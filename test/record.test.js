import test from 'node:test';
import assert from 'node:assert/strict';
import { classify, buildRecord, MAX_BODY } from '../src/lib/record.js';
import { pageKey } from '../src/lib/url.js';

test('classification at the threshold boundary', () => {
  assert.equal(classify(0, 10000), null);
  assert.equal(classify(1, 10000), 'glance');
  assert.equal(classify(9999, 10000), 'glance');
  assert.equal(classify(10000, 10000), 'read');
});

const draft = {
  id: '6f1c2d3e-4a5b-4c6d-8e7f-0123456789ab',
  url: 'https://Docs.Example.com/p?a=1&token=x#h', title: 'T', lang: 'en-US',
  text: 'hello', dwellMs: 12345, first: Date.UTC(2026, 10, 5, 1, 2, 3, 4), last: Date.UTC(2026, 10, 5, 1, 3, 0),
};

test('read record has every contract field', async () => {
  const r = await buildRecord(draft, 10000, '0.1.0');
  assert.deepEqual(Object.keys(r).sort(), ['capture_id', 'client', 'dwell_seconds', 'first_seen', 'kind', 'lang', 'last_seen', 'page_key', 'schema', 'site', 'text', 'title', 'url'].sort());
  assert.equal(r.schema, 'afferent.page/1');
  assert.equal(r.capture_id, draft.id);
  assert.equal(r.kind, 'read');
  assert.equal(r.url, 'https://docs.example.com/p?a=1');
  assert.equal(r.page_key, await pageKey(r.url));
  assert.match(r.page_key, /^[0-9a-f]{64}$/);
  assert.equal(r.site, 'docs.example.com');
  assert.equal(r.text, 'hello');
  assert.equal(r.dwell_seconds, 12);
  assert.equal(r.first_seen, '2026-11-05T01:02:03.004Z');
  assert.equal(r.last_seen, '2026-11-05T01:03:00.000Z');
  assert.match(r.first_seen, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{3})?Z$/);
  assert.equal(r.lang, 'en-US');
  assert.deepEqual(r.client, { name: 'afferent', version: '0.1.0' });
});

test('glance has empty text; zero dwell gives no record', async () => {
  const g = await buildRecord({ ...draft, dwellMs: 3000 }, 10000, '1');
  assert.equal(g.kind, 'glance');
  assert.equal(g.text, '');
  assert.equal(await buildRecord({ ...draft, dwellMs: 0 }, 10000, '1'), null);
});

test('caps: title, text, dwell, lang, missing fields', async () => {
  const r = await buildRecord({ ...draft, title: 'x'.repeat(2000), text: 'y'.repeat(200000), dwellMs: 1e12, lang: 'z'.repeat(40) }, 10000, '1');
  assert.equal(r.title.length, 1000);
  assert.equal(r.text.length, 100000);
  assert.equal(r.dwell_seconds, 604800);
  assert.equal('lang' in r, false);
  const m = await buildRecord({ ...draft, title: undefined, text: undefined, lang: '' }, 10000, '1');
  assert.equal(m.title, '');
  assert.equal(m.text, '');
  assert.equal('lang' in m, false);
});

test('truncation never leaves a lone surrogate', async () => {
  const r = await buildRecord({ ...draft, text: 'a' + '😀'.repeat(60000) }, 10000, '1');
  assert.ok(r.text.length <= 100000);
  assert.ok(!/[\uD800-\uDBFF]$/.test(r.text));
});

test('body stays under 512 KiB even for escape-heavy text', async () => {
  const r = await buildRecord({ ...draft, text: '\u0001'.repeat(100000) }, 10000, '1');
  assert.ok(new TextEncoder().encode(JSON.stringify(r)).length <= MAX_BODY);
});

test('over-long url: query dropped, else no record; bad scheme no record', async () => {
  const long = 'https://e.com/p?q=' + 'a'.repeat(3000);
  assert.equal((await buildRecord({ ...draft, url: long }, 10000, '1')).url, 'https://e.com/p');
  assert.equal(await buildRecord({ ...draft, url: 'https://e.com/' + 'a'.repeat(3000) }, 10000, '1'), null);
  assert.equal(await buildRecord({ ...draft, url: 'ftp://e.com/' }, 10000, '1'), null);
});

test('lone surrogates become U+FFFD so every string is well-formed', async () => {
  const r = await buildRecord({ ...draft, title: 'x\udc80', text: 'abc\ud83d' }, 10000, '0.1.0');
  assert.ok(r.title.isWellFormed() && r.text.isWellFormed());
  assert.equal(r.title, 'x�');
  assert.equal(r.text, 'abc�');
});

