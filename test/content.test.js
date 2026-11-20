// Runs the real content scripts in a vm with a fake DOM, wired to a real core over fake storage.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { createCore } from '../src/lib/core.js';
import { fakeStore, fakeAlarms, fakeFetch } from './fakes.js';
import { h, doc, fakeMedia } from './fakedom.js';

const src = f => readFileSync(new URL('../src/content/' + f, import.meta.url), 'utf8');
const tick = () => new Promise(r => setImmediate(r));
// Hashing (crypto.subtle) settles off-thread, so wait for the outcome instead of a fixed number of turns.
async function until(cond) {
  const end = performance.now() + 5000;
  while (!cond() && performance.now() < end) await tick();
}

function page(t, { url, focused = true, settings = {}, dom = {}, pageFetch, perf = performance, hook = true }) {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'], now: Date.UTC(2026, 10, 5, 9) });
  const store = fakeStore({
    ...(hook && { 'dest:webhook': { enabled: true, url: 'http://127.0.0.1:9/hook', token: 't', kinds: ['read', 'glance'] } }),
    settings: { consent: { agreed: true, at: 'x' }, thresholdSec: 10, ...settings },
  });
  globalThis.fetch = fakeFetch([]);
  const core = createCore({ store, alarms: fakeAlarms(), version: '0.1.0' });
  const winHandlers = {}, docHandlers = {}, answers = [];
  const on = h => (type, fn) => (h[type] ??= []).push(fn);
  const fire = (h, type, e = {}) => (h[type] || []).forEach(fn => fn(e));
  const env = {
    focused,
    location: { href: url },
    document: {
      visibilityState: focused ? 'visible' : 'hidden', title: 'Page A', documentElement: { lang: 'en' },
      body: { innerText: 'text of A' }, querySelectorAll: () => [], hasFocus: () => env.focused, addEventListener: on(docHandlers), ...dom,
    },
    addEventListener: on(winHandlers),
    starts: [],
    chrome: { runtime: { id: 'self', onMessage: { addListener: fn => { env.onMessage = fn; } }, sendMessage: async m => {
      if (m.type === 'start') { env.starts.push(m.url); const a = core.start(1, m.url).then(r => structuredClone(r)); answers.push(a); return a; }
      return structuredClone(await core.report(1, m));
    } } },
    setInterval, setTimeout, clearTimeout, performance: perf, Date, URL, Response,
    fetch: pageFetch ?? (async () => { throw new Error('no page fetch in this test'); }),
  };
  const ctx = vm.createContext(env);
  vm.runInContext(src('dwell.js'), ctx);
  vm.runInContext(src('extract.js'), ctx);
  vm.runInContext(src('media.js'), ctx);
  vm.runInContext(src('bilibili.js'), ctx);
  vm.runInContext(src('xhs.js'), ctx);
  vm.runInContext(src('content.js'), ctx);
  // The background answers a start (real hashing, off-thread) before fake time moves on, so a visit is up
  // before the next step or event; the content script's continuation is microtasks, so one tick() after is enough.
  const started = async () => { await Promise.all(answers); await tick(); };
  const advance = async (ms, step = 100) => {
    for (let i = 0; i < ms / step; i++) { await started(); t.mock.timers.tick(step); await tick(); }
    await started();
  };
  // No event: the 1 s tick must notice the URL change.
  const spa = (href, title, text) => {
    env.location.href = href; env.document.title = title; env.document.body.innerText = text;
  };
  return { env, core, store, advance, spa, fireWin: (type, e) => fire(winHandlers, type, e), fireDoc: (type, e) => fire(docHandlers, type, e) };
}
const sent = () => globalThis.fetch.calls.map(c => c.body);

test('read, then SPA change: record keeps the pre-change text; new visit starts after quiet', async t => {
  const p = page(t, { url: 'https://app.example.com/a?token=zz#top' });
  await p.advance(12000);
  p.spa('https://app.example.com/b', 'Page B', 'text of B');
  await p.advance(3000);
  await until(() => sent().length === 1);
  const [a] = sent();
  assert.equal(a.kind, 'read');
  assert.equal(a.url, 'https://app.example.com/a');
  assert.equal(a.title, 'Page A');
  assert.equal(a.text, 'text of A');
  assert.equal(a.dwell_seconds, 13); // the change is seen at the next 1 s tick
  p.fireWin('pagehide', {});
  await until(() => sent().length === 2);
  assert.equal(sent().length, 2);
  assert.equal(sent()[1].url, 'https://app.example.com/b');
  assert.equal(sent()[1].kind, 'glance');
});

test('hash-only change is the same visit; the tick catches URL changes', async t => {
  const p = page(t, { url: 'https://e.com/a' });
  p.env.location.href = 'https://e.com/a#section';
  await p.advance(3000);
  assert.equal(sent().length, 0);
  p.env.location.href = 'https://e.com/c';
  await p.advance(3000);
  await until(() => sent().length === 1);
  assert.equal(sent().length, 1);
  assert.equal(sent()[0].kind, 'glance');
});

test('SPA into and out of a skipped prefix', async t => {
  const p = page(t, { url: 'https://x.feishu.cn/docx/1', settings: { skipOn: ['chat'] } });
  await p.advance(2000);
  p.spa('https://x.feishu.cn/next/messenger/chat/9', 'Chat', 'secret chat');
  await p.advance(20000);
  p.spa('https://x.feishu.cn/wiki/2', 'Wiki', 'wiki text');
  await p.advance(15000);
  p.fireWin('pagehide', {});
  await until(() => sent().length === 2);
  assert.deepEqual(sent().map(r => [r.url, r.kind]), [
    ['https://x.feishu.cn/docx/1', 'glance'],
    ['https://x.feishu.cn/wiki/2', 'read'],
  ]);
  assert.ok(!JSON.stringify(sent()).includes('secret chat'));
});

// ---- adult pages (Google SafeSearch's two meta labels) ----
const metaDom = metas => ({ querySelectorAll: sel => doc(...metas.map(a => h('meta', a))).querySelectorAll(sel) });

test('adult label: no start, so nothing is recorded', async t => {
  for (const meta of [{ name: 'rating', content: 'adult' }, { name: 'rating', content: 'RTA-5042-1996-1400-1577-RTA' },
    { name: 'RATING', content: 'Adult' }, { name: 'rating', content: '  rta-5042-1996-1400-1577-rta ' }]) {
    const p = page(t, { url: 'https://x.example.com/v/1', dom: metaDom([{ charset: 'utf-8' }, meta]) });
    await p.advance(15000);
    p.fireWin('pagehide', {});
    await p.advance(1000);
    assert.deepEqual(p.env.starts, [], JSON.stringify(meta));
    assert.equal(sent().length, 0);
    assert.ok(!Object.keys(p.store.data).some(k => k.startsWith('v:')));
    t.mock.timers.reset();
  }
});

