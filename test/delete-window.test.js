// Deleting a time window or one row: local purge, the open page going quiet, and the afferent.forget/1 job.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createCore } from '../src/lib/core.js';
import { readFileSync } from 'node:fs';
import { fakeStore, fakeAlarms, fakeClock, fakeFetch } from './fakes.js';
import { popupView } from '../src/ui/popup-view.js';

const DEST = { enabled: true, url: 'http://192.0.2.10:8770/hook', token: 's3cret', kinds: ['read', 'glance'] };
const HOUR = 3600e3;

function setup(script = [], extra = {}) {
  const store = fakeStore({ 'dest:webhook': DEST, settings: { consent: { agreed: true, at: 'x' } }, ...extra });
  const alarms = fakeAlarms(), now = fakeClock();
  globalThis.fetch = fakeFetch(script);
  const mk = () => createCore({ store, alarms, now, version: '0.1.0' });
  return { store, alarms, now, core: mk(), mk, fetch: globalThis.fetch };
}
const bodies = () => globalThis.fetch.calls.map(c => c.body);
const forgets = () => bodies().filter(b => b.schema === 'afferent.forget/1');
const pages = () => bodies().filter(b => b.schema === 'afferent.page/1');
// The delete no longer waits for the network: poll until the background flush has got where a test needs it.
const until = async fn => { for (let i = 0; i < 200 && !fn(); i++) await new Promise(r => setTimeout(r, 1)); assert.ok(fn()); };
const msgs = JSON.parse(readFileSync(new URL('../_locales/zh_CN/messages.json', import.meta.url), 'utf8'));
const t = (k, subs = []) => msgs[k].message.replace(/\$(\d)/g, (_, i) => subs[i - 1]);
const view = (store, now) => popupView({ store, tab: null, page: null, now }, t).rows.map(r => ({ id: r.id, earlier: r.earlier }));
const midnight = t => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
const rec = n => ({ schema: 'afferent.page/1', capture_id: `00000000-0000-4000-8000-00000000000${n}`, kind: 'read', url: `https://e.com/${n}`,
  title: `t${n}`, site: 'e.com', text: 'x', first_seen: new Date(Date.UTC(2026, 10, 5, 9)).toISOString(), last_seen: new Date(Date.UTC(2026, 10, 5, 9, 1)).toISOString() });

test('"today" selects by visit time: a visit seen yesterday and finalized at startup today survives', async () => {
  // 503 keeps records queued, so the queues show what was purged.
  const { store, core, now } = setup([503]);
  const m0 = midnight(now());
  now.t = m0 - 2 * HOUR;
  const old = await core.start(1, 'https://e.com/old');
  await core.report(1, { id: old.id, url: 'https://e.com/old', title: 'Old', text: 'x', dwellMs: 20000, first: m0 - 2 * HOUR, last: m0 - HOUR });
  now.t = m0 + 10 * HOUR;
  await core.startup(); // browser start finalizes yesterday's draft today
  const fresh = await core.start(2, 'https://e.com/new');
  await core.report(2, { id: fresh.id, url: 'https://e.com/new', title: 'New', text: 'x', dwellMs: 20000, first: now() - 60e3, last: now(), end: true });
  assert.deepEqual(store.data.recent.map(e => e.id).sort(), [old.id, fresh.id].sort());
  // Shown and counted by when it was last seen, not when the startup finalized it.
  assert.equal(store.data.recent.find(e => e.id === old.id).at, m0 - HOUR);
  assert.equal(store.data.today.n, 1, 'the visit seen yesterday does not raise today\'s count');
  assert.deepEqual(view(store.data, now()), [{ id: fresh.id, earlier: false }, { id: old.id, earlier: true }]);

  const r = await core.deleteWindow(m0, now());
  assert.equal(r.n, 1);
  assert.equal(r.forget, 'queued');
  assert.deepEqual(r.sentTo, []);
  assert.deepEqual(store.data.recent.map(e => e.id), [old.id]);
  assert.deepEqual(store.data['q:webhook'], [old.id]);
  assert.ok(store.data['r:' + old.id]);
  assert.equal(store.data['r:' + fresh.id], undefined);
  assert.equal(store.data.today.n, 0);
  assert.deepEqual(view(store.data, now()), [{ id: old.id, earlier: true }], 'no today rows left; the earlier one stays');
});

