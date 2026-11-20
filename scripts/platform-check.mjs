// Real-platform check for the Supermemory, Mem0 and Hindsight destinations (the step-2 gates).
//   SUPERMEMORY_API_KEY=... MEM0_API_KEY=... HINDSIGHT_API_KEY=... [HINDSIGHT_URL=...] [CHECK_WAIT_MIN=3]
//   node scripts/platform-check.mjs
// A platform whose key is missing is skipped. Keys are never printed.
// Supermemory and Mem0 write to a dedicated scope (namespace / user_id "afferent-check") and empty it before
// and after a run, also after a failure: Supermemory deletes every document in the namespace, Mem0 only the
// memories of that user_id whose text holds the check URL (afferent-check.example). Nothing to delete by hand.
// Hindsight uses a new bank per run (afferent-check-<run>) and deletes it at the end, also after a failure.
// CHECK_WAIT_MIN: how long to wait for Hindsight's job queue to write every document (minutes, default 3).
import supermemory from '../src/adapters/supermemory.js';
import mem0 from '../src/adapters/mem0.js';
import hindsight from '../src/adapters/hindsight.js';
import { pageKey } from '../src/lib/url.js';
import { createCore } from '../src/lib/core.js';
import { fakeStore, fakeAlarms } from '../test/fakes.js';

const SCOPE = 'afferent-check';
const run = Date.now().toString(36);
const WORDS = ['quokka lantern', 'basalt origami', 'saffron dirigible', 'tundra marimba', 'cobalt walrus',
  'velvet asteroid', 'juniper turbine', 'obsidian kazoo', 'paprika glacier', 'mango sextant'];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const rows = [];
const gate = (platform, name, pass, detail = '') => rows.push({ platform, gate: name, result: pass ? 'PASS' : 'FAIL', detail });

async function record(i, text) {
  const url = `https://afferent-check.example/page-${i}`;
  const now = new Date().toISOString();
  return { schema: 'afferent.page/1', capture_id: crypto.randomUUID(), page_key: await pageKey(url), kind: 'read', url,
    title: `Afferent check page ${i}`, site: 'afferent-check.example', text, dwell_seconds: 30, first_seen: now,
    last_seen: now, client: { name: 'afferent', version: 'platform-check' } };
}
// Each page carries its own distinctive phrase; revisions of page 0 add "revision N".
const pageText = (i, rev = 0) => `Check run ${run}. The distinctive phrase for this page is ${WORDS[i]} ${i}.`
  + (rev ? ` This is revision ${rev} of page 0.` : ' This is the original text.');

// A very long page (100,000 Chinese characters by default) with quotes, a backslash and an emoji, so escaping is covered.
const bigRecord = (i = 10, n = 100000) => record(i, '汉'.repeat(n / 2) + ' "quoted" \'single\' back\\slash 🦘 ' + '字'.repeat(n / 2));

const memState = (m = {}) => ({ get: async k => m[k], set: async (k, v) => { m[k] = v; } });

async function sendAll(platform, adapter, cfg, state) {
  const recs = [];
  for (let i = 0; i < 10; i++) recs.push(await record(i, pageText(i)));
  const out = [];
  for (const r of recs) out.push((await adapter.send(r, cfg, state)).outcome);
  gate(platform, '(a) 10 sends done', out.every(o => o === 'done'), out.join(','));
  const re = [];
  for (let rev = 1; rev <= 3; rev++) {
    re.push((await adapter.send({ ...recs[0], capture_id: crypto.randomUUID(), text: pageText(0, rev) }, cfg, state)).outcome);
  }
  gate(platform, '(b) 3 re-sends done', re.every(o => o === 'done'), re.join(','));
  return recs;
}

// (d) wrong key: adapter says auth, and core keeps the record queued.
async function wrongKey(platform, adapter, cfg) {
  const r = await record(0, pageText(0, 3));
  const direct = await adapter.send(r, cfg, memState());
  gate(platform, '(d) wrong key → auth', direct.outcome === 'auth', direct.detail);
  const store = fakeStore({ settings: { consent: { agreed: true, at: 'x' } }, ['dest:' + adapter.id]: { enabled: true, kinds: ['read'], ...cfg } });
  const core = createCore({ store, alarms: fakeAlarms(), version: 'platform-check' });
  await core.enqueue(r);
  const queued = store.data['q:' + adapter.id] ?? [];
  gate(platform, '(d) core keeps it queued', store.data['dstate:' + adapter.id]?.auth === true && queued.includes(r.capture_id),
    `auth=${store.data['dstate:' + adapter.id]?.auth} queued=${queued.length}`);
}

async function api(base, auth, method, path, body) {
  const res = await fetch(base + path, { method, headers: { Authorization: auth, 'Content-Type': 'application/json' },
    body: body && JSON.stringify(body) });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} → HTTP ${res.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : {};
}

