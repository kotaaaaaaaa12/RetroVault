"use strict";

(() => {
  class RuntimeSupport {
    constructor({ contexts, onFailure, onChange }) {
      this.contexts = contexts;
      this.onFailure = onFailure;
      this.onChange = onChange;
      this.emulator = null;
      this.stopped = false;
      this.restorers = [];
      this.wrapped = new WeakMap();
      this.failures = [];
      this.input = { pointerEvents: 0, touchEvents: 0, keyEvents: 0, virtualControlEvents: 0, coreInputCalls: 0, canvasPointerEvents: 0, canvasTouchEvents: 0 };
      this.audioCheck = "native";
      this.coreLog = [];
      this.coreIssues = [];
      for (const name of ["getGamepads", "webkitGetGamepads"]) this.trace(window.navigator, name, "navigator." + name);
      this.trace(window.navigator?.mediaDevices, "getUserMedia", "mediaDevices.getUserMedia");
      const input = event => {
        if (!this.emulator?.started || this.stopped) return;
        const key = event.type === "keydown" ? "keyEvents" : event.type === "touchstart" ? "touchEvents" : "pointerEvents";
        this.input[key] = Math.min(1000000, this.input[key] + 1);
        if (event.target === this.emulator.canvas) {
          const canvasKey = event.type === 'touchstart' ? 'canvasTouchEvents' : event.type === 'pointerdown' ? 'canvasPointerEvents' : null;
          if (canvasKey) this.input[canvasKey] = Math.min(1000000, this.input[canvasKey] + 1);
        }
        if (event.target?.closest?.('.ejs_virtualGamepad_button, .ejs_dpad_main')) this.input.virtualControlEvents = Math.min(1000000, this.input.virtualControlEvents + 1);
        if (this.input[key] === 1) this.onChange?.();
      };
      const resume = event => {
        if (event.isTrusted !== true || this.stopped || document.hidden || this.emulator?.paused) return;
        for (const context of this.contexts()) {
          if (!["suspended", "interrupted"].includes(context.state) || typeof context.resume !== "function") continue;
          // Keep resume inside the trusted gesture; do not consume the input.
          try { Promise.resolve(context.resume()).catch(() => {}); } catch {}
        }
      };
      for (const type of ["pointerdown", "touchstart", "keydown"]) this.listen(type, input);
      for (const type of ["pointerup", "touchend", "keydown"]) this.listen(type, resume);
    }
    listen(type, handler) {
      document.addEventListener(type, handler, { capture: true, passive: true });
      this.restorers.push(() => document.removeEventListener(type, handler, true));
    }
    replace(target, name, create) {
      if (!target || typeof target[name] !== "function") return;
      const names = this.wrapped.get(target) || new Set();
      if (names.has(name)) return;
      const own = Object.getOwnPropertyDescriptor(target, name);
      const original = target[name];
      const wrapped = create(original);
      try {
        target[name] = wrapped;
        if (target[name] !== wrapped) return;
        names.add(name); this.wrapped.set(target, names);
        this.restorers.push(() => {
          if (target[name] !== wrapped) return;
          if (own) Object.defineProperty(target, name, own); else delete target[name];
        });
      } catch {}
    }
    failed(error, operation) {
      if (this.stopped) return;
      const name = String(error?.name || "Error").slice(0, 80);
      const detail = String(error?.message || error).slice(0, 500);
      const previous = this.failures.find(item => item.operation === operation && item.name === name && item.detail === detail);
      if (previous) { previous.count = Math.min(1000000, previous.count + 1); return; }
      this.failures.push({ at: new Date().toISOString(), operation, name, detail, count: 1 });
      this.failures = this.failures.slice(-4);
      this.onFailure?.(error, operation);
    }
    trace(target, name, operation) {
      this.replace(target, name, original => {
        const support = this;
        return function(...args) {
          let result;
          try { result = Reflect.apply(original, this, args); }
          catch (error) { support.failed(error, operation); throw error; }
          if (result && typeof result.then === "function") {
            // Record a named failure even when Safari provides no stack.
            Promise.resolve(result).catch(error => support.failed(error, operation));
          }
          return result;
        };
      });
    }
    trackContext(context) { this.trace(context, "resume", "AudioContext.resume"); }
    coreOutput(source, args) {
      if (this.stopped) return;
      const detail = args.filter(value => typeof value === 'string' || typeof value === 'number')
        .slice(0, 3).map(value => String(value).slice(0, 500)).join(' ')
        .replace(/\x1b\[[0-9;]*m/g, '')
        .replace(/https?:\/\/[^\s"'<>]+/g, value => {
          try { const url = new URL(value); return url.origin + url.pathname; } catch { return '[url]'; }
        }).slice(0, 500);
      if (!detail) return;
      const last = this.coreLog.at(-1);
      if (last?.source === source && last.detail === detail) last.count = Math.min(1000000, last.count + 1);
      else {
        const item = { source, detail, count: 1 };
        this.coreLog = [...this.coreLog, item].slice(-20);
        if (/\[(?:ERROR|FATAL|CRITICAL)\]|<(?:Error|Critical)>|SET_MESSAGE:.*(?:failed|error|encrypted|unsupported|invalid)|^\s*(?:failed|error|fatal|unsupported|invalid|aborted)\b/i.test(detail)) {
          // Keep the first failures even if secondary shutdown/configuration
          // errors follow the original cause.
          this.coreIssues = this.coreIssues.length < 6 ? [...this.coreIssues, item]
            : [...this.coreIssues.slice(0, 3), ...this.coreIssues.slice(-2), item];
        }
      }
      // Native output can be frequent. Persist at most once per second;
      // errors remain in a separate bounded list when later output rolls over.
      if (!this.coreLogTimer) this.coreLogTimer = setTimeout(() => {
        this.coreLogTimer = null; if (!this.stopped) this.onChange?.();
      }, 1000);
    }
    attachCoreModule(module) {
      if (!module || this.stopped) return;
      this.coreModule = module;
      this.replace(module, 'callMain', original => {
        const support = this;
        return function(args = [], ...rest) {
          support.coreStartup.mainInvoked = true;
          const options = Array.isArray(args) ? [...args] : args;
          if (Array.isArray(options) && !options.includes('-v')) options.unshift('-v');
          try {
            const result = Reflect.apply(original, this, [options, ...rest]);
            support.coreStartup.mainReturned = true;
            if (Number.isFinite(result)) support.coreStartup.mainReturnCode = result;
            support.onChange?.();
            return result;
          } catch (error) {
            support.coreOutput('callMain', [error?.message || String(error)]);
            throw error;
          }
        };
      });
    }
    traceCore(emulator) {
      if (this.coreStartup) return;
      this.coreStartup = { mainInvoked: false, mainReturned: false, graphics: [] };
      this.replace(emulator.canvas, 'getContext', original => {
        const support = this;
        return function(type, ...args) {
          const result = Reflect.apply(original, this, [type, ...args]);
          if (['webgl', 'webgl2', 'experimental-webgl'].includes(type)) {
            support.coreStartup.graphics = [...support.coreStartup.graphics, { type, created: !!result }].slice(-4);
          }
          return result;
        };
      });
      this.replace(emulator, 'initModule', original => {
        const support = this;
        return function(...args) {
          // The core factory reads print/printErr once during initialization.
          // Hook its options before the native frontend invokes it; replacing
          // Module.print afterward would miss Emscripten's captured callbacks.
          support.replace(window, 'EJS_Runtime', factory => function(options = {}, ...rest) {
            const configured = { ...options };
            for (const name of ['print', 'printErr']) {
              const callback = options[name];
              configured[name] = function(...output) {
                support.coreOutput(name, output);
                if (typeof callback === 'function') return Reflect.apply(callback, this, output);
              };
            }
            return Promise.resolve(Reflect.apply(factory, this, [configured, ...rest])).then(module => {
              support.attachCoreModule(module); return module;
            });
          });
          return Reflect.apply(original, this, args);
        };
      });
    }
    nativeSnapshot() {
      if (!this.coreStartup) return null;
      if (!this.stopped) {
        const canvas = this.emulator?.canvas;
        if (canvas) this.coreStartup.canvas = { width: canvas.width, height: canvas.height, clientWidth: canvas.clientWidth, clientHeight: canvas.clientHeight };
        this.coreStartup.frontendStarted = this.emulator?.started === true;
      }
      return { startup: this.coreStartup, log: this.coreLog, issues: this.coreIssues };
    }
    attach(emulator) {
      if (!emulator || this.stopped) return;
      this.emulator = emulator;
      const host = emulator.elements?.parent;
      const core = emulator.getCore?.();
      if (emulator.ejs_version === '4.3.0-pre' && core === 'azahar') this.traceCore(emulator);
      if (emulator.ejs_version === '4.3.0-pre' && ['nds', 'melonds', 'desmume', 'desmume2015'].includes(core) && host?.classList && !this.dsTouchHost) {
        const alreadyEnabled = host.classList.contains('rv-ds-touch');
        host.classList.add('rv-ds-touch');
        this.dsTouchHost = host;
        this.restorers.push(() => { if (!alreadyEnabled) host.classList.remove('rv-ds-touch'); this.dsTouchHost = null; });
      }
      if (emulator.isSafari && emulator.isMobile && emulator.ejs_version === "4.3.0-pre") {
        this.replace(emulator, "checkStarted", () => () => {
          // The prerelease assumes OpenAL.currentCtx exists. RWebAudio need not
          // create it; use tracked contexts and later gestures instead of a popup.
          this.audioCheck = "gesture-recovery";
          this.onChange?.();
        });
      }
      this.replace(emulator.gameManager, "simulateInput", original => {
        const support = this;
        return function(...args) {
          support.input.coreInputCalls = Math.min(1000000, support.input.coreInputCalls + 1);
          if (support.input.coreInputCalls === 1) support.onChange?.();
          return Reflect.apply(original, this, args);
        };
      });
      for (const name of ["requestFullscreen", "webkitRequestFullscreen", "webkitRequestFullScreen"]) this.trace(emulator.elements?.parent, name, "Element." + name);
      for (const name of ["requestPointerLock", "mozRequestPointerLock"]) this.trace(emulator.canvas, name, "Element." + name);
    }
    snapshot() {
      const result = { ...this.input, audioCheck: this.audioCheck };
      if (this.dsTouchHost) result.dsTouchRouting = "canvas-and-controls";
      try {
        if (['nds', 'melonds'].includes(this.emulator?.getCore?.())) {
          const mode = this.emulator.getSettingValue?.('melonds_touch_mode') || this.emulator.settings?.melonds_touch_mode;
          if (['Mouse', 'Touch', 'Joystick', 'disabled'].includes(mode)) this.dsTouchMode = mode;
        }
      } catch {}
      if (this.dsTouchMode) result.dsTouchMode = this.dsTouchMode;
      const device = this.emulator?.settings?.['controller-port-device-p1'];
      if (/^\d{1,8}$/.test(String(device))) result.controllerPort1 = Number(device);
      try { if (typeof this.emulator?.isPopupOpen === "function") result.nativePopupOpen = this.emulator.isPopupOpen() === true; } catch {}
      return result;
    }
    stop() {
      if (this.stopped) return;
      this.snapshot();
      this.nativeSnapshot();
      this.stopped = true;
      clearTimeout(this.coreLogTimer);
      for (const restore of this.restorers.reverse()) { try { restore(); } catch {} }
      this.restorers = [];
      this.emulator = null;
    }
  }
  window.RetroRuntimeSupport = RuntimeSupport;
})();
