import { SYSTEMS, detectSystem, systemFor } from './systems.js';
import { formatFileSize as bytes } from './file-size.js';
import { uploadPart } from './upload-part.js';

const i18n = window.RetroI18n;
const t = (key, values) => i18n.t(key, values);
const element = id => document.getElementById(id);
let csrf = '';
let games = [];
let orderRevision = 0;
let files = [];
let model = {};
let busy = false;
let dirty = false;
let jsonDirty = false;
let uploadController = null;
let uploadResults = [];
let uploadProgress = null;
const fields = [ ['rom', 'rom', 'adminRom'], ['thumbnail', 'thumbnail', 'adminThumbnail'], ['bios', 'bios', 'adminBios'], ['patch', 'patch', 'adminPatch'] ];
const clean = game => Object.fromEntries(Object.entries(game).filter(([key]) => !['updatedAt', 'revision'].includes(key)));

function show(key, values = {}, error = false) {
  window.RetroNotices.notify('admin', { key, values, error });
}
function problem(error) {
  const key = t(error.message) === error.message ? 'serverError' : error.message;
  show(key, {}, true);
}
function setBusy(value) {
  busy = value;
  for (const control of document.querySelectorAll('button, input, select, textarea')) {
    if (['language-select', 'cancel-upload'].includes(control.id) || control.closest('#rv-notices')) continue;
    control.disabled = value;
  }
  updateOrderControls();
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
function restoreRomSystem(previous) {
  model.system = previous.system; model.core = previous.core;
  if (previous.coreOverride) model.coreOverride = previous.coreOverride; else delete model.coreOverride;
  element('game-system').value = model.system;
  coreOptions();
}
function selectRomSystem(filename) {
  const system = detectSystem(filename);
  if (!system) return;
  if ((model.system || systemFor(model.core)?.id) !== system) {
    model.system = model.core = system;
    delete model.coreOverride;
  }
  element('game-system').value = system;
  coreOptions();
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
  element('game-title').value = model.titleEn ?? (model.titleJa ? '' : model.title || '');
  element('game-title-ja').value = model.titleJa || '';
  systemOptions(); element('game-system').value = model.system || systemFor(model.core)?.id || 'nes'; coreOptions();
  element('game-status').value = model.status === 'ready' ? 'ready' : 'draft';
  fileChoices(); preview(); syncJson(true);
}
async function selectGame(game) {
  if (busy || (dirty && !await ask('adminDiscardChanges'))) return;
  model = game ? structuredClone(game) : { title: '', system: 'nes', core: 'nes', status: 'draft' };
  dirty = false; fill();
}
function makeButton(key, action) {
  const button = document.createElement('button'); button.type = 'button'; button.textContent = t(key);
  button.addEventListener('click', async () => { button.blur(); try { await action(); } catch (error) { problem(error); } });
  return button;
}
function renderGames() {
  const root = element('admin-games'); root.replaceChildren();
  const search = element('admin-search').value.trim().toLowerCase();
  for (const game of games.filter(game => (element('show-trash').checked ? game.status === 'trashed' : game.status !== 'trashed') && [game.title, game.titleEn, game.titleJa].filter(Boolean).join('\n').toLowerCase().includes(search))) {
    const row = document.createElement('section'); row.className = 'game-row';
    row.dataset.gameId = String(game.id);
    const title = document.createElement('strong'); title.textContent = i18n.gameTitle(game);
    const info = document.createElement('small'); info.textContent = `#${game.id} · ${game.system || game.core} · ${game.coreOverride || game.core} · ` + t(game.status === 'ready' ? 'adminReady' : game.status === 'trashed' ? 'adminTrashed' : 'adminDraft');
    const actions = document.createElement('div'); actions.className = 'actions';
    if (game.status !== 'trashed') actions.append(makeButton('adminEdit', () => selectGame(game)), makeButton('adminTrash', () => changeGame(game, 'trash')));
    else actions.append(makeButton('adminRestore', () => changeGame(game, 'restore')), makeButton('adminDeleteEntry', () => changeGame(game, 'delete')));
    if (game.status !== 'trashed') {
      const order = document.createElement('div'); order.className = 'game-order actions';
      for (const [key, direction, action] of [['adminMoveUp', -1, 'up'], ['adminMoveDown', 1, 'down']]) {
        const button = makeButton(key, () => moveGame(game, direction));
        button.dataset.orderAction = action; button.dataset.gameId = String(game.id);
        button.setAttribute('aria-label', t(key) + ': ' + i18n.gameTitle(game));
        order.appendChild(button);
      }
      row.appendChild(order);
    }
    row.append(title, info, actions); root.appendChild(row);
  }
  updateOrderControls();
}
function updateOrderControls() {
  const active = games.filter(game => game.status !== 'trashed');
  const searching = !!element('admin-search').value.trim();
  for (const button of document.querySelectorAll('[data-order-action]')) {
    const index = active.findIndex(game => String(game.id) === button.dataset.gameId);
    button.disabled = busy || searching || index < 0 || (button.dataset.orderAction === 'up' ? index === 0 : index === active.length - 1);
  }
}
async function moveGame(game, direction) {
  if (busy || element('admin-search').value.trim()) return;
  const active = games.filter(item => item.status !== 'trashed');
  const neighbor = active[active.findIndex(item => item.id === game.id) + direction];
  if (!neighbor) return;
  const ids = games.map(item => item.id);
  const from = ids.indexOf(game.id), to = ids.indexOf(neighbor.id);
  [ids[from], ids[to]] = [ids[to], ids[from]];
  setBusy(true);
  try {
    await api('/api/admin/order', 'POST', { ids, revision: orderRevision });
    await refresh(); show('adminOrderSaved');
  } catch (error) {
    if (error.message === 'orderConflict') await refresh();
    problem(error);
  } finally { setBusy(false); }
}
function renderFiles() {
  element('storage-summary').textContent = t('adminStorageSummary', { count: files.length, size: bytes(files.reduce((total, file) => total + (file.status === 'ready' ? file.size : 0), 0)) });
  const root = element('admin-files');
  const opened = new Set(Array.from(root.querySelectorAll('details[open]'), group => group.dataset.fileKind));
  root.replaceChildren();
  for (const [kind, key] of [['rom', 'adminCategoryRom'], ['thumbnail', 'adminCategoryThumbnail'], ['bios', 'adminCategoryBios'], ['patch', 'adminCategoryPatch']]) {
    const members = files.filter(file => file.kind === kind);
    const group = document.createElement('details');
    group.className = 'file-category'; group.dataset.fileKind = kind; group.open = opened.has(kind);
    const summary = document.createElement('summary');
    const title = document.createElement('span'); title.textContent = `${t(key)} (${members.length})`;
    const size = document.createElement('small');
    size.textContent = t('adminCategorySize', { size: bytes(members.reduce((total, file) => total + (file.status === 'ready' ? file.size : 0), 0)) });
    summary.append(title, size); group.appendChild(summary);
    const list = document.createElement('div'); list.className = 'file-category-list';
    if (!members.length) {
      const empty = document.createElement('p'); empty.className = 'hint'; empty.textContent = t('adminEmptyCategory'); list.appendChild(empty);
    }
    for (const file of members) {
      const row = document.createElement('div'); row.className = 'file-row';
      const info = document.createElement('p'); info.textContent = `${file.name} · ${bytes(file.size)} · ` + t(file.status === 'ready' ? 'adminFileReady' : file.status === 'deleting' ? 'adminFileRemoving' : 'adminUploading');
      row.append(info, makeButton('adminRemoveFile', async () => {
        if (busy || !await ask('adminConfirmRemoveFile', { name: file.name })) return;
        setBusy(true);
        try { await api('/api/admin/files/' + file.id, 'DELETE'); await refresh(); show('adminFileRemoved'); }
        finally { setBusy(false); }
      }));
      list.appendChild(row);
    }
    group.appendChild(list); root.appendChild(group);
  }
}
async function refresh() {
  const [catalog, storedFiles] = await Promise.all([api('/api/admin/catalog'), api('/api/admin/files')]);
  games = catalog.games; orderRevision = catalog.orderRevision; files = storedFiles;
  renderGames(); renderFiles(); fileChoices();
}
async function changeGame(game, action) {
  if (busy || !await ask(action === 'delete' ? 'adminConfirmDeleteEntry' : action === 'trash' ? 'adminConfirmTrash' : 'adminConfirmRestore', { title: i18n.gameTitle(game) })) return;
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
function renderUploadResults() {
  element('upload-results').hidden = !uploadResults.length;
  const root = element('upload-results-list'); root.replaceChildren();
  for (const result of uploadResults) {
    const row = document.createElement('li'); row.className = 'upload-result'; row.dataset.state = result.state;
    const state = t({ waiting: 'adminUploadWaiting', uploading: 'adminUploading', complete: 'adminFileReady', failed: 'adminUploadFailed', cancelled: 'adminUploadSkipped' }[result.state]);
    row.textContent = `${result.name} · ${bytes(result.size)} · ${state}` + (result.error ? ' — ' + t(result.error) : '');
    root.appendChild(row);
  }
  if (uploadProgress) {
    element('upload-label').textContent = t('adminUploadByteProgress', uploadProgress);
    element('upload-phase').textContent = t(uploadProgress.phase);
  }
}
async function transferFile(kind, original, signal, progress) {
  let created;
  let completed = false;
  try {
    signal.throwIfAborted();
    const file = kind === 'thumbnail' ? await thumbnail(original) : original;
    signal.throwIfAborted();
    progress(0, file.size);
    created = await api('/api/admin/uploads', 'POST', { kind, name: file.name, size: file.size });
    for (let part = 1; part <= created.parts; part++) {
      signal.throwIfAborted();
      const body = file.slice((part - 1) * created.partBytes, Math.min(part * created.partBytes, file.size));
      for (let attempt = 0; ; attempt++) {
        try {
          await uploadPart(`/api/admin/uploads/${created.id}/parts/${part}`, body, {
            signal, csrf,
            onProgress: loaded => progress(((part - 1) * created.partBytes + loaded) / file.size, file.size),
            onUnauthorized: () => location.assign('/admin/login?next=/admin/')
          });
          break;
        }
        catch (error) { if (attempt >= 2 || signal.aborted || ['loginRequired', 'invalidSession'].includes(error.message)) throw error; await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1))); }
      }
      progress(Math.min(part * created.partBytes, file.size) / file.size, file.size);
    }
    signal.throwIfAborted();
    // Finish this commit before honoring cancellation of the remaining queue.
    progress(1, file.size, 'adminUploadFinalizing');
    await api('/api/admin/uploads/' + created.id + '/complete', 'POST', {});
    progress(1, file.size, 'adminFileReady');
    completed = true;
    return { key: created.key, size: file.size };
  } catch (error) {
    if (created && !completed) { try { await api('/api/admin/uploads/' + created.id, 'DELETE'); } catch {} }
    throw error;
  }
}
async function upload(field, kind, originals) {
  if (busy || !originals.length) return;
  setBusy(true); uploadController = new AbortController();
  window.RetroNotices.dismiss('admin');
  const signal = uploadController.signal;
  uploadResults = originals.map(file => ({ name: file.name, size: file.size, state: 'waiting' }));
  uploadProgress = null;
  element('upload-progress').hidden = false;
  element('upload-meter').value = 0;
  element('cancel-upload').disabled = false;
  renderUploadResults();
  let selected = false;
  let completed = 0;
  let failed = 0;
  const previousSystem = { system: model.system, core: model.core, coreOverride: model.coreOverride };
  if (kind === 'rom') { selectRomSystem(originals[0].name); syncJson(); }
  try {
    for (let index = 0; index < originals.length; index++) {
      if (signal.aborted) break;
      const original = originals[index];
      const result = uploadResults[index];
      const progress = (fraction, totalBytes = original.size, phase = 'adminUploading') => {
        const percent = Math.floor(Math.min(phase === 'adminFileReady' ? 1 : .99, fraction) * 100);
        element('upload-meter').value = percent;
        uploadProgress = { index: index + 1, total: originals.length, name: original.name, percent, loaded: bytes(Math.floor(fraction * totalBytes)), size: bytes(totalBytes), phase };
        element('upload-label').textContent = t('adminUploadByteProgress', uploadProgress);
        element('upload-phase').textContent = t(phase);
      };
      result.state = 'uploading'; progress(0, original.size, 'adminUploadPreparing'); renderUploadResults();
      try {
        const stored = await transferFile(kind, original, signal, progress);
        result.state = 'complete'; result.size = stored.size; completed++;
        // A batch never replaces the current selection with every later file.
        if (!selected) {
          selected = true; model[field] = stored.key; dirty = true;
          if (kind === 'rom') {
            restoreRomSystem(previousSystem); selectRomSystem(original.name);
            if (!model.id && !i18n.gameTitle(model)) { model.title = model.titleEn = original.name.replace(/\.[^.]+$/, ''); element('game-title').value = model.title; }
          }
          syncJson(); preview();
        }
      } catch (error) {
        if (signal.aborted || error.name === 'AbortError') result.state = 'cancelled';
        else {
          result.state = 'failed'; failed++;
          result.error = t(error.message) === error.message ? 'serverError' : error.message;
          if (['loginRequired', 'invalidSession'].includes(error.message)) uploadController.abort();
        }
      }
      renderUploadResults();
    }
    for (const result of uploadResults) if (result.state === 'waiting') result.state = 'cancelled';
    if (kind === 'rom' && !selected) restoreRomSystem(previousSystem);
    renderUploadResults();
    await refresh(); syncJson(); preview();
    if (signal.aborted) show('adminUploadBatchCancelled', { completed, total: originals.length });
    else if (failed) show('adminUploadBatchFinished', { completed, failed }, true);
    else if (originals.length === 1) show('adminUploadDone');
    else show('adminUploadBatchDone', { count: completed });
  } catch (error) {
    problem(error);
  } finally {
    uploadController = null; uploadProgress = null; element('upload-progress').hidden = true; setBusy(false);
    for (const [name] of fields) element('upload-' + name).value = '';
  }
}
for (const [field, kind, key] of fields) {
  const group = document.createElement('section');
  const label = document.createElement('div'); label.className = 'file-control'; const title = document.createElement('span'); title.dataset.i18n = key; title.textContent = t(key);
  const input = document.createElement('input'); input.type = 'file'; input.id = 'upload-' + field;
  input.hidden = true;
  input.multiple = kind === 'rom' || kind === 'thumbnail';
  if (kind === 'thumbnail') input.accept = '.png,.jpg,.jpeg,.webp';
  input.addEventListener('change', () => { if (input.files?.length) upload(field, kind, Array.from(input.files)); });
  const select = document.createElement('select'); select.id = 'existing-' + field;
  select.setAttribute('aria-label', t('adminChooseExisting', { name: t(key) }));
  select.addEventListener('change', () => {
    if (select.value) model[field] = select.value; else delete model[field];
    const file = files.find(file => file.key === model[field]);
    if (kind === 'rom' && file) selectRomSystem(file.name);
    dirty = true; element('current-' + field).textContent = file?.name || model[field] || t('adminNoFile');
    syncJson(); preview(); select.blur();
  });
  const current = document.createElement('small'); current.id = 'current-' + field;
  const chooseKey = input.multiple ? 'adminChooseUploads' : 'adminChooseUpload';
  const choose = makeButton(chooseKey, () => input.click()); choose.dataset.i18n = chooseKey;
  label.append(title, choose, input, select, current); group.appendChild(label); element('file-fields').appendChild(group);
}
for (const id of ['game-title', 'game-title-ja']) element(id).addEventListener('input', () => {
  model.titleEn = element('game-title').value; model.titleJa = element('game-title-ja').value;
  model.title = model.titleEn.trim() || model.titleJa.trim();
  dirty = true; syncJson();
});
element('game-system').addEventListener('change', event => { model.system = model.core = event.target.value; delete model.coreOverride; dirty = true; coreOptions(); syncJson(); event.target.blur(); });
element('game-core').addEventListener('change', event => { if (event.target.value) model.coreOverride = event.target.value; else delete model.coreOverride; dirty = true; syncJson(); event.target.blur(); });
element('game-status').addEventListener('change', event => { model.status = event.target.value; dirty = true; syncJson(); event.target.blur(); });
element('game-json').addEventListener('input', () => { jsonDirty = dirty = true; });
element('apply-json').addEventListener('click', () => {
  try {
    const config = JSON.parse(element('game-json').value);
    if (!config || typeof config !== 'object' || Array.isArray(config) || (model.id && config.id !== model.id) || !['title', 'titleEn', 'titleJa'].some(key => typeof config[key] === 'string')) throw new Error('invalidJson');
    model = { ...config, id: model.id, revision: model.revision, saveName: model.saveName || config.saveName };
    dirty = true; fill(); show('adminJsonApplied');
  } catch { problem(new Error('invalidJson')); }
});
element('game-form').addEventListener('submit', async event => {
  event.preventDefault(); if (busy) return;
  if (jsonDirty) { show('adminApplyJsonFirst', {}, true); return; }
  model.titleEn = element('game-title').value.trim(); model.titleJa = element('game-title-ja').value.trim();
  model.title = model.titleEn || model.titleJa;
  if (!model.title) { show('invalidTitle', {}, true); return; }
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
const language = element('language-select'); i18n.bindLanguageSelect(language);
i18n.onChange(() => {
  systemOptions(); renderGames(); renderFiles(); fileChoices();
  renderUploadResults();
  element('editor-heading').textContent = t(model.id ? 'adminEdit' : 'adminAdd');
  element('game-identity').textContent = model.id ? t('adminIdentity', { id: model.id, revision: model.revision }) : t('adminNewIdentity');
  for (const [field, , key] of fields) element('existing-' + field).setAttribute('aria-label', t('adminChooseExisting', { name: t(key) }));
});
window.addEventListener('beforeunload', event => { if (dirty || busy) { event.preventDefault(); event.returnValue = ''; } });
i18n.apply();
window.RetroNotices.mount(element('upload-progress'));
setBusy(true);
try {
  csrf = (await api('/api/auth/session')).csrf;
  await refresh();
  model = { title: '', system: 'nes', core: 'nes', status: 'draft' };
  fill();
} catch (error) { problem(error); }
finally { setBusy(false); }
