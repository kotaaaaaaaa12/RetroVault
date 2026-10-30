"use strict";
let file, state, bytes, remoteUrl, remoteSize, remoteTag;
const MAX_REMOTE_BLOCK = 256 * 1024;
function ioError(code, status = 0) { return Object.assign(new Error('ROM I/O failed'), { ioCode: code, httpStatus: status }); }
function failureValue(error, fallback = 12) { return -((error.ioCode || fallback) * 1000 + (error.httpStatus || 0)); }
async function range(start, end, probe = false) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4500);
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
    if (count <= 0 || count > MAX_REMOTE_BLOCK || count > bytes.length) throw ioError(8);
    const output = new Uint8Array(count);
    const reader = response.body.getReader();
    readingBody = true;
    let done = 0;
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        if (done + part.value.length > count) { reader.cancel().catch(() => {}); throw ioError(9); }
        output.set(part.value, done); done += part.value.length;
      }
    } finally { reader.releaseLock(); }
    if (done !== count) throw ioError(10);
    if (probe) { remoteSize = total; remoteTag = tag; }
    return output;
  } catch (error) {
    if (controller.signal.aborted) throw ioError(readingBody ? 16 : 11);
    throw error.ioCode ? error : ioError(12);
  } finally { clearTimeout(timer); }
}
self.onmessage = async event => {
  const message = event.data;
  if (message.type === 'init') {
    try {
      state = new Int32Array(message.shared, 0, 2);
      bytes = new Uint8Array(message.shared, 8);
      if (message.url) {
        const url = new URL(message.url, self.location.href);
        if (url.origin !== self.location.origin || !url.pathname.startsWith('/data/roms/') || !['http:', 'https:'].includes(url.protocol)) throw ioError(1);
        remoteUrl = url.href;
        const first = await range(0, MAX_REMOTE_BLOCK, true);
        bytes.set(first);
        self.postMessage({ ready: true, size: remoteSize, firstLength: first.length });
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
    const chunk = remoteUrl ? await range(message.start, message.end) : new Uint8Array(new FileReaderSync().readAsArrayBuffer(file.slice(message.start, message.end)));
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
