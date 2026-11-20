// 边读边发: mid-visit publishes go to destinations that keep one copy per page; the webhook waits for the end.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createCore } from '../src/lib/core.js';
import { fakeStore, fakeAlarms, fakeClock } from './fakes.js';

const HOOK = { enabled: true, url: 'http://127.0.0.1:9/hook', token: 't', kinds: ['read', 'glance'] };
const HS = { enabled: true, url: 'http://127.0.0.1:9/hs', apiKey: 'k', bank: 'b', kinds: ['read', 'glance'] };
const T9 = Date.UTC(2026, 10, 5, 9);

// Every call is logged; `hold` makes the next platform call wait until release() is called.
function setup(dests = { webhook: HOOK, hindsight: HS }) {
  const store = fakeStore({ settings: { consent: { agreed: true, at: 'x' } },
    ...Object.fromEntries(Object.entries(dests).map(([id, cfg]) => ['dest:' + id, cfg])) });
  const now = fakeClock(T9);
  const calls = [], gates = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url, body: init.body && JSON.parse(init.body) });
    if (gates.length) await new Promise(r => gates.shift()(r));
    return new Response(JSON.stringify({ success: true, status: 'stored' }), { status: 200 });
  };
  const hold = () => { let release; const p = new Promise(r => { release = r; }); gates.push(go => p.then(go)); return release; };
  const core = createCore({ store, alarms: fakeAlarms(), now, version: '0.1.0' });
  return { store, now, core, calls, hold };
}
const to = (calls, part) => calls.filter(c => c.url.includes(part));
const hsText = c => c.body.items[0].content;
async function until(cond) {
  const end = performance.now() + 2000;
  while (!cond() && performance.now() < end) await new Promise(r => setImmediate(r));
}
const visit = async (core, tab, url) => (await core.start(tab, url)).id;
const rep = (core, tab, id, url, text, extra = {}) =>
  core.report(tab, { id, url, title: 'T', text, dwellMs: 12000, first: T9, last: T9 + 12000, ...extra });

test('a mid-visit publish keeps the visit open: same draft, no restart', async () => {
  const { store, core, calls } = setup();
  const id = await visit(core, 1, 'https://e.com/a');
  assert.deepEqual(await rep(core, 1, id, 'https://e.com/a', 'one', { publish: true }), { capture: true, thresholdMs: 10000 });
  assert.equal(to(calls, '/hs').length, 1, 'Hindsight got the mid-visit version');
  assert.equal(store.data['v:' + id].id, id, 'the draft stays');
  assert.deepEqual(await rep(core, 1, id, 'https://e.com/a', 'two'), { capture: true, thresholdMs: 10000 }, 'no restart');
  await rep(core, 1, id, 'https://e.com/a', 'three', { end: true });
  assert.equal(to(calls, '/hook').length, 1);
  assert.equal(to(calls, '/hook')[0].body.capture_id, id, 'the final record keeps the visit id');
});

test('only Neurosea connected: a mid-visit publish leaves no row, no count, no queue', async () => {
  const { store, core, calls } = setup({ webhook: HOOK });
  const id = await visit(core, 1, 'https://e.com/a');
  await rep(core, 1, id, 'https://e.com/a', 'one', { publish: true });
  assert.equal(calls.length, 0);
  assert.equal(store.data.recent, undefined);
  assert.equal(store.data.today, undefined);
  assert.equal(store.data['r:' + id], undefined);
});

test('a visit is queued once; enqueueing it again replaces the record and moves it to the tail', async () => {
  const { store, core } = setup({ hindsight: HS });
  store.data['dstate:hindsight'] = { failures: 1, nextAt: T9 + 3600e3 }; // nothing goes out
  const rec = (n, text) => ({ schema: 'afferent.page/1', capture_id: `00000000-0000-4000-8000-00000000000${n}`, page_key: 'k' + n,
    kind: 'read', url: `https://e.com/${n}`, title: 't', site: 'e.com', text, dwell_seconds: 12,
    first_seen: new Date(T9).toISOString(), last_seen: new Date(T9 + 12000).toISOString(), client: { name: 'afferent', version: '0.1.0' } });
  await core.enqueue(rec(1, 'a1'));
  await core.enqueue(rec(2, 'b'));
  await core.enqueue(rec(1, 'a2'));
  assert.deepEqual(store.data['q:hindsight'], [rec(2).capture_id, rec(1).capture_id]);
  assert.equal(store.data['r:' + rec(1).capture_id].text, 'a2');
});

