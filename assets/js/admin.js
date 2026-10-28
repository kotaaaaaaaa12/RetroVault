import { SYSTEMS, detectSystem, systemFor } from './systems.js';

const i18n = window.RetroI18n;
const t = (key, values) => i18n.t(key, values);
const element = id => document.getElementById(id);
let csrf = '';
let games = [];
let files = [];
let model = {};
let busy = false;
let dirty = false;
let jsonDirty = false;
let uploadController = null;
let autoSystem = true;
let statusMessage = null;
const fields = [ ['rom', 'rom', 'adminRom'], ['thumbnail', 'thumbnail', 'adminThumbnail'], ['bios', 'bios', 'adminBios'], ['patch', 'patch', 'adminPatch'] ];
const clean = game => Object.fromEntries(Object.entries(game).filter(([key]) => !['updatedAt', 'revision'].includes(key)));
const bytes = size => (size / (1024 * 1024)).toFixed(1) + ' MiB';

function show(key, values = {}, error = false) {
  statusMessage = { key, values, error };
  element('admin-status').hidden = false;
  element('admin-status').textContent = t(key, values);
  element('admin-status').classList.toggle('error', error);
}
function problem(error) {
  const key = t(error.message) === error.message ? 'serverError' : error.message;
  show(key, {}, true);
}
function setBusy(value) {
  busy = value;
  for (const control of document.querySelectorAll('button, input, select, textarea')) {
    if (['language-select', 'cancel-upload'].includes(control.id)) continue;
    control.disabled = value;
  }
}
async function api(path, method = 'GET', body, options = {}) {
  const response = await fetch(path, {
    method,
    headers: { ...(body !== undefined && !(body instanceof Blob) ? { 'Content-Type': 'application/json' } : {}), ...(method !== 'GET' ? { 'X-RetroVault-CSRF': csrf } : {}) },
    body: body instanceof Blob ? body : body === undefined ? undefined : JSON.stringify(body),
    ...options
  });
  const data = await response.json();
  if (response.status === 401) { location.assign('/admin/login?next=/admin/'); throw new Error('loginRequired'); }
  if (!response.ok) throw new Error(data.error || 'serverError');
  return data;
}

let answer = null;
function ask(key, values = {}) {
  element('confirm-text').textContent = t(key, values);
  element('confirm-dialog').showModal();
  element('confirm-text').focus({ preventScroll: true });
  return new Promise(resolve => { answer = resolve; });
}
function respond(value) { element('confirm-dialog').close(); const resolve = answer; answer = null; resolve?.(value); }
element('confirm-yes').addEventListener('click', () => respond(true));
element('confirm-no').addEventListener('click', () => respond(false));
element('confirm-dialog').addEventListener('cancel', event => { event.preventDefault(); respond(false); });

