// Hindsight (cloud or self-hosted): one document per page (document_id = page_key), replaced on revisits.
// The bank must store chunks only: with model extraction every page would run through the user's LLM quota.
import { request, netDetail, json, pageContent, pageMetadata, unchanged, UNCHANGED, classify } from './http.js';

const bank = config => config.url.replace(/\/+$/, '') + '/v1/default/banks/' + encodeURIComponent(config.bank);

const call = (config, method, path, body) => request(bank(config) + path, {
  method,
  headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
  body: body && JSON.stringify(body),
});

const STORE_ONLY = { retain_extraction_mode: 'chunks', enable_observations: false };
const storeOnly = c => c?.retain_extraction_mode === 'chunks' && c.enable_observations === false;

export default {
  id: 'hindsight',
  label: 'Hindsight',
  keepsLatest: true, // one copy per page, replaced by each version: takes the versions sent while a visit is open
  keyPage: 'https://ui.hindsight.vectorize.io',
  // Cloud keys start hsk_; a self-hosted server accepts whatever key its admin set, so a picked Hindsight with any
  // other key is self-hosted and the connect box asks for its address instead of using the cloud default.
  oddKeySelfHosted: true,
  fromKey: (text, picked = false) => {
    const apiKey = text.trim();
    return (picked ? /^\S+$/ : /^hsk_\S{8,}$/).test(apiKey) ? { apiKey } : null;
  },
  defaultKinds: ['read', 'glance'],
  configFields: [
    { name: 'apiKey', type: 'password' },
    { name: 'url', type: 'url', label: 'fieldUrl', default: 'https://api.hindsight.vectorize.io', ask: true },
    { name: 'bank', type: 'text', label: 'fieldBank', default: 'afferent', ask: true },
  ],
  origins: config => [new URL(config.url).origin + '/*'],

  async send(record, config, state) {
    const content = pageContent(record);
    try {
      const last = await unchanged(state, `${config.url} ${config.bank} ${record.page_key}`, record, content);
      if (last.same) return UNCHANGED;
      // metadata is dict[str, str] on the server.
      const metadata = Object.fromEntries(Object.entries(pageMetadata(record)).map(([k, v]) => [k, String(v)]));
      const res = await call(config, 'POST', '/memories', { async: true, items: [{ content, document_id: record.page_key,
        metadata, timestamp: record.last_seen, update_mode: 'replace' }] });
      const body = await json(res);
      if (res.ok && body.success === true) { await last.save(); return { outcome: 'done', detail: String(res.status) }; }
      const detail = `HTTP ${res.status}` + (typeof body.detail === 'string' ? ' ' + body.detail.slice(0, 80) : '');
      // A 2xx without success: true stored nothing: keep the page.
      return { outcome: res.ok ? 'retry' : classify(res.status), detail };
    } catch (e) {
      return { outcome: 'retry', detail: netDetail(e) };
    }
  },

  // Runs on connect. Creates a missing bank store-only; never changes a bank that already existed (it may be
  // the user's working bank, and switching its mode would turn off its extraction).
  async test(config) {
    let res, created = false;
    try {
      res = await call(config, 'GET', '/config');
      if (res.status === 404) {
        const put = await call(config, 'PUT', '', STORE_ONLY);
        // No bank endpoint here at all: the URL is wrong, not a server that refuses setup.
        if (put.status === 404 || put.status === 405) return { result: 'error', detail: `HTTP ${put.status}` };
        created = true;
        res = await call(config, 'GET', '/config');
      }
    } catch (e) {
      return { result: 'unreachable', detail: netDetail(e) };
    }
    if (res.status === 401 || res.status === 403) return { result: 'auth' };
    const got = res.status === 200 ? (await json(res)).config : undefined;
    // A 200 without a config object is not the Hindsight API (e.g. its web UI's fallback page): wrong URL.
    if (res.status === 200 && (typeof got !== 'object' || got === null)) return { result: 'error', detail: 'HTTP 200' };
    // After a PUT, anything but a confirmed store-only bank means the server would not set it up.
    if (res.status === 200 && storeOnly(got)) return { result: 'ok' };
    if (created) return { result: 'refused', message: 'hsRefuseSetup' };
    if (res.status !== 200) return { result: 'error', detail: `HTTP ${res.status}` };
    return { result: 'refused', message: 'hsRefuseExtracts' };
  },
};
