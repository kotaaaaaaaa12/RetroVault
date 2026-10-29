"use strict";

(() => {
  class ResourceDiagnostics {
    constructor({ onChange, onReadFailure }) {
      this.onChange = onChange;
      this.onReadFailure = onReadFailure;
      this.requests = [];
      this.localRom = null;
      this.restorers = [];
      this.stopped = false;
      this.sequence = 0;
      this.hook(window, 'fetch', original => {
        const support = this;
        return function(input, options) {
          const started = Date.now();
          const entry = {
            id: ++support.sequence, at: new Date().toISOString(),
            method: String(options?.method || input?.method || 'GET').slice(0, 12),
            resource: support.describe(input), outcome: 'pending', status: null
          };
          support.requests = [...support.requests, entry].slice(-12);
          const finish = (outcome, response, error) => {
            if (support.stopped) return;
            entry.outcome = outcome; entry.elapsedMs = Date.now() - started;
            if (response) entry.status = response.status;
            if (error) { entry.errorName = String(error.name || 'Error').slice(0, 80); }
            support.onChange?.();
          };
          try {
            return Promise.resolve(Reflect.apply(original, this, arguments)).then(response => {
              finish(response.ok ? 'response' : 'http-error', response);
              return response;
            }, error => { finish('failed', null, error); throw error; });
          } catch (error) { finish('failed', null, error); throw error; }
        };
      });
    }
    describe(input) {
      try {
        const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url, window.location.href || window.location.origin);
        if (['blob:', 'data:'].includes(url.protocol)) return url.protocol + '[local]';
        // Exclude credentials, query strings, and fragments from exported logs.
        return (url.origin + url.pathname).slice(0, 400);
      } catch { return '[unavailable]'; }
    }
    hook(target, name, factory) {
      if (!target || typeof target[name] !== 'function') return false;
      const own = Object.getOwnPropertyDescriptor(target, name);
      const wrapped = factory(target[name]);
      try {
        Object.defineProperty(target, name, { configurable: true, writable: true, value: wrapped });
        this.restorers.push(() => {
          if (target[name] !== wrapped) return;
          if (own) Object.defineProperty(target, name, own); else delete target[name];
        });
        return true;
      } catch { return false; }
    }
    trackFile(file) {
      const support = this;
      this.localRom = { source: 'file', size: file.size, extension: String(file.name.split('.').pop() || '').slice(0, 16).toLowerCase(), readState: 'waiting', readAttempts: 0 };
      this.localRom.tracked = this.hook(file, 'arrayBuffer', original => async function() {
        const info = support.localRom;
        const started = Date.now();
        info.readAttempts++; info.readState = 'reading'; support.onChange?.();
        try {
          const result = await Reflect.apply(original, this, arguments);
          if (!support.stopped) { info.readState = 'read'; info.readBytes = result.byteLength; info.readMs = Date.now() - started; support.onChange?.(); }
          return result;
        } catch (error) {
          if (!support.stopped) {
            info.readState = 'failed'; info.errorName = String(error.name || 'Error').slice(0, 80); info.error = String(error.message || error).slice(0, 300);
            support.onChange?.(); support.onReadFailure?.(error);
          }
          throw error;
        }
      });
      this.onChange?.();
    }
    stop() {
      this.stopped = true;
      for (const restore of this.restorers.reverse()) { try { restore(); } catch {} }
      this.restorers = [];
    }
  }
  window.RetroResourceDiagnostics = ResourceDiagnostics;
})();
