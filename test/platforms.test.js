import test from 'node:test';
import assert from 'node:assert/strict';
import { createCore } from '../src/lib/core.js';
import supermemory from '../src/adapters/supermemory.js';
import mem0 from '../src/adapters/mem0.js';
import { fakeStore, fakeAlarms, fakeClock, fakeFetch } from './fakes.js';

const KEY = 'a'.repeat(64);
const rec = (n, { kind = 'read', url = `https://e.com/${n}`, text = kind === 'read' ? `text ${n}` : '' } = {}) => ({
  schema: 'afferent.page/1', capture_id: `00000000-0000-4000-8000-00000000000${n}`, page_key: KEY.slice(1) + n, kind, url,
  title: `t${n}`, site: new URL(url).hostname, text, dwell_seconds: 12, first_seen: '2026-11-05T10:00:00.000Z',
  last_seen: '2026-11-05T10:00:12.000Z', client: { name: 'afferent', version: '0.2.0' },
});
const meta = r => ({ url: r.url, title: r.title, site: r.site, kind: r.kind, dwell_seconds: r.dwell_seconds,
  first_seen: r.first_seen, last_seen: r.last_seen, capture_id: r.capture_id, page_key: r.page_key, source: 'afferent' });
const memState = (m = {}) => ({ m, get: async k => m[k], set: async (k, v) => { m[k] = v; } });
// Mem0 memory ids in adapter state, without the content hashes.
const ids = m => Object.entries(m).filter(([k]) => !k.endsWith('#sha')).map(([, v]) => v);
const edit = (r, n) => ({ ...r, text: 'edit ' + n });

function coreWith(dests, script = []) {
  const store = fakeStore({ settings: { consent: { agreed: true, at: 'x' } },
    ...Object.fromEntries(Object.entries(dests).map(([id, cfg]) => ['dest:' + id, cfg])) });
  globalThis.fetch = fakeFetch(script);
  const core = createCore({ store, alarms: fakeAlarms(), now: fakeClock(), version: '0.2.0' });
  return { store, core, fetch: globalThis.fetch };
}
const HOOK = { enabled: true, url: 'http://127.0.0.1:8799/hook', token: 't', kinds: ['read', 'glance'] };
const sentUrls = (store, id) => store.data.recent.filter(e => e.status[id]).map(e => e.url).reverse();

// --- per-destination site allowlist ---

test('allowlist: github.com covers itself, subdomains and paths, nothing else', async () => {
  const { store, core } = coreWith({ webhook: { ...HOOK, sites: ['github.com'] } });
  const urls = ['https://github.com/', 'https://gist.github.com/x', 'https://github.com/a/b', 'https://notgithub.com/',
    'https://github.com.evil.io/', 'https://e.com/'];
  for (const [i, url] of urls.entries()) await core.enqueue(rec(i, { url }));
  assert.deepEqual(sentUrls(store, 'webhook'), urls.slice(0, 3));
});

test('allowlist: empty or missing list sends everything', async () => {
  for (const sites of [[], undefined]) {
    const { store, core } = coreWith({ webhook: { ...HOOK, sites } });
    await core.enqueue(rec(1, { url: 'https://github.com/' }));
    await core.enqueue(rec(2, { url: 'https://e.com/' }));
    assert.deepEqual(sentUrls(store, 'webhook'), ['https://github.com/', 'https://e.com/']);
  }
});

test('allowlist: two destinations with different lists each get their own records', async () => {
  const { store, core } = coreWith({
    webhook: { ...HOOK, sites: ['github.com'] },
    supermemory: { enabled: true, apiKey: 'k', namespace: 'afferent', kinds: ['read'], sites: ['e.com/docs'] },
  });
  await core.enqueue(rec(1, { url: 'https://github.com/x' }));
  await core.enqueue(rec(2, { url: 'https://e.com/docs/1' }));
  await core.enqueue(rec(3, { url: 'https://e.com/blog' }));
  assert.deepEqual(sentUrls(store, 'webhook'), ['https://github.com/x']);
  assert.deepEqual(sentUrls(store, 'supermemory'), ['https://e.com/docs/1']);
  assert.equal(store.data['r:' + rec(3).capture_id], undefined, 'a record no destination takes is not kept');
});

// --- Supermemory ---

const SM = { apiKey: 'sm-key', namespace: 'my_ns:1' };

