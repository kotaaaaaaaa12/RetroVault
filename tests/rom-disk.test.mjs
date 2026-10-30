import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
const source = await readFile(new URL('../assets/js/rom-reader-worker.js', import.meta.url), 'utf8');

function environment(options = {}) {
  const size = options.size || 10 * 1024 * 1024 + 123, messages = [], requests = [], files = new Map();
  let maxWrite = 0, totalWritten = 0, flushes = 0, prepared = false;
  const directory = {
    async *keys() { yield* files.keys(); },
    async removeEntry(name) { if (files.get(name)?.locked) throw new Error('Locked'); files.delete(name); },
    async getFileHandle(name) {
      const file = { chunks: new Map(), size: 0, locked: false }; files.set(name, file);
      return { async createSyncAccessHandle() {
        file.locked = true;
        return {
          truncate(size) { file.chunks.clear(); file.size = size; },
          write(bytes, { at }) {
            if (options.quotaOnWrite && totalWritten >= 262144) throw Object.assign(new Error('Quota exceeded'), { name: 'QuotaExceededError' });
            const length = options.partialWrites ? Math.min(8192, bytes.length) : bytes.length;
            maxWrite = Math.max(maxWrite, bytes.length); totalWritten += length;
            file.chunks.set(at, bytes.slice(0, length)); file.size = Math.max(file.size, at + length); return length;
          },
          read(output, { at }) {
            if (options.failRead) return 0;
            for (const [start, bytes] of file.chunks) {
              const a = Math.max(start, at), b = Math.min(start + bytes.length, at + output.length);
              if (b > a) output.set(bytes.subarray(a - start, b - start), a - at);
            }
            return Math.min(output.length, file.size - at);
          },
          flush() { flushes++; }, getSize: () => file.size,
          close() { file.locked = false; }
        };
      } };
    }
  };
  files.set('rom-aaa.tmp', { locked: false });
  files.set('unrelated.txt', { locked: false });
  files.set('rom-bbb.tmp', { locked: true });
  const self = {
    location: { href: 'https://retro.example/assets/js/rom-reader-worker.js', origin: 'https://retro.example' },
    crypto: { randomUUID: () => '12345678-abcd' },
    navigator: options.unavailable ? {} : {
      locks: { request: async (name, callback) => callback() },
      storage: { getDirectory: async () => ({ getDirectoryHandle: async name => { assert.equal(name, 'retrovault-rom-temp-v1'); return directory; } }), estimate: async () => ({ usage: 0, quota: options.quota ?? size * 2 }) }
    },
    postMessage(message) { messages.push(message); if (message.type === 'disk-ready' && message.ok) prepared = true; }
  };
  const fetch = async (url, request) => {
    assert.equal(prepared, false, 'Playback must not fetch after disk preparation');
    requests.push(request.headers.Range);
    if (options.fetchOverride && requests.length > 1) return options.fetchOverride(request);
    const [, a, b] = /^bytes=(\d+)-(\d+)$/.exec(request.headers.Range), start = Number(a), end = Math.min(Number(b), size - 1);
    const length = end - start + 1;
    assert.ok(length <= 4 * 1024 * 1024);
    const body = Uint8Array.from({ length: options.short && requests.length > 1 ? length - 1 : length }, (_, i) => (start + i) % 251);
    const response = new Response(body, { status: 206, headers: { 'Content-Range': `bytes ${start}-${end}/${size}`, ETag: options.changed && requests.length > 1 ? '"changed"' : '"fixed"' } });
    response.arrayBuffer = () => { throw new Error('Whole response buffering is forbidden'); };
    return response;
  };
  vm.runInNewContext(source, { self, fetch, URL, AbortController, setTimeout, clearTimeout, Atomics });
  const shared = new SharedArrayBuffer(262144 + 8);
  return { self, size, shared, messages, requests, files, summary: () => ({ maxWrite, totalWritten, flushes }), send: data => self.onmessage({ data }), init: () => self.onmessage({ data: { type: 'init', url: 'https://retro.example/data/roms/test.3ds', shared } }) };
}
test('temporary ROM preparation streams validated ranges to bounded disk writes and playback makes no network requests', async () => {
  const env = environment({ partialWrites: true }); await env.init();
  await env.send({ type: 'prepare-disk' });
  assert.equal(env.messages.at(-1).type, 'disk-ready'); assert.equal(env.messages.at(-1).ok, true);
  assert.equal(env.summary().totalWritten, env.size); assert.ok(env.summary().maxWrite <= 65536); assert.equal(env.summary().flushes, 1);
  const progress = env.messages.filter(x => x.type === 'disk-progress');
  assert.equal(progress.at(-1).completed, env.size);
  assert.ok(progress.every((item, index) => !index || item.completed >= progress[index - 1].completed));
  const count = env.requests.length;
  for (const start of [0, 3670016, 9 * 1024 * 1024, env.size - 17]) {
    const end = Math.min(start + 128, env.size);
    await env.send({ type: 'read', start, end });
    assert.equal(Atomics.load(new Int32Array(env.shared, 0, 2), 0), 2);
    assert.deepEqual([...new Uint8Array(env.shared, 8, end - start)], Array.from({ length: end - start }, (_, i) => (start + i) % 251));
  }
  assert.equal(env.requests.length, count);
  assert.ok(!env.files.has('rom-aaa.tmp')); assert.ok(env.files.has('rom-bbb.tmp')); assert.ok(env.files.has('unrelated.txt'));
  await env.send({ type: 'dispose' });
  assert.equal(env.messages.at(-1).cleanup, 'removed'); assert.ok(!env.files.has('rom-12345678-abcd.tmp'));
});
test('quota, unsupported storage, changed objects and truncated downloads cannot become playable disk files', async () => {
  for (const [options, failure] of [[{ quota: 1 }, -18000], [{ quotaOnWrite: true }, -18000], [{ unavailable: true }, -17000], [{ changed: true }, -5206], [{ short: true }, -10000]]) {
    const env = environment({ ...options, size: 1048576 }); await env.init(); await env.send({ type: 'prepare-disk' });
    assert.equal(env.messages.at(-1).ok, false); assert.equal(env.messages.at(-1).failure, failure);
    assert.ok(!env.files.has('rom-12345678-abcd.tmp'));
    assert.ok(!env.messages.some(x => x.type === 'disk-ready' && x.ok));
  }
});
test('cancelling an in-flight download aborts its request, removes the partial file, and never reports ready', async () => {
  let started;
  const waiting = new Promise(resolve => started = resolve);
  const env = environment({ size: 1048576, fetchOverride: request => new Promise((resolve, reject) => {
    started(); request.signal.addEventListener('abort', () => reject(Object.assign(new Error('Aborted'), { name: 'AbortError' })));
  }) });
  await env.init(); const preparation = env.send({ type: 'prepare-disk' });
  await waiting; await env.send({ type: 'dispose' }); await preparation;
  assert.equal(env.messages.at(-1).type, 'disposed'); assert.equal(env.messages.at(-1).cleanup, 'removed');
  assert.ok(!env.messages.some(x => x.type === 'disk-ready' && x.ok));
  assert.ok(!env.files.has('rom-12345678-abcd.tmp'));
});
test('disk read failures are recorded as disk errors without a network fallback', async () => {
  const env = environment({ size: 1048576, failRead: true }); await env.init(); await env.send({ type: 'prepare-disk' });
  const count = env.requests.length;
  await env.send({ type: 'read', start: 262144, end: 524288 });
  const state = new Int32Array(env.shared, 0, 2);
  assert.equal(Atomics.load(state, 0), -1); assert.equal(Atomics.load(state, 1), -20000); assert.equal(env.requests.length, count);
  await env.send({ type: 'dispose' });
});
