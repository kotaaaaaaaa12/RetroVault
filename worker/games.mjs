import { fail } from './auth.mjs';
import { SYSTEMS, systemFor } from '../assets/js/systems.js';

export const references = game => ['rom', 'thumbnail', 'bios', 'patch', 'gameParent'].map(key => game[key]).filter(Boolean);
export function decode(row) { return { ...JSON.parse(row.config), id: row.id, revision: row.revision, status: row.status, updatedAt: row.updated_at }; }
const text = (value, maximum) => typeof value === 'string' && value.length <= maximum && !/[\u0000-\u001f]/.test(value);
export function normalize(input, previous, id) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('invalidGame');
  const allowed = new Set(['id', 'revision', 'status', 'updatedAt', 'title', 'titleEn', 'titleJa', 'system', 'core', 'coreOverride', 'saveName', 'rom', 'thumbnail', 'bios', 'patch', 'gameParent', 'threads', 'disableCue', 'forceLegacyCores', 'videoRotation', 'ejsVersion', 'dataPath']);
  if (Object.keys(input).some(key => !allowed.has(key))) fail('unsupportedField');
  const localized = input.titleEn !== undefined || input.titleJa !== undefined;
  const titles = {};
  for (const field of ['titleEn', 'titleJa']) {
    if (input[field] !== undefined && typeof input[field] !== 'string') fail('invalidTitle');
    titles[field] = (input[field] || '').trim();
    if (!text(titles[field], 180)) fail('invalidTitle');
  }
  const title = localized ? titles.titleEn || titles.titleJa : typeof input.title === 'string' ? input.title.trim() : '';
  if (!text(title, 180) || !title) fail('invalidTitle');
  const system = SYSTEMS.find(item => item.id === input.system) || systemFor(input.core);
  if (!system) fail('invalidSystem');
  const core = input.core || system.id;
  if (core !== system.id && !system.cores.includes(core)) fail('invalidCore');
  const coreOverride = input.coreOverride || '';
  if (coreOverride && !system.cores.includes(coreOverride)) fail('invalidCore');
  const config = { id, title, system: system.id, core, saveName: previous?.saveName || previous?.title || input.saveName || `rv-game-${id}` };
  if (localized) Object.assign(config, titles);
  if (!text(config.saveName, 180) || !config.saveName) fail('invalidGame');
  if (coreOverride) config.coreOverride = coreOverride;
  for (const field of ['rom', 'thumbnail', 'bios', 'patch', 'gameParent']) {
    if (input[field] === undefined || input[field] === '') continue;
    if (!text(input[field], 1024) || input[field].startsWith('/') || input[field].split('/').includes('..') || input[field].includes('\\')) fail('invalidFile');
    config[field] = input[field];
  }
  for (const field of ['threads', 'disableCue', 'forceLegacyCores']) {
    if (input[field] === undefined) continue;
    if (typeof input[field] !== 'boolean') fail('invalidGame');
    config[field] = input[field];
  }
  if (input.videoRotation !== undefined) {
    if (!Number.isInteger(input.videoRotation) || input.videoRotation < 0 || input.videoRotation > 3) fail('invalidGame');
    config.videoRotation = input.videoRotation;
  }
  if (input.ejsVersion) {
    if (!text(input.ejsVersion, 80) || !/^[\w.-]+$/.test(input.ejsVersion)) fail('invalidVersion');
    config.ejsVersion = input.ejsVersion;
  }
  if (input.dataPath) {
    try { if (new URL(input.dataPath).protocol !== 'https:') fail('invalidVersion'); } catch { fail('invalidVersion'); }
    if (!text(input.dataPath, 1024)) fail('invalidVersion');
    config.dataPath = input.dataPath;
  }
  return config;
}
function ordered(games, ids) {
  const ranks = new Map(ids.map((id, index) => [id, index]));
  return games.sort((a, b) => (ranks.get(a.id) ?? Infinity) - (ranks.get(b.id) ?? Infinity) || a.id - b.id);
}
export async function catalog(env) {
  const order = await env.DB.prepare('SELECT * FROM library_order WHERE id=1').first();
  const games = (await env.DB.prepare('SELECT * FROM games ORDER BY id').all()).results.map(decode);
  return { games: ordered(games, JSON.parse(order.ids)), orderRevision: order.revision };
}
export async function allGames(env) { return (await catalog(env)).games; }
export async function reorderGames(env, input) {
  if (!input || !Array.isArray(input.ids) || !Number.isSafeInteger(input.revision) || input.revision < 1 || input.ids.some(id => !Number.isSafeInteger(id) || id <= 0)) fail('invalidOrder');
  const current = (await env.DB.prepare('SELECT id FROM games').all()).results.map(game => game.id);
  const ids = new Set(input.ids);
  if (ids.size !== input.ids.length || ids.size !== current.length || current.some(id => !ids.has(id))) fail('orderConflict', 409);
  // Insert/delete triggers advance this revision, so membership cannot change
  // between validation and the atomic compare-and-swap update unnoticed.
  const result = await env.DB.prepare('UPDATE library_order SET ids=?,revision=revision+1 WHERE id=1 AND revision=?').bind(JSON.stringify(input.ids), input.revision).run();
  if (!result.meta.changes) fail('orderConflict', 409);
  return { revision: input.revision + 1 };
}
export async function publishedGames(env) {
  const rows = (await env.DB.prepare("SELECT games.*,files.size AS rom_size FROM games LEFT JOIN files ON files.key=json_extract(games.config,'$.rom') AND files.status='ready' AND files.kind='rom' WHERE games.status='ready' ORDER BY games.id").all()).results;
  const order = await env.DB.prepare('SELECT ids FROM library_order WHERE id=1').first();
  return ordered(rows.map(row => {
    const { revision, status, updatedAt, ...game } = decode(row);
    return { ...game, romSize: Number.isSafeInteger(row.rom_size) && row.rom_size >= 0 ? row.rom_size : null };
  }), JSON.parse(order.ids));
}
export async function getGame(env, id) {
  if (!Number.isSafeInteger(id) || id <= 0) fail('adminGameNotFound', 404);
  const row = await env.DB.prepare('SELECT * FROM games WHERE id=?').bind(id).first();
  if (!row) fail('adminGameNotFound', 404);
  return decode(row);
}
export async function validateFiles(env, game) {
  if (!game.rom) fail('adminMissingRom');
  for (const field of ['rom', 'thumbnail', 'bios', 'patch', 'gameParent']) {
    if (!game[field]) continue;
    const file = await env.DB.prepare('SELECT kind,status FROM files WHERE key=?').bind(game[field]).first();
    const kinds = field === 'thumbnail' ? ['thumbnail'] : field === 'bios' ? ['bios'] : field === 'patch' ? ['patch'] : ['rom'];
    if (!file || file.status !== 'ready' || !kinds.includes(file.kind)) fail('filesNotReady');
  }
}
export async function saveGame(env, input, id = null) {
  const previous = id === null ? null : await getGame(env, id);
  if (previous?.status === 'trashed') fail('restoreFirst', 409);
  if (previous && input.revision !== previous.revision) fail('editConflict', 409);
  const status = input.status === 'ready' ? 'ready' : 'draft';
  let config = normalize(previous ? input : { ...input, saveName: input.saveName || 'rv-game-' + crypto.randomUUID() }, previous, id || 1);
  if (status === 'ready') await validateFiles(env, config);
  const updated = new Date().toISOString();
  if (!previous) {
    delete config.id;
    const result = await env.DB.prepare('INSERT INTO games (config,status,updated_at) VALUES (?,?,?)').bind(JSON.stringify(config), status, updated).run();
    id = result.meta.last_row_id;
  } else {
    const result = await env.DB.prepare('UPDATE games SET config=?,status=?,revision=revision+1,updated_at=? WHERE id=? AND revision=?').bind(JSON.stringify(config), status, updated, id, previous.revision).run();
    if (!result.meta.changes) fail('editConflict', 409);
  }
  return getGame(env, id);
}
export async function importGames(env, input) {
  if (!Array.isArray(input) || !input.length || input.length > 500) fail('invalidGame');
  const existing = new Set((await allGames(env)).map(game => game.id));
  const seen = new Set();
  const rows = input.map(game => {
    if (!Number.isSafeInteger(game.id) || game.id <= 0 || seen.has(game.id) || existing.has(game.id)) fail('adminDuplicateId', 409);
    seen.add(game.id);
    // Keep the previous native save filename during migration from games.json.
    return normalize({ ...game, saveName: game.saveName || game.title }, null, game.id);
  });
  await env.DB.batch(rows.map(game => env.DB.prepare('INSERT INTO games (id,config,status,updated_at) VALUES (?,?,?,?)').bind(game.id, JSON.stringify(game), 'draft', new Date().toISOString())));
  return { imported: rows.length };
}
export async function changeStatus(env, id, revision, action) {
  const game = await getGame(env, id);
  if (game.revision !== revision) fail('editConflict', 409);
  if (action === 'delete') {
    if (game.status !== 'trashed') fail('trashFirst', 409);
    const result = await env.DB.prepare('DELETE FROM games WHERE id=? AND revision=?').bind(id, revision).run();
    if (!result.meta.changes) fail('editConflict', 409);
    return { deleted: true };
  }
  const status = action === 'restore' ? 'draft' : 'trashed';
  const result = await env.DB.prepare('UPDATE games SET status=?,revision=revision+1,updated_at=? WHERE id=? AND revision=?').bind(status, new Date().toISOString(), id, revision).run();
  if (!result.meta.changes) fail('editConflict', 409);
  return getGame(env, id);
}
