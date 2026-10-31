import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../assets/js/3ds-test-support.js', import.meta.url), 'utf8');
function setup() {
  let now = 100000;
  const messages = [];
  const window = { location: { origin: 'https://retro.example' }, parent: { postMessage: value => messages.push(structuredClone(value)) } };
  const context = vm.createContext({ window, URLSearchParams, TextDecoder, Date: class extends Date { static now() { return now; } } });
  vm.runInContext(source, context);
  const API = window.Retro3DSDiagnostics;
  const runId = '12345678-1234-1234-1234-123456789012';
  const config = profile => API.configuration({ pathname: '/admin/3ds-player.html', search: '?profile=' + profile + '&run=' + runId });
  return { API, config, messages, window, advance: ms => { now += ms; } };
}

function runtimeHooks(extra) { return { initGameCore() {}, initModule() {}, ...extra }; }

test('3DS test conditions are private-path scoped and alternate exactly one baseline value', () => {
  const { API, config } = setup();
  assert.equal(API.configuration({ pathname: '/pages/player.html', search: '?profile=hardware-shaders-off' }), null);
  assert.throws(() => API.configuration({ pathname: '/admin/3ds-player.html', search: '?profile=constructor&run=x' }));
  const base = config('baseline').options;
  assert.equal(base.citra_resolution_factor, '1');
  assert.equal(base.citra_touch_touchscreen, 'enabled');
  for (const [profile, key] of [['shader-cache-off', 'citra_use_hw_shader_cache'], ['hardware-shaders-off', 'citra_use_hw_shaders']]) {
    const alternate = config(profile).options;
    assert.deepEqual(Object.keys(base).filter(key => base[key] !== alternate[key]), [key]);
  }
  assert.deepEqual(JSON.parse(JSON.stringify(config('saved-data-readonly').options)), JSON.parse(JSON.stringify(config('shader-cache-off').options)));
  assert.equal(config('saved-data-readonly').savedData, true);
  assert.deepEqual(config('worker-pool-4').options, config('saved-data-readonly').options);
  assert.equal(config('worker-pool-4').savedData, true);
  assert.equal(config('worker-pool-4').workerPool, 4);
  assert.equal(config('saved-data-readonly').workerPool, 32);
});

// Reduced form of the pinned pool initializer. The full downloaded core is
// checked separately during release verification and is not shipped in the ZIP.
const poolScript = '({initMainThread(){var pthreadPoolSize=32;while(pthreadPoolSize--){PThread.allocateUnusedWorker()}addOnPreRun(()=>PThread.loadWasmModuleToAllWorkers())}})';
function workerPool() {
  const workers = [];
  const pool = { unusedWorkers: [], runningWorkers: [], pthreads: {}, allocateUnusedWorker() {
    const listeners = new Map();
    const worker = { terminated: 0, addEventListener(type, handler) { listeners.set(type, handler); }, removeEventListener(type) { listeners.delete(type); },
      terminate() { assert.equal(this, worker); this.terminated++; }, emit(type) { listeners.get(type)?.(); } };
    workers.push(worker); this.unusedWorkers.push(worker);
  }, terminateAllThreads() {
    for (const worker of [...this.runningWorkers, ...this.unusedWorkers]) worker.terminate();
    this.runningWorkers = []; this.unusedWorkers = []; this.pthreads = {};
  }, loadWasmModuleToAllWorkers() {} };
  return { pool, workers };
}

