// Generic webhook speaking afferent.page/1 (see docs/webhook.md).
import { request, netDetail, json } from './http.js';

function call(config, init) {
  const headers = { ...init.headers };
  if (config.token) headers.Authorization = `Bearer ${config.token}`;
  return request(config.url, { ...init, headers });
}

// Key: nsk_ + base64url(URL, no padding) + '.' + token, the token being everything after the first dot.
// Still accepted, the older connection code: <url>#token=<token>&name=<name>. Not URLSearchParams: it would turn
// '+' in a token into a space.
function fromKey(text, picked = false) {
  text = text.trim();
  const nsk = /^nsk_([\w-]+)\.(\S+)$/.exec(text); // a token never holds whitespace: such a paste is damaged
  if (nsk) {
    try {
      const bytes = Uint8Array.from(atob(nsk[1].replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
      const url = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      return /^https?:$/.test(new URL(url).protocol) ? { url, token: nsk[2] } : null;
    } catch { return null; } // not base64, not UTF-8 or not a URL
  }
  if (!picked && !/^https?:\/\/\S+#token=\S+/.test(text)) return null;
  const [base, frag = ''] = text.split(/#(.*)/s);
  try {
    if (!/^https?:$/.test(new URL(base).protocol)) return null;
    const p = Object.fromEntries(frag.split('&').map(kv => kv.split(/=(.*)/s)).map(([k, v = '']) => [k, decodeURIComponent(v)]));
    const cfg = { url: base, token: p.token ?? '' };
    if (p.name) cfg.name = p.name;
    return cfg;
  } catch { return null; } // invalid URL or bad %-escape
}

async function post(body, config) {
  let res;
  try {
    res = await call(config, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  } catch (e) {
    return { outcome: 'retry', detail: netDetail(e) };
  }
  const s = res.status;
  if (s >= 200 && s < 300) return { outcome: 'done', detail: (await json(res)).status || String(s) };
  if ([400, 411, 413, 415].includes(s)) return { outcome: 'failed', detail: `HTTP ${s} ${(await json(res)).error || ''}`.trim() };
  if (s === 401 || s === 403) return { outcome: 'auth', detail: `HTTP ${s}` };
  // 408, 429, 5xx and anything the contract does not list: keep the record and retry later.
  return { outcome: 'retry', detail: `HTTP ${s}` };
}

export default {
  id: 'webhook',
  label: 'Neurosea',
  fromKey,
  defaultKinds: ['read', 'glance'],
  configFields: [
    { name: 'url', type: 'url' },
    { name: 'token', type: 'password' },
  ],
  // Host permission patterns to request on Save.
  origins: config => [new URL(config.url).origin + '/*'],

  send: post,
  // afferent.forget/1: same request, auth and outcomes as a page record.
  forget: post,

  async test(config) {
    let res;
    try { res = await call(config, { method: 'GET' }); } catch (e) {
      return { result: 'unreachable', detail: netDetail(e) };
    }
    const body = res.status === 200 ? await json(res) : {};
    if (body.status === 'ok') return { result: 'ok' };
    if (res.status === 401 || res.status === 403) return { result: 'auth' };
    if (res.status === 404 || res.status === 405) return { result: 'no_health' };
    return { result: 'error', detail: `HTTP ${res.status}` };
  },
};
