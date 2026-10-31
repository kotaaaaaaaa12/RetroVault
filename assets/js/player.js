"use strict";

const I18n = window.RetroI18n;
const t = (key, values) => I18n.t(key, values);
const requestedLanguage = new URLSearchParams(window.location.search).get("lang");
if (["en", "ja"].includes(requestedLanguage)) I18n.setLanguage(requestedLanguage, false);
const threeDsTest = window.Retro3DSDiagnostics?.configuration(window.location) || null;
const threeDsMonitor = threeDsTest ? new window.Retro3DSDiagnostics(threeDsTest) : null;

const DEFAULT_EJS_VERSION = "4.3.0-pre";
const DEFAULT_EJS_DATA_PATH = `https://cdn.emulatorjs.org/${DEFAULT_EJS_VERSION}/data/`;

const THREADS_REQUIRED_CORES = new Set([
  "psp",
  "ppsspp",
  "dos",
  "dosbox_pure",
  "3ds",
  "azahar"
]);

const CORE_ALIASES = Object.freeze({
  gbc: "gb",
  mame: "mame2003"
});

const message = document.getElementById("player-message");
let resourceDiagnostics = null;
let lazyRom = null;
let localPreparation = null;
const localPreparationController = new AbortController();
let emulatorStarted = false;
let playerClosing = false;
let displayedMessage = null;
let localeObjectUrl = "";
let diagnosticTimer = null;
let diagnostics = null;
let cleanupPromise = null;
let lastReportedError = "";
let pausedForVisibility = false;
let saveManager = null;
let restoreConsoleDiagnostics = null;
let restoreAudioContextTracking = null;
let legacyLanguageLoader = false;
let runtimeSupport = null;
let threeDsStartupPolicy = null;
let restoreThreeDsCoreSettings = null;
const ownedAudioContexts = new Set();

function renderRomPreparation(stats) {
  const panel = document.getElementById('rom-disk-preparation');
  if (!panel) return;
  const preparing = !playerClosing && stats?.disk?.state === 'downloading';
  panel.hidden = !preparing;
  if (!preparing) return;
  const { completed, total } = stats.disk;
  document.getElementById('rom-disk-meter').value = total ? completed / total * 100 : 0;
  document.getElementById('rom-disk-count').textContent = `${I18n.formatBytes(completed)} / ${I18n.formatBytes(total)}`;
}

function installAudioContextTracking() {
  // RWebAudio keeps its context private. Track contexts created in this iframe.
  const hooks = [];
  const proxies = new Map();
  for (const key of ["AudioContext", "webkitAudioContext"]) {
    const original = window[key];
    if (typeof original !== "function") continue;
    const wrapped = proxies.get(original) || new Proxy(original, {
      construct(target, args, newTarget) {
        const context = Reflect.construct(target, args, newTarget);
        if (ownedAudioContexts.size < 16) {
          ownedAudioContexts.add(context);
          runtimeSupport?.trackContext(context);
        }
        return context;
      }
    });
    proxies.set(original, wrapped);
    try {
      window[key] = wrapped;
      if (window[key] === wrapped) hooks.push({ key, original, wrapped });
    } catch {}
  }
  restoreAudioContextTracking = () => {
    for (const { key, original, wrapped } of hooks) {
      try { if (window[key] === wrapped) window[key] = original; } catch {}
    }
    restoreAudioContextTracking = null;
  };
}

function existingAudioContexts(module = window.EJS_emulator?.Module) {
  const contexts = new Set(ownedAudioContexts);
  const audio = module?.AL;
  if (audio?.currentCtx?.audioCtx) contexts.add(audio.currentCtx.audioCtx);
  for (const entry of Object.values(audio?.contexts || {})) {
    if (entry?.audioCtx) contexts.add(entry.audioCtx);
  }
  return contexts;
}

function errorContext(reason, source = "", event = {}) {
  const context = { source: String(source || event.filename || "").slice(0, 250) };
  try {
    context.name = String(reason?.name || "").slice(0, 80);
    context.stack = String(reason?.stack || "").slice(0, 1600);
    if (Number.isFinite(reason?.code)) context.code = reason.code;
  } catch {}
  if (Number.isFinite(event.lineno)) context.line = event.lineno;
  if (Number.isFinite(event.colno)) context.column = event.colno;
  return context;
}

function diagnosticEnvironment() {
  const environment = {
    secureContext: window.isSecureContext === true,
    crossOriginIsolated: window.crossOriginIsolated === true,
    visibility: document.visibilityState || (document.hidden ? "hidden" : "visible"),
    framed: window.parent !== window,
    userActivation: {
      isActive: window.navigator?.userActivation?.isActive === true,
      hasBeenActive: window.navigator?.userActivation?.hasBeenActive === true
    },
    audioStates: []
  };
  const contexts = existingAudioContexts();
  for (const context of [...contexts].slice(0, 4)) environment.audioStates.push(String(context.state || "unknown").slice(0, 40));
  try {
    const policy = document.permissionsPolicy || document.featurePolicy;
    if (policy?.features && policy?.allowsFeature) {
      const features = new Set(policy.features());
      environment.permissionsPolicy = {};
      for (const feature of ["autoplay", "fullscreen", "gamepad", "microphone", "screen-wake-lock"]) {
        environment.permissionsPolicy[feature] = features.has(feature) ? policy.allowsFeature(feature) : null;
      }
    }
  } catch {}
  return environment;
}

