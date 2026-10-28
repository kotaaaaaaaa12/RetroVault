import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker/index.mjs';
import { environment, passwordHash, testPassword } from './support/worker-environment.mjs';
import { PART_BYTES } from '../worker/files.mjs';

const origin = 'https://retrovault.example';
function call(env, path, method = 'GET', body, auth = {}, headers = {}) {
  const raw = body instanceof Uint8Array;
  return worker.fetch(new Request(origin + path, { method, headers: { ...(body !== undefined && !raw ? { 'Content-Type': 'application/json' } : {}), ...(method !== 'GET' && method !== 'HEAD' ? { Origin: origin } : {}), ...(auth.cookie ? { Cookie: auth.cookie } : {}), ...(auth.csrf ? { 'X-RetroVault-CSRF': auth.csrf } : {}), ...headers }, body: body === undefined ? undefined : raw ? body : JSON.stringify(body) }), env);
}
async function loggedIn(env) {
  const response = await call(env, '/api/auth/login', 'POST', { password: testPassword });
  assert.equal(response.status, 200, await response.clone().text());
  return { cookie: response.headers.get('Set-Cookie').split(';')[0], csrf: (await response.json()).csrf };
}
async function upload(env, auth, kind = 'rom', name = 'game.nes', bytes = new Uint8Array([1, 2, 3, 4])) {
  const start = await call(env, '/api/admin/uploads', 'POST', { kind, name, size: bytes.length }, auth);
  assert.equal(start.status, 201);
  const record = await start.json();
  for (let part = 1; part <= record.parts; part++) {
    const piece = bytes.slice((part - 1) * PART_BYTES, part * PART_BYTES);
    const response = await call(env, `/api/admin/uploads/${record.id}/parts/${part}`, 'PUT', piece, auth, { 'Content-Length': String(piece.length) });
    assert.equal(response.status, 200);
  }
  const completed = await call(env, `/api/admin/uploads/${record.id}/complete`, 'POST', {}, auth);
  assert.equal(completed.status, 200);
  return record;
}

test('public login is available but the catalog, admin, legacy test, and file APIs require authentication', async () => {
  const env = environment();
  assert.equal((await call(env, '/admin/login')).status, 200);
  for (const path of ['/', '/index.html', '/admin/', '/admin/index.html', '/admin/core-test.html', '/pages/core-test.html', '/pages/%63ore-test.html', '/pages/player.html']) {
    const response = await call(env, path);
    assert.equal(response.status, 303, path);
    assert.ok(response.headers.get('Location').includes('/admin/login'));
  }
  for (const path of ['/api/games', '/data/games.json', '/api/admin/games', '/api/admin/files', '/data/roms/private.nes']) assert.equal((await call(env, path)).status, 401, path);
});

test('login fails closed without a password hash and enforces origin, password, and logout checks', async () => {
  const env = environment(); delete env.ADMIN_PASSWORD_HASH;
  assert.equal((await call(env, '/api/auth/login', 'POST', { password: testPassword })).status, 503);
  env.ADMIN_PASSWORD_HASH = passwordHash();
  assert.equal((await call(env, '/api/auth/login', 'POST', { password: testPassword }, {}, { Origin: 'https://another.example' })).status, 403);
  assert.equal((await call(env, '/api/auth/login', 'POST', { password: 'wrong' })).status, 401);
  const auth = await loggedIn(env);
  assert.equal((await call(env, '/api/auth/session', 'GET', undefined, auth)).status, 200);
  assert.equal((await call(env, '/api/admin/games', 'POST', { title: 'Bad', core: 'nes' }, { cookie: auth.cookie })).status, 403);
  assert.equal((await call(env, '/api/auth/logout', 'POST', {}, auth)).status, 200);
  assert.equal((await call(env, '/api/auth/session', 'GET', undefined, auth)).status, 401);
});

