import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';
import { ncchFixture } from './ncch-fixture.mjs';
const source = await readFile(new URL('../assets/js/lazy-rom.js', import.meta.url), 'utf8');
function environment(Worker = class {}, crypto = webcrypto) {
  const window = { location: { href: 'https://retro.example/pages/player.html' } };
  vm.runInNewContext(source, { window, URL, crypto, Worker, SharedArrayBuffer, Atomics, performance, setTimeout, clearTimeout });
  return window.RetroLazyRom;
}
async function verify(fixture, api = environment()) {
  const first = fixture.bytes.slice(0, 262144), calls = [];
  const header = api.inspectHeader(first, fixture.size);
  header.exheaderHash = await api.inspectExheaderHash(first, fixture.size, header);
  const result = await api.verifyPlaintextRegions(first, fixture.size, header, async (start, length) => {
    calls.push({ start, length }); return fixture.bytes.slice(start, start + length);
  });
  return { result, calls };
}
test('plaintext compatibility verifies both container layouts, all ExeFS files and the RomFS superblock without modifying bytes', async () => {
  for (const ncsd of [true, false]) {
    const fixture = ncchFixture({ ncsd }), before = fixture.bytes.slice();
    const { result, calls } = await verify(fixture);
    assert.equal(result.state, 'verified'); assert.equal(result.checks.length, 5);
    assert.ok(result.checks.every(check => check.state === 'match'));
    assert.equal(result.bytesHashed, 1024 + 512 + fixture.codeLength + 1000 + 512);
    assert.ok(calls.some(call => call.start === fixture.code && call.length === fixture.codeLength));
    assert.deepEqual(fixture.bytes, before);
  }
});
test('encrypted or partially decrypted sections and missing hashes never authorize normalization', async () => {
  for (const [target, reason] of [['exheader', 'exheader-not-verified'], ['exefs', 'exefs-superblock-not-verified'], ['code', 'exefs-file-not-verified'], ['icon', 'exefs-file-not-verified'], ['romfs', 'romfs-superblock-not-verified']]) {
    const fixture = ncchFixture();
    fixture.bytes[target === 'exheader' ? fixture.base + 0x200 : fixture[target]] ^= 1;
    const { result } = await verify(fixture);
    assert.equal(result.state, 'not-applied', target); assert.equal(result.reason, reason);
  }
  const fixture = ncchFixture(); fixture.bytes.fill(0, fixture.base + 0x1e0, fixture.base + 0x200);
  assert.equal((await verify(fixture)).result.checks.at(-1).state, 'missing-digest');
  const normal = ncchFixture({ flags: 4 }), { result, calls } = await verify(normal);
  assert.equal(result.reason, 'already-no-crypto'); assert.equal(calls.length, 0);
});
test('unsupported layouts, malicious offsets, overlaps and oversized verification requests fail closed', async () => {
  const cases = [
    [f => f.view.setUint16(f.base + 0x112, 1, true), 'unsupported-ncch-layout'],
    [f => f.bytes[f.base + 0x18e] = 31, 'unsupported-ncch-layout'],
    [f => f.view.setUint32(f.base + 0x1a0, 0xffffffff, true), 'invalid-section-bounds'],
    [f => f.view.setUint32(f.base + 0x104, 0xffffffff, true), 'invalid-content-bounds'],
    [f => f.view.setUint32(f.base + 0x1b0, 0x2000 / 512, true), 'overlapping-sections'],
    [f => { f.view.setUint32(f.base + 0x1b4, 0x180000 / 512, true); }, 'invalid-section-bounds'],
    [f => { f.view.setUint32(f.exefs + 12, 0xffffffff, true); f.hash(f.base + 0x1c0, f.exefs, 512); }, 'invalid-exefs-entry'],
    [f => { f.view.setUint32(f.exefs + 24, 0, true); f.hash(f.base + 0x1c0, f.exefs, 512); }, 'overlapping-exefs-files']
  ];
  for (const [mutate, expected] of cases) {
    const fixture = ncchFixture(); mutate(fixture);
    const { result } = await verify(fixture);
    assert.equal(result.state, 'not-applied'); assert.equal(result.reason, expected);
  }
  const unsupported = ncchFixture(); unsupported.bytes[unsupported.exefs + 0x80] = 1;
  unsupported.hash(unsupported.base + 0x1c0, unsupported.exefs, 512);
  assert.equal((await verify(unsupported)).result.reason, 'unsupported-exefs-layout');
  const limited = ncchFixture(); limited.view.setUint32(limited.base + 0x1b4, 0x120000 / 512, true);
  limited.view.setUint32(limited.base + 0x1b8, 0x110000 / 512, true);
  limited.size = 4 * 1024 * 1024;
  limited.view.setUint32(limited.base + 0x104, (limited.size - limited.base) / 512, true);
  limited.view.setUint32(0x124, (limited.size - limited.base) / 512, true);
  assert.equal((await verify(limited)).result.reason, 'superblock-check-limit');
  const fixture = ncchFixture();
  const api = environment(class {}, { subtle: { digest: async () => { throw new Error('Denied'); } } });
  assert.equal((await verify(fixture, api)).result.reason, 'exheader-not-verified');
});
function rangeWorker(fixture, options = {}) {
  const requests = [];
  class Worker {
    postMessage(message) {
      if (message.type === 'init') {
        this.bytes = new Uint8Array(message.shared, 8); this.state = new Int32Array(message.shared, 0, 2);
        this.bytes.set(fixture.bytes.subarray(0, 262144));
        queueMicrotask(() => this.onmessage({ data: { ready: true, size: fixture.size, firstLength: 262144 } }));
        return;
      }
      requests.push(message);
      if (options.hold) return;
      this.bytes.set(fixture.bytes.subarray(message.start, message.end));
      if (message.type === 'prefetch') queueMicrotask(() => this.onmessage({ data: { type: 'prefetch', requestId: message.requestId, ok: !options.fail, length: message.end - message.start } }));
      else { Atomics.store(this.state, 1, message.end - message.start); Atomics.store(this.state, 0, 2); }
    }
    terminate() { this.terminated = true; }
  }
  return { Worker, requests };
}
test('remote mounting normalizes only output copies, including partial and repeated FS reads, and preserves original storage', async () => {
  const fixture = ncchFixture({ flags: 0x21 }), before = fixture.bytes.slice();
  const { Worker, requests } = rangeWorker(fixture), api = environment(Worker);
  const reader = new api.LazyRom({ url: '/data/roms/test.3ds', name: 'test.3ds' });
  const node = { node_ops: { getattr: () => ({}) }, stream_ops: {} };
  try {
    await reader.ready;
    assert.equal(reader.stats.header.compatibility.state, 'applied');
    assert.equal(reader.stats.header.compatibility.originalFlagsByte, 0x21);
    assert.equal(reader.stats.header.compatibility.virtualFlagsByte, 0x25);
    assert.ok(requests.every(request => request.end - request.start <= 262144));
    reader.mount({ createDataFile() {}, lookupPath: () => ({ node }), ErrnoError: Error });
    const flagAt = fixture.base + 0x18f;
    for (const [start, length] of [[flagAt, 1], [flagAt - 2, 5], [fixture.base, 512]]) {
      const output = new Uint8Array(length + 14).fill(0x9a);
      assert.equal(node.stream_ops.read({}, output, 7, length, start), length);
      const expected = fixture.bytes.slice(start, start + length); expected[flagAt - start] = 0x25;
      assert.deepEqual(output.subarray(7, 7 + length), expected);
      assert.ok(output.subarray(0, 7).every(byte => byte === 0x9a));
      assert.ok(output.subarray(7 + length).every(byte => byte === 0x9a));
    }
    assert.equal(reader.stats.header.deliveredMatchesVirtual, true);
    assert.equal(reader.stats.header.unexpectedDeliveryMismatchObserved, false);
    assert.equal(reader.cache.get(0)[flagAt], 0x21);
    reader.cache.delete(0);
    assert.equal(reader.read(flagAt, 1)[0], 0x25);
    assert.equal(reader.cache.get(0)[flagAt], 0x21);
    assert.deepEqual(fixture.bytes, before);
  } finally { reader.stop(); }
  assert.equal(reader.stats.header.compatibility.state, 'applied');
});
test('a failed check keeps original flags and failed I/O rejects mounting; closing cancels verification', async () => {
  const fixture = ncchFixture(); fixture.bytes[fixture.romfs] ^= 1;
  const { Worker } = rangeWorker(fixture), reader = new (environment(Worker).LazyRom)({ url: '/data/roms/test.3ds', name: 'test.3ds' });
  await reader.ready;
  assert.equal(reader.stats.header.compatibility.state, 'not-applied');
  assert.equal(reader.read(fixture.base + 0x18f, 1)[0], 0); reader.stop();
  for (const options of [{ fail: true }, { hold: true }]) {
    const fixture = ncchFixture(), { Worker, requests } = rangeWorker(fixture, options);
    const reader = new (environment(Worker).LazyRom)({ url: '/data/roms/test.3ds', name: 'test.3ds' });
    if (options.hold) {
      while (!requests.length) await new Promise(resolve => setTimeout(resolve, 1));
      reader.stop();
    }
    await assert.rejects(reader.ready, /lazyRomReadError/);
    assert.equal(reader.virtualFlagsByte, undefined);
    assert.equal(reader.worker.terminated, true); reader.stop();
  }
});