// ---- media (contract section 1) ----
import { shapeMedia } from '../src/lib/record.js';

const entry = (over = {}) => ({ kind: 'video', src: 'https://cdn.e.com/v.mp4', duration: 600.04, played: [[0, 30]], playMs: 30000, bgMs: 0, ...over });

test('shapeMedia: rounding, merging, src rules', () => {
  const [e] = shapeMedia([entry({ played: [[60.04, 90.06], [0, 30], [31, 40], [10, 20]], playMs: 61900, bgMs: 1500, heard: [[60.04, 90.06], [31, 40]] })], []);
  assert.deepEqual(e, { kind: 'video', src: 'https://cdn.e.com/v.mp4', duration_s: 600, played: [[0, 40], [60, 90.1]], heard: [[31, 40], [60, 90.1]], play_s: 61, background_s: 1 });
  const src = s => shapeMedia([entry({ src: s })], ['sess'])[0].src;
  assert.equal(src('https://cdn.e.com/v.mp4?token=abc&sess=1&x=2#t=5'), 'https://cdn.e.com/v.mp4?x=2');
  for (const s of ['blob:https://e.com/1', 'data:audio/mp3;base64,AA', 'mediastream:1', '', undefined]) assert.equal('src' in shapeMedia([entry({ src: s })], [])[0], false, s);
  assert.equal(src('https://cdn.e.com/v.mp4?q=' + 'a'.repeat(3000)), 'https://cdn.e.com/v.mp4');
  assert.equal('src' in shapeMedia([entry({ src: 'https://e.com/' + 'a'.repeat(3000) })], [])[0], false);
  for (const d of [Infinity, NaN, 0, null]) assert.equal(shapeMedia([entry({ duration: d })], [])[0].duration_s, null);
  assert.equal(shapeMedia([entry({ kind: 'audio' })], [])[0].kind, 'audio');
  assert.equal(shapeMedia([entry({ bgMs: 99999 })], [])[0].background_s, 30, 'background_s <= play_s');
  assert.deepEqual(shapeMedia([entry()], [])[0].heard, [], 'none recorded: []');
});

test('shapeMedia: entries under 1 s are dropped; empty gives []', () => {
  assert.deepEqual(shapeMedia([entry({ playMs: 999 })], []), []);
  assert.deepEqual(shapeMedia(undefined, []), []);
});

test('shapeMedia: at most 50 ranges (the longest, by start) and 20 entries (largest play, first-play order)', () => {
  const played = Array.from({ length: 80 }, (_, i) => [i * 10, i * 10 + 1 + (i % 7)]);
  const [e] = shapeMedia([entry({ played })], []);
  assert.equal(e.played.length, 50);
  assert.deepEqual(e.played, [...e.played].sort((a, b) => a[0] - b[0]));
  // lengths 1-7: all 44 ranges of length 4-7 kept, the rest filled from length 3
  assert.equal(e.played.filter(([a, b]) => b - a >= 4).length, 44);
  assert.ok(e.played.every(([a, b]) => b - a >= 3), 'kept the longest');
  const many = Array.from({ length: 30 }, (_, i) => entry({ src: 'https://e.com/' + i, playMs: (i % 2 ? 100 : 1) * 1000 + i }));
  const out = shapeMedia(many, []);
  assert.equal(out.length, 20);
  assert.equal(out.filter(x => x.play_s >= 100).length, 15);
  const order = out.map(x => Number(x.src.split('/').pop()));
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
});

test('record exists on playback alone: dwell 0 and play_s >= 60 is read, < 60 is nothing', async () => {
  const at = n => [{ kind: 'audio', src: 'https://e.com/a.mp3', duration_s: null, played: [[0, n]], play_s: n, background_s: n }];
  const r = await buildRecord({ ...draft, dwellMs: 0, first: 1, last: 2, media: at(60) }, 10000, '1');
  assert.equal(r.kind, 'read');
  assert.equal(r.text, 'hello');
  assert.equal(r.dwell_seconds, 0);
  assert.deepEqual(r.media, at(60));
  assert.equal(await buildRecord({ ...draft, dwellMs: 0, media: at(59) }, 10000, '1'), null);
  const g = await buildRecord({ ...draft, dwellMs: 3000, media: at(59) }, 10000, '1');
  assert.equal(g.kind, 'glance');
  assert.deepEqual(g.media, at(59));
  assert.equal('media' in await buildRecord({ ...draft, media: [] }, 10000, '1'), false);
  assert.equal('media' in await buildRecord(draft, 10000, '1'), false);
});