test('rating "general" or no tag: starts normally', async t => {
  for (const metas of [[{ name: 'rating', content: 'general' }], [{ name: 'description', content: 'adult' }]]) {
    const p = page(t, { url: 'https://x.example.com/a', dom: metaDom(metas) });
    await p.advance(2000);
    assert.deepEqual(p.env.starts, ['https://x.example.com/a']);
    t.mock.timers.reset();
  }
});

// Chrome can prerender the likely next page in the owner's tab: no visit (and no draft) until it is shown.
test('prerendered page: silent until activation, then starts once', async t => {
  const p = page(t, { url: 'https://x.example.com/next', dom: { prerendering: true } });
  await p.advance(5000);
  assert.deepEqual(p.env.starts, []);
  let got; p.env.onMessage({ type: 'state' }, {}, r => { got = r; });
  assert.equal(got, undefined); // the popup's state query is not answered
  p.env.document.prerendering = false;
  p.fireDoc('prerenderingchange', {});
  await p.advance(5000);
  assert.deepEqual(p.env.starts, ['https://x.example.com/next']);
});

test('SPA change to a page that now has the adult label: no new visit', async t => {
  const metas = [];
  const p = page(t, { url: 'https://x.example.com/a', dom: metaDom(metas) });
  p.env.document.querySelectorAll = sel => metaDom(metas).querySelectorAll(sel);
  await p.advance(12000);
  metas.push({ name: 'rating', content: 'adult' });
  p.spa('https://x.example.com/b', 'B', 'adult text');
  await p.advance(15000);
  p.fireWin('pagehide', {});
  await until(() => sent().length === 1);
  assert.deepEqual(p.env.starts, ['https://x.example.com/a']);
  assert.deepEqual(sent().map(r => r.url), ['https://x.example.com/a']);
  assert.ok(!JSON.stringify(sent()).includes('adult text'));
});

test('background tab never focused: no record when closed', async t => {
  const p = page(t, { url: 'https://e.com/bg', focused: false });
  await p.advance(60000);
  await p.core.tabRemoved(1);
  assert.equal(sent().length, 0);
});

test('only focused time counts; tab close after threshold still delivers', async t => {
  const p = page(t, { url: 'https://e.com/r' });
  await p.advance(6000);
  p.env.focused = false;
  await p.advance(30000);
  p.env.focused = true;
  await p.advance(6000);
  // tab closed: visibilitychange(hidden) fires, then the SW sees onRemoved
  p.env.document.visibilityState = 'hidden'; p.fireDoc('visibilitychange');
  await p.advance(1000);
  await p.core.tabRemoved(1);
  await until(() => sent().length === 1);
  assert.equal(sent().length, 1);
  assert.equal(sent()[0].kind, 'read');
  assert.equal(sent()[0].dwell_seconds, 12);
});

test('chat page: the record holds the extracted turns, not the whole body', async t => {
  const d = doc(h('nav', {}, 'Other chat title'), h('div', { 'data-message-author-role': 'user' }, 'Hi'),
    h('div', { 'data-message-author-role': 'assistant' }, 'Hello!'));
  const p = page(t, { url: 'https://chatgpt.com/c/abc', dom: { querySelectorAll: d.querySelectorAll, body: { innerText: 'Other chat title Hi Hello!' } } });
  await p.advance(12000);
  p.fireWin('pagehide', {});
  await until(() => sent().length === 1);
  assert.equal(sent()[0].text, 'User:\nHi\n\nChatGPT:\nHello!');
});

test('chat page without turns falls back to body text', async t => {
  const p = page(t, { url: 'https://chatgpt.com/c/abc', dom: { querySelectorAll: () => [], body: { innerText: 'loading text' } } });
  await p.advance(12000);
  p.fireWin('pagehide', {});
  await until(() => sent().length === 1);
  assert.equal(sent()[0].text, 'loading text');
});

test('content script sends a margin past 100000 chars, so a key at the cut is redacted whole', async t => {
  const GHP = 'ghp_' + 'aB3dE5fG7h'.repeat(4).slice(0, 36);
  const p = page(t, { url: 'https://e.com/long', dom: { body: { innerText: 'x'.repeat(99990) + ' ' + GHP + ' tail' } } });
  await p.advance(12000);
  p.fireWin('pagehide', {});
  await until(() => sent().length === 1);
  const { text } = sent()[0];
  assert.equal(text.length, 100000);
  assert.ok(!text.includes('ghp_'), text.slice(99980));
});

// The popup asks the page for its live state; the stored draft can be 15 s old.
const ask = p => { let got; p.env.onMessage({ type: 'state' }, {}, r => { got = r; }); return got; };

test('state query: a captured page reports live dwell and the threshold', async t => {
  const p = page(t, { url: 'https://e.com/live#x' });
  await p.advance(3000);
  const a = ask(p);
  await p.advance(2000);
  const b = ask(p);
  assert.equal(a.url, 'https://e.com/live');
  assert.equal(a.title, 'Page A');
  assert.equal(a.capturing, true);
  assert.equal(a.thresholdMs, 10000);
  assert.ok(b.dwellMs - a.dwellMs >= 1900, `${a.dwellMs} -> ${b.dwellMs}`);
});

// Opening the popup takes focus from the page; its once-a-second asks keep the page counting.
test('state query: while the popup asks every second, an unfocused visible page keeps counting', async t => {
  const p = page(t, { url: 'https://e.com/pop' });
  await p.advance(2000);
  p.env.focused = false; // popup opened: visible, but the page lost focus
  const a = ask(p);
  for (let i = 0; i < 5; i++) await p.advance(1000);
  const b = ask(p); // the popup asked only at a and b; between them a gap of 5 s
  assert.ok(b.dwellMs - a.dwellMs <= 2600, `no asks for 5 s: ${a.dwellMs} -> ${b.dwellMs}`);
  let last = b;
  for (let i = 0; i < 6; i++) { await p.advance(1000); last = ask(p); }
  assert.ok(last.dwellMs - b.dwellMs >= 5900 && last.dwellMs - b.dwellMs <= 6100, `asked each second: ${b.dwellMs} -> ${last.dwellMs}`);
  await p.advance(5000); // popup closed, page still unfocused
  const c = ask(p);
  assert.ok(c.dwellMs - last.dwellMs <= 2600, `popup closed: ${last.dwellMs} -> ${c.dwellMs}`);
});

