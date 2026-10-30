"use strict";
let file, state, bytes, remoteUrl, remoteSize, remoteTag;
const MAX_REMOTE_BLOCK = 256 * 1024;
async function range(start, end, probe = false) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4500);
  try {
    const response = await fetch(remoteUrl, { headers: { Range: `bytes=${start}-${end - 1}` }, credentials: 'same-origin', redirect: 'error', cache: 'no-store', signal: controller.signal });
    const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('Content-Range') || '');
    const total = match ? Number(match[3]) : NaN;
    const tag = response.headers.get('ETag');
    const valid = response.status === 206 && match && Number.isSafeInteger(total) && total > 0 && Number(match[1]) === start && Number(match[2]) === Math.min(end, total) - 1 && tag && (!remoteTag || tag === remoteTag) && (probe || total === remoteSize) && !response.headers.get('Content-Encoding');
    if (!valid) { response.body?.cancel().catch(() => {}); throw new Error('Invalid range response'); }
    const count = Math.min(end, total) - start;
    if (count <= 0 || count > MAX_REMOTE_BLOCK || count > bytes.length) throw new Error('Invalid range size');
    const output = new Uint8Array(count);
    const reader = response.body.getReader();
    let done = 0;
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        if (done + part.value.length > count) { reader.cancel().catch(() => {}); throw new Error('Oversized range response'); }
        output.set(part.value, done); done += part.value.length;
      }
    } finally { reader.releaseLock(); }
    if (done !== count) throw new Error('Short range response');
    if (probe) { remoteSize = total; remoteTag = tag; }
    return output;
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
        if (url.origin !== self.location.origin || !url.pathname.startsWith('/data/roms/') || !['http:', 'https:'].includes(url.protocol)) throw new Error('Unsupported ROM URL');
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
    } catch { self.postMessage({ ready: false }); }
    return;
  }
  if (message.type !== 'read') return;
  try {
    if (!Number.isSafeInteger(message.start) || !Number.isSafeInteger(message.end) || message.start < 0 || message.end <= message.start || message.end - message.start > bytes.length) throw new Error('Invalid read');
    const chunk = remoteUrl ? await range(message.start, message.end) : new Uint8Array(new FileReaderSync().readAsArrayBuffer(file.slice(message.start, message.end)));
    if (chunk.length > bytes.length || chunk.length !== message.end - message.start) throw new Error('Short read');
    bytes.set(chunk);
    Atomics.store(state, 1, chunk.length);
    Atomics.store(state, 0, 2);
  } catch { Atomics.store(state, 0, -1); }
};
