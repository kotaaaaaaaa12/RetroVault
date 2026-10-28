const i18n = window.RetroI18n;
const language = document.getElementById('language-select');
language.value = i18n.mode;
language.addEventListener('change', () => { i18n.setLanguage(language.value); language.blur(); });
i18n.onChange(() => { language.value = i18n.mode; });
const status = document.getElementById('login-status');
let errorKey = '';
i18n.onChange(() => { if (errorKey) status.textContent = i18n.t(errorKey); });
document.getElementById('login-form').addEventListener('submit', async event => {
  event.preventDefault();
  const button = event.target.querySelector('button');
  button.disabled = true;
  status.hidden = true;
  try {
    const response = await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: document.getElementById('password').value }) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'serverError');
    document.getElementById('password').value = '';
    const next = new URLSearchParams(location.search).get('next') || '/admin/';
    location.assign(next.startsWith('/') && !next.startsWith('//') && !next.includes('\\') && !/[\u0000-\u001f]/.test(next) ? next : '/admin/');
  } catch (error) {
    errorKey = i18n.t(error.message) !== error.message ? error.message : 'serverError';
    status.textContent = i18n.t(errorKey); status.hidden = false; status.classList.add('error');
  } finally { button.disabled = false; }
});
i18n.apply();