test('Safari library startup waits for the complete disk copy, preserves virtual flags, and awaits disposal', async () => {
  const fixture = ncchFixture(); let finishDisk, worker, mounts = 0;
  const { Worker: Base } = rangeWorker(fixture);
  class Worker extends Base {
    constructor() { super(); worker = this; }
    postMessage(message) {
      if (message.type === 'prepare-disk') {
        finishDisk = () => {
          this.onmessage({ data: { type: 'disk-progress', completed: fixture.size, total: fixture.size } });
          this.onmessage({ data: { type: 'disk-ready', ok: true } });
        };
      } else if (message.type === 'dispose') queueMicrotask(() => this.onmessage({ data: { type: 'disposed', cleanup: 'removed' } }));
      else super.postMessage(message);
    }
  }
  const api = environment(Worker); const source = 'https://retro.example/data/roms/test.3ds';
  const node = { node_ops: { getattr: () => ({}) }, stream_ops: {} };
  const emulator = { ejs_version: '4.3.0-pre', isSafari: true, getCore: () => 'azahar', download() { throw new Error('Native whole-ROM fallback'); }, config: {}, gameManager: { FS: { createDataFile() { mounts++; }, lookupPath: () => ({ node }), ErrnoError: Error } } };
  const installed = api.install(emulator, source);
  const downloading = emulator.download(source, { name: 'ROM' });
  while (!finishDisk) await new Promise(resolve => setTimeout(resolve, 1));
  assert.equal(mounts, 0); assert.equal(installed.stats.disk.state, 'downloading');
  finishDisk(); await downloading;
  assert.equal(mounts, 1); assert.equal(installed.stats.mode, 'lazy-opfs'); assert.equal(installed.stats.cacheBytes, 0);
  const flag = new Uint8Array(1); node.stream_ops.read({}, flag, 0, 1, fixture.base + 0x18f);
  assert.equal(flag[0], 4);
  await installed.stop();
  assert.equal(installed.stats.disk.cleanup, 'removed'); assert.equal(worker.terminated, true);
});
