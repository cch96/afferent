import test from 'node:test';
import assert from 'node:assert/strict';
import { createCore } from '../src/lib/core.js';
import { fakeStore, fakeAlarms, fakeClock, fakeFetch } from './fakes.js';

const DEST = { enabled: true, url: 'http://192.0.2.10:8770/hook', token: 's3cret', kinds: ['read', 'glance'] };

function setup(script, extra = {}) {
  const store = fakeStore({ 'dest:webhook': DEST, settings: { consent: { agreed: true, at: 'x' } }, ...extra });
  const alarms = fakeAlarms();
  const now = fakeClock();
  globalThis.fetch = fakeFetch(script);
  const core = createCore({ store, alarms, now, version: '0.1.0' });
  return { store, alarms, now, core, fetch: globalThis.fetch };
}

const rec = (n, kind = 'read') => ({ schema: 'afferent.page/1', capture_id: `00000000-0000-4000-8000-00000000000${n}`, kind, url: `https://e.com/${n}`, title: `t${n}`, site: 'e.com', text: kind === 'read' ? 'x' : '' });

test('record is in storage before the first send attempt', async () => {
  const { store, core, fetch } = setup([]);
  let seenAtSend;
  globalThis.fetch = async (...a) => { seenAtSend = structuredClone(store.data); return fetch(...a); };
  await core.enqueue(rec(1));
  assert.ok(seenAtSend['r:' + rec(1).capture_id]);
  assert.deepEqual(seenAtSend['q:webhook'], [rec(1).capture_id]);
});

test('request shape: POST, json, bearer token', async () => {
  const { core, fetch } = setup([200]);
  await core.enqueue(rec(1));
  const c = fetch.calls[0];
  assert.equal(c.url, DEST.url);
  assert.equal(c.init.method, 'POST');
  assert.equal(c.init.headers['Content-Type'], 'application/json');
  assert.equal(c.init.headers.Authorization, 'Bearer s3cret');
  assert.ok(c.init.signal instanceof AbortSignal);
  assert.equal(c.body.capture_id, rec(1).capture_id);
});

for (const body of [{ status: 'stored' }, { status: 'duplicate' }]) {
  test(`2xx ${body.status} removes from queue, marks it sent`, async () => {
    const { store, core } = setup([{ status: 200, body }]);
    await core.enqueue(rec(1));
    assert.deepEqual(store.data['q:webhook'], []);
    assert.equal(store.data['r:' + rec(1).capture_id], undefined);
    assert.equal(store.data.recent[0].status.webhook, 'sent');
  });
}

for (const status of [400, 411, 413, 415]) {
  test(`${status} marks the record failed, no retry`, async () => {
    const { store, core, alarms, fetch } = setup([status, 200]);
    await core.enqueue(rec(1));
    await core.enqueue(rec(2)); // queue keeps moving
    assert.deepEqual(store.data['q:webhook'], []);
    assert.equal(store.data.recent[1].status.webhook, 'failed');
    assert.equal(store.data.recent[0].status.webhook, 'sent');
    assert.equal(alarms.set.has('flush:webhook'), false);
    assert.equal(fetch.calls.length, 2);
  });
}

for (const status of [401, 403]) {
  test(`${status} is an auth error: record kept, sending stops until settings change`, async () => {
    const { store, core, fetch } = setup([status, 200, 200]);
    await core.enqueue(rec(1));
    await core.enqueue(rec(2));
    assert.equal(fetch.calls.length, 1);
    assert.deepEqual(store.data['q:webhook'], [rec(1).capture_id, rec(2).capture_id]);
    assert.equal(store.data['dstate:webhook'].auth, true);
    assert.ok(store.data['r:' + rec(1).capture_id]);
    await core.flush();
    assert.equal(fetch.calls.length, 1);
    await core.saveDest('webhook', { ...DEST, token: 'new' });
    assert.equal(fetch.calls.length, 3);
    assert.deepEqual(store.data['q:webhook'], []);
  });
}