test('"today" sets the count to 0 even when recent holds fewer entries than the count', async () => {
  const { store, core, now } = setup();
  await core.enqueue(rec(1));
  store.data.today.n = 130;
  await core.deleteWindow(midnight(now()), now());
  assert.equal(store.data.today.n, 0);
  // The last hour still subtracts only what it removed.
  store.data.today.n = 130;
  await core.enqueue(rec(2));
  await core.deleteWindow(now() - HOUR, now());
  assert.equal(store.data.today.n, 130);
});

test('an open draft in the window becomes a tombstone: the page goes quiet, nothing is ever recorded', async () => {
  const { store, core, now } = setup();
  const s = await core.start(1, 'https://e.com/a');
  await core.report(1, { id: s.id, url: 'https://e.com/a', title: 'A', text: 'secret-ish', dwellMs: 20000, first: now() - 60e3, last: now() });
  const r = await core.deleteWindow(now() - HOUR, now());
  assert.equal(r.n, 1);
  assert.equal(store.data['v:' + s.id].off, true);
  assert.equal(store.data['v:' + s.id].text, undefined, 'the tombstone keeps no page content');
  assert.equal('url' in store.data['v:' + s.id], false, 'nor its URL');

  assert.deepEqual(await core.report(1, { id: s.id, url: 'https://e.com/a', dwellMs: 30000, first: now() - 60e3, last: now() + 5000 }), { capture: false });
  now.t += 31 * 60e3;
  await core.alarm('sweep');
  assert.ok(store.data['v:' + s.id], 'the sweep leaves the tombstone, so a late report cannot restart the visit');
  assert.deepEqual(await core.report(1, { id: s.id, url: 'https://e.com/a', dwellMs: 30000, first: 1, last: 2, end: true }), { capture: false });
  await core.tabRemoved(1);
  assert.equal(store.data['v:' + s.id], undefined);
  assert.equal(pages().length, 0);
  assert.equal(Object.keys(store.data).filter(k => k.startsWith('r:')).length, 0);
  assert.deepEqual(store.data.recent ?? [], []);

  // A new document in that tab records normally.
  const b = await core.start(1, 'https://e.com/b');
  assert.equal(b.capture, true);
  await core.report(1, { id: b.id, url: 'https://e.com/b', title: 'B', text: 'x', dwellMs: 20000, first: now(), last: now() + 1000, end: true });
  assert.deepEqual(pages().map(p => p.url), ['https://e.com/b']);
});

test('the forget job is stored before it is sent, with ISO times', async () => {
  const { store, core, now } = setup([200]);
  const from = now() - HOUR, to = now();
  let seen;
  const f = globalThis.fetch;
  globalThis.fetch = async (...a) => { seen = structuredClone(store.data.forgetq); return f(...a); };
  globalThis.fetch.calls = f.calls;
  assert.equal((await core.deleteWindow(from, to)).forget, 'queued');
  await until(() => store.data.forgetq[0].status.webhook === 'done');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].status.webhook, 'pending');
  assert.deepEqual(forgets(), [{ schema: 'afferent.forget/1', from: new Date(from).toISOString(), to: new Date(to).toISOString(), capture_ids: [] }]);
  assert.equal(f.calls[0].init.headers.Authorization, 'Bearer s3cret');
  assert.equal(store.data.forgetq[0].status.webhook, 'done');
});

test('a 5xx keeps the job pending; the backoff alarm (after a service-worker restart) sends it', async () => {
  const { store, core, now, alarms, mk } = setup([503, 200]);
  await core.deleteWindow(now() - HOUR, now());
  await until(() => alarms.set.has('flush:webhook'));
  assert.equal(store.data.forgetq[0].status.webhook, 'pending');
  assert.equal(forgets().length, 1);
  now.t = alarms.set.get('flush:webhook').when;
  await mk().alarm('flush:webhook');
  assert.equal(forgets().length, 2);
  assert.deepEqual(forgets()[1], forgets()[0]);
  assert.equal(store.data.forgetq[0].status.webhook, 'done');
});

test('a 400 marks the job failed with the detail and it is never resent', async () => {
  const { store, core, now, mk } = setup([{ status: 400, body: { error: 'unknown schema' } }]);
  await core.deleteWindow(now() - HOUR, now());
  await until(() => store.data.forgetq[0].status.webhook === 'failed');
  assert.equal(store.data.forgetq[0].status.webhook, 'failed');
  assert.match(store.data.forgetq[0].detail, /400 unknown schema/);
  await core.flush();
  await mk().flush();
  assert.equal(forgets().length, 1);
});

