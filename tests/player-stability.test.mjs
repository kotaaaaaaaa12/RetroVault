import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';

const appSource = await readFile(new URL('../assets/js/app.js', import.meta.url), 'utf8');
const playerSource = await readFile(new URL('../assets/js/player.js', import.meta.url), 'utf8');
const i18nSource = await readFile(new URL('../assets/js/i18n.js', import.meta.url), 'utf8');
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
  contains(child) { return this.children.includes(child); }
  get childNodes() { return this.children; }
  setAttribute(key, value) { this.attributes.set(key, value); }
  getAttribute(key) { return this.attributes.get(key) ?? null; }
  querySelectorAll() { return []; }
  focus() {}
  blur() {}
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
  document.getElementById = id => {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id);
  };
  document.createElement = () => new Element();
  document.createDocumentFragment = () => new Element();
  document.querySelector = () => options.coreError || null;
  const window = new Element();
  window.localStorage = storage(options.localStorage);
  window.sessionStorage = options.sessionStorage || storage();
  window.crossOriginIsolated = options.isolated !== false;
  window.SharedArrayBuffer = SharedArrayBuffer;
  window.navigator = { language: options.browserLanguage || 'en-US', languages: [options.browserLanguage || 'en-US'] };
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
    window, document, URL, URLSearchParams, Blob, File, console,
    setTimeout: (callback, delay) => schedule(callback, delay),
    setInterval: (callback, delay) => schedule(callback, delay, true),
    clearTimeout: id => timers.delete(id),
    clearInterval: id => timers.delete(id),
    fetch: async () => ({ ok: true, json: async () => structuredClone(options.games || games) }),
    MutationObserver: class { constructor(callback) { observers.push(callback); } observe() {} disconnect() { this.disconnected = true; } }
  });
  vm.runInContext(i18nSource, context);
  vm.runInContext(source, context);
  await new Promise(resolve => setImmediate(resolve));
  return { context, window, document, elements, posts, observers, timers };
}

test('launcher has no threading UI and its inline scripts compile', () => {
  assert.doesNotMatch(html, /threads-toggle|threads-status|thread-control|THREADS/);
  for (const [, source] of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) new vm.Script(source);
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
  assert.equal(standard.window.EJS_pathtodata, 'https://cdn.emulatorjs.org/4.2.3/data/');
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
  assert.equal(env.elements.get('stats').textContent, '1件中1件');
  assert.equal(vm.runInContext('coreLabel("nes")', env.context), 'ファミコン／NES');
  env.window.RetroI18n.setLanguage('en');
  assert.equal(env.elements.get('stats').textContent, '1 / 1 GAMES');
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
  const source = appSource + playerSource + html + playerHtml + changelogHtml;
  const keys = new Set([
    ...[...source.matchAll(/(?:\bt|setNotice|reportPlayerError|playerError|showMessage)\("([a-zA-Z]+)"/g)].map(match => match[1]),
    ...[...source.matchAll(/data-i18n(?:-[a-z-]+)?="([a-zA-Z]+)"/g)].map(match => match[1]),
    'ambiguousExtension', 'unknownExtension', 'runtimeError'
  ]);
  for (const locale of ['en', 'ja']) {
    env.window.RetroI18n.setLanguage(locale);
    for (const key of keys) assert.notEqual(env.window.RetroI18n.t(key), key, `${locale}: ${key}`);
  }
});

test('the player uses the correct Japanese EmulatorJS locale and a bundled complete dictionary', async () => {
  const env = await environment(playerSource, { browserLanguage: 'en-US', search: '?id=1&lang=ja' });
  assert.equal(env.window.RetroI18n.language, 'ja');
  assert.equal(env.window.EJS_language, 'ja-JA');
  assert.equal(env.window.EJS_disableAutoLang, false);
  assert.equal(env.window.EJS_threads, false);
  const dictionary = await (await fetch(env.window.EJS_paths['ja-JA'])).json();
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
  assert.equal(emulator.config.language, 'ja-JA');
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
  assert.match(html, /<a href="https:\/\/emulatorjs\.org\/" target="_blank" rel="noopener noreferrer">EMULATORJS<\/a>/);
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
