import test from 'node:test';
import assert from 'node:assert/strict';
import { createCore } from '../src/lib/core.js';
import { fakeStore, fakeAlarms, fakeClock, fakeFetch } from './fakes.js';

const DEST = { enabled: true, url: 'http://127.0.0.1:9/hook', token: 't', kinds: ['read', 'glance'] };

function setup(settings = {}) {
  const store = fakeStore({ 'dest:webhook': DEST, settings: { consent: { agreed: true, at: 'x' }, ...settings } });
  const now = fakeClock();
  globalThis.fetch = fakeFetch([]);
  const mk = () => createCore({ store, alarms: fakeAlarms(), now, version: '0.1.0' });
  return { store, now, core: mk(), mk };
}
const sent = () => globalThis.fetch.calls.map(c => c.body);

test('tab closed after crossing the threshold queues a read record', async () => {
  const { core, now } = setup();
  const s = await core.start(7, 'https://e.com/a?token=1#x');
  assert.equal(s.capture, true);
  assert.equal(s.thresholdMs, 10000);
  assert.match(s.id, /^[0-9a-f-]{36}$/);
  const t0 = now();
  await core.report(7, { id: s.id, url: 'https://e.com/a?token=1#x', title: 'A', lang: 'en', dwellMs: 12000, first: t0, last: t0 + 12000, text: 'body text' });
  assert.equal(sent().length, 0, 'not sent before the visit ends');
  await core.tabRemoved(7);
  const [r] = sent();
  assert.equal(r.kind, 'read');
  assert.equal(r.capture_id, s.id);
  assert.equal(r.url, 'https://e.com/a');
  assert.equal(r.text, 'body text');
  assert.equal(r.dwell_seconds, 12);
});

test('end report finalizes; a later report for the same id restarts', async () => {
  const { core } = setup();
  const s = await core.start(1, 'https://e.com/');
  await core.report(1, { id: s.id, url: 'https://e.com/', title: 'x', dwellMs: 2000, first: 1, last: 2, end: true });
  assert.equal(sent()[0].kind, 'glance');
  assert.equal(sent()[0].text, '');
  assert.deepEqual(await core.report(1, { id: s.id, url: 'https://e.com/', dwellMs: 3000, first: 1, last: 3 }), { restart: true });
  await core.tabRemoved(1);
  assert.equal(sent().length, 1);
});

test('end report without title/text keeps earlier values (SPA change)', async () => {
  const { core } = setup();
  const s = await core.start(1, 'https://e.com/a');
  await core.report(1, { id: s.id, url: 'https://e.com/a', title: 'Old', text: 'old text', dwellMs: 15000, first: 1, last: 2 });
  await core.report(1, { id: s.id, url: 'https://e.com/a', dwellMs: 16000, first: 1, last: 3, end: true });
  assert.equal(sent()[0].title, 'Old');
  assert.equal(sent()[0].text, 'old text');
  assert.equal(sent()[0].dwell_seconds, 16);
});

test('never focused: no record', async () => {
  const { core, store } = setup();
  const s = await core.start(3, 'https://e.com/');
  await core.report(3, { id: s.id, url: 'https://e.com/', dwellMs: 0, first: null, last: null });
  await core.tabRemoved(3);
  assert.equal(sent().length, 0);
  assert.equal(store.data.recent, undefined);
});

test('skipped, paused and unconsented pages are not captured', async () => {
  for (const [settings, url] of [
    [{}, 'https://www.1password.com/x'],
    [{ skipOn: ['payment'] }, 'https://www.paypal.com/x'],
    [{ paused: true }, 'https://e.com/'],
    [{ consent: null }, 'https://e.com/'],
  ]) {
    const { core } = setup(settings);
    assert.deepEqual(await core.start(1, url), { capture: false }, url);
  }
});

test('SPA change into a skipped prefix: new visit refused, prior visit kept', async () => {
  const { core } = setup({ skipOn: ['chat'] });
  const a = await core.start(1, 'https://x.feishu.cn/docx/1');
  assert.equal(a.capture, true);
  await core.report(1, { id: a.id, url: 'https://x.feishu.cn/docx/1', dwellMs: 11000, first: 1, last: 2, text: 'doc', end: true });
  assert.deepEqual(await core.start(1, 'https://x.feishu.cn/next/messenger/c'), { capture: false });
  assert.equal((await core.start(1, 'https://x.feishu.cn/wiki/2')).capture, true);
  assert.equal(sent().length, 1);
});

