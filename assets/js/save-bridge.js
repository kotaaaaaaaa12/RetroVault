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

  window.RetroSaveBridge = Object.freeze({ stripDsvFooter, isDsvFooter, DSV_FOOTER_SIZE });
})();