for (const s of [408, 429, 500, 503, 'network', 'timeout']) {
  test(`${s} retries with exponential backoff capped at 30 min`, async () => {
    const { store, core, alarms, now, fetch } = setup([s, s, s, s, s, s, s, s, s, 200]);
    await core.enqueue(rec(1));
    const delays = [];
    for (let i = 0; i < 9; i++) {
      const when = alarms.set.get('flush:webhook').when;
      delays.push((when - now()) / 1000);
      await core.enqueue(rec(2)); // a new record during backoff must not bypass it
      assert.equal(fetch.calls.length, i + 1);
      now.t = when;
      await core.alarm('flush:webhook');
    }
    assert.deepEqual(delays, [30, 60, 120, 240, 480, 960, 1800, 1800, 1800]);
    assert.deepEqual(store.data['q:webhook'], []);
    assert.equal(store.data['dstate:webhook'].failures, 0);
  });
}

test('fetch timeout is under 25 s', async () => {
  const { core } = setup([]);
  let aborted = null;
  globalThis.fetch = (url, init) => new Promise((_, rej) => {
    const t0 = Date.now();
    init.signal.addEventListener('abort', () => { aborted = Date.now() - t0; const e = new Error('a'); e.name = 'AbortError'; rej(e); });
  });
  const { mock } = test;
  mock.timers.enable({ apis: ['setTimeout'] });
  const p = core.enqueue(rec(1));
  await new Promise(r => setImmediate(r));
  mock.timers.tick(24000);
  const abortedBy24s = aborted !== null;
  mock.timers.tick(600000); // let a too-long timeout finish so the test fails instead of hanging
  await p;
  mock.timers.reset();
  assert.ok(abortedBy24s, 'aborted before 25 s');
});

test('queue and backoff survive a SW restart; a lost response is resent once', async () => {
  const { store, alarms, now, core } = setup(['timeout']);
  await core.enqueue(rec(1)); // receiver stored it but the response was lost
  assert.equal(store.data.recent[0].status.webhook, 'queued');
  const when = alarms.set.get('flush:webhook').when;
  // SW dies; a fresh instance starts from storage only
  globalThis.fetch = fakeFetch([{ status: 200, body: { status: 'duplicate' } }]);
  const core2 = createCore({ store, alarms, now, version: '0.1.0' });
  await core2.startup();
  assert.equal(globalThis.fetch.calls.length, 0, 'startup flush respects backoff');
  now.t = when;
  await core2.alarm('flush:webhook');
  assert.deepEqual(store.data['q:webhook'], []);
  assert.equal(store.data.recent[0].status.webhook, 'sent');
});

test('kinds filter: read-only destination skips glances', async () => {
  const { store, core, fetch } = setup([], { 'dest:webhook': { ...DEST, kinds: ['read'] } });
  await core.enqueue(rec(1, 'glance'));
  assert.equal(fetch.calls.length, 0);
  assert.equal(store.data.recent[0].status.webhook, undefined);
  assert.equal(store.data['r:' + rec(1).capture_id], undefined);
});

test('delete cancels a pending send', async () => {
  const { store, core, alarms, now, fetch } = setup([503]);
  await core.enqueue(rec(1));
  const r = await core.deleteCapture(rec(1).capture_id);
  assert.deepEqual(r, { n: 1, sentTo: [], forget: 'queued' });
  assert.deepEqual(store.data['q:webhook'], []);
  assert.equal(store.data['r:' + rec(1).capture_id], undefined);
  assert.equal(store.data.recent.length, 0);
  await new Promise(r => setTimeout(r, 10)); // the delete's own background flush (held by the backoff) ends first
  now.t = alarms.set.get('flush:webhook').when;
  await core.alarm('flush:webhook');
  // The next send is the forget request, never the deleted record.
  assert.deepEqual(fetch.calls.map(c => c.body.schema), ['afferent.page/1', 'afferent.forget/1']);
});