test('state query: a skipped page is not capturing', async t => {
  const p = page(t, { url: 'https://x.feishu.cn/next/messenger/chat/9', settings: { skipOn: ['chat'] } });
  await p.advance(3000);
  assert.deepEqual({ ...ask(p) }, { url: 'https://x.feishu.cn/next/messenger/chat/9', title: 'Page A', capturing: false, dwellMs: 0, thresholdMs: null });
});

// ---- media ----
// A media element starts playing: its event reaches the document listener (capture phase in the browser).
const playing = (p, over) => { const el = fakeMedia(over); p.fireDoc('play', { target: el }); return el; };

test('audible playback in a background tab: not swept in 40 min, then a read record with media and text', async t => {
  const p = page(t, { url: 'https://pod.example.com/ep/1', focused: false });
  await p.advance(2000);
  const el = playing(p, { tagName: 'AUDIO', currentSrc: 'https://cdn.example.com/ep1.mp3?token=zz', duration: 3600 });
  for (let m = 0; m < 40; m++) {
    el.ranges = [[0, (m + 1) * 60]];
    await p.advance(60000, 1000);
    if (m % 5 === 4) await p.core.alarm('sweep');
  }
  assert.equal(sent().length, 0, 'the sweep left the visit open');
  await p.core.tabRemoved(1);
  await until(() => sent().length === 1);
  const [r] = sent();
  assert.equal(r.kind, 'read');
  assert.equal(r.dwell_seconds, 0);
  assert.equal(r.text, 'text of A');
  assert.equal(r.media.length, 1);
  const [e] = r.media;
  assert.equal(e.kind, 'audio');
  assert.equal(e.src, 'https://cdn.example.com/ep1.mp3');
  assert.equal(e.duration_s, 3600);
  assert.ok(e.play_s >= 2370 && e.background_s >= 2370 && e.background_s <= e.play_s, JSON.stringify(e));
  assert.ok(Date.parse(r.last_seen) > Date.parse(r.first_seen));
});

test('muted autoplay in a background tab: no record, no media stored', async t => {
  const p = page(t, { url: 'https://e.com/autoplay', focused: false });
  await p.advance(2000);
  playing(p, { muted: true });
  await p.advance(600000, 1000);
  assert.ok(!JSON.stringify(p.store.data).includes('cdn.e.com'));
  await p.core.tabRemoved(1);
  assert.equal(sent().length, 0);
});

test('watching on an active page adds media to the dwell record', async t => {
  const p = page(t, { url: 'https://www.youtube.com/watch?v=abc' });
  await p.advance(1000);
  const el = playing(p, { currentSrc: 'blob:https://www.youtube.com/1' });
  el.ranges = [[0, 20]];
  await p.advance(20000);
  p.fireWin('pagehide', {});
  await until(() => sent().length === 1);
  const [r] = sent();
  assert.equal(r.kind, 'read');
  assert.equal(r.media.length, 1);
  assert.equal('src' in r.media[0], false);
  assert.deepEqual(r.media[0].played, [[0, 20]]);
  assert.ok(Math.abs(r.media[0].play_s - 20) <= 1, r.media[0].play_s);
});

test('record playback off: nothing about media is tracked or sent', async t => {
  const p = page(t, { url: 'https://e.com/v', settings: { recordPlayback: false } });
  await p.advance(1000);
  playing(p);
  await p.advance(20000);
  p.fireWin('pagehide', {});
  await until(() => sent().length === 1);
  assert.equal('media' in sent()[0], false);
  assert.ok(!JSON.stringify(p.store.data).includes('cdn.e.com'));
});

// ---- Bilibili subtitles ----
// Answers the three calls of the recipe; counts every call.
function biliFetch(sub = { body: [{ from: 1, to: 2, content: 'hi' }] }) {
  const f = async (url, init) => {
    f.calls.push({ url, init });
    const body = url.includes('/view?') ? { code: 0, data: { cid: 7, pages: [{ cid: 7 }, { cid: 8 }] } }
      : url.includes('/wbi/v2?') ? { code: 0, data: { subtitle: { subtitles: [{ lan: 'ai-zh', subtitle_url: '//aisubtitle.hdslb.com/s.json' }] } } }
      : sub;
    if (body === 'network') throw new TypeError('Failed to fetch');
    return new Response(JSON.stringify(body));
  };
  f.calls = [];
  return f;
}
const BV = 'https://www.bilibili.com/video/BV1xx411c7mD';
// By URL: the previous test's record can still land in this test's webhook.
const recOf = url => sent().find(r => r.url === url);

test('Bilibili: subtitles fetched once, from 50 s of counted playback, and sent with the record', async t => {
  const f = biliFetch();
  const p = page(t, { url: BV, pageFetch: f });
  await p.advance(1000);
  playing(p, { currentSrc: 'blob:https://www.bilibili.com/1' });
  await p.advance(45000);
  assert.equal(f.calls.length, 0, 'not before 50 s of playback');
  await p.advance(10000);
  await p.advance(8000);
  assert.equal(f.calls.length, 3);
  assert.equal(f.calls[1].url, 'https://api.bilibili.com/x/player/wbi/v2?bvid=BV1xx411c7mD&cid=7');
  await p.advance(120000);
  assert.equal(f.calls.length, 3, 'once per visit');
  p.fireWin('pagehide', {});
  await until(() => recOf(BV));
  const r = recOf(BV);
  assert.equal(r.subtitle_status, 'ok');
  assert.deepEqual(r.subtitles, [{ source: 'bilibili', lang: 'ai-zh', auto: true, lines: [[1, 2, 'hi']] }]);
  assert.equal('subtitle_error' in r, false);
});

test('Bilibili: a new visit (SPA to ?p=2) fetches again, for that part', async t => {
  const f = biliFetch();
  const p = page(t, { url: BV, pageFetch: f });
  await p.advance(1000);
  const el = playing(p, { currentSrc: 'blob:https://www.bilibili.com/1' });
  await p.advance(65000);
  assert.equal(f.calls.length, 3);
  p.spa(BV + '?p=2', 'P2', 'part 2');
  await p.advance(4000); // the new visit is up before the element is seen again (in a browser, timeupdate keeps coming)
  p.fireDoc('play', { target: el });
  await p.advance(65000);
  assert.equal(f.calls.length, 6);
  assert.equal(f.calls[4].url, 'https://api.bilibili.com/x/player/wbi/v2?bvid=BV1xx411c7mD&cid=8');
});

