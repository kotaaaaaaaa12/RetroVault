"use strict";

(() => {
  const entries = new Map();
  let region;
  function mount(node) {
    if (!region) {
      region = document.createElement('div');
      region.id = 'rv-notices';
    }
    const host = document.fullscreenElement || document.webkitFullscreenElement || document.body;
    if (region.parentNode !== host) host.appendChild(region);
    if (node && node.parentNode !== region) region.appendChild(node);
    return region;
  }
  function dismiss(id) {
    const entry = entries.get(id);
    if (!entry) return;
    clearTimeout(entry.timer);
    entry.node.remove();
    entries.delete(id);
  }
  function render(entry) {
    const i18n = window.RetroI18n;
    entry.text.textContent = entry.key ? i18n.t(entry.key, entry.values) : entry.message;
    entry.close.setAttribute('aria-label', i18n.t('dismissNotification'));
  }
  function notify(id, { key, values = {}, message = '', error = false }) {
    dismiss(id);
    const node = document.createElement('section');
    node.className = 'rv-toast';
    node.dataset.noticeId = id;
    node.classList.toggle('error', error);
    node.setAttribute('role', error ? 'alert' : 'status');
    node.setAttribute('aria-atomic', 'true');
    const text = document.createElement('p');
    const close = document.createElement('button');
    close.type = 'button'; close.className = 'rv-toast-close'; close.textContent = '×';
    const entry = { node, text, close, key, values, message, error, timer: null };
    const pause = () => clearTimeout(entry.timer);
    const schedule = () => { pause(); if (!error) entry.timer = setTimeout(() => dismiss(id), 8000); };
    close.addEventListener('click', () => dismiss(id));
    node.addEventListener('pointerenter', pause);
    node.addEventListener('pointerleave', schedule);
    node.addEventListener('focusin', pause);
    node.addEventListener('focusout', schedule);
    node.append(text, close); render(entry); entries.set(id, entry); mount(node); schedule();
  }
  document.addEventListener('fullscreenchange', () => { if (region) mount(); });
  document.addEventListener('webkitfullscreenchange', () => { if (region) mount(); });
  window.RetroI18n.onChange(() => { for (const entry of entries.values()) render(entry); });
  window.RetroNotices = { notify, dismiss, mount };
})();