test('both pool comparisons patch only the in-memory initializer, count real handles and preserve dynamic allocation', () => {
  for (const [profile, count] of [['saved-data-readonly', 32], ['worker-pool-4', 4]]) {
    const { API, config, window } = setup();
    const monitor = new API(config(profile));
    const { pool, workers } = workerPool();
    const input = new TextEncoder().encode(poolScript);
    const originalBytes = new Uint8Array(input);
    let patched, received, receiver;
    const emulator = runtimeHooks({ initializeGameManager() {}, initGameCore(script, wasm) { patched = script; assert.equal(wasm, 'unchanged-wasm'); },
      initModule() { return window.EJS_Runtime({ canvas: 'original', preRun: [] }); } });
    const factory = function(options) {
      received = options;
      const context = vm.createContext({ Module: options, PThread: pool, addOnPreRun() {} });
      vm.runInContext(patched, context).initMainThread();
      return 'native-result';
    };
    window.EJS_Runtime = factory;
    monitor.attach(emulator);
    emulator.initGameCore(input, 'unchanged-wasm');
    assert.deepEqual(input, originalBytes, 'cached bytes must stay unchanged');
    assert.equal(emulator.initModule(), 'native-result');
    assert.equal(window.EJS_Runtime, factory);
    assert.equal(received.canvas, 'original');
    assert.equal(monitor.state.workers.initialHandles, count);
    assert.equal(monitor.state.workers.created, count);
    const active = pool.unusedWorkers.pop(); pool.runningWorkers.push(active); pool.pthreads['123'] = active;
    pool.allocateUnusedWorker(); // Initial pool size is not a hard thread limit.
    monitor.sampleWorkers();
    assert.equal(monitor.state.workers.created, count + 1);
    assert.equal(monitor.state.workers.runningHandles, 1);
    assert.equal(monitor.state.workers.registeredThreads, 1);
    active.emit('error');
    assert.equal(monitor.state.workers.errors, 1);
    monitor.stop(); monitor.finishWorkers(); monitor.finishWorkers();
    assert.equal(monitor.state.workers.terminationRequests, count + 1);
    assert.equal(monitor.state.workers.trackedHandles, 0);
    assert.equal(monitor.state.workers.idleHandles, 0);
    assert.equal(monitor.state.workers.runningHandles, 0);
    assert.equal(monitor.state.workers.cleanup, 'termination-requested');
    assert.equal(workers.every(worker => worker.terminated === 1), true);
    assert.throws(() => pool.allocateUnusedWorker(), /cancelled/);
  }
});

test('changed pool layouts fail before execution, failed factories restore wrappers, and cancelled tests create no Workers', () => {
  for (const text of ['unexpected', poolScript.replace('=32;', '=8;'), poolScript + poolScript]) {
    const { API, config } = setup();
    const monitor = new API(config('worker-pool-4'));
    assert.throws(() => monitor.patchRuntime(text), error => error.i18nKey === 'threeDsWorkerUnavailable');
    assert.equal(monitor.state.workers.patch, 'failed');
  }
  const { API, config, window } = setup();
  const monitor = new API(config('worker-pool-4'));
  const emulator = runtimeHooks({ initializeGameManager() {}, initModule() { return window.EJS_Runtime(); } });
  const factory = () => { throw new Error('native failure'); }; window.EJS_Runtime = factory;
  monitor.attach(emulator); monitor.patchRuntime(poolScript);
  assert.throws(() => emulator.initModule(), /native failure/);
  assert.equal(window.EJS_Runtime, factory);
  monitor.stop();
  const { pool, workers } = workerPool();
  assert.throws(() => monitor.registerThreads(pool), /unavailable/);
  assert.equal(workers.length, 0);
  monitor.finishWorkers();
  assert.equal(monitor.state.workers.cleanup, 'no-workers');
});

test('pool cleanup records failures and bounded events without claiming physical memory was released', () => {
  const { API, config } = setup();
  const monitor = new API(config('worker-pool-4'));
  const { pool } = workerPool(); monitor.registerThreads(pool);
  for (let i = 0; i < 50; i++) pool.allocateUnusedWorker();
  pool.unusedWorkers[0].terminate = () => { throw new Error('termination failed'); };
  monitor.stop(); monitor.finishWorkers();
  assert.equal(monitor.state.workers.cleanup, 'request-failed');
  assert.equal(monitor.state.workers.events.length, 24);
  assert.equal(monitor.state.workers.physicalMemoryReleased, undefined);
});

function snapshotDatabase(records, { missing = false } = {}) {
  const state = { transactions: [], closes: 0, abortedCreation: false };
  return { state, open(name, version) {
    assert.equal(name, '/data/saves'); assert.equal(version, undefined);
    const request = {};
    setImmediate(() => {
      if (missing) {
        request.transaction = { abort() { state.abortedCreation = true; } };
        request.onupgradeneeded(); return;
      }
      request.result = { close() { state.closes++; }, transaction(stores, mode) {
        state.transactions.push(mode); assert.equal(mode, 'readonly'); assert.deepEqual(Array.from(stores), ['FILE_DATA']);
        let index = 0, aborted = false;
        const tx = { abort() { aborted = true; setImmediate(() => tx.onabort?.()); }, objectStore(name) {
          assert.equal(name, 'FILE_DATA'); return { openCursor() {
            const cursorRequest = {};
            const next = () => setImmediate(() => {
              if (aborted) return;
              const record = records[index++];
              cursorRequest.result = record ? { primaryKey: record[0], value: structuredClone(record[1]), continue: next } : null;
              cursorRequest.onsuccess();
              if (!record) setImmediate(() => { if (!aborted) tx.oncomplete?.(); });
            }); next(); return cursorRequest;
          } };
        } }; return tx;
      } };
      request.onsuccess();
    }); return request;
  } };
}