test('Bilibili: a failed request gives status error and the visit goes on', async t => {
  const f = biliFetch('network');
  const p = page(t, { url: BV, pageFetch: f });
  await p.advance(1000);
  playing(p, { currentSrc: 'blob:https://www.bilibili.com/1' });
  await p.advance(90000);
  p.fireWin('pagehide', {});
  await until(() => recOf(BV));
  const r = recOf(BV);
  assert.equal(r.kind, 'read');
  assert.equal(r.subtitle_status, 'error');
  assert.equal(r.subtitle_error, 'subtitle network error');
  assert.equal('subtitles' in r, false);
  assert.equal(r.media.length, 1);
});

// The subtitles switch covers every site: off, each record says so and the page fetches nothing.
for (const url of [BV, 'https://www.youtube.com/watch?v=abc']) {
  test(`subtitles switch off: no subtitle request, record says subtitle_status off: ${url}`, async t => {
    const f = biliFetch();
    const p = page(t, { url, settings: { bilibiliSubs: false }, pageFetch: f });
    await p.advance(1000);
    playing(p, { currentSrc: 'blob:https://www.bilibili.com/1' });
    await p.advance(90000);
    p.fireWin('pagehide', {});
    await until(() => recOf(url));
    assert.equal(f.calls.length, 0);
    assert.equal(recOf(url).subtitle_status, 'off');
    assert.ok(!('subtitles' in recOf(url)) && !('subtitle_error' in recOf(url)));
  });
}

for (const [name, url, settings] of [
  ['record playback off', BV, { recordPlayback: false }],
  ['a Bilibili page that is not a video', 'https://www.bilibili.com/bangumi/play/ep1', {}],
  ['another site with a /video/BV path', 'https://e.com/video/BV1xx411c7mD', {}],
]) {
  test(`Bilibili: no subtitle request and no subtitle fields: ${name}`, async t => {
    const f = biliFetch();
    const p = page(t, { url, settings, pageFetch: f });
    await p.advance(1000);
    playing(p, { currentSrc: 'blob:https://www.bilibili.com/1' });
    await p.advance(90000);
    p.fireWin('pagehide', {});
    await until(() => recOf(url));
    assert.equal(f.calls.length, 0);
    assert.ok(!Object.keys(recOf(url)).some(k => k.startsWith('subtitle')), JSON.stringify(Object.keys(recOf(url))));
  });
}

// ---- Bilibili video pages: the player (danmaku, controls, subtitle overlay) is not page text ----
const biliDom = () => doc(
  h('div', { id: 'app' },
    h('div', { id: 'bilibili-player' },
      h('div', { class: 'bpx-player-container' },
        h('div', { class: 'bpx-player-render-dm-wrap' }, h('div', { class: 'bpx-player-row-dm-wrap' },
          h('div', { class: 'bili-danmaku-x-dm' }, 'DANMAKU one'), h('div', { class: 'bili-danmaku-x-dm' }, 'DANMAKU two'))),
        h('div', { class: 'bpx-player-control-wrap' }, h('span', {}, 'CONTROL 1080P'), h('button', {}, 'CONTROL speed')))),
    h('div', { class: 'video-info-container' }, h('h1', {}, 'The video title')),
    h('div', { class: 'basic-desc-info' }, 'The description'),
    h('div', { class: 'reply-list' }, 'A comment below'),
    h('script', {}, 'window.SCRIPT_SOURCE = 1')));

for (const [url, player] of [[BV, false], ['https://e.com/video/BV1xx411c7mD', true]]) {
  test(`page text ${player ? 'keeps' : 'skips'} the Bilibili player: ${url}`, async t => {
    const d = biliDom();
    const p = page(t, { url, settings: { bilibiliSubs: false }, dom: { querySelectorAll: d.querySelectorAll, querySelector: d.querySelector, body: d.body } });
    await p.advance(12000);
    p.fireWin('pagehide', {});
    await until(() => recOf(url));
    const { text } = recOf(url);
    for (const s of ['The video title', 'The description', 'A comment below']) assert.ok(text.includes(s), s + ' in ' + JSON.stringify(text));
    for (const s of ['DANMAKU one', 'DANMAKU two', 'CONTROL 1080P', 'CONTROL speed']) assert.equal(text.includes(s), player, s + ' in ' + JSON.stringify(text));
    if (!player) assert.ok(!text.includes('SCRIPT_SOURCE'), text); // the browser's body.innerText has no script source either
  });
}

// 边读边发: the threshold and each active → inactive edge send a version to Hindsight; Neurosea gets one record, at the end.
test('threshold and switch-away publish to Hindsight; Neurosea gets one record when the visit ends', async t => {
  const p = page(t, { url: 'https://e.com/doc' });
  p.store.data['dest:hindsight'] = { enabled: true, url: 'http://127.0.0.1:9/hs', apiKey: 'k', bank: 'b', kinds: ['read', 'glance'] };
  const calls = [];
  globalThis.fetch = async (url, init) => { calls.push({ url, body: JSON.parse(init.body) }); return new Response('{"success":true}', { status: 200 }); };
  const rt = p.env.chrome.runtime, real = rt.sendMessage, pubs = [];
  rt.sendMessage = m => { if (m.publish) pubs.push(m.text); return real(m); };
  const hs = () => calls.filter(c => c.url.includes('/hs')), hook = () => calls.filter(c => c.url.includes('/hook'));
  await p.advance(11000);
  await until(() => hs().length === 1);
  assert.deepEqual(pubs, ['text of A'], 'threshold');
  p.env.document.body.innerText = 'more of A';
  p.env.focused = false; // switched to another program
  await p.advance(3000);
  await until(() => hs().length === 2);
  assert.deepEqual(pubs, ['text of A', 'more of A'], 'focus lost after the threshold');
  p.env.focused = true;
  await p.advance(3000);
  p.env.document.body.innerText = 'end of A';
  p.env.document.visibilityState = 'hidden'; p.fireDoc('visibilitychange'); // tab switch: one publish, not one more at the tick
  await p.advance(3000);
  await until(() => hs().length === 3);
  assert.deepEqual(pubs, ['text of A', 'more of A', 'end of A'], 'tab hidden');
  assert.equal(hook().length, 0, 'Neurosea waits for the end');
  p.fireWin('pagehide', {});
  await until(() => hook().length === 1);
  assert.equal(hook().length, 1);
  assert.equal(hook()[0].body.text, 'end of A');
  assert.equal(hs().length, 3, 'unchanged final version: no fourth write');
});

// ---- presence: reading time counts only with input in the last 5 minutes ----
const MIN = 60000;
const input = p => p.fireWin('pointermove', { isTrusted: true });
// No ticks while the computer sleeps: the clock jumps, the timers have not run.
const sleep = (t, ms) => t.mock.timers.setTime(Date.now() + ms);

