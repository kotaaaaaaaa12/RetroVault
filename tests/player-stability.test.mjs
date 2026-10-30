import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';
import { MemoryIndexedDB } from './support/memory-indexeddb.mjs';

const appSource = await readFile(new URL('../assets/js/app.js', import.meta.url), 'utf8');
const playerSource = await readFile(new URL('../assets/js/player.js', import.meta.url), 'utf8');
const runtimeSupportSource = await readFile(new URL('../assets/js/runtime-support.js', import.meta.url), 'utf8');
const resourceDiagnosticsSource = await readFile(new URL('../assets/js/resource-diagnostics.js', import.meta.url), 'utf8');
const coreTestSource = await readFile(new URL('../assets/js/core-test.js', import.meta.url), 'utf8');
const i18nSource = await readFile(new URL('../assets/js/i18n.js', import.meta.url), 'utf8');
const saveStorageSource = await readFile(new URL('../assets/js/save-storage.js', import.meta.url), 'utf8');
const savesSource = await readFile(new URL('../assets/js/saves.js', import.meta.url), 'utf8');
const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const games = [{ id: 1, title: 'Test Game', core: 'nes', rom: 'Test Game.nes' }];

class Element {
  constructor() {
    this.handlers = new Map();
    this.attributes = new Map();
    this.nodeType = 1;
    this.tagName = 'DIV';
    this.tokens = new Set();
    this.classList = {
      add: (...items) => items.forEach(item => this.tokens.add(item)),
      remove: (...items) => items.forEach(item => this.tokens.delete(item)),
      contains: item => this.tokens.has(item),
      toggle: (item, value) => value ? this.tokens.add(item) : this.tokens.delete(item)
    };
    this.dataset = {};
    this.style = {};
    this.children = [];
    this.textContent = '';
    this.hidden = false;
    this.contentWindow = { postMessage() {} };
  }
  addEventListener(type, callback) {
    if (!this.handlers.has(type)) this.handlers.set(type, []);
    this.handlers.get(type).push(callback);
  }
  removeEventListener(type, callback) {
    this.handlers.set(type, (this.handlers.get(type) || []).filter(item => item !== callback));
  }
  dispatch(type, detail = {}) { for (const callback of this.handlers.get(type) || []) callback({ target: this, ...detail }); }
  appendChild(child) { this.children.push(child); return child; }
  append(...items) { this.children.push(...items); }
  prepend(child) { this.children.unshift(child); }
  replaceChildren(...items) { this.children = items; }
  contains(child) { return this.children.some(item => item === child || item.contains?.(child)); }
  get childNodes() { return this.children; }
  setAttribute(key, value) { this.attributes.set(key, value); }
  getAttribute(key) { return this.attributes.get(key) ?? null; }
  querySelectorAll() { return []; }
  focus() { if (this.ownerDocument) this.ownerDocument.activeElement = this; }
  blur() { if (this.ownerDocument) this.ownerDocument.activeElement = this.ownerDocument.body; }
  click() { this.dispatch('click'); }
  getClientRects() { return [{}]; }
  remove() {}
}

function storage(seed = {}) {
  const entries = new Map(Object.entries(seed));
  return {
    get length() { return entries.size; },
    key: index => [...entries.keys()][index] ?? null,
    getItem: key => entries.get(key) ?? null,
    setItem: (key, value) => entries.set(key, String(value)),
    removeItem: key => entries.delete(key)
  };
}

async function environment(source, options = {}) {
  const elements = new Map();
  const document = new Element();
  document.body = new Element();
  document.activeElement = document.body;
  document.getElementById = id => {
    if (!elements.has(id)) {
      const element = new Element();
      element.ownerDocument = document;
      elements.set(id, element);
    }
    return elements.get(id);
  };
  document.createElement = tag => {
    const element = new Element();
    element.ownerDocument = document;
    element.tagName = tag.toUpperCase();
    return element;
  };
  document.createDocumentFragment = () => new Element();
  document.querySelector = () => options.coreError || null;
  const window = new Element();
  window.localStorage = storage(options.localStorage);
  window.sessionStorage = options.sessionStorage || storage();
  window.crossOriginIsolated = options.isolated !== false;
  window.indexedDB = options.indexedDB;
  if (options.audioContext) window.AudioContext = options.audioContext;
  if (options.console) window.console = options.console;
  window.SharedArrayBuffer = SharedArrayBuffer;
  window.navigator = { language: options.browserLanguage || 'en-US', languages: [options.browserLanguage || 'en-US'], ...options.navigator };
  window.location = { origin: 'https://retro.example', search: options.search || '?id=1' };
  const posts = [];
  window.parent = { postMessage: data => posts.push(data) };
  const observers = [];
  const timers = new Map();
  let timerId = 0;
  const schedule = (callback, delay, interval = false) => {
    const id = ++timerId;
    timers.set(id, { callback, delay, interval });
    return id;
  };
  const context = vm.createContext({
    window, document, URL, URLSearchParams, Blob, File, AbortController, TextEncoder, TextDecoder, console: options.console || console,
    sessionStorage: window.sessionStorage, location: window.location, navigator: window.navigator,
    setTimeout: (callback, delay) => schedule(callback, delay),
    setInterval: (callback, delay) => schedule(callback, delay, true),
    clearTimeout: id => timers.delete(id),
    clearInterval: id => timers.delete(id),
    fetch: async () => ({ ok: true, json: async () => structuredClone(options.games || games) }),
    MutationObserver: class { constructor(callback) { observers.push(callback); } observe() {} disconnect() { this.disconnected = true; } }
  });
  vm.runInContext(i18nSource, context);
  vm.runInContext(runtimeSupportSource, context);
  vm.runInContext(resourceDiagnosticsSource, context);
  if (options.loadSaves) {
    vm.runInContext(saveStorageSource, context);
    vm.runInContext(savesSource, context);
  }
  vm.runInContext(source, context);
  await new Promise(resolve => setImmediate(resolve));
  return { context, window, document, elements, posts, observers, timers };
}

test('launcher has no threading UI and its inline scripts compile', () => {
  assert.doesNotMatch(html, /threads-toggle|threads-status|thread-control|THREADS/);
  for (const [, source] of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) new vm.Script(source);
});