test('a 401 keeps the job pending until the key changes', async () => {
  const { store, core, now } = setup([401, 200]);
  await core.deleteWindow(now() - HOUR, now());
  await until(() => store.data['dstate:webhook']?.auth);
  assert.equal(store.data.forgetq[0].status.webhook, 'pending');
  assert.equal(store.data['dstate:webhook'].auth, true);
  await core.flush();
  assert.equal(forgets().length, 1);
  await core.patchDest('webhook', { token: 'new' });
  assert.equal(forgets().length, 2);
  assert.equal(store.data.forgetq[0].status.webhook, 'done');
});

test('a row delete sends a capture_ids forget for that id and purges it locally', async () => {
  const { store, core } = setup([503, 200]);
  await core.enqueue(rec(1)); // 503: still queued, backoff running
  const id = rec(1).capture_id;
  const r = await core.deleteCapture(id);
  assert.deepEqual(r, { n: 1, sentTo: [], forget: 'queued' });
  assert.deepEqual(store.data['q:webhook'], []);
  assert.equal(store.data['r:' + id], undefined);
  assert.deepEqual(store.data.recent, []);
  assert.deepEqual(store.data.forgetq[0].body, { schema: 'afferent.forget/1', capture_ids: [id] });
  await core.retry();
  assert.deepEqual(forgets(), [{ schema: 'afferent.forget/1', capture_ids: [id] }]);
  assert.equal(pages().length, 1, 'the deleted record is not sent again');
});

test('without a webhook destination the delete purges locally and answers forget: none', async () => {
  const { store, core, now } = setup();
  delete store.data['dest:webhook'];
  await core.enqueue(rec(1));
  store.data.recent[0].status.supermemory = 'sent';
  const r = await core.deleteWindow(Date.UTC(2026, 10, 5, 8), now());
  assert.deepEqual(r, { n: 1, sentTo: ['supermemory'], forget: 'none' });
  assert.deepEqual(store.data.recent, []);
  assert.equal(store.data.forgetq, undefined);
  assert.equal(globalThis.fetch.calls.length, 0);
});

test('Neurosea switched off still gets the forget: queued now, sent when switched back on', async () => {
  const { store, core, now } = setup([], { 'dest:webhook': { ...DEST, enabled: false } });
  const r = await core.deleteWindow(now() - HOUR, now());
  assert.equal(r.forget, 'queued');
  assert.equal(store.data.forgetq[0].status.webhook, 'pending');
  await core.flush();
  assert.equal(forgets().length, 0, 'nothing is sent while it is off');
  await core.patchDest('webhook', { enabled: true });
  assert.equal(forgets().length, 1);
  assert.equal(store.data.forgetq[0].status.webhook, 'done');
});

test('a window delete lists every capture it removes locally next to from/to', async () => {
  const { store, core, now } = setup([503]);
  const from = now() - HOUR, to = now();
  // A 0.4.x entry: no first/last, finalized inside the window.
  const OLD = '00000000-0000-4000-8000-0000000000aa';
  store.data.recent = [{ id: OLD, title: 'o', site: 'e.com', url: 'https://e.com/o', kind: 'read', at: now() - 10 * 60e3, status: { webhook: 'sent' }, redacted: 0 }];
  // A record still queued in the browser.
  const q = { ...rec(1), first_seen: new Date(now() - 20 * 60e3).toISOString(), last_seen: new Date(now() - 19 * 60e3).toISOString() };
  store.data['r:' + q.capture_id] = q;
  store.data['q:webhook'] = [q.capture_id];
  // An open draft that was seen.
  const d = await core.start(1, 'https://e.com/d');
  await core.report(1, { id: d.id, url: 'https://e.com/d', title: 'D', text: 'x', dwellMs: 20000, first: now() - 60e3, last: now() });
  await core.deleteWindow(from, to);
  const body = store.data.forgetq[0].body;
  assert.equal(body.from, new Date(from).toISOString());
  assert.equal(body.to, new Date(to).toISOString());
  assert.deepEqual([...body.capture_ids].sort(), [OLD, q.capture_id, d.id].sort());
});