test('presence: no input for 5 min stops the clock at the last input + 5 min; input resumes from that moment', async t => {
  const p = page(t, { url: 'https://e.com/idle' });
  await p.advance(7 * MIN, 1000); // the script's start is the last input
  const a = ask(p);
  assert.ok(Math.abs(a.dwellMs - 5 * MIN) <= 1500, `idle after 5 min: ${a.dwellMs}`);
  input(p);
  await p.advance(10000, 1000);
  const b = ask(p);
  assert.ok(Math.abs(b.dwellMs - a.dwellMs - 10000) <= 1500, `resumed at the input: ${a.dwellMs} -> ${b.dwellMs}`);
});

test('presence: a 30-min sleep ended by an input adds at most 5 min past the last input before it', async t => {
  const p = page(t, { url: 'https://e.com/sleep' });
  await p.advance(MIN, 1000);
  input(p);
  await p.advance(1000, 1000);
  sleep(t, 30 * MIN);
  input(p); // wakes the machine, before the next tick
  await p.advance(1000, 1000);
  const a = ask(p);
  assert.ok(a.dwellMs <= 6 * MIN + 2000 && a.dwellMs >= 6 * MIN - 1500, `sleep: ${a.dwellMs}`);
});

test('presence: a URL change seen by the first tick after a sleep stops the old visit at the last input + 5 min', async t => {
  const p = page(t, { url: 'https://app.e.com/a' });
  await p.advance(MIN, 1000);
  input(p);
  await p.advance(1000, 1000);
  sleep(t, 30 * MIN);
  p.spa('https://app.e.com/b', 'Page B', 'text of B');
  await p.advance(1000, 1000);
  await until(() => sent().length === 1);
  const [r] = sent();
  assert.equal(r.url, 'https://app.e.com/a');
  assert.ok(r.dwell_seconds >= 359 && r.dwell_seconds <= 362, `dwell ${r.dwell_seconds}`);
  assert.ok(Date.parse(r.last_seen) - Date.parse(r.first_seen) <= 6 * MIN + 2000, `${r.first_seen} .. ${r.last_seen}`);
});

test('presence: the popup asking every second is not input', async t => {
  const p = page(t, { url: 'https://e.com/pop-idle' });
  p.env.focused = false; // popup open: visible, page not focused
  let last;
  for (let i = 0; i < 7 * 60; i++) { last = ask(p); await p.advance(1000, 1000); }
  last = ask(p);
  assert.ok(Math.abs(last.dwellMs - 5 * MIN) <= 1500, `popup asks only: ${last.dwellMs}`);
});

test('presence: audible playback is not input; play time keeps growing', async t => {
  const p = page(t, { url: 'https://e.com/watch' });
  await p.advance(1000, 1000);
  const el = playing(p, { currentSrc: 'https://cdn.e.com/v.mp4' });
  for (let m = 0; m < 7; m++) { el.ranges = [[0, (m + 1) * 60]]; await p.advance(MIN, 1000); }
  p.fireWin('pagehide', {});
  await until(() => sent().length === 1);
  const [r] = sent();
  assert.ok(r.dwell_seconds >= 299 && r.dwell_seconds <= 301, `dwell ${r.dwell_seconds}`);
  assert.ok(r.media[0].play_s >= 418, `play_s ${r.media[0].play_s}`);
});

test('presence: idle neither publishes nor ends the visit; the 15 s reports go on with the stopped dwell', async t => {
  const p = page(t, { url: 'https://e.com/doc-idle' });
  p.store.data['dest:hindsight'] = { enabled: true, url: 'http://127.0.0.1:9/hs', apiKey: 'k', bank: 'b', kinds: ['read', 'glance'] };
  globalThis.fetch = fakeFetch(Array(50).fill({ status: 200, body: { success: true } }));
  const rt = p.env.chrome.runtime, real = rt.sendMessage, reports = [];
  rt.sendMessage = m => { if (m.type === 'report') reports.push({ t: Date.now(), ...m }); return real(m); };
  await p.advance(35 * MIN, 1000);
  await p.core.alarm('sweep');
  assert.equal(reports.filter(m => m.publish).length, 1, 'only the threshold published');
  assert.equal(reports.filter(m => m.end).length, 0, 'not ended');
  const late = reports.filter(m => m.t > Date.UTC(2026, 10, 5, 9) + 6 * MIN);
  assert.ok(late.length >= 100, `reports while idle: ${late.length}`);
  for (const m of late) assert.ok(Math.abs(m.dwellMs - 5 * MIN) <= 1500, `dwell in an idle report: ${m.dwellMs}`);
  assert.ok(Object.keys(p.store.data).some(k => k.startsWith('v:')), 'the sweep left the draft');
  assert.ok(!globalThis.fetch.calls.some(c => c.url.includes('/hook')), 'Neurosea got nothing yet');
});

test('presence: the page becoming visible again counts as input', async t => {
  const p = page(t, { url: 'https://e.com/vis' });
  await p.advance(4 * MIN, 1000);
  p.env.document.visibilityState = 'hidden'; p.fireDoc('visibilitychange');
  await p.advance(10 * MIN, 1000);
  p.env.document.visibilityState = 'visible'; p.fireDoc('visibilitychange');
  await p.advance(7 * MIN, 1000);
  const a = ask(p);
  assert.ok(Math.abs(a.dwellMs - 9 * MIN) <= 2000, `4 min + 5 min after showing: ${a.dwellMs}`);
});

test('presence: the window gaining focus counts as input', async t => {
  const p = page(t, { url: 'https://e.com/foc' });
  await p.advance(4 * MIN, 1000);
  p.env.focused = false;
  await p.advance(10 * MIN, 1000);
  p.env.focused = true; p.fireWin('focus', {});
  await p.advance(7 * MIN, 1000);
  const a = ask(p);
  assert.ok(Math.abs(a.dwellMs - 9 * MIN) <= 2000, `4 min + 5 min after focus: ${a.dwellMs}`);
});

test('presence: a page restored from the back/forward cache counts from the restore', async t => {
  const p = page(t, { url: 'https://e.com/bf' });
  await p.advance(2000, 1000);
  p.fireWin('pagehide', { persisted: true });
  sleep(t, 10 * MIN); // in the cache: the heap is kept, no timers run
  p.fireWin('pageshow', { persisted: true });
  await p.advance(MIN, 1000);
  const a = ask(p);
  assert.ok(Math.abs(a.dwellMs - MIN) <= 1500, `restored 1 min ago: ${a.dwellMs}`);
});