async function checkSupermemory(key) {
  const P = 'supermemory', cfg = { apiKey: key, namespace: SCOPE };
  const sm = (m, p, b) => api('https://api.supermemory.ai', `Bearer ${key}`, m, p, b);
  const list = () => sm('POST', `/ns/${SCOPE}/list/documents?limit=100`, {});
  // Deletes every document in the check namespace (at most 11). Finished documents go at once; one still processing
  // is refused ("Document is still processing" in errors), hence the throw.
  const clear = async () => {
    const ids = (await list()).documents.map(d => d.id);
    if (!ids.length) return 0;
    const res = await sm('DELETE', `/ns/${SCOPE}/document`, { ids });
    if (res.errors?.length) throw new Error(`delete errors: ${JSON.stringify(res.errors).slice(0, 200)}`);
    return res.count;
  };
  const text = async r => (await sm('GET', `/ns/${SCOPE}/document/${r.page_key}`)).content ?? '';
  try {
    await clear();
    const map = memState();
    const recs = await sendAll(P, supermemory, cfg, map);
    const big = await bigRecord();
    const out = await supermemory.send(big, cfg, map);
    gate(P, '(a) the long page accepted', out.outcome === 'done', `${out.outcome} (${out.detail})`);
    // Processing is asynchronous and PATCH returns while still queued; between two queued updates every document
    // can show done. So wait until all are done or failed AND page 0 holds revision 3 (max 5 min).
    let docs, c0 = '';
    for (let t = 0; t < 60; t++) {
      docs = await list();
      c0 = await text(recs[0]).catch(() => '');
      if (docs.documents.length >= 11 && docs.documents.every(d => ['done', 'failed'].includes(d.system?.status))
        && c0.includes('revision 3')) break;
      await sleep(5000);
    }
    gate(P, '(c) exactly 11 documents', docs.pagination.totalItems === 11, `total=${docs.pagination.totalItems}`);
    gate(P, '(c) re-sent page holds only latest text', c0.includes('revision 3') && !/revision [12]\b|original text/.test(c0),
      JSON.stringify(c0.slice(-80)));
    let found = 0;
    for (let i = 0; i < 10; i++) {
      const phrase = `${WORDS[i]} ${i}`;
      const res = await sm('POST', `/ns/${SCOPE}/search`, { query: phrase, searchMode: 'chunks', limit: 10, threshold: 0 });
      if (res.results.some(x => (x.chunk ?? x.memory ?? '').includes(phrase))) found++;
    }
    gate(P, '(c) each page found by its phrase', found === 10, `${found}/10`);
    const back = await text(big).catch(() => '');
    const status = docs.documents.find(d => d.id === big.page_key)?.system?.status;
    gate(P, '(c) the long page reads back whole', status === 'done' && back === `${big.title}\n${big.url}\n\n${big.text}`,
      `status=${status} sent=${big.text.length} read=${back.length}`);
    await wrongKey(P, supermemory, { ...cfg, apiKey: 'sm_wrong_key_for_check' });
  } finally {
    try { gate(P, 'check data deleted', true, `${await clear()} deleted`); } catch (e) {
      gate(P, 'check data deleted', false, String(e.message).replaceAll(key, '***'));
    }
  }
}

async function checkMem0(key) {
  const P = 'mem0', cfg = { apiKey: key, userId: SCOPE }, map = {};
  const m0 = (m, p, b) => api('https://api.mem0.ai', `Token ${key}`, m, p, b);
  // Deletes only the check's own pages: this is the owner's real account, so even if the user_id filter were
  // ignored, nothing without the check URL in its text may go.
  const clear = async () => {
    const items = (await m0('POST', '/v3/memories/?page_size=100', { filters: { user_id: SCOPE } })).results ?? [];
    let n = 0;
    for (const x of items) {
      if (!String(x.memory ?? '').includes('afferent-check.example')) continue;
      await m0('DELETE', `/v1/memories/${encodeURIComponent(x.id)}/`);
      n++;
    }
    return n;
  };
  const text = async r => { const id = map[SCOPE + ':' + r.page_key]; return id ? (await m0('GET', `/v1/memories/${id}/`)).memory ?? '' : ''; };
  try {
    await clear();
    const recs = await sendAll(P, mem0, cfg, memState(map));
    const over = await mem0.send(await bigRecord(), cfg, memState(map));
    gate(P, '(a) the page over Mem0\'s limit is given up', over.outcome === 'failed', `${over.outcome} (${over.detail})`);
    const big = await bigRecord(11, 99000);
    const out = await mem0.send(big, cfg, memState(map));
    gate(P, '(a) the page just under the limit accepted', out.outcome === 'done', `${out.outcome} (${out.detail})`);
    const list = await m0('POST', '/v3/memories/?page_size=100', { filters: { user_id: SCOPE } });
    gate(P, '(c) exactly 11 memories', list.count === 11, `count=${list.count}`);
    const id = map[SCOPE + ':' + recs[0].page_key];
    const c = await text(recs[0]);
    gate(P, '(c) re-sent page holds only latest text', c.includes('revision 3') && !/revision [12]\b|original text/.test(c),
      id ? JSON.stringify(c.slice(-80)) : 'no memory id stored');
    // About 10 retrievals; the free tier allows 1k a month.
    let found = 0;
    for (let i = 0; i < 10; i++) {
      const phrase = `${WORDS[i]} ${i}`;
      const res = await m0('POST', '/v3/memories/search/', { query: phrase, filters: { user_id: SCOPE }, top_k: 10, threshold: 0 });
      if ((res.results ?? []).some(x => (x.memory ?? '').includes(phrase))) found++;
    }
    gate(P, '(c) each page found by its phrase', found === 10, `${found}/10`);
    const back = await text(big).catch(() => '');
    gate(P, '(c) the page under the limit reads back whole', back === `${big.title}\n${big.url}\n\n${big.text}`,
      `sent=${big.text.length} read=${back.length}`);
    await wrongKey(P, mem0, { ...cfg, apiKey: 'm0-wrong-key-for-check' });
  } finally {
    try { gate(P, 'check data deleted', true, `${await clear()} deleted`); } catch (e) {
      gate(P, 'check data deleted', false, String(e.message).replaceAll(key, '***'));
    }
  }
}