test('standalone NES comparison excludes custom loaders and preserves normal diagnostics', async () => {
  const shared = storage({ 'retro-vault-diagnostics': 'normal-player-log' });
  const env = await environment(coreTestSource, {
    sessionStorage: shared,
    games: [...games, { ...games[0], id: 2, dataPath: 'https://custom.example/data/' },
      { ...games[0], id: 3, ejsVersion: 'nightly' }, { ...games[0], id: 4, core: 'snes' }]
  });
  assert.equal(env.elements.get('test-game').children.length, 1);
  env.elements.get('test-game').value = '0';
  env.elements.get('test-version').value = '4.2.3';
  env.elements.get('test-start').click();
  assert.equal(env.window.EJS_startOnLoaded, false);
  assert.equal(env.window.EJS_threads, false);
  assert.equal(env.window.EJS_disableAutoLang, false);
  assert.equal(env.window.EJS_defaultOptions['save-save-interval'], undefined);
  assert.equal(env.window.EJS_gameUrl, 'https://retro.example/data/roms/Test%20Game.nes');
  assert.notEqual(env.window.EJS_gameName, games[0].title);
  assert.equal(env.document.body.children.at(-1).src, 'https://cdn.emulatorjs.org/4.2.3/data/loader.js');
  let paused = 0;
  env.window.EJS_emulator = { Module: { HEAPU8: new Uint8Array(128) }, pause() { paused++; } };
  env.window.EJS_ready();
  env.window.EJS_onGameStart();
  for (let i = 0; i < 9; i++) env.window.dispatch('error', { error: new Error('sample error') });
  env.elements.get('test-finish').click();
  const log = JSON.parse(shared.getItem('retro-vault-core-test-diagnostics'));
  assert.equal(log.mode, 'standalone-core-test');
  assert.equal(log.phase, 'finished');
  assert.equal(log.wasmHeapBytes, 128);
  assert.equal(log.errors.length, 4);
  assert.equal(paused, 1);
  assert.equal(shared.getItem('retro-vault-diagnostics'), 'normal-player-log');
  assert.equal(env.elements.get('test-download').hidden, false);
  const page = await readFile(new URL('../pages/core-test.html', import.meta.url), 'utf8');
  assert.doesNotMatch(page, /<iframe|src="[^\"]*(?:app|player|saves|save-storage)\.js/);
});

test('standalone comparison keeps a previous report until a new test starts', async () => {
  const old = JSON.stringify({ mode: 'standalone-core-test', gameElapsedSeconds: 63 });
  const shared = storage({ 'retro-vault-core-test-diagnostics': old });
  const env = await environment(coreTestSource, { sessionStorage: shared });
  assert.equal(shared.getItem('retro-vault-core-test-diagnostics'), old);
  assert.equal(env.elements.get('test-download').hidden, false);
  assert.match(env.elements.get('test-status').textContent, /63 seconds/);
  env.elements.get('test-game').value = '0';
  env.elements.get('test-start').click();
  assert.equal(JSON.parse(shared.getItem('retro-vault-core-test-diagnostics')).gameElapsedSeconds, null);
});

test('prerelease comparison loads its matching runtime with Japanese translations and separate save names', async () => {
  const env = await environment(coreTestSource, { browserLanguage: 'ja-JP' });
  assert.equal(env.elements.get('test-version').value, '4.3.0-pre');
  env.elements.get('test-game').value = '0';
  env.elements.get('test-start').click();
  assert.equal(env.window.EJS_pathtodata, 'https://cdn.emulatorjs.org/4.3.0-pre/data/');
  assert.equal(env.document.body.children.at(-1).src, env.window.EJS_pathtodata + 'loader.js');
  assert.equal(env.window.EJS_threads, false);
  assert.equal(env.window.EJS_language, 'ja');
  assert.equal(env.window.EJS_disableAutoLang, true);
  assert.ok(env.window.EJS_paths.ja.startsWith('blob:'));
  assert.match(env.window.EJS_gameName, /4\.3\.0-pre/);
  env.window.EJS_emulator = { ejs_version: '4.3.0-pre', getCore: () => 'fceumm', Module: { HEAPU8: new Uint8Array(64) } };
  env.window.EJS_onGameStart();
  const log = JSON.parse(env.window.sessionStorage.getItem('retro-vault-core-test-diagnostics'));
  assert.equal(log.emulatorVersion, '4.3.0-pre');
  assert.equal(log.runtimeVersion, '4.3.0-pre');
  assert.equal(log.resolvedCore, 'fceumm');
  assert.equal(log.wasmHeapBytes, 64);
  assert.equal(env.elements.get('test-version').disabled, true);
});

test('old site preference cannot turn threads on for a normal game or local ROM', async () => {
  const env = await environment(appSource, { localStorage: { 'retro-vault-threads': 'true' } });
  vm.runInContext('openGame(state.games[0])', env.context);
  const frame = env.elements.get('emulator-frame');
  assert.equal(new URL(frame.src, env.window.location.origin).searchParams.get('threads'), '0');
  vm.runInContext('closeModal(); finishClosingPlayer(); openLocalGame(new File(["rom"], "game.nes"), "nes")', env.context);
  assert.equal(new URL(frame.src, env.window.location.origin).searchParams.get('threads'), '0');
});

test('required cores still work and unsupported browsers get an error', async () => {
  const env = await environment(appSource);
  vm.runInContext('openLocalGame(new File(["rom"], "game.iso"), "psp")', env.context);
  assert.equal(new URL(env.elements.get('emulator-frame').src, env.window.location.origin).searchParams.get('threads'), '1');
  const unsupported = await environment(appSource, { isolated: false });
  vm.runInContext('openLocalGame(new File(["rom"], "game.iso"), "psp")', unsupported.context);
  assert.match(unsupported.elements.get('notice').textContent, /unavailable/);
  assert.equal(unsupported.elements.get('modal').classList.contains('open'), false);
});

test('a JSON 3DS entry passes through the launcher and selects the nightly loader', async () => {
  const entry = { id: 301, title: 'Example 3DS Game', rom: 'example.3ds', core: '3ds', thumbnail: 'example.png', ejsVersion: 'nightly' };
  const app = await environment(appSource, { games: [entry] });
  vm.runInContext('openGame(state.games[0])', app.context);
  const search = new URL(app.elements.get('emulator-frame').src, app.window.location.origin).search;
  assert.equal(new URLSearchParams(search).get('threads'), '1');
  const player = await environment(playerSource, { games: [entry], search });
  assert.equal(player.window.EJS_core, '3ds');
  assert.equal(player.window.EJS_threads, true);
  assert.equal(player.window.EJS_gameUrl, 'https://retro.example/data/roms/example.3ds');
  assert.equal(player.window.EJS_pathtodata, 'https://cdn.emulatorjs.org/nightly/data/');
  assert.equal(player.document.body.children.at(-1).src, 'https://cdn.emulatorjs.org/nightly/data/loader.js');
  const unsupported = await environment(appSource, { games: [entry], isolated: false });
  vm.runInContext('openGame(state.games[0])', unsupported.context);
  assert.equal(unsupported.elements.get('modal').classList.contains('open'), false);
  assert.match(unsupported.elements.get('notice').textContent, /requires threaded emulation/);
});

test('an explicit dataPath overrides the JSON version and ordinary games retain the pinned default', async () => {
  const game = { id: 1, title: 'Example', rom: 'example.nes', core: 'nes', ejsVersion: 'nightly', dataPath: 'https://cores.example/custom' };
  const custom = await environment(playerSource, { games: [game] });
  assert.equal(custom.window.EJS_pathtodata, 'https://cores.example/custom/');
  const standard = await environment(playerSource);
  assert.equal(standard.window.EJS_pathtodata, 'https://cdn.emulatorjs.org/4.3.0-pre/data/');
});

test('main player defaults to the tested prerelease while explicit legacy loaders keep their locale contract', async () => {
  const current = await environment(playerSource, { browserLanguage: 'ja' });
  assert.equal(current.document.body.children.at(-1).src, 'https://cdn.emulatorjs.org/4.3.0-pre/data/loader.js');
  assert.equal(current.window.EJS_gameID, 1);
  assert.equal(current.window.EJS_gameName, 'Test Game');
  assert.equal(current.window.EJS_language, 'ja');
  assert.equal(current.window.EJS_disableAutoLang, true);
  assert.equal(JSON.parse(current.window.sessionStorage.getItem('retro-vault-diagnostics')).emulatorVersion, '4.3.0-pre');
  for (const entry of [{ ...games[0], ejsVersion: '4.2.3' },
    { ...games[0], ejsVersion: 'nightly', dataPath: 'https://cdn.emulatorjs.org/4.2.3/data/' }]) {
    const legacy = await environment(playerSource, { browserLanguage: 'ja', games: [entry] });
    assert.equal(legacy.window.EJS_disableAutoLang, false);
    assert.equal(legacy.window.EJS_language, 'ja-JA');
    assert.ok(legacy.window.EJS_paths['ja-JA']);
    assert.equal(JSON.parse(legacy.window.sessionStorage.getItem('retro-vault-diagnostics')).emulatorVersion, '4.2.3');
  }
});

test('managed games keep save names and thread preferences stable when titles change and core overrides change the backend', async () => {
  const game = { ...games[0], title: 'Renamed Game', saveName: 'Original Name', coreOverride: 'nestopia' };
  const key = 'ejs-1-nes-Original Name-settings';
  const env = await environment(playerSource, { games: [game], localStorage: { [key]: JSON.stringify({ settings: { ejs_threads: 'enabled', volume: .4 } }) } });
  assert.equal(env.window.EJS_gameName, 'Original Name');
  assert.equal(env.window.EJS_core, 'nestopia');
  assert.equal(env.window.EJS_threads, false);
  assert.deepEqual(JSON.parse(env.window.localStorage.getItem(key)).settings, { volume: .4 });
});

test('library and local 3DS entries use the pinned prerelease with required threads', async () => {
  const game = { ...games[0], core: '3ds', rom: 'game.3ds' };
  const player = await environment(playerSource, { games: [game], search: '?id=1&threads=1' });
  assert.equal(player.window.EJS_pathtodata, 'https://cdn.emulatorjs.org/4.3.0-pre/data/');
  assert.equal(player.window.EJS_threads, true);
  const launcher = await environment(appSource);
  vm.runInContext('openLocalGame(new File(["rom"], "game.3ds"), "3ds")', launcher.context);
  assert.equal(vm.runInContext('state.localLaunch.game.ejsVersion', launcher.context), undefined);
  assert.equal(new URL(launcher.elements.get('emulator-frame').src, launcher.window.location.origin).searchParams.get('threads'), '1');
});

test('local ROMs reach the runtime as named Files without a blob URL round trip or a pre-read', async () => {
  for (const source of [new File(['rom'], 'local game.3ds'), new Blob(['rom'])]) {
    const player = await environment(playerSource, { search: '?mode=local&threads=1' });
    const file = source instanceof File ? source : null;
    const originalRead = file?.arrayBuffer;
    player.window.dispatch('message', { origin: player.window.location.origin, source: player.window.parent,
      data: { type: 'retro-vault-local-rom', file: source, game: { id: 1234567890, title: 'Local game', core: '3ds', localFilename: 'local game.3ds' } } });
    const runtimeFile = player.window.EJS_gameUrl;
    assert.ok(runtimeFile instanceof File);
    assert.equal(runtimeFile.name, 'local game.3ds');
    assert.equal(runtimeFile.size, 3);
    let log = JSON.parse(player.window.sessionStorage.getItem('retro-vault-diagnostics'));
    assert.equal(log.localRom.readState, 'waiting');
    assert.equal(log.localRom.readAttempts, 0);
    assert.equal(Buffer.from(await runtimeFile.arrayBuffer()).toString(), 'rom');
    log = JSON.parse(player.window.sessionStorage.getItem('retro-vault-diagnostics'));
    assert.equal(log.localRom.readState, 'read');
    assert.equal(log.localRom.readBytes, 3);
    assert.equal(log.localRom.extension, '3ds');
    assert.equal(log.localRom.size, 3);
    await vm.runInContext('shutdownPlayer()', player.context);
    assert.equal(player.window.EJS_gameUrl, '');
    if (file) assert.equal(file.arrayBuffer, originalRead);
  }
});

test('resource diagnostics identify failed requests without secrets, data copies, or changing responses and rejections', async () => {
  const env = await environment(playerSource);
  const failure = new TypeError('Load failed');
  const response = { ok: false, status: 404 };
  const original = async input => {
    if (String(input).includes('failed')) throw failure;
    return response;
  };
  env.window.fetch = original;
  const support = new env.window.RetroResourceDiagnostics({});
  assert.equal(await env.window.fetch('https://user:password@cdn.example/core.wasm?token=secret#private'), response);
  await assert.rejects(env.window.fetch('https://cdn.example/failed.data?key=secret'), error => error === failure);
  assert.equal(support.requests[0].resource, 'https://cdn.example/core.wasm');
  assert.equal(support.requests[0].status, 404);
  assert.equal(support.requests[0].outcome, 'http-error');
  assert.equal(support.requests[1].resource, 'https://cdn.example/failed.data');
  assert.equal(support.requests[1].outcome, 'failed');
  assert.equal(support.describe('blob:https://retro.example/private-token'), 'blob:[local]');
  assert.equal(support.describe('data:application/octet-stream;base64,private'), 'data:[local]');
  assert.doesNotMatch(JSON.stringify(support.requests), /password|secret|token/);
  for (let index = 0; index < 20; index++) await env.window.fetch('https://cdn.example/core-' + index);
  assert.equal(support.requests.length, 12);
  const file = new File(['rom'], 'test.3ds');
  const readFailure = new DOMException('File unavailable.', 'NotReadableError');
  const read = () => Promise.reject(readFailure);
  Object.defineProperty(file, 'arrayBuffer', { configurable: true, writable: true, value: read });
  let reported;
  support.onReadFailure = error => { reported = error; };
  support.trackFile(file);
  await assert.rejects(file.arrayBuffer(), error => error === readFailure);
  assert.equal(support.localRom.readState, 'failed');
  assert.equal(support.localRom.errorName, 'NotReadableError');
  assert.equal(reported, readFailure);
  support.stop();
  assert.equal(env.window.fetch, original);
  assert.equal(file.arrayBuffer, read);
});

test('private RWebAudio contexts are tracked without creating audio and close once on player shutdown', async () => {
  let created = 0;
  let closed = 0;
  class AudioContext {
    constructor() { created++; this.state = 'running'; }
    close() { closed++; this.state = 'closed'; return Promise.resolve(); }
  }
  const env = await environment(playerSource, { audioContext: AudioContext });
  assert.equal(created, 0);
  const context = new env.window.AudioContext();
  assert.ok(context instanceof AudioContext);
  const emulator = { started: true, paused: false, isFastForward: false,
    ejs_version: '4.3.0-pre', pause() {},
    Module: {},
    gameManager: { saveSaveFiles() {}, FS: { syncfs(populate, callback) { callback(null); } } }
  };
  env.window.EJS_emulator = emulator;
  env.window.EJS_onGameStart();
  const log = JSON.parse(env.window.sessionStorage.getItem('retro-vault-diagnostics'));
  assert.equal(log.runtimeVersion, '4.3.0-pre');
  assert.equal(log.fastForward, false);
  assert.deepEqual(log.environment.audioStates, ['running']);
  emulator.Module.AL = { currentCtx: { audioCtx: context } };
  await vm.runInContext('shutdownPlayer()', env.context);
  assert.equal(closed, 1);
  assert.equal(env.window.AudioContext, AudioContext);
  assert.equal(created, 1);
});

test('the prerelease mobile Safari audio check does not dereference missing OpenAL contexts or create a blocking popup', async () => {
  const env = await environment(playerSource);
  let calls = 0;
  const emulator = { isSafari: true, isMobile: true, ejs_version: '4.3.0-pre', Module: { AL: { currentCtx: null } },
    checkStarted() { calls++; return this.Module.AL.currentCtx.sources; }, on() {}, canvas: new Element() };
  const original = emulator.checkStarted;
  assert.throws(() => original.call(emulator), TypeError);
  env.window.EJS_emulator = emulator;
  env.window.EJS_ready();
  assert.doesNotThrow(() => emulator.checkStarted());
  emulator.Module.AL.currentCtx = { sources: [] };
  assert.doesNotThrow(() => emulator.checkStarted());
  assert.equal(calls, 1);
  assert.equal(JSON.parse(env.window.sessionStorage.getItem('retro-vault-diagnostics')).input.audioCheck, 'gesture-recovery');
  await vm.runInContext('shutdownPlayer()', env.context);
  assert.equal(emulator.checkStarted, original);
});

test('the Safari startup compatibility change leaves other runtimes and browsers unchanged', async () => {
  for (const flags of [{ isSafari: false, isMobile: true, ejs_version: '4.3.0-pre' }, { isSafari: true, isMobile: true, ejs_version: '4.2.3' }]) {
    const env = await environment(playerSource);
    const original = () => 'native';
    const emulator = { ...flags, checkStarted: original, on() {} };
    env.window.EJS_emulator = emulator; env.window.EJS_ready();
    assert.equal(emulator.checkStarted, original);
  }
});

test('trusted input resumes existing audio without consuming controls and records only input counts', async () => {
  let resumed = 0;
  class AudioContext {
    constructor() { this.state = 'suspended'; }
    resume() { resumed++; this.state = 'running'; return Promise.resolve(); }
    close() { this.state = 'closed'; return Promise.resolve(); }
  }
  const env = await environment(playerSource, { audioContext: AudioContext });
  const audio = new env.window.AudioContext();
  const manager = { simulateInput(...args) { assert.equal(this, manager); return args.join(':'); } };
  const emulator = { started: true, paused: false, gameManager: manager, on() {} };
  env.window.EJS_emulator = emulator; env.window.EJS_ready(); env.window.EJS_onGameStart();
  env.document.dispatch('touchend', { type: 'touchend', isTrusted: false });
  assert.equal(resumed, 0);
  const event = { isTrusted: true, preventDefault() { assert.fail('Input was consumed'); } };
  env.document.dispatch('touchstart', { type: 'touchstart', ...event });
  env.document.dispatch('touchend', { type: 'touchend', ...event });
  assert.equal(resumed, 1);
  assert.equal(manager.simulateInput(0, 3, 1), '0:3:1');
  env.document.dispatch('keydown', { type: 'keydown', key: 'private-key-value', ...event });
  vm.runInContext('sampleDiagnostics()', env.context);
  const raw = env.window.sessionStorage.getItem('retro-vault-diagnostics');
  const log = JSON.parse(raw);
  assert.equal(log.input.touchEvents, 1); assert.equal(log.input.keyEvents, 1); assert.equal(log.input.coreInputCalls, 1);
  assert.ok(!raw.includes('private-key-value'));
  audio.state = 'suspended'; emulator.paused = true;
  env.document.dispatch('touchend', { type: 'touchend', ...event });
  assert.equal(resumed, 1);
  await vm.runInContext('shutdownPlayer()', env.context);
  assert.equal(audio.resume, AudioContext.prototype.resume);
  env.document.dispatch('touchend', { type: 'touchend', ...event });
  assert.equal(resumed, 1);
});

test('permission failures name the rejected operation, retain native failure behavior, and restore hooks', async () => {
  const denied = Object.assign(new Error('Permission was denied'), { name: 'NotAllowedError', stack: '' });
  const getGamepads = () => { throw denied; };
  class AudioContext {
    constructor() { this.state = 'suspended'; }
    resume() { return Promise.reject(denied); }
    close() { return Promise.resolve(); }
  }
  const env = await environment(playerSource, { audioContext: AudioContext, navigator: { getGamepads } });
  const audio = new env.window.AudioContext();
  assert.throws(() => env.window.navigator.getGamepads(), error => error === denied);
  await assert.rejects(audio.resume(), error => error === denied);
  await new Promise(resolve => setImmediate(resolve));
  const log = JSON.parse(env.window.sessionStorage.getItem('retro-vault-diagnostics'));
  assert.deepEqual(log.operationFailures.map(item => item.operation), ['navigator.getGamepads', 'AudioContext.resume']);
  assert.equal(log.errors.at(-1).operation, 'AudioContext.resume');
  assert.equal(log.errors.at(-1).name, 'NotAllowedError');
  await vm.runInContext('shutdownPlayer()', env.context);
  assert.equal(env.window.navigator.getGamepads, getGamepads);
});

test('errors, exit messages, backdrop taps, and Escape keep the game view open; CLOSE dismisses it', async () => {
  const env = await environment(appSource);
  vm.runInContext('openGame(state.games[0])', env.context);
  const modal = env.elements.get('modal');
  const frame = env.elements.get('emulator-frame');
  for (const type of ['retro-vault-player-error', 'retro-vault-player-exit']) {
    env.window.dispatch('message', { origin: env.window.location.origin, source: frame.contentWindow, data: { type, message: 'Test failure' } });
    assert.equal(modal.classList.contains('open'), true);
    assert.equal(env.elements.get('player-status').textContent, type === 'retro-vault-player-error' ? 'Test failure' : env.window.RetroI18n.t('emulatorStopped'));
  }
  modal.dispatch('click');
  env.document.dispatch('keydown', { key: 'Escape' });
  assert.equal(modal.classList.contains('open'), true);
  env.elements.get('close-btn').dispatch('click');
  assert.equal(env.elements.get('close-btn').disabled, true);
  env.window.dispatch('message', { origin: env.window.location.origin, source: frame.contentWindow, data: { type: 'retro-vault-player-stopped', token: vm.runInContext('state.closeToken', env.context) } });
  assert.equal(modal.classList.contains('open'), false);
  assert.equal(frame.src, 'about:blank');
  assert.equal(env.window.sessionStorage.getItem('retro-vault-active-game'), null);
});

test('a page reload during a game produces a notice without restarting the game', async () => {
  const sessionStorage = storage({ 'retro-vault-active-game': 'Test Game' });
  const env = await environment(appSource, { sessionStorage });
  assert.match(env.elements.get('notice').textContent, /reloaded while Test Game was open/);
  assert.equal(env.elements.get('modal').classList.contains('open'), false);
  assert.equal(sessionStorage.getItem('retro-vault-active-game'), null);
});

test('direct player defaults to threads OFF and preserves unrelated settings and save data', async () => {
  const key = 'ejs-1-nes-Test Game-settings';
  const saved = { settings: { ejs_threads: 'enabled', volume: 0.8 }, cheats: ['test'], controlSettings: { a: 'x' } };
  const env = await environment(playerSource, { localStorage: { [key]: JSON.stringify(saved), 'save-data': 'keep' } });
  assert.equal(env.window.EJS_threads, false);
  const updated = JSON.parse(env.window.localStorage.getItem(key));
  delete saved.settings.ejs_threads;
  assert.deepEqual(updated, saved);
  assert.equal(env.window.localStorage.getItem('save-data'), 'keep');
  assert.equal(env.window.EJS_defaultOptions.ejs_threads, 'disabled');
  const optedIn = await environment(playerSource, { search: '?id=1&threads=1' });
  assert.equal(optedIn.window.EJS_threads, true);
});

test('runtime errors, actual emulator exit events, and context loss are surfaced', async () => {
  const env = await environment(playerSource);
  const events = new Map();
  const canvas = new Element();
  env.window.EJS_emulator = { on: (name, callback) => events.set(name, callback), canvas };
  env.window.EJS_ready();
  events.get('exit')();
  assert.match(env.elements.get('player-message').textContent, /emulator stopped/);
  canvas.dispatch('webglcontextlost', { preventDefault() {} });
  assert.match(env.elements.get('player-message').textContent, /graphics context was lost/);
  env.window.dispatch('unhandledrejection', { reason: new Error('WASM failure') });
  assert.equal(env.posts.at(-1).message, 'WASM failure');
  env.window.dispatch('pagehide');
  const previousCount = env.posts.length;
  events.get('exit')();
  assert.equal(env.posts.length, previousCount);
});

test('internally handled core errors are surfaced too', async () => {
  const env = await environment(playerSource, { coreError: { textContent: 'Failed to start game' } });
  env.observers[0]([]);
  assert.equal(env.posts.at(-1).message, 'Failed to start game');
});

test('Auto follows the preferred browser language and an explicit choice is saved', async () => {
  const env = await environment(appSource, { browserLanguage: 'ja-JP' });
  assert.equal(env.window.RetroI18n.language, 'ja');
  assert.equal(env.elements.get('stats').textContent, '1件中1件（容量不明）');
  assert.equal(vm.runInContext('coreLabel("nes")', env.context), 'ファミコン／NES');
  env.window.RetroI18n.setLanguage('en');
  assert.equal(env.elements.get('stats').textContent, '1 of 1 games (size unavailable)');
  assert.equal(env.window.localStorage.getItem('retro-vault-language'), 'en');
  const persisted = await environment(appSource, { browserLanguage: 'ja-JP', localStorage: { 'retro-vault-language': 'en' } });
  assert.equal(persisted.window.RetroI18n.language, 'en');
});

test('language changes preserve the active game, filter, notices, and error descriptions', async () => {
  const env = await environment(appSource);
  vm.runInContext('state.activeCore = canonicalFilterKey("nes"); openGame(state.games[0]); setNotice("emptyFile"); showPlayerError("", "contextLost")', env.context);
  const frame = env.elements.get('emulator-frame');
  const originalSource = frame.src;
  const posts = [];
  frame.contentWindow.postMessage = message => posts.push(message);
  env.window.RetroI18n.setLanguage('ja');
  assert.equal(frame.src, originalSource);
  assert.equal(env.elements.get('modal').classList.contains('open'), true);
  assert.equal(vm.runInContext('getFilteredGames().length', env.context), 1);
  assert.match(env.elements.get('notice').textContent, /ファイル/);
  assert.match(env.elements.get('player-status').textContent, /描画/);
  assert.equal(posts.at(-1).language, 'ja');
  env.window.RetroI18n.setLanguage('en');
  assert.match(env.elements.get('player-status').textContent, /graphics context/);
});

test('both locale dictionaries cover every interface key used by scripts and markup', async () => {
  const env = await environment(appSource);
  const playerHtml = await readFile(new URL('../pages/player.html', import.meta.url), 'utf8');
  const changelogHtml = await readFile(new URL('../pages/changelog.html', import.meta.url), 'utf8');
  const managementSources = await Promise.all(['../admin/index.html', '../admin/login.html', '../admin/core-test.html', '../assets/js/admin.js', '../assets/js/login.js', '../assets/js/core-test.js'].map(path => readFile(new URL(path, import.meta.url), 'utf8')));
  const source = appSource + playerSource + savesSource + html + playerHtml + changelogHtml + managementSources.join('\n');
  const keys = new Set([
    ...[...source.matchAll(/(?:\bt|setNotice|reportPlayerError|playerError|showMessage|setStatus|ask|show|makeButton)\(["']([a-zA-Z]+)["']/g)].map(match => match[1]),
    ...[...source.matchAll(/data-i18n(?:-[a-z-]+)?="([a-zA-Z]+)"/g)].map(match => match[1]),
    'ambiguousExtension', 'unknownExtension', 'runtimeError', 'saveHere', 'loadHere', 'downloadBackup', 'importBackup', 'deleteSave'
  ]);
  for (const locale of ['en', 'ja']) {
    env.window.RetroI18n.setLanguage(locale);
    for (const key of keys) assert.notEqual(env.window.RetroI18n.t(key), key, `${locale}: ${key}`);
  }
});

test('the player uses the correct Japanese EmulatorJS locale and a bundled complete dictionary', async () => {
  const env = await environment(playerSource, { browserLanguage: 'en-US', search: '?id=1&lang=ja' });
  assert.equal(env.window.RetroI18n.language, 'ja');
  assert.equal(env.window.EJS_language, 'ja');
  assert.equal(env.window.EJS_disableAutoLang, true);
  assert.equal(env.window.EJS_threads, false);
  const dictionary = await (await fetch(env.window.EJS_paths.ja)).json();
  assert.equal(dictionary['Download Game Core'], 'ゲームコアをダウンロード');
  assert.equal(dictionary['Graphics Settings'], '映像設定');
  assert.equal(dictionary['Requires restart'], '再起動が必要');
  assert.ok(Object.keys(dictionary).length >= 400);
  env.window.dispatch('pagehide');
});

test('native menus update without rebooting the emulator and unknown runtime errors have Japanese guidance', async () => {
  const env = await environment(playerSource);
  const events = new Map();
  const canvas = new Element();
  const text = { nodeType: 3, nodeValue: 'Graphics Settings' };
  const game = env.elements.get('game');
  game.appendChild(text);
  const emulator = { config: {}, canvas, on: (name, callback) => events.set(name, callback) };
  env.window.EJS_emulator = emulator;
  env.window.EJS_ready();
  env.window.dispatch('message', { origin: env.window.location.origin, source: env.window.parent, data: { type: 'retro-vault-language', language: 'ja' } });
  assert.equal(env.window.EJS_emulator, emulator);
  assert.equal(text.nodeValue, '映像設定');
  assert.equal(emulator.config.language, 'ja');
  assert.equal(env.window.RetroI18n.translateEmulatorText('Core (再起動が必要)'), 'コア（再起動が必要）');
  assert.equal(env.window.RetroI18n.translateEmulatorText('fceumm region'), '地域');
  env.window.dispatch('error', { message: 'Some unfamiliar WASM error' });
  assert.match(env.elements.get('player-message').textContent, /エミュレーターでエラー/);
  assert.doesNotMatch(env.elements.get('player-message').textContent, /unfamiliar/);
  env.window.RetroI18n.setLanguage('en', false);
  assert.equal(text.nodeValue, 'Graphics Settings');
  assert.equal(env.window.RetroI18n.translateEmulatorText('コア（再起動が必要）'), 'Core (Requires restart)');
  assert.match(env.elements.get('player-message').textContent, /unfamiliar/);
});

test('controller port labels translate in native menus and switch back without altering their numbers', async () => {
  const env = await environment(playerSource);
  const heading = { nodeType: 3, nodeValue: 'Controller Port Devices' };
  const port = { nodeType: 3, nodeValue: 'Port 2' };
  env.elements.get('game').append(heading, port);
  env.window.RetroI18n.setLanguage('ja');
  assert.equal(heading.nodeValue, 'コントローラーポートの機器');
  assert.equal(port.nodeValue, 'ポート 2');
  assert.equal(env.window.RetroI18n.emulatorDictionary()['Controller Port Devices'], heading.nodeValue);
  env.window.RetroI18n.setLanguage('en');
  assert.equal(heading.nodeValue, 'Controller Port Devices');
  assert.equal(port.nodeValue, 'Port 2');
});

test('ready leaves startup guidance hidden and preserves a previously reported error', async () => {
  const env = await environment(playerSource);
  env.window.EJS_ready();
  assert.equal(env.elements.get('player-message').classList.contains('hidden'), true);
  assert.equal(env.window.EJS_startOnLoaded, false);
  env.window.dispatch('error', { message: 'Startup failure' });
  env.window.EJS_ready();
  assert.equal(env.elements.get('player-message').classList.contains('hidden'), false);
  assert.match(env.elements.get('player-message').textContent, /Startup failure/);
});

test('local ROM selection and reload notices are localized', async () => {
  const env = await environment(appSource, { browserLanguage: 'ja' });
  vm.runInContext('showCorePicker(new File(["rom"], "disc.bin"), ["psx"], ".bin")', env.context);
  assert.match(env.elements.get('core-picker-help').textContent, /ゲーム機/);
  assert.equal(env.elements.get('core-picker-select').children[0].textContent, 'プレイステーション');
  const reloaded = await environment(appSource, { browserLanguage: 'ja', sessionStorage: storage({ 'retro-vault-active-game': 'Test Game' }) });
  assert.match(reloaded.elements.get('notice').textContent, /再読み込み/);
});

test('native dictionaries have matching keys and cover core option labels', async () => {
  const env = await environment(appSource);
  env.window.RetroI18n.setLanguage('en');
  const englishKeys = Object.keys(env.window.RetroI18n.emulatorDictionary()).sort();
  env.window.RetroI18n.setLanguage('ja');
  const japanese = env.window.RetroI18n.emulatorDictionary();
  assert.deepEqual(Object.keys(japanese).sort(), englishKeys);
  for (const key of ['Aspect Ratio', 'Color Palette', 'Crop Overscan', 'Audio Interpolation', 'Show Layer 1']) {
    assert.notEqual(japanese[key], key);
    assert.equal(env.window.RetroI18n.translateEmulatorText(key), japanese[key]);
  }
});

test('locale selection tolerates unavailable browser storage', async () => {
  const env = await environment(appSource, { browserLanguage: 'ja' });
  Object.defineProperty(env.window, 'localStorage', { get() { throw new Error('Storage unavailable'); } });
  assert.doesNotThrow(() => env.window.RetroI18n.setLanguage('en'));
  assert.equal(env.window.RetroI18n.language, 'en');
  env.window.navigator = { language: 'ja-JP', languages: ['ja-JP'] };
  env.window.RetroI18n.setLanguage('auto');
  assert.equal(env.window.RetroI18n.language, 'ja');
});

test('production mode enables caching and the footer links to the official site', async () => {
  const env = await environment(playerSource);
  assert.equal(env.window.EJS_DEBUG_XX, false);
  assert.match(html, /<a href="https:\/\/emulatorjs\.org\/" target="_blank" rel="noopener noreferrer">EmulatorJS<\/a>/);
});

test('closing pauses the core, flushes saves, closes audio once, and releases the canvas before acknowledging', async () => {
  const env = await environment(playerSource);
  const calls = [];
  let flush;
  const audio = { close() { calls.push('audio'); return Promise.resolve(); } };
  const canvas = new Element();
  canvas.width = 640;
  canvas.height = 480;
  const emulator = {
    started: true, paused: false, canvas,
    pause() { calls.push('pause'); this.paused = true; },
    Module: { pauseMainLoop() { calls.push('loop'); }, AL: { currentCtx: { audioCtx: audio }, contexts: [{ audioCtx: audio }] } },
    gameManager: { saveSaveFiles() { calls.push('save'); }, FS: { syncfs(populate, callback) { assert.equal(populate, false); flush = callback; } } }
  };
  env.window.EJS_emulator = emulator;
  env.window.dispatch('message', { origin: env.window.location.origin, source: env.window.parent, data: { type: 'retro-vault-player-stop', token: 'test-close' } });
  assert.deepEqual(calls, ['pause', 'loop', 'save']);
  assert.equal(emulator.started, false);
  assert.equal(env.posts.some(item => item.type === 'retro-vault-player-stopped'), false);
  flush(null);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.filter(item => item === 'audio').length, 1);
  assert.equal(canvas.width, 1);
  assert.equal(canvas.height, 1);
  assert.equal(env.window.EJS_emulator, null);
  assert.equal(env.posts.at(-1).token, 'test-close');
  assert.equal(JSON.parse(env.window.sessionStorage.getItem('retro-vault-diagnostics')).saveFlush, 'saved');
  assert.equal(env.timers.size, 0);
  await vm.runInContext('shutdownPlayer()', env.context);
  assert.equal(calls.filter(item => item === 'save').length, 1);
});

test('a stalled save flush is bounded and a dead player can still be closed', async () => {
  const player = await environment(playerSource);
  player.window.EJS_emulator = { started: true, gameManager: { saveSaveFiles() {}, FS: { syncfs() {} } } };
  const cleanup = vm.runInContext('shutdownPlayer()', player.context);
  const saveTimeout = [...player.timers.values()].find(timer => timer.delay === 1200);
  assert.ok(saveTimeout);
  saveTimeout.callback();
  await cleanup;
  assert.equal(JSON.parse(player.window.sessionStorage.getItem('retro-vault-diagnostics')).saveFlush, 'timed-out');

  const app = await environment(appSource);
  vm.runInContext('openGame(state.games[0]); closeModal()', app.context);
  const token = vm.runInContext('state.closeToken', app.context);
  app.window.dispatch('message', { origin: app.window.location.origin, source: app.elements.get('emulator-frame').contentWindow, data: { type: 'retro-vault-player-stopped', token: 'stale-token' } });
  assert.equal(vm.runInContext('state.closeToken', app.context), token);
  assert.equal(app.elements.get('modal').classList.contains('open'), true);
  const fallback = [...app.timers.values()].find(timer => timer.delay === 2000);
  fallback.callback();
  assert.equal(app.elements.get('modal').classList.contains('open'), false);
  assert.equal(app.document.body.classList.contains('playing'), false);
  assert.equal(app.elements.get('emulator-frame').src, 'about:blank');
});

test('diagnostics store bounded metadata and heap growth without copying the heap', async () => {
  const env = await environment(playerSource);
  const heap = { byteLength: 128 * 1024 * 1024 };
  env.window.EJS_emulator = { Module: { HEAPU8: heap } };
  vm.runInContext('sampleDiagnostics("running")', env.context);
  heap.byteLength = 160 * 1024 * 1024;
  vm.runInContext('sampleDiagnostics(); sampleDiagnostics()', env.context);
  for (let index = 0; index < 10; index++) vm.runInContext(`reportPlayerError("runtimeError", { message: "failure-${index}" })`, env.context);
  const raw = env.window.sessionStorage.getItem('retro-vault-diagnostics');
  const diagnostics = JSON.parse(raw);
  assert.equal(diagnostics.heapGrowthEvents, 1);
  assert.equal(diagnostics.peakWasmHeapBytes, heap.byteLength);
  assert.equal(diagnostics.errors.length, 4);
  assert.ok(raw.length < 16000);
  assert.match(diagnostics.memoryScope, /excludes.*GPU/);
  const previousPosts = env.posts.length;
  vm.runInContext('reportPlayerError("runtimeError", { message: "failure-9" })', env.context);
  assert.equal(env.posts.length, previousPosts);
  env.window.EJS_onGameStart();
  assert.equal(env.elements.get('player-message').classList.contains('hidden'), false);
});

test('backgrounding pauses only a running game and does not resume a manual pause', async () => {
  const env = await environment(playerSource);
  const calls = [];
  const emulator = {
    started: true, paused: false,
    pause() { calls.push('pause'); this.paused = true; },
    play() { calls.push('play'); this.paused = false; }
  };
  env.window.EJS_emulator = emulator;
  env.document.hidden = true;
  env.document.dispatch('visibilitychange');
  env.document.hidden = false;
  env.document.dispatch('visibilitychange');
  assert.deepEqual(calls, ['pause', 'play']);
  emulator.paused = true;
  env.document.hidden = true;
  env.document.dispatch('visibilitychange');
  env.document.hidden = false;
  env.document.dispatch('visibilitychange');
  assert.deepEqual(calls, ['pause', 'play']);
});

test('the latest diagnostic log remains available after a page reload', async () => {
  const sessionStorage = storage({
    'retro-vault-active-game': 'Test Game',
    'retro-vault-diagnostics': JSON.stringify({ schemaVersion: 1, phase: 'running', wasmHeapBytes: 134217728 })
  });
  const env = await environment(appSource, { sessionStorage });
  assert.equal(env.elements.get('diagnostics-download').hidden, false);
  assert.equal(vm.runInContext('readDiagnostics().wasmHeapBytes', env.context), 134217728);
  assert.match(env.elements.get('notice').textContent, /reloaded/);
});

test('the launcher releases the local ROM File only after the core starts', async () => {
  const env = await environment(appSource);
  vm.runInContext('openLocalGame(new File(["rom"], "game.nes"), "nes")', env.context);
  assert.equal(vm.runInContext('state.localLaunch.file.name', env.context), 'game.nes');
  const frame = env.elements.get('emulator-frame');
  env.window.dispatch('message', { origin: env.window.location.origin, source: frame.contentWindow, data: { type: 'retro-vault-player-start' } });
  assert.equal(vm.runInContext('state.localLaunch.file', env.context), null);
  assert.equal(vm.runInContext('state.localLaunch.game.core', env.context), 'nes');
});

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (predicate()) return;
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.ok(predicate(), 'The expected asynchronous operation did not complete');
}

async function saveEnvironment(options = {}) {
  const indexedDB = options.indexedDB || new MemoryIndexedDB();
  const env = await environment(playerSource, { ...options, indexedDB, loadSaves: true });
  const handlers = new Map();
  const calls = { states: 0, normal: 0, loaded: [], pauses: 0, plays: 0 };
  const emulator = {
    started: true, paused: !!options.paused, ejs_version: options.emulatorVersion || '4.3.0-pre',
    getCore: () => 'fceumm',
    getBaseFileName: () => 'Test Game',
    settings: { 'save-state-slot': '1' },
    getSettingValue(key) { return this.settings[key]; },
    changeSettingOption(key, value) { this.settings[key] = value; },
    elements: { parent: env.document.createElement('div'), menu: env.document.createElement('div') },
    pause() { this.paused = true; calls.pauses += 1; },
    play() { this.paused = false; calls.plays += 1; },
    on(name, callback) { handlers.set(name, callback); },
    gameManager: {
      supportsStates: () => options.supportsStates !== false,
      getState() { calls.states += 1; return new Uint8Array([1, 2, calls.states]); },
      loadState(data) { calls.loaded.push([...data]); },
      getSaveFile: () => options.noSystemSave ? null : new Uint8Array([8, 9]),
      saveSaveFiles() { calls.normal += 1; handlers.get('saveSaveFiles')?.(new Uint8Array([8, 9])); },
      FS: { syncfs: options.syncfs || ((populate, callback) => callback(null)) }
    }
  };
  const nativeFiles = new Map();
  emulator.gameManager.FS.readFile = path => { const data = nativeFiles.get(path); if (!data) throw new Error('Missing native file'); return data.slice(); };
  emulator.gameManager.FS.writeFile = (path, data) => nativeFiles.set(path, data.slice());
  emulator.gameManager.FS.unlink = path => nativeFiles.delete(path);
  emulator.gameManager.quickSave = function(slot) { this.FS.writeFile('/' + slot + '-quick.state', this.getState()); return true; };
  emulator.gameManager.quickLoad = function(slot) { this.loadState(this.FS.readFile('/' + slot + '-quick.state')); };
  env.window.EJS_emulator = emulator;
  env.window.EJS_onGameStart();
  const manager = vm.runInContext('saveManager', env.context);
  await manager.refresh();
  return { ...env, indexedDB, manager, emulator, handlers, calls };
}

test('save defaults migrate once, preserve unrelated settings, and respect later preferences', async () => {
  const key = 'ejs-1-nes-Test Game-settings';
  const saved = { settings: { 'save-state-location': 'download', 'save-save-interval': '300', volume: 0.6 }, cheats: ['keep'] };
  const first = await environment(playerSource, { localStorage: { [key]: JSON.stringify(saved) } });
  assert.equal(first.window.EJS_defaultOptions['save-state-location'], 'browser');
  assert.equal(first.window.EJS_defaultOptions['save-save-interval'], '30');
  const migrated = JSON.parse(first.window.localStorage.getItem(key));
  assert.deepEqual(migrated, { settings: { volume: 0.6 }, cheats: ['keep'] });
  const migrationKey = 'retro-vault-save-defaults:' + JSON.stringify([1, 'nes', 'Test Game']);
  const later = await environment(playerSource, { localStorage: { [key]: JSON.stringify(saved), [migrationKey]: '1' } });
  assert.equal(JSON.parse(later.window.localStorage.getItem(key)).settings['save-save-interval'], '300');
});

test('state slots persist across player reloads and listing does not read state payloads', async () => {
  const first = await saveEnvironment();
  await first.manager.open();
  await first.manager.run(() => first.manager.saveState(1));
  assert.equal(first.manager.slots.length, 1);
  assert.ok(Date.parse(first.manager.slots[0].savedAt));
  const reads = first.indexedDB.reads.length;
  await first.manager.refresh();
  assert.equal(first.indexedDB.reads.slice(reads).some(item => item.store === 'states'), false);
  const next = await saveEnvironment({ indexedDB: first.indexedDB });
  assert.equal(next.manager.slots.length, 1);
  await next.manager.open();
  const loading = next.manager.run(() => next.manager.loadState(1));
  await waitFor(() => next.manager.confirmation);
  assert.equal(next.calls.loaded.length, 0);
  next.manager.answer(true);
  await loading;
  assert.deepEqual(next.calls.loaded, [[1, 2, 1]]);
  assert.equal(next.emulator.paused, true);
  next.manager.close();
  assert.equal(next.emulator.paused, false);
});

test('slot identity separates games and systems but survives local file timestamp changes', async () => {
  const env = await saveEnvironment();
  const api = env.window.RetroSaveStorage;
  assert.notEqual(api.identity({ id: 1, core: 'nes' }), api.identity({ id: 2, core: 'nes' }));
  assert.notEqual(api.identity({ id: 1, core: 'nes' }), api.identity({ id: 1, core: 'snes' }));
  assert.equal(api.identity({ id: 1000000001, core: 'gba', localFilename: 'game.gba', localSize: 100 }), api.identity({ id: 1000000002, core: 'gba', localFilename: 'game.gba', localSize: 100 }));
  await env.manager.run(() => env.manager.saveState(1));
  const other = await saveEnvironment({ indexedDB: env.indexedDB, games: [{ ...games[0], id: 2 }], search: '?id=2' });
  assert.equal(other.manager.slots.length, 0);
});

test('upgrading preserves legacy slots for export and rejects loading them into the new core version', async () => {
  const legacy = await saveEnvironment({ emulatorVersion: '4.2.3', games: [{ ...games[0], ejsVersion: '4.2.3' }] });
  await legacy.manager.run(() => legacy.manager.saveState(1));
  const updated = await saveEnvironment({ indexedDB: legacy.indexedDB });
  assert.equal(updated.manager.current().emulatorVersion, '4.3.0-pre');
  assert.equal(updated.manager.slots.length, 1);
  assert.equal(updated.manager.slots[0].emulatorVersion, '4.2.3');
  await assert.rejects(updated.manager.loadState(1), { name: 'SaveStateMismatch' });
  assert.equal(updated.calls.loaded.length, 0);
  let exported;
  updated.manager.download = (metadata, data) => { exported = { metadata, data }; };
  await updated.manager.exportSlot(1);
  assert.equal(exported.metadata.emulatorVersion, '4.2.3');
  assert.deepEqual([...new Uint8Array(await exported.data.arrayBuffer())], [1, 2, 1]);
});

test('cancelled overwrites do not allocate another state and quota failures preserve the previous slot', async () => {
  const env = await saveEnvironment();
  await env.manager.run(() => env.manager.saveState(1));
  const before = env.manager.slots[0].savedAt;
  const overwrite = env.manager.run(() => env.manager.saveState(1));
  await waitFor(() => env.manager.confirmation);
  assert.equal(env.calls.states, 1);
  env.manager.answer(false);
  await overwrite;
  assert.equal(env.calls.states, 1);
  assert.equal(env.manager.status.key, 'saveActionCancelled');
  env.indexedDB.failWrite = true;
  const failed = env.manager.run(() => env.manager.saveState(1));
  await waitFor(() => env.manager.confirmation);
  env.manager.answer(true);
  await failed;
  assert.equal(env.manager.status.key, 'saveStorageFull');
  const record = await env.manager.store.get(env.manager.gameKey, 1);
  assert.deepEqual([...new Uint8Array(await record.data.arrayBuffer())], [1, 2, 1]);
  assert.equal(record.metadata.savedAt, before);
});

test('another tab cannot silently replace or delete a slot after confirmation was shown', async () => {
  const env = await saveEnvironment();
  await env.manager.run(() => env.manager.saveState(1));
  const overwrite = env.manager.run(() => env.manager.saveState(1));
  await waitFor(() => env.manager.confirmation);
  await env.manager.store.put(env.manager.metadata(1), new Uint8Array([7]));
  env.manager.answer(true);
  await overwrite;
  assert.equal(env.manager.status.key, 'saveConflict');
  const deleting = env.manager.run(() => env.manager.deleteSlot(1));
  await waitFor(() => env.manager.confirmation);
  await env.manager.store.put(env.manager.metadata(1), new Uint8Array([9]));
  env.manager.answer(true);
  await deleting;
  assert.equal(env.manager.status.key, 'saveConflict');
  const record = await env.manager.store.get(env.manager.gameKey, 1);
  assert.deepEqual([...new Uint8Array(await record.data.arrayBuffer())], [9]);
});

test('backups round trip without base64 and reject other games, versions, and invalid files', async () => {
  const env = await saveEnvironment();
  const api = env.window.RetroSaveStorage;
  const backup = api.makeBackup(env.manager.metadata(1), new Uint8Array([20, 21, 22]));
  const file = new File([backup], 'save.rvstate');
  const parsed = await api.readBackup(file);
  assert.deepEqual([...new Uint8Array(await parsed.data.arrayBuffer())], [20, 21, 22]);
  await env.manager.run(() => env.manager.importFile(2, file));
  assert.equal(env.manager.slots[0].slot, 2);
  const wrongGame = api.makeBackup({ ...env.manager.metadata(1), gameKey: 'another-game' }, new Uint8Array([1]));
  await assert.rejects(env.manager.importFile(3, new File([wrongGame], 'wrong.rvstate')), { name: 'SaveStateMismatch' });
  env.emulator.ejs_version = '4.3.0';
  await assert.rejects(env.manager.loadState(2), { name: 'SaveStateMismatch' });
  env.emulator.ejs_version = '4.3.0-pre';
  await assert.rejects(api.readBackup(new File(['bad'], 'bad.rvstate')), { name: 'InvalidStateBackup' });
  await assert.rejects(api.readBackup(new File([], 'empty.state')), { name: 'InvalidStateSize' });
  const corrupt = new Blob(['RVSTATE1\n', new Uint8Array([255, 255, 255, 255]), 'invalid']);
  await assert.rejects(api.readBackup(new File([corrupt], 'bad.rvstate')), { name: 'InvalidStateBackup' });
});

test('raw imports require confirmation and unsupported cores do not attempt state capture', async () => {
  const env = await saveEnvironment();
  const raw = env.manager.run(() => env.manager.importFile(1, new File([new Uint8Array([4, 5])], 'old.state')));
  await waitFor(() => env.manager.confirmation);
  assert.equal(env.manager.confirmation.key, 'confirmRawState');
  env.manager.answer(true);
  await raw;
  assert.equal(env.manager.slots.length, 1);
  const unsupported = await saveEnvironment({ supportsStates: false });
  await unsupported.manager.open();
  await unsupported.manager.run(() => unsupported.manager.saveState(1));
  assert.equal(unsupported.calls.states, 0);
  assert.equal(unsupported.manager.status.key, 'saveStatesUnsupported');
  assert.equal(unsupported.elements.get('state-support').hidden, false);
});

test('normal save timestamps follow successful filesystem writes, and never capture states automatically', async () => {
  const callbacks = [];
  const env = await saveEnvironment({ syncfs(populate, callback) { callbacks.push(callback); } });
  env.handlers.get('saveSaveFiles')(new Uint8Array([8, 9]));
  assert.equal(env.manager.systemSavedAt, undefined);
  assert.equal(env.calls.states, 0);
  assert.equal(callbacks.length, 0);
  const saving = env.manager.flushSystem();
  callbacks.shift()(null);
  await saving;
  const savedAt = env.manager.systemSavedAt;
  assert.ok(Date.parse(savedAt));
  assert.equal(env.window.localStorage.getItem('retro-vault-system-save:' + env.manager.gameKey), savedAt);
  const failed = env.manager.flushSystem();
  callbacks.shift()(new Error('Write failed'));
  await failed;
  assert.equal(env.manager.systemSavedAt, savedAt);
  assert.equal(env.manager.status.key, 'systemSaveFailed');
  assert.equal(env.calls.states, 0);
  const empty = await saveEnvironment({ noSystemSave: true });
  await empty.manager.run(async () => {
    await empty.manager.flushSystem();
    assert.equal(empty.manager.hasSystemData, false);
  });
  assert.equal(empty.manager.systemSavedAt, undefined);
});

test('shutdown serializes an in-flight flush with the final write before acknowledging', async () => {
  const callbacks = [];
  const env = await saveEnvironment({ syncfs(populate, callback) { callbacks.push(callback); } });
  const saving = env.manager.flushSystem();
  const cleanup = vm.runInContext('shutdownPlayer()', env.context);
  assert.equal(callbacks.length, 1);
  callbacks.shift()(null);
  assert.equal(callbacks.length, 1);
  callbacks.shift()(null);
  await cleanup;
  await saving;
  assert.equal(env.window.EJS_emulator, null);
  assert.equal(env.manager.closing, true);
  assert.equal(JSON.parse(env.window.sessionStorage.getItem('retro-vault-diagnostics')).saveFlush, 'saved');
  assert.equal(env.calls.states, 0);
});

test('the save panel preserves a manual pause, and storage errors still allow a current-state backup', async () => {
  const env = await saveEnvironment({ paused: true });
  await env.manager.open();
  env.manager.close();
  assert.equal(env.emulator.paused, true);
  assert.equal(env.calls.plays, 0);
  env.manager.store = new env.window.RetroSaveStorage.SaveStorage(null);
  await env.manager.open();
  assert.equal(env.manager.status.key, 'saveStorageUnavailable');
  env.elements.get('save-current-backup').dispatch('click');
  await waitFor(() => !env.manager.busy);
  assert.equal(env.manager.status.key, 'backupReady');
  assert.equal(env.calls.states, 1);
});

test('startup waits for a tap in the player and records the native start phases', async () => {
  const env = await environment(playerSource);
  assert.equal(env.window.EJS_startOnLoaded, false);
  const events = new Map();
  env.window.EJS_emulator = { on: (name, callback) => events.set(name, callback) };
  env.window.EJS_ready();
  assert.equal(env.elements.get('player-message').classList.contains('hidden'), true);
  assert.equal(JSON.parse(env.window.sessionStorage.getItem('retro-vault-diagnostics')).phase, 'waiting-for-start');
  events.get('start-clicked')();
  assert.equal(JSON.parse(env.window.sessionStorage.getItem('retro-vault-diagnostics')).phase, 'loading-core');
  env.window.EJS_onGameStart();
  assert.equal(JSON.parse(env.window.sessionStorage.getItem('retro-vault-diagnostics')).phase, 'running');
});

test('permission errors retain their name, bounded stack, location, and environment without being suppressed', async () => {
  const env = await environment(playerSource, { browserLanguage: 'ja' });
  env.window.navigator.userActivation = { isActive: false, hasBeenActive: true };
  env.document.visibilityState = 'visible';
  env.window.EJS_emulator = { Module: { AL: { currentCtx: { audioCtx: { state: 'suspended' } } } } };
  const reason = Object.assign(new Error('Permission was denied.'), { name: 'NotAllowedError', stack: 'failedCall@core.js:10:2\n' + 'x'.repeat(5000) });
  env.window.dispatch('error', { error: reason, message: reason.message, filename: 'https://cdn.example/core.js', lineno: 10, colno: 2 });
  const log = JSON.parse(env.window.sessionStorage.getItem('retro-vault-diagnostics'));
  const failure = log.errors.at(-1);
  assert.equal(failure.name, 'NotAllowedError');
  assert.equal(failure.source, 'https://cdn.example/core.js');
  assert.equal(failure.line, 10);
  assert.equal(failure.column, 2);
  assert.equal(failure.stack.length, 1600);
  assert.deepEqual(failure.environment.audioStates, ['suspended']);
  assert.equal(failure.environment.userActivation.hasBeenActive, true);
  assert.match(env.elements.get('player-message').textContent, /権限/);
  assert.match(env.posts.at(-1).message, /Permission was denied/);
  env.window.dispatch('unhandledrejection', { reason });
  assert.equal(JSON.parse(env.window.sessionStorage.getItem('retro-vault-diagnostics')).errors.at(-1).source, 'unhandledrejection');
});

test('internally handled exceptions are captured without changing console output and hooks restore on close', async () => {
  const calls = [];
  const originalWarn = (...args) => { calls.push(args); return 'forwarded'; };
  const originalError = (...args) => { calls.push(args); };
  const logger = { warn: originalWarn, error: originalError, log() {}, debug() {} };
  const env = await environment(playerSource, { console: logger });
  const reason = Object.assign(new Error('Permission was denied.'), { name: 'NotAllowedError', stack: 'runtime.js\n' + 'x'.repeat(4000) });
  for (let index = 0; index < 5; index += 1) {
    assert.equal(logger.warn('Failed to start game', reason), 'forwarded');
  }
  const log = JSON.parse(env.window.sessionStorage.getItem('retro-vault-diagnostics'));
  assert.equal(calls.length, 5);
  assert.equal(calls[0][1], reason);
  assert.equal(log.runtimeLog.length, 3);
  assert.equal(log.runtimeLog.at(-1).name, 'NotAllowedError');
  assert.equal(log.runtimeLog.at(-1).stack.length, 1000);
  assert.equal(log.runtimeLog.at(-1).source, 'console.warn');
  logger.warn('An unrelated notice');
  assert.equal(JSON.parse(env.window.sessionStorage.getItem('retro-vault-diagnostics')).runtimeLog.length, 3);
  await vm.runInContext('shutdownPlayer()', env.context);
  assert.equal(logger.warn, originalWarn);
  assert.equal(logger.error, originalError);
});

test('expanded diagnostics remain bounded and downloadable through the launcher after failure', async () => {
  const sessionStorage = storage();
  const logger = { warn() {}, error() {}, log() {}, debug() {} };
  const env = await environment(playerSource, { sessionStorage, console: logger });
  for (let index = 0; index < 8; index += 1) {
    const reason = Object.assign(new Error('Permission was denied. ' + index + 'x'.repeat(10000)), { name: 'NotAllowedError', stack: 'core.js\n' + 'x'.repeat(20000) });
    env.window.dispatch('error', { error: reason, message: reason.message, filename: 'https://example.com/' + 'x'.repeat(2000), lineno: index });
  }
  const raw = sessionStorage.getItem('retro-vault-diagnostics');
  assert.ok(raw.length < 32000);
  const log = JSON.parse(raw);
  assert.equal(log.errors.length, 4);
  assert.equal(log.runtimeLog.length, 3);
  assert.ok(log.errors.every(item => item.detail.length <= 1200 && item.stack.length <= 1600 && item.source.length <= 250));
  const app = await environment(appSource, { sessionStorage });
  assert.equal(app.elements.get('diagnostics-download').hidden, false);
  assert.equal(vm.runInContext('readDiagnostics().startMode', app.context), 'tap-in-player');
  await vm.runInContext('shutdownPlayer()', env.context);
});

test('the save entry stays out of the game canvas and appears only in the fullscreen controls menu', async () => {
  const env = await saveEnvironment();
  const toggle = env.elements.get('save-manager-toggle');
  assert.equal(toggle.hidden, true);
  assert.equal(env.emulator.elements.menu.contains(toggle), true);
  assert.equal(env.elements.get('save-root').contains(toggle), false);
  env.document.fullscreenElement = env.emulator.elements.parent;
  env.document.dispatch('fullscreenchange');
  assert.equal(toggle.hidden, false);
  let closedMenu = 0;
  env.emulator.menu = { close() { closedMenu += 1; } };
  toggle.dispatch('click');
  assert.equal(closedMenu, 1);
  assert.equal(env.manager.opened, true);
  env.manager.close();
  env.document.fullscreenElement = null;
  env.document.dispatch('fullscreenchange');
  assert.equal(toggle.hidden, true);
  env.document.webkitFullscreenElement = env.emulator.elements.parent;
  env.document.dispatch('webkitfullscreenchange');
  assert.equal(toggle.hidden, false);
  env.manager.stop();
  assert.equal(toggle.hidden, true);
  assert.equal(env.document.handlers.get('fullscreenchange').length, 0);
  assert.equal(env.document.handlers.get('webkitfullscreenchange').length, 0);
});

test('native save events add no forced filesystem writes or hidden slot renders', async () => {
  let syncs = 0;
  const env = await saveEnvironment({ syncfs(populate, callback) { syncs += 1; callback(null); } });
  let slotRenders = 0;
  const slots = env.elements.get('save-slots');
  const replace = slots.replaceChildren.bind(slots);
  slots.replaceChildren = (...items) => { slotRenders += 1; return replace(...items); };
  for (let index = 0; index < 20; index += 1) env.handlers.get('saveSaveFiles')(new Uint8Array([8, 9]));
  env.manager.render();
  assert.equal(syncs, 0);
  assert.equal(slotRenders, 0);
  assert.equal(env.calls.states, 0);
  assert.equal(env.manager.systemSavedAt, undefined);
  const log = JSON.parse(env.window.sessionStorage.getItem('retro-vault-diagnostics'));
  assert.equal(log.nativeSaveEvents, 20);
  assert.equal(log.activities.length, 8);
  assert.ok(log.activities.every(item => item.action === 'native-save-event' && typeof item.hasSystemData === 'boolean'));
  await env.manager.open();
  assert.equal(slotRenders > 0, true);
});

test('diagnostics distinguish time spent loading from elapsed time after the game starts', async () => {
  const env = await environment(playerSource);
  assert.equal(JSON.parse(env.window.sessionStorage.getItem('retro-vault-diagnostics')).gameElapsedSeconds, null);
  env.window.EJS_onGameStart();
  vm.runInContext('diagnostics.gameStartedAtMs = Date.now() - 42000; sampleDiagnostics()', env.context);
  const log = JSON.parse(env.window.sessionStorage.getItem('retro-vault-diagnostics'));
  assert.equal(log.gameElapsedSeconds, 42);
  const sessionStorage = storage({
    'retro-vault-active-game': 'Test Game',
    'retro-vault-diagnostics': JSON.stringify(log)
  });
  const app = await environment(appSource, { sessionStorage });
  assert.match(app.elements.get('notice').textContent, /42 seconds/);
  const mismatch = await environment(appSource, { sessionStorage: storage({
    'retro-vault-active-game': 'Another Game',
    'retro-vault-diagnostics': JSON.stringify(log)
  }) });
  assert.doesNotMatch(mismatch.elements.get('notice').textContent, /42 seconds/);
});

test('localized game titles fall back to either title and searches, filter counts, and ROM totals remain consistent', async () => {
  const catalog = [
    { id: 1, title: 'First', titleEn: 'First', titleJa: '最初', core: 'nes', rom: 'one.nes', romSize: 40976 },
    { id: 2, title: '日本語だけ', titleJa: '日本語だけ', core: 'snes', rom: 'two.sfc', romSize: 1048576 },
    { id: 3, title: 'English Only', titleEn: 'English Only', core: 'snes9x', system: 'snes', rom: 'three.sfc', romSize: 1048576 },
    { id: 4, title: 'Legacy', core: 'gba', rom: 'four.gba', romSize: 1024 }
  ];
  const env = await environment(appSource, { games: catalog, browserLanguage: 'ja-JP' });
  const api = env.window.RetroI18n;
  assert.equal(api.gameTitle(catalog[0]), '最初');
  assert.equal(api.gameTitle(catalog[2]), 'English Only');
  assert.equal(api.gameTitle(catalog[3]), 'Legacy');
  const labels = env.elements.get('core-filters').children.map(element => element.textContent);
  assert.ok(labels.includes('すべて (4)'));
  assert.ok(labels.some(label => label.includes('スーパーファミコン') && label.endsWith('(2)')));
  vm.runInContext('state.activeCore = canonicalFilterKey("snes"); renderGrid()', env.context);
  assert.equal(env.elements.get('stats').textContent, '4件中2件（2.0 MiB）');
  vm.runInContext('state.activeCore = "all"; state.activeSearch = "first"; renderGrid()', env.context);
  assert.equal(env.elements.get('stats').textContent, '4件中1件（40.0 KiB）');
  vm.runInContext('openGame(state.games[0])', env.context);
  const source = env.elements.get('emulator-frame').src;
  assert.equal(env.elements.get('modal-title').textContent, '最初');
  api.setLanguage('en');
  assert.equal(api.gameTitle(catalog[1]), '日本語だけ');
  assert.equal(env.elements.get('modal-title').textContent, 'First');
  assert.equal(env.elements.get('emulator-frame').src, source);
  vm.runInContext('state.activeSearch = "最初"; renderGrid()', env.context);
  assert.equal(vm.runInContext('getFilteredGames().length', env.context), 1);
  vm.runInContext('state.activeSearch = "missing"; renderGrid()', env.context);
  assert.equal(env.elements.get('stats').textContent, '0 of 4 games (0 B)');
});

test('library 3DS uses the range adapter and diagnostics follow actual startup methods', async () => {
  const game = { ...games[0], core: '3ds', rom: 'rom/test/library.3ds', saveName: 'stable-save' };
  const env = await environment(playerSource, { games: [game], search: '?id=1&threads=1' });
  let source; const forwarded = [];
  env.window.RetroLazyRom = { install(emulator, url) { source = url; return { stats: { mode: 'lazy-range', state: 'ready', size: 4294967296 }, stop() {} }; } };
  const emulator = { initModule(...args) { forwarded.push(args); return 17; }, downloadFiles() { return 18; }, startGame() { return 19; }, download(url, type) { return { url, type }; } };
  env.window.EJS_emulator = emulator; env.window.EJS_ready();
  assert.equal(source, env.window.EJS_gameUrl); assert.match(source,/\/data\/roms\//);
  assert.equal(env.window.EJS_gameName, 'stable-save');
  const log = () => JSON.parse(env.window.sessionStorage.getItem('retro-vault-diagnostics'));
  assert.equal(emulator.initModule('wasm'),17);assert.equal(log().phase,'initializing-core');assert.deepEqual(forwarded,[['wasm']]);
  assert.equal(emulator.downloadFiles(),18);assert.equal(log().phase,'preparing-files');
  assert.equal(emulator.download(source,{name:'ROM'}).url,source);assert.equal(log().phase,'loading-rom');
  assert.equal(emulator.startGame(),19);assert.equal(log().phase,'starting-game');
  assert.equal(log().romIO.mode,'lazy-range');
});

test('unsupported 3DS adapters block native uppercase ROM downloads without blocking other files', async () => {
  const game = { ...games[0], core: '3ds', rom: 'rom/test/library.3ds' };
  const env = await environment(playerSource, { games: [game], search: '?id=1&threads=1' });
  env.window.RetroLazyRom = { install() { throw new Error('lazyRomUnavailable'); } };
  const forwarded = [];
  const emulator = { download(url, type) { forwarded.push({ url, type }); return 'native'; } };
  env.window.EJS_emulator = emulator; env.window.EJS_ready();
  await assert.rejects(emulator.download(env.window.EJS_gameUrl, { name: 'ROM' }), /lazyRomUnavailable/);
  assert.equal(forwarded.length, 0);
  assert.equal(emulator.download('/bios/test.bin', { name: 'BIOS' }), 'native');
  assert.equal(forwarded.length, 1);
});


test('native quick saves and all nine panel slots share durable data across restart', async () => {
  const first = await saveEnvironment();
  assert.equal(first.emulator.gameManager.quickSave('9'), true);
  await first.manager.nativePending;
  assert.equal(first.manager.slots[0].slot, 9);
  const reload = await saveEnvironment({ indexedDB: first.indexedDB });
  reload.emulator.gameManager.quickLoad('9');
  await reload.manager.nativePending;
  assert.deepEqual(reload.calls.loaded, [[1, 2, 1]]);
  await reload.manager.run(() => reload.manager.saveState(8));
  assert.equal(reload.emulator.settings['save-state-slot'], '8');
  reload.emulator.gameManager.quickLoad('8'); await reload.manager.nativePending;
  assert.deepEqual(reload.calls.loaded.at(-1), [1, 2, 1]);
  await reload.manager.open();
  assert.equal(reload.elements.get('save-slots').children.length, 9);
  reload.manager.selectSlot(7);
  assert.equal(reload.emulator.getSettingValue('save-state-slot'), '7');
});

test('native toolbar state actions share slots, and queued snapshots survive rapid saves', async () => {
  const env = await saveEnvironment();
  env.manager.selectSlot(4);
  env.handlers.get('saveState')({ state: new Uint8Array([4, 8]) });
  env.emulator.gameManager.quickSave('5');
  env.emulator.gameManager.quickSave('5');
  await env.manager.nativePending;
  const toolbarState = await env.manager.store.get(env.manager.gameKey, 4);
  assert.deepEqual([...new Uint8Array(await toolbarState.data.arrayBuffer())], [4, 8]);
  env.handlers.get('loadState')(); await env.manager.nativePending;
  assert.deepEqual(env.calls.loaded, [[4, 8]]);
  env.emulator.gameManager.quickLoad('5'); await env.manager.nativePending;
  assert.deepEqual(env.calls.loaded.at(-1), [1, 2, 2]);
});

test('native slot failures preserve durable saves and incompatible states never load', async () => {
  const env = await saveEnvironment();
  env.emulator.gameManager.quickSave(1); await env.manager.nativePending;
  env.indexedDB.failWrite = true;
  env.emulator.gameManager.quickSave(1);
  await assert.rejects(env.manager.nativePending, { name: 'QuotaExceededError' });
  env.emulator.gameManager.quickLoad(1); await env.manager.nativePending;
  assert.deepEqual(env.calls.loaded, [[1, 2, 1]]);
  env.emulator.ejs_version = 'other';
  env.emulator.gameManager.quickLoad(1);
  await assert.rejects(env.manager.nativePending, { name: 'SaveStateMismatch' });
  assert.equal(env.calls.loaded.length, 1);
  env.emulator.ejs_version = '4.3.0-pre';
  const deleting = env.manager.run(() => env.manager.deleteSlot(1));
  await waitFor(() => env.manager.confirmation); env.manager.answer(true); await deleting;
  env.emulator.gameManager.quickLoad(1); await env.manager.nativePending;
  assert.equal(env.calls.loaded.length, 1);
});

test('close waits for queued native state persistence and restores native methods', async () => {
  const env = await saveEnvironment();
  const bridged = env.emulator.gameManager.quickSave;
  env.emulator.gameManager.quickSave(6);
  await vm.runInContext('shutdownPlayer()', env.context);
  const saved = await env.manager.store.get(env.manager.gameKey, 6);
  assert.deepEqual([...new Uint8Array(await saved.data.arrayBuffer())], [1, 2, 1]);
  assert.notEqual(env.emulator.gameManager.quickSave, bridged);
  assert.equal(env.window.EJS_emulator, null);
  assert.throws(() => env.manager.store.get(env.manager.gameKey, 10), { name: 'InvalidSaveSlot' });
});


test('pinned DS runtime routes canvas touch separately from virtual controls and restores on close', async () => {
  const env = await environment(playerSource);
  const host = env.document.createElement('div');
  const canvas = env.document.createElement('canvas');
  const emulator = { started: true, ejs_version: '4.3.0-pre', getCore: () => 'melonds', canvas, elements: { parent: host } };
  const support = new env.window.RetroRuntimeSupport({ contexts: () => [], onChange() {} });
  support.attach(emulator); support.attach(emulator);
  assert.equal(host.classList.contains('rv-ds-touch'), true);
  env.document.dispatch('touchstart', { target: canvas, type: 'touchstart' });
  env.document.dispatch('pointerdown', { target: canvas, type: 'pointerdown' });
  const snapshot = support.snapshot();
  assert.equal(snapshot.canvasTouchEvents, 1); assert.equal(snapshot.canvasPointerEvents, 1);
  assert.equal(snapshot.dsTouchRouting, 'canvas-and-controls');
  support.stop(); assert.equal(host.classList.contains('rv-ds-touch'), false);
});

test('DS routing leaves other systems and explicit older runtimes unchanged', async () => {
  const env = await environment(playerSource);
  for (const [core, version] of [['fceumm','4.3.0-pre'], ['melonds','4.2.3']]) {
    const host = env.document.createElement('div');
    const support = new env.window.RetroRuntimeSupport({ contexts: () => [] });
    support.attach({ getCore: () => core, ejs_version: version, elements: { parent: host } });
    assert.equal(host.classList.contains('rv-ds-touch'), false); support.stop();
  }
});

test('DS startup migrates relative Mouse mode once without touching saves, controls or cheats', async () => {
  const game = { id: 9, title: 'Pearl', saveName: 'Stable save identity', core: 'nds', rom: 'Pearl.nds' };
  const key = 'ejs-9-nds-Stable save identity-settings';
  const original = { settings: { melonds_touch_mode: 'Mouse', volume: '0.5' }, controlSettings: { 0: { 8: 'KeyX' } }, cheats: [{ code: 'test' }] };
  const env = await environment(playerSource, { games: [game], search: '?id=9', localStorage: { [key]: JSON.stringify(original), 'unrelated-save': 'preserve' } });
  assert.equal(env.window.EJS_defaultOptions.melonds_touch_mode, 'Touch');
  const saved = JSON.parse(env.window.localStorage.getItem(key));
  assert.equal(saved.settings.melonds_touch_mode, 'Touch');
  assert.deepEqual(saved.controlSettings, original.controlSettings);
  assert.deepEqual(saved.cheats, original.cheats);
  assert.equal(saved.settings.volume, '0.5');
  assert.equal(env.window.localStorage.getItem('unrelated-save'), 'preserve');
  // A deliberate later selection must survive the next startup.
  saved.settings.melonds_touch_mode = 'Mouse';
  env.window.localStorage.setItem(key, JSON.stringify(saved));
  vm.runInContext('configureDsTouchMode({id:9,title:"Pearl",saveName:"Stable save identity",core:"nds"},"nds","4.3.0-pre")', env.context);
  assert.equal(JSON.parse(env.window.localStorage.getItem(key)).settings.melonds_touch_mode, 'Mouse');
});

test('DS absolute touch defaults support fresh games and preserve explicit alternative controls', async () => {
  for (const mode of [undefined, 'Touch', 'Joystick', 'disabled']) {
    const game = { id: 9, title: 'Pearl', core: 'nds', rom: 'Pearl.nds' };
    const key = 'ejs-9-nds-Pearl-settings';
    const seed = mode === undefined ? {} : { [key]: JSON.stringify({ settings: { melonds_touch_mode: mode } }) };
    const env = await environment(playerSource, { games: [game], search: '?id=9', localStorage: seed });
    assert.equal(env.window.EJS_defaultOptions.melonds_touch_mode, 'Touch');
    if (mode !== undefined) assert.equal(JSON.parse(env.window.localStorage.getItem(key)).settings.melonds_touch_mode, mode);
  }
  for (const options of [{ core: 'nes' }, { core: 'nds', coreOverride: 'desmume' }, { core: 'nds', ejsVersion: '4.2.3' }]) {
    const env = await environment(playerSource, { games: [{ id: 1, title: 'Test Game', rom: 'test.rom', ...options }] });
    assert.equal(env.window.EJS_defaultOptions.melonds_touch_mode, undefined);
  }
});

test('DS mode diagnostics retain the last active setting after close without input coordinates', async () => {
  const env = await environment(playerSource);
  const support = new env.window.RetroRuntimeSupport({ contexts: () => [] });
  const emulator = { ejs_version: '4.3.0-pre', getCore: () => 'melonds', settings: { melonds_touch_mode: 'Mouse' } };
  support.attach(emulator);
  assert.equal(support.snapshot().dsTouchMode, 'Mouse');
  emulator.settings.melonds_touch_mode = 'Touch';
  support.stop();
  assert.equal(support.snapshot().dsTouchMode, 'Touch');
  assert.doesNotMatch(JSON.stringify(support.snapshot()), /clientX|clientY|touch_x|touch_y/);
});
