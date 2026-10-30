import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../assets/js/3ds-test-support.js', import.meta.url), 'utf8');
function setup() {
  let now = 100000;
  const messages = [];
  const window = { location: { origin: 'https://retro.example' }, parent: { postMessage: value => messages.push(structuredClone(value)) } };
  const context = vm.createContext({ window, URLSearchParams, Date: class extends Date { static now() { return now; } } });
  vm.runInContext(source, context);
  const API = window.Retro3DSDiagnostics;
  const runId = '12345678-1234-1234-1234-123456789012';
  const config = profile => API.configuration({ pathname: '/admin/3ds-player.html', search: '?profile=' + profile + '&run=' + runId });
  return { API, config, messages, advance: ms => { now += ms; } };
}

test('3DS test conditions are private-path scoped and alternate exactly one baseline value', () => {
  const { API, config } = setup();
  assert.equal(API.configuration({ pathname: '/pages/player.html', search: '?profile=hardware-shaders-off' }), null);
  assert.throws(() => API.configuration({ pathname: '/admin/3ds-player.html', search: '?profile=constructor&run=x' }));
  const base = config('baseline').options;
  assert.equal(base.citra_resolution_factor, '1');
  for (const [profile, key] of [['shader-cache-off', 'citra_use_hw_shader_cache'], ['hardware-shaders-off', 'citra_use_hw_shaders']]) {
    const alternate = config(profile).options;
    assert.deepEqual(Object.keys(base).filter(key => base[key] !== alternate[key]), [key]);
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
  monitor.attach(emulator);
  assert.equal(await emulator.initializeGameManager(123), 'initialized');
  assert.equal(receiver, emulator);
  assert.equal(calls[0][0], MEMFS);
  assert.equal(calls[0][2], '/data/saves');
  assert.equal(calls[1][0], IDBFS);
  assert.equal(calls[1][1].preserved, true);
  assert.equal(FS.mount, originalMount);
  assert.equal(monitor.state.saveStorage, 'volatile-memory');
  const broken = new API(config('baseline'));
  broken.attach({ Module: { FS }, initializeGameManager() { throw new Error('failed initialization'); } });
  await assert.rejects(broken.emulator.initializeGameManager(), /failed initialization/);
  assert.equal(FS.mount, originalMount);
  const missing = new API(config('baseline'));
  missing.attach({ Module: { FS: {} }, initializeGameManager() { throw new Error('should not run'); } });
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
