// Hindsight destination: one document per page, stored as chunks, and a connect test that never changes an existing bank.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createCore } from '../src/lib/core.js';
import { classify } from '../src/adapters/http.js';
import hindsight from '../src/adapters/hindsight.js';
import { fakeStore, fakeAlarms, fakeClock, fakeFetch } from './fakes.js';

const KEY = 'a'.repeat(64);
const rec = (n, text = `text ${n}`) => ({
  schema: 'afferent.page/1', capture_id: `00000000-0000-4000-8000-00000000000${n}`, page_key: KEY.slice(1) + n, kind: 'read',
  url: `https://e.com/${n}`, title: `t${n}`, site: 'e.com', text, dwell_seconds: 12, first_seen: '2026-11-05T10:00:00.000Z',
  last_seen: '2026-11-05T10:00:12.000Z', client: { name: 'afferent', version: '0.2.0' },
});
const HS = { apiKey: 'hsk_secret1', url: 'https://hs.example.com:8888/', bank: 'my bank' };
const BANK = 'https://hs.example.com:8888/v1/default/banks/my%20bank';
const OK = { status: 200, body: { success: true, items_count: 1, is_async: true, operation_id: 'op' } };

function coreWith(script) {
  const store = fakeStore({ settings: { consent: { agreed: true, at: 'x' } },
    'dest:hindsight': { enabled: true, kinds: ['read'], sites: [], ...HS } });
  globalThis.fetch = fakeFetch(script);
  return { store, core: createCore({ store, alarms: fakeAlarms(), now: fakeClock(), version: '0.2.0' }) };
}

test('classify: the default status table', () => {
  assert.deepEqual([200, 201, 204, 401, 403, 413, 400, 402, 404, 429, 500, 503].map(classify),
    ['done', 'done', 'done', 'auth', 'auth', 'failed', 'retry', 'retry', 'retry', 'retry', 'retry', 'retry']);
});

test('hindsight: a read page becomes one async replace with string-only metadata, and is marked sent', async () => {
  const { store, core } = coreWith([OK]);
  const r = rec(1);
  await core.enqueue(r);
  const [c] = fetch.calls;
  assert.equal(fetch.calls.length, 1);
  assert.equal(c.url, BANK + '/memories');
  assert.equal(c.init.method, 'POST');
  assert.equal(c.init.headers.Authorization, 'Bearer hsk_secret1');
  assert.deepEqual(c.body, { async: true, items: [{ content: 't1\nhttps://e.com/1\n\ntext 1', document_id: r.page_key,
    timestamp: r.last_seen, update_mode: 'replace', metadata: { url: r.url, title: 't1', site: 'e.com', kind: 'read',
      dwell_seconds: '12', first_seen: r.first_seen, last_seen: r.last_seen, capture_id: r.capture_id, page_key: r.page_key,
      source: 'afferent' } }] });
  assert.equal(store.data.recent[0].status.hindsight, 'sent');
  assert.deepEqual(store.data['q:hindsight'], []);
});

test('hindsight: changed text is sent again under the same document_id; unchanged text is not', async () => {
  const { core } = coreWith([OK, OK]);
  await core.enqueue(rec(1));
  await core.enqueue({ ...rec(1, 'changed'), capture_id: '00000000-0000-4000-8000-0000000000aa' });
  await core.enqueue({ ...rec(1, 'changed'), capture_id: '00000000-0000-4000-8000-0000000000bb' });
  assert.equal(fetch.calls.length, 2);
  assert.equal(fetch.calls[1].body.items[0].document_id, rec(1).page_key);
  assert.match(fetch.calls[1].body.items[0].content, /changed$/);
});

test('hindsight: the unchanged check is per server and bank', async () => {
  const st = { m: {}, get: async k => st.m[k], set: async (k, v) => { st.m[k] = v; } };
  globalThis.fetch = fakeFetch([OK, OK, OK]);
  await hindsight.send(rec(1), HS, st);
  await hindsight.send(rec(1), { ...HS, bank: 'other' }, st);
  await hindsight.send(rec(1), { ...HS, url: 'https://elsewhere.example.com' }, st);
  assert.equal(fetch.calls.length, 3);
});

test('hindsight: 401 keeps the page queued and marks the key rejected', async () => {
  const { store, core } = coreWith([{ status: 401, body: { detail: 'Invalid API key' } }]);
  await core.enqueue(rec(1));
  assert.deepEqual(store.data['q:hindsight'], [rec(1).capture_id]);
  assert.equal(store.data['dstate:hindsight'].auth, true);
});

for (const s of [402, 400, 500]) {
  test(`hindsight: ${s} keeps the page queued for retry, status in detail`, async () => {
    const { store, core } = coreWith([{ status: s, body: { detail: 'Something went wrong here' } }]);
    await core.enqueue(rec(1));
    assert.deepEqual(store.data['q:hindsight'], [rec(1).capture_id]);
    const st = store.data['dstate:hindsight'];
    assert.equal(st.failures, 1);
    assert.equal(st.detail, `HTTP ${s} Something went wrong here`);
  });
}

test('hindsight: a 200 without success: true is not sent', async () => {
  const { store, core } = coreWith([{ status: 200, body: { success: false } }]);
  await core.enqueue(rec(1));
  assert.deepEqual(store.data['q:hindsight'], [rec(1).capture_id]);
  assert.notEqual(store.data.recent[0].status.hindsight, 'sent');
});

