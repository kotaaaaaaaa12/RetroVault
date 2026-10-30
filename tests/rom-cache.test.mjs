import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';
const cacheSource = await readFile(new URL('../assets/js/rom-cache.js', import.meta.url), 'utf8');
const workerSource = await readFile(new URL('../assets/js/rom-reader-worker.js', import.meta.url), 'utf8');
const missing = () => Object.assign(new Error('Missing'), { name: 'NotFoundError' });
function filesystem() {
  const directories = new Map();
  function makeDirectory() {
    const files = new Map();
    return {
      files, async *keys() { yield* files.keys(); },
      async removeEntry(name) { const file = files.get(name); if (!file) throw missing(); if (file.locked) throw Object.assign(new Error('Busy'), { name: 'NoModificationAllowedError' }); files.delete(name); },
      async getFileHandle(name, { create = false } = {}) {
        if (!files.has(name)) { if (!create) throw missing(); files.set(name, { bytes: new Uint8Array(), locked: false }); }
        const file = files.get(name);
        return {
          async getFile() { return { size: file.bytes.length, text: async () => new TextDecoder().decode(file.bytes) }; },
          async createSyncAccessHandle() {
            if (file.locked) throw Object.assign(new Error('Busy'), { name: 'NoModificationAllowedError' });
            file.locked = true;
            return {
              truncate(length) { const next = new Uint8Array(length); next.set(file.bytes.subarray(0, length)); file.bytes = next; },
              write(bytes, { at }) { if (at + bytes.length > file.bytes.length) { const next = new Uint8Array(at + bytes.length); next.set(file.bytes); file.bytes = next; } file.bytes.set(bytes, at); return bytes.length; },
              read(output, { at }) { const count = Math.max(0, Math.min(output.length, file.bytes.length - at)); output.set(file.bytes.subarray(at, at + count)); return count; },
              getSize: () => file.bytes.length, flush() {}, close() { file.locked = false; }
            };
          }
        };
      }
    };
  }
  const root = { async getDirectoryHandle(name, { create = false } = {}) { if (!directories.has(name)) { if (!create) throw missing(); directories.set(name, makeDirectory()); } return directories.get(name); } };
  return { root, directories, navigator: { storage: { getDirectory: async () => root, estimate: async () => ({ quota: 100 * 1024 * 1024, usage: 0 }) }, locks: { request: async (name, callback) => callback() } } };
}
function worker(fs, tag = '"one"', size = 1048576, behavior = {}) {
  const messages = [], requests = [], shared = new SharedArrayBuffer(262144 + 8);
  const self = { navigator: fs.navigator, crypto: webcrypto, location: { href: 'https://retro.example/assets/js/rom-reader-worker.js', origin: 'https://retro.example' }, postMessage: item => messages.push(item) };
  const context = vm.createContext({ self, navigator: fs.navigator, crypto: webcrypto, TextEncoder, URL, AbortController, setTimeout, clearTimeout, Atomics,
    fetch: async (url, options) => {
      requests.push(options.headers.Range);
      if (requests.length > 1 && behavior.onRange) return behavior.onRange(options);
      const [, a, b] = /^bytes=(\d+)-(\d+)$/.exec(options.headers.Range), start = Number(a), end = Math.min(Number(b), size - 1);
      return new Response(Uint8Array.from({ length: end - start + 1 }, (_, i) => (start + i) % 251), { status: 206, headers: { 'Content-Range': `bytes ${start}-${end}/${size}`, ETag: tag } });
    }
  });
  context.importScripts = url => { assert.match(url, /^\/assets\/js\/rom-cache\.js\?v=/); vm.runInContext(cacheSource, context); };
  vm.runInContext(workerSource, context);
  return { context, messages, requests, shared, init: () => self.onmessage({ data: { type: 'init', persistent: true, fileName: 'Example.3ds', url: 'https://retro.example/data/roms/example.3ds', shared } }), send: data => self.onmessage({ data }) };
}
test('completed cache survives close and is reused after one small update probe without a ROM redownload', async () => {
  const fs = filesystem(), first = worker(fs); await first.init(); await first.send({ type: 'prepare-disk' });
  assert.equal(first.messages.at(-1).ok, true); assert.equal(first.messages.at(-1).persistent, true);
  await first.send({ type: 'dispose' }); assert.equal(first.messages.at(-1).cleanup, 'retained');
  const second = worker(fs); await second.init();
  assert.equal(second.messages.at(-1).reused, true); assert.deepEqual(second.requests, ['bytes=0-262143']);
  await second.send({ type: 'read', start: 367000, end: 367512 });
  assert.equal(Atomics.load(new Int32Array(second.shared, 0, 2), 0), 2);
  assert.deepEqual([...new Uint8Array(second.shared, 8, 512)], Array.from({ length: 512 }, (_, i) => (367000 + i) % 251));
  assert.equal(second.requests.length, 1); await second.send({ type: 'dispose' });
});
test('ETag and size changes require a new copy; deletion is scoped and refuses active readers', async () => {
  const fs = filesystem(), first = worker(fs); await first.init(); await first.send({ type: 'prepare-disk' }); await first.send({ type: 'dispose' });
  const second = worker(fs, '"two"'); await second.init(); assert.equal(second.messages.at(-1).reused, false); await second.send({ type: 'prepare-disk' });
  const api = second.context.RetroRomCache, entries = await api.list(); assert.equal(entries.length, 2);
  const directory = fs.directories.get('retrovault-rom-cache-v1');
  const activeKey = entries.find(entry => directory.files.get(entry.key + '.rom').locked).key;
  await assert.rejects(api.remove(activeKey), /romCacheBusy/);
  assert.ok(directory.files.has(activeKey + '.json'));
  const oldKey = entries.find(entry => entry.key !== activeKey).key; await api.remove(oldKey);
  assert.equal((await api.list()).length, 1); await assert.rejects(api.remove('../saves'), /Invalid cache key/);
  await second.send({ type: 'dispose' }); await api.remove(activeKey); assert.equal((await api.list()).length, 0);
  const unrelated = await fs.root.getDirectoryHandle('game-saves', { create: true }); unrelated.files.set('save.bin', { bytes: new Uint8Array([1, 2, 3]) });
  const resized = worker(fs, '"two"', 2097152); await resized.init(); assert.equal(resized.messages.at(-1).reused, false);
  await resized.send({ type: 'prepare-disk' }); await resized.send({ type: 'dispose' });
  assert.equal((await resized.context.RetroRomCache.list())[0].size, 2097152);
  assert.deepEqual([...unrelated.files.get('save.bin').bytes], [1, 2, 3]);
});
test('locked, truncated and corrupted-prefix cache entries are never reused as complete files', async () => {
  const fs = filesystem(), first = worker(fs); await first.init(); await first.send({ type: 'prepare-disk' });
  const concurrent = worker(fs); await concurrent.init(); assert.equal(concurrent.messages.at(-1).ready, false); assert.equal(concurrent.messages.at(-1).failure, -22000);
  await first.send({ type: 'dispose' });
  const dir = fs.directories.get('retrovault-rom-cache-v1'), key = [...dir.files.keys()].find(name => name.endsWith('.rom'));
  dir.files.get(key).bytes[0] ^= 1;
  const corrupted = worker(fs); await corrupted.init(); assert.equal(corrupted.messages.at(-1).reused, false);
  await corrupted.send({ type: 'prepare-disk' }); await corrupted.send({ type: 'dispose' });
  dir.files.get(key).bytes = dir.files.get(key).bytes.subarray(0, 1024);
  const truncated = worker(fs); await truncated.init(); assert.equal(truncated.messages.at(-1).reused, false);
  await truncated.send({ type: 'prepare-disk' }); await truncated.send({ type: 'dispose' });
});
test('cancelling a persistent download removes its incomplete data and cannot publish a reusable manifest', async () => {
  let started; const waiting = new Promise(resolve => started = resolve);
  const fs = filesystem(), downloading = worker(fs, '"one"', 1048576, {
    onRange: request => new Promise((resolve, reject) => { started(); request.signal.addEventListener('abort', () => reject(new Error('Aborted'))); })
  });
  await downloading.init(); const task = downloading.send({ type: 'prepare-disk' }); await waiting;
  const entries = await downloading.context.RetroRomCache.list(); assert.equal(entries.length, 1); assert.equal(entries[0].complete, false);
  await downloading.send({ type: 'dispose' }); await task;
  assert.equal(downloading.messages.at(-1).cleanup, 'removed');
  assert.equal((await downloading.context.RetroRomCache.list()).length, 0);
  const retry = worker(fs); await retry.init(); assert.equal(retry.messages.at(-1).reused, false);
});