function installConsoleDiagnostics() {
  if (restoreConsoleDiagnostics || !window.console) return;
  const hooks = [];
  for (const level of ["warn", "error"]) {
    const original = window.console[level];
    if (typeof original !== "function") continue;
    const wrapped = function(...args) {
      try {
        const inputs = args.slice(0, 6);
        const error = inputs.find(value => value && typeof value === "object" && typeof value.message === "string");
        const detail = inputs.filter(value => typeof value === "string").map(value => value.slice(0, 250)).join(" ").slice(0, 750);
        if (diagnostics && (error || /permission|denied|notallowed|failed to start|webgl|abort/i.test(detail))) {
          const context = errorContext(error, "console." + level);
          const item = { at: new Date().toISOString(), ...context, stack: context.stack.slice(0, 1000), detail: String(error?.message || detail).slice(0, 750), environment: diagnosticEnvironment() };
          diagnostics.runtimeLog = [...(diagnostics.runtimeLog || []), item].slice(-3);
          diagnostics.environment = diagnosticEnvironment();
          persistDiagnostics();
        }
      } catch {}
      return original.apply(this, args);
    };
    try { window.console[level] = wrapped; hooks.push({ level, original, wrapped }); } catch {}
  }
  restoreConsoleDiagnostics = () => {
    for (const { level, original, wrapped } of hooks) {
      try { if (window.console[level] === wrapped) window.console[level] = original; } catch {}
    }
    restoreConsoleDiagnostics = null;
  };
}

function persistDiagnostics() {
  if (!diagnostics) return;
  try {
    window.sessionStorage.setItem(threeDsTest ? window.Retro3DSDiagnostics.storageKey : "retro-vault-diagnostics", JSON.stringify(diagnostics));
  } catch {
    // Restricted storage must not prevent a game from running.
  }
}

function sampleDiagnostics(phase) {
  if (!diagnostics) return;
  const module = window.EJS_emulator?.Module;
  const bytes = module?.HEAPU8?.byteLength ?? module?.HEAP8?.byteLength;
  if (Number.isFinite(bytes) && bytes > 0) {
    if (bytes !== diagnostics.wasmHeapBytes) diagnostics.heapSamples = [...(diagnostics.heapSamples || []), { elapsedMs: Date.now() - diagnostics.startedAtMs, bytes }].slice(-8);
    if (diagnostics.wasmHeapBytes !== null && bytes > diagnostics.wasmHeapBytes) diagnostics.heapGrowthEvents += 1;
    diagnostics.wasmHeapBytes = bytes;
    diagnostics.peakWasmHeapBytes = Math.max(diagnostics.peakWasmHeapBytes || 0, bytes);
  }
  if (phase) diagnostics.phase = phase;
  diagnostics.lastSampleAt = new Date().toISOString();
  diagnostics.elapsedSeconds = Math.round((Date.now() - diagnostics.startedAtMs) / 1000);
  diagnostics.gameElapsedSeconds = diagnostics.gameStartedAtMs === null ? null
    : Math.max(0, Math.round((Date.now() - diagnostics.gameStartedAtMs) / 1000));
  diagnostics.environment = diagnosticEnvironment();
  if (runtimeSupport) {
    diagnostics.input = runtimeSupport.snapshot();
    diagnostics.operationFailures = runtimeSupport.failures;
    const native = runtimeSupport.nativeSnapshot();
    if (native) {
      diagnostics.coreStartup = native.startup;
      diagnostics.coreLog = native.log;
      diagnostics.coreIssues = native.issues;
    }
  }
  if (lazyRom) diagnostics.romIO = { ...lazyRom.stats };
  if (resourceDiagnostics) {
    diagnostics.requests = resourceDiagnostics.requests;
    if (resourceDiagnostics.localRom) diagnostics.localRom = lazyRom ? { ...resourceDiagnostics.localRom, source: 'lazy-file', readState: lazyRom.stats.state, readAttempts: lazyRom.stats.reads } : resourceDiagnostics.localRom;
  }
  const emulator = window.EJS_emulator;
  if (typeof emulator?.ejs_version === "string") diagnostics.runtimeVersion = emulator.ejs_version.slice(0, 80);
  if (emulator?.started) {
    diagnostics.fastForward = emulator.isFastForward === true;
    diagnostics.slowMotion = emulator.isSlowMotion === true;
  }
  threeDsMonitor?.observe(diagnostics, emulator, phase);
  persistDiagnostics();
}