test('presence: a page prerendered long before activation counts from the activation', async t => {
  const p = page(t, { url: 'https://e.com/pre', dom: { prerendering: true } });
  await p.advance(7 * MIN, 1000);
  p.env.document.prerendering = false;
  p.fireDoc('prerenderingchange', {});
  await p.advance(MIN, 1000);
  const a = ask(p);
  assert.ok(Math.abs(a.dwellMs - MIN) <= 1500, `activated 1 min ago: ${a.dwellMs}`);
});

// Nothing new is taken from the page while idle, so a delete window over the idle stretch cannot miss text in the record.
const logReports = p => {
  const rt = p.env.chrome.runtime, real = rt.sendMessage, reports = [];
  rt.sendMessage = m => { if (m.type === 'report') reports.push({ t: Date.now(), ...m }); return real(m); };
  return reports;
};
const T0 = Date.UTC(2026, 10, 5, 9);

test('presence: reports while idle carry no title, lang or text; the record keeps the snapshot taken while present', async t => {
  const p = page(t, { url: 'https://chat.e.com/c/1' });
  const reports = logReports(p);
  await p.advance(6 * MIN, 1000);
  p.env.document.title = 'Late'; p.env.document.body.innerText = 'late messages';
  await p.advance(2 * MIN, 1000);
  p.env.document.visibilityState = 'hidden'; p.fireDoc('visibilitychange');
  const idle = reports.filter(m => m.t >= T0 + 5 * MIN);
  assert.ok(idle.length >= 8, `reports while idle: ${idle.length}`);
  for (const m of idle) assert.deepEqual([m.title, m.lang, m.text], [undefined, undefined, undefined], `idle report at ${m.t - T0}`);
  p.fireWin('pagehide', {});
  await until(() => sent().length === 1);
  const [r] = sent();
  assert.equal(r.title, 'Page A');
  assert.equal(r.text, 'text of A');
  assert.ok(Date.parse(r.last_seen) <= T0 + 5 * MIN + 1000, `last_seen ${r.last_seen}`);
});

test('presence: after an input, reports carry the page again', async t => {
  const p = page(t, { url: 'https://chat.e.com/c/2' });
  const reports = logReports(p);
  await p.advance(6 * MIN, 1000);
  p.env.document.title = 'Late'; p.env.document.body.innerText = 'late messages';
  input(p);
  const at = Date.now();
  await p.advance(20000, 1000);
  const back = reports.filter(m => m.t >= at);
  assert.ok(back.length >= 1, 'a report after the input');
  for (const m of back) assert.deepEqual([m.title, m.text], ['Late', 'late messages']);
});

test('presence: an untrusted (synthetic) input does not keep the owner present', async t => {
  const p = page(t, { url: 'https://e.com/fake' });
  await p.advance(4 * MIN, 1000);
  for (const type of ['pointermove', 'pointerdown', 'keydown', 'wheel', 'touchstart']) p.fireWin(type, { isTrusted: false });
  await p.advance(3 * MIN, 1000);
  const a = ask(p);
  assert.ok(Math.abs(a.dwellMs - 5 * MIN) <= 1500, `synthetic input: ${a.dwellMs}`);
});

test('presence: a visit started while idle with media playing still carries title and lang, and text once read by play time', async t => {
  const p = page(t, { url: 'https://v.e.com/1' });
  const reports = logReports(p);
  await p.advance(6 * MIN, 1000);
  p.spa('https://v.e.com/2', 'Next', 'next page'); // autoplay of the next item, hands-off
  await p.advance(2000, 1000);
  const el = playing(p, { currentSrc: 'https://cdn.e.com/2.mp4' });
  const at = Date.now();
  for (let s = 0; s < 90; s += 10) { el.ranges = [[0, s + 10]]; await p.advance(10000, 1000); }
  const mine = reports.filter(m => m.url === 'https://v.e.com/2' && m.t >= at);
  assert.ok(mine.length >= 3, `reports: ${mine.length}`);
  for (const m of mine) assert.deepEqual([m.title, m.lang], ['Next', 'en'], `report at ${m.t - at}`);
  const pub = mine.find(m => m.publish);
  assert.ok(pub, 'the 60 s play threshold published');
  assert.equal(pub.text, 'next page');
});

test('presence: the threshold first crossed at the first tick after a sleep, with no input after waking, publishes with title and text', async t => {
  const p = page(t, { url: 'https://e.com/lid' });
  const reports = logReports(p);
  await p.advance(5000, 1000);
  sleep(t, 30 * MIN); // the page stays visible across the sleep
  await p.advance(1000, 1000);
  const pub = reports.find(m => m.publish);
  assert.ok(pub, 'the crossing published');
  assert.deepEqual([pub.title, pub.text], ['Page A', 'text of A']);
});

// ---- the sound's address (audio contract): Bilibili without subtitles, Xiaohongshu notes; once, after 60 s ----
const SIGNED = 'https://upos-sz.bilivideo.com/x/30216.m4s?deadline=1893456000&token=abc&upsig=a%2Fb';
// Like biliFetch, plus playurl; subs: the wbi/v2 subtitle list.
// playurl: optional (n-th playurl call) -> base URL, or a number (HTTP status).
function audioFetch(subs = [], playurl = () => SIGNED) {
  const f = async url => {
    f.calls.push(url);
    const pu = url.includes('/wbi/playurl?') && playurl(f.calls.filter(u => u.includes('/wbi/playurl?')).length);
    if (typeof pu === 'number') return new Response('{}', { status: pu });
    const body = url.includes('/view?') ? { code: 0, data: { cid: 7 } }
      : url.includes('/wbi/v2?') ? { code: 0, data: { subtitle: { subtitles: subs } } }
      : pu ? { code: 0, data: { dash: { audio: [{ id: 30216, bandwidth: 66000, baseUrl: pu }] } } }
      : { body: [{ from: 1, to: 2, content: 'hi' }] };
    return new Response(JSON.stringify(body));
  };
  f.calls = [];
  return f;
}
const playurls = f => f.calls.filter(u => u.includes('/wbi/playurl?'));

test('Bilibili without subtitles: the audio address is looked up once, from 50 s, and sent with the record', async t => {
  const f = audioFetch();
  const p = page(t, { url: BV, pageFetch: f });
  await p.advance(1000);
  playing(p, { currentSrc: 'blob:https://www.bilibili.com/1' });
  await p.advance(45000);
  assert.equal(f.calls.length, 0, 'not before 50 s of playback');
  await p.advance(10000);
  await p.advance(8000);
  assert.deepEqual(playurls(f), ['https://api.bilibili.com/x/player/wbi/playurl?bvid=BV1xx411c7mD&cid=7&fnval=16']);
  await p.advance(120000);
  assert.equal(f.calls.length, 4, 'once per visit');
  p.fireWin('pagehide', {});
  await until(() => recOf(BV));
  const r = recOf(BV);
  assert.equal(r.subtitle_status, 'none');
  assert.deepEqual(r.audio, { source: 'bilibili', urls: [SIGNED], expires: 1893456000 });
});

