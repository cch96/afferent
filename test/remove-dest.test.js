// 移除 in a platform's 管理 panel: removeDest(id) forgets that platform and only it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createCore } from '../src/lib/core.js';
import { popupView } from '../src/ui/popup-view.js';
import { fakeStore, fakeAlarms, fakeClock, fakeFetch } from './fakes.js';

const msgs = JSON.parse(readFileSync(new URL('../_locales/zh_CN/messages.json', import.meta.url), 'utf8'));
const t = (k, subs = []) => msgs[k].message.replace(/\$(\d)/g, (_, i) => subs[i - 1]);

const HOOK = { enabled: true, url: 'http://192.0.2.10:8770/hook', token: 'fake_key_00000000000000', kinds: ['read', 'glance'] };
const MEM0 = { enabled: true, apiKey: 'fake_key_00000000000000', userId: 'afferent', kinds: ['read', 'glance'] };
const down = { failures: 3, nextAt: Date.UTC(2030, 0, 1) };

function setup() {
  const now = fakeClock();
  const store = fakeStore({
    settings: { consent: { agreed: true, at: 'x' } },
    'dest:webhook': HOOK, 'dstate:webhook': down, 'q:webhook': ['a', 'b'],
    'dest:mem0': MEM0, 'dstate:mem0': down, 'q:mem0': ['b'],
    'r:a': { capture_id: 'a' }, 'r:b': { capture_id: 'b' },
    recent: [
      { id: 'a', at: now(), status: { webhook: 'queued' } },
      { id: 'b', at: now(), status: { webhook: 'queued', mem0: 'queued' } },
      { id: 'c', at: now(), status: { webhook: 'sent', mem0: 'queued' } },
    ],
    forgetq: [
      { id: 'f1', body: {}, status: { webhook: 'done' } },
      { id: 'f2', body: {}, status: { webhook: 'pending' } },
    ],
  });
  const core = createCore({ store, alarms: fakeAlarms(), now, version: 't' });
  return { store, core, now };
}

test('removeDest: the platform\'s config, delivery state and queue go; another platform\'s stay as they were', async () => {
  const { store, core } = setup();
  await core.removeDest('mem0');
  for (const k of ['dest:mem0', 'dstate:mem0', 'q:mem0']) assert.equal(k in store.data, false, k);
  assert.deepEqual([store.data['dest:webhook'], store.data['dstate:webhook'], store.data['q:webhook']], [HOOK, down, ['a', 'b']]);
  // Still queued for Neurosea: the record stays.
  assert.ok(store.data['r:b']);
  // Forget jobs belong to Neurosea only.
  assert.equal(store.data.forgetq.length, 2);
});

test('removeDest webhook: pending forget jobs go with it; records nobody else waits for go too', async () => {
  const { store, core } = setup();
  await core.removeDest('webhook');
  for (const k of ['dest:webhook', 'dstate:webhook', 'q:webhook', 'r:a']) assert.equal(k in store.data, false, k);
  assert.deepEqual(store.data.forgetq.map(j => j.id), ['f1']);
  assert.ok(store.data['r:b'], 'still queued for Mem0');
  assert.deepEqual([store.data['dest:mem0'], store.data['q:mem0']], [MEM0, ['b']]);
});

test('removeDest webhook: a forget job that had failed goes too, so the popup shows no forget line', async () => {
  const { store, core, now } = setup();
  // Shown first is the pending job; with it gone, the failed one behind it would surface and stay.
  store.data.forgetq.splice(1, 0, { id: 'f0', body: {}, status: { webhook: 'failed' } });
  await core.removeDest('webhook');
  assert.equal(popupView({ store: store.data, tab: null, page: null, now: now() }, t).forget, null);
});

test('patchDest after removeDest: a late patch does not bring the platform back without a key', async () => {
  const { store, core } = setup();
  await core.removeDest('webhook');
  await core.patchDest('webhook', { kinds: ['read'] });
  for (const k of ['dest:webhook', 'dstate:webhook']) assert.equal(k in store.data, false, k);
});

test('removeDest: the popup no longer counts pages as waiting for the removed platform', async () => {
  const { store, core, now } = setup();
  const late = () => popupView({ store: store.data, tab: null, page: null, now: now() }, t).rows.map(r => [r.id, r.late]);
  assert.deepEqual(late(), [['a', 'queued'], ['b', 'queued'], ['c', 'queued']]);
  await core.removeDest('webhook');
  // a: never went anywhere; b: still waits for Mem0; c: Neurosea had it, Mem0 still waits.
  assert.deepEqual(late(), [['a', 'local'], ['b', 'queued'], ['c', 'queued']]);
  assert.deepEqual(store.data.recent.map(e => e.status), [{}, { mem0: 'queued' }, { webhook: 'sent', mem0: 'queued' }]);
  await core.removeDest('mem0');
  assert.deepEqual(late(), [['a', 'local'], ['b', 'local'], ['c', null]]);
});

test('removeDest while a send to that platform is in flight: its late answer brings back no state', async () => {
  const { store, core } = setup();
  let answer;
  globalThis.fetch = () => new Promise(r => { answer = r; });
  store.data['dstate:webhook'] = { failures: 0 };
  const flushing = core.flush('webhook');
  await new Promise(r => setTimeout(r, 10));
  assert.ok(answer, 'the send is in flight');
  await core.removeDest('webhook');
  answer(new Response('{}', { status: 503 }));
  await flushing;
  for (const k of ['dest:webhook', 'dstate:webhook', 'q:webhook']) assert.equal(k in store.data, false, k);
  delete globalThis.fetch;
});

test('removeDest then the same platform again: a glance at a page it already holds is not sent, so its text is not replaced', async () => {
  const HS = { enabled: true, kinds: ['read', 'glance'], apiKey: 'hsk_secret1', url: 'https://hs.example.com:8888/', bank: 'b' };
  const OK = { status: 200, body: { success: true, items_count: 1, is_async: true, operation_id: 'op' } };
  const store = fakeStore({ settings: { consent: { agreed: true, at: 'x' } }, 'dest:hindsight': HS });
  const core = createCore({ store, alarms: fakeAlarms(), now: fakeClock(), version: 't' });
  const page = { schema: 'afferent.page/1', page_key: 'b'.repeat(64), url: 'https://e.com/1', title: 't1', site: 'e.com',
    dwell_seconds: 12, first_seen: '2026-11-05T10:00:00.000Z', last_seen: '2026-11-05T10:00:12.000Z', client: { name: 'afferent', version: 't' } };
  globalThis.fetch = fakeFetch([OK, OK]);
  await core.enqueue({ ...page, capture_id: '00000000-0000-4000-8000-000000000001', kind: 'read', text: 'full text' });
  assert.equal(fetch.calls.length, 1);
  await core.removeDest('hindsight');
  await core.saveDest('hindsight', HS);
  await core.enqueue({ ...page, capture_id: '00000000-0000-4000-8000-000000000002', kind: 'glance' });
  assert.equal(fetch.calls.length, 1, 'the glance went out and would replace the stored text');
  delete globalThis.fetch;
});