test('pausing mid-visit drops the draft', async () => {
  const { core, store } = setup();
  const s = await core.start(1, 'https://e.com/');
  await core.report(1, { id: s.id, url: 'https://e.com/', dwellMs: 11000, first: 1, last: 2 });
  await core.setSettings({ paused: true });
  assert.deepEqual(await core.report(1, { id: s.id, url: 'https://e.com/', dwellMs: 12000, first: 1, last: 2 }), { capture: false });
  await core.tabRemoved(1);
  assert.equal(sent().length, 0);
  assert.equal(Object.keys(store.data).some(k => k.startsWith('v:')), false);
});

test('browser closed without tab events: drafts finalized on next startup', async () => {
  const { core, mk } = setup();
  const s = await core.start(4, 'https://e.com/');
  await core.report(4, { id: s.id, url: 'https://e.com/', dwellMs: 30000, first: 1, last: 2, text: 't' });
  await mk().startup();
  assert.equal(sent()[0].kind, 'read');
});

test('long-hidden drafts finalized by the sweep alarm, fresh ones kept', async () => {
  const { core, now } = setup();
  const a = await core.start(1, 'https://e.com/a');
  await core.report(1, { id: a.id, url: 'https://e.com/a', dwellMs: 5000, first: 1, last: 2 });
  now.t += 20 * 60e3;
  const b = await core.start(2, 'https://e.com/b');
  await core.report(2, { id: b.id, url: 'https://e.com/b', dwellMs: 5000, first: 1, last: 2 });
  now.t += 11 * 60e3;
  await core.alarm('sweep');
  assert.deepEqual(sent().map(r => r.url), ['https://e.com/a']);
});

test('today counter increments per record', async () => {
  const { core, store, now } = setup();
  for (const tab of [1, 2]) {
    const s = await core.start(tab, 'https://e.com/' + tab);
    // Counted by the day it was last seen, so seen today.
    await core.report(tab, { id: s.id, url: 'https://e.com/' + tab, dwellMs: 1000, first: now() - 2000, last: now() - 1000, end: true });
  }
  assert.equal(store.data.today.n, 2);
});

test('drafts never hold sensitive params', async () => {
  const { core, store } = setup();
  const s = await core.start(1, 'https://e.com/cb?code=abc&x=1');
  await core.report(1, { id: s.id, url: 'https://e.com/cb?code=abc&x=1', dwellMs: 1000, first: 1, last: 2 });
  assert.ok(!JSON.stringify(store.data).includes('code=abc'));
});

test('user strip list: names from settings never reach the draft or the record', async () => {
  const { core, store } = setup({ stripParams: ['invite'] });
  const s = await core.start(1, 'https://e.com/a?invite=abc&p=2&utm_source=x');
  assert.equal(store.data['v:' + s.id].url, 'https://e.com/a?p=2');
  await core.report(1, { id: s.id, url: 'https://e.com/a?invite=abc&p=2', title: 'A', dwellMs: 2000, first: 1, last: 2, end: true });
  assert.equal(sent()[0].url, 'https://e.com/a?p=2');
});

const GHP = 'ghp_' + 'aB3dE5fG7h'.repeat(4).slice(0, 36);

test('secrets in title and text are redacted before the 100000-char cut; recent shows the count', async () => {
  const { core, store } = setup();
  const s = await core.start(1, 'https://e.com/a');
  const text = 'x'.repeat(99990) + ' ' + GHP;
  await core.report(1, { id: s.id, url: 'https://e.com/a', title: 'key ' + GHP, text, dwellMs: 12000, first: 1, last: 2, end: true });
  const [r] = sent();
  assert.equal(r.title, 'key [redacted:github-pat]');
  assert.equal(r.text.length, 100000);
  assert.ok(!r.text.includes('ghp_'), 'no half-kept token');
  assert.equal(store.data.recent[0].redacted, 2);
});

test('secret settings: a stored secretsOff no longer stops a built-in rule; a user rule fires', async () => {
  const { core } = setup({ secretsOff: ['github-pat'], secretRules: ['badge: EMP-\\d{6}'] });
  const s = await core.start(1, 'https://e.com/a');
  await core.report(1, { id: s.id, url: 'https://e.com/a', title: 'T', text: `${GHP} EMP-123456`, dwellMs: 12000, first: 1, last: 2, end: true });
  assert.equal(sent()[0].text, '[redacted:github-pat] [redacted:badge]');
});

test('a secret straddling the 100000-char cut leaves no fragment', async () => {
  const { core } = setup();
  const s = await core.start(1, 'https://e.com/a');
  const text = 'x'.repeat(99990) + ' ' + GHP + ' and more text after it';
  await core.report(1, { id: s.id, url: 'https://e.com/a', title: 'T', text, dwellMs: 12000, first: 1, last: 2, end: true });
  const [r] = sent();
  assert.ok(r.text.length <= 100000);
  assert.ok(!r.text.includes('ghp_'));
});

