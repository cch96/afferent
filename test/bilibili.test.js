// Bilibili subtitles, fetched by the content script with the user's login (media contract §1b). Fake fetch only.
import test from 'node:test';
import assert from 'node:assert/strict';
import '../src/content/bilibili.js';
const { video, subtitles, audio } = globalThis.AfferentBilibili;

// Answers by URL prefix; each value is a JSON body, a number (HTTP status), 'text' (not JSON) or 'network'.
function biliFetch(routes) {
  const calls = [];
  const f = async (url, init = {}) => {
    calls.push({ url, init });
    const key = Object.keys(routes).find(k => url.startsWith(k));
    const r = routes[key];
    if (r === undefined) throw new Error('unexpected ' + url);
    if (r === 'network') throw new TypeError('Failed to fetch');
    if (typeof r === 'number') return new Response('{}', { status: r });
    return new Response(r === 'text' ? '<html>' : JSON.stringify(r), { status: 200 });
  };
  f.calls = calls;
  return f;
}
const VIEW = 'https://api.bilibili.com/x/web-interface/view?', PLAYER = 'https://api.bilibili.com/x/player/wbi/v2?';
const view = { code: 0, data: { cid: 111, pages: [{ cid: 111 }, { cid: 222 }] } };
const track = (lan, url = `//aisubtitle.hdslb.com/bfs/${lan}.json`) => ({ lan, lan_doc: lan, subtitle_url: url, ai_type: lan.startsWith('ai-') ? 1 : 0 });
const player = (subs, more = {}) => ({ code: 0, data: { need_login_subtitle: false, subtitle: { subtitles: subs }, ...more } });
const file = { body: [{ from: 0.123, to: 2.46, content: '你好', location: 2 }, { from: 2.5, to: 4, content: 'world' }] };

test('video(): only www.bilibili.com/video/BV… pages, part from ?p=', () => {
  assert.deepEqual(video('https://www.bilibili.com/video/BV1xx411c7mD'), { bvid: 'BV1xx411c7mD', p: 1 });
  assert.deepEqual(video('https://www.bilibili.com/video/BV1xx411c7mD/?p=2&spm=x'), { bvid: 'BV1xx411c7mD', p: 2 });
  assert.deepEqual(video('https://www.bilibili.com/video/BV1xx411c7mD?p=0'), { bvid: 'BV1xx411c7mD', p: 1 });
  for (const u of ['https://www.bilibili.com/', 'https://www.bilibili.com/bangumi/play/ep1', 'https://www.bilibili.com/video/av170001',
    'https://m.bilibili.com/video/BV1xx411c7mD', 'https://space.bilibili.com/1', 'https://e.com/video/BV1xx411c7mD', 'not a url']) {
    assert.equal(video(u), null, u);
  }
});

test('call sequence: view (cid of part p) -> wbi/v2 -> subtitle file; credentials only for the two API calls', async () => {
  const f = biliFetch({ [VIEW]: view, [PLAYER]: player([track('zh-CN')]), 'https://aisubtitle.hdslb.com/': file });
  const r = await subtitles({ bvid: 'BV1xx411c7mD', p: 2 }, f);
  assert.deepEqual(f.calls.map(c => c.url), [
    VIEW + 'bvid=BV1xx411c7mD',
    PLAYER + 'bvid=BV1xx411c7mD&cid=222',
    'https://aisubtitle.hdslb.com/bfs/zh-CN.json', // protocol-relative URL got https:
  ]);
  assert.equal(f.calls[0].init.credentials, 'include');
  assert.equal(f.calls[1].init.credentials, 'include');
  assert.equal(f.calls[2].init.credentials, 'omit');
  for (const c of f.calls) assert.equal(c.init.headers, undefined, 'no extra headers');
  assert.deepEqual(r, { subtitle_status: 'ok', subtitles: [{ source: 'bilibili', lang: 'zh-CN', auto: false,
    lines: [[0.123, 2.46, '你好'], [2.5, 4, 'world']] }] });
});

test('cid falls back to data.cid when the part is not listed', async () => {
  const f = biliFetch({ [VIEW]: { code: 0, data: { cid: 999 } }, [PLAYER]: player([]) });
  await subtitles({ bvid: 'BV1', p: 3 }, f);
  assert.equal(f.calls[1].url, PLAYER + 'bvid=BV1&cid=999');
});