async function checkHindsight(key) {
  const P = 'hindsight', url = process.env.HINDSIGHT_URL || 'https://api.hindsight.vectorize.io';
  const cfg = { apiKey: key, url, bank: `${SCOPE}-${run}` };
  const hs = (m, p, b) => api(url.replace(/\/+$/, ''), `Bearer ${key}`, m, `/v1/default/banks/${cfg.bank}${p}`, b);
  try {
    const t = await hindsight.test(cfg);
    const c = (await hs('GET', '/config')).config ?? {};
    const storeOnly = t.result === 'ok' && c.retain_extraction_mode === 'chunks' && c.enable_observations === false;
    gate(P, '(0) connect test ok, bank is store-only', storeOnly,
      `test=${t.result} mode=${c.retain_extraction_mode} observations=${c.enable_observations}`);
    // Writing into a bank that extracts would run the owner's LLM on every page.
    if (!storeOnly) throw new Error('bank is not store-only, nothing sent');
    const recs = await sendAll(P, hindsight, cfg, memState());
    const big = await bigRecord();
    const out = await hindsight.send(big, cfg, memState());
    const text = async r => (await hs('GET', `/documents/${r.page_key}`)).original_text ?? '';
    // Sends are queued jobs on the server, the re-sends of page 0 too: wait until all 11 documents are written
    // and page 0 shows revision 3.
    const waitMin = Number(process.env.CHECK_WAIT_MIN || 3);
    let list, c0 = '';
    for (let t = Date.now(); ; await sleep(5000)) {
      list = await hs('GET', '/documents?limit=100');
      c0 = await text(recs[0]).catch(() => '');
      if (list.total >= 11 && c0.includes('revision 3')) break;
      if (Date.now() - t > waitMin * 60000) {
        console.log(`hindsight: waited ${waitMin} min; ${list.total} of 11 documents had arrived (page 0 at revision 3: `
          + `${c0.includes('revision 3')}). Jobs still queued are dropped with the bank. Set CHECK_WAIT_MIN to wait longer.`);
        break;
      }
    }
    gate(P, '(c) exactly 11 documents', list.total === 11, `total=${list.total}`);
    gate(P, '(c) re-sent page holds only latest text', c0.includes('revision 3') && !/revision [12]\b|original text/.test(c0),
      JSON.stringify(c0.slice(-80)));
    let found = 0;
    for (let i = 0; i < 10; i++) if ((await text(recs[i]).catch(() => '')).includes(`${WORDS[i]} ${i}`)) found++;
    gate(P, '(c) each page holds its own phrase', found === 10, `${found}/10`);
    const back = await text(big).catch(() => '');
    gate(P, '(c) the long page reads back whole', back === `${big.title}\n${big.url}\n\n${big.text}`,
      `send=${out.outcome} (${out.detail}) sent=${big.text.length} read=${back.length}`);
    await wrongKey(P, hindsight, { ...cfg, apiKey: 'hsk_wrong_key_for_check' });
  } finally {
    try { await hs('DELETE', ''); gate(P, 'check bank deleted', true, cfg.bank); } catch (e) {
      gate(P, 'check bank deleted', false, `${cfg.bank}: ${String(e.message).replaceAll(key, '***')}`);
    }
  }
}

for (const [name, env, fn] of [['supermemory', 'SUPERMEMORY_API_KEY', checkSupermemory], ['mem0', 'MEM0_API_KEY', checkMem0],
  ['hindsight', 'HINDSIGHT_API_KEY', checkHindsight]]) {
  const key = process.env[env];
  if (!key) { console.log(`${name}: skipped (${env} not set)`); continue; }
  try { await fn(key); } catch (e) { gate(name, 'ran to the end', false, String(e.message).replaceAll(key, '***')); }
}
console.table(rows);
process.exitCode = rows.every(r => r.result === 'PASS') && rows.length ? 0 : 1;
