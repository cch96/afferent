// Mem0 platform: one memory per page. Mem0 has no caller-chosen id, so the adapter keeps
// page_key → memory id in its state and updates that memory on revisits.
// https://docs.mem0.ai/openapi.json
import { request, netDetail, json, pageContent, pageMetadata, unchanged, UNCHANGED, classify } from './http.js';

const API = 'https://api.mem0.ai';

const call = (config, method, path, body) => request(API + path, {
  method,
  headers: { Authorization: `Token ${config.apiKey}`, 'Content-Type': 'application/json' },
  body: body && JSON.stringify(body),
});

async function outcome(res) {
  const s = res.status;
  if (s >= 200 && s < 300) return { outcome: 'done', detail: String(s) };
  const msg = (await json(res)).error;
  // Mem0 refuses a too-long add with 400, not 413 (hosted, 2026-11-13): "Messages contain 100,060 tokens, which exceeds the limit of 100,000."
  const tooLong = s === 400 && typeof msg === 'string' && msg.includes('tokens, which exceeds the limit');
  return { outcome: tooLong ? 'failed' : classify(s), detail: `HTTP ${s}` + (typeof msg === 'string' ? ' ' + msg.slice(0, 80) : '') };
}

export default {
  id: 'mem0',
  label: 'Mem0',
  keepsLatest: true, // one copy per page, replaced by each version: takes the versions sent while a visit is open
  keyPage: 'https://app.mem0.ai/dashboard/settings?tab=api-keys',
  fromKey: (text, picked = false) => {
    const apiKey = text.trim();
    return (picked ? /^\S+$/ : /^m0-\S{8,}$/).test(apiKey) ? { apiKey } : null;
  },
  defaultKinds: ['read', 'glance'],
  configFields: [
    { name: 'apiKey', type: 'password' },
    { name: 'userId', type: 'text', label: 'fieldUserId', default: 'afferent' },
  ],
  origins: () => [API + '/*'],

  async send(record, config, state) {
    const userId = config.userId || 'afferent';
    // Keyed by user id too, so changing it never updates a memory in the old scope.
    const key = userId + ':' + record.page_key;
    const content = pageContent(record), metadata = pageMetadata(record);
    try {
      const last = await unchanged(state, key, record, content);
      if (last.same) return UNCHANGED;
      const done = async out => { if (out.outcome === 'done') await last.save(); return out; };
      const id = await state.get(key);
      if (id) {
        const res = await call(config, 'PUT', `/v1/memories/${encodeURIComponent(id)}/`, { text: content, metadata });
        if (res.status !== 404) return done(await outcome(res));
      }
      // Never search for an existing memory: retrievals are capped at 1k/month on the free tier.
      const res = await call(config, 'POST', '/v3/memories/add/',
        { messages: [{ role: 'user', content }], user_id: userId, infer: false, metadata });
      if (res.status < 200 || res.status >= 300) return outcome(res);
      const body = await json(res);
      if (body.status === 'FAILED') return { outcome: 'retry', detail: `HTTP ${res.status} Mem0 status FAILED` };
      // An identical add returns the existing memory's id (2026-11-13); an answer without an id keeps any existing mapping.
      if (body.results?.[0]?.id) await state.set(key, body.results[0].id);
      return done({ outcome: 'done', detail: String(res.status) });
    } catch (e) {
      return { outcome: 'retry', detail: netDetail(e) };
    }
  },

  async test(config) {
    let res;
    try { res = await call(config, 'GET', '/v1/ping/'); } catch (e) {
      return { result: 'unreachable', detail: netDetail(e) };
    }
    if (res.status === 200) return { result: 'ok' };
    if (res.status === 401 || res.status === 403) return { result: 'auth' };
    return { result: 'error', detail: `HTTP ${res.status}` };
  },
};
