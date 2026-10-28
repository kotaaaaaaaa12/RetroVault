export const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS games (id INTEGER PRIMARY KEY AUTOINCREMENT, revision INTEGER NOT NULL DEFAULT 1, status TEXT NOT NULL DEFAULT 'draft', config TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS files (key TEXT PRIMARY KEY, id TEXT UNIQUE NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL, size INTEGER NOT NULL, mime TEXT NOT NULL, status TEXT NOT NULL, upload_id TEXT, owner TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS upload_parts (file_id TEXT NOT NULL, part INTEGER NOT NULL, etag TEXT NOT NULL, PRIMARY KEY(file_id, part))`,
  `CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, csrf TEXT NOT NULL, expires INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS login_limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL, reset_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS library_order (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, ids TEXT NOT NULL)`,
  `INSERT OR IGNORE INTO library_order (id,revision,ids) SELECT 1,1,json_group_array(id) FROM (SELECT id FROM games ORDER BY id)`,
  `CREATE TRIGGER IF NOT EXISTS games_order_insert AFTER INSERT ON games BEGIN UPDATE library_order SET ids=json_insert(ids,'$[#]',NEW.id),revision=revision+1 WHERE id=1; END`,
  `CREATE TRIGGER IF NOT EXISTS games_order_delete AFTER DELETE ON games BEGIN UPDATE library_order SET ids=(SELECT json_group_array(value) FROM (SELECT value FROM json_each(library_order.ids) WHERE value!=OLD.id ORDER BY CAST(key AS INTEGER))),revision=revision+1 WHERE id=1; END`,
  ...['INSERT', 'UPDATE'].map(event => `CREATE TRIGGER IF NOT EXISTS games_file_guard_${event.toLowerCase()} BEFORE ${event} ON games BEGIN SELECT CASE WHEN EXISTS (SELECT 1 FROM json_each(NEW.config) ref WHERE ref.key IN ('rom','thumbnail','bios','patch','gameParent') AND ref.value != '' AND ((NEW.status='ready' AND NOT EXISTS (SELECT 1 FROM files WHERE key=ref.value AND status='ready')) OR EXISTS (SELECT 1 FROM files WHERE key=ref.value AND status='deleting'))) THEN RAISE(ABORT, 'filesNotReady') END; END`),
  `CREATE TRIGGER IF NOT EXISTS files_removal_guard BEFORE UPDATE OF status ON files WHEN NEW.status='deleting' BEGIN SELECT CASE WHEN EXISTS (SELECT 1 FROM games, json_each(games.config) ref WHERE ref.key IN ('rom','thumbnail','bios','patch','gameParent') AND ref.value=NEW.key) THEN RAISE(ABORT, 'fileInUse') END; END`
];
let initialized = new WeakMap();
export function initialize(db) {
  if (!db) throw Object.assign(new Error('storageNotConfigured'), { status: 503 });
  if (!initialized.has(db)) initialized.set(db, db.batch(SCHEMA.map(sql => db.prepare(sql))).catch(error => { initialized.delete(db); throw error; }));
  return initialized.get(db);
}