function coreOptions(value = model.coreOverride || '') {
  const system = SYSTEMS.find(item => item.id === element('game-system').value) || SYSTEMS[0];
  element('game-core').replaceChildren();
  const defaultCore = system.cores.includes(model.core) ? model.core : system.cores[0];
  for (const [core, label] of [['', t('adminDefaultCore', { core: defaultCore })], ...system.cores.map(core => [core, core])]) {
    const option = document.createElement('option'); option.value = core; option.textContent = label; element('game-core').appendChild(option);
  }
  element('game-core').value = value;
}
function systemOptions() {
  const value = element('game-system').value || model.system || 'nes';
  element('game-system').replaceChildren();
  for (const system of SYSTEMS) {
    const option = document.createElement('option'); option.value = system.id; option.textContent = i18n.systemLabel(system.label); element('game-system').appendChild(option);
  }
  element('game-system').value = value;
  coreOptions();
}
function syncJson(force = false) { if (jsonDirty && !force) return; element('game-json').value = JSON.stringify(clean(model), null, 2); jsonDirty = false; }
function preview() {
  const image = element('thumbnail-preview');
  image.hidden = !model.thumbnail;
  image.src = model.thumbnail ? '/data/thumbs/' + model.thumbnail.split('/').map(encodeURIComponent).join('/') : '';
  image.onerror = () => { image.hidden = true; };
}
function fileChoices() {
  for (const [field, kind] of fields) {
    const select = element('existing-' + field); select.replaceChildren();
    const empty = document.createElement('option'); empty.value = ''; empty.textContent = t('adminNoFile'); select.appendChild(empty);
    for (const file of files.filter(file => file.kind === kind && file.status === 'ready')) {
      const option = document.createElement('option'); option.value = file.key; option.textContent = file.name + ' (' + bytes(file.size) + ')'; select.appendChild(option);
    }
    select.value = model[field] || '';
    element('current-' + field).textContent = files.find(file => file.key === model[field])?.name || model[field] || t('adminNoFile');
  }
}
function fill() {
  element('editor-heading').removeAttribute('data-i18n');
  element('editor-heading').textContent = t(model.id ? 'adminEdit' : 'adminAdd');
  element('game-identity').textContent = model.id ? t('adminIdentity', { id: model.id, revision: model.revision }) : t('adminNewIdentity');
  element('game-title').value = model.title || '';
  systemOptions(); element('game-system').value = model.system || systemFor(model.core)?.id || 'nes'; coreOptions();
  element('game-status').value = model.status === 'ready' ? 'ready' : 'draft';
  fileChoices(); preview(); syncJson(true);
}
async function selectGame(game) {
  if (busy || (dirty && !await ask('adminDiscardChanges'))) return;
  model = game ? structuredClone(game) : { title: '', system: 'nes', core: 'nes', status: 'draft' };
  autoSystem = !game;
  dirty = false; fill();
}
function makeButton(key, action) {
  const button = document.createElement('button'); button.type = 'button'; button.textContent = t(key);
  button.addEventListener('click', async () => { button.blur(); try { await action(); } catch (error) { problem(error); } });
  return button;
}
function renderGames() {
  const root = element('admin-games'); root.replaceChildren();
  const search = element('admin-search').value.toLowerCase();
  for (const game of games.filter(game => (element('show-trash').checked ? game.status === 'trashed' : game.status !== 'trashed') && game.title.toLowerCase().includes(search))) {
    const row = document.createElement('section'); row.className = 'game-row';
    const title = document.createElement('strong'); title.textContent = game.title;
    const info = document.createElement('small'); info.textContent = `#${game.id} · ${game.system || game.core} · ${game.coreOverride || game.core} · ` + t(game.status === 'ready' ? 'adminReady' : game.status === 'trashed' ? 'adminTrashed' : 'adminDraft');
    const actions = document.createElement('div'); actions.className = 'actions';
    if (game.status !== 'trashed') actions.append(makeButton('adminEdit', () => selectGame(game)), makeButton('adminTrash', () => changeGame(game, 'trash')));
    else actions.append(makeButton('adminRestore', () => changeGame(game, 'restore')), makeButton('adminDeleteEntry', () => changeGame(game, 'delete')));
    row.append(title, info, actions); root.appendChild(row);
  }
}
function renderFiles() {
  element('storage-summary').textContent = t('adminStorageSummary', { count: files.length, size: bytes(files.reduce((total, file) => total + (file.status === 'ready' ? file.size : 0), 0)) });
  const root = element('admin-files'); root.replaceChildren();
  for (const file of files) {
    const row = document.createElement('div'); row.className = 'file-row';
    const info = document.createElement('p'); info.textContent = `${file.name} · ${t({ rom: 'adminRom', thumbnail: 'adminThumbnail', bios: 'adminBios', patch: 'adminPatch' }[file.kind])} · ${bytes(file.size)} · ` + t(file.status === 'ready' ? 'adminFileReady' : file.status === 'deleting' ? 'adminFileRemoving' : 'adminUploading');
    row.append(info, makeButton('adminRemoveFile', async () => {
      if (busy || !await ask('adminConfirmRemoveFile', { name: file.name })) return;
      setBusy(true);
      try { await api('/api/admin/files/' + file.id, 'DELETE'); await refresh(); show('adminFileRemoved'); }
      finally { setBusy(false); }
    }));
    root.appendChild(row);
  }
}
async function refresh() {
  [games, files] = await Promise.all([api('/api/admin/games'), api('/api/admin/files')]);
  renderGames(); renderFiles(); fileChoices();
}
async function changeGame(game, action) {
  if (busy || !await ask(action === 'delete' ? 'adminConfirmDeleteEntry' : action === 'trash' ? 'adminConfirmTrash' : 'adminConfirmRestore', { title: game.title })) return;
  setBusy(true);
  try {
    await api('/api/admin/games/' + game.id + (action === 'delete' ? '' : '/' + action), action === 'delete' ? 'DELETE' : 'POST', { revision: game.revision });
    if (model.id === game.id) { model = { title: '', system: 'nes', core: 'nes', status: 'draft' }; dirty = false; fill(); }
    await refresh(); show('adminSaved');
  } finally { setBusy(false); }
}

