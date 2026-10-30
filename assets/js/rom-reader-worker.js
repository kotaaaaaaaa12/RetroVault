"use strict";
let file, state, bytes, remoteUrl, remoteSize, remoteTag;
let probeBytes, diskHandle, diskDirectory, diskName, diskReady = false, diskTask, disposing = false;
let persistent = false, cacheKey, committed = false, diskOwned = false, displayName = '', cacheReused = false;
const controllers = new Set();
const MAX_REMOTE_BLOCK = 256 * 1024;
function ioError(code, status = 0) { return Object.assign(new Error('ROM I/O failed'), { ioCode: code, httpStatus: status }); }
function failureValue(error, fallback = 12) { return -((error.ioCode || fallback) * 1000 + (error.httpStatus || 0)); }
async function range(start, end, probe = false, sink = null) {
  const controller = new AbortController();
  controllers.add(controller);
  let timer;
  const arm = () => { clearTimeout(timer); timer = setTimeout(() => controller.abort(), sink ? 20000 : 4500); };
  arm();
  let readingBody = false;
  try {
    const response = await fetch(remoteUrl, { headers: { Range: `bytes=${start}-${end - 1}` }, credentials: 'same-origin', redirect: 'error', cache: 'no-store', signal: controller.signal });
    const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('Content-Range') || '');
    const total = match ? Number(match[3]) : NaN;
    const tag = response.headers.get('ETag');
    let invalid = response.status !== 206 ? 2
      : !match || !Number.isSafeInteger(total) || total <= 0 || Number(match[1]) !== start || Number(match[2]) !== Math.min(end, total) - 1 ? 3
      : !tag ? 4 : remoteTag && tag !== remoteTag ? 5 : !probe && total !== remoteSize ? 6
      : response.headers.get('Content-Encoding') ? 7 : 0;
    if (invalid) { response.body?.cancel().catch(() => {}); throw ioError(invalid, response.status); }
    const count = Math.min(end, total) - start;
    if (count <= 0 || count > (sink ? 4 * 1024 * 1024 : MAX_REMOTE_BLOCK) || (!sink && count > bytes.length)) throw ioError(8);
    const output = sink ? null : new Uint8Array(count);
    const reader = response.body.getReader();
    readingBody = true;
    let done = 0;
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        if (done + part.value.length > count) { reader.cancel().catch(() => {}); throw ioError(9); }
        if (sink) writeDisk(part.value, start + done);
        else output.set(part.value, done);
        done += part.value.length;
        if (sink) { arm(); diskProgress(start + done); }
      }
    } finally { reader.releaseLock(); }
    if (done !== count) throw ioError(10);
    if (probe) { remoteSize = total; remoteTag = tag; }
    return output;
  } catch (error) {
    if (controller.signal.aborted) throw ioError(readingBody ? 16 : 11);
    throw error.ioCode ? error : ioError(12);
  } finally { clearTimeout(timer); controllers.delete(controller); }
}
let lastProgress = 0;
function diskProgress(completed, force = false) {
  const now = Date.now();
  if (force || now - lastProgress >= 250) {
    lastProgress = now;
    self.postMessage({ type: 'disk-progress', completed, total: remoteSize });
  }
}
function writeDisk(chunk, position) {
  if (disposing) throw ioError(21);
  for (let done = 0; done < chunk.length;) {
    let written;
    try { written = diskHandle.write(chunk.subarray(done, Math.min(done + 65536, chunk.length)), { at: position + done }); }
    catch (error) { throw ioError(error.name === 'QuotaExceededError' ? 18 : 19); }
    if (!Number.isInteger(written) || written <= 0 || written > Math.min(65536, chunk.length - done)) throw ioError(19);
    done += written;
  }
}
async function cleanupDisk() {
  diskReady = false;
  try {
    if (diskHandle) { await diskHandle.close(); diskHandle = null; }
    if (persistent && committed) return 'retained';
    if (diskOwned && diskDirectory && diskName) {
      await diskDirectory.removeEntry(diskName);
      if (persistent && cacheKey) { try { await diskDirectory.removeEntry(cacheKey + '.json'); } catch {} }
    }
    diskName = null;
    return 'removed';
  } catch { return 'pending'; }
}
async function cacheSetup() {
  try {
    if (!globalThis.RetroRomCache) importScripts('/assets/js/rom-cache.js?v=2.16.0');
    cacheKey = await RetroRomCache.key(remoteUrl, remoteTag, remoteSize);
    diskDirectory = await RetroRomCache.directory(true);
  } catch (error) { throw ioError(error.name === 'QuotaExceededError' ? 18 : 17); }
}
async function tryReusableCache() {
  const meta = await RetroRomCache.metadata(diskDirectory, cacheKey);
  if (!meta || meta.size !== remoteSize || meta.etag !== remoteTag) return false;
  let handle;
  try { handle = await diskDirectory.getFileHandle(cacheKey + '.rom'); }
  catch (error) { if (error.name === 'NotFoundError') return false; throw error; }
  try { diskHandle = await handle.createSyncAccessHandle(); }
  catch (error) { if (['NoModificationAllowedError', 'InvalidStateError'].includes(error.name)) throw ioError(22); throw error; }
  diskName = cacheKey + '.rom'; diskOwned = true;
  const actual = new Uint8Array(probeBytes.length);
  let valid = false;
  try { valid = diskHandle.getSize() === remoteSize && diskHandle.read(actual, { at: 0 }) === actual.length && actual.every((byte, index) => byte === probeBytes[index]); } catch {}
  if (!valid) {
    await cleanupDisk(); return false;
  }
  committed = true; diskReady = true; cacheReused = true;
  return true;
}
async function prepareDisk() {
  if (!remoteUrl || !self.navigator?.storage?.getDirectory) throw ioError(17);
  try {
    const root = await self.navigator.storage.getDirectory();
    if (persistent) {
      await cacheSetup();
      await RetroRomCache.locked(async () => {
        if (await tryReusableCache()) return;
        // Reclaim only unlocked files left by the earlier temporary-copy path.
        try {
          const old = await root.getDirectoryHandle('retrovault-rom-temp-v1');
          for await (const name of old.keys()) if (/^rom-[a-f0-9-]+\.tmp$/.test(name)) { try { await old.removeEntry(name); } catch {} }
        } catch {}
        diskName = cacheKey + '.rom';
        const handle = await diskDirectory.getFileHandle(diskName, { create: true });
        try { diskHandle = await handle.createSyncAccessHandle(); }
        catch (error) { if (['NoModificationAllowedError', 'InvalidStateError'].includes(error.name)) throw ioError(22); throw error; }
        diskOwned = true;
      });
      if (committed) { diskProgress(remoteSize, true); return; }
    } else {
    diskDirectory = await root.getDirectoryHandle('retrovault-rom-temp-v1', { create: true });
    const open = async (removeStale = false) => {
      if (removeStale) {
        for await (const name of diskDirectory.keys()) {
          if (/^rom-[a-f0-9-]+\.tmp$/.test(name)) {
            // Active sessions hold exclusive access handles. Locked files are
            // skipped; only this dedicated temporary-ROM directory is touched.
            try { await diskDirectory.removeEntry(name); } catch {}
          }
        }
      }
      if (disposing) throw ioError(21);
      diskName = `rom-${self.crypto.randomUUID()}.tmp`;
      const handle = await diskDirectory.getFileHandle(diskName, { create: true });
      if (typeof handle.createSyncAccessHandle !== 'function') throw ioError(17);
      diskHandle = await handle.createSyncAccessHandle();
      diskOwned = true;
    };
    if (self.navigator.locks?.request) await self.navigator.locks.request('retrovault-rom-temp-v1', () => open(true));
    else await open();
    }
    diskHandle.truncate(0);
    let estimate;
    try { estimate = await self.navigator.storage.estimate?.(); } catch {}
    if (Number.isFinite(estimate?.quota) && Number.isFinite(estimate?.usage) && estimate.quota - estimate.usage < remoteSize) throw ioError(18);
    writeDisk(probeBytes, 0); diskProgress(probeBytes.length, true);
    for (let start = probeBytes.length; start < remoteSize; start += 4 * 1024 * 1024) {
      if (disposing) throw ioError(21);
      await range(start, Math.min(start + 4 * 1024 * 1024, remoteSize), false, diskHandle);
    }
    await diskHandle.flush();
    if (disposing) throw ioError(21);
    if (diskHandle.getSize() !== remoteSize) throw ioError(19);
    if (persistent) {
      await RetroRomCache.writeMetadata(diskDirectory, cacheKey, { schema: 1, name: displayName, size: remoteSize, etag: remoteTag });
      committed = true;
    }
    diskReady = true; diskProgress(remoteSize, true);
  } catch (error) {
    const classified = error.ioCode ? error : ioError(error.name === 'QuotaExceededError' ? 18 : diskHandle ? 19 : 17);
    await cleanupDisk();
    throw classified;
  }
}
self.onmessage = async event => {
  const message = event.data;
  if (message.type === 'dispose') {
    disposing = true;
    for (const controller of controllers) controller.abort();
    await diskTask?.catch(() => {});
    self.postMessage({ type: 'disposed', cleanup: await cleanupDisk() });
    return;
  }
  if (disposing) return;
  if (message.type === 'prepare-disk') {
    if (diskTask) return;
    diskTask = prepareDisk();
    try { await diskTask; if (!disposing) self.postMessage({ type: 'disk-ready', ok: true, persistent, reused: cacheReused }); }
    catch (error) { if (!disposing) self.postMessage({ type: 'disk-ready', ok: false, failure: failureValue(error, 19) }); }
    return;
  }
  if (message.type === 'init') {
    try {
      state = new Int32Array(message.shared, 0, 2);
      bytes = new Uint8Array(message.shared, 8);
      if (message.url) {
        persistent = message.persistent === true; displayName = String(message.fileName || '').slice(0, 255);
        const url = new URL(message.url, self.location.href);
        if (url.origin !== self.location.origin || !url.pathname.startsWith('/data/roms/') || !['http:', 'https:'].includes(url.protocol)) throw ioError(1);
        remoteUrl = url.href;
        const first = await range(0, MAX_REMOTE_BLOCK, true);
        probeBytes = first;
        let reused = false;
        if (persistent) {
          await cacheSetup();
          reused = await RetroRomCache.locked(() => tryReusableCache());
        }
        bytes.set(first);
        self.postMessage({ ready: true, size: remoteSize, firstLength: first.length, reused, persistent, cacheKey });
      } else {
        file = message.file;
        const expected = Uint8Array.from({ length: 256 }, (_, i) => i);
        const actual = new Uint8Array(new FileReaderSync().readAsArrayBuffer(new Blob([expected])));
        if (!expected.every((value, i) => actual[i] === value)) throw new Error('Binary read unavailable');
        self.postMessage({ ready: true });
      }
    } catch (error) { self.postMessage({ ready: false, failure: failureValue(error, remoteUrl ? 12 : 14) }); }
    return;
  }
  if (!['read', 'prefetch'].includes(message.type)) return;
  try {
    if (!Number.isSafeInteger(message.start) || !Number.isSafeInteger(message.end) || message.start < 0 || message.end <= message.start || message.end - message.start > bytes.length) throw ioError(13);
    let chunk;
    if (diskReady) {
      chunk = new Uint8Array(message.end - message.start);
      try { if (diskHandle.read(chunk, { at: message.start }) !== chunk.length) throw ioError(20); }
      catch { throw ioError(20); }
    } else chunk = remoteUrl ? await range(message.start, message.end) : new Uint8Array(new FileReaderSync().readAsArrayBuffer(file.slice(message.start, message.end)));
    if (chunk.length > bytes.length || chunk.length !== message.end - message.start) throw ioError(10);
    bytes.set(chunk);
    if (message.type === 'prefetch') { self.postMessage({ type: 'prefetch', requestId: message.requestId, ok: true, length: chunk.length }); return; }
    Atomics.store(state, 1, chunk.length);
    Atomics.store(state, 0, 2);
  } catch (error) {
    const failure = failureValue(error, remoteUrl ? 12 : 14);
    if (message.type === 'prefetch') self.postMessage({ type: 'prefetch', requestId: message.requestId, ok: false, failure });
    else { Atomics.store(state, 1, failure); Atomics.store(state, 0, -1); }
  }
};