test('a newer version enqueued while the older one is out is still sent, the final one too', async () => {
  const { store, core, calls, hold } = setup();
  const url = 'https://e.com/a', id = await visit(core, 1, url);
  const r1 = hold();
  const p1 = rep(core, 1, id, url, 'one', { publish: true });
  await until(() => to(calls, '/hs').length === 1);
  const r2 = hold();
  await rep(core, 1, id, url, 'two', { publish: true });
  r1();
  await until(() => to(calls, '/hs').length === 2);
  assert.equal(to(calls, '/hs').length, 2, 'the newer mid-visit version was sent');
  assert.match(hsText(to(calls, '/hs')[1]), /two$/, 'the newer mid-visit version went out after the older one');
  await rep(core, 1, id, url, 'three', { end: true });
  r2();
  await p1;
  await until(() => to(calls, '/hs').length === 3);
  assert.equal(to(calls, '/hs').length, 3, 'the final version was sent');
  assert.match(hsText(to(calls, '/hs')[2]), /three$/, 'the final version went out after the in-flight one');
  assert.deepEqual(store.data['q:hindsight'], []);
  assert.equal(store.data['r:' + id], undefined);
  const hook = to(calls, '/hook');
  assert.equal(hook.length, 1);
  // Nothing used to tell versions apart reaches a body: same fields as a visit that never published.
  const b = await visit(core, 2, 'https://e.com/b');
  await rep(core, 2, b, 'https://e.com/b', 'plain', { end: true });
  await until(() => to(calls, '/hook').length === 2);
  assert.deepEqual(Object.keys(hook[0].body), Object.keys(to(calls, '/hook')[1].body));
  assert.deepEqual(Object.keys(to(calls, '/hs')[2].body.items[0].metadata), Object.keys(to(calls, '/hs').at(-1).body.items[0].metadata));
});

test('one popup row per visit, counted once in today', async () => {
  const { store, core } = setup();
  const url = 'https://e.com/a', id = await visit(core, 1, url);
  await rep(core, 1, id, url, 'one', { publish: true });
  await rep(core, 1, id, url, 'two', { publish: true });
  await rep(core, 1, id, url, 'three', { end: true });
  assert.equal(store.data.recent.length, 1);
  assert.equal(store.data.recent[0].id, id);
  assert.deepEqual(store.data.recent[0].status, { hindsight: 'sent', webhook: 'sent' });
  assert.equal(store.data.today.n, 1);
});

test('09:00 publish, visit still open, delete "last 15 min" at 10:00: row gone, today down, Hindsight named', async () => {
  const { store, now, core } = setup({ hindsight: HS });
  const url = 'https://e.com/a', id = await visit(core, 1, url);
  await rep(core, 1, id, url, 'one', { publish: true });
  assert.equal(store.data.recent[0].status.hindsight, 'sent');
  assert.equal(store.data.today.n, 1);
  now.t = T9 + 3600e3;
  // Still reading at 09:59: the draft's last moves on, the row keeps 09:00.
  await rep(core, 1, id, url, 'one', { last: now.t - 1000 });
  const out = await core.deleteWindow(now.t - 15 * 60e3, now.t);
  assert.deepEqual(out.sentTo, ['hindsight']);
  assert.deepEqual(store.data.recent, []);
  assert.equal(store.data.today.n, 0);
});

test('delete while the latest version waits: the platform that got an earlier one is still named', async () => {
  const { store, core } = setup({ hindsight: HS });
  const url = 'https://e.com/a', id = await visit(core, 1, url);
  await rep(core, 1, id, url, 'one', { publish: true });
  store.data['dstate:hindsight'] = { failures: 1, nextAt: T9 + 3600e3 };
  await rep(core, 1, id, url, 'two', { publish: true });
  assert.equal(store.data.recent[0].status.hindsight, 'queued');
  assert.deepEqual((await core.deleteCapture(id)).sentTo, ['hindsight']);
});
