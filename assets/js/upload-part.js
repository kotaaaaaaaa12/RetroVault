// Report bytes sent within each multipart request, including small files.
export function uploadPart(path, body, { signal, csrf, onProgress, onUnauthorized }) {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const xhr = new XMLHttpRequest();
    const abort = () => xhr.abort();
    const finish = (error, result) => {
      signal.removeEventListener('abort', abort);
      if (error) reject(error); else resolve(result);
    };
    xhr.open('PUT', path);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.setRequestHeader('X-RetroVault-CSRF', csrf);
    xhr.upload.onprogress = event => { if (event.lengthComputable) onProgress(Math.min(body.size, event.loaded)); };
    xhr.onload = () => {
      let data;
      try { data = JSON.parse(xhr.responseText); } catch { data = {}; }
      if (xhr.status === 401) { onUnauthorized(); finish(new Error('loginRequired')); }
      else if (xhr.status < 200 || xhr.status >= 300) finish(new Error(data.error || 'serverError'));
      else { onProgress(body.size); finish(null, data); }
    };
    xhr.onerror = () => finish(new Error('serverError'));
    xhr.onabort = () => finish(new DOMException('Upload cancelled.', 'AbortError'));
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) { finish(new DOMException('Upload cancelled.', 'AbortError')); return; }
    xhr.send(body);
  });
}