async function thumbnail(file) {
  if (!/\.(png|jpe?g|webp)$/i.test(file.name) || file.size > 10 * 1024 * 1024) throw new Error('invalidImage');
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    await new Promise((resolve, reject) => { image.onload = resolve; image.onerror = () => reject(new Error('invalidImage')); image.src = url; });
    const ratio = Math.min(1, 1024 / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = document.createElement('canvas'); canvas.width = Math.max(1, Math.round(image.naturalWidth * ratio)); canvas.height = Math.max(1, Math.round(image.naturalHeight * ratio));
    canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/webp', .86));
    if (!blob) throw new Error('invalidImage');
    const result = new File([blob], file.name.replace(/\.[^.]+$/, '') + '.webp', { type: 'image/webp' });
    canvas.width = canvas.height = 1;
    return result;
  } finally { URL.revokeObjectURL(url); }
}
async function upload(field, kind, original) {
  if (busy) return;
  setBusy(true); uploadController = new AbortController();
  let created;
  try {
    const file = kind === 'thumbnail' ? await thumbnail(original) : original;
    created = await api('/api/admin/uploads', 'POST', { kind, name: file.name, size: file.size });
    element('upload-progress').hidden = false;
    for (let part = 1; part <= created.parts; part++) {
      if (uploadController.signal.aborted) throw new DOMException('Cancelled', 'AbortError');
      const body = file.slice((part - 1) * created.partBytes, Math.min(part * created.partBytes, file.size));
      for (let attempt = 0; ; attempt++) {
        try { await api(`/api/admin/uploads/${created.id}/parts/${part}`, 'PUT', body, { signal: uploadController.signal }); break; }
        catch (error) { if (attempt >= 2 || uploadController.signal.aborted) throw error; await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1))); }
      }
      const percent = Math.round(part / created.parts * 100);
      element('upload-meter').value = percent;
      element('upload-label').textContent = t('adminUploadProgress', { name: original.name, percent });
    }
    await api('/api/admin/uploads/' + created.id + '/complete', 'POST', {});
    model[field] = created.key; dirty = true;
    if (kind === 'rom' && !model.id) {
      const system = detectSystem(original.name);
      if (system && autoSystem) { model.system = model.core = system; delete model.coreOverride; element('game-system').value = system; coreOptions(); }
      if (!model.title) { model.title = original.name.replace(/\.[^.]+$/, ''); element('game-title').value = model.title; }
    }
    await refresh(); syncJson(); preview(); show('adminUploadDone');
  } catch (error) {
    if (created) { try { await api('/api/admin/uploads/' + created.id, 'DELETE'); } catch {} }
    if (error.name === 'AbortError') show('adminUploadCancelled'); else problem(error);
  } finally {
    uploadController = null; element('upload-progress').hidden = true; setBusy(false);
    for (const [name] of fields) element('upload-' + name).value = '';
  }
}
for (const [field, kind, key] of fields) {
  const group = document.createElement('section');
  const label = document.createElement('div'); label.className = 'file-control'; const title = document.createElement('span'); title.dataset.i18n = key; title.textContent = t(key);
  const input = document.createElement('input'); input.type = 'file'; input.id = 'upload-' + field;
  input.hidden = true;
  if (kind === 'thumbnail') input.accept = '.png,.jpg,.jpeg,.webp';
  input.addEventListener('change', () => { if (input.files?.[0]) upload(field, kind, input.files[0]); });
  const select = document.createElement('select'); select.id = 'existing-' + field;
  select.setAttribute('aria-label', t('adminChooseExisting', { name: t(key) }));
  select.addEventListener('change', () => { if (select.value) model[field] = select.value; else delete model[field]; dirty = true; element('current-' + field).textContent = files.find(file => file.key === model[field])?.name || model[field] || t('adminNoFile'); syncJson(); preview(); select.blur(); });
  const current = document.createElement('small'); current.id = 'current-' + field;
  const choose = makeButton('adminChooseUpload', () => input.click()); choose.dataset.i18n = 'adminChooseUpload';
  label.append(title, choose, input, select, current); group.appendChild(label); element('file-fields').appendChild(group);
}
element('game-title').addEventListener('input', event => { model.title = event.target.value; dirty = true; syncJson(); });
element('game-system').addEventListener('change', event => { model.system = model.core = event.target.value; delete model.coreOverride; autoSystem = false; dirty = true; coreOptions(); syncJson(); event.target.blur(); });
element('game-core').addEventListener('change', event => { if (event.target.value) model.coreOverride = event.target.value; else delete model.coreOverride; autoSystem = false; dirty = true; syncJson(); event.target.blur(); });
element('game-status').addEventListener('change', event => { model.status = event.target.value; dirty = true; syncJson(); event.target.blur(); });
element('game-json').addEventListener('input', () => { jsonDirty = dirty = true; });
element('apply-json').addEventListener('click', () => {
  try {
    const config = JSON.parse(element('game-json').value);
    if (!config || typeof config !== 'object' || Array.isArray(config) || (model.id && config.id !== model.id) || typeof config.title !== 'string') throw new Error('invalidJson');
    model = { ...config, id: model.id, revision: model.revision, saveName: model.saveName || config.saveName };
    autoSystem = false;
    dirty = true; fill(); show('adminJsonApplied');
  } catch { problem(new Error('invalidJson')); }
});
element('game-form').addEventListener('submit', async event => {
  event.preventDefault(); if (busy) return;
  if (jsonDirty) { show('adminApplyJsonFirst', {}, true); return; }
  setBusy(true);
  try {
    model = await api('/api/admin/games' + (model.id ? '/' + model.id : ''), model.id ? 'PUT' : 'POST', model);
    dirty = false; await refresh(); fill(); show('adminSaved');
  } catch (error) { problem(error); }
  finally { setBusy(false); }
});
element('cancel-upload').addEventListener('click', () => uploadController?.abort());
element('new-game').addEventListener('click', () => selectGame(null));
element('admin-search').addEventListener('input', renderGames);
element('show-trash').addEventListener('change', renderGames);
element('import-json').addEventListener('click', () => element('import-input').click());
element('import-input').addEventListener('change', async event => {
  const file = event.target.files?.[0]; event.target.value = ''; if (!file || busy) return;
  try {
    if (file.size > 1024 * 1024) throw new Error('requestTooLarge');
    let input; try { input = JSON.parse(await file.text()); } catch { throw new Error('invalidJson'); }
    if (!Array.isArray(input)) throw new Error('invalidJson');
    if (!await ask('adminConfirmImport', { count: input.length })) return;
    setBusy(true); await api('/api/admin/import', 'POST', input); await refresh(); show('adminImported');
  } catch (error) { problem(error); } finally { setBusy(false); }
});
function download(data, name) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url; link.download = name; document.body.appendChild(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 30000);
}
element('export-json').addEventListener('click', async () => { try { download(await api('/api/admin/export'), 'retrovault-games.json'); } catch (error) { problem(error); } });
element('logout').addEventListener('click', async () => {
  if (dirty && !await ask('adminDiscardChanges')) return;
  try { await api('/api/auth/logout', 'POST', {}); dirty = false; location.assign('/admin/login'); } catch (error) { problem(error); }
});
const language = element('language-select'); language.value = i18n.mode;
language.addEventListener('change', () => { i18n.setLanguage(language.value); language.blur(); });
i18n.onChange(() => {
  language.value = i18n.mode; systemOptions(); renderGames(); renderFiles(); fileChoices();
  element('editor-heading').textContent = t(model.id ? 'adminEdit' : 'adminAdd');
  if (statusMessage) show(statusMessage.key, statusMessage.values, statusMessage.error);
});
window.addEventListener('beforeunload', event => { if (dirty || busy) { event.preventDefault(); event.returnValue = ''; } });
i18n.apply();
setBusy(true);
try {
  csrf = (await api('/api/auth/session')).csrf;
  await refresh();
  model = { title: '', system: 'nes', core: 'nes', status: 'draft' };
  fill();
} catch (error) { problem(error); }
finally { setBusy(false); }