test('password rotation invalidates existing sessions and repeated failed logins are limited', async () => {
  const env = environment(); const auth = await loggedIn(env);
  env.ADMIN_PASSWORD_HASH = passwordHash('A different test password 2026.');
  assert.equal((await call(env, '/api/auth/session', 'GET', undefined, auth)).status, 401);
  for (let i = 0; i < 8; i++) assert.equal((await call(env, '/api/auth/login', 'POST', { password: 'wrong' })).status, 401);
  assert.equal((await call(env, '/api/auth/login', 'POST', { password: 'wrong' })).status, 429);
});

test('uploads are completed before publishing and reads stream with correct range and security headers', async () => {
  const env = environment(); const auth = await loggedIn(env);
  const rom = await upload(env, auth);
  const game = { title: 'Test Game', core: 'nes', system: 'nes', coreOverride: 'nestopia', rom: rom.key, status: 'ready' };
  const saved = await call(env, '/api/admin/games', 'POST', game, auth);
  assert.equal(saved.status, 201);
  const record = await saved.json();
  assert.equal(record.core, 'nes'); assert.equal(record.coreOverride, 'nestopia');
  const list = await (await call(env, '/api/games', 'GET', undefined, auth)).json();
  assert.equal(list.length, 1);
  assert.equal(list[0].id, record.id);
  const file = '/data/roms/' + rom.key;
  const response = await call(env, file, 'GET', undefined, auth, { Range: 'bytes=1-2' });
  assert.equal(response.status, 206);
  assert.equal(response.headers.get('Content-Range'), 'bytes 1-2/4');
  assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
  assert.equal(response.headers.get('Cross-Origin-Embedder-Policy'), 'require-corp');
  assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [2, 3]);
  assert.equal((await call(env, file, 'GET', undefined, auth, { Range: 'bytes=8-9' })).status, 416);
  const reads = env.FILES.reads;
  assert.equal((await call(env, file, 'HEAD', undefined, auth)).headers.get('Content-Length'), '4');
  assert.equal(env.FILES.reads, reads);
  assert.equal((await call(env, '/api/admin/files/' + rom.id, 'DELETE', undefined, auth)).status, 409);
});

test('game revisions prevent stale writes and title changes preserve save names through import and editing', async () => {
  const env = environment(); const auth = await loggedIn(env);
  const input = [{ id: 101, title: 'Original Name', rom: 'old.nes', core: 'nes' }];
  assert.equal((await call(env, '/api/admin/import', 'POST', input, auth)).status, 200);
  let game = (await (await call(env, '/api/admin/games', 'GET', undefined, auth)).json())[0];
  assert.equal(game.status, 'draft'); assert.equal(game.saveName, 'Original Name');
  assert.equal((await (await call(env, '/api/games', 'GET', undefined, auth)).json()).length, 0);
  const response = await call(env, '/api/admin/games/101', 'PUT', { ...game, title: 'Renamed', saveName: 'Do not change' }, auth);
  assert.equal(response.status, 200);
  const next = await response.json(); assert.equal(next.id, 101); assert.equal(next.saveName, 'Original Name');
  assert.equal((await call(env, '/api/admin/games/101', 'PUT', game, auth)).status, 409);
  assert.equal((await call(env, '/api/admin/games/101', 'PUT', { ...next, status: 'ready' }, auth)).status, 400);
  assert.equal((await call(env, '/api/admin/import', 'POST', [{ id: 102, title: 'New', core: 'nes' }, ...input], auth)).status, 409);
  assert.equal((await (await call(env, '/api/admin/games', 'GET', undefined, auth)).json()).length, 1);
});