test('supermemory: revisit replaces via PATCH; body has only documented fields', async () => {
  globalThis.fetch = fakeFetch([{ status: 200, body: { id: 'x', status: 'queued' } }]);
  const r = rec(1);
  assert.equal((await supermemory.send(r, SM, memState())).outcome, 'done');
  const [c] = fetch.calls;
  assert.equal(fetch.calls.length, 1);
  assert.equal(c.url, `https://api.supermemory.ai/ns/my_ns:1/document/${r.page_key}`);
  assert.equal(c.init.method, 'PATCH');
  assert.equal(c.init.headers.Authorization, 'Bearer sm-key');
  assert.equal(c.init.headers['Content-Type'], 'application/json');
  assert.deepEqual(c.body, { content: 't1\nhttps://e.com/1\n\ntext 1', metadata: meta(r), taskType: 'superrag' });
});

test('supermemory: PATCH 404 creates the document with POST and id = page_key', async () => {
  globalThis.fetch = fakeFetch([404, 200]);
  const r = rec(2, { kind: 'glance' });
  assert.equal((await supermemory.send(r, SM, memState())).outcome, 'done');
  const [, c] = fetch.calls;
  assert.equal(c.url, 'https://api.supermemory.ai/ns/my_ns:1/document');
  assert.equal(c.init.method, 'POST');
  assert.deepEqual(c.body, { id: r.page_key, content: 't2\nhttps://e.com/2', metadata: meta(r), taskType: 'superrag' });
});

