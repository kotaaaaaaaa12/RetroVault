// A deterministic transaction mock for commit, abort, quota, and reload tests.
export class MemoryIndexedDB {
  constructor() {
    this.databases = new Map();
    this.reads = [];
    this.failWrite = false;
  }

  open(name) {
    const request = {};
    setImmediate(() => {
      let db = this.databases.get(name);
      if (!db) {
        db = this.createDatabase();
        this.databases.set(name, db);
        request.result = db;
        request.onupgradeneeded?.();
      }
      request.result = db;
      request.onsuccess?.();
    });
    return request;
  }

  createDatabase() {
    const factory = this;
    const stores = new Map();
    return {
      close() {},
      createObjectStore(name) {
        stores.set(name, new Map());
        return { createIndex() {} };
      },
      transaction(names, mode) {
        const working = new Map(names.map(name => [name, mode === 'readwrite' ? new Map(stores.get(name)) : stores.get(name)]));
        let pending = 0;
        let aborted = false;
        let completed = false;
        const tx = {
          abort() {
            if (aborted || completed) return;
            aborted = true;
            setImmediate(() => tx.onabort?.());
          },
          objectStore(name) {
            const table = working.get(name);
            const perform = (kind, key, action) => {
              const request = {};
              pending += 1;
              setImmediate(() => {
                if (aborted) return;
                try {
                  if (kind === 'put' && factory.failWrite) {
                    factory.failWrite = false;
                    throw Object.assign(new Error('Storage quota exceeded'), { name: 'QuotaExceededError' });
                  }
                  if (kind === 'get' || kind === 'getAll') factory.reads.push({ store: name, kind, key });
                  request.result = action();
                  request.onsuccess?.();
                } catch (reason) {
                  request.error = reason;
                  tx.error = reason;
                  request.onerror?.();
                  tx.onerror?.();
                  tx.abort();
                }
                pending -= 1;
                finish();
              });
              return request;
            };
            return {
              get(key) { return perform('get', key, () => structuredClone(table.get(key))); },
              put(value) { return perform('put', value.key, () => { table.set(value.key, structuredClone(value)); }); },
              delete(key) { return perform('delete', key, () => { table.delete(key); }); },
              index() {
                return { getAll(gameKey) { return perform('getAll', gameKey, () => [...table.values()].filter(item => item.gameKey === gameKey).map(item => structuredClone(item))); } };
              }
            };
          }
        };
        function finish() {
          setImmediate(() => {
            if (pending || aborted || completed) return;
            completed = true;
            if (mode === 'readwrite') for (const [name, table] of working) stores.set(name, table);
            tx.oncomplete?.();
          });
        }
        finish();
        return tx;
      }
    };
  }
}
