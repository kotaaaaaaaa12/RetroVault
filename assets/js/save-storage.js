"use strict";

// Store payloads separately so listing slots never reads large state buffers.
(() => {
  const MAX_STATE_BYTES = 256 * 1024 * 1024;
  const MAGIC = new TextEncoder().encode("RVSTATE1\n");
  const error = name => Object.assign(new Error(name), { name });
  const keyFor = (gameKey, slot) => JSON.stringify([gameKey, slot]);

  function validateSlot(slot) {
    if (!Number.isInteger(slot) || slot < 1 || slot > 9) throw error("InvalidSaveSlot");
  }

  function identity(game) {
    // Local file modification dates can change when a file is selected again.
    const source = typeof game.localFilename === "string"
      ? ["local", game.localFilename, game.localSize]
      : ["library", game.id];
    return JSON.stringify([...source, game.core]);
  }

  function compatible(metadata, current) {
    return metadata.gameKey === current.gameKey && metadata.core === current.core &&
      metadata.emulatorVersion === current.emulatorVersion;
  }

  class SaveStorage {
    constructor(indexedDB = window.indexedDB) {
      this.indexedDB = indexedDB;
      this.database = null;
    }

    open() {
      if (this.database) return this.database;
      if (!this.indexedDB) return Promise.reject(error("SaveStorageUnavailable"));
      this.database = new Promise((resolve, reject) => {
        let request;
        let blocked = false;
        try { request = this.indexedDB.open("RetroVault-saves", 1); }
        catch (reason) { reject(reason); return; }
        request.onupgradeneeded = () => {
          const db = request.result;
          db.createObjectStore("states", { keyPath: "key" });
          const metadata = db.createObjectStore("metadata", { keyPath: "key" });
          metadata.createIndex("gameKey", "gameKey", { unique: false });
        };
        request.onerror = () => reject(request.error || error("SaveStorageUnavailable"));
        request.onblocked = () => { blocked = true; reject(error("SaveStorageBlocked")); };
        request.onsuccess = () => {
          const db = request.result;
          if (blocked) { db.close(); return; }
          db.onversionchange = () => { db.close(); this.database = null; };
          resolve(db);
        };
      }).catch(reason => { this.database = null; throw reason; });
      return this.database;
    }

    async transaction(stores, mode, run) {
      const db = await this.open();
      return new Promise((resolve, reject) => {
        let result;
        let failure;
        let tx;
        try { tx = db.transaction(stores, mode); }
        catch (reason) { reject(reason); return; }
        tx.oncomplete = () => resolve(result);
        tx.onabort = () => reject(failure || tx.error || error("SaveTransactionFailed"));
        tx.onerror = () => {};
        const capture = request => {
          request.onsuccess = () => { result = request.result; };
          return request;
        };
        const fail = reason => { failure = reason; tx.abort(); };
        try { run(tx, capture, fail); }
        catch (reason) { tx.abort(); reject(reason); }
      });
    }

    list(gameKey) {
      return this.transaction(["metadata"], "readonly", (tx, capture) => {
        capture(tx.objectStore("metadata").index("gameKey").getAll(gameKey));
      });
    }

    get(gameKey, slot) {
      validateSlot(slot);
      return this.transaction(["states"], "readonly", (tx, capture) => {
        capture(tx.objectStore("states").get(keyFor(gameKey, slot)));
      });
    }

    put(metadata, payload, expectedRevision) {
      validateSlot(metadata.slot);
      const data = payload instanceof Blob ? payload : new Blob([payload]);
      if (!data.size || data.size > MAX_STATE_BYTES) return Promise.reject(error("InvalidStateSize"));
      const key = keyFor(metadata.gameKey, metadata.slot);
      return this.transaction(["states", "metadata"], "readwrite", (tx, capture, fail) => {
        const request = tx.objectStore("metadata").get(key);
        request.onsuccess = () => {
          const current = request.result?.revision || request.result?.savedAt || null;
          if (expectedRevision !== undefined && current !== expectedRevision) { fail(error("SaveConflict")); return; }
          const record = { ...metadata, key, bytes: data.size, revision: Date.now() + "-" + Math.random().toString(36).slice(2) };
          tx.objectStore("states").put({ key, metadata: record, data });
          tx.objectStore("metadata").put(record);
        };
      });
    }

    remove(gameKey, slot, expectedRevision) {
      validateSlot(slot);
      const key = keyFor(gameKey, slot);
      return this.transaction(["states", "metadata"], "readwrite", (tx, capture, fail) => {
        const request = tx.objectStore("metadata").get(key);
        request.onsuccess = () => {
          const current = request.result?.revision || request.result?.savedAt || null;
          if (expectedRevision !== undefined && current !== expectedRevision) { fail(error("SaveConflict")); return; }
          tx.objectStore("states").delete(key);
          tx.objectStore("metadata").delete(key);
        };
      });
    }
  }

  function makeBackup(metadata, data) {
    const payload = data instanceof Blob ? data : new Blob([data]);
    if (!payload.size || payload.size > MAX_STATE_BYTES) throw error("InvalidStateSize");
    const header = new TextEncoder().encode(JSON.stringify({
      format: 1, gameKey: metadata.gameKey, title: String(metadata.title || "").slice(0, 512),
      core: metadata.core, emulatorVersion: metadata.emulatorVersion,
      savedAt: metadata.savedAt
    }));
    if (header.byteLength > 8192) throw error("InvalidStateBackup");
    const length = new Uint8Array(4);
    new DataView(length.buffer).setUint32(0, header.byteLength, true);
    return new Blob([MAGIC, length, header, payload], { type: "application/octet-stream" });
  }

  async function readBackup(file) {
    if (!file.size || file.size > MAX_STATE_BYTES + 8192) throw error("InvalidStateSize");
    const prefix = new Uint8Array(await file.slice(0, 13).arrayBuffer());
    const wrapped = MAGIC.every((byte, index) => prefix[index] === byte);
    if (!wrapped) {
      if (!/\.state$/i.test(file.name || "") || file.size > MAX_STATE_BYTES) throw error("InvalidStateBackup");
      return { metadata: null, data: file };
    }
    if (prefix.byteLength < 13) throw error("InvalidStateBackup");
    const length = new DataView(prefix.buffer).getUint32(9, true);
    if (!length || length > 8192 || 13 + length >= file.size) throw error("InvalidStateBackup");
    let metadata;
    try { metadata = JSON.parse(await file.slice(13, 13 + length).text()); }
    catch { throw error("InvalidStateBackup"); }
    if (metadata?.format !== 1 || typeof metadata.gameKey !== "string" ||
        typeof metadata.core !== "string" || typeof metadata.emulatorVersion !== "string") {
      throw error("InvalidStateBackup");
    }
    const data = file.slice(13 + length);
    if (data.size > MAX_STATE_BYTES) throw error("InvalidStateSize");
    return { metadata, data };
  }

  window.RetroSaveStorage = Object.freeze({ SaveStorage, identity, compatible, makeBackup, readBackup });
})();
