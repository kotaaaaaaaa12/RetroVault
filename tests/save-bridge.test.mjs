import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../assets/js/save-bridge.js', import.meta.url), 'utf8');
globalThis.window = {};
(0, eval)(source);
const bridge = globalThis.window.RetroSaveBridge;
const bytes = (...values) => Uint8Array.from(values);
const text = value => Uint8Array.from(Buffer.from(value, 'ascii'));

const FOOTER_TEXT = "|<--Snip above here to create a raw sav by excluding this DeSmuME savedata footer:";
const COOKIE = "|-DESMUME SAVE-|";
const le32 = value => Uint8Array.from([value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff]);
const withFooter = (raw, padSize = raw.length, version = 0) => {
  const info = (size, pad, type, addrSize, memSize) => new Uint8Array([...le32(size), ...le32(pad), ...le32(type), ...le32(addrSize), ...le32(memSize)]);
  return new Uint8Array([...raw, ...text(FOOTER_TEXT), ...info(0x40, padSize, 7, 3, 0x40), ...le32(version), ...text(COOKIE)]);
};

test('DSV footer size matches the DeSmuME on-disk layout (82 text + 20 info + 4 version + 16 cookie)', () => {
  assert.equal(FOOTER_TEXT.length, 82);
  assert.equal(COOKIE.length, 16);
  assert.equal(bridge.DSV_FOOTER_SIZE, 122);
});

test('strips a valid DeSmuME footer and returns the raw save', () => {
  const raw = bytes(0, 1, 2, 3, 4, 5, 6, 7);
  const dsv = withFooter(raw);
  assert.equal(bridge.isDsvFooter(dsv), true);
  assert.deepEqual([...bridge.stripDsvFooter(dsv)], [...raw]);
});

test('passes plain raw saves through untouched', () => {
  const raw = bytes(1, 2, 3, 4, 5);
  assert.equal(bridge.isDsvFooter(raw), false);
  assert.equal(bridge.stripDsvFooter(raw), null);
  assert.equal(bridge.isDsvFooter(new Uint8Array([...raw, ...text(FOOTER_TEXT)])), false);
  assert.equal(bridge.stripDsvFooter(new Uint8Array([...raw, ...text(FOOTER_TEXT)])), null);
});

test('rejects a DeSmuME cookie with a broken footer instead of misreading the save', () => {
  const raw = bytes(9, 9, 9, 9);
  const broken = new Uint8Array([...raw, ...text(FOOTER_TEXT), ...text(COOKIE)]);
  assert.equal(broken.length, 102);
  assert.equal(bridge.isDsvFooter(broken), false);
  assert.throws(() => bridge.stripDsvFooter(new Uint8Array([...raw, ...text(FOOTER_TEXT), ...new Uint8Array(20).fill(0), ...bytes(1, 0, 0, 0), ...text(COOKIE)])), { name: 'InvalidGameSaveBackup' });
  assert.throws(() => bridge.stripDsvFooter(withFooter(raw, raw.length, 7)), { name: 'InvalidGameSaveBackup' });
  assert.throws(() => bridge.stripDsvFooter(withFooter(raw, raw.length + 8)), { name: 'InvalidGameSaveBackup' });
});

test('short files never look like a DSV', () => {
  assert.equal(bridge.stripDsvFooter(new Uint8Array(121)), null);
  assert.equal(bridge.stripDsvFooter(new Uint8Array(0)), null);
});
