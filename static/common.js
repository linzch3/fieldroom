export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({
    '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'
  })[ch]);
}

export async function api(path, body, key) {
  const headers = {Accept:'application/json'};
  if (body !== undefined && body !== null) headers['Content-Type'] = 'application/json';
  if (key) headers.Authorization = 'Bearer ' + key;
  const response = await fetch(path, {
    method: body == null ? 'GET' : 'POST', headers,
    body: body == null ? undefined : JSON.stringify(body), cache:'no-store',
    signal: AbortSignal.timeout ? AbortSignal.timeout(12000) : undefined
  });
  const data = await response.json();
  if (!response.ok) {
    const error = new Error(data.error || '请求未完成');
    error.status = response.status;
    error.code = data.code;
    throw error;
  }
  return data;
}

let timer;
export function toast(message) {
  const notice = document.querySelector('#notice');
  notice.textContent = message;
  notice.hidden = false;
  clearTimeout(timer);
  timer = setTimeout(() => { notice.hidden = true; }, 4500);
}
