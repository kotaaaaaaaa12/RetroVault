"use strict";
(() => {
  const DIRECTORY = 'retrovault-rom-cache-v1', LOCK = 'retrovault-rom-cache-v1';
  const validKey = key => /^[a-f0-9]{64}$/.test(key);
  const navigator = globalThis.navigator || globalThis.self?.navigator;
  async function directory(create = false) {
    if (!navigator?.storage?.getDirectory) throw new Error('romDiskUnavailable');
    const root = await navigator.storage.getDirectory();
    try { return await root.getDirectoryHandle(DIRECTORY, { create }); }
    catch (error) { if (!create && error.name === 'NotFoundError') return null; throw error; }
  }
  function locked(callback) { return navigator?.locks?.request ? navigator.locks.request(LOCK, callback) : callback(); }
  async function key(url, etag, size) {
    const input = new TextEncoder().encode(JSON.stringify([url, etag, size]));
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', input));
    return Array.from(hash, byte => byte.toString(16).padStart(2, '0')).join('');
  }
  async function metadata(dir, key) {
    try {
      if (!validKey(key)) return null;
      const file = await (await dir.getFileHandle(key + '.json')).getFile();
      if (file.size > 4096) return null;
      const value = JSON.parse(await file.text());
      return value.schema === 1 && Number.isSafeInteger(value.size) && value.size > 0 && typeof value.etag === 'string' && value.etag.length <= 1024 && typeof value.name === 'string' && value.name.length <= 255 ? value : null;
    } catch { return null; }
  }
  async function writeMetadata(dir, key, value) {
    if (!validKey(key)) throw new Error('Invalid cache key');
    const file = await dir.getFileHandle(key + '.json', { create: true });
    const handle = await file.createSyncAccessHandle();
    try {
      const bytes = new TextEncoder().encode(JSON.stringify(value));
      if (bytes.length > 4096) throw new Error('Invalid cache metadata');
      handle.truncate(0);
      let done = 0;
      while (done < bytes.length) {
        const count = handle.write(bytes.subarray(done), { at: done });
        if (!Number.isInteger(count) || count <= 0 || count > bytes.length - done) throw new Error('Short metadata write');
        done += count;
      }
      await handle.flush();
    } finally { await handle.close(); }
  }
  async function list() {
    const dir = await directory(); if (!dir) return [];
    const entries = [];
    for await (const name of dir.keys()) {
      if (!/^[a-f0-9]{64}\.rom$/.test(name)) continue;
      const key = name.slice(0, -4), meta = await metadata(dir, key);
      let size = meta?.size || 0;
      try { size = (await (await dir.getFileHandle(name)).getFile()).size; } catch {}
      entries.push({ key, name: meta?.name || key.slice(0, 12) + '.rom', size, complete: !!meta && size === meta.size });
    }
    return entries.sort((a, b) => a.name.localeCompare(b.name));
  }
  async function remove(key) {
    if (!validKey(key)) throw new Error('Invalid cache key');
    return locked(async () => {
      const dir = await directory(); if (!dir) return;
      // Deleting an entry with an active exclusive access handle fails. Remove
      // its manifest only after the ROM entry is successfully removed.
      try { await dir.removeEntry(key + '.rom'); }
      catch (error) { if (error.name !== 'NotFoundError') throw new Error('romCacheBusy'); }
      try { await dir.removeEntry(key + '.json'); } catch (error) { if (error.name !== 'NotFoundError') throw error; }
    });
  }
  globalThis.RetroRomCache = { directory, locked, key, metadata, writeMetadata, list, remove };
})();