function recordActivity(action, detail = {}) {
  if (!diagnostics) return;
  const activity = { at: new Date().toISOString(), action: String(action).slice(0, 80) };
  if (typeof detail.hasSystemData === "boolean") activity.hasSystemData = detail.hasSystemData;
  if (typeof detail.result === "string") activity.result = detail.result.slice(0, 40);
  if (diagnostics.gameStartedAtMs !== null) activity.gameElapsedSeconds = Math.max(0, Math.round((Date.now() - diagnostics.gameStartedAtMs) / 1000));
  if (action === "native-save-event") diagnostics.nativeSaveEvents += 1;
  diagnostics.activities = [...diagnostics.activities, activity].slice(-8);
  sampleDiagnostics();
}

function beginDiagnostics(game, threads, version = game.ejsVersion || DEFAULT_EJS_VERSION) {
  diagnostics = {
    schemaVersion: 1,
    appVersion: "2.18.0",
    emulatorVersion: version,
    dataPath: resolveDataPath(game),
    game: { id: game.id, title: game.title, core: game.core },
    userAgent: String(window.navigator?.userAgent || "").slice(0, 500),
    threads,
    phase: "loading",
    startedAtMs: Date.now(),
    gameStartedAtMs: null,
    gameElapsedSeconds: null,
    nativeSaveEvents: 0,
    activities: [],
    wasmHeapBytes: null,
    peakWasmHeapBytes: null,
    heapGrowthEvents: 0,
    errors: [],
    runtimeLog: [],
    localPreparation,
    ...(threeDsStartupPolicy ? { threeDsStartupPolicy } : {}),
    startMode: "tap-in-player",
    memoryScope: "Core WebAssembly linear memory only; excludes browser, JavaScript, audio, and GPU memory."
  };
  sampleDiagnostics();
  installConsoleDiagnostics();
  diagnosticTimer = setInterval(() => sampleDiagnostics(), threeDsTest ? 2000 : 10000);
}

function reportPlayerError(key, values = {}, context = {}) {
  if (playerClosing) return;
  if (key === "emulatorStopped" && displayedMessage?.isError) return;
  const signature = key + JSON.stringify(values) + String(context.name || "") + String(context.source || "") + String(context.operation || "");
  if (signature === lastReportedError) return;
  lastReportedError = signature;
  if (diagnostics) {
    diagnostics.errors.push({ at: new Date().toISOString(), key, detail: String(values.message || t(key, values)).slice(0, 1200), ...context, environment: diagnosticEnvironment() });
    diagnostics.errors = diagnostics.errors.slice(-4);
    sampleDiagnostics("error");
  }
  showMessage(key, true, values);
  notifyParent("retro-vault-player-error", { key, values, message: t(key, values), toastHandled: !!window.RetroNotices });
}

function playerError(key, values = {}) {
  const error = new Error(t(key, values));
  error.i18nKey = key;
  error.i18nValues = values;
  return error;
}

function reportException(error, fallback) {
  const context = errorContext(error, "player-boot");
  if (error?.i18nKey) reportPlayerError(error.i18nKey, error.i18nValues, context);
  else if (error?.message) reportPlayerError("runtimeError", { message: error.message }, context);
  else reportPlayerError(fallback);
}

function clearSavedThreadOverride(game) {
  // Migrate save defaults once; keep save files, controls, and cheats intact.
  try {
    const storage = window.localStorage;
    const saveName = game.saveName || game.title;
    const migrationKey = "retro-vault-save-defaults:" + JSON.stringify([game.id, game.core, saveName]);
    const migrateSaves = storage.getItem(migrationKey) !== "1";
    const prefix = `ejs-${game.id}-`;
    const suffix = `-${saveName}-settings`;
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (!key || !key.startsWith(prefix) || !key.endsWith(suffix)) continue;
      const saved = JSON.parse(storage.getItem(key));
      if (saved?.settings) {
        delete saved.settings.ejs_threads;
        if (migrateSaves) {
          delete saved.settings["save-state-location"];
          delete saved.settings["save-save-interval"];
        }
        storage.setItem(key, JSON.stringify(saved));
      }
    }
    storage.setItem(migrationKey, "1");
  } catch (error) {
    console.debug("Saved preference migration was unavailable:", error);
  }
}

function configureSafari3dsCache(game, core, dataPath) {
  // Match the Safari check in the pinned frontend. Other browsers and runtime
  // versions retain their existing core defaults and saved preferences.
  if (threeDsTest || dataPath !== DEFAULT_EJS_DATA_PATH || !['3ds', 'azahar'].includes(core)
    || !/^((?!chrome|android).)*safari/i.test(String(window.navigator?.userAgent || ''))) return;
  window.EJS_defaultOptions.citra_use_hw_shader_cache = 'disabled';
  threeDsStartupPolicy = { name: 'safari-shader-cache-off', requestedDefaults: { citra_use_hw_shader_cache: 'disabled' }, savedPreferenceMigration: 'pending' };
  try {
    const storage = window.localStorage;
    const saveName = game.saveName || game.title;
    const migrationKey = 'retro-vault-safari-3ds-cache-v2:' + JSON.stringify([game.id, saveName]);
    if (storage.getItem(migrationKey) === '1') {
      threeDsStartupPolicy.savedPreferenceMigration = 'already-applied';
      return;
    }
    for (const system of ['3ds', 'azahar']) {
      const key = `ejs-${game.id}-${system}-${saveName}-settings`;
      const raw = storage.getItem(key);
      if (!raw) continue;
      let saved;
      try { saved = JSON.parse(raw); } catch { continue; }
      if (!saved?.settings || typeof saved.settings !== 'object' || Array.isArray(saved.settings)) continue;
      saved.settings.citra_use_hw_shader_cache = 'disabled';
      storage.setItem(key, JSON.stringify(saved));
    }
    // Only this preference is migrated once. Later explicit native settings
    // choices remain available; no save files or shader-cache files are deleted.
    storage.setItem(migrationKey, '1');
    threeDsStartupPolicy.savedPreferenceMigration = 'applied';
  } catch {
    threeDsStartupPolicy.savedPreferenceMigration = 'unavailable';
  }
}