test('delete answers where the capture was sent, from storage at delete time', async () => {
  const { core } = setup([200]);
  await core.enqueue(rec(1));
  // The webhook gets a forget request, so only the other platforms are named.
  assert.deepEqual(await core.deleteCapture(rec(1).capture_id), { n: 1, sentTo: [], forget: 'queued' });
  // Recorded while no platform took it: never queued anywhere.
  const off = setup([]);
  delete off.store.data['dest:webhook'];
  await off.core.enqueue(rec(2));
  assert.deepEqual(await off.core.deleteCapture(rec(2).capture_id), { n: 1, sentTo: [], forget: 'none' });
});

test('two patches built from the same stale page copy both land', async () => {
  const { store, core } = setup([]);
  await Promise.all([core.patchDest('webhook', { sites: ['a.com'] }), core.patchDest('webhook', { kinds: ['read'] })]);
  assert.deepEqual(store.data['dest:webhook'], { ...DEST, sites: ['a.com'], kinds: ['read'] });
});

test('the stored threshold is clamped to 3-60 s for capture too', async () => {
  for (const [stored, used] of [[1, 3], [600, 60], [15, 15]]) {
    const { core } = setup([], { settings: { consent: { agreed: true, at: 'x' }, thresholdSec: stored } });
    assert.equal((await core.start(1, 'https://e.com/a')).thresholdMs, used * 1000, String(stored));
  }
});

test('token never leaves storage.local in the recent list or logs', async () => {
  const { store, core } = setup([401]);
  const logs = [];
  const orig = { ...console };
  for (const k of ['log', 'warn', 'error', 'info', 'debug']) console[k] = (...a) => logs.push(a.join(' '));
  try { await core.enqueue(rec(1)); } finally { Object.assign(console, orig); }
  assert.ok(!JSON.stringify(store.data.recent).includes('s3cret'));
  assert.ok(!JSON.stringify(store.data['dstate:webhook']).includes('s3cret'));
  assert.ok(!logs.join('\n').includes('s3cret'));
});

test('health check maps responses', async () => {
  const { core } = setup([{ status: 200, body: { status: 'ok' } }, 401, 404, 'network']);
  assert.equal((await core.testDest('webhook', DEST)).result, 'ok');
  assert.equal((await core.testDest('webhook', DEST)).result, 'auth');
  assert.equal((await core.testDest('webhook', DEST)).result, 'no_health');
  assert.equal((await core.testDest('webhook', DEST)).result, 'unreachable');
  assert.equal(globalThis.fetch.calls[0].init.method, 'GET');
});

const BADGE = { count: n => ({ text: String(n), color: '#A0583A' }), none: { text: '', color: '#A0583A' },
  bad: { text: '!', color: '#AA4539' }, paused: { text: 'Ⅱ', color: '#7B6659' } };

function badgeSetup(script, extra = {}) {
  const store = fakeStore({ 'dest:webhook': DEST, ...extra });
  globalThis.fetch = fakeFetch(script);
  const badges = [];
  const alarms = fakeAlarms(), now = fakeClock();
  const core = createCore({ store, alarms, now, version: '1', setBadge: b => badges.push(b) });
  return { store, core, badges, alarms, now };
}

test('badge: empty with nothing today, then the count, then "!" on auth error', async () => {
  const { core, badges } = badgeSetup([200, 401]);
  await core.flush();
  assert.deepEqual(badges.at(-1), BADGE.none);
  await core.enqueue(rec(1));
  assert.deepEqual(badges.at(-1), BADGE.count(1));
  await core.enqueue(rec(2));
  assert.deepEqual(badges.at(-1), BADGE.bad);
});

test('badge: "!" while a destination is retrying', async () => {
  const { core, badges } = badgeSetup([503]);
  await core.enqueue(rec(1));
  assert.deepEqual(badges.at(-1), BADGE.bad);
});

