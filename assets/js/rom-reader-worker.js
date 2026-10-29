"use strict";
let file, state, bytes;
self.onmessage = event => {
  const message = event.data;
  if (message.type === 'init') {
    try {
      file = message.file;
      state = new Int32Array(message.shared, 0, 2);
      bytes = new Uint8Array(message.shared, 8);
      const expected = Uint8Array.from({ length: 256 }, (_, i) => i);
      const actual = new Uint8Array(new FileReaderSync().readAsArrayBuffer(new Blob([expected])));
      if (!expected.every((value, i) => actual[i] === value)) throw new Error('Binary read unavailable');
      self.postMessage({ ready: true });
    } catch { self.postMessage({ ready: false }); }
    return;
  }
  if (message.type !== 'read') return;
  try {
    const chunk = new Uint8Array(new FileReaderSync().readAsArrayBuffer(file.slice(message.start, message.end)));
    if (chunk.length > bytes.length || chunk.length !== message.end - message.start) throw new Error('Short read');
    bytes.set(chunk);
    Atomics.store(state, 1, chunk.length);
    Atomics.store(state, 0, 2);
  } catch { Atomics.store(state, 0, -1); }
};
