"use strict";
(() => {
  const BLOCK = 1024 * 1024;
  const LIMIT = 8;
  class LazyRom {
    constructor(file, changed = () => {}) {
      this.shared = new SharedArrayBuffer(BLOCK + 8);
      this.state = new Int32Array(this.shared, 0, 2);
      this.bytes = new Uint8Array(this.shared, 8);
      this.worker = new Worker('/assets/js/rom-reader-worker.js?v=2.10.1');
      this.ready = new Promise((resolve, reject) => {
        this.rejectReady = reject;
        this.initTimeout = setTimeout(() => { this.worker.terminate(); reject(new Error('lazyRomUnavailable')); }, 10000);
        this.worker.onmessage = event => { clearTimeout(this.initTimeout); if (event.data.ready) resolve(); else reject(new Error('lazyRomUnavailable')); };
        this.worker.onerror = () => { clearTimeout(this.initTimeout); reject(new Error('lazyRomUnavailable')); };
      });
      this.ready.catch(() => {});
      try { this.worker.postMessage({ type: 'init', file, shared: this.shared }); } catch (error) { clearTimeout(this.initTimeout); this.worker.terminate(); this.rejectReady(error); }
      this.file = file; this.changed = changed; this.cache = new Map(); this.stopped = false;
      this.stats = { mode: 'lazy-local', size: file.size, reads: 0, bytesRead: 0, cacheBytes: 0, cacheLimit: BLOCK * LIMIT, largestRead: 0, state: 'waiting' };
    }
    read(position, length) {
      if (this.stopped) throw new Error('lazyRomReadError');
      if (!Number.isSafeInteger(position) || position < 0 || !Number.isSafeInteger(length) || length < 0 || length > BLOCK) throw new Error('lazyRomReadError');
      const count = Math.max(0, Math.min(length, this.file.size - position));
      const output = new Uint8Array(count);
      for (let done = 0; done < count;) {
        const at = position + done; const block = Math.floor(at / BLOCK); const start = block * BLOCK;
        let bytes = this.cache.get(block);
        if (!bytes) {
          const end = Math.min(start + BLOCK, this.file.size);
          Atomics.store(this.state, 0, 1);
          this.worker.postMessage({ type: 'read', start, end });
          // The core requires synchronous reads. Only the worker touches disk;
          // the bounded shared-memory wait never allocates the full ROM.
          const deadline = performance.now() + 5000;
          while (Atomics.load(this.state, 0) === 1) {
            if (performance.now() >= deadline) { this.worker.terminate(); throw new Error('lazyRomReadError'); }
          }
          if (Atomics.load(this.state, 0) !== 2) throw new Error('lazyRomReadError');
          bytes = this.bytes.slice(0, Atomics.load(this.state, 1));
          this.stats.bytesRead += bytes.length; this.stats.largestRead = Math.max(this.stats.largestRead, bytes.length);
          if (this.cache.size >= LIMIT) this.cache.delete(this.cache.keys().next().value);
        } else this.cache.delete(block);
        this.cache.set(block, bytes);
        const offset = at - start; const take = Math.min(count - done, bytes.length - offset);
        output.set(bytes.subarray(offset, offset + take), done); done += take;
      }
      this.stats.reads++; this.stats.cacheBytes = Array.from(this.cache.values()).reduce((sum, bytes) => sum + bytes.length, 0);
      return output;
    }
    mount(FS) {
      if (!FS?.createDataFile || !FS?.lookupPath || !FS?.ErrnoError) throw new Error('lazyRomUnavailable');
      const name = this.file.name.replace(/[/\\\x00]/g, '_');
      FS.createDataFile('/', name, new Uint8Array(), true, false);
      const path = '/' + name; const node = FS.lookupPath(path).node; const originalGetattr = node.node_ops.getattr; const originalSetattr = node.node_ops.setattr;
      const reader = this;
      node.usedBytes = this.file.size;
      node.node_ops = { ...node.node_ops, setattr(node, attributes) { if ('size' in attributes || 'mode' in attributes) throw new FS.ErrnoError(2); return originalSetattr(node, attributes); }, getattr(node) { return { ...originalGetattr(node), size: reader.file.size, blocks: Math.ceil(reader.file.size / 4096) }; } };
      node.stream_ops = { ...node.stream_ops,
        open(stream) { if ((stream.flags & 3) !== 0) throw new FS.ErrnoError(2); },
        read(stream, buffer, offset, length, position) {
          try {
            // Bound each temporary copy, even when the core requests a large read.
            const total = Math.max(0, Math.min(length, reader.file.size - position));
            for (let done = 0; done < total; done += BLOCK) {
              const chunk = reader.read(position + done, Math.min(BLOCK, total - done));
              buffer.set(chunk, offset + done);
            }
            if (reader.stats.reads === 1 || reader.stats.reads % 64 === 0) reader.changed(reader.stats);
            return total;
          } catch (error) { reader.stats.state = 'failed'; reader.changed(reader.stats); throw new FS.ErrnoError(29); }
        },
        llseek(stream, offset, whence) {
          const position = whence === 0 ? offset : whence === 1 ? stream.position + offset : reader.file.size + offset;
          if (!Number.isSafeInteger(position) || position < 0) throw new FS.ErrnoError(28);
          return position;
        },
        write() { throw new FS.ErrnoError(2); },
        allocate() { throw new FS.ErrnoError(2); },
        mmap() { throw new FS.ErrnoError(43); }
      };
      this.stats.state = 'mounted'; this.changed(this.stats); return path;
    }
    stop() { this.stopped = true; clearTimeout(this.initTimeout); this.rejectReady(new Error('lazyRomReadError')); this.worker.terminate(); this.cache.clear(); this.stats.cacheBytes = 0; }
  }
  function install(emulator, file, changed) {
    if (!/\.(3ds|cci|cxi|app|elf|axf)$/i.test(file.name || '') || emulator.ejs_version !== '4.3.0-pre' || emulator.getCore() !== 'azahar' || typeof emulator.download !== 'function') throw new Error('lazyRomUnavailable');
    const reader = new LazyRom(file, changed); const original = emulator.download;
    const wrapped = async function(url, type) {
      if (url !== file || type?.name !== 'rom') return Reflect.apply(original, this, arguments);
      try {
        await reader.ready;
        const path = reader.mount(this.gameManager.FS);
        this.config.gameUrl = path;
        return Promise.resolve({ files: [{ filename: path.slice(1) }] });
      } catch (error) { reader.stats.state = 'failed'; reader.changed(reader.stats); return Promise.reject(error); }
    };
    emulator.download = wrapped;
    return { stats: reader.stats, stop() { reader.stop(); if (emulator.download === wrapped) emulator.download = original; } };
  }
  window.RetroLazyRom = { LazyRom, install };
})();
