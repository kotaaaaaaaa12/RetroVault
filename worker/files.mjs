import { fail } from './auth.mjs';
import { allGames, references } from './games.mjs';
export const PART_BYTES = 16 * 1024 * 1024;
export async function createUpload(env, input, owner) {
  if (!['rom', 'thumbnail', 'bios', 'patch'].includes(input.kind) || typeof input.name !== 'string' || !input.name.length || input.name.length > 255) fail('invalidFile');
  const maximum = input.kind === 'thumbnail' ? 10 * 1024 * 1024 : Number(env.MAX_ROM_BYTES || 8589934592);
  if (!Number.isSafeInteger(input.size) || input.size < 1 || input.size > maximum) fail('invalidFileSize');
  const extension = input.name.split('.').pop().toLowerCase();
  const imageMime = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' };
  if (input.kind === 'thumbnail' && !imageMime[extension]) fail('invalidImage');
  const mime = input.kind === 'thumbnail' ? imageMime[extension] : 'application/octet-stream';
  const id = crypto.randomUUID();
  // Keep the ROM basename stable for native game saves during migration.
  const name = input.name.replace(/[\u0000-\u001f\u007f/\\]/g, '_') || 'file.bin';
  const key = `${input.kind}/${id}/${name}`;
  if (!env.FILES) fail('storageNotConfigured', 503);
  const upload = await env.FILES.createMultipartUpload(key, { httpMetadata: { contentType: mime } });
  try {
    await env.DB.prepare('INSERT INTO files (key,id,kind,name,size,mime,status,upload_id,owner,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)').bind(key, id, input.kind, input.name, input.size, mime, 'uploading', upload.uploadId, owner, new Date().toISOString()).run();
  } catch (error) { await upload.abort(); throw error; }
  return { id, key, partBytes: PART_BYTES, parts: Math.ceil(input.size / PART_BYTES) };
}
export async function uploadFile(env, id, owner) {
  const file = await env.DB.prepare('SELECT * FROM files WHERE id=?').bind(id).first();
  if (!file || file.owner !== owner) fail('fileNotFound', 404);
  return file;
}
export async function uploadPart(request, env, file, part) {
  if (file.status !== 'uploading') fail('uploadNotActive', 409);
  const count = Math.ceil(file.size / PART_BYTES);
  if (!Number.isInteger(part) || part < 1 || part > count) fail('invalidPart');
  const expected = Math.min(PART_BYTES, file.size - (part - 1) * PART_BYTES);
  if (!request.body || Number(request.headers.get('Content-Length')) !== expected) fail('invalidPartSize');
  const uploaded = await env.FILES.resumeMultipartUpload(file.key, file.upload_id).uploadPart(part, request.body);
  await env.DB.prepare('INSERT INTO upload_parts (file_id,part,etag) VALUES (?,?,?) ON CONFLICT(file_id,part) DO UPDATE SET etag=excluded.etag').bind(file.id, part, uploaded.etag).run();
  return { partNumber: part, etag: uploaded.etag };
}
export async function completeUpload(env, file) {
  if (file.status === 'ready') return { key: file.key };
  if (file.status !== 'uploading') fail('uploadNotActive', 409);
  const parts = (await env.DB.prepare('SELECT part,etag FROM upload_parts WHERE file_id=? ORDER BY part').bind(file.id).all()).results;
  if (parts.length !== Math.ceil(file.size / PART_BYTES) || parts.some((part, index) => part.part !== index + 1)) fail('uploadIncomplete', 409);
  // A retry after completion can recover using the immutable final object.
  let object = await env.FILES.head(file.key);
  if (!object) object = await env.FILES.resumeMultipartUpload(file.key, file.upload_id).complete(parts.map(part => ({ partNumber: part.part, etag: part.etag })));
  if (object.size !== file.size) fail('invalidFileSize');
  await env.DB.prepare("UPDATE files SET status='ready',upload_id=NULL,updated_at=? WHERE id=? AND status='uploading'").bind(new Date().toISOString(), file.id).run();
  return { key: file.key };
}
export async function removeFile(env, id) {
  const file = await env.DB.prepare('SELECT * FROM files WHERE id=?').bind(id).first();
  if (!file) fail('fileNotFound', 404);
  if ((await allGames(env)).some(game => references(game).includes(file.key))) fail('fileInUse', 409);
  // The database trigger prevents new game references while removal is pending.
  await env.DB.prepare("UPDATE files SET status='deleting' WHERE id=?").bind(id).run();
  if (file.upload_id) await env.FILES.resumeMultipartUpload(file.key, file.upload_id).abort();
  await env.FILES.delete(file.key);
  await env.DB.batch([env.DB.prepare('DELETE FROM upload_parts WHERE file_id=?').bind(id), env.DB.prepare('DELETE FROM files WHERE id=?').bind(id)]);
  return { deleted: true };
}
export async function serveFile(request, env, key, expectedKind, publicOnly = false) {
  const file = await env.DB.prepare("SELECT * FROM files WHERE key=? AND status='ready'").bind(key).first();
  if (!file || (expectedKind && !expectedKind.includes(file.kind))) fail('fileNotFound', 404);
  if (publicOnly) {
    const published = await env.DB.prepare("SELECT 1 FROM games,json_each(games.config) ref WHERE games.status='ready' AND ref.key IN ('rom','thumbnail','bios','patch','gameParent') AND ref.value=? LIMIT 1").bind(key).first();
    if (!published) fail('fileNotFound', 404);
  }
  const base = { 'Cache-Control': 'private, no-store', 'Content-Type': file.mime, 'Accept-Ranges': 'bytes', 'X-Content-Type-Options': 'nosniff' };
  if (request.method === 'HEAD') return new Response(null, { headers: { ...base, 'Content-Length': String(file.size) } });
  const rangeHeader = request.headers.get('Range');
  let range;
  if (rangeHeader) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
    if (!match || (!match[1] && !match[2])) return new Response(null, { status: 416, headers: { ...base, 'Content-Range': `bytes */${file.size}` } });
    const offset = match[1] ? Number(match[1]) : Math.max(0, file.size - Number(match[2]));
    const end = match[1] && match[2] ? Math.min(file.size - 1, Number(match[2])) : file.size - 1;
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(end) || offset < 0 || offset >= file.size || end < offset) return new Response(null, { status: 416, headers: { ...base, 'Content-Range': `bytes */${file.size}` } });
    range = { offset, length: end - offset + 1 };
  }
  const object = await env.FILES.get(key, range ? { range } : undefined);
  if (!object) fail('fileNotFound', 404);
  const headers = { ...base, 'Content-Length': String(range?.length || file.size), ETag: object.httpEtag };
  if (range) headers['Content-Range'] = `bytes ${range.offset}-${range.offset + range.length - 1}/${file.size}`;
  return new Response(object.body, { status: range ? 206 : 200, headers });
}
