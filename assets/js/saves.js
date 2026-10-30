"use strict";

(() => {
  const I18n = window.RetroI18n;
  const t = (key, values) => I18n.t(key, values);
  const storage = window.RetroSaveStorage;

  class SaveManager {
    constructor(game, onActivity = () => {}) {
      this.game = game;
      this.onActivity = (...args) => { try { onActivity(...args); } catch {} };
      this.gameKey = storage.identity(game);
      this.store = new storage.SaveStorage();
      this.slots = [];
      this.nativePending = Promise.resolve();
      this.nativeRestorers = [];
      this.busy = false;
      this.started = false;
      this.closing = false;
      this.opened = false;
      this.pausedByPanel = false;
      this.confirmation = null;
      this.status = null;
      this.systemFlush = null;
      this.flushAgain = false;
      this.suppressSaveEvent = false;
      this.importSlot = 1;
      this.elements = {};
      for (const id of ["save-root", "save-manager-toggle", "save-manager", "save-manager-heading", "save-manager-close", "save-slots", "state-support", "system-save-status", "save-system-now", "save-manager-status", "save-confirm", "save-confirm-text", "save-confirm-yes", "save-confirm-no", "save-import", "save-current-backup", "save-legacy-import"]) {
        this.elements[id] = document.getElementById(id);
      }
      this.elements["save-manager-toggle"].addEventListener("click", () => {
        this.elements["save-manager-toggle"].blur();
        this.emulator?.menu?.close?.();
        this.open();
      });
      this.onFullscreenChange = () => this.updateSaveEntry();
      this.elements["save-manager-close"].addEventListener("click", () => this.close());
      this.elements["save-system-now"].addEventListener("click", () => this.run(async () => {
        const outcome = await this.flushSystem();
        if (outcome !== "saved") throw Object.assign(new Error(outcome), { name: "SystemSaveFailed" });
        this.setStatus(this.hasSystemData ? "systemSaveDone" : "noSystemSave");
      }));
      this.elements["save-current-backup"].addEventListener("click", () => this.run(async () => {
        this.ensureStates();
        const data = this.emulator.gameManager.getState();
        if (!data?.byteLength) throw new Error("Empty state");
        this.download(this.metadata(this.selectedSlot()), new Blob([data]));
        this.setStatus("backupReady");
      }));
      this.elements["save-legacy-import"].addEventListener("click", () => this.run(async () => {
        this.ensureStates();
        const name = this.emulator.getBaseFileName?.();
        const data = name ? await this.emulator.storage?.states?.get(name + ".state") : null;
        if (!data?.byteLength && !data?.size) { this.setStatus("legacyStateMissing"); return; }
        if (!await this.ask("confirmLegacyState")) return;
        await this.writeSlot(1, data);
      }));
      this.elements["save-import"].addEventListener("change", event => {
        const file = event.target.files?.[0];
        const slot = this.importSlot;
        event.target.value = "";
        if (file) this.run(() => this.importFile(slot, file));
      });
      this.elements["save-confirm-yes"].addEventListener("click", () => this.answer(true));
      this.elements["save-confirm-no"].addEventListener("click", () => this.answer(false));
      this.elements["save-manager"].addEventListener("keydown", event => this.onKey(event));
      this.unsubscribe = I18n.onChange(() => this.render());
    }

    get emulator() { return window.EJS_emulator; }

    current() {
      return {
        gameKey: this.gameKey,
        core: this.emulator?.getCore?.() || window.EJS_core || this.game.core,
        emulatorVersion: this.emulator?.ejs_version || this.game.ejsVersion || "4.3.0-pre"
      };
    }

    metadata(slot) {
      return { ...this.current(), slot, title: this.game.title, savedAt: new Date().toISOString() };
    }

    selectedSlot() {
      const slot = Number(this.emulator?.getSettingValue?.('save-state-slot') || this.emulator?.settings?.['save-state-slot'] || 1);
      return Number.isInteger(slot) && slot >= 1 && slot <= 9 ? slot : 1;
    }

    selectSlot(slot) {
      if (this.closing) return;
      this.emulator?.changeSettingOption?.('save-state-slot', String(slot));
      this.render();
    }

    queueNative(action) {
      const pending = this.nativePending.catch(() => {}).then(action);
      this.nativePending = pending;
      pending.catch(reason => {
        this.setError(reason);
        this.onActivity('state-persist-failed');
        window.RetroNotices?.notify('save-state', { key: this.status.key, error: true });
      });
      return pending;
    }

    attachNativeSlots() {
      const emulator = this.emulator;
      const manager = emulator?.gameManager;
      if (typeof manager?.quickSave !== 'function' || typeof manager?.quickLoad !== 'function' || !manager.FS?.readFile || !manager.FS?.writeFile) return;
      const owner = this;
      const originalSave = manager.quickSave;
      const originalLoad = manager.quickLoad;
      const wrap = (target, name, wrapped) => {
        const original = target[name]; target[name] = wrapped;
        this.nativeRestorers.push(() => { if (target[name] === wrapped) target[name] = original; });
      };
      wrap(manager, 'quickSave', function(slot = 1) {
        if (owner.closing || owner.busy || !owner.supportsStates()) return false;
        slot = Number(slot);
        if (!Number.isInteger(slot) || slot < 1 || slot > 9) return false;
        const result = originalSave.call(this, slot);
        if (!result) return result;
        // Capture an immutable snapshot before another hotkey overwrites MEMFS.
        try {
          const data = new Blob([manager.FS.readFile('/' + slot + '-quick.state')]);
          owner.persistNativeSnapshot(slot, data);
        } catch (reason) { owner.setError(reason); return false; }
        return result;
      });
      wrap(manager, 'quickLoad', function(slot = 1) {
        if (owner.closing || owner.busy || !owner.supportsStates()) return;
        slot = Number(slot);
        owner.queueNative(async () => {
          if (owner.closing) return;
          const record = await owner.store.get(owner.gameKey, slot);
          if (!record?.data?.size) { owner.setStatus('emptySaveSlot'); window.RetroNotices?.notify('save-state', { key: 'emptySaveSlot' }); return; }
          if (!storage.compatible(record.metadata, owner.current())) throw Object.assign(new Error('Mismatch'), { name: 'SaveStateMismatch' });
          manager.FS.writeFile('/' + slot + '-quick.state', new Uint8Array(await record.data.arrayBuffer()));
          originalLoad.call(manager, slot);
          owner.setStatus('stateLoadDone', { slot });
        });
      });
      const originalChange = emulator.changeSettingOption;
      if (typeof originalChange === 'function') wrap(emulator, 'changeSettingOption', function(key, value) {
        const result = Reflect.apply(originalChange, this, arguments);
        if (key === 'save-state-slot') owner.render();
        return result;
      });
      // The native toolbar and keyboard shortcuts share the same durable slots.
      emulator.on?.('saveState', event => {
        if (owner.closing || owner.busy || !event?.state?.byteLength) return;
        const slot = owner.selectedSlot();
        const data = new Blob([event.state]);
        owner.persistNativeSnapshot(slot, data);
      });
      emulator.on?.('loadState', () => manager.quickLoad(owner.selectedSlot()));
    }

    persistNativeSnapshot(slot, data) {
      const metadata = this.metadata(slot);
      return this.queueNative(async () => {
        await this.store.put(metadata, data);
        await this.refresh();
        this.setStatus('stateSaveDone', { slot });
        if (!this.opened && !this.closing) window.RetroNotices?.notify('save-state', { key: 'stateSaveDone', values: { slot } });
        this.onActivity('state-persisted');
      });
    }

    async start() {
      if (this.started || this.closing) return;
      this.started = true;
      this.attachNativeSlots();
      // The native fullscreen element must contain the save controls as well.
      const host = this.emulator?.elements?.parent || document.body;
      host.appendChild(this.elements["save-root"]);
      this.fullscreenHost = host;
      this.toolbar = this.emulator?.elements?.menu;
      if (this.toolbar) this.toolbar.appendChild(this.elements["save-manager-toggle"]);
      document.addEventListener("fullscreenchange", this.onFullscreenChange);
      document.addEventListener("webkitfullscreenchange", this.onFullscreenChange);
      this.updateSaveEntry();
      this.emulator?.on?.("saveSaveFiles", data => {
        if (this.closing || this.suppressSaveEvent) return;
        this.hasSystemData = !!(data?.byteLength || data?.size);
        // IDBFS already persists native writes. Do not schedule a second flush.
        this.onActivity("native-save-event", { hasSystemData: this.hasSystemData });
      });
      try {
        const savedAt = window.localStorage.getItem("retro-vault-system-save:" + this.gameKey);
        if (savedAt && Number.isFinite(Date.parse(savedAt))) this.systemSavedAt = savedAt;
      } catch {}
      await this.refresh();
    }

    updateSaveEntry() {
      const fullscreen = document.fullscreenElement || document.webkitFullscreenElement;
      const playerIsFullscreen = !!fullscreen &&
        (fullscreen === this.fullscreenHost || fullscreen.contains?.(this.fullscreenHost));
      this.elements["save-manager-toggle"].hidden = !this.started || this.closing || !this.toolbar || !playerIsFullscreen;
    }

    async refresh() {
      try {
        this.slots = await this.store.list(this.gameKey);
        this.storageFailed = false;
      } catch (reason) {
        this.storageFailed = true;
        this.setError(reason);
      }
      this.render();
    }

    formatDate(value) {
      const date = new Date(value);
      return Number.isFinite(date.getTime()) ? date.toLocaleString(I18n.language === "ja" ? "ja-JP" : "en-US") : "";
    }

    render() {
      if (this.closing || !this.opened) return;
      const gameTitle = document.getElementById("save-game-title");
      if (gameTitle) gameTitle.textContent = I18n.gameTitle(this.game);
      this.elements["system-save-status"].textContent = this.systemSavedAt
        ? t("systemSavedAt", { date: this.formatDate(this.systemSavedAt) }) : t("systemNotSaved");
      const list = this.elements["save-slots"];
      this.elements["state-support"].hidden = this.supportsStates();
      list.replaceChildren();
      for (let slot = 1; slot <= 9; slot += 1) {
        const metadata = this.slots.find(item => item.slot === slot);
        const row = document.createElement("section");
        row.className = "rv-save-slot";
        row.classList.toggle("rv-save-selected", slot === this.selectedSlot());
        const title = document.createElement("h3");
        title.id = "rv-slot-title-" + slot;
        title.textContent = t(slot === this.selectedSlot() ? "selectedSaveSlot" : "saveSlotName", { slot });
        row.setAttribute("aria-labelledby", title.id);
        const date = document.createElement("p");
        date.textContent = metadata ? t("stateSavedAt", { date: this.formatDate(metadata.savedAt) }) : t("emptySaveSlot");
        row.append(title, date);
        if (metadata && !storage.compatible(metadata, this.current())) {
          const warning = document.createElement("p");
          warning.className = "rv-save-warning";
          warning.textContent = t("stateVersionMismatch");
          row.appendChild(warning);
        }
        const actions = document.createElement("div");
        actions.className = "rv-save-actions";
        for (const [key, action, disabled] of [
          ["selectSaveSlot", () => this.selectSlot(slot), slot === this.selectedSlot()],
          ["saveHere", () => this.saveState(slot), !this.supportsStates()],
          ["loadHere", () => this.loadState(slot), !metadata || !storage.compatible(metadata, this.current()) || !this.supportsStates()],
          ["downloadBackup", () => this.exportSlot(slot), !metadata],
          ["importBackup", () => this.chooseImport(slot), !this.supportsStates()],
          ["deleteSave", () => this.deleteSlot(slot), !metadata]
        ]) {
          const button = document.createElement("button");
          button.type = "button";
          button.dataset.saveAction = key;
          button.textContent = t(key);
          button.disabled = this.busy || disabled;
          button.addEventListener("click", () => { button.blur(); this.run(action); });
          actions.appendChild(button);
        }
        row.appendChild(actions);
        list.appendChild(row);
      }
      for (const id of ["save-system-now", "save-current-backup", "save-legacy-import"]) {
        this.elements[id].disabled = this.busy || (id !== "save-system-now" && !this.supportsStates());
      }
      this.elements["save-manager-status"].textContent = this.status ? t(this.status.key, this.status.values) : "";
      this.elements["save-manager-status"].classList.toggle("rv-save-warning", !!this.status?.error);
      this.elements["save-manager"].setAttribute("aria-busy", this.busy ? "true" : "false");
      if (this.confirmation) this.elements["save-confirm-text"].textContent = t(this.confirmation.key, this.confirmation.values);
    }

    supportsStates() {
      try { return this.started && this.emulator?.gameManager?.supportsStates?.() === true; }
      catch { return false; }
    }

    ensureStates() {
      if (!this.supportsStates()) throw Object.assign(new Error("Unsupported"), { name: "SaveStatesUnsupported" });
    }

    setStatus(key, values = {}, error = false) {
      this.status = { key, values, error };
      this.render();
    }

    setError(reason) {
      const name = reason?.name || "";
      const key = name === "QuotaExceededError" ? "saveStorageFull"
        : name === "SaveConflict" ? "saveConflict"
        : /SaveStorage|SecurityError|InvalidStateError/.test(name) ? "saveStorageUnavailable"
        : name === "SaveStatesUnsupported" ? "saveStatesUnsupported"
        : name === "InvalidStateSize" ? "invalidStateSize"
        : name === "InvalidStateBackup" ? "invalidStateBackup"
        : name === "SaveStateMismatch" ? "stateVersionMismatch"
        : "saveOperationFailed";
      this.setStatus(key, {}, true);
    }

    async run(action) {
      if (this.busy || this.closing || !this.started) return;
      this.busy = true;
      this.setStatus("saveWorking");
      try {
        this.pendingOperation = (async () => { await this.nativePending.catch(() => {}); if (!this.closing) return action(); })();
        await this.pendingOperation;
      }
      catch (reason) { this.setError(reason); }
      finally {
        this.pendingOperation = null;
        this.busy = false;
        this.render();
        if (this.opened && !this.elements["save-manager"].contains(document.activeElement)) {
          this.elements["save-manager-heading"].focus({ preventScroll: true });
        }
      }
    }

    async open() {
      if (!this.started || this.closing) return;
      if (!this.opened) {
        this.returnFocus = document.activeElement;
        this.opened = true;
        this.pausedByPanel = this.emulator?.paused === false;
        if (this.pausedByPanel) this.emulator.pause();
        this.elements["save-manager"].hidden = false;
        this.elements["save-manager-heading"].focus({ preventScroll: true });
      }
      if (!this.busy) await this.refresh();
    }

    close() {
      if (this.busy && !this.confirmation) return;
      this.answer(false);
      this.opened = false;
      this.elements["save-manager"].hidden = true;
      if (this.pausedByPanel && !this.closing && !document.hidden) this.emulator?.play?.();
      this.pausedByPanel = false;
      this.returnFocus?.focus?.({ preventScroll: true });
    }

    onKey(event) {
      if (event.key === "Escape") {
        event.preventDefault();
        if (this.confirmation) this.answer(false);
        else this.close();
      }
      if (event.key !== "Tab") return;
      const scope = this.confirmation ? this.elements["save-confirm"] : this.elements["save-manager"];
      const controls = [...scope.querySelectorAll("button:not(:disabled), input:not([type=hidden]), [tabindex='0']")]
        .filter(element => element.getClientRects().length > 0);
      if (!controls.length) { event.preventDefault(); return; }
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (event.shiftKey && (document.activeElement === first || !controls.includes(document.activeElement))) {
        event.preventDefault(); last.focus();
      } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }

    ask(key, values = {}) {
      if (this.closing) return Promise.resolve(false);
      this.elements["save-confirm"].hidden = false;
      return new Promise(resolve => {
        this.confirmation = { key, values, resolve };
        this.render();
        this.elements["save-confirm"].focus({ preventScroll: true });
      });
    }

    answer(value) {
      const confirmation = this.confirmation;
      this.confirmation = null;
      this.elements["save-confirm"].hidden = true;
      confirmation?.resolve(value);
      if (confirmation && !value && !this.closing) this.setStatus("saveActionCancelled");
      if (confirmation && this.opened && !this.closing) this.elements["save-manager-heading"].focus({ preventScroll: true });
    }

    async writeSlot(slot, data) {
      // Recheck before a destructive operation in case another tab wrote a save.
      this.slots = await this.store.list(this.gameKey);
      const previous = this.slots.find(item => item.slot === slot);
      if (previous && !await this.ask("confirmOverwrite", { slot })) return;
      if (this.closing) return;
      await this.store.put(this.metadata(slot), data, previous?.revision || previous?.savedAt || null);
      this.selectSlot(slot);
      await this.refresh();
      this.setStatus("stateSaveDone", { slot });
    }

    async saveState(slot) {
      this.ensureStates();
      // Request a state only for a manual action; never allocate one on a timer.
      this.slots = await this.store.list(this.gameKey);
      const previous = this.slots.find(item => item.slot === slot);
      if (previous && !await this.ask("confirmOverwrite", { slot })) return;
      if (this.closing) return;
      const data = this.emulator.gameManager.getState();
      if (!data?.byteLength) throw new Error("Empty state");
      await this.store.put(this.metadata(slot), data, previous?.revision || previous?.savedAt || null);
      this.selectSlot(slot);
      await this.refresh();
      this.setStatus("stateSaveDone", { slot });
    }

    async loadState(slot) {
      this.ensureStates();
      const record = await this.store.get(this.gameKey, slot);
      if (!record?.data?.size) { this.setStatus("emptySaveSlot"); return; }
      if (!storage.compatible(record.metadata, this.current())) throw Object.assign(new Error("Mismatch"), { name: "SaveStateMismatch" });
      if (!await this.ask("confirmLoadState", { slot })) return;
      if (this.closing) return;
      this.selectSlot(slot);
      this.emulator.gameManager.loadState(new Uint8Array(await record.data.arrayBuffer()));
      this.setStatus("stateLoadDone", { slot });
    }

    download(metadata, data) {
      const blob = storage.makeBackup(metadata, data);
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      const title = String(this.game.title).replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80) || "game";
      link.href = url;
      link.download = `${title}-slot-${metadata.slot}.rvstate`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
    }

    async exportSlot(slot) {
      const record = await this.store.get(this.gameKey, slot);
      if (!record) { this.setStatus("emptySaveSlot"); return; }
      this.download(record.metadata, record.data);
      this.setStatus("backupReady");
    }

    chooseImport(slot) {
      this.importSlot = slot;
      this.elements["save-import"].value = "";
      this.elements["save-import"].click();
      this.setStatus("chooseStateBackup");
    }

    async importFile(slot, file) {
      this.ensureStates();
      const backup = await storage.readBackup(file);
      if (backup.metadata && !storage.compatible(backup.metadata, this.current())) {
        throw Object.assign(new Error("Mismatch"), { name: "SaveStateMismatch" });
      }
      if (!backup.metadata && !await this.ask("confirmRawState", { title: I18n.gameTitle(this.game) })) return;
      await this.writeSlot(slot, backup.data);
    }

    async deleteSlot(slot) {
      const metadata = (await this.store.list(this.gameKey)).find(item => item.slot === slot);
      if (!await this.ask("confirmDeleteState", { slot }) || this.closing) return;
      await this.store.remove(this.gameKey, slot, metadata?.revision || metadata?.savedAt || null);
      try { this.emulator.gameManager.FS.unlink("/" + slot + "-quick.state"); } catch {}
      await this.refresh();
      this.setStatus("stateDeleted", { slot });
    }

    async flushSystem() {
      if (!this.started || this.closing) return "not-needed";
      this.onActivity("manual-save-request");
      this.suppressSaveEvent = true;
      try { this.emulator.gameManager.saveSaveFiles(); }
      finally { this.suppressSaveEvent = false; }
      return this.flushExistingSystem();
    }

    flushExistingSystem() {
      if (this.systemFlush) {
        this.flushAgain = true;
        this.onActivity("save-flush-queued");
        return this.systemFlush;
      }
      const manager = this.emulator?.gameManager;
      if (!manager?.FS?.syncfs) return Promise.resolve("not-needed");
      this.onActivity("save-flush-start");
      this.systemFlush = new Promise(resolve => {
        let finished = false;
        const done = result => {
          if (finished) return;
          finished = true;
          clearTimeout(timeout);
          if (result === "saved") {
            let data;
            try { data = manager.getSaveFile?.(false); } catch {}
            this.hasSystemData = !!(data?.byteLength || data?.size);
            if (this.hasSystemData) {
              this.systemSavedAt = new Date().toISOString();
              try { window.localStorage.setItem("retro-vault-system-save:" + this.gameKey, this.systemSavedAt); } catch {}
            }
          } else if (!this.closing) {
            this.setStatus("systemSaveFailed", {}, true);
          }
          this.render();
          this.onActivity("save-flush-end", { result });
          resolve(result);
        };
        const timeout = setTimeout(() => done("timed-out"), 1200);
        const flush = () => {
          this.flushAgain = false;
          try {
            manager.FS.syncfs(false, reason => {
              if (finished) return;
              if (reason) { done("failed"); return; }
              if (this.flushAgain) flush();
              else done("saved");
            });
          } catch { done("failed"); }
        };
        flush();
      }).finally(() => { this.systemFlush = null; });
      return this.systemFlush;
    }

    stop() {
      this.closing = true;
      for (const restore of this.nativeRestorers.reverse()) restore();
      this.answer(false);
      this.pausedByPanel = false;
      this.elements["save-manager-toggle"].hidden = true;
      document.removeEventListener("fullscreenchange", this.onFullscreenChange);
      document.removeEventListener("webkitfullscreenchange", this.onFullscreenChange);
      this.elements["save-manager"].hidden = true;
      this.unsubscribe?.();
    }
  }

  window.RetroSaveManager = SaveManager;
})();
