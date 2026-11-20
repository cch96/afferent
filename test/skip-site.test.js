// 不记这个网站: the site joins the own list, and what the extension still holds from it is deleted the way a row delete does it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createCore } from '../src/lib/core.js';
import { fakeStore, fakeAlarms, fakeClock, fakeFetch } from './fakes.js';

const DEST = { enabled: true, url: 'http://192.0.2.10:8770/hook', token: 's3cret', kinds: ['read', 'glance'] };

// 503: records stay queued, so the queues show what was purged.
function setup(hook = true) {
  const store = fakeStore({ settings: { consent: { agreed: true, at: 'x' } }, ...(hook && { 'dest:webhook': DEST }) });
  const now = fakeClock();
  globalThis.fetch = fakeFetch([503, 503, 503, 503, 503]);
  return { store, now, core: createCore({ store, alarms: fakeAlarms(), now, version: '0.6.6' }) };
}
const read = async (core, now, tab, url, end = true) => {
  const s = await core.start(tab, url);
  await core.report(tab, { id: s.id, url, title: url, text: 'x', dwellMs: 20000, first: now() - 60e3, last: now(), end });
  return s.id;
};

test('the site is on the own list; its entries, queued pages and open visit go; another site stays; Neurosea gets exactly those ids', async () => {
  const { store, now, core } = setup();
  const a = await read(core, now, 1, 'https://news.example.com/a');
  const b = await read(core, now, 2, 'https://news.example.com/b');
  const keep = await read(core, now, 3, 'https://cook.example.org/c');
  const open = await read(core, now, 4, 'https://news.example.com/open', false);
  store.data.recent.find(e => e.id === a).status.hindsight = 'sent';
  const before = store.data.today.n;

  const r = await core.skipSite('news.example.com');
  assert.deepEqual(store.data.settings.skipOwn, ['news.example.com']);
  assert.deepEqual(store.data.recent.map(e => e.id), [keep]);
  assert.deepEqual(store.data['q:webhook'], [keep]);
  for (const id of [a, b, open]) assert.equal(store.data['r:' + id], undefined);
  assert.ok(store.data['r:' + keep]);
  assert.deepEqual(store.data.forgetq.map(j => j.body.capture_ids.sort()), [[a, b, open].sort()]);
  assert.deepEqual(r, { n: 3, sentTo: ['hindsight'], forget: 'queued' });
  assert.equal(store.data.today.n, before - 2);

  // The open visit leaves no record and no draft content; the next visit to the site is not recorded.
  assert.deepEqual(store.data['v:' + open], { id: open, tabId: 4, off: true });
  assert.deepEqual(await core.report(4, { id: open, url: 'https://news.example.com/open', dwellMs: 30000, first: 1, last: 2, end: true }), { capture: false });
  assert.equal((await core.start(5, 'https://news.example.com/x')).capture, false);
  assert.deepEqual(store.data.recent.map(e => e.id), [keep]);
});

test('without Neurosea nothing is queued for it; the local delete still happens', async () => {
  const { store, now, core } = setup(false);
  await read(core, now, 1, 'https://news.example.com/a');
  const r = await core.skipSite('news.example.com');
  assert.equal(store.data.forgetq, undefined);
  assert.deepEqual(store.data.recent, []);
  assert.deepEqual(r, { n: 1, sentTo: [], forget: 'none' });
});

test('nothing recorded from the site: no forget job, a zero count; a site a rule already covers is not added again', async () => {
  const { store, core } = setup();
  assert.deepEqual(await core.skipSite('news.example.com'), { n: 0, sentTo: [], forget: 'none' });
  assert.equal(store.data.forgetq, undefined);
  await core.skipSite('www.news.example.com');
  await core.skipSite('my.1password.com');
  assert.deepEqual(store.data.settings.skipOwn, ['news.example.com']);
});

// A one-word host deletes only that exact host: the job never carries ids of *.dev captures.
test('skipSite(\'dev\'): only the http://dev/ capture is deleted, go.dev and web.dev stay; Neurosea gets only its id', async () => {
  const { store, now, core } = setup();
  const a = await read(core, now, 1, 'http://dev/a');
  const b = await read(core, now, 2, 'https://go.dev/doc');
  const c = await read(core, now, 3, 'https://web.dev/x');
  assert.deepEqual(await core.skipSite('dev'), { n: 1, sentTo: [], forget: 'queued' });
  assert.deepEqual(store.data.forgetq.map(j => j.body.capture_ids), [[a]]);
  assert.deepEqual(store.data.recent.map(e => e.id).sort(), [b, c].sort());
});

test('skipSite(\'example.com\') still deletes the subdomain captures too', async () => {
  const { store, now, core } = setup();
  const a = await read(core, now, 1, 'https://example.com/');
  const b = await read(core, now, 2, 'https://docs.example.com/');
  assert.deepEqual(await core.skipSite('example.com'), { n: 2, sentTo: [], forget: 'queued' });
  assert.deepEqual(store.data.forgetq[0].body.capture_ids.sort(), [a, b].sort());
});
