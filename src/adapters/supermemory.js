// Supermemory v5: one document per page (id = page_key); the latest visit replaces its content.
// https://supermemory.ai/docs/v5/api-reference/ingest/update-document.md
import { request, netDetail, json, pageContent, pageMetadata, unchanged, UNCHANGED, classify } from './http.js';

const API = 'https://api.supermemory.ai';
// Options refuses to save a namespace that fails this, so the adapter trusts it.
const NS_RULE = '[a-zA-Z0-9_:\\-]{1,100}';
const ns = config => config.namespace || 'afferent';

const call = (config, method, path, body) => request(API + path, {
  method,
  headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
  body: body && JSON.stringify(body),
});

async function outcome(res) {
  const s = res.status, body = await json(res);
  if (s >= 200 && s < 300) return { outcome: 'done', detail: body.status || String(s) };
  return { outcome: classify(s), detail: `HTTP ${s}` + (typeof body.error === 'string' ? ' ' + body.error.slice(0, 80) : '') };
}

export default {
  id: 'supermemory',
  label: 'Supermemory',
  keepsLatest: true, // one copy per page, replaced by each version: takes the versions sent while a visit is open
  keyPage: 'https://console.supermemory.ai',
  fromKey: (text, picked = false) => {
    const apiKey = text.trim();
    return (picked ? /^\S+$/ : /^sm_\S{8,}$/).test(apiKey) ? { apiKey } : null;
  },
  defaultKinds: ['read', 'glance'],
  configFields: [
    { name: 'apiKey', type: 'password' },
    { name: 'namespace', type: 'text', label: 'fieldNamespace', default: 'afferent', pattern: NS_RULE },
  ],
  origins: () => [API + '/*'],

  async send(record, config, state) {
    // superrag: chunk and index only, no fact extraction; about 5× cheaper than "memory".
    const body = { content: pageContent(record), metadata: pageMetadata(record), taskType: 'superrag' };
    try {
      const last = await unchanged(state, ns(config) + ':' + record.page_key, record, body.content);
      if (last.same) return UNCHANGED;
      // Only PATCH replaces; POSTing an existing id appends to it, so POST is for the first visit only.
      let res = await call(config, 'PATCH', `/ns/${ns(config)}/document/${record.page_key}`, body);
      if (res.status === 404) res = await call(config, 'POST', `/ns/${ns(config)}/document`, { id: record.page_key, ...body });
      const out = await outcome(res);
      if (out.outcome === 'done') await last.save();
      return out;
    } catch (e) {
      return { outcome: 'retry', detail: netDetail(e) };
    }
  },

  async test(config) {
    let res;
    try { res = await call(config, 'POST', `/ns/${ns(config)}/list/documents?limit=1`); } catch (e) {
      return { result: 'unreachable', detail: netDetail(e) };
    }
    if (res.status === 200) return { result: 'ok' };
    if (res.status === 401 || res.status === 403) return { result: 'auth' };
    return { result: 'error', detail: `HTTP ${res.status}` };
  },
};
