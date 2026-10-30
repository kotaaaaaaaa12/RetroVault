const i18n = window.RetroI18n;
const language = document.getElementById('language-select');
i18n.bindLanguageSelect(language);
document.getElementById('login-form').addEventListener('submit', async event => {
  event.preventDefault();
  const button = event.target.querySelector('button');
  button.disabled = true;
  window.RetroNotices.dismiss('login');
  try {
    const response = await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: document.getElementById('password').value }) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'serverError');
    document.getElementById('password').value = '';
    const next = new URLSearchParams(location.search).get('next') || '/admin/';
    location.assign(next.startsWith('/') && !next.startsWith('//') && !next.includes('\\') && !/[\u0000-\u001f]/.test(next) ? next : '/admin/');
  } catch (error) {
    const errorKey = i18n.t(error.message) !== error.message ? error.message : 'serverError';
    window.RetroNotices.notify('login', { key: errorKey, error: true });
  } finally { button.disabled = false; }
});
i18n.apply();