test('Bilibili with subtitles: no audio lookup and no audio fields', async t => {
  const f = audioFetch([{ lan: 'ai-zh', subtitle_url: '//aisubtitle.hdslb.com/s.json' }]);
  const p = page(t, { url: BV, pageFetch: f });
  await p.advance(1000);
  playing(p, { currentSrc: 'blob:https://www.bilibili.com/1' });
  await p.advance(90000);
  p.fireWin('pagehide', {});
  await until(() => recOf(BV));
  assert.equal(recOf(BV).subtitle_status, 'ok');
  assert.equal(playurls(f).length, 0);
  assert.ok(!Object.keys(recOf(BV)).some(k => k.startsWith('audio')));
});

const NOTE = 'https://www.rednote.com/discovery/item/6a52522e0000000011015940';
const XV = 'https://sns-video-hw.xhscdn.com/stream/1/110/259/01e6_259.mp4?sign=ab%2Fcd&t=1';
const fakePerf = (entries = [{ name: XV, startTime: 5, initiatorType: 'fetch' }]) => {
  const perf = { n: 0, now: () => performance.now(), getEntriesByType: type => { perf.n++; return type === 'resource' ? entries : []; } };
  return perf;
};

test('Xiaohongshu note: the video file address is taken once, after 60 s, and sent with the record', async t => {
  const perf = fakePerf();
  const p = page(t, { url: NOTE, perf });
  await p.advance(1000);
  playing(p, { currentSrc: 'blob:https://www.rednote.com/1' });
  await p.advance(55000);
  assert.equal(perf.n, 0, 'not before 60 s of playback');
  await p.advance(8000);
  assert.equal(perf.n, 1);
  await p.advance(120000);
  assert.equal(perf.n, 1, 'once per visit');
  p.fireWin('pagehide', {});
  await until(() => recOf(NOTE));
  assert.deepEqual(recOf(NOTE).audio, { source: 'xiaohongshu', urls: [XV], expires: null });
});

test('Xiaohongshu note without a video file: audio_error', async t => {
  const p = page(t, { url: NOTE, perf: fakePerf([]) });
  await p.advance(1000);
  playing(p, { currentSrc: 'blob:https://www.rednote.com/1' });
  await p.advance(70000);
  p.fireWin('pagehide', {});
  await until(() => recOf(NOTE));
  assert.equal(recOf(NOTE).audio_error, 'xhs no video url');
  assert.equal('audio' in recOf(NOTE), false);
});

for (const [name, url, opts] of [
  ['Bilibili, Subtitles off', BV, { settings: { bilibiliSubs: false } }],
  ['Xiaohongshu, Subtitles off', NOTE, { settings: { bilibiliSubs: false } }],
  ['Bilibili, no Neurosea', BV, { hook: false }],
  ['Xiaohongshu, no Neurosea', NOTE, { hook: false }],
  ['Xiaohongshu page that is not a note', 'https://www.rednote.com/explore', {}],
]) {
  test(`no audio lookup and no audio fields: ${name}`, async t => {
    const f = audioFetch(), perf = fakePerf();
    const p = page(t, { url, pageFetch: f, perf, ...opts });
    await p.advance(1000);
    playing(p, { currentSrc: 'blob:https://x/1' });
    await p.advance(90000);
    assert.equal(playurls(f).length + perf.n, 0);
    assert.ok(!Object.values(p.store.data).some(d => d && typeof d === 'object' && ('audio' in d || 'audio_error' in d)));
    p.fireWin('pagehide', {});
    if (opts.hook === false) return;
    await until(() => recOf(url));
    assert.ok(!Object.keys(recOf(url)).some(k => k.startsWith('audio')));
  });
}

// The address dies at its deadline (about 2 h); Neurosea only gets the visit's final version.
const expiring = n => `https://upos-sz.bilivideo.com/x/30216.m4s?deadline=${Math.floor(Date.now() / 1000) + 7200}&n=${n}`;
const deadlineOf = u => Number(new URL(u).searchParams.get('deadline'));

test('Bilibili: the address is looked up again once when its deadline is under 30 min away; later reports carry the new one', async t => {
  const f = audioFetch([], expiring);
  const p = page(t, { url: BV, pageFetch: f });
  await p.advance(1000);
  playing(p, { currentSrc: 'blob:https://www.bilibili.com/1' });
  await p.advance(65000);
  assert.equal(playurls(f).length, 1);
  const firstAt = Date.now();
  await p.advance(5300 * 1000 - 65000, 1000); // ~88 min after the lookup: over 30 min left
  assert.equal(playurls(f).length, 1, 'not while over 30 min is left');
  await p.advance(200 * 1000, 1000);
  assert.equal(playurls(f).length, 2, 'refreshed with under 30 min left');
  await p.advance(600 * 1000, 1000);
  assert.equal(playurls(f).length, 2, 'once per expiry');
  p.fireWin('pagehide', {});
  await until(() => recOf(BV));
  const a = recOf(BV).audio;
  assert.equal(a.urls.length, 1);
  assert.ok(a.urls[0].includes('&n=2'), 'the refreshed address');
  assert.ok(a.expires > Math.floor(firstAt / 1000) + 7200);
});

test('Bilibili: a failed refresh keeps the old address and is tried again 10 min later, not before', async t => {
  const f = audioFetch([], n => (n === 1 ? expiring(1) : 412));
  const p = page(t, { url: BV, pageFetch: f });
  await p.advance(1000);
  playing(p, { currentSrc: 'blob:https://www.bilibili.com/1' });
  await p.advance(65000);
  await p.advance(5480 * 1000 - 65000, 1000); // just past 30 min left: the first refresh, which fails
  assert.equal(playurls(f).length, 2);
  await p.advance(570 * 1000, 1000);
  assert.equal(playurls(f).length, 2, 'not before 10 min');
  await p.advance(40 * 1000, 1000);
  assert.equal(playurls(f).length, 3, 'tried again after 10 min');
  p.fireWin('pagehide', {});
  await until(() => recOf(BV));
  const r = recOf(BV);
  assert.ok(r.audio.urls[0].includes('&n=1'), 'the old address, still alive');
  assert.equal('audio_error' in r, false);
});