function installSafari3dsCoreSettings(emulator) {
  if (!threeDsStartupPolicy || typeof emulator?.getCoreSettings !== 'function' || restoreThreeDsCoreSettings) return;
  const original = emulator.getCoreSettings;
  const wrapped = function(...args) {
    let text = Reflect.apply(original, this, args);
    if (typeof text !== 'string') throw new Error('The pinned runtime returned an invalid core settings file.');
    // In 4.3.0-pre, getCoreSettings returns an empty string when no saved
    // settings record exists, even if defaultOptions is configured. Supply
    // this scoped default at the actual native configuration-file boundary.
    let match = /^\s*citra_use_hw_shader_cache\s*=\s*(?:"([^"]*)"|([^\s#]+))/m.exec(text);
    if (!match) {
      text += (text && !text.endsWith('\n') ? '\n' : '') + 'citra_use_hw_shader_cache = "disabled"\n';
      match = [null, 'disabled'];
    }
    threeDsStartupPolicy.coreSettingsFile = { source: 'native-startup-config', shaderCacheValue: match[1] ?? match[2] };
    return text;
  };
  emulator.getCoreSettings = wrapped;
  restoreThreeDsCoreSettings = () => {
    if (emulator.getCoreSettings === wrapped) emulator.getCoreSettings = original;
    restoreThreeDsCoreSettings = null;
  };
}

function configureDsTouchMode(game, core, loaderVersion) {
  if (loaderVersion !== '4.3.0-pre' || !['nds', 'melonds'].includes(core)) return;
  // Mouse mode integrates relative movement; Touch uses the displayed position
  // for both mouse clicks and finger input, including the core's screen layout.
  window.EJS_defaultOptions.melonds_touch_mode = 'Touch';
  try {
    const storage = window.localStorage;
    const saveName = game.saveName || game.title;
    const migrationKey = 'retro-vault-ds-touch-mode:' + JSON.stringify([game.id, game.core, saveName]);
    if (storage.getItem(migrationKey) === '1') return;
    for (const system of ['nds', 'melonds']) {
      const key = `ejs-${game.id}-${system}-${saveName}-settings`;
      const raw = storage.getItem(key);
      if (!raw) continue;
      let saved;
      try { saved = JSON.parse(raw); } catch { continue; }
      if (!saved?.settings || typeof saved.settings !== 'object' || Array.isArray(saved.settings)) continue;
      const mode = saved.settings.melonds_touch_mode;
      if (mode == null || mode === 'Mouse') {
        saved.settings.melonds_touch_mode = 'Touch';
        storage.setItem(key, JSON.stringify(saved));
      }
    }
    // Subsequent explicit choices in the native settings remain user-controlled.
    storage.setItem(migrationKey, '1');
  } catch (error) {
    console.debug('Saved DS touch preference migration was unavailable:', error);
  }
}

function showMessage(key, isError = false, values = {}) {
  displayedMessage = { key, isError, values };
  if (window.RetroNotices) {
    window.RetroNotices.notify('player', { key, values, error: isError });
    message?.classList.add('hidden');
    return;
  }
  if (!message) return;
  message.textContent = t(key, values);
  message.classList.toggle("error", isError);
  message.classList.remove("hidden");
}

function hideMessage() {
  if (displayedMessage?.isError) return;
  displayedMessage = null;
  window.RetroNotices?.dismiss('player');
  if (!message) return;
  message.classList.add("hidden");
  message.classList.remove("error");
}

function notifyParent(type, detail = {}) {
  if (window.parent === window) return;
  window.parent.postMessage({ type, ...detail }, window.location.origin);
}

function encodeAssetPath(folder, filename) {
  if (typeof filename !== "string" || filename.length === 0) return "";

  const encoded = filename
    .split("/")
    .map(part => encodeURIComponent(part))
    .join("/");

  return `/data/${folder}/${encoded}`;
}