test('hindsight: 413 gives up only that page; the next queued page is still sent', async () => {
  const { store, core } = coreWith([500]);
  await core.enqueue(rec(1));
  await core.enqueue(rec(2));
  assert.deepEqual(store.data['q:hindsight'], [rec(1).capture_id, rec(2).capture_id]);
  globalThis.fetch = fakeFetch([{ status: 413, body: { detail: 'too large' } }, OK]);
  await core.retry();
  assert.deepEqual(store.data['q:hindsight'], []);
  const status = Object.fromEntries(store.data.recent.map(e => [e.url, e.status.hindsight]));
  assert.deepEqual(status, { 'https://e.com/1': 'failed', 'https://e.com/2': 'sent' });
});

test('hindsight: a network failure or timeout retries', async () => {
  for (const s of ['network', 'timeout']) {
    globalThis.fetch = fakeFetch([s]);
    assert.equal((await hindsight.send(rec(1), HS, { get: async () => undefined, set: async () => {} })).outcome, 'retry');
  }
});

test('hindsight: key detection, fields, origins', () => {
  assert.deepEqual(hindsight.fromKey('hsk_abcdefgh12'), { apiKey: 'hsk_abcdefgh12' });
  assert.equal(hindsight.fromKey('sm_abcdefgh12'), null);
  assert.deepEqual(hindsight.fromKey(' plain ', true), { apiKey: 'plain' });
  assert.equal(hindsight.fromKey('two words', true), null);
  assert.deepEqual(hindsight.defaultKinds, ['read', 'glance']);
  assert.deepEqual(hindsight.configFields.filter(f => f.ask).map(f => [f.name, f.default]),
    [['url', 'https://api.hindsight.vectorize.io'], ['bank', 'afferent']]);
  assert.deepEqual(hindsight.origins(HS), ['https://hs.example.com:8888/*']);
});

// --- test(): connect leaves the bank in store-only mode or refuses ---

const conf = config => ({ status: 200, body: { bank_id: 'my bank', config, overrides: {} } });
const CHUNKS = { retain_extraction_mode: 'chunks', enable_observations: false, other: 1 };
const writes = () => fetch.calls.filter(c => c.init.method === 'PUT' || c.init.method === 'PATCH');

test('hindsight test: a missing bank is created store-only and confirmed', async () => {
  globalThis.fetch = fakeFetch([404, { status: 200, body: {} }, conf(CHUNKS)]);
  assert.deepEqual(await hindsight.test(HS), { result: 'ok' });
  assert.deepEqual(fetch.calls.map(c => [c.init.method, c.url]),
    [['GET', BANK + '/config'], ['PUT', BANK], ['GET', BANK + '/config']]);
  assert.deepEqual(fetch.calls[1].body, { retain_extraction_mode: 'chunks', enable_observations: false });
  assert.equal(fetch.calls[0].init.headers.Authorization, 'Bearer hsk_secret1');
});

test('hindsight test: an existing store-only bank is ok and untouched', async () => {
  globalThis.fetch = fakeFetch([conf(CHUNKS)]);
  assert.deepEqual(await hindsight.test(HS), { result: 'ok' });
  assert.deepEqual(writes(), []);
});

test('hindsight test: an existing bank that extracts is refused and untouched', async () => {
  for (const config of [{ retain_extraction_mode: 'concise', enable_observations: false },
    { retain_extraction_mode: 'chunks', enable_observations: true }]) {
    globalThis.fetch = fakeFetch([conf(config)]);
    assert.deepEqual(await hindsight.test(HS), { result: 'refused', message: 'hsRefuseExtracts' });
    assert.deepEqual(writes(), []);
  }
});

test('hindsight test: created but the mode did not stick is refused', async () => {
  globalThis.fetch = fakeFetch([404, { status: 200, body: {} }, conf({ retain_extraction_mode: 'concise', enable_observations: true })]);
  assert.deepEqual(await hindsight.test(HS), { result: 'refused', message: 'hsRefuseSetup' });
});

test('hindsight test: a refused bank setup is refused, not unreachable', async () => {
  for (const status of [403, 422]) {
    globalThis.fetch = fakeFetch([404, status, 404]);
    assert.deepEqual(await hindsight.test(HS), { result: 'refused', message: 'hsRefuseSetup' }, String(status));
  }
});

test('hindsight test: no bank endpoint at the address (wrong URL) is an error, not a refusal', async () => {
  for (const status of [404, 405]) {
    globalThis.fetch = fakeFetch([404, status, 404]);
    assert.deepEqual(await hindsight.test(HS), { result: 'error', detail: `HTTP ${status}` }, String(status));
  }
});

test('hindsight test: a 200 that is not a bank config (e.g. the web UI page) is an error, not a refusal', async () => {
  const html = () => new Response('<!doctype html><html><body>UI</body></html>', { status: 200 });
  const methods = [];
  globalThis.fetch = async (url, init = {}) => { methods.push(init.method); return html(); };
  assert.deepEqual(await hindsight.test(HS), { result: 'error', detail: 'HTTP 200' });
  assert.deepEqual(methods, ['GET']);
  globalThis.fetch = fakeFetch([{ status: 200, body: { bank_id: 'my bank' } }]);
  assert.deepEqual(await hindsight.test(HS), { result: 'error', detail: 'HTTP 200' });
  assert.deepEqual(writes(), []);
  // Same after a PUT: the confirming GET must be a bank config, or the address is wrong.
  globalThis.fetch = fakeFetch([404, { status: 200, body: {} }, { status: 200, body: {} }]);
  assert.deepEqual(await hindsight.test(HS), { result: 'error', detail: 'HTTP 200' });
});

test('hindsight test: a rejected key is auth, a network failure unreachable', async () => {
  globalThis.fetch = fakeFetch([401, 403, 'network']);
  assert.equal((await hindsight.test(HS)).result, 'auth');
  assert.equal((await hindsight.test(HS)).result, 'auth');
  assert.equal((await hindsight.test(HS)).result, 'unreachable');
  assert.deepEqual(writes(), []);
});
