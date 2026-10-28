import { initialize } from './schema.mjs';
import { authorize, cookieName, fail, json, login, readJson, session } from './auth.mjs';
import { allGames, catalog, changeStatus, importGames, publishedGames, reorderGames, saveGame } from './games.mjs';
import { completeUpload, createUpload, removeFile, serveFile, uploadFile, uploadPart } from './files.mjs';

function redirect(request, next) {
  return Response.redirect(new URL('/admin/login?next=' + encodeURIComponent(next), request.url), 303);
}
async function route(request, env) {
  const url = new URL(request.url);
  let path;
  try { path = decodeURIComponent(url.pathname); } catch { fail('notFound', 404); }
  const get = request.method === 'GET' || request.method === 'HEAD';
  if (path === '/admin/login' || path === '/admin/login.html') return env.ASSETS.fetch(new Request(new URL('/admin/login.html', url), request));
  const protectedPage = path.startsWith('/admin/') || path === '/admin' || path === '/pages/core-test.html';
  const api = path.startsWith('/api/') || path.startsWith('/data/') || path === '/games.json';
  if (api || protectedPage) await initialize(env.DB);
  if (protectedPage) {
    if (!await session(request, env)) return redirect(request, path + url.search);
    if (path === '/pages/core-test.html') return Response.redirect(new URL('/admin/core-test.html' + url.search, url), 303);
    if (path === '/admin' || path === '/admin/') return env.ASSETS.fetch(new Request(new URL('/admin/index.html', url), request));
  }
  if (path === '/' && get) return env.ASSETS.fetch(new Request(new URL('/index.html', url), request));
  if (path === '/api/auth/login' && request.method === 'POST') return login(request, env);
  if (path === '/api/auth/session' && get) {
    const current = await authorize(request, env);
    return json({ csrf: current.csrf, expires: current.expires });
  }
  if (path === '/api/auth/logout' && request.method === 'POST') {
    const current = await authorize(request, env, true);
    await env.DB.prepare('DELETE FROM sessions WHERE token=?').bind(current.token).run();
    return json({ ok: true }, 200, { 'Set-Cookie': `${cookieName}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0` });
  }
  if ((path === '/api/games' || path === '/data/games.json' || path === '/games.json') && get) {
    return json(await publishedGames(env));
  }
  if (path.startsWith('/data/') && get) {
    const match = /^\/data\/(roms|thumbs|bios)\/(.+)$/.exec(path);
    if (!match) fail('fileNotFound', 404);
    return serveFile(request, env, match[2], match[1] === 'thumbs' ? ['thumbnail'] : match[1] === 'bios' ? ['bios'] : ['rom', 'patch'], !await session(request, env));
  }
  if (path.startsWith('/api/admin/')) {
    const current = await authorize(request, env, !get);
    if (path === '/api/admin/catalog' && get) return json(await catalog(env));
    if (path === '/api/admin/order' && request.method === 'POST') return json(await reorderGames(env, await readJson(request)));
    if (path === '/api/admin/games' && get) return json(await allGames(env));
    if (path === '/api/admin/games' && request.method === 'POST') return json(await saveGame(env, await readJson(request)), 201);
    if (path === '/api/admin/import' && request.method === 'POST') return json(await importGames(env, await readJson(request)));
    if (path === '/api/admin/export' && get) return json((await allGames(env)).map(({ revision, updatedAt, ...game }) => game));
    const gameRoute = /^\/api\/admin\/games\/(\d+)(?:\/(trash|restore))?$/.exec(path);
    if (gameRoute) {
      const input = await readJson(request);
      if (request.method === 'PUT' && !gameRoute[2]) return json(await saveGame(env, input, Number(gameRoute[1])));
      if (request.method === 'POST' && gameRoute[2]) return json(await changeStatus(env, Number(gameRoute[1]), input.revision, gameRoute[2]));
      if (request.method === 'DELETE' && !gameRoute[2]) return json(await changeStatus(env, Number(gameRoute[1]), input.revision, 'delete'));
    }
    if (path === '/api/admin/files' && get) {
      const files = (await env.DB.prepare('SELECT id,key,kind,name,size,status,updated_at FROM files ORDER BY updated_at DESC').all()).results;
      return json(files);
    }
    const fileRoute = /^\/api\/admin\/files\/([a-f0-9-]+)$/.exec(path);
    if (fileRoute && request.method === 'DELETE') return json(await removeFile(env, fileRoute[1]));
    if (path === '/api/admin/uploads' && request.method === 'POST') return json(await createUpload(env, await readJson(request), current.token), 201);
    const uploadRoute = /^\/api\/admin\/uploads\/([a-f0-9-]+)(?:\/(complete|parts\/(\d+)))?$/.exec(path);
    if (uploadRoute) {
      const file = await uploadFile(env, uploadRoute[1], current.token);
      if (request.method === 'PUT' && uploadRoute[3]) return json(await uploadPart(request, env, file, Number(uploadRoute[3])));
      if (request.method === 'POST' && uploadRoute[2] === 'complete') return json(await completeUpload(env, file));
      if (request.method === 'DELETE' && !uploadRoute[2]) return json(await removeFile(env, file.id));
    }
    fail('notFound', 404);
  }
  if (path.startsWith('/api/') || path.startsWith('/data/') || !get) fail('notFound', 404);
  return env.ASSETS.fetch(request);
}
export default {
  async fetch(request, env) {
    let response;
    try { response = await route(request, env); }
    catch (error) {
      const conflict = /fileInUse|filesNotReady/.exec(String(error.message))?.[0];
      response = json({ error: error.status ? error.message : conflict || 'serverError' }, error.status || (conflict ? 409 : 500));
    }
    const headers = new Headers(response.headers);
    headers.set('Cross-Origin-Opener-Policy', 'same-origin');
    headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
    headers.set('X-Content-Type-Options', 'nosniff');
    headers.set('Referrer-Policy', 'same-origin');
    if (headers.get('Content-Type')?.includes('text/html')) headers.set('Cache-Control', 'private, no-store');
    return new Response(request.method === 'HEAD' ? null : response.body, { status: response.status, statusText: response.statusText, headers });
  }
};