test('a record at the 20-entry / 50-range caps with escape-heavy text stays within 512 KB', async () => {
  const played = Array.from({ length: 200 }, (_, i) => [i * 10.123456, i * 10.123456 + 5.987654]);
  const media = shapeMedia(Array.from({ length: 40 }, (_, i) =>
    entry({ src: `https://cdn.e.com/${i}/` + 'p'.repeat(2000), played, playMs: 1e9 + i, bgMs: 1e9 })), []);
  assert.equal(media.length, 20);
  assert.ok(media.every(m => m.played.length === 50));
  const r = await buildRecord({ ...draft, text: '\u0001'.repeat(100000), media }, 10000, '1');
  assert.equal(r.media.length, 20);
  assert.ok(new TextEncoder().encode(JSON.stringify(r)).length <= MAX_BODY);
});

// ---- Bilibili subtitles (media contract §1b) ----
const subs = lines => ({ subtitle_status: 'ok', subtitles: [{ source: 'bilibili', lang: 'zh-CN', auto: false, lines }] });

test('subtitles: times rounded to 0.1 s, text capped at 60,000 chars (later lines dropped)', async () => {
  const lines = [[0.04, 1.26, 'a'.repeat(30000)], [1.26, 2.5, 'b'.repeat(29999)], [2.5, 3, 'cc'], [3, 4, 'd']];
  const r = await buildRecord({ ...draft, ...subs(lines) }, 10000, '1');
  assert.equal(r.subtitle_status, 'ok');
  assert.deepEqual(r.subtitles[0].lines.map(l => [l[0], l[1], l[2].length]), [[0, 1.3, 30000], [1.3, 2.5, 29999]]);
  assert.deepEqual(Object.keys(r.subtitles[0]).sort(), ['auto', 'lang', 'lines', 'source']);
  assert.equal('subtitle_error' in r, false);
});

test('subtitles: status and error kept, error cut to 100 chars; no status gives no fields', async () => {
  const e = await buildRecord({ ...draft, subtitle_status: 'error', subtitle_error: 'x'.repeat(300) }, 10000, '1');
  assert.equal(e.subtitle_status, 'error');
  assert.equal(e.subtitle_error.length, 100);
  assert.equal('subtitles' in e, false);
  const n = await buildRecord({ ...draft, subtitle_status: 'none', subtitle_error: 'stray', subtitles: subs([[0, 1, 'x']]).subtitles }, 10000, '1');
  assert.deepEqual([n.subtitle_status, 'subtitle_error' in n, 'subtitles' in n], ['none', false, false]);
  assert.ok(!Object.keys(await buildRecord(draft, 10000, '1')).some(k => k.startsWith('subtitle')));
});

test('subtitles: the record stays within 512 KB, page text gives way first', async () => {
  // Control characters escape to 6 bytes each in JSON: 60,000 of them are ~360 KB of subtitles.
  const lines = Array.from({ length: 600 }, (_, i) => [i, i + 1, '\u0001'.repeat(100)]);
  const r = await buildRecord({ ...draft, text: '\u0001'.repeat(100000), ...subs(lines) }, 10000, '1');
  assert.ok(new TextEncoder().encode(JSON.stringify(r)).length <= MAX_BODY);
  assert.equal(r.subtitles[0].lines.length, 600, 'all subtitle lines kept');
  assert.ok(r.text.length < 100000);
  // Even with no page text left, lines are dropped from the end until it fits.
  const many = Array.from({ length: 60000 }, (_, i) => [i + 0.1, i + 0.9, '\u0001']);
  const m = await buildRecord({ ...draft, text: '', ...subs(many) }, 10000, '1');
  assert.ok(new TextEncoder().encode(JSON.stringify(m)).length <= MAX_BODY);
  assert.ok(m.subtitles[0].lines.length > 1000 && m.subtitles[0].lines.length < 60000);
  assert.deepEqual(m.subtitles[0].lines[0], [0.1, 0.9, '\u0001']);
});

// ---- audio / audio_error (audio contract, Neurosea only) ----
const SIGNED = 'https://Upos-SZ.bilivideo.com/x/30216.m4s?deadline=1763370000&token=abc&utm_source=x&upsig=a%2Fb&e=ig8%3D';
const bili = (urls, expires = 1763370000) => ({ audio: { source: 'bilibili', urls, expires } });

