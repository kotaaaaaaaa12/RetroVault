"use strict";

(() => {
  const i18n = window.RetroI18n;
  const t = (key, values) => i18n.t(key, values);
  const element = id => document.getElementById('three-ds-' + id);
  const key = 'retro-vault-3ds-comparison-v1';
  const profiles = window.Retro3DSDiagnostics.profiles;
  const profileKeys = { baseline: 'threeDsBaseline', 'shader-cache-off': 'threeDsCacheOff', 'hardware-shaders-off': 'threeDsShadersOff', 'saved-data-readonly': 'threeDsSavedData' };
  const outcomes = ['active', 'stopped', 'interrupted', 'error', 'played', 'screen-blank', 'page-reloaded'];
  const outcomeKeys = { active: 'threeDsActive', stopped: 'threeDsStopped', interrupted: 'threeDsInterrupted', error: 'threeDsError', played: 'threeDsPlayed', 'screen-blank': 'threeDsBlank', 'page-reloaded': 'threeDsReloaded' };
  const phaseKeys = { loading: 'threeDsPhaseLoading', 'waiting-for-start': 'threeDsPhaseWaiting', 'loading-core': 'threeDsPhaseCore', 'initializing-core': 'threeDsPhaseInitializing', 'preparing-files': 'threeDsPhaseFiles', 'loading-rom': 'threeDsPhaseRom', 'starting-game': 'threeDsPhaseStarting', running: 'threeDsPhaseRunning', error: 'threeDsError', closing: 'threeDsPhaseClosing', closed: 'threeDsPhaseClosed', background: 'threeDsPhaseBackground' };
  const phaseLabel = value => phaseKeys[value] ? t(phaseKeys[value]) : value || t('threeDsUnavailable');
  const romLabel = value => value === 'downloading' ? t('romDiskPreparing') : value === 'ready' ? t('threeDsRomReady') : value;
  let games = [];
  let runs = [];
  let active = null;
  let frame = null;
  let closing = null;
  let closeTimer = null;
  let storageFailed = false;
  let loading = true;
  let statusKey = 'loadingGames';
  try {
    const raw = localStorage.getItem(key);
    const stored = raw && raw.length < 500000 ? JSON.parse(raw) : null;
    if (stored?.schemaVersion === 1 && Array.isArray(stored.runs)) runs = stored.runs.filter(run => run && typeof run.id === 'string' && Object.hasOwn(profiles, run.profile) && run.game && outcomes.includes(run.outcome)).slice(-6);
    for (const run of runs) if (run.outcome === 'active') run.outcome = 'interrupted';
  } catch { storageFailed = true; }

  function save() {
    try { localStorage.setItem(key, JSON.stringify({ schemaVersion: 1, runs })); }
    catch { storageFailed = true; }
    if (storageFailed) window.RetroNotices?.notify('test-storage', { key: 'threeDsStorageError', error: true });
  }
  function status(next) {
    if (next) statusKey = next;
    element('status').textContent = t(statusKey);
  }
  function node(tag, text, className) {
    const result = document.createElement(tag);
    if (text !== undefined) result.textContent = text;
    if (className) result.className = className;
    return result;
  }
  const bytes = value => Number.isFinite(value) ? i18n.formatBytes(value) : t('threeDsUnavailable');
  function renderResults() {
    const root = element('results');
    root.replaceChildren();
    for (const run of [...runs].reverse()) {
      const report = run.diagnostics;
      const info = report?.test3ds;
      const card = node('article', undefined, 'test-result');
      card.append(node('h3', `${run.game.title} · ${t(profileKeys[run.profile])}`));
      card.append(node('p', new Date(run.startedAt).toLocaleString(i18n.language === 'ja' ? 'ja-JP' : 'en-US'), 'hint'));
      const list = node('dl');
      const details = [
        ['threeDsStage', phaseLabel(report?.phase || (run.playerError ? 'error' : null))],
        ['threeDsPeak', bytes(report?.peakWasmHeapBytes)],
        ['threeDsElapsed', Number.isFinite(report?.gameElapsedSeconds) ? `${report.gameElapsedSeconds}s` : t('threeDsUnavailable')],
        ['threeDsLastSample', report?.lastSampleAt ? new Date(report.lastSampleAt).toLocaleTimeString(i18n.language === 'ja' ? 'ja-JP' : 'en-US') : t('threeDsUnavailable')],
        ['threeDsSettingsStatus', !info || info.optionSource !== 'native-get_core_options' ? t('threeDsUnavailable') : Object.entries(profiles[run.profile]).every(([key, value]) => info.actualOptions[key] === value) && !info.settingsChanges.length ? t('threeDsSettingsMatch') : t('threeDsSettingsDiffer')]
      ];
      for (const [label, value] of details) list.append(node('dt', t(label)), node('dd', value));
      card.append(list);
      if (info?.savedSnapshot) {
        const snapshot = info.savedSnapshot;
        card.append(node('p', t('threeDsSnapshotSummary', { state: t('threeDsSnapshot' + snapshot.state), files: snapshot.files, bytes: bytes(snapshot.bytes) }), 'hint'));
      }
      if (run.playerError) card.append(node('p', run.playerError.message, 'hint test-mismatch'));
      const label = node('label');
      label.append(node('span', t('threeDsObservation')));
      const outcome = node('select');
      outcome.setAttribute('aria-label', t('threeDsObservation'));
      for (const value of outcomes.filter(value => value !== 'active' || run === active)) {
        const option = node('option', t(outcomeKeys[value])); option.value = value; outcome.append(option);
      }
      outcome.value = run.outcome;
      outcome.disabled = !!active;
      outcome.addEventListener('change', () => { run.outcome = outcome.value; run.observationByUser = true; outcome.blur(); save(); });
      label.append(outcome); card.append(label);
      const settings = node('details');
      settings.append(node('summary', t('threeDsSettings')));
      const wrap = node('div', undefined, 'test-table-wrap');
      const table = node('table');
      const head = node('tr');
      for (const text of ['threeDsSetting', 'threeDsRequested', 'threeDsActual']) { const th = node('th', t(text)); th.scope = 'col'; head.append(th); }
      const thead = node('thead'); thead.append(head); table.append(thead);
      const tbody = node('tbody');
      for (const [key, value] of Object.entries(profiles[run.profile])) {
        const row = node('tr');
        const actual = info?.actualOptions?.[key];
        row.append(node('td', key), node('td', value), node('td', actual ?? t('threeDsUnavailable'), actual !== undefined && actual !== value ? 'test-mismatch' : ''));
        tbody.append(row);
      }
      table.append(tbody); wrap.append(table); settings.append(wrap);
      settings.append(node('p', t('threeDsReadbackHelp'), 'hint'));
      card.append(settings);
      const stages = node('details'); stages.append(node('summary', t('threeDsStages')));
      const timeline = node('ol', undefined, 'test-stages');
      for (const stage of info?.stages || []) timeline.append(node('li', `${(stage.elapsedMs / 1000).toFixed(1)}s · ${phaseLabel(stage.phase)}${stage.romState ? ' / ' + romLabel(stage.romState) : ''} · ${bytes(stage.bytes)}`));
      stages.append(timeline); card.append(stages); root.append(card);
    }
    if (!runs.length) root.append(node('p', t('threeDsNoResults'), 'hint'));
    element('download').disabled = runs.length === 0;
    element('clear').disabled = !!active || runs.length === 0;
  }
  function controls() {
    element('start').disabled = loading || !games.length || !!active;
    element('game').disabled = loading || !games.length || !!active;
    element('condition').disabled = !!active;
    element('stop').hidden = !active;
    element('stop').disabled = !!closing;
    renderResults();
  }
  function finish() {
    clearTimeout(closeTimer); closeTimer = null;
    if (active) { if (active.outcome === 'active') active.outcome = 'stopped'; active.finishedAt = new Date().toISOString(); }
    active = null; closing = null;
    if (frame) { frame.src = 'about:blank'; frame.remove(); frame = null; }
    element('player-panel').hidden = true;
    save(); controls(); status('threeDsFinished');
  }
  element('start').addEventListener('click', () => {
    const game = games.find(game => String(game.id) === element('game').value);
    const profile = element('condition').value;
    if (!game || active || !Object.hasOwn(profiles, profile)) return;
    active = { id: crypto.randomUUID(), profile, game: { id: game.id, title: i18n.gameTitle(game) }, startedAt: new Date().toISOString(), outcome: 'active', diagnostics: null };
    runs.push(active); runs = runs.slice(-6); save(); controls();
    frame = node('iframe');
    const params = new URLSearchParams({ id: String(game.id), threads: '1', profile, run: active.id, lang: i18n.language });
    frame.src = '/admin/3ds-player.html?' + params;
    frame.title = t('threeDsTest');
    frame.allow = 'autoplay; fullscreen; gamepad; screen-wake-lock'; frame.allowFullscreen = true;
    element('frame').replaceChildren(frame); element('player-panel').hidden = false;
    status('threeDsRunning'); element('start').blur();
  });
  element('stop').addEventListener('click', () => {
    if (!active || closing) return;
    closing = crypto.randomUUID();
    frame.contentWindow.postMessage({ type: 'retro-vault-player-stop', token: closing }, location.origin);
    closeTimer = setTimeout(() => {
      if (active) active.cleanupAcknowledged = false;
      finish();
    }, 2200);
    controls();
  });
  window.addEventListener('message', event => {
    if (!active || event.origin !== location.origin || event.source !== frame?.contentWindow) return;
    const data = event.data;
    if (data?.type === 'retro-vault-player-error') {
      active.playerError = { key: String(data.key || '').slice(0, 80), message: String(data.message || '').slice(0, 1200) };
      active.outcome = 'error'; save(); renderResults();
    }
    if (data?.type === 'retro-vault-3ds-diagnostics' && data.runId === active.id && data.diagnostics?.test3ds?.runId === active.id) {
      active.diagnostics = data.diagnostics;
      if (data.diagnostics.phase === 'error' && active.outcome === 'active') active.outcome = 'error';
      save();
      // Avoid replacing an open settings table or a focused input every sample.
      if (!element('results').contains(document.activeElement) && !element('results').querySelector('details[open]')) renderResults();
    }
    if (data?.type === 'retro-vault-player-stopped' && closing && data.token === closing) { active.cleanupAcknowledged = true; finish(); }
  });
  element('download').addEventListener('click', () => {
    if (!runs.length) return;
    const report = { schemaVersion: 1, appVersion: '2.18.0', mode: '3ds-comparison', exportedAt: new Date().toISOString(), memoryScope: 'Core WebAssembly region only; not total resident RAM or GPU use.', runs };
    const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }));
    const link = node('a'); link.href = url; link.download = 'retro-vault-3ds-comparison.json'; document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000); element('download').blur();
  });
  element('clear').addEventListener('click', () => { if (active) return; runs = []; save(); controls(); element('clear').blur(); });
  i18n.bindLanguageSelect(document.getElementById('language-select'));
  i18n.onChange(() => {
    for (const option of element('game').options) { const game = games.find(game => String(game.id) === option.value); if (game) option.textContent = i18n.gameTitle(game); }
    if (frame) { frame.title = t('threeDsTest'); frame.contentWindow.postMessage({ type: 'retro-vault-language', language: i18n.language }, location.origin); }
    renderResults(); status();
  });
  fetch('/api/games', { cache: 'no-store' }).then(response => { if (!response.ok) throw new Error('catalog'); return response.json(); }).then(entries => {
    if (!Array.isArray(entries)) throw new Error('catalog');
    games = entries.filter(game => game?.core === '3ds' && Number.isInteger(game.id) && game.id > 0 && typeof game.rom === 'string' && game.rom.length
      && (!game.coreOverride || game.coreOverride === 'azahar' || game.coreOverride === '3ds')
      && (!game.ejsVersion || game.ejsVersion === '4.3.0-pre') && !game.dataPath && !game.bios && !game.patch && !game.gameParent);
    for (const game of games) { const option = node('option', i18n.gameTitle(game)); option.value = String(game.id); element('game').append(option); }
    loading = false; controls(); status(games.length ? (runs.length ? 'threeDsPrevious' : 'threeDsReady') : 'threeDsNoGames');
  }).catch(() => { loading = false; controls(); status('databaseError'); });
  save(); controls(); status(); i18n.apply();
})();
