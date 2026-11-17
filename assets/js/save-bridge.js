"use strict";

// Cross-core game save bridging. DeSmuME stores battery saves as raw data plus
// a footer at the end: snip note (82 bytes), five u32 info fields (size,
// padSize, type, addr_size, mem_size), version, then the cookie. A raw .sav is
// accepted by melonDS and by DeSmuME's own .dsv fallback loader, so raw is the
// exchange format used here.
(() => {
  const COOKIE = "|-DESMUME SAVE-|";
  const FOOTER_TEXT = "|<--Snip above here to create a raw sav by excluding this DeSmuME savedata footer:";
  const INFO_BYTES = 20;
  const VERSION_BYTES = 4;
  const DSV_FOOTER_SIZE = FOOTER_TEXT.length + INFO_BYTES + VERSION_BYTES + COOKIE.length;
  const error = name => Object.assign(new Error(name), { name });

  function hasBytes(bytes, offset, expected) {
    for (let i = 0; i < expected.length; i += 1) {
      if (bytes[offset + i] !== expected.charCodeAt(i)) return false;
    }
    return true;
  }

  function isDsvFooter(bytes) {
    return bytes.length >= DSV_FOOTER_SIZE && isDsvFooterAt(bytes, bytes.length - DSV_FOOTER_SIZE);
  }

  function isDsvFooterAt(bytes, offset) {
    if (bytes.length - offset < DSV_FOOTER_SIZE) return false;
    if (!hasBytes(bytes, offset, FOOTER_TEXT)) return false;
    if (!hasBytes(bytes, offset + FOOTER_TEXT.length + INFO_BYTES + VERSION_BYTES, COOKIE)) return false;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (view.getUint32(offset + FOOTER_TEXT.length + INFO_BYTES, true) !== 0) return false;
    // padSize records the padded payload size, which is exactly the region before the footer.
    return view.getUint32(offset + FOOTER_TEXT.length + 4, true) === offset;
  }

  // Returns the raw save bytes when the input carries a valid DeSmuME footer,
  // null when it is a plain raw save (pass through unchanged), and throws for
  // a malformed footer that claims to be a DeSmuME file.
  function stripDsvFooter(bytes) {
    if (bytes.length < DSV_FOOTER_SIZE) return null;
    const offset = bytes.length - DSV_FOOTER_SIZE;
    if (hasBytes(bytes, offset + FOOTER_TEXT.length + INFO_BYTES + VERSION_BYTES, COOKIE)) {
      if (!isDsvFooterAt(bytes, offset)) throw error("InvalidGameSaveBackup");
      return bytes.slice(0, offset);
    }
    return null;
  }

  function readDsvFooter(bytes) {
    if (bytes.length < DSV_FOOTER_SIZE) return null;
    const offset = bytes.length - DSV_FOOTER_SIZE;
    if (!isDsvFooterAt(bytes, offset)) return null;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const base = offset + FOOTER_TEXT.length;
    return {
      offset,
      size: view.getUint32(base, true),
      padSize: view.getUint32(base + 4, true),
      type: view.getUint32(base + 8, true),
      addrSize: view.getUint32(base + 12, true),
      memSize: view.getUint32(base + 16, true)
    };
  }

  // Builds a DeSmuME .dsv file around raw save bytes. On import DeSmuME only
  // validates the cookie, version, and padSize (mc.cpp GetDSVFileInfo), and
  // then applies info.padSize and info.addr_size; type and mem_size are kept
  // for informational parity with the footer DeSmuME itself writes.
  function wrapDsvFooter(raw, info = {}) {
    const out = new Uint8Array(raw.length + DSV_FOOTER_SIZE);
    out.set(raw, 0);
    let at = raw.length;
    for (let i = 0; i < FOOTER_TEXT.length; i += 1) out[at + i] = FOOTER_TEXT.charCodeAt(i);
    at += FOOTER_TEXT.length;
    const view = new DataView(out.buffer);
    view.setUint32(at, raw.length, true);
    view.setUint32(at + 4, raw.length, true);
    view.setUint32(at + 8, info.type ?? 0, true);
    view.setUint32(at + 12, info.addrSize ?? 2, true);
    view.setUint32(at + 16, info.memSize ?? raw.length, true);
    at += INFO_BYTES;
    view.setUint32(at, 0, true);
    at += VERSION_BYTES;
    for (let i = 0; i < COOKIE.length; i += 1) out[at + i] = COOKIE.charCodeAt(i);
    return out;
  }

  window.RetroSaveBridge = Object.freeze({ stripDsvFooter, readDsvFooter, wrapDsvFooter, isDsvFooter, DSV_FOOTER_SIZE });
})();
