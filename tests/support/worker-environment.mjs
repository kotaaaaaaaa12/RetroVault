import { DatabaseSync } from 'node:sqlite';
import { pbkdf2Sync } from 'node:crypto';

export class SQLiteD1 {
  constructor() { this.sqlite = new DatabaseSync(':memory:'); }
  prepare(sql) {
    const database = this;
    class Query {
      constructor(params = []) { this.params = params; }
      bind(...params) { return new Query(params); }
      execute() { const result = database.sqlite.prepare(sql).run(...this.params); return { success: true, meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } }; }
      async run() { return this.execute(); }
      async first() { return database.sqlite.prepare(sql).get(...this.params) || null; }
      async all() { return { results: database.sqlite.prepare(sql).all(...this.params) }; }
    }
    return new Query();
  }
  async batch(queries) {
    this.sqlite.exec('BEGIN');
    try { const results = queries.map(query => query.execute()); this.sqlite.exec('COMMIT'); return results; }
    catch (error) { this.sqlite.exec('ROLLBACK'); throw error; }
  }
}
export class MemoryR2 {
  constructor() { this.objects = new Map(); this.uploads = new Map(); this.reads = 0; }
  async createMultipartUpload(key, options) {
    const uploadId = crypto.randomUUID(); this.uploads.set(uploadId, { key, options, parts: new Map() });
    return { uploadId, key, ...this.resumeMultipartUpload(key, uploadId) };
  }
  resumeMultipartUpload(key, id) {
    const bucket = this;
    const current = () => { const upload = bucket.uploads.get(id); if (!upload || upload.key !== key) throw new Error('Missing upload'); return upload; };
    return {
      async uploadPart(part, body) { const data = new Uint8Array(await new Response(body).arrayBuffer()); const etag = crypto.randomUUID(); current().parts.set(part, { data, etag }); return { partNumber: part, etag }; },
      async complete(parts) {
        const upload = current();
        const pieces = parts.map(part => { const stored = upload.parts.get(part.partNumber); if (stored?.etag !== part.etag) throw new Error('Invalid etag'); return stored.data; });
        const data = new Uint8Array(await new Blob(pieces).arrayBuffer()); bucket.objects.set(key, { data, httpEtag: '"' + crypto.randomUUID() + '"' }); bucket.uploads.delete(id);
        return bucket.head(key);
      },
      async abort() { bucket.uploads.delete(id); }
    };
  }
  async head(key) { const value = this.objects.get(key); return value ? { size: value.data.byteLength, httpEtag: value.httpEtag } : null; }
  async get(key, options) { this.reads++; const value = this.objects.get(key); if (!value) return null; const range = options?.range; const data = range ? value.data.slice(range.offset, range.offset + range.length) : value.data; return { size: value.data.length, httpEtag: value.httpEtag, body: new Response(data).body }; }
  async delete(key) { this.objects.delete(key); }
}
export const testPassword = 'Local test password only 2026.';
export function passwordHash(password = testPassword) {
  const salt = '0123456789abcdef0123456789abcdef';
  return 'pbkdf2-sha256$100000$' + salt + '$' + pbkdf2Sync(password, salt, 100000, 32, 'sha256').toString('hex');
}
export function environment() {
  return { DB: new SQLiteD1(), FILES: new MemoryR2(), ADMIN_PASSWORD_HASH: passwordHash(), ASSETS: { async fetch(request) { const path = new URL(request.url).pathname; return new Response('<html>' + path + '</html>', { headers: { 'Content-Type': 'text/html' } }); } } };
}