// ---- media ----
const media = (src, playMs = 70000) => [{ kind: 'video', src, duration: 100, played: [[0, 70]], playMs, bgMs: playMs }];

test('drafts never hold a raw media src: token and user params are stripped before storing', async () => {
  const { core, store } = setup({ stripParams: ['sess'] });
  const s = await core.start(1, 'https://e.com/w');
  assert.equal(s.media, true);
  await core.report(1, { id: s.id, url: 'https://e.com/w', dwellMs: 0, first: 1, last: 2, media: media('https://cdn.e.com/v.mp4?token=abc&sess=9&x=1') });
  const raw = JSON.stringify(store.data);
  assert.ok(!raw.includes('token=abc') && !raw.includes('sess=9'), raw);
  assert.equal(store.data['v:' + s.id].media[0].src, 'https://cdn.e.com/v.mp4?x=1');
  await core.tabRemoved(1);
  assert.equal(sent()[0].kind, 'read');
  assert.equal(sent()[0].media[0].play_s, 70);
});

test('record playback off: start says so, and media is neither stored nor sent', async () => {
  const { core, store } = setup({ recordPlayback: false });
  const s = await core.start(1, 'https://e.com/w');
  assert.equal(s.media, false);
  await core.report(1, { id: s.id, url: 'https://e.com/w', dwellMs: 12000, first: 1, last: 2, media: media('https://cdn.e.com/v.mp4') });
  assert.equal('media' in store.data['v:' + s.id], false);
  await core.tabRemoved(1);
  assert.equal('media' in sent()[0], false);
});

test('playback under 60 s with no dwell: no record', async () => {
  const { core } = setup();
  const s = await core.start(1, 'https://e.com/w');
  await core.report(1, { id: s.id, url: 'https://e.com/w', dwellMs: 0, first: 1, last: 2, media: media('https://cdn.e.com/v.mp4', 59000) });
  await core.tabRemoved(1);
  assert.equal(sent().length, 0);
});

// ---- Bilibili subtitles ----
const BV = 'https://www.bilibili.com/video/BV1xx411c7mD';
const subMsg = { subtitle_status: 'ok', subtitles: [{ source: 'bilibili', lang: 'ai-zh', auto: true, lines: [[0.04, 1, 'hi']] }] };

test('subtitles switch off: every record says subtitle_status off, with no subtitle fields', async () => {
  for (const url of [BV, 'https://e.com/a']) {
    const { core } = setup({ bilibiliSubs: false });
    const s = await core.start(1, url);
    assert.equal(s.subs, false);
    await core.report(1, { id: s.id, url, dwellMs: 12000, first: 1, last: 2, text: 'x', ...subMsg });
    await core.tabRemoved(1);
    const r = sent().at(-1);
    assert.equal(r.subtitle_status, 'off', url);
    assert.ok(!('subtitles' in r) && !('subtitle_error' in r), url);
  }
});

test('start tells the page whether to fetch Bilibili subtitles: both switches must be on', async () => {
  assert.equal((await setup().core.start(1, BV)).subs, true);
  assert.equal((await setup({ bilibiliSubs: false }).core.start(1, BV)).subs, false);
  assert.equal((await setup({ recordPlayback: false }).core.start(1, BV)).subs, false);
});

test('start says no subtitles without an enabled Neurosea: only Neurosea ever receives them', async () => {
  const MEM0 = { enabled: true, apiKey: 'k', userId: 'u', kinds: ['read', 'glance'] };
  const only = setup();
  delete only.store.data['dest:webhook'];
  only.store.data['dest:mem0'] = MEM0;
  assert.equal((await only.core.start(1, BV)).subs, false);
  const off = setup();
  off.store.data['dest:webhook'] = { ...DEST, enabled: false };
  assert.equal((await off.core.start(1, BV)).subs, false);
  assert.equal((await setup().core.start(1, BV)).subs, true);
});

test('subtitles are kept in the draft (shaped) and put in the record', async () => {
  const { core, store } = setup();
  const s = await core.start(1, BV);
  await core.report(1, { id: s.id, url: BV, dwellMs: 0, first: 1, last: 2, media: media(null), ...subMsg });
  assert.deepEqual(store.data['v:' + s.id].subtitles[0].lines, [[0, 1, 'hi']]);
  await core.report(1, { id: s.id, url: BV, dwellMs: 0, first: 1, last: 3, media: media(null) }); // later reports carry none
  await core.tabRemoved(1);
  const [r] = sent();
  assert.equal(r.subtitle_status, 'ok');
  assert.deepEqual(r.subtitles, [{ source: 'bilibili', lang: 'ai-zh', auto: true, lines: [[0, 1, 'hi']] }]);
});