test('track choice: uploader over AI, then ai-zh, then the first', async () => {
  const pick = async subs => {
    const f = biliFetch({ [VIEW]: view, [PLAYER]: player(subs), 'https://aisubtitle.hdslb.com/': file });
    const r = await subtitles({ bvid: 'BV1', p: 1 }, f);
    return [r.subtitles[0].lang, r.subtitles[0].auto, f.calls[2].url];
  };
  assert.deepEqual(await pick([track('ai-zh'), track('en-US')]), ['en-US', false, 'https://aisubtitle.hdslb.com/bfs/en-US.json']);
  assert.deepEqual(await pick([track('ai-en'), track('ai-zh')]), ['ai-zh', true, 'https://aisubtitle.hdslb.com/bfs/ai-zh.json']);
  assert.deepEqual(await pick([track('ai-ja'), track('ai-en')]), ['ai-ja', true, 'https://aisubtitle.hdslb.com/bfs/ai-ja.json']);
  assert.deepEqual(await pick([track('ai-zh', 'https://aisubtitle.hdslb.com/full.json')]), ['ai-zh', true, 'https://aisubtitle.hdslb.com/full.json']);
});

test('empty list -> none; empty list with need_login_subtitle -> login', async () => {
  let f = biliFetch({ [VIEW]: view, [PLAYER]: player([]) });
  assert.deepEqual(await subtitles({ bvid: 'BV1', p: 1 }, f), { subtitle_status: 'none' });
  assert.equal(f.calls.length, 2);
  f = biliFetch({ [VIEW]: view, [PLAYER]: player([], { need_login_subtitle: true }) });
  assert.deepEqual(await subtitles({ bvid: 'BV1', p: 1 }, f), { subtitle_status: 'login' });
  f = biliFetch({ [VIEW]: view, [PLAYER]: { code: 0, data: { need_login_subtitle: true } } });
  assert.deepEqual(await subtitles({ bvid: 'BV1', p: 1 }, f), { subtitle_status: 'login' });
});

test('failures -> error with a short subtitle_error naming the call; nothing throws', async () => {
  const cases = [
    [{ [VIEW]: 412 }, 'view HTTP 412'],
    [{ [VIEW]: 'text' }, 'view not JSON'],
    [{ [VIEW]: { code: -404, message: 'x' } }, 'view code -404'],
    [{ [VIEW]: 'network' }, 'view network error'],
    [{ [VIEW]: { code: 0, data: {} } }, 'view no cid'],
    [{ [VIEW]: view, [PLAYER]: { code: -352 } }, 'wbi/v2 code -352'],
    [{ [VIEW]: view, [PLAYER]: 500 }, 'wbi/v2 HTTP 500'],
    [{ [VIEW]: view, [PLAYER]: player([track('zh-CN')]), 'https://aisubtitle.hdslb.com/': 403 }, 'subtitle HTTP 403'],
    [{ [VIEW]: view, [PLAYER]: player([track('zh-CN')]), 'https://aisubtitle.hdslb.com/': 'text' }, 'subtitle not JSON'],
    [{ [VIEW]: view, [PLAYER]: player([track('zh-CN')]), 'https://aisubtitle.hdslb.com/': { nobody: 1 } }, 'subtitle no body'],
    [{ [VIEW]: view, [PLAYER]: player([track('zh-CN', '')]) }, 'subtitle no url'],
  ];
  for (const [routes, msg] of cases) {
    const r = await subtitles({ bvid: 'BV1', p: 1 }, biliFetch(routes));
    assert.deepEqual(r, { subtitle_status: 'error', subtitle_error: msg }, msg);
  }
});

// ---- audio(): where the lowest-bandwidth DASH audio stream can be downloaded (audio contract) ----
const PLAYURL = 'https://api.bilibili.com/x/player/wbi/playurl?';
// Signed-looking URLs: the params (and their order) must come back byte for byte.
const A = n => `https://upos-sz-mirror${n}.bilivideo.com/upgcxcode/x/30216.m4s?e=ig8euxZM&uipk=5&deadline=1763370000&gen=playurlv2&os=a&og=x&upsig=ab%2Fcd&mid=9&bvc=vod&nettype=0&orderid=0,3&buvid=XY&build=0&f=u_0_0&agrr=1&bw=8&logo=80000000`;
const dash = audio => ({ code: 0, data: { dash: { audio } } });