test('badge: pausing and resuming update it at once; a failure outranks pause', async () => {
  const { core, badges } = badgeSetup([200]);
  await core.enqueue(rec(1));
  await core.setSettings({ paused: true });
  assert.deepEqual(badges.at(-1), BADGE.paused);
  await core.setSettings({ paused: false });
  assert.deepEqual(badges.at(-1), BADGE.count(1));
  const f = badgeSetup([], { 'dstate:webhook': { failures: 2, nextAt: Infinity } });
  await f.core.setSettings({ paused: true });
  assert.deepEqual(f.badges.at(-1), BADGE.bad);
});

test('retry(): a destination in backoff sends at once; one in the auth state is left alone', async () => {
  const { store, core, alarms, now, badges } = badgeSetup([503]);
  await core.enqueue(rec(1));
  // A second destination that needs a new key, with a record queued.
  Object.assign(store.data, { 'dest:mem0': { enabled: true, apiKey: 'k' }, 'dstate:mem0': { auth: true, detail: 'HTTP 401' },
    'q:mem0': [rec(1).capture_id] });
  assert.ok(store.data['dstate:webhook'].nextAt > now());
  globalThis.fetch = fakeFetch([200]);
  await core.retry();
  assert.equal(globalThis.fetch.calls.length, 1);
  assert.equal(globalThis.fetch.calls[0].url, DEST.url);
  assert.deepEqual(store.data['q:webhook'], []);
  assert.deepEqual(store.data['dstate:webhook'], { failures: 0 });
  assert.equal(store.data['dstate:mem0'].auth, true);
  assert.deepEqual(store.data['q:mem0'], [rec(1).capture_id]);
  assert.deepEqual(badges.at(-1), BADGE.bad); // mem0 still needs a new key
});

test('recent entries carry the reading time in seconds, for reads and glances', async () => {
  const { store, core } = setup([200, 200]);
  await core.enqueue({ ...rec(1), dwell_seconds: 42 });
  await core.enqueue({ ...rec(2, 'glance'), dwell_seconds: 3 });
  assert.equal(store.data.recent[1].dwell, 42);
  assert.equal(store.data.recent[0].dwell, 3);
});

test("deleting today's capture lowers today's count and the badge; an older one or a stale count does not", async () => {
  const { store, core, badges, now } = badgeSetup([200, 200]);
  await core.enqueue(rec(1));
  now.t += 864e5;
  await core.enqueue(rec(2));
  await core.enqueue(rec(3));
  assert.equal(store.data.today.n, 2);
  await core.deleteCapture(rec(3).capture_id);
  assert.equal(store.data.today.n, 1);
  assert.deepEqual(badges.at(-1), BADGE.count(1));
  await core.deleteCapture(rec(1).capture_id); // yesterday's
  assert.equal(store.data.today.n, 1);
  store.data.today.n = 0;
  await core.deleteCapture(rec(2).capture_id);
  assert.equal(store.data.today.n, 0);
});

// Supermemory's and Mem0's consent text says nothing about playback: a read from playback alone goes to the webhook only.
test('a read from playback alone goes to the webhook only; a read from dwell goes everywhere', async () => {
  const { store, core } = setup([], { 'dest:supermemory': { enabled: true, apiKey: 'k' }, 'dest:mem0': { enabled: true, apiKey: 'k' } });
  const media = [{ kind: 'video', playMs: 90000, bgMs: 90000, duration: 100, played: [[0, 90]] }];
  const visit = async dwellMs => {
    const { id } = await core.start(1, 'https://e.com/v');
    await core.report(1, { id, url: 'https://e.com/v', dwellMs, first: 1, last: 2, end: true, title: 'T', text: 'x', media });
    return Object.keys(store.data.recent[0].status).sort();
  };
  assert.deepEqual(await visit(2000), ['webhook']);
  assert.equal(store.data.recent[0].kind, 'read');
  assert.deepEqual(await visit(20000), ['mem0', 'supermemory', 'webhook']);
});
