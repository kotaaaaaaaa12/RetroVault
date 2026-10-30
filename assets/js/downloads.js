"use strict";
(() => {
  const I18n = window.RetroI18n, cache = window.RetroRomCache;
  const list = document.getElementById('cache-entries'), clear = document.getElementById('cache-clear'), refresh = document.getElementById('cache-refresh');
  let entries = [], busy = false;
  const notify = (key, error = false) => window.RetroNotices.notify('rom-cache', { key, error });
  function render() {
    list.replaceChildren();
    document.getElementById('cache-summary').textContent = I18n.t('romCacheSummary', { count: entries.length, size: I18n.formatBytes(entries.reduce((sum, entry) => sum + entry.size, 0)) });
    document.getElementById('cache-empty').hidden = entries.length !== 0;
    clear.disabled = busy || !entries.length; refresh.disabled = busy;
    for (const entry of entries) {
      const row = document.createElement('article'), text = document.createElement('div'), title = document.createElement('h2'), info = document.createElement('p'), button = document.createElement('button');
      row.className = 'cache-entry'; title.textContent = entry.name; info.className = 'hint';
      info.textContent = `${I18n.formatBytes(entry.size)} · ${I18n.t(entry.complete ? 'romCacheReady' : 'romCacheIncomplete')}`;
      button.type = 'button'; button.textContent = I18n.t('romCacheDelete'); button.disabled = busy;
      button.addEventListener('click', () => removeEntries([entry]));
      text.append(title, info); row.append(text, button); list.append(row);
    }
  }
  async function load() {
    try { entries = await cache.list(); render(); }
    catch { notify('romDiskUnavailable', true); }
  }
  async function removeEntries(items) {
    if (busy) return;
    busy = true; render(); let failed = false;
    for (const entry of items) {
      try { await cache.remove(entry.key); }
      catch { failed = true; }
    }
    busy = false; await load(); notify(failed ? 'romCacheBusy' : 'romCacheDeleted', failed);
  }
  refresh.addEventListener('click', load);
  clear.addEventListener('click', () => removeEntries([...entries]));
  I18n.bindLanguageSelect(document.getElementById('language-select'));
  I18n.onChange(render);
  load();
})();
