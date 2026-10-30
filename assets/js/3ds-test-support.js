"use strict";

(() => {
  const baseline = Object.freeze({
    citra_resolution_factor: '1',
    citra_texture_filter: 'none',
    citra_custom_textures: 'disabled',
    citra_dump_textures: 'disabled',
    citra_use_hw_shader_cache: 'enabled',
    citra_use_hw_shaders: 'enabled',
    citra_is_new_3ds: 'Old 3DS'
  });
  const profiles = Object.freeze({
    baseline,
    'shader-cache-off': Object.freeze({ ...baseline, citra_use_hw_shader_cache: 'disabled' }),
    'hardware-shaders-off': Object.freeze({ ...baseline, citra_use_hw_shaders: 'disabled' })
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
      return { profile, runId, options: { ...profiles[profile] } };
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
        actualOptions: {}, optionSource: 'unavailable', stages: [], samples: [], settingsChanges: [],
        saveStorage: 'not-mounted', settingsStorage: 'disabled', changedFromBaseline: Object.keys(baseline).filter(key => config.options[key] !== baseline[key]) };
      this.lastSent = 0;
      this.lastOptions = 0;
      this.lastSample = 0;
      this.lastPhase = '';
      this.lastRomState = '';
    }
    attach(emulator) {
      if (!emulator || this.emulator) return;
      this.emulator = emulator;
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
          return result;
        } finally { fs.mount = mount; }
      };
    }
    observe(diagnostics, emulator, phase) {
      const now = Date.now();
      const elapsedMs = Math.max(0, now - diagnostics.startedAtMs);
      const romState = diagnostics.romIO?.disk?.state || diagnostics.romIO?.state || '';
      const phaseChanged = diagnostics.phase !== this.lastPhase || romState !== this.lastRomState;
      if (phaseChanged) {
        this.state.stages.push({ elapsedMs, phase: diagnostics.phase, romState, bytes: diagnostics.wasmHeapBytes });
        this.state.stages = this.state.stages.slice(-48);
        this.lastPhase = diagnostics.phase;
        this.lastRomState = romState;
      }
      if (now - this.lastSample >= 2000 || phaseChanged || diagnostics.wasmHeapBytes !== this.lastBytes) {
        this.state.samples.push({ elapsedMs, phase: diagnostics.phase, bytes: diagnostics.wasmHeapBytes });
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