test('an unseen draft loaded inside the window is not matched and records normally later', async () => {
  const { store, core, now } = setup();
  const d = await core.start(1, 'https://e.com/bg'); // background tab: never looked at, first is null
  now.t += 60e3;
  const r = await core.deleteWindow(now() - HOUR, now());
  assert.equal(r.n, 0);
  assert.equal(store.data['v:' + d.id].off, undefined);
  assert.equal((await core.report(1, { id: d.id, url: 'https://e.com/bg', title: 'BG', text: 'x', dwellMs: 20000, first: now(), last: now() + 1000 })).capture, true);
  assert.deepEqual(await core.report(1, { id: d.id, url: 'https://e.com/bg', title: 'BG', text: 'x', dwellMs: 20000, first: now(), last: now() + 1000, end: true }), { capture: true });
  assert.deepEqual(pages().map(p => p.url), ['https://e.com/bg']);
});

test('the delete answers before the network does', async () => {
  const { store, core, now } = setup();
  let release;
  const gate = new Promise(r => { release = r; });
  const f = globalThis.fetch;
  globalThis.fetch = async (...a) => { await gate; return f(...a); };
  globalThis.fetch.calls = f.calls;
  const r = await Promise.race([core.deleteWindow(now() - HOUR, now()), new Promise(r => setTimeout(() => r('waited'), 200))]);
  assert.equal(r.forget, 'queued');
  release();
  await until(() => store.data.forgetq[0].status.webhook === 'done');
});

test('the page the owner is on is tombstoned even before its first report; unseen drafts in other tabs are not', async () => {
  const { store, core, now } = setup([200, 200]);
  const d = await core.start(7, 'https://e.com/fg'); // foreground: the popup's tab, no report yet
  const bg = await core.start(8, 'https://e.com/bg');
  const loaded = now();
  now.t += 5e3;
  const r = await core.deleteWindow(now() - HOUR, now(), 7);
  assert.equal(r.n, 1);
  assert.deepEqual(store.data['v:' + d.id], { id: d.id, tabId: 7, off: true });
  assert.deepEqual(store.data.forgetq[0].body.capture_ids, [d.id]);
  assert.deepEqual(await core.report(7, { id: d.id, url: 'https://e.com/fg', title: 'FG', text: 'x', dwellMs: 20000, first: loaded, last: now() + 15e3 }), { capture: false });
  assert.deepEqual(await core.report(7, { id: d.id, url: 'https://e.com/fg', dwellMs: 20000, first: loaded, last: now() + 16e3, end: true }), { capture: false });
  assert.equal(store.data['v:' + bg.id].off, undefined);
  assert.equal((await core.report(8, { id: bg.id, url: 'https://e.com/bg', title: 'BG', text: 'x', dwellMs: 20000, first: now(), last: now() + 1000 })).capture, true);
  await core.report(8, { id: bg.id, url: 'https://e.com/bg', title: 'BG', text: 'x', dwellMs: 20000, first: now(), last: now() + 1000, end: true });
  await until(() => pages().length === 1);
  assert.deepEqual(pages().map(p => p.url), ['https://e.com/bg']);
  assert.equal(store.data['r:' + d.id], undefined, 'no record queued for the tombstoned page');
  assert.ok(!(store.data['q:webhook'] ?? []).includes(d.id));
  assert.ok(!(store.data.recent ?? []).some(e => e.id === d.id));
});

test('全部 ({from: 0, to: now}) leaves no recent, r: or q: entries and queues a forget from 1970', async () => {
  const { store, core, now } = setup([503]);
  await core.enqueue(rec(1)); // 503: stays queued
  store.data.recent.push({ id: '00000000-0000-4000-8000-0000000000aa', title: 'o', site: 'e.com', url: 'https://e.com/o', kind: 'read',
    at: Date.UTC(2020, 0, 1), status: { webhook: 'sent' }, redacted: 0 });
  await core.deleteWindow(0, now());
  assert.deepEqual(store.data.recent, []);
  const keys = Object.keys(store.data);
  assert.deepEqual(keys.filter(k => k.startsWith('r:')), []);
  for (const k of keys.filter(k => k.startsWith('q:'))) assert.deepEqual(store.data[k], [], k);
  const { body } = store.data.forgetq[0];
  assert.equal(body.from, '1970-01-01T00:00:00.000Z');
  assert.equal(body.to, new Date(now()).toISOString());
});
