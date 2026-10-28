const encoder = new TextEncoder();
export const cookieName = '__Host-retrovault';
export const fail = (code, status = 400) => { throw Object.assign(new Error(code), { status }); };
export const json = (value, status = 200, headers = {}) => Response.json(value, { status, headers: { 'Cache-Control': 'private, no-store', ...headers } });
export async function hash(value) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)))].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
function credential(env) {
  // A directly configured password takes precedence over the legacy hash.
  if (env.ADMIN_PASSWORD !== undefined) {
    const password = env.ADMIN_PASSWORD;
    return typeof password === 'string' && password.length > 0 && password.length <= 1024 ? { password, sessionKey: 'password|' + password } : null;
  }
  return typeof env.ADMIN_PASSWORD_HASH === 'string' && env.ADMIN_PASSWORD_HASH ? { encoded: env.ADMIN_PASSWORD_HASH, sessionKey: env.ADMIN_PASSWORD_HASH } : null;
}
function equalDigest(actual, expected) {
  let difference = 0;
  for (let i = 0; i < expected.length; i++) difference |= actual.charCodeAt(i) ^ expected.charCodeAt(i);
  return difference === 0;
}
export function sameOrigin(request) {
  if (request.headers.get('Origin') !== new URL(request.url).origin) fail('invalidOrigin', 403);
}
export async function readJson(request, limit = 1024 * 1024) {
  if (!request.headers.get('Content-Type')?.startsWith('application/json')) fail('invalidJson');
  const reader = request.body?.getReader();
  if (!reader) fail('invalidJson');
  const chunks = []; let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) { await reader.cancel(); fail('requestTooLarge', 413); }
    chunks.push(value);
  }
  const data = new Uint8Array(size); let offset = 0;
  for (const part of chunks) { data.set(part, offset); offset += part.byteLength; }
  try { return JSON.parse(new TextDecoder().decode(data)); } catch { fail('invalidJson'); }
}
export async function session(request, env) {
  const configured = credential(env);
  if (!configured) return null;
  const value = request.headers.get('Cookie')?.split(';').map(item => item.trim()).find(item => item.startsWith(cookieName + '='))?.slice(cookieName.length + 1);
  if (!value || !/^[a-f0-9]{64}$/.test(value)) return null;
  return env.DB.prepare('SELECT * FROM sessions WHERE token = ? AND expires > ?').bind(await hash(value + '|' + configured.sessionKey), Date.now()).first();
}
export async function authorize(request, env, mutation = false) {
  const current = await session(request, env);
  if (!current) fail('loginRequired', 401);
  if (mutation) {
    sameOrigin(request);
    if (request.headers.get('X-RetroVault-CSRF') !== current.csrf) fail('invalidSession', 403);
  }
  return current;
}
export async function verifyPassword(password, encoded) {
  const [algorithm, iterations, salt, expected] = String(encoded || '').split('$');
  if (algorithm !== 'pbkdf2-sha256' || !/^\d+$/.test(iterations) || Number(iterations) < 100000 || Number(iterations) > 1000000 || !/^[a-f0-9]{32}$/.test(salt) || !/^[a-f0-9]{64}$/.test(expected)) fail('passwordNotConfigured', 503);
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bytes = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: encoder.encode(salt), iterations: Number(iterations), hash: 'SHA-256' }, key, 256);
  const actual = [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
  return equalDigest(actual, expected);
}
export async function login(request, env) {
  sameOrigin(request);
  const input = await readJson(request, 4096);
  if (typeof input?.password !== 'string' || input.password.length > 1024) fail('invalidPassword', 401);
  const configured = credential(env);
  if (!configured) fail('passwordNotConfigured', 503);
  const now = Date.now();
  const key = await hash(request.headers.get('CF-Connecting-IP') || 'local-development');
  await env.DB.prepare(`INSERT INTO login_limits (key,count,reset_at) VALUES (?,1,?) ON CONFLICT(key) DO UPDATE SET count=CASE WHEN reset_at < ? THEN 1 ELSE count+1 END, reset_at=CASE WHEN reset_at < ? THEN excluded.reset_at ELSE reset_at END`).bind(key, now + 15 * 60000, now, now).run();
  const attempts = await env.DB.prepare('SELECT count FROM login_limits WHERE key=?').bind(key).first();
  if (attempts.count > 8) fail('tooManyAttempts', 429);
  const matches = configured.encoded
    ? await verifyPassword(input.password, configured.encoded)
    : equalDigest(await hash(input.password), await hash(configured.password));
  if (!matches) fail('invalidPassword', 401);
  await env.DB.prepare('DELETE FROM login_limits WHERE key=?').bind(key).run();
  await env.DB.prepare('DELETE FROM sessions WHERE expires < ?').bind(now).run();
  const token = [...crypto.getRandomValues(new Uint8Array(32))].map(byte => byte.toString(16).padStart(2, '0')).join('');
  const csrf = crypto.randomUUID();
  await env.DB.prepare('INSERT INTO sessions (token,csrf,expires) VALUES (?,?,?)').bind(await hash(token + '|' + configured.sessionKey), csrf, now + 12 * 60 * 60000).run();
  return json({ csrf }, 200, { 'Set-Cookie': `${cookieName}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=43200` });
}
