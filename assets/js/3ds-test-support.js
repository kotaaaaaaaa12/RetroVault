"use strict";

(() => {
  const baseline = Object.freeze({
    citra_resolution_factor: '1',
    citra_texture_filter: 'none',
    citra_custom_textures: 'disabled',
    citra_dump_textures: 'disabled',
    citra_use_hw_shader_cache: 'enabled',
    citra_use_hw_shaders: 'enabled',
    citra_is_new_3ds: 'Old 3DS',
    citra_touch_touchscreen: 'enabled'
  });
  const profiles = Object.freeze({
    baseline,
    'shader-cache-off': Object.freeze({ ...baseline, citra_use_hw_shader_cache: 'disabled' }),
    'hardware-shaders-off': Object.freeze({ ...baseline, citra_use_hw_shaders: 'disabled' }),
    'saved-data-readonly': Object.freeze({ ...baseline, citra_use_hw_shader_cache: 'disabled' }),
    'worker-pool-4': Object.freeze({ ...baseline, citra_use_hw_shader_cache: 'disabled' })
  });

  class ThreeDSDiagnostics {
    static profiles = profiles;
    static storageKey = 'retro-vault-3ds-player-diagnostics';
    static configuration(location) {
      if (location.pathname !== '/admin/3ds-player.html') return null;
      const params = new URLSearchParams(location.search);
      const profile = params.get('profile');
      const runId = params.get('run');
      if (!Object.hasOwn(profiles, profile) || !/^[a-f0-9-]{36}$/.test(runId || '')) throw new Error('Invalid 3DS test condition.');
      return { profile, runId, options: { ...profiles[profile] }, savedData: ['saved-data-readonly', 'worker-pool-4'].includes(profile), workerPool: profile === 'worker-pool-4' ? 4 : 32 };
    }
    static parseOptions(value) {
      const result = {};
      if (typeof value !== 'string' || value.length > 131072) return result;
      for (const line of value.split('\n').slice(0, 128)) {
        const header = line.split('; ')[0];
        const [key, current] = header.split('|');
        // The pinned frontend reads the current value from key|value, before
        // the semicolon. The following list contains available values only.
        if (/^citra_[a-z0-9_]{1,64}$/.test(key) && typeof current === 'string' && current.length <= 100) result[key] = current;
      }
      return result;
    }
    constructor(config) {
      this.config = config;
      this.state = { profile: config.profile, runId: config.runId, requestedOptions: config.options,
        actualOptions: {}, optionSource: 'unavailable', stages: [], samples: [], heapChanges: [], settingsChanges: [],
        saveStorage: 'not-mounted', settingsStorage: 'disabled', changedFromBaseline: Object.keys(baseline).filter(key => config.options[key] !== baseline[key]) };
      if (config.savedData) this.state.savedSnapshot = { state: 'pending', files: 0, directories: 0, bytes: 0, largestFile: 0 };
      this.state.workers = { requestedInitialPool: config.workerPool, patch: 'pending', probe: 'pending', created: 0,
        terminationRequests: 0, terminationFailures: 0, peakHandles: 0, trackedHandles: 0, errors: 0, events: [], cleanup: 'not-requested' };
      this.workerHandles = new Map();
      this.workerRestorers = [];
      this.lastSent = 0;
      this.lastOptions = 0;
      this.lastSample = 0;
      this.lastPhase = '';
      this.lastRomState = '';
    }
    attach(emulator) {
      if (!emulator || this.emulator) return;
      this.emulator = emulator;
      this.installWorkerProbe(emulator);
      const original = emulator.initializeGameManager;
      if (typeof original !== 'function') throw new Error('The test requires the pinned EmulatorJS game manager.');
      const monitor = this;
      emulator.initializeGameManager = async function(...args) {
        const fs = this.Module?.FS;
        if (!fs?.filesystems?.MEMFS || !fs.filesystems.IDBFS || typeof fs.mount !== 'function') throw new Error('Test save isolation is unavailable.');
        const mount = fs.mount;
        fs.mount = function(type, options, path, ...rest) {
          if (path === '/data/saves' && type === fs.filesystems.IDBFS) {
            // Native 3DS NAND files use a shared IDBFS mount, regardless of
            // game name. Tests use fresh, volatile MEMFS at that same path.
            monitor.state.saveStorage = 'volatile-memory';
            return Reflect.apply(mount, this, [fs.filesystems.MEMFS, {}, path, ...rest]);
          }
          return Reflect.apply(mount, this, [type, options, path, ...rest]);
        };
        try {
          const result = await Reflect.apply(original, this, args);
          if (monitor.state.saveStorage !== 'volatile-memory') throw new Error('Test save isolation was not applied.');
          if (monitor.config.savedData) {
            await monitor.loadSavedSnapshot(fs, fs.filesystems.IDBFS);
            monitor.state.saveStorage = 'readonly-snapshot-in-memory';
          }
          return result;
        } finally { fs.mount = mount; }
      };
    }
    workerEvent(type, workerId) {
      const stats = this.state.workers;
      stats.events.push({ elapsedMs: Math.max(0, Date.now() - (this.startedAtMs || Date.now())), type, ...(workerId ? { workerId } : {}) });
      stats.events = stats.events.slice(-24);
    }
    patchRuntime(source) {
      const stats = this.state.workers;
      const marker = 'initMainThread(){var pthreadPoolSize=32;';
      const loop = 'while(pthreadPoolSize--){PThread.allocateUnusedWorker()}addOnPreRun(';
      let text;
      try {
        if (this.stopped) throw new Error('The test was cancelled.');
        text = typeof source === 'string' ? source : new TextDecoder('utf-8', { fatal: true }).decode(source);
        if (text.length > 3000000 || text.split(marker).length !== 2 || text.split(loop).length !== 2 || ![4, 32].includes(this.config.workerPool)) throw new Error('The pinned Worker pool layout is unavailable.');
      } catch (error) {
        stats.patch = 'failed';
        throw Object.assign(error, { i18nKey: 'threeDsWorkerUnavailable' });
      }
      // Patch the in-memory script only. Never modify the cached core, WASM,
      // shared memory size, native options, or the pthread worker script.
      const patched = text.replace(marker, 'initMainThread(){Module["retroVault3dsTestRegisterThreads"](PThread);var pthreadPoolSize=' + this.config.workerPool + ';')
        .replace(loop, 'while(pthreadPoolSize--){PThread.allocateUnusedWorker()}Module["retroVault3dsTestPoolReady"]();addOnPreRun(');
      stats.originalInitialPool = 32;
      stats.patch = 'applied';
      return patched;
    }
    installWorkerProbe(emulator) {
      if (typeof emulator.initGameCore !== 'function' || typeof emulator.initModule !== 'function') throw new Error('The pinned Worker test hooks are unavailable.');
      const monitor = this;
      const initGameCore = emulator.initGameCore;
      const patchedInit = function(source, ...rest) {
        return Reflect.apply(initGameCore, this, [monitor.patchRuntime(source), ...rest]);
      };
      emulator.initGameCore = patchedInit;
      this.workerRestorers.push(() => { if (emulator.initGameCore === patchedInit) emulator.initGameCore = initGameCore; });
      const initModule = emulator.initModule;
      const configuredInit = function(...args) {
        const factory = window.EJS_Runtime;
        if (monitor.stopped || monitor.state.workers.patch !== 'applied' || typeof factory !== 'function') throw new Error('The Worker comparison was not prepared.');
        const wrapped = function(options = {}, ...rest) {
          return Reflect.apply(factory, this, [{ ...options, retroVault3dsTestRegisterThreads: threads => monitor.registerThreads(threads),
            retroVault3dsTestPoolReady: () => {
              monitor.sampleWorkers();
              monitor.state.workers.initialHandles = monitor.state.workers.idleHandles + monitor.state.workers.runningHandles;
              monitor.workerEvent('initial-pool-ready');
              monitor.onChange?.();
            } }, ...rest]);
        };
        window.EJS_Runtime = wrapped;
        try { return Reflect.apply(initModule, this, args); }
        finally { if (window.EJS_Runtime === wrapped) window.EJS_Runtime = factory; }
      };
      emulator.initModule = configuredInit;
      this.workerRestorers.push(() => { if (emulator.initModule === configuredInit) emulator.initModule = initModule; });
    }
    registerThreads(threads) {
      if (this.stopped || this.threads || !Array.isArray(threads?.unusedWorkers) || !Array.isArray(threads.runningWorkers)
        || typeof threads.allocateUnusedWorker !== 'function' || typeof threads.terminateAllThreads !== 'function') throw new Error('The pinned native Worker probe is unavailable.');
      this.threads = threads;
      const allocate = threads.allocateUnusedWorker;
      const monitor = this;
      threads.allocateUnusedWorker = function(...args) {
        if (monitor.stopped) throw new Error('Worker allocation was cancelled.');
        const result = Reflect.apply(allocate, this, args);
        const worker = this.unusedWorkers.at(-1);
        if (!worker || monitor.workerHandles.has(worker)) throw new Error('The native Worker handle could not be observed.');
        monitor.trackWorker(worker);
        return result;
      };
      this.state.workers.probe = 'native-pthread-pool';
      this.workerEvent('probe-attached');
    }
    trackWorker(worker) {
      const stats = this.state.workers;
      const id = ++stats.created;
      const terminate = worker.terminate;
      if (typeof terminate !== 'function' || typeof worker.addEventListener !== 'function') throw new Error('The native Worker handle is unsupported.');
      const error = () => { stats.errors++; this.workerEvent('worker-error', id); this.onChange?.(); };
      worker.addEventListener('error', error);
      worker.addEventListener('messageerror', error);
      const detach = () => {
        worker.removeEventListener('error', error);
        worker.removeEventListener('messageerror', error);
        this.workerHandles.delete(worker);
        stats.trackedHandles = this.workerHandles.size;
      };
      const monitor = this;
      worker.terminate = function(...args) {
        stats.terminationRequests++;
        monitor.workerEvent('terminate-requested', id);
        try {
          const result = Reflect.apply(terminate, this, args);
          detach();
          if (worker.terminate === wrapped) worker.terminate = terminate;
          return result;
        } catch (failure) { stats.terminationFailures++; throw failure; }
      };
      const wrapped = worker.terminate;
      this.workerHandles.set(worker, { detach, terminate: () => Reflect.apply(wrapped, worker, []) });
      stats.trackedHandles = this.workerHandles.size;
      stats.peakHandles = Math.max(stats.peakHandles, stats.trackedHandles);
      this.workerEvent('worker-created', id);
    }
    sampleWorkers() {
      const stats = this.state.workers;
      if (!this.threads) return;
      stats.idleHandles = this.threads.unusedWorkers.length;
      stats.runningHandles = this.threads.runningWorkers.length;
      stats.registeredThreads = Object.keys(this.threads.pthreads || {}).length;
    }
    finishWorkers() {
      const stats = this.state.workers;
      if (stats.cleanup !== 'not-requested') return;
      this.sampleWorkers();
      stats.beforeCleanup = { idle: stats.idleHandles ?? null, running: stats.runningHandles ?? null, tracked: stats.trackedHandles };
      stats.cleanup = 'requested';
      try { this.threads?.terminateAllThreads(); } catch { stats.terminationFailures++; }
      // A partially initialized pool can be missing from the native arrays.
      for (const record of [...this.workerHandles.values()]) {
        try { record.terminate(); } catch { record.detach(); }
      }
      this.sampleWorkers();
      stats.cleanup = stats.terminationFailures ? 'request-failed' : stats.created ? 'termination-requested' : 'no-workers';
      this.workerEvent('cleanup-requested');
      for (const restore of this.workerRestorers.reverse()) restore();
      this.workerRestorers = [];
      // Worker.terminate has no completion notification or resident-RAM probe.
      // Zero handles is not proof that Safari has reclaimed the memory.
    }
    loadSavedSnapshot(fs, idbfs) {
      const stats = this.state.savedSnapshot;
      stats.state = 'reading';
      return new Promise((resolve, reject) => {
        let db, transaction, failure, settled = false, cursorFinished = false, count = 0;
        const finish = error => {
          if (settled) return;
          settled = true;
          this.cancelSnapshot = null;
          try { db?.close(); } catch {}
          stats.state = error ? (this.stopped ? 'cancelled' : 'failed') : 'ready';
          if (error) reject(Object.assign(error, { i18nKey: 'threeDsSavedDataUnavailable' })); else resolve();
        };
        const abort = error => {
          failure = error;
          try { transaction?.abort(); } catch {}
          finish(error);
        };
        this.cancelSnapshot = () => abort(new Error('Saved-data preparation was cancelled.'));
        if (!window.indexedDB || typeof idbfs?.storeLocalEntry !== 'function') { finish(new Error('Read-only saved-data access is unavailable.')); return; }
        let open;
        // No version argument: never upgrade an existing native save database.
        try { open = window.indexedDB.open('/data/saves'); }
        catch (error) { finish(error); return; }
        open.onupgradeneeded = () => {
          // Opening a missing database would create it. Abort creation instead.
          try { open.transaction.abort(); } catch {}
          try { open.result?.close(); } catch {}
          finish(new Error('There is no existing native save database.'));
        };
        open.onerror = () => finish(open.error || new Error('The existing save database could not be opened.'));
        open.onblocked = () => finish(new Error('The existing save database is busy.'));
        open.onsuccess = () => {
          db = open.result;
          if (settled || this.stopped) { try { db.close(); } catch {} if (!settled) finish(new Error('Saved-data preparation was cancelled.')); return; }
          try {
            // Read one record at a time. No readwrite transaction, getAll,
            // put, delete, database deletion, or persistent IDBFS mount.
            transaction = db.transaction(['FILE_DATA'], 'readonly');
            transaction.onabort = () => finish(failure || transaction.error || new Error('Saved-data reading was aborted.'));
            transaction.onerror = () => { failure ||= transaction.error || new Error('Saved-data reading failed.'); };
            transaction.oncomplete = () => finish(cursorFinished ? null : failure || new Error('Saved-data reading did not finish.'));
            const request = transaction.objectStore('FILE_DATA').openCursor();
            request.onerror = () => abort(request.error || new Error('Saved-data reading failed.'));
            request.onsuccess = () => {
              const cursor = request.result;
              if (!cursor) { cursorFinished = true; return; }
              if (this.stopped) { abort(new Error('Saved-data preparation was cancelled.')); return; }
              const path = cursor.primaryKey;
              const entry = cursor.value;
              if (++count > 4096 || typeof path !== 'string' || !path.startsWith('/data/saves/')
                || path.includes('\0') || path.split('/').some(part => part === '..' || part === '.')
                || !entry || !Number.isInteger(entry.mode)) { abort(new Error('The native save snapshot is unsupported.')); return; }
              const file = fs.isFile(entry.mode), directory = fs.isDir(entry.mode);
              if (!file && !directory) { abort(new Error('The native save snapshot contains an unsupported entry.')); return; }
              const bytes = file ? entry.contents?.byteLength : 0;
              if (!Number.isSafeInteger(bytes) || bytes < 0) { abort(new Error('The native save snapshot contains an invalid file.')); return; }
              try {
                // The pinned helper writes into this test's MEMFS only. Cursor
                // values are IndexedDB structured clones, not live save objects.
                idbfs.storeLocalEntry(path, entry, error => {
                  if (settled) return;
                  if (error) { abort(error); return; }
                  stats.files += file ? 1 : 0;
                  stats.directories += directory ? 1 : 0;
                  stats.bytes += bytes;
                  stats.largestFile = Math.max(stats.largestFile, bytes);
                  cursor.continue();
                });
              } catch (error) { abort(error); }
            };
          } catch (error) { abort(error); }
        };
      });
    }
    stop() {
      this.stopped = true;
      this.cancelSnapshot?.();
    }
    observe(diagnostics, emulator, phase) {
      const now = Date.now();
      this.startedAtMs = diagnostics.startedAtMs;
      this.sampleWorkers();
      const elapsedMs = Math.max(0, now - diagnostics.startedAtMs);
      if (Number.isFinite(diagnostics.wasmHeapBytes) && diagnostics.wasmHeapBytes !== this.lastHeapBytes) {
        this.state.heapChanges.push({ elapsedMs, before: this.lastHeapBytes ?? null, bytes: diagnostics.wasmHeapBytes,
          workerHandles: this.state.workers.trackedHandles });
        this.state.heapChanges = this.state.heapChanges.length > 16
          ? [...this.state.heapChanges.slice(0, 8), ...this.state.heapChanges.slice(-8)] : this.state.heapChanges;
        this.lastHeapBytes = diagnostics.wasmHeapBytes;
      }
      const romState = diagnostics.romIO?.disk?.state || diagnostics.romIO?.state || '';
      const phaseChanged = diagnostics.phase !== this.lastPhase || romState !== this.lastRomState;
      if (phaseChanged) {
        this.state.stages.push({ elapsedMs, phase: diagnostics.phase, romState, bytes: diagnostics.wasmHeapBytes });
        this.state.stages = this.state.stages.slice(-48);
        this.lastPhase = diagnostics.phase;
        this.lastRomState = romState;
      }
      if (now - this.lastSample >= 2000 || phaseChanged || diagnostics.wasmHeapBytes !== this.lastBytes) {
        this.state.samples.push({ elapsedMs, phase: diagnostics.phase, bytes: diagnostics.wasmHeapBytes,
          ...(this.threads ? { workerHandles: this.state.workers.trackedHandles, runningWorkers: this.state.workers.runningHandles } : {}) });
        this.state.samples = this.state.samples.slice(-64);
        this.lastSample = now;
        this.lastBytes = diagnostics.wasmHeapBytes;
      }
      // get_core_options in this pinned native frontend dereferences its core
      // option manager. Never call it while native initialization is in progress.
      if (emulator?.Module && diagnostics.coreStartup?.mainReturned === true && diagnostics.coreStartup?.frontendStarted === true && (now - this.lastOptions >= 2000 || phase === 'running')) {
        this.lastOptions = now;
        try {
          const options = ThreeDSDiagnostics.parseOptions(emulator.gameManager?.getCoreOptions?.());
          if (Object.keys(options).length) {
            const previous = this.state.actualOptions;
            for (const [key, value] of Object.entries(options)) if (Object.hasOwn(previous, key) && previous[key] !== value) {
              this.state.settingsChanges.push({ elapsedMs, key, before: previous[key], after: value });
            }
            this.state.settingsChanges = this.state.settingsChanges.slice(-16);
            this.state.actualOptions = options;
            this.state.optionSource = 'native-get_core_options';
            this.state.optionReadAtMs = elapsedMs;
          }
        } catch { this.state.optionReadFailed = true; }
      }
      diagnostics.test3ds = this.state;
      if (window.parent !== window && (now - this.lastSent >= 1000 || phaseChanged || phase === 'closed' || phase === 'error')) {
        this.lastSent = now;
        window.parent.postMessage({ type: 'retro-vault-3ds-diagnostics', runId: this.config.runId, diagnostics }, window.location.origin);
      }
    }
  }
  window.Retro3DSDiagnostics = ThreeDSDiagnostics;
})();