test('supermemory: default namespace is afferent', async () => {
  globalThis.fetch = fakeFetch([200]);
  await supermemory.send(rec(1), { apiKey: 'k', namespace: '' }, memState());
  assert.match(fetch.calls[0].url, /\/ns\/afferent\/document\//);
});

for (const [s, outcome, detail] of [[200, 'done'], [201, 'done'], [400, 'retry', 'HTTP 400'], [409, 'retry', 'HTTP 409'],
  [401, 'auth'], [403, 'auth'], [402, 'retry', 'HTTP 402'], [413, 'failed', 'HTTP 413'], [429, 'retry'], [500, 'retry', 'HTTP 500'],
  [503, 'retry'], ['network', 'retry'], ['timeout', 'retry']]) {
  test(`supermemory: ${s} on PATCH → ${outcome}`, async () => {
    globalThis.fetch = fakeFetch([s]);
    const res = await supermemory.send(rec(1), SM, memState());
    assert.equal(res.outcome, outcome);
    if (detail) assert.equal(res.detail, detail);
    assert.equal(fetch.calls.length, 1);
  });
  test(`supermemory: ${s} on the POST after a 404 → ${outcome}`, async () => {
    globalThis.fetch = fakeFetch([404, s]);
    assert.equal((await supermemory.send(rec(1), SM, memState())).outcome, outcome);
    assert.equal(fetch.calls.length, 2);
  });
}

// Only 413 gives a page up; any other refusal may be about the account, so the page stays queued and visible.
const SMDEST = { enabled: true, kinds: ['read'], sites: [], ...SM };
for (const s of [400, 409, 402, 500]) {
  test(`supermemory: ${s} keeps the page queued, status and server text in detail`, async () => {
    const { store, core } = coreWith({ supermemory: SMDEST }, [{ status: s, body: { error: 'Something went wrong here' } }]);
    await core.enqueue(rec(1));
    assert.deepEqual(store.data['q:supermemory'], [rec(1).capture_id]);
    assert.equal(store.data['dstate:supermemory'].detail, `HTTP ${s} Something went wrong here`);
    assert.notEqual(store.data['dstate:supermemory'].auth, true);
  });
}

test('supermemory: 413 gives up only that page; the next queued page is still sent', async () => {
  const { store, core } = coreWith({ supermemory: SMDEST }, [500]);
  await core.enqueue(rec(1));
  await core.enqueue(rec(2));
  assert.deepEqual(store.data['q:supermemory'], [rec(1).capture_id, rec(2).capture_id]);
  globalThis.fetch = fakeFetch([{ status: 413, body: { error: 'too large' } }, 200]);
  await core.retry();
  assert.deepEqual(store.data['q:supermemory'], []);
  const status = Object.fromEntries(store.data.recent.map(e => [e.url, e.status.supermemory]));
  assert.deepEqual(status, { 'https://e.com/1': 'failed', 'https://e.com/2': 'sent' });
});

test('supermemory: 401 keeps the page queued and marks the key rejected', async () => {
  const { store, core } = coreWith({ supermemory: SMDEST }, [401]);
  await core.enqueue(rec(1));
  assert.deepEqual(store.data['q:supermemory'], [rec(1).capture_id]);
  assert.equal(store.data['dstate:supermemory'].auth, true);
});

test('supermemory: test button lists one document, read-only', async () => {
  globalThis.fetch = fakeFetch([200, 401, 'network']);
  assert.equal((await supermemory.test(SM)).result, 'ok');
  assert.equal((await supermemory.test(SM)).result, 'auth');
  assert.equal((await supermemory.test(SM)).result, 'unreachable');
  const c = fetch.calls[0];
  assert.equal(c.url, 'https://api.supermemory.ai/ns/my_ns:1/list/documents?limit=1');
  assert.equal(c.init.method, 'POST');
  assert.equal(c.init.body, undefined);
});

test('supermemory: host permission and namespace rule', () => {
  assert.deepEqual(supermemory.origins(SM), ['https://api.supermemory.ai/*']);
  const ns = supermemory.configFields.find(f => f.name === 'namespace');
  const re = new RegExp(`^(?:${ns.pattern})$`);
  assert.ok(re.test('afferent') && re.test('a_b:c-1'));
  assert.ok(!re.test('a.b') && !re.test('a b') && !re.test('x'.repeat(101)));
});

// --- Mem0 ---

const M0 = { apiKey: 'm0-key', userId: 'me' };
const added = id => ({ status: 200, body: { event_id: 'e', status: 'SUCCEEDED', results: id ? [{ id, event: 'ADD' }] : [] } });

test('mem0: first visit adds verbatim and remembers the memory id', async () => {
  globalThis.fetch = fakeFetch([added('m-1')]);
  const st = memState(), r = rec(1);
  assert.equal((await mem0.send(r, M0, st)).outcome, 'done');
  const [c] = fetch.calls;
  assert.equal(c.url, 'https://api.mem0.ai/v3/memories/add/');
  assert.equal(c.init.method, 'POST');
  assert.equal(c.init.headers.Authorization, 'Token m0-key');
  assert.deepEqual(c.body, { messages: [{ role: 'user', content: 't1\nhttps://e.com/1\n\ntext 1' }], user_id: 'me',
    infer: false, metadata: meta(r) });
  assert.deepEqual(ids(st.m), ['m-1']);
});

test('mem0: revisit with a known id updates it with PUT', async () => {
  const st = memState();
  globalThis.fetch = fakeFetch([added('m-1'), { status: 200, body: { id: 'm-1' } }]);
  await mem0.send(rec(1), M0, st);
  const r = { ...rec(1), text: 'new text' };
  assert.equal((await mem0.send(r, M0, st)).outcome, 'done');
  const c = fetch.calls[1];
  assert.equal(c.url, 'https://api.mem0.ai/v1/memories/m-1/');
  assert.equal(c.init.method, 'PUT');
  assert.deepEqual(c.body, { text: 't1\nhttps://e.com/1\n\nnew text', metadata: meta(r) });
  assert.equal(fetch.calls.length, 2);
});

test('mem0: PUT 404 adds again and stores the new id', async () => {
  const st = memState();
  globalThis.fetch = fakeFetch([added('m-1'), 404, added('m-2'), 200]);
  await mem0.send(rec(1), M0, st);
  assert.equal((await mem0.send(edit(rec(1), 2), M0, st)).outcome, 'done');
  assert.equal(fetch.calls[2].url, 'https://api.mem0.ai/v3/memories/add/');
  assert.deepEqual(ids(st.m), ['m-2']);
  await mem0.send(edit(rec(1), 3), M0, st);
  assert.equal(fetch.calls[3].url, 'https://api.mem0.ai/v1/memories/m-2/');
});

test('mem0: an answer without an id is done and keeps an existing mapping', async () => {
  const st = memState();
  globalThis.fetch = fakeFetch([added(null), added('m-1'), 404, added(null)]);
  assert.equal((await mem0.send(rec(1), M0, st)).outcome, 'done');
  assert.deepEqual(ids(st.m), []);
  await mem0.send(edit(rec(1), 2), M0, st);
  assert.equal((await mem0.send(edit(rec(1), 3), M0, st)).outcome, 'done');
  assert.deepEqual(ids(st.m), ['m-1']);
});

test('mem0: the id map is per user id, so changing it never updates another scope', async () => {
  const st = memState();
  globalThis.fetch = fakeFetch([added('m-1'), added('m-2')]);
  await mem0.send(rec(1), M0, st);
  await mem0.send(rec(1), { ...M0, userId: 'other' }, st);
  assert.equal(fetch.calls[1].url, 'https://api.mem0.ai/v3/memories/add/');
  assert.equal(fetch.calls[1].body.user_id, 'other');
});

test('mem0: default user id is afferent', async () => {
  globalThis.fetch = fakeFetch([added('m')]);
  await mem0.send(rec(1), { apiKey: 'k', userId: '' }, memState());
  assert.equal(fetch.calls[0].body.user_id, 'afferent');
});

for (const [s, outcome] of [[200, 'done'], [400, 'retry'], [401, 'auth'], [403, 'auth'], [404, 'retry'], [413, 'failed'],
  [429, 'retry'], [500, 'retry'], ['network', 'retry'], ['timeout', 'retry']]) {
  test(`mem0: ${s} on add → ${outcome}`, async () => {
    globalThis.fetch = fakeFetch([s === 200 ? added('m') : s]);
    assert.equal((await mem0.send(rec(1), M0, memState())).outcome, outcome);
  });
  if (s !== 404) test(`mem0: ${s} on PUT → ${outcome}`, async () => {
    globalThis.fetch = fakeFetch([s]);
    const st = memState();
    await st.set('me:' + rec(1).page_key, 'm-1');
    assert.equal((await mem0.send(rec(1), M0, st)).outcome, outcome);
    assert.equal(fetch.calls.length, 1);
  });
}

test('mem0: a 200 whose status is FAILED keeps the page for retry, shown as HTTP', async () => {
  globalThis.fetch = fakeFetch([{ status: 200, body: { status: 'FAILED' } }]);
  const res = await mem0.send(rec(1), M0, memState());
  assert.equal(res.outcome, 'retry');
  assert.equal(res.detail, 'HTTP 200 Mem0 status FAILED');
});

const M0DEST = { enabled: true, kinds: ['read'], sites: [], ...M0 };
for (const s of [400, 500]) {
  test(`mem0: ${s} keeps the page queued, status and server message in detail`, async () => {
    const { store, core } = coreWith({ mem0: M0DEST }, [{ status: s, body: { error: 'Something went wrong here' } }]);
    await core.enqueue(rec(1));
    assert.deepEqual(store.data['q:mem0'], [rec(1).capture_id]);
    assert.equal(store.data['dstate:mem0'].detail, `HTTP ${s} Something went wrong here`);
  });
}

test('mem0: a 200 with status FAILED keeps the page queued', async () => {
  const { store, core } = coreWith({ mem0: M0DEST }, [{ status: 200, body: { status: 'FAILED' } }]);
  await core.enqueue(rec(1));
  assert.deepEqual(store.data['q:mem0'], [rec(1).capture_id]);
});

test('mem0: 413 gives up only that page; the next queued page is still sent', async () => {
  const { store, core } = coreWith({ mem0: M0DEST }, [500]);
  await core.enqueue(rec(1));
  await core.enqueue(rec(2));
  globalThis.fetch = fakeFetch([413, added('m2')]);
  await core.retry();
  assert.deepEqual(store.data['q:mem0'], []);
  const status = Object.fromEntries(store.data.recent.map(e => [e.url, e.status.mem0]));
  assert.deepEqual(status, { 'https://e.com/1': 'failed', 'https://e.com/2': 'sent' });
});

// The real answer to an add over Mem0's limit (hosted, 2026-11-13).
const M0_TOO_LONG = { status: 400, body: { error: "{'messages': [ErrorDetail(string='Messages contain 100,060 tokens, which exceeds the limit of 100,000.', code='invalid')]}" } };

test('mem0: a 400 saying the page is over the token limit gives up only that page; the next is still sent', async () => {
  const { store, core } = coreWith({ mem0: M0DEST }, [500]);
  await core.enqueue(rec(1));
  await core.enqueue(rec(2));
  globalThis.fetch = fakeFetch([M0_TOO_LONG, added('m2')]);
  await core.retry();
  assert.deepEqual(store.data['q:mem0'], []);
  const status = Object.fromEntries(store.data.recent.map(e => [e.url, e.status.mem0]));
  assert.deepEqual(status, { 'https://e.com/1': 'failed', 'https://e.com/2': 'sent' });
});

test('mem0: 401 keeps the page queued and marks the key rejected', async () => {
  const { store, core } = coreWith({ mem0: M0DEST }, [401]);
  await core.enqueue(rec(1));
  assert.deepEqual(store.data['q:mem0'], [rec(1).capture_id]);
  assert.equal(store.data['dstate:mem0'].auth, true);
});

test('mem0: test button pings', async () => {
  globalThis.fetch = fakeFetch([{ status: 200, body: { status: 'ok' } }, 401, 'timeout']);
  assert.equal((await mem0.test(M0)).result, 'ok');
  assert.equal((await mem0.test(M0)).result, 'auth');
  assert.equal((await mem0.test(M0)).result, 'unreachable');
  assert.equal(fetch.calls[0].url, 'https://api.mem0.ai/v1/ping/');
  assert.equal(fetch.calls[0].init.method, 'GET');
  assert.equal(fetch.calls[0].init.headers.Authorization, 'Token m0-key');
});

test('mem0: host permission and default kinds', () => {
  assert.deepEqual(mem0.origins(M0), ['https://api.mem0.ai/*']);
  assert.deepEqual(mem0.defaultKinds, ['read', 'glance']);
  assert.deepEqual(supermemory.defaultKinds, ['read', 'glance']);
});

// --- adapter state through core ---

test('adapter state lives in storage across a SW restart', async () => {
  const { store, core } = coreWith({ mem0: { enabled: true, ...M0, kinds: ['read'] } }, [added('m-1')]);
  await core.enqueue(rec(1));
  assert.deepEqual(ids(store.data['astate:mem0']), ['m-1']);
  globalThis.fetch = fakeFetch([200]);
  const core2 = createCore({ store, alarms: fakeAlarms(), now: fakeClock(), version: '0.2.0' });
  await core2.enqueue({ ...edit(rec(1), 2), capture_id: '00000000-0000-4000-8000-0000000000aa' });
  assert.equal(globalThis.fetch.calls[0].init.method, 'PUT');
});

// --- unchanged content is not re-sent to the paid platforms ---

for (const [a, cfg, ok] of [[supermemory, SM, () => 200], [mem0, M0, () => added('m-1')]]) {
  test(`${a.id}: same content twice → the second send makes no request`, async () => {
    const st = memState();
    globalThis.fetch = fakeFetch([ok(), ok()]);
    assert.equal((await a.send(rec(1), cfg, st)).outcome, 'done');
    // Only metadata (dwell, last_seen) differs: still unchanged.
    assert.deepEqual(await a.send({ ...rec(1), dwell_seconds: 99, last_seen: '2026-11-06T00:00:00.000Z' }, cfg, st),
      { outcome: 'done', detail: 'unchanged' });
    assert.equal(fetch.calls.length, 1);
  });

  test(`${a.id}: changed content is written again`, async () => {
    const st = memState();
    globalThis.fetch = fakeFetch([ok(), ok()]);
    await a.send(rec(1), cfg, st);
    assert.equal((await a.send({ ...rec(1), text: 'changed' }, cfg, st)).outcome, 'done');
    assert.equal(fetch.calls.length, 2);
    assert.match(fetch.calls[1].init.method, /^(PATCH|PUT)$/);
  });

  test(`${a.id}: the hash is stored only after a successful write`, async () => {
    const st = memState();
    globalThis.fetch = fakeFetch([500, ok()]);
    assert.equal((await a.send(rec(1), cfg, st)).outcome, 'retry');
    assert.equal((await a.send(rec(1), cfg, st)).outcome, 'done');
    assert.equal(fetch.calls.length, 2);
  });

  test(`${a.id}: the hash is per scope (namespace / user id)`, async () => {
    const st = memState();
    globalThis.fetch = fakeFetch([ok(), ok()]);
    await a.send(rec(1), cfg, st);
    await a.send(rec(1), { ...cfg, namespace: 'other', userId: 'other' }, st);
    assert.equal(fetch.calls.length, 2);
  });
}

for (const [a, cfg, ok] of [[supermemory, SM, () => 200], [mem0, M0, () => added('m-1')]]) {
  test(`${a.id}: a glance after a read keeps the stored full text (no request)`, async () => {
    const st = memState();
    globalThis.fetch = fakeFetch([ok(), ok()]);
    await a.send(rec(1), cfg, st);
    assert.deepEqual(await a.send(rec(1, { kind: 'glance' }), cfg, st), { outcome: 'done', detail: 'unchanged' });
    assert.equal(fetch.calls.length, 1);
  });

  test(`${a.id}: a glance first, then a read → the read is sent`, async () => {
    const st = memState();
    globalThis.fetch = fakeFetch([ok(), ok()]);
    assert.equal((await a.send(rec(1, { kind: 'glance' }), cfg, st)).outcome, 'done');
    assert.equal((await a.send(rec(1), cfg, st)).outcome, 'done');
    assert.equal(fetch.calls.length, 2);
  });
}