test('trash and restore keep files and explicit file deletion is allowed only after references are removed', async () => {
  const env = environment(); const auth = await loggedIn(env); const rom = await upload(env, auth);
  const saved = await (await call(env, '/api/admin/games', 'POST', { title: 'Test', core: 'nes', rom: rom.key, status: 'ready' }, auth)).json();
  const path = '/api/admin/games/' + saved.id;
  assert.equal((await call(env, path, 'DELETE', { revision: saved.revision }, auth)).status, 409);
  let game = await (await call(env, path + '/trash', 'POST', { revision: saved.revision }, auth)).json();
  assert.equal((await (await call(env, '/api/games', 'GET', undefined, auth)).json()).length, 0);
  assert.equal((await call(env, '/api/admin/files/' + rom.id, 'DELETE', undefined, auth)).status, 409);
  game = await (await call(env, path + '/restore', 'POST', { revision: game.revision }, auth)).json();
  assert.equal(game.status, 'draft');
  game = await (await call(env, path + '/trash', 'POST', { revision: game.revision }, auth)).json();
  assert.equal((await call(env, path, 'DELETE', { revision: game.revision }, auth)).status, 200);
  assert.equal((await call(env, '/api/admin/files/' + rom.id, 'DELETE', undefined, auth)).status, 200);
  assert.equal(await env.FILES.head(rom.key), null);
});

test('incomplete uploads and invalid parts cannot become game files and cancellation clears staged data', async () => {
  const env = environment(); const auth = await loggedIn(env);
  const created = await (await call(env, '/api/admin/uploads', 'POST', { kind: 'rom', name: 'large.3ds', size: PART_BYTES + 2 }, auth)).json();
  assert.equal((await call(env, `/api/admin/uploads/${created.id}/complete`, 'POST', {}, auth)).status, 409);
  assert.equal((await call(env, `/api/admin/uploads/${created.id}/parts/1`, 'PUT', new Uint8Array([1]), auth, { 'Content-Length': '1' })).status, 400);
  assert.equal((await call(env, `/api/admin/uploads/${created.id}`, 'DELETE', undefined, auth)).status, 200);
  assert.equal(env.FILES.uploads.size, 0);
  assert.equal((await call(env, '/api/admin/uploads', 'POST', { kind: 'thumbnail', name: 'unsafe.svg', size: 20 }, auth)).status, 400);
});

test('multipart retry replaces only its part and completion is idempotent', async () => {
  const env = environment(); const auth = await loggedIn(env);
  const created = await (await call(env, '/api/admin/uploads', 'POST', { kind: 'rom', name: 'large.nds', size: PART_BYTES + 1 }, auth)).json();
  const first = new Uint8Array(PART_BYTES); first[0] = 8;
  const url = `/api/admin/uploads/${created.id}`;
  for (let attempt = 0; attempt < 2; attempt++) assert.equal((await call(env, url + '/parts/1', 'PUT', first, auth, { 'Content-Length': String(first.length) })).status, 200);
  assert.equal((await call(env, url + '/parts/2', 'PUT', new Uint8Array([9]), auth, { 'Content-Length': '1' })).status, 200);
  assert.equal((await call(env, url + '/complete', 'POST', {}, auth)).status, 200);
  assert.equal((await call(env, url + '/complete', 'POST', {}, auth)).status, 200);
  const object = env.FILES.objects.get(created.key); assert.equal(object.data.length, PART_BYTES + 1); assert.equal(object.data[0], 8); assert.equal(object.data.at(-1), 9);
});

test('encoded original file names survive upload and database guards prevent publication during removal', async () => {
  const env = environment(); const auth = await loggedIn(env);
  const rom = await upload(env, auth, 'rom', '100% 日本語 original.nes');
  const path = '/data/roms/' + rom.key.split('/').map(encodeURIComponent).join('/');
  const response = await call(env, path, 'GET', undefined, auth);
  assert.equal(response.status, 200);
  assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [1, 2, 3, 4]);
  await env.DB.prepare("UPDATE files SET status='deleting' WHERE id=?").bind(rom.id).run();
  assert.equal((await call(env, '/api/admin/games', 'POST', { title: 'Pending removal', core: 'nes', rom: rom.key, status: 'draft' }, auth)).status, 409);
  await env.DB.prepare("UPDATE files SET status='ready' WHERE id=?").bind(rom.id).run();
  const game = await call(env, '/api/admin/games', 'POST', { title: 'Referenced file', core: 'nes', rom: rom.key, status: 'ready' }, auth);
  assert.equal(game.status, 201);
  await assert.rejects(env.DB.prepare("UPDATE files SET status='deleting' WHERE id=?").bind(rom.id).run(), /fileInUse/);
});
