import { createHash } from 'node:crypto';

// Synthetic containers for loader tests; these contain no game data.
export function ncchFixture({ ncsd = true, codeLength = 300123, flags = 0 } = {}) {
  const bytes = new Uint8Array(2 * 1024 * 1024), view = new DataView(bytes.buffer);
  const base = ncsd ? 0x4000 : 0, size = bytes.length;
  const put = (at, value) => view.setUint32(base + at, value, true);
  const hash = (target, start, length) => bytes.set(createHash('sha256').update(bytes.subarray(start, start + length)).digest(), target);
  if (ncsd) {
    bytes.set(Buffer.from('NCSD'), 0x100);
    view.setUint32(0x120, base / 512, true); view.setUint32(0x124, (size - base) / 512, true);
  }
  bytes.set(Buffer.from('NCCH'), base + 0x100);
  put(0x104, (size - base) / 512); view.setUint16(base + 0x112, 2, true);
  bytes[base + 0x18f] = flags; put(0x180, 0x400);
  hash(base + 0x160, base + 0x200, 0x400);
  const exefs = base + 0x2000, code = exefs + 512;
  const iconOffset = Math.ceil(codeLength / 512) * 512, icon = code + iconOffset;
  const exefsSize = Math.ceil((512 + iconOffset + 1000) / 512) * 512;
  put(0x1a0, 0x2000 / 512); put(0x1a4, exefsSize / 512); put(0x1a8, 1);
  bytes.set(Buffer.from('.code'), exefs); view.setUint32(exefs + 12, codeLength, true);
  bytes.set(Buffer.from('icon'), exefs + 16); view.setUint32(exefs + 24, iconOffset, true); view.setUint32(exefs + 28, 1000, true);
  for (let i = 0; i < codeLength; i++) bytes[code + i] = (i * 13 + 7) % 256;
  bytes.fill(0x5a, icon, icon + 1000);
  hash(exefs + 0x1e0, code, codeLength); hash(exefs + 0x1c0, icon, 1000);
  hash(base + 0x1c0, exefs, 512);
  const romfs = base + 0x100000;
  put(0x1b0, 0x100000 / 512); put(0x1b4, 0x20000 / 512); put(0x1b8, 1);
  bytes.fill(0x71, romfs, romfs + 512); bytes.set(Buffer.from('IVFC'), romfs);
  hash(base + 0x1e0, romfs, 512);
  return { bytes, base, size, view, code, codeLength, exefs, exefsSize, romfs, icon, hash };
}