test('audio(): view (cid of part p) -> unsigned wbi/playurl fnval=16, both with credentials', async () => {
  const f = biliFetch({ [VIEW]: view, [PLAYURL]: dash([{ id: 30216, bandwidth: 66000, baseUrl: A(1) }]) });
  const r = await audio({ bvid: 'BV1xx411c7mD', p: 2 }, f);
  assert.deepEqual(f.calls.map(c => c.url), [VIEW + 'bvid=BV1xx411c7mD', PLAYURL + 'bvid=BV1xx411c7mD&cid=222&fnval=16']);
  for (const c of f.calls) { assert.equal(c.init.credentials, 'include'); assert.equal(c.init.headers, undefined); }
  assert.deepEqual(r, { audio: { source: 'bilibili', urls: [A(1)], expires: 1763370000 } });
});

test('audio(): lowest bandwidth; base then backups (either spelling); non-http dropped; at most 4; ≤ 4096 chars', async () => {
  const pick = async streams => (await audio({ bvid: 'BV1', p: 1 }, biliFetch({ [VIEW]: view, [PLAYURL]: dash(streams) }))).audio;
  const lo = { id: 30216, bandwidth: 65600, baseUrl: A(1), backupUrl: [A(2), 'ftp://x/y', A(3), A(4), A(5)] };
  const r = await pick([{ id: 30280, bandwidth: 214000, baseUrl: A(9) }, lo, { id: 30232, bandwidth: 91000, baseUrl: A(8) }]);
  assert.deepEqual(r.urls, [A(1), A(2), A(3), A(4)]);
  assert.deepEqual((await pick([{ bandwidth: 1, base_url: A(1), backup_url: [A(2)] }])).urls, [A(1), A(2)]);
  const long = 'https://x.bilivideo.com/' + 'a'.repeat(4096);
  assert.deepEqual((await pick([{ bandwidth: 1, baseUrl: long, backupUrl: [A(3)] }])).urls, [A(3)]);
  assert.deepEqual((await pick([{ bandwidth: 1, baseUrl: '//x.bilivideo.com/a', backupUrl: ['javascript:1', 'http://', A(2)] }])).urls, [A(2)]);
});

test('audio(): expires from the first URL\'s deadline param, else null', async () => {
  const exp = async u => (await audio({ bvid: 'BV1', p: 1 }, biliFetch({ [VIEW]: view, [PLAYURL]: dash([{ bandwidth: 1, baseUrl: u }]) }))).audio.expires;
  assert.equal(await exp(A(1)), 1763370000);
  assert.equal(await exp('https://x.bilivideo.com/a.m4s?e=1'), null);
  assert.equal(await exp('https://x.bilivideo.com/a.m4s?deadline=soon'), null);
});

test('audio(): failures -> audio_error naming the call; nothing throws', async () => {
  const cases = [
    [{ [VIEW]: 412 }, 'view HTTP 412'],
    [{ [VIEW]: { code: -404 } }, 'view code -404'],
    [{ [VIEW]: 'network' }, 'view network error'],
    [{ [VIEW]: 'text' }, 'view not JSON'],
    [{ [VIEW]: { code: 0, data: {} } }, 'view no cid'],
    [{ [VIEW]: view, [PLAYURL]: 412 }, 'playurl HTTP 412'],
    [{ [VIEW]: view, [PLAYURL]: { code: -352 } }, 'playurl code -352'],
    [{ [VIEW]: view, [PLAYURL]: 'network' }, 'playurl network error'],
    [{ [VIEW]: view, [PLAYURL]: 'text' }, 'playurl not JSON'],
    [{ [VIEW]: view, [PLAYURL]: { code: 0, data: {} } }, 'playurl no audio'],
    [{ [VIEW]: view, [PLAYURL]: dash([]) }, 'playurl no audio'],
    [{ [VIEW]: view, [PLAYURL]: dash([{ bandwidth: 1, baseUrl: 'ftp://x' }]) }, 'playurl no url'],
    [{ [VIEW]: view, [PLAYURL]: dash([null]) }, 'playurl no url'],
  ];
  for (const [routes, msg] of cases) assert.deepEqual(await audio({ bvid: 'BV1', p: 1 }, biliFetch(routes)), { audio_error: msg }, msg);
  assert.deepEqual(await audio({ bvid: 'BV1', p: 1 }, () => { throw new Error('sync boom'); }), { audio_error: 'view network error' });
});
