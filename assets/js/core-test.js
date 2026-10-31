"use strict";

(() => {
  const i18n = window.RetroI18n;
  const key = "retro-vault-core-test-diagnostics";
  const select = document.getElementById("test-game");
  const version = document.getElementById("test-version");
  version.value = "4.3.0-pre";
  const start = document.getElementById("test-start");
  const finish = document.getElementById("test-finish");
  const download = document.getElementById("test-download");
  const language = document.getElementById("language-select");
  const status = document.getElementById("test-status");
  let games = [];
  let report = null;
  let previous = null;
  let timer = null;
  let localeUrl = "";
  let message = "loadingGames";
  let values = {};

  // This report is independent of the normal player's diagnostic log.
  try { previous = JSON.parse(sessionStorage.getItem(key) || "null"); } catch {}
  if (previous?.mode !== "standalone-core-test") previous = null;
  download.hidden = !previous;
  i18n.bindLanguageSelect(language);

  function show(next, parameters = {}) {
    message = next;
    values = parameters;
    status.textContent = i18n.t(message, values);
  }

  i18n.onChange(() => {
    for (const option of select.children) if (games[Number(option.value)]) option.textContent = i18n.gameTitle(games[Number(option.value)]);
    show(message, values);
  });

  function sample() {
    if (!report) return;
    report.lastSampleAt = new Date().toISOString();
    report.gameElapsedSeconds = report.gameStartedAtMs === null
      ? null : Math.floor((Date.now() - report.gameStartedAtMs) / 1000);
    const module = window.EJS_emulator?.Module;
    const bytes = module?.HEAPU8?.buffer?.byteLength ?? module?.HEAP8?.buffer?.byteLength;
    if (Number.isFinite(bytes)) {
      report.wasmHeapBytes = bytes;
      report.peakWasmHeapBytes = Math.max(report.peakWasmHeapBytes || 0, bytes);
    }
    report.visibility = document.visibilityState;
    try { sessionStorage.setItem(key, JSON.stringify(report)); }
    catch { report.logStorageUnavailable = true; }
  }

  function recordError(value) {
    if (!report) return;
    report.errors.push({
      at: new Date().toISOString(),
      message: String(value?.message || value || "Unknown error").slice(0, 750),
      name: String(value?.name || "").slice(0, 80),
      stack: String(value?.stack || "").slice(0, 1000)
    });
    report.errors = report.errors.slice(-4);
    sample();
    show("coreTestError");
  }

  window.addEventListener("error", event => recordError(event.error || event.message));
  window.addEventListener("unhandledrejection", event => recordError(event.reason));
  window.addEventListener("pagehide", () => {
    if (!report) return;
    report.pagehideObserved = true;
    sample();
    clearInterval(timer);
  });
  window.addEventListener("pageshow", event => {
    if (event.persisted && report && report.phase !== "finished") {
      sample();
      timer = setInterval(sample, 10000);
    }
  });

  download.addEventListener("click", () => {
    sample();
    const data = report || previous;
    if (!data) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "retro-vault-core-test.json";
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });

  finish.addEventListener("click", () => {
    window.EJS_emulator?.pause?.();
    report.phase = "finished";
    sample();
    clearInterval(timer);
    finish.disabled = true;
    show("coreTestFinished", { seconds: report.gameElapsedSeconds ?? 0 });
  });

  start.addEventListener("click", () => {
    const game = games[Number(select.value)];
    if (!game || report) return;
    const release = version.value === "4.2.3" ? "4.2.3" : "4.3.0-pre";
    start.disabled = true;
    select.disabled = true;
    language.disabled = true;
    version.disabled = true;
    report = {
      schemaVersion: 1,
      appVersion: "2.19.1",
      mode: "standalone-core-test",
      emulatorVersion: release,
      game: { id: game.id, title: game.title, core: game.core },
      threads: false,
      framed: window.self !== window.top,
      saveInterval: "EmulatorJS default",
      userAgent: navigator.userAgent,
      crossOriginIsolated: window.crossOriginIsolated === true,
      startedAtMs: Date.now(),
      gameStartedAtMs: null,
      phase: "loading-loader",
      errors: [],
      memoryScope: "Core WebAssembly memory only; excludes browser, JavaScript, audio, and GPU memory."
    };
    download.hidden = false;
    sample();
    timer = setInterval(sample, 10000);
    window.EJS_player = "#game";
    window.EJS_core = game.coreOverride || game.core;
    window.EJS_gameID = game.id;
    window.EJS_gameName = "Retro Vault Core Test " + release + " - " + game.title;
    window.EJS_gameUrl = new URL("/data/roms/" + game.rom.split("/").map(encodeURIComponent).join("/"), location.origin).href;
    window.EJS_pathtodata = "https://cdn.emulatorjs.org/" + release + "/data/";
    report.dataPath = window.EJS_pathtodata;
    window.EJS_threads = false;
    window.EJS_defaultOptions = { ejs_threads: "disabled" };
    window.EJS_startOnLoaded = false;
    window.EJS_DEBUG_XX = false;
    window.EJS_language = i18n.emulatorLocale(release);
    // The two pinned loaders use opposite checks for loading a language file.
    window.EJS_disableAutoLang = release === "4.2.3" ? false : true;
    if (i18n.language === "ja") {
      localeUrl = URL.createObjectURL(new Blob([JSON.stringify(i18n.emulatorDictionary())], { type: "application/json" }));
      window.EJS_paths = { [window.EJS_language]: localeUrl };
    }
    window.EJS_ready = () => {
      report.phase = "waiting-for-start";
      show("tapToStart");
      sample();
    };
    window.EJS_onGameStart = () => {
      report.gameStartedAtMs = Date.now();
      report.phase = "running";
      const emulator = window.EJS_emulator;
      if (typeof emulator?.ejs_version === "string") report.runtimeVersion = emulator.ejs_version.slice(0, 80);
      if (typeof emulator?.getCore === "function") report.resolvedCore = String(emulator.getCore()).slice(0, 80);
      finish.hidden = false;
      show("coreTestRunning");
      sample();
      if (localeUrl) URL.revokeObjectURL(localeUrl);
      localeUrl = "";
    };
    show("coreTestLoading");
    const script = document.createElement("script");
    script.src = window.EJS_pathtodata + "loader.js";
    script.onerror = () => recordError(new Error("Failed to load EmulatorJS loader.js."));
    document.body.appendChild(script);
  });

  fetch("/api/games", { cache: "no-store" }).then(response => {
    if (!response.ok) throw new Error("Failed to load games.json.");
    return response.json();
  }).then(entries => {
    if (!Array.isArray(entries)) throw new Error("Invalid game list.");
    // Both releases use the ROM from an ordinary stable NES entry.
    games = entries.filter(game => game && ["nes", "fceumm", "nestopia"].includes(game.core) && Number.isInteger(game.id)
      && typeof game.title === "string" && typeof game.rom === "string" && game.rom.length
      && !game.bios && !game.patch && !game.gameParent && !game.dataPath
      && (!game.ejsVersion || ["4.2.3", "4.3.0-pre"].includes(game.ejsVersion)));
    games.forEach((game, index) => {
      const option = document.createElement("option");
      option.value = String(index);
      option.textContent = i18n.gameTitle(game);
      select.appendChild(option);
    });
    select.disabled = start.disabled = games.length === 0;
    if (previous) show("coreTestPrevious", { seconds: previous.gameElapsedSeconds ?? 0, version: previous.emulatorVersion || "unknown" });
    else show(games.length ? "coreTestReady" : "coreTestNoGames");
  }).catch(() => show("databaseError"));
  i18n.apply();
})();