test('subtitles switched off meanwhile: the record says off and drops the fetched fields', async () => {
  const { core } = setup();
  const s = await core.start(1, BV);
  await core.report(1, { id: s.id, url: BV, dwellMs: 12000, first: 1, last: 2, media: media(null), subtitle_status: 'error', subtitle_error: 'view HTTP 412' });
  await core.setSettings({ bilibiliSubs: false });
  await core.tabRemoved(1);
  assert.equal(sent()[0].subtitle_status, 'off');
  assert.ok(!('subtitle_error' in sent()[0]));
});

for (const off of [{ recordPlayback: false }]) {
  test(`subtitle fields dropped at finalize when playback is switched off meanwhile`, async () => {
    const { core } = setup();
    const s = await core.start(1, BV);
    await core.report(1, { id: s.id, url: BV, dwellMs: 12000, first: 1, last: 2, media: media(null), subtitle_status: 'error', subtitle_error: 'view HTTP 412' });
    await core.setSettings(off);
    await core.tabRemoved(1);
    assert.ok(!Object.keys(sent()[0]).some(k => k.startsWith('subtitle')));
  });
}

// finalize: the record is queued before the draft goes, so a kill in between loses nothing.
test('finalize: draft removal fails after the enqueue; the record is queued and startup finalizes again', async () => {
  const { core, store, mk } = setup();
  const s = await core.start(7, 'https://e.com/k');
  await core.report(7, { id: s.id, url: 'https://e.com/k', title: 'K', dwellMs: 12000, first: 1, last: 2, text: 'kept' });
  const remove = store.remove;
  store.remove = async keys => { if ([].concat(keys).includes('v:' + s.id)) throw new Error('killed'); return remove(keys); };
  await assert.rejects(core.tabRemoved(7));
  assert.equal(store.data['r:' + s.id]?.text, 'kept', 'record stored');
  assert.deepEqual(store.data['q:webhook'], [s.id], 'record queued');
  store.remove = remove;
  await mk().startup();
  assert.equal(sent().length, 1);
  assert.equal(sent()[0].text, 'kept');
  assert.equal(store.data['v:' + s.id], undefined);
});

test('finalize: build or enqueue throws; the draft stays for startup', async () => {
  const { core, store, mk } = setup();
  const s = await core.start(7, 'https://e.com/k');
  await core.report(7, { id: s.id, url: 'https://e.com/k', title: 'K', dwellMs: 12000, first: 1, last: 2, text: 'kept' });
  const set = store.set;
  store.set = async obj => { if (Object.keys(obj).some(k => k.startsWith('r:'))) throw new Error('killed'); return set(obj); };
  await assert.rejects(core.tabRemoved(7));
  assert.ok(store.data['v:' + s.id], 'draft kept');
  store.set = set;
  await mk().startup();
  assert.equal(sent().length, 1);
  assert.equal(sent()[0].text, 'kept');
});

// ---- audio / audio_error (audio contract): same gate as subtitles, Neurosea only ----
const SIGNED = 'https://upos-sz.bilivideo.com/x/30216.m4s?deadline=1893456000&token=abc&upsig=a%2Fb';
const audioMsg = { audio: { source: 'bilibili', urls: [SIGNED], expires: 1893456000 } };

test('audio is kept in the draft and put in the record byte for byte; later reports keep it', async () => {
  const { core, store } = setup({ stripParams: ['token', 'upsig', 'deadline'] });
  const s = await core.start(1, BV);
  await core.report(1, { id: s.id, url: BV, dwellMs: 0, first: 1, last: 2, media: media(null), subtitle_status: 'none', ...audioMsg });
  assert.deepEqual(store.data['v:' + s.id].audio, audioMsg.audio);
  await core.report(1, { id: s.id, url: BV, dwellMs: 0, first: 1, last: 3, media: media(null) });
  await core.tabRemoved(1);
  assert.deepEqual(sent()[0].audio, audioMsg.audio);
  assert.ok(JSON.stringify(sent()[0]).includes(JSON.stringify(SIGNED)));
});

test('audio_error is kept and sent, cut to 100', async () => {
  const { core } = setup();
  const s = await core.start(1, BV);
  await core.report(1, { id: s.id, url: BV, dwellMs: 12000, first: 1, last: 2, media: media(null), audio_error: 'playurl HTTP 412' + 'x'.repeat(200) });
  await core.tabRemoved(1);
  assert.equal(sent()[0].audio_error, ('playurl HTTP 412' + 'x'.repeat(200)).slice(0, 100));
});

