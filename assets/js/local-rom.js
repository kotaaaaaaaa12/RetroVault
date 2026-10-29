"use strict";
(() => {
  async function prepare(file, { signal, progress = () => {} } = {}) {
    const check = () => signal?.throwIfAborted();
    const result = (reason, end = file.size) => ({ file: end === file.size ? file : new File([file.slice(0, end)], file.name, { type: file.type, lastModified: file.lastModified }), originalSize: file.size, preparedSize: end, reason });
    check();
    if (!/\.(3ds|cci)$/i.test(file.name) || file.size < 0x4000) return result('not-applicable');
    const header = new Uint8Array(await file.slice(0, 512).arrayBuffer()); check();
    if (String.fromCharCode(...header.slice(256, 260)) !== 'NCSD') return result('unsupported');
    const view = new DataView(header.buffer);
    // Only standard CARD1 images are handled. CARD2 can contain writable saves.
    if (header[0x18d] !== 1 || header[0x18e] !== 0) return result('unsupported-media');
    const declared = view.getUint32(0x104, true) * 512;
    if (declared < file.size || !Number.isInteger(Math.log2(declared))) return result('invalid-layout');
    let end = 0x4000;
    const ranges = [];
    for (let i = 0; i < 8; i++) {
      const offset = view.getUint32(0x120 + i * 8, true) * 512;
      const size = view.getUint32(0x124 + i * 8, true) * 512;
      if (!size) { if (offset) return result('invalid-layout'); continue; }
      if (offset < 0x4000 || offset + size > file.size) return result('invalid-layout');
      ranges.push([offset, offset + size]); end = Math.max(end, offset + size);
    }
    if (!ranges.length || !view.getUint32(0x124, true)) return result('invalid-layout');
    ranges.sort((a, b) => a[0] - b[0]);
    if (ranges.some((range, i) => i && range[0] < ranges[i - 1][1])) return result('invalid-layout');
    // Validate partition signatures before trusting the table.
    for (const [offset] of ranges) {
      const magic = new Uint8Array(await file.slice(offset + 256, offset + 260).arrayBuffer()); check();
      if (String.fromCharCode(...magic) !== 'NCCH') return result('invalid-layout');
    }
    if (end === file.size) return result('already-trimmed');
    const total = file.size - end;
    for (let offset = end; offset < file.size; offset += 4 * 1024 * 1024) {
      check();
      const next = Math.min(file.size, offset + 4 * 1024 * 1024);
      const chunk = new Uint8Array(await file.slice(offset, next).arrayBuffer()); check();
      if (chunk.some(byte => byte !== 255)) return result('non-padding');
      progress(next - end, total);
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    check(); return result('trimmed', end);
  }
  window.RetroLocalRom = { prepare };
})();