test('saved-data comparison populates MEMFS through readonly cursors without changing existing records', async () => {
  const { API, config, window } = setup();
  const monitor = new API(config('saved-data-readonly'));
  const records = [['/data/saves/Azahar', { mode: 16877 }], ['/data/saves/Azahar/game.sav', { mode: 33188, contents: new Uint8Array([1, 2, 3]) }]];
  const database = snapshotDatabase(records); window.indexedDB = database;
  const local = new Map();
  const fs = { isFile: mode => mode === 33188, isDir: mode => mode === 16877 };
  await monitor.loadSavedSnapshot(fs, { storeLocalEntry(path, entry, callback) { local.set(path, entry); callback(null); } });
  assert.deepEqual(database.state.transactions, ['readonly']);
  assert.equal(database.state.closes, 1);
  assert.equal(monitor.state.savedSnapshot.state, 'ready');
  assert.equal(monitor.state.savedSnapshot.files, 1);
  assert.equal(monitor.state.savedSnapshot.directories, 1);
  assert.equal(monitor.state.savedSnapshot.bytes, 3);
  local.get('/data/saves/Azahar/game.sav').contents[0] = 99;
  assert.equal(records[1][1].contents[0], 1);
  assert.doesNotMatch(JSON.stringify(monitor.state.savedSnapshot), /game\.sav|Azahar/);
});

test('saved-data condition finishes readonly population before native initialization resolves and keeps the save mount volatile', async () => {
  const { API, config, window } = setup();
  const monitor = new API(config('saved-data-readonly'));
  const database = snapshotDatabase([['/data/saves/game.sav', { mode: 33188, contents: new Uint8Array([7]) }]]);
  window.indexedDB = database;
  const mounted = [], loaded = [];
  const IDBFS = { storeLocalEntry(path, entry, callback) { loaded.push(path); callback(null); } }, MEMFS = {};
  const FS = { filesystems: { IDBFS, MEMFS }, mount(type, options, path) { mounted.push({ type, options, path }); }, isFile: () => true, isDir: () => false };
  const emulator = { Module: { FS }, async initializeGameManager() { FS.mount(IDBFS, { autoPersist: true }, '/data/saves'); assert.equal(loaded.length, 0); return 'ready'; } };
  monitor.attach(Object.assign(emulator, runtimeHooks(emulator)));
  assert.equal(await emulator.initializeGameManager(), 'ready');
  assert.equal(loaded.length, 1);
  assert.equal(mounted[0].type, MEMFS);
  assert.equal(mounted[0].options.autoPersist, undefined);
  assert.equal(monitor.state.saveStorage, 'readonly-snapshot-in-memory');
  assert.equal(monitor.state.savedSnapshot.state, 'ready');
  assert.deepEqual(database.state.transactions, ['readonly']);
});

test('missing, invalid and cancelled saved-data snapshots fail closed without creating or writing a database', async () => {
  for (const mode of ['missing', 'invalid', 'cancelled']) {
    const { API, config, window } = setup();
    const monitor = new API(config('saved-data-readonly'));
    const records = [[mode === 'invalid' ? '/outside/game.sav' : '/data/saves/game.sav', { mode: 33188, contents: new Uint8Array([1]) }]];
    const database = snapshotDatabase(records, { missing: mode === 'missing' }); window.indexedDB = database;
    const promise = monitor.loadSavedSnapshot({ isFile: () => true, isDir: () => false }, { storeLocalEntry(path, entry, callback) {
      if (mode === 'cancelled') monitor.stop();
      callback(null);
    } });
    await assert.rejects(promise, error => error.i18nKey === 'threeDsSavedDataUnavailable');
    if (mode === 'missing') assert.equal(database.state.abortedCreation, true);
    else assert.deepEqual(database.state.transactions, ['readonly']);
    assert.equal(monitor.state.savedSnapshot.state, mode === 'cancelled' ? 'cancelled' : 'failed');
  }
});

