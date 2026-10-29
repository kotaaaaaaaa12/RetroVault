import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
const source = await readFile(new URL('../assets/js/local-rom.js', import.meta.url), 'utf8');
const window = {};
vm.runInNewContext(source, { window, File, Uint8Array, DataView, AbortController, setTimeout });
function image({ media = 1, dirty = false, invalid = false } = {}) {
  const data = new Uint8Array(65536).fill(255);
  data.fill(0, 0, 512);
  data.set(new TextEncoder().encode('NCSD'), 256);
  const view = new DataView(data.buffer);
  view.setUint32(0x104, 128, true);
  data[0x18d] = media;
  view.setUint32(0x120, 32, true); view.setUint32(0x124, invalid ? 1000 : 32, true);
  data.set(new TextEncoder().encode('NCCH'), 16384 + 256);
  if (dirty) data[65535] = 0;
  return new File([data], 'game.3ds');
}
test('only verified padding is omitted; original bytes and filename remain intact', async () => {
  const file = image(); const before = await file.arrayBuffer();
  const result = await window.RetroLocalRom.prepare(file);
  assert.equal(result.reason, 'trimmed'); assert.equal(result.preparedSize, 32768);
  assert.equal(result.file.name, file.name); assert.equal(file.size, 65536);
  assert.deepEqual(await file.arrayBuffer(), before);
  assert.deepEqual(await result.file.arrayBuffer(), before.slice(0, 32768));
});
test('CARD2, invalid partition layouts, and non-padding tails remain unchanged', async () => {
  for (const [options, reason] of [[{ media: 2 }, 'unsupported-media'], [{ invalid: true }, 'invalid-layout'], [{ dirty: true }, 'non-padding']]) {
    const file = image(options); const result = await window.RetroLocalRom.prepare(file);
    assert.equal(result.reason, reason); assert.equal(result.file, file);
  }
});
test('preparation is cancellable and never reads the entire source file', async () => {
  const file = image(); const original = file.slice.bind(file); let largest = 0;
  file.arrayBuffer = () => { throw new Error('Full read forbidden'); };
  file.slice = (start, end) => { largest = Math.max(largest, end - start); return original(start, end); };
  const abort = new AbortController();
  await assert.rejects(window.RetroLocalRom.prepare(file, { signal: abort.signal, progress() { abort.abort(); } }), error => error.name === 'AbortError');
  assert.ok(largest <= 4 * 1024 * 1024);
});