async function fetchGames() {
  const candidates = ["/api/games"];
  let lastError = null;

  for (const path of candidates) {
    try {
      const response = await fetch(`${path}?v=${Date.now()}`, {
        cache: "no-store"
      });

      if (!response.ok) {
        lastError = new Error(`${path} returned HTTP ${response.status}.`);
        continue;
      }

      const games = await response.json();
      if (!Array.isArray(games)) {
        throw new Error(`${path} is not an array.`);
      }

      return games;
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error("Could not load games.json.");
}

function resolveDataPath(game) {
  if (typeof game.dataPath === "string" && /^https:\/\//i.test(game.dataPath)) {
    return game.dataPath.endsWith("/") ? game.dataPath : `${game.dataPath}/`;
  }

  if (
    typeof game.ejsVersion === "string" &&
    /^[A-Za-z0-9._-]+$/.test(game.ejsVersion)
  ) {
    return `https://cdn.emulatorjs.org/${game.ejsVersion}/data/`;
  }

  return DEFAULT_EJS_DATA_PATH;
}

function configureOptionalOptions(game) {
  if (game.bios) {
    window.EJS_biosUrl = new URL(
      encodeAssetPath("bios", game.bios),
      window.location.origin
    ).href;
  }

  if (game.gameParent) {
    window.EJS_gameParentUrl = new URL(
      encodeAssetPath("roms", game.gameParent),
      window.location.origin
    ).href;
  }

  if (game.patch) {
    window.EJS_gamePatchUrl = new URL(
      encodeAssetPath("roms", game.patch),
      window.location.origin
    ).href;
  }

  if (
    Number.isInteger(game.videoRotation) &&
    game.videoRotation >= 0 &&
    game.videoRotation <= 3
  ) {
    window.EJS_videoRotation = game.videoRotation;
  }

  if (typeof game.disableCue === "boolean") {
    window.EJS_disableCue = game.disableCue;
  }

  if (typeof game.forceLegacyCores === "boolean") {
    window.EJS_forceLegacyCores = game.forceLegacyCores;
  }
}

function startEmulator(game, gameUrl, requestedThreads) {
  if (emulatorStarted) {
    throw playerError("alreadyStarted");
  }

  if (!game || !Number.isInteger(game.id) || !game.core || !game.title) {
    throw playerError("invalidConfig");
  }

  const core = game.coreOverride || CORE_ALIASES[game.core] || game.core;
  const threadSupport =
    window.crossOriginIsolated === true &&
    typeof window.SharedArrayBuffer === "function";
  const threads = requestedThreads && threadSupport;

  if (THREADS_REQUIRED_CORES.has(game.core) && !threads) {
    throw playerError("threadUnavailable");
  }

  const dataPath = resolveDataPath(game);
  const loaderVersion = new URL(dataPath).pathname.match(/\/([^/]+)\/data\/$/)?.[1]
    || game.ejsVersion || DEFAULT_EJS_VERSION;
  if (threeDsTest && (game.core !== '3ds' || !['3ds', 'azahar'].includes(core) || dataPath !== DEFAULT_EJS_DATA_PATH)) {
    throw new Error('The comparison requires a library 3DS game using the pinned 4.3.0-pre Azahar runtime.');
  }
  legacyLanguageLoader = /^(?:4\.[0-2](?:\.|$)|stable$)/i.test(loaderVersion);
  if (!threeDsTest && typeof window.RetroSaveManager === "function") saveManager = new window.RetroSaveManager(game, recordActivity);

  // Keep the player configuration intentionally close to the official EmulatorJS demo.
  window.EJS_player = "#game";
  window.EJS_gameID = game.id;
  window.EJS_gameName = threeDsTest ? `Retro Vault 3DS Test ${game.id}` : game.saveName || game.title;
  window.EJS_gameUrl = gameUrl;
  window.EJS_core = core;
  window.EJS_pathtodata = dataPath;
  // A tap inside the player establishes interaction in the emulator document.
  window.EJS_startOnLoaded = false;
  window.EJS_language = I18n.emulatorLocale(legacyLanguageLoader ? "4.2.3" : DEFAULT_EJS_VERSION);
  window.EJS_disableAutoLang = !legacyLanguageLoader;
  if (I18n.language === "ja") {
    localeObjectUrl = URL.createObjectURL(new Blob([JSON.stringify(I18n.emulatorDictionary())], { type: "application/json" }));
    window.EJS_paths = { [window.EJS_language]: localeObjectUrl };
  }
  window.EJS_threads = threads;
  window.EJS_defaultOptions = {
    ejs_threads: threads ? "enabled" : "disabled",
    "save-state-location": "browser",
    "save-save-interval": "30"
  };
  if (threeDsTest) {
    window.EJS_disableLocalStorage = true;
    Object.assign(window.EJS_defaultOptions, threeDsTest.options);
  }
  // Production mode enables the core cache and avoids verbose runtime logging.
  window.EJS_DEBUG_XX = false;

  configureOptionalOptions(game);
  if (!threeDsTest) clearSavedThreadOverride(game);
  configureSafari3dsCache(game, core, dataPath);
  configureDsTouchMode(game, core, loaderVersion);
  beginDiagnostics(game, threads, loaderVersion);
  if (typeof window.RetroResourceDiagnostics === "function") {
    resourceDiagnostics = new window.RetroResourceDiagnostics({
      onChange: () => sampleDiagnostics(),
      onReadFailure: error => reportPlayerError("localReadError", {}, errorContext(error, "File.arrayBuffer"))
    });
    if (gameUrl instanceof File) resourceDiagnostics.trackFile(gameUrl);
  }
  if (typeof window.RetroRuntimeSupport === "function") {
    runtimeSupport = new window.RetroRuntimeSupport({
      contexts: existingAudioContexts,
      onFailure(error, operation) {
        reportPlayerError(error?.name === 'EncryptedRomError' ? 'encryptedRom' : 'runtimeError',
          { message: error?.message || String(error) }, { ...errorContext(error, "operation"), operation });
        sampleDiagnostics();
      },
      onChange() { sampleDiagnostics(); }
    });
  }
  installAudioContextTracking();

  window.EJS_ready = () => {
    if (playerClosing) return;
    // The native Start Game button is the startup instruction.
    if (!displayedMessage?.isError) hideMessage();
    sampleDiagnostics("waiting-for-start");
    const emulator = window.EJS_emulator;
    installSafari3dsCoreSettings(emulator);
    if (threeDsMonitor) {
      try { threeDsMonitor.attach(emulator); }
      catch (error) { reportException(error, 'startError'); return; }
    }
    if (game.core === '3ds' && ((gameUrl instanceof File && gameUrl.size >= 256 * 1048576) || typeof gameUrl === 'string')) {
      try {
        lazyRom = window.RetroLazyRom.install(emulator, gameUrl, stats => { sampleDiagnostics(); renderRomPreparation(stats); if (stats.state === 'failed') reportPlayerError(stats.errorKey || 'lazyRomReadError'); });
        sampleDiagnostics();
      } catch (error) {
        // Stop instead of silently retrying a multi-gigabyte allocation.
        const original = emulator.download;
        emulator.download = function(url, type) {
          if (url === gameUrl) { reportPlayerError('lazyRomUnavailable'); return Promise.reject(new Error('lazyRomUnavailable')); }
          return Reflect.apply(original, this, arguments);
        };
        reportPlayerError('lazyRomUnavailable');
      }
    }
    // Record entry into the actual runtime stages, independent of native status text.
    for (const [method, phase] of [['initModule', 'initializing-core'], ['downloadFiles', 'preparing-files'], ['startGame', 'starting-game']]) {
      if (typeof emulator?.[method] !== 'function') continue;
      const original = emulator[method];
      emulator[method] = function() { sampleDiagnostics(phase); return Reflect.apply(original, this, arguments); };
    }
    if (typeof emulator?.download === 'function') {
      const original = emulator.download;
      emulator.download = function(url, type) { if (url === gameUrl) sampleDiagnostics('loading-rom'); return Reflect.apply(original, this, arguments); };
    }
    runtimeSupport?.attach(emulator);
    syncEmulatorLanguage();
    // EmulatorJS emits exit for both failures and explicit exits.
    if (typeof emulator?.on === "function") {
      emulator.on("start-clicked", () => {
        hideMessage();
        sampleDiagnostics("loading-core");
      });
      emulator.on("exit", () => {
        reportPlayerError("emulatorStopped");
      });
    }
    emulator?.canvas?.addEventListener("webglcontextlost", event => {
      event.preventDefault();
      reportPlayerError("contextLost");
    });
    notifyParent("retro-vault-player-ready");
  };

  window.EJS_onGameStart = () => {
    if (playerClosing) return;
    runtimeSupport?.attach(window.EJS_emulator);
    hideMessage();
    if (diagnostics && diagnostics.gameStartedAtMs === null) diagnostics.gameStartedAtMs = Date.now();
    sampleDiagnostics(displayedMessage?.isError ? "error" : "running");
    saveManager?.start();
    updateVisibility();
    notifyParent("retro-vault-player-start", { savesAvailable: !!saveManager });
  };

  window.EJS_onExit = () => {
    reportPlayerError("emulatorStopped");
  };

  const loader = document.createElement("script");
  loader.src = `${dataPath}loader.js`;

  loader.addEventListener("error", () => {
    reportPlayerError("loaderError");
  });

  emulatorStarted = true;
  document.body.appendChild(loader);
}

async function bootLibraryGame(params, requestedThreads) {
  const gameId = Number(params.get("id"));

  if (!Number.isInteger(gameId) || gameId <= 0) {
    throw playerError("invalidGameId");
  }

  const games = await fetchGames();
  const game = games.find(item => item.id === gameId);

  if (!game) {
    throw playerError("gameNotFound", { id: gameId });
  }

  if (typeof game.rom !== "string" || game.rom.length === 0) {
    throw playerError("romNotConfigured", { id: gameId });
  }

  // Pass an absolute same-origin URL directly to EmulatorJS.
  // This avoids ambiguity about whether a relative ROM path is resolved
  // against player.html or the CDN-loaded loader.js.
  const gameUrl = new URL(
    encodeAssetPath("roms", game.rom),
    window.location.origin
  ).href;

  startEmulator(game, gameUrl, requestedThreads);
}

function bootLocalGame(requestedThreads) {
  showMessage("waitingLocal");

  const onMessage = async event => {
    if (
      event.origin !== window.location.origin ||
      event.source !== window.parent ||
      event.data?.type !== "retro-vault-local-rom"
    ) {
      return;
    }

    window.removeEventListener("message", onMessage);

    try {
      const file = event.data.file;
      const game = event.data.game;

      if (!(file instanceof Blob) || file.size <= 0) {
        throw playerError("localReadError");
      }

      // The pinned runtime supports File input, as used by the official demo.
      // Keep the original extension and avoid fetching a local blob URL.
      let rom = file instanceof File ? file : new File([file], game.localFilename || "game.rom", { type: file.type });
      if (window.RetroLocalRom && game.core === '3ds') {
        const panel = document.getElementById('local-preparation');
        const meter = document.getElementById('local-preparation-meter');
        const label = document.getElementById('local-preparation-label');
        let last = 0;
        window.RetroNotices?.mount(panel); panel.hidden = false;
        try {
          const prepared = await window.RetroLocalRom.prepare(rom, { signal: localPreparationController.signal, progress(done, total) {
            meter.value = done / total * 100;
            if (Date.now() - last > 200 || done === total) { label.textContent = t('localTrimProgress', { percent: Math.floor(done / total * 100) }); last = Date.now(); }
          } });
          localPreparation = { originalSize: prepared.originalSize, preparedSize: prepared.preparedSize, reason: prepared.reason };
          rom = prepared.file;
        } finally { panel.hidden = true; }
      }
      if (playerClosing || localPreparationController.signal.aborted) return;
      hideMessage();
      startEmulator(game, rom, requestedThreads);
      if (localPreparation) window.RetroNotices?.notify('trim-result', { key: localPreparation.reason === 'trimmed' ? 'localTrimDone' : localPreparation.reason === 'unsupported-media' ? 'localTrimSkippedMedia' : 'localTrimSkipped', values: { before: (localPreparation.originalSize / 1048576).toFixed(1), after: (localPreparation.preparedSize / 1048576).toFixed(1) } });
    } catch (error) {
      if (playerClosing) return;
      if (localPreparationController.signal.aborted) { showMessage("localTrimCancelled", true); return; }
      console.error(error);
      reportException(error, "localOpenError");
    }
  };

  window.addEventListener("message", onMessage);
  notifyParent("retro-vault-player-local-ready");
}

async function boot() {
  try {
    hideMessage();

    const params = new URLSearchParams(window.location.search);
    const requestedThreads = params.get("threads") === "1";

    if (params.get("mode") === "local") {
      bootLocalGame(requestedThreads);
      return;
    }

    await bootLibraryGame(params, requestedThreads);
  } catch (error) {
    console.error(error);

    reportException(error, "startError");
  }
}

function shutdownPlayer(reason = "close") {
  if (cleanupPromise) return cleanupPromise;
  playerClosing = true;
  localPreparationController.abort();
  threeDsMonitor?.stop();
  restoreThreeDsCoreSettings?.();
  runtimeSupport?.stop();
  const romCleanup = lazyRom?.stop();
  renderRomPreparation(null);
  restoreConsoleDiagnostics?.();
  restoreAudioContextTracking?.();
  saveManager?.stop();
  pausedForVisibility = false;
  if (diagnosticTimer !== null) clearInterval(diagnosticTimer);
  diagnosticTimer = null;
  errorObserver.disconnect();
  sampleDiagnostics("closing");
  recordActivity("player-close-request");
  const emulator = window.EJS_emulator;
  const module = emulator?.Module;
  const shouldSave = emulator?.started === true && !emulator.failedToStart;
  try { emulator?.pause?.(true); } catch {}
  try { module?.pauseMainLoop?.(); } catch {}
  if (emulator) {
    // Suppress the native beforeunload handler, which otherwise resets the core.
    emulator.started = false;
    if (emulator.saveSaveInterval != null) clearInterval(emulator.saveSaveInterval);
    if (emulator.resetTimeout != null) clearTimeout(emulator.resetTimeout);
    emulator.saveSaveInterval = null;
    emulator.resetTimeout = null;
  }
  try { if (shouldSave) emulator.gameManager?.saveSaveFiles?.(); } catch (error) {
    if (diagnostics) diagnostics.saveError = String(error?.message || error).slice(0, 500);
  }
  const flushSave = shouldSave && saveManager?.started ? saveManager.flushExistingSystem() : new Promise(resolve => {
    const fs = emulator?.gameManager?.FS || module?.FS;
    if (!shouldSave || typeof fs?.syncfs !== "function") {
      resolve("not-needed");
      return;
    }
    let finished = false;
    const done = result => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      resolve(result);
    };
    const timeout = setTimeout(() => done("timed-out"), 1200);
    try { fs.syncfs(false, error => done(error ? "failed" : "saved")); }
    catch { done("failed"); }
  });
  cleanupPromise = Promise.allSettled([flushSave, saveManager?.pendingOperation, saveManager?.nativePending, romCleanup]).then(([flushResult]) => {
    const saveFlush = flushResult.status === "fulfilled" ? flushResult.value : "failed";
    const contexts = existingAudioContexts(module);
    for (const context of contexts) {
      try { Promise.resolve(context.close()).catch(() => {}); } catch {}
    }
    ownedAudioContexts.clear();
    if (emulator?.canvas) {
      emulator.canvas.width = 1;
      emulator.canvas.height = 1;
    }
    if (localeObjectUrl) URL.revokeObjectURL(localeObjectUrl);
    localeObjectUrl = "";
    resourceDiagnostics?.stop();
    window.EJS_gameUrl = "";
    if (diagnostics) {
      diagnostics.closeReason = reason;
      diagnostics.saveFlush = saveFlush;
      sampleDiagnostics("closed");
    }
    window.EJS_emulator = null;
  });
  return cleanupPromise;
}

window.addEventListener("pagehide", () => { shutdownPlayer("pagehide"); });
document.getElementById('rom-disk-cancel')?.addEventListener('click', () => {
  shutdownPlayer('preparation-cancelled').then(() => showMessage('romDiskCancelled'));
});

function updateVisibility() {
  if (playerClosing) return;
  const emulator = window.EJS_emulator;
  if (!emulator?.started) return;
  if (document.hidden) {
    if (!emulator.paused && typeof emulator.pause === "function") {
      emulator.pause();
      pausedForVisibility = true;
    }
    sampleDiagnostics("background");
  } else {
    if (pausedForVisibility) {
      pausedForVisibility = false;
      emulator.play?.();
    }
    sampleDiagnostics(displayedMessage?.isError ? "error" : "running");
  }
}

document.addEventListener("visibilitychange", updateVisibility);

window.addEventListener("error", event => {
  if (playerClosing) return;
  if (event.message) {
    console.error("Emulator runtime error:", event.message);
    reportPlayerError("runtimeError", { message: event.message }, errorContext(event.error, event.filename || "window-error", event));
  }
});

window.addEventListener("unhandledrejection", event => {
  if (playerClosing) return;
  const reason = event.reason;
  console.error("Emulator promise rejection:", reason);
  if (reason) reportPlayerError("runtimeError", { message: reason?.message || String(reason) }, errorContext(reason, "unhandledrejection"));
  else reportPlayerError("unexpectedError");
});

// Some core failures are handled internally rather than thrown to the page.
const errorObserver = new MutationObserver(records => {
  for (const record of records) {
    if (record.type === "childList") {
      for (const node of record.addedNodes) localizeEmulatorNode(node);
    } else localizeEmulatorNode(record.target, record.type !== "attributes");
  }
  const error = document.querySelector(".ejs_error_text");
  if (error?.textContent) reportPlayerError("runtimeError", { message: error.textContent });
});
errorObserver.observe(document.getElementById("game"), {
  childList: true,
  subtree: true,
  attributes: true,
  attributeFilter: ["class", "title", "aria-label", "placeholder"],
  characterData: true
});

function localizeEmulatorNode(node, traverse = true) {
  if (playerClosing) return;
  if (node.nodeType === 3) {
    const translated = I18n.translateEmulatorText(node.nodeValue);
    if (node.nodeValue !== translated) node.nodeValue = translated;
    return;
  }
  if (node.nodeType !== 1 || ["SCRIPT", "STYLE", "TEXTAREA"].includes(node.tagName)) return;
  for (const attribute of ["title", "aria-label", "placeholder"]) {
    const value = node.getAttribute(attribute);
    if (!value) continue;
    const translated = I18n.translateEmulatorText(value);
    if (value !== translated) node.setAttribute(attribute, translated);
  }
  if (traverse) for (const child of node.childNodes) localizeEmulatorNode(child);
}

function syncEmulatorLanguage() {
  const emulator = window.EJS_emulator;
  if (emulator?.config) {
    emulator.config.language = I18n.emulatorLocale(legacyLanguageLoader ? "4.2.3" : DEFAULT_EJS_VERSION);
    emulator.config.langJson = I18n.emulatorDictionary();
  }
  localizeEmulatorNode(document.getElementById("game"));
}

I18n.onChange(() => {
  syncEmulatorLanguage();
  if (displayedMessage) {
    const { key, isError, values } = displayedMessage;
    if (!window.RetroNotices) showMessage(key, isError, values);
    if (isError) notifyParent("retro-vault-player-error", { key, values, message: t(key, values), toastHandled: !!window.RetroNotices });
  }
});

window.addEventListener("message", event => {
  if (event.origin !== window.location.origin || event.source !== window.parent) return;
  if (event.data?.type === "retro-vault-open-saves") {
    if (!playerClosing) saveManager?.open();
    return;
  }
  if (event.data?.type === "retro-vault-player-stop" && typeof event.data.token === "string") {
    const token = event.data.token;
    shutdownPlayer().then(() => notifyParent("retro-vault-player-stopped", { token }));
    return;
  }
  if (event.data?.type !== "retro-vault-language" || !["en", "ja"].includes(event.data.language)) return;
  I18n.setLanguage(event.data.language, false);
});

I18n.apply();
boot();

document.getElementById("local-preparation-cancel")?.addEventListener("click", () => localPreparationController.abort());