test('audio: kept byte for byte (no normalizing, no param stripping), with source and expires', async () => {
  const r = await buildRecord({ ...draft, ...bili([SIGNED, SIGNED + '&b=1']) }, 10000, '1', { stripParams: ['token', 'upsig', 'deadline'] });
  assert.deepEqual(r.audio, { source: 'bilibili', urls: [SIGNED, SIGNED + '&b=1'], expires: 1763370000 });
  assert.equal('audio_error' in r, false);
  const x = await buildRecord({ ...draft, audio: { source: 'xiaohongshu', urls: ['http://v.xhscdn.com/a.mp4?sign=1'], expires: null } }, 10000, '1');
  assert.deepEqual(x.audio, { source: 'xiaohongshu', urls: ['http://v.xhscdn.com/a.mp4?sign=1'], expires: null });
});

test('audio: urls filtered to absolute http(s) ≤ 4096 chars, at most 4; expires an integer or null; extra keys dropped', async () => {
  const long = 'https://x.bilivideo.com/' + 'a'.repeat(4096);
  const r = await buildRecord({ ...draft, audio: { source: 'bilibili', urls: ['ftp://x/a', long, 7, '/rel', 'https://a/1', 'https://a/2', 'https://a/3', 'https://a/4', 'https://a/5'],
    expires: 1.5, extra: 'x' } }, 10000, '1');
  assert.deepEqual(r.audio, { source: 'bilibili', urls: ['https://a/1', 'https://a/2', 'https://a/3', 'https://a/4'], expires: null });
  for (const expires of [-1, '1763370000', undefined, NaN]) assert.equal((await buildRecord({ ...draft, audio: { source: 'bilibili', urls: ['https://a/1'], expires } }, 10000, '1')).audio.expires, null);
});

test('audio: a wrong shape gives no audio field', async () => {
  for (const audio of [null, 'x', [], { source: 'youtube', urls: ['https://a/1'], expires: null }, { source: 'bilibili', urls: 'https://a/1' },
    { source: 'bilibili', urls: [] }, { source: 'bilibili', urls: ['ftp://a', 'javascript:1'] }]) {
    const r = await buildRecord({ ...draft, audio }, 10000, '1');
    assert.ok(!('audio' in r) && !('audio_error' in r), JSON.stringify(audio));
  }
});

test('audio_error: a string cut to 100 chars; never with audio', async () => {
  const e = await buildRecord({ ...draft, audio_error: 'playurl code -352 ' + 'x'.repeat(300) }, 10000, '1');
  assert.equal(e.audio_error.length, 100);
  assert.equal('audio' in e, false);
  assert.equal((await buildRecord({ ...draft, audio_error: 'view code -404' }, 10000, '1')).audio_error, 'view code -404');
  assert.equal((await buildRecord({ ...draft, audio_error: 'x https://a/b' }, 10000, '1')).audio_error, 'x https://a/b'); // our own templates hold no URL: not scrubbed
  assert.ok(!('audio_error' in await buildRecord({ ...draft, audio_error: 42 }, 10000, '1')));
  const both = await buildRecord({ ...draft, ...bili(['https://a/1']), audio_error: 'stray' }, 10000, '1');
  assert.deepEqual([!!both.audio, 'audio_error' in both], [true, false]);
  const bad = await buildRecord({ ...draft, audio: { source: 'x' }, audio_error: 'playurl no audio' }, 10000, '1');
  assert.deepEqual([('audio' in bad), bad.audio_error], [false, 'playurl no audio']);
  assert.ok(!Object.keys(await buildRecord(draft, 10000, '1')).some(k => k.startsWith('audio')));
});

test('shapeMedia: past 20 entries, the heard ones are kept first (by heard length), then by play_s', () => {
  const muted = Array.from({ length: 20 }, (_, i) => entry({ src: `https://cdn.e.com/m${i}.mp4`, playMs: 60000 + i * 1000, played: [[0, 60]] }));
  const heard = entry({ src: 'https://cdn.e.com/heard.mp4', playMs: 5000, played: [[0, 5]], heard: [[0, 5]] });
  const out = shapeMedia([...muted.slice(0, 10), heard, ...muted.slice(10)], []);
  assert.equal(out.length, 20);
  assert.ok(out.some(m => m.src === 'https://cdn.e.com/heard.mp4'), 'the heard clip survives');
  assert.ok(!out.some(m => m.src === 'https://cdn.e.com/m0.mp4'), 'the shortest muted clip goes');
  assert.equal(out[9].src, 'https://cdn.e.com/heard.mp4', 'order of first play kept (m0 before it was cut)');
});
