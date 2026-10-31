"use strict";
(() => {
  const BLOCK = 1024 * 1024;
  const LIMIT = 8;
  function inspectHeader(bytes, size) {
    // Report only container metadata. The flag describes the header; it does
    // not independently prove whether the content bytes were decrypted.
    if (bytes.length < 0x200) return { format: 'unknown', state: 'short-probe' };
    const magic = at => String.fromCharCode(...bytes.subarray(at + 0x100, at + 0x104));
    const format = magic(0);
    if (!['NCSD', 'NCCH'].includes(format)) return { format: 'unknown', state: 'unrecognized' };
    const result = { format };
    let offset = 0;
    if (format === 'NCSD') {
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      offset = view.getUint32(0x120, true) * 512;
      const length = view.getUint32(0x124, true) * 512;
      result.partitionOffset = offset; result.partitionSize = length;
      if (!offset || !length || offset + length > size) return { ...result, state: 'invalid-partition-bounds' };
    }
    result.ncchOffset = offset;
    if (offset + 0x200 > bytes.length) return { ...result, state: 'outside-probe' };
    if (magic(offset) !== 'NCCH') return { ...result, state: 'missing-ncch-magic' };
    const flagsOffset = offset + 0x18f;
    return { ...result, state: 'observed', flagsOffset, flagsByte: bytes[flagsOffset], noCryptoFlag: !!(bytes[flagsOffset] & 4) };
  }
  async function inspectExheaderHash(bytes, size, header) {
    // This checks only the standard 0x400-byte exheader against its stored
    // digest. A match does not validate ExeFS, RomFS, or the complete ROM.
    const result = { algorithm: 'SHA-256', scope: 'NCCH exheader only' };
    if (header?.state !== 'observed') return { ...result, state: 'header-unavailable' };
    const offset = header.ncchOffset;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const length = view.getUint32(offset + 0x180, true);
    if (!length) return { ...result, state: 'no-exheader' };
    if (length !== 0x400) return { ...result, state: 'unsupported-size', declaredSize: length };
    const start = offset + 0x200, end = start + length;
    if (end > size || (header.format === 'NCSD' && end > offset + header.partitionSize)) return { ...result, state: 'invalid-bounds' };
    if (end > bytes.length) return { ...result, state: 'outside-probe' };
    const expected = bytes.subarray(offset + 0x160, offset + 0x180);
    if (expected.every(byte => byte === 0)) return { ...result, state: 'missing-digest' };
    try {
      if (!globalThis.crypto?.subtle?.digest) return { ...result, state: 'unavailable' };
      const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes.subarray(start, end)));
      return { ...result, state: digest.every((byte, index) => byte === expected[index]) ? 'match' : 'mismatch', bytesHashed: length };
    } catch {
      // Diagnostic failure must not block mounting or change core behavior.
      return { ...result, state: 'unavailable' };
    }
  }
  async function verifyPlaintextRegions(first, size, header, read) {
    const result = { state: 'not-applied', scope: 'NCCH exheader, ExeFS files and RomFS superblock; not the complete RomFS', checks: [] };
    const skip = reason => ({ ...result, reason });
    if (header?.state !== 'observed') return skip('header-unavailable');
    if (header.noCryptoFlag) return skip('already-no-crypto');
    if (header.exheaderHash?.state !== 'match') return skip('exheader-not-verified');
    result.checks.push({ region: 'exheader', state: 'match', bytesHashed: 1024 });
    const base = header.ncchOffset;
    const view = new DataView(first.buffer, first.byteOffset, first.byteLength);
    const u32 = at => view.getUint32(base + at, true);
    // Restrict normalization to the standard format used by the pinned core.
    if (view.getUint16(base + 0x112, true) !== 2 || first[base + 0x18e] !== 0) return skip('unsupported-ncch-layout');
    const contentSize = u32(0x104) * 512, end = base + contentSize;
    if (contentSize < 0xa00 || end > size || (header.format === 'NCSD' && contentSize > header.partitionSize)) return skip('invalid-content-bounds');
    const regions = [
      { region: 'exefs-superblock', offset: u32(0x1a0) * 512, size: u32(0x1a4) * 512, hashSize: u32(0x1a8) * 512, hashAt: base + 0x1c0 },
      { region: 'romfs-superblock', offset: u32(0x1b0) * 512, size: u32(0x1b4) * 512, hashSize: u32(0x1b8) * 512, hashAt: base + 0x1e0 }
    ];
    const [exefs, romfs] = regions;
    for (const section of regions) {
      if (!section.size && section === romfs && !section.offset && !section.hashSize) continue;
      if (section.offset < 0xa00 || section.size < 512 || section.hashSize < 512 || section.hashSize > section.size || base + section.offset + section.size > end) return skip('invalid-section-bounds');
      if (section.hashSize > BLOCK) return skip('superblock-check-limit');
    }
    if (romfs.size && exefs.offset < romfs.offset + romfs.size && romfs.offset < exefs.offset + exefs.size) return skip('overlapping-sections');
    let bytesHashed = 1024;
    const check = async (region, start, length, expected) => {
      if (!expected.some(byte => byte !== 0)) { result.checks.push({ region, state: 'missing-digest' }); return null; }
      const bytes = await read(start, length);
      if (bytes.length !== length) throw new Error('lazyRomReadError');
      let digest;
      try { digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes)); }
      catch { result.checks.push({ region, state: 'unavailable' }); return null; }
      const matches = digest.every((byte, index) => byte === expected[index]);
      bytesHashed += length;
      result.checks.push({ region, state: matches ? 'match' : 'mismatch', bytesHashed: length });
      return matches ? bytes : null;
    };
    const exefsBytes = await check(exefs.region, base + exefs.offset, exefs.hashSize, first.subarray(exefs.hashAt, exefs.hashAt + 32));
    if (!exefsBytes) return skip('exefs-superblock-not-verified');
    if (exefsBytes.subarray(0x80, 0x100).some(byte => byte !== 0)) return skip('unsupported-exefs-layout');
    const files = [], table = new DataView(exefsBytes.buffer, exefsBytes.byteOffset, exefsBytes.byteLength);
    let total = 0, hasCode = false;
    // The pinned Azahar core supports eight entries with hashes in reverse order.
    for (let i = 0; i < 8; i++) {
      const at = i * 16, name = exefsBytes.subarray(at, at + 8);
      const offset = table.getUint32(at + 8, true), length = table.getUint32(at + 12, true);
      if (!name.some(byte => byte !== 0) && !offset && !length) continue;
      if (!name.some(byte => byte !== 0) || !length || 512 + offset + length > exefs.size) return skip('invalid-exefs-entry');
      const start = base + exefs.offset + 512 + offset;
      if (files.some(file => start < file.start + file.length && file.start < start + length)) return skip('overlapping-exefs-files');
      total += length;
      if (length > 32 * BLOCK || total > 64 * BLOCK) return skip('exefs-check-limit');
      hasCode ||= String.fromCharCode(...name).replace(/\0.*$/, '') === '.code';
      files.push({ start, length, region: `exefs-file-${i}`, hashAt: 0x1e0 - i * 32 });
    }
    if (!hasCode) return skip('missing-code-entry');
    for (const file of files) {
      if (!await check(file.region, file.start, file.length, exefsBytes.subarray(file.hashAt, file.hashAt + 32))) return skip('exefs-file-not-verified');
    }
    if (romfs.size && !await check(romfs.region, base + romfs.offset, romfs.hashSize, first.subarray(romfs.hashAt, romfs.hashAt + 32))) return skip('romfs-superblock-not-verified');
    return { ...result, state: 'verified', bytesHashed };
  }
  class LazyRom {
    recordIoFailure(value, phase, offset, length, waitMs) {
      const encoded = Number.isInteger(value) && value < 0 ? -value : 0;
      const code = Math.floor(encoded / 1000), httpStatus = encoded % 1000;
      const reasons = { 1: 'unsupported-url', 2: 'http-status', 3: 'content-range', 4: 'missing-etag', 5: 'changed-etag', 6: 'changed-size', 7: 'content-encoding', 8: 'range-size', 9: 'oversized-body', 10: 'short-body', 11: 'response-timeout', 12: 'network-error', 13: 'invalid-read', 14: 'local-file-read', 16: 'body-timeout', 17: 'opfs-unavailable', 18: 'opfs-quota', 19: 'opfs-write', 20: 'opfs-read', 21: 'preparation-cancelled', 22: 'cache-in-use' };
      this.stats.ioFailure = { phase, transport: this.stats.mode === 'lazy-opfs' ? 'OPFS' : this.remote ? 'fetch' : 'FileReaderSync', reason: typeof value === 'string' ? value : reasons[code] || 'worker-read-failed' };
      if (httpStatus) this.stats.ioFailure.httpStatus = httpStatus;
      if (Number.isSafeInteger(offset)) this.stats.ioFailure.offset = offset;
      if (Number.isSafeInteger(length)) this.stats.ioFailure.length = length;
      if (Number.isFinite(waitMs)) this.stats.ioFailure.waitMs = Math.round(waitMs);
    }
    constructor(file, changed = () => {}, { persistent = false } = {}) {
      this.remote = typeof file.url === 'string';
      this.block = this.remote ? 256 * 1024 : BLOCK;
      this.file = file; this.changed = changed; this.cache = new Map(); this.stopped = false;
      this.stats = { mode: this.remote ? 'lazy-range' : 'lazy-local', fileName: String(file.name || '').slice(0, 255), size: file.size, reads: 0, bytesRead: 0, cacheBytes: 0, cacheLimit: BLOCK * LIMIT, largestRead: 0, state: 'preparing' };
      this.shared = new SharedArrayBuffer(this.block + 8);
      this.state = new Int32Array(this.shared, 0, 2);
      this.bytes = new Uint8Array(this.shared, 8);
      this.worker = new Worker('/assets/js/rom-reader-worker.js?v=2.18.0');
      this.ready = new Promise((resolve, reject) => {
        this.rejectReady = reject;
        this.initTimeout = setTimeout(() => { this.recordIoFailure('worker-init-timeout', 'probe'); this.worker.terminate(); reject(new Error('lazyRomUnavailable')); }, 10000);
        this.worker.onmessage = async event => {
          if (event.data.type === 'disposed') {
            if (this.stats.disk) this.stats.disk.cleanup = ['removed', 'retained'].includes(event.data.cleanup) ? event.data.cleanup : 'pending';
            this.finishDispose?.(); return;
          }
          if (this.stopped) return;
          if (event.data.type === 'disk-progress') {
            if (this.pendingDisk && event.data.total === this.file.size && Number.isSafeInteger(event.data.completed) && event.data.completed >= 0 && event.data.completed <= this.file.size) {
              this.stats.disk.completed = Math.max(this.stats.disk.completed, event.data.completed);
              this.resetDiskTimeout(); this.changed(this.stats);
            }
            return;
          }
          if (event.data.type === 'disk-ready') {
            const pending = this.pendingDisk;
            if (!pending) return;
            this.pendingDisk = null; clearTimeout(this.diskTimeout);
            if (!event.data.ok) {
              this.recordIoFailure(event.data.failure, 'disk-preparation');
              const code = Math.floor(-event.data.failure / 1000);
              this.stats.errorKey = code === 17 ? 'romDiskUnavailable' : code === 18 ? 'romDiskSpace' : code === 22 ? 'romCacheBusy' : 'romDiskFailed';
              this.stats.disk.state = 'failed';
              pending.reject(new Error('The device ROM copy could not be prepared.'));
            } else {
              this.stats.mode = 'lazy-opfs'; this.stats.disk.state = 'ready'; this.stats.disk.completed = this.file.size;
              this.stats.disk.persistent = event.data.persistent === true;
              this.stats.disk.reused = event.data.reused === true;
              this.cache.clear(); this.stats.cacheBytes = 0;
              this.changed(this.stats); pending.resolve();
            }
            return;
          }
          if (event.data.type === 'prefetch') {
            const pending = this.pendingPrefetch;
            if (!pending || event.data.requestId !== pending.id) return;
            this.pendingPrefetch = null; clearTimeout(pending.timer);
            if (!event.data.ok || event.data.length !== pending.length) { this.recordIoFailure(event.data.failure, 'verification', pending.start, pending.length); pending.reject(new Error('lazyRomReadError')); }
            else pending.resolve(this.bytes.slice(0, event.data.length));
            return;
          }
          clearTimeout(this.initTimeout);
          if (this.stopped) return;
          if (!event.data.ready) {
            this.recordIoFailure(event.data.failure, 'probe');
            const code = Math.floor(-event.data.failure / 1000);
            if ([17, 18, 22].includes(code)) this.stats.errorKey = code === 22 ? 'romCacheBusy' : code === 18 ? 'romDiskSpace' : 'romDiskUnavailable';
            return reject(new Error('lazyRomUnavailable'));
          }
          if (this.remote) {
            const { size, firstLength } = event.data;
            if (!Number.isSafeInteger(size) || size <= 0 || firstLength !== Math.min(size, this.block)) return reject(new Error('lazyRomUnavailable'));
            this.file.size = size; this.stats.size = size;
            if (event.data.reused === true) {
              this.diskRequested = true; this.stats.mode = 'lazy-opfs';
              this.stats.disk = { state: 'ready', persistent: true, reused: true, completed: size, total: size, cleanup: 'not-started' };
            }
            const first = this.bytes.slice(0, firstLength);
            this.cache.set(0, first);
            this.stats.header = inspectHeader(first, size);
            this.stats.header.exheaderHash = await inspectExheaderHash(first, size, this.stats.header);
            if (this.stopped) return;
            this.stats.cacheBytes = firstLength; this.stats.bytesRead = firstLength; this.stats.largestRead = firstLength;
            this.stats.state = 'verifying'; this.changed(this.stats);
            try {
              this.verificationDeadline = performance.now() + 60000;
              this.stats.header.compatibility = await verifyPlaintextRegions(first, size, this.stats.header, (start, length) => this.readAsync(start, length));
              if (this.stopped) return;
              if (this.stats.header.compatibility.state === 'verified') {
                this.virtualFlagsByte = this.stats.header.flagsByte | 4;
                Object.assign(this.stats.header.compatibility, { state: 'applied', flagsOffset: this.stats.header.flagsOffset, originalFlagsByte: this.stats.header.flagsByte, virtualFlagsByte: this.virtualFlagsByte });
              }
            } catch (error) {
              this.stats.header.compatibility = { state: 'not-applied', reason: 'verification-read-failed' };
              return reject(error);
            }
          }
          this.stats.state = 'ready'; this.changed(this.stats); resolve();
        };
        this.worker.onerror = () => {
          this.recordIoFailure('worker-error', this.pendingDisk ? 'disk-preparation' : this.pendingPrefetch ? 'verification' : 'probe');
          clearTimeout(this.initTimeout);
          if (this.pendingPrefetch) { clearTimeout(this.pendingPrefetch.timer); this.pendingPrefetch.reject(new Error('lazyRomReadError')); this.pendingPrefetch = null; }
          if (this.pendingDisk) { clearTimeout(this.diskTimeout); this.stats.errorKey = 'romDiskFailed'; this.stats.disk.state = 'failed'; this.pendingDisk.reject(new Error('The ROM reader stopped during preparation.')); this.pendingDisk = null; }
          reject(new Error('lazyRomUnavailable'));
        };
      });
      this.ready.catch(() => { if (!this.stopped) { this.worker.terminate(); this.stats.state = 'failed'; this.changed(this.stats); } });
      try { this.worker.postMessage({ type: 'init', ...(this.remote ? { url: file.url, persistent, fileName: file.name } : { file }), shared: this.shared }); } catch (error) { clearTimeout(this.initTimeout); this.worker.terminate(); this.rejectReady(error); }
    }
    resetDiskTimeout() {
      clearTimeout(this.diskTimeout);
      this.diskTimeout = setTimeout(() => {
        if (!this.pendingDisk) return;
        this.recordIoFailure('disk-preparation-timeout', 'disk-preparation');
        this.stats.errorKey = 'romDiskFailed'; this.stats.disk.state = 'failed';
        this.pendingDisk.reject(new Error('The device ROM copy preparation timed out.')); this.pendingDisk = null;
      }, 60000);
    }
    prepareDisk() {
      if (this.stats.disk?.state === 'ready') return Promise.resolve();
      if (this.diskPromise) return this.diskPromise;
      if (this.stopped || !this.remote) return Promise.reject(new Error('lazyRomUnavailable'));
      this.diskRequested = true;
      this.stats.state = 'preparing-disk'; this.stats.disk = { state: 'downloading', completed: 0, total: this.file.size, cleanup: 'not-started' };
      this.changed(this.stats);
      this.diskPromise = new Promise((resolve, reject) => {
        this.pendingDisk = { resolve, reject }; this.resetDiskTimeout();
        try { this.worker.postMessage({ type: 'prepare-disk' }); }
        catch (error) { clearTimeout(this.diskTimeout); this.pendingDisk = null; reject(error); }
      });
      return this.diskPromise;
    }
    async readAsync(position, length) {
      if (!Number.isSafeInteger(position) || position < 0 || !Number.isSafeInteger(length) || length < 1 || length > 32 * BLOCK || position + length > this.file.size) throw new Error('lazyRomReadError');
      const output = new Uint8Array(length);
      for (let done = 0; done < length;) {
        if (this.stopped || performance.now() > this.verificationDeadline) throw new Error('lazyRomReadError');
        const at = position + done, block = Math.floor(at / this.block), start = block * this.block;
        let bytes = this.cache.get(block);
        if (!bytes) {
          const end = Math.min(start + this.block, this.file.size);
          bytes = await new Promise((resolve, reject) => {
            if (this.pendingPrefetch) return reject(new Error('lazyRomReadError'));
            const id = this.prefetchId = (this.prefetchId || 0) + 1;
            const timer = setTimeout(() => { this.recordIoFailure('worker-prefetch-timeout', 'verification', start, end - start); this.pendingPrefetch = null; reject(new Error('lazyRomReadError')); }, 6000);
            this.pendingPrefetch = { id, start, length: end - start, timer, resolve, reject };
            try { this.worker.postMessage({ type: 'prefetch', requestId: id, start, end }); }
            catch (error) { clearTimeout(timer); this.pendingPrefetch = null; reject(error); }
          });
          if (this.stopped) throw new Error('lazyRomReadError');
          if (this.cache.size >= BLOCK * LIMIT / this.block) this.cache.delete(this.cache.keys().next().value);
          this.stats.bytesRead += bytes.length; this.stats.largestRead = Math.max(this.stats.largestRead, bytes.length);
        } else this.cache.delete(block);
        this.cache.set(block, bytes);
        const offset = at - start, count = Math.min(length - done, bytes.length - offset);
        output.set(bytes.subarray(offset, offset + count), done); done += count;
        this.stats.cacheBytes = Array.from(this.cache.values()).reduce((sum, chunk) => sum + chunk.length, 0);
      }
      return output;
    }
    read(position, length) {
      if (this.stopped) throw new Error('lazyRomReadError');
      if (!Number.isSafeInteger(position) || position < 0 || !Number.isSafeInteger(length) || length < 0 || length > BLOCK) throw new Error('lazyRomReadError');
      const count = Math.max(0, Math.min(length, this.file.size - position));
      const output = new Uint8Array(count);
      for (let done = 0; done < count;) {
        const at = position + done; const block = Math.floor(at / this.block); const start = block * this.block;
        let bytes = this.cache.get(block);
        if (!bytes) {
          const end = Math.min(start + this.block, this.file.size);
          this.stats.pendingRead = { offset: start, length: end - start };
          this.changed(this.stats);
          Atomics.store(this.state, 1, 0);
          Atomics.store(this.state, 0, 1);
          this.worker.postMessage({ type: 'read', start, end });
          // The core requires synchronous reads. Only the worker performs I/O;
          // the bounded shared-memory wait never allocates the full ROM.
          const waitStarted = performance.now(), deadline = waitStarted + 5000;
          while (Atomics.load(this.state, 0) === 1) {
            if (performance.now() >= deadline) { this.recordIoFailure('main-wait-timeout', 'playback', start, end - start, performance.now() - waitStarted); this.worker.terminate(); throw new Error('lazyRomReadError'); }
          }
          if (Atomics.load(this.state, 0) !== 2) { this.recordIoFailure(Atomics.load(this.state, 1), 'playback', start, end - start, performance.now() - waitStarted); throw new Error('lazyRomReadError'); }
          const received = Atomics.load(this.state, 1);
          if (received !== end - start) { this.recordIoFailure('worker-length-mismatch', 'playback', start, end - start, performance.now() - waitStarted); throw new Error('lazyRomReadError'); }
          bytes = this.bytes.slice(0, received);
          delete this.stats.pendingRead;
          this.stats.bytesRead += bytes.length; this.stats.largestRead = Math.max(this.stats.largestRead, bytes.length);
          if (this.cache.size >= BLOCK * LIMIT / this.block) this.cache.delete(this.cache.keys().next().value);
        } else this.cache.delete(block);
        this.cache.set(block, bytes);
        const offset = at - start; const take = Math.min(count - done, bytes.length - offset);
        output.set(bytes.subarray(offset, offset + take), done); done += take;
      }
      const header = this.stats.header;
      if (this.virtualFlagsByte !== undefined && position <= header.flagsOffset && position + count > header.flagsOffset) output[header.flagsOffset - position] = this.virtualFlagsByte;
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
            const header = reader.stats.header;
            if (header?.state === 'observed' && position <= header.flagsOffset && position + total > header.flagsOffset) {
              const flag = buffer[offset + header.flagsOffset - position];
              header.deliveredFlagsByte = flag;
              header.deliveredNoCryptoFlag = !!(flag & 4);
              header.deliveredMatchesProbe = flag === header.flagsByte;
              header.deliveryMismatchObserved = header.deliveryMismatchObserved === true || flag !== header.flagsByte;
              if (header.compatibility?.state === 'applied') header.deliveredMatchesVirtual = flag === header.compatibility.virtualFlagsByte;
              const expected = header.compatibility?.state === 'applied' ? header.compatibility.virtualFlagsByte : header.flagsByte;
              header.unexpectedDeliveryMismatchObserved = header.unexpectedDeliveryMismatchObserved === true || flag !== expected;
              header.deliveryChecks = Math.min(1000000, (header.deliveryChecks || 0) + 1);
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
    stop() {
      if (this.disposePromise) return this.disposePromise;
      this.stopped = true; clearTimeout(this.initTimeout); clearTimeout(this.diskTimeout);
      this.rejectReady(new Error('lazyRomReadError'));
      if (this.pendingPrefetch) { clearTimeout(this.pendingPrefetch.timer); this.pendingPrefetch.reject(new Error('lazyRomReadError')); this.pendingPrefetch = null; }
      if (this.pendingDisk) { this.pendingDisk.reject(new Error('ROM preparation was cancelled.')); this.pendingDisk = null; }
      this.cache.clear(); this.stats.cacheBytes = 0;
      if (!this.diskRequested) { this.worker.terminate(); return this.disposePromise = Promise.resolve(); }
      this.stats.disk.cleanup = 'removing';
      this.disposePromise = new Promise(resolve => {
        const timer = setTimeout(() => { this.stats.disk.cleanup = 'pending'; this.finishDispose(); }, 1800);
        this.finishDispose = () => { clearTimeout(timer); this.worker.terminate(); resolve(); };
        try { this.worker.postMessage({ type: 'dispose' }); } catch { this.stats.disk.cleanup = 'pending'; this.finishDispose(); }
      });
      return this.disposePromise;
    }
  }
  function install(emulator, source, changed) {
    const file = typeof source === 'string' ? { url: source, name: decodeURIComponent(new URL(source, window.location.href).pathname.split('/').pop()), size: 0 } : source;
    if (!/\.(3ds|cci|cxi|app|elf|axf)$/i.test(file.name || '') || emulator.ejs_version !== '4.3.0-pre' || emulator.getCore() !== 'azahar' || typeof emulator.download !== 'function') throw new Error('lazyRomUnavailable');
    const reader = new LazyRom(file, changed, { persistent: typeof source === 'string' && emulator.isSafari === true }); const original = emulator.download;
    const wrapped = async function(url, type) {
      // This adapter owns this exact ROM source. The pinned frontend labels its
      // download type "ROM"; routing must not depend on that display label.
      if (url !== source) return Reflect.apply(original, this, arguments);
      try {
        reader.stats.state = 'mounting'; reader.changed(reader.stats);
        await reader.ready;
        if (reader.remote && emulator.isSafari === true) await reader.prepareDisk();
        const path = reader.mount(this.gameManager.FS);
        this.config.gameUrl = path;
        return Promise.resolve({ files: [{ filename: path.slice(1) }] });
      } catch (error) { if (!reader.stopped) { reader.stats.state = 'failed'; reader.changed(reader.stats); } return Promise.reject(error); }
    };
    emulator.download = wrapped;
    return { stats: reader.stats, stop() { const result = reader.stop(); if (emulator.download === wrapped) emulator.download = original; return result; } };
  }
  window.RetroLazyRom = { LazyRom, install, inspectHeader, inspectExheaderHash, verifyPlaintextRegions };
})();