for (const [name, change] of [
  ['the Subtitles switch off', ({ store }) => { store.data.settings.bilibiliSubs = false; }],
  ['record playback off', ({ store }) => { store.data.settings.recordPlayback = false; }],
  ['no Neurosea', ({ store }) => { delete store.data['dest:webhook']; store.data['dest:mem0'] = { enabled: true, apiKey: 'k', kinds: ['read'] }; }],
  ['Neurosea disabled', ({ store }) => { store.data['dest:webhook'] = { ...DEST, enabled: false }; }],
]) {
  test(`audio not accepted with ${name}`, async () => {
    const env = setup();
    const s = await env.core.start(1, BV);
    change(env);
    for (const m of [audioMsg, { audio_error: 'playurl HTTP 412' }]) {
      await env.core.report(1, { id: s.id, url: BV, dwellMs: 12000, first: 1, last: 2, text: 'x', ...m });
      assert.ok(!Object.keys(env.store.data['v:' + s.id]).some(k => k.startsWith('audio')), name);
    }
  });
}

test('audio dropped at finalize when the Subtitles switch goes off meanwhile', async () => {
  const { core } = setup();
  const s = await core.start(1, BV);
  await core.report(1, { id: s.id, url: BV, dwellMs: 12000, first: 1, last: 2, media: media(null), ...audioMsg });
  await core.setSettings({ bilibiliSubs: false });
  await core.tabRemoved(1);
  assert.ok(!Object.keys(sent()[0]).some(k => k.startsWith('audio')));
});

// Only the webhook adapter sends the record itself; the others must never pass audio on.
test('only the Neurosea payload carries audio / audio_error; Hindsight, Supermemory and Mem0 never do', async () => {
  for (const m of [audioMsg, { audio_error: 'playurl code -352' }]) {
    const { core, store } = setup();
    Object.assign(store.data, {
      'dest:hindsight': { enabled: true, apiKey: 'hsk_k', url: 'https://hs.example', bank: 'b', kinds: ['read'] },
      'dest:supermemory': { enabled: true, apiKey: 'sm_k', kinds: ['read'] },
      'dest:mem0': { enabled: true, apiKey: 'm0-k', kinds: ['read'] },
    });
    const s = await core.start(1, BV);
    await core.report(1, { id: s.id, url: BV, title: 'T', text: 'x', dwellMs: 20000, first: 1, last: 2, media: media(null), ...m });
    await core.tabRemoved(1);
    const calls = globalThis.fetch.calls.filter(c => c.body);
    const hook = calls.filter(c => c.url === DEST.url), others = calls.filter(c => c.url !== DEST.url);
    assert.equal(hook.length, 1);
    assert.ok('audio' in hook[0].body || 'audio_error' in hook[0].body);
    for (const host of ['hs.example', 'supermemory', 'mem0']) assert.ok(others.some(c => c.url.includes(host)), host);
    for (const c of others) {
      const j = JSON.stringify(c.body);
      assert.ok(!/audio/.test(j) && !j.includes('bilivideo') && !j.includes('-352'), c.url);
    }
  }
});

// The server drops dead addresses itself (it has received_at and audio.expires): the record carries audio as is.
test('a record built after audio.expires still carries the audio as is, with no audio_error', async () => {
  const env = setup();
  const s = await env.core.start(1, BV);
  const a = { source: 'bilibili', urls: [SIGNED], expires: Math.floor(env.now() / 1000) + 60 };
  await env.core.report(1, { id: s.id, url: BV, dwellMs: 12000, first: 1, last: 2, media: media(null), audio: a });
  env.now.t += 60e3; // expires == now: dead
  await env.core.tabRemoved(1);
  const r = sent().at(-1);
  assert.deepEqual(r.audio, a);
  assert.equal('audio_error' in r, false);
});

test('an address with time left, or with expires null, is sent', async () => {
  for (const expires of [null, 'later']) {
    const env = setup();
    const s = await env.core.start(1, BV);
    const a = { source: 'bilibili', urls: [SIGNED], expires: expires && Math.floor(env.now() / 1000) + 120 };
    await env.core.report(1, { id: s.id, url: BV, dwellMs: 12000, first: 1, last: 2, media: media(null), audio: a });
    env.now.t += 60e3;
    await env.core.tabRemoved(1);
    assert.deepEqual(sent().at(-1).audio, a);
  }
});