// A fast clock (or a short deadline) makes every fresh address look due: at most one lookup per 10 min.
test('Bilibili: addresses that always look due are looked up at most once per 10 min', async t => {
  const f = audioFetch([], n => `https://upos-sz.bilivideo.com/x/30216.m4s?deadline=${Math.floor(Date.now() / 1000) + 600}&n=${n}`);
  const p = page(t, { url: BV, pageFetch: f });
  await p.advance(1000);
  playing(p, { currentSrc: 'blob:https://www.bilibili.com/1' });
  await p.advance(65000);
  assert.equal(playurls(f).length, 1);
  await p.advance(3600 * 1000, 1000);
  const n = playurls(f).length;
  assert.ok(n >= 6 && n <= 7, `${n} lookups in an hour`);
});

test('Xiaohongshu (expires null) is never looked up again', async t => {
  const perf = fakePerf();
  const p = page(t, { url: NOTE, perf });
  await p.advance(1000);
  playing(p, { currentSrc: 'blob:https://www.rednote.com/1' });
  await p.advance(3 * 3600 * 1000, 1000);
  assert.equal(perf.n, 1);
});

// ---- Koala: the transcript preview (a Radix dialog, unmounted on close) stays in the record after it closes ----
const KOALA = 'https://app.koala-oss.club/videos/42';
const MARK = 'PREVIEW-MARK-7f3';
// Opens or closes the preview: like the browser, body.innerText has the dialog's text while it is open.
const preview = (p, open) => {
  const d = h('div', { role: 'dialog' }, h('pre', {}, `transcript ${MARK} line`));
  p.env.document.body.innerText = open ? 'video page\n' + d.innerText : 'video page after';
  p.env.document.querySelector = sel => (open && sel === '[role="dialog"]' ? d : null);
};
const count = (s, x) => s.split(x).length - 1;
const draftText = p => Object.entries(p.store.data).find(([k]) => k.startsWith('v:'))?.[1].text ?? '';

for (const [url, kept] of [[KOALA, true], ['https://e.com/videos/42', false]]) {
  test(`preview opened at a report, then closed: ${kept ? 'kept once' : 'not kept'}: ${url}`, async t => {
    const p = page(t, { url, dom: { querySelector: () => null, body: { innerText: 'video page' } } });
    await p.advance(12000);
    preview(p, true);
    await p.advance(16000); // a timed report while it is open
    preview(p, false);
    await p.advance(16000); // the next report
    await until(() => draftText(p).startsWith('video page after')); // the draft is written after hashing, off-thread
    assert.equal(count(draftText(p), MARK), kept ? 1 : 0, draftText(p));
    p.fireWin('pagehide', {});
    await until(() => recOf(url));
    assert.equal(count(recOf(url).text, MARK), kept ? 1 : 0, recOf(url).text);
  });
}

test('preview still open at the end: its text is in the record once, not twice', async t => {
  const p = page(t, { url: KOALA, dom: { querySelector: () => null, body: { innerText: 'video page' } } });
  await p.advance(12000);
  preview(p, true);
  await p.advance(16000);
  await until(() => draftText(p).includes(MARK));
  assert.equal(count(draftText(p), MARK), 1, draftText(p));
  p.fireWin('pagehide', {});
  await until(() => recOf(KOALA));
  assert.equal(count(recOf(KOALA).text, MARK), 1, recOf(KOALA).text);
});

test('preview opened at 3 s and closed at 8 s, before the threshold; left at 12 s: kept once', async t => {
  const url = 'https://app.koala-oss.club/videos/43';
  const p = page(t, { url, dom: { querySelector: () => null, body: { innerText: 'video page' } } });
  await p.advance(3000);
  preview(p, true);
  await p.advance(5000);
  preview(p, false);
  await p.advance(4000);
  p.fireWin('pagehide', {});
  await until(() => recOf(url));
  assert.equal(count(recOf(url).text, MARK), 1, recOf(url).text);
});

test('preview opened at 11 s and closed at 14 s, then an SPA exit at 15 s: kept once', async t => {
  const url = 'https://app.koala-oss.club/videos/44';
  const p = page(t, { url, dom: { querySelector: () => null, body: { innerText: 'video page' } } });
  await p.advance(11000);
  preview(p, true);
  await p.advance(3000);
  preview(p, false);
  await p.advance(1000);
  p.spa('https://app.koala-oss.club/videos/45', 'Other', 'other video');
  await p.advance(2000);
  await until(() => recOf(url));
  assert.equal(count(recOf(url).text, MARK), 1, recOf(url).text);
});

// ---- Bilibili: the lookup starts at 50 s of playback; its answer is recorded only from 60 s ----
// The first request answers 2 s late: an instant answer lets a lookup started at 60 s pass too.
const slow = f => { const g = async url => { if (!g.n++) await new Promise(r => setTimeout(r, 2000)); return f(url); }; g.n = 0; return g; };

for (const subs of [[{ lan: 'ai-zh', subtitle_url: '//aisubtitle.hdslb.com/s.json' }], []]) {
  test(`Bilibili, ${subs.length ? 'with' : 'without'} subtitles: leaving at 61 s of playback keeps the slow answer`, async t => {
    const f = audioFetch(subs);
    const p = page(t, { url: BV, pageFetch: slow(f) });
    await p.advance(1000);
  playing(p, { currentSrc: 'blob:https://www.bilibili.com/1' });
    await p.advance(61000);
    p.fireWin('pagehide', {});
    await until(() => recOf(BV));
    const r = recOf(BV);
    assert.equal(r.subtitle_status, subs.length ? 'ok' : 'none');
    if (!subs.length) assert.deepEqual(r.audio, { source: 'bilibili', urls: [SIGNED], expires: 1893456000 });
  });
}

test('Bilibili: leaving at 55 s of playback looked up, but neither draft nor record has the answer', async t => {
  const f = audioFetch();
  const p = page(t, { url: BV, pageFetch: slow(f) });
  await p.advance(1000);
  playing(p, { currentSrc: 'blob:https://www.bilibili.com/1' });
  await p.advance(55000);
  assert.ok(playurls(f).length === 1, 'looked up, sound address included');
  const has = d => d && typeof d === 'object' && ['subtitle_status', 'subtitles', 'audio', 'audio_error'].some(k => k in d);
  assert.ok(!Object.values(p.store.data).some(has), 'not in the draft');
  p.fireWin('pagehide', {});
  await until(() => recOf(BV));
  assert.ok(!has(recOf(BV)), JSON.stringify(Object.keys(recOf(BV))));
});