test('native readback uses reported current values, never the available/default value list', () => {
  const { API, config, advance, messages } = setup();
  assert.equal(API.parseOptions('citra_resolution_factor; 1|2|3').citra_resolution_factor, undefined);
  assert.equal(API.parseOptions('citra_resolution_factor|2; 1|2|3').citra_resolution_factor, '2');
  assert.equal(Object.keys(API.parseOptions('x'.repeat(131073))).length, 0);
  const monitor = new API(config('baseline'));
  let raw = 'citra_resolution_factor|2; 1|2|3\ncitra_use_hw_shaders|enabled; enabled|disabled';
  const emulator = { Module: {}, gameManager: { getCoreOptions: () => raw } };
  const report = { startedAtMs: 100000, phase: 'running', wasmHeapBytes: 100, coreStartup: { mainInvoked: true } };
  monitor.observe(report, emulator, 'running');
  assert.equal(report.test3ds.optionSource, 'unavailable');
  report.coreStartup.mainReturned = report.coreStartup.frontendStarted = true;
  monitor.observe(report, emulator, 'running');
  assert.equal(report.test3ds.actualOptions.citra_resolution_factor, '2');
  assert.equal(report.test3ds.optionSource, 'native-get_core_options');
  raw = raw.replace('factor|2', 'factor|1'); advance(2100); monitor.observe(report, emulator);
  assert.equal(report.test3ds.settingsChanges.length, 1);
  assert.equal(report.test3ds.settingsChanges[0].before, '2');
  assert.equal(messages.at(-1).runId, config('baseline').runId);
});

test('test saves replace only the shared IDBFS save mount and restore the mount function', async () => {
  const { API, config } = setup();
  const monitor = new API(config('baseline'));
  const calls = [];
  const MEMFS = {}, IDBFS = {};
  const originalMount = function(...args) { calls.push(args); return 'mounted'; };
  const FS = { filesystems: { MEMFS, IDBFS }, mount: originalMount };
  let receiver;
  const emulator = { Module: { FS }, async initializeGameManager(argument) {
    receiver = this; assert.equal(argument, 123);
    FS.mount(IDBFS, { autoPersist: true }, '/data/saves');
    FS.mount(IDBFS, { preserved: true }, '/other');
    return 'initialized';
  } };
  monitor.attach(Object.assign(emulator, runtimeHooks(emulator)));
  assert.equal(await emulator.initializeGameManager(123), 'initialized');
  assert.equal(receiver, emulator);
  assert.equal(calls[0][0], MEMFS);
  assert.equal(calls[0][2], '/data/saves');
  assert.equal(calls[1][0], IDBFS);
  assert.equal(calls[1][1].preserved, true);
  assert.equal(FS.mount, originalMount);
  assert.equal(monitor.state.saveStorage, 'volatile-memory');
  const broken = new API(config('baseline'));
  broken.attach(runtimeHooks({ Module: { FS }, initializeGameManager() { throw new Error('failed initialization'); } }));
  await assert.rejects(broken.emulator.initializeGameManager(), /failed initialization/);
  assert.equal(FS.mount, originalMount);
  const missing = new API(config('baseline'));
  missing.attach(runtimeHooks({ Module: { FS: {} }, initializeGameManager() { throw new Error('should not run'); } }));
  await assert.rejects(missing.emulator.initializeGameManager(), /isolation is unavailable/);
});

test('memory sampling, stage transitions and parent reports stay bounded and mark no inferred crash cause', () => {
  const { API, config, advance, messages } = setup();
  const monitor = new API(config('baseline'));
  const report = { startedAtMs: 100000, phase: 'loading', wasmHeapBytes: 128 };
  for (let index = 0; index < 1000; index++) {
    report.phase = 'stage-' + index;
    report.wasmHeapBytes += 16;
    monitor.observe(report, {});
    advance(2000);
  }
  assert.equal(report.test3ds.stages.length, 48);
  assert.equal(report.test3ds.samples.length, 64);
  assert.equal(report.test3ds.optionSource, 'unavailable');
  assert.equal(report.test3ds.crashCause, undefined);
  assert.equal(messages.at(-1).diagnostics.phase, 'stage-999');
});
