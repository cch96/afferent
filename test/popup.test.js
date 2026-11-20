import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { popupView, deleteNotice, skipNotice, fmtDwell, windowRange, forgetText } from '../src/ui/popup-view.js';
import * as pv from '../src/ui/popup-view.js';

const msgs = JSON.parse(readFileSync(new URL('../_locales/zh_CN/messages.json', import.meta.url), 'utf8'));
const t = (k, subs = []) => {
  assert.ok(msgs[k], 'missing key ' + k);
  return msgs[k].message.replace(/\$(\d)/g, (_, i) => subs[i - 1]);
};

const NOW = new Date(2026, 10, 10, 15, 30).getTime();
const at = (h, m) => new Date(2026, 10, 10, h, m).getTime();
const ok = { settings: { consent: { agreed: true } } };
const http = { url: 'https://example.com/a', title: 'Tab title' };
const v = (store, tab = http, page = null) => popupView({ store: { ...ok, ...store }, tab, page, now: NOW }, t);

test('card: not consented wins over everything and hides pause', () => {
  const r = popupView({ store: { settings: { paused: true } }, tab: http, page: null, now: NOW }, t);
  assert.deepEqual(r.card, { kind: 'start', big: '还没开始记录', note: '', action: '连接平台', fill: 0, grey: false, done: false });
  assert.equal(r.pause, null);
  assert.equal(r.showList, false);
});

test('card: the start card has no note', () => {
  assert.equal(popupView({ store: {}, tab: http, page: null, now: NOW }, t).card.note, '');
});

test('card: paused wins over the page state', () => {
  const r = v({ settings: { consent: { agreed: true }, paused: true } }, http, { url: http.url, title: 'x', capturing: true, dwellMs: 20000, thresholdMs: 10000 });
  assert.equal(r.card.big, '已暂停');
  assert.equal(r.card.note, '所有网页都不记');
  assert.equal(r.card.grey, true);
  assert.equal(r.card.fill, 0);
  assert.deepEqual(r.pause, { paused: true, label: '继续' });
});

test('card: no content script on an http page asks for a refresh', () => {
  const r = v({ settings: { consent: { agreed: true }, thresholdSec: 15 } });
  assert.equal(r.card.big, '看满 15 秒，记下正文');
  assert.equal(r.card.note, '刷新后开始计时');
  assert.equal(r.card.fill, 0);
  assert.equal(r.card.grey, false);
  assert.deepEqual(r.pause, { paused: false, label: '暂停' });
});

test('card: no content script and not http (or unknown URL) is a browser page', () => {
  for (const tab of [{ url: 'chrome://extensions/' }, {}, null]) {
    const r = v({}, tab);
    assert.equal(r.card.big, '这页不记');
    assert.equal(r.card.note, '浏览器自带页面');
    assert.equal(r.card.action, undefined);
    assert.equal(r.card.grey, true);
  }
});

test('card: not capturing on a skip-listed URL names the rule (from the page URL, tab fields may be empty)', () => {
  // A built-in rule is not in the settings list, so there is nothing to edit there.
  const r = v({}, {}, { url: 'https://my.1password.com/vault', title: 'Vault', capturing: false, dwellMs: 0, thresholdMs: null });
  assert.equal(r.card.note, '内置不记：1password.com');
  assert.equal(r.card.action, undefined);
  const custom = v({ settings: { consent: { agreed: true }, skip: ['example.com/a'] } }, http, { ...http, capturing: false });
  assert.equal(custom.card.note, 'example.com/a 在名单里');
  assert.equal(custom.card.action, '改名单');
});

test('card: an optional group names its rule only while it is on', () => {
  const mail = { url: 'https://mail.google.com/mail/u/0/', title: 'Inbox', capturing: false, dwellMs: 0, thresholdMs: null };
  assert.equal(v({}, {}, mail).card.note, '');
  assert.equal(v({ settings: { consent: { agreed: true }, skipOn: ['email'], skipOwn: [] } }, {}, mail).card.note, 'mail.google.com 在名单里');
});

test('card: not capturing and not skip-listed', () => {
  const r = v({}, http, { ...http, capturing: false, dwellMs: 0, thresholdMs: null });
  assert.equal(r.card.big, '这页不记');
  assert.equal(r.card.note, '');
  assert.equal(r.card.action, undefined);
});

test('card: an unexplained skip has no note', () => {
  assert.equal(v({}, http, { ...http, capturing: false, dwellMs: 0, thresholdMs: null }).card.note, '');
});

test('card: capturing shows the title and the fill; at the threshold it is saved', () => {
  const page = { url: http.url, title: 'Page title', capturing: true, thresholdMs: 10000 };
  const reading = v({}, {}, { ...page, dwellMs: 7000 });
  assert.equal(reading.card.big, '看满 10 秒，记下正文');
  assert.equal(reading.card.title, 'Page title');
  assert.equal(reading.card.fill, 0.7);
  assert.equal(reading.card.done, false);
  const saved = v({}, {}, { ...page, dwellMs: 10000 });
  assert.equal(saved.card.big, '记下了');
  assert.equal(saved.card.done, true);
  assert.equal(saved.card.fill, 1);
  assert.equal(v({}, { title: 'Tab' }, { ...page, title: '', dwellMs: 0 }).card.title, 'Tab');
});

test('dwell formatting', () => {
  assert.equal(fmtDwell(48, t), '48 秒');
  assert.equal(fmtDwell(4 * 60 + 30, t), '4 分钟');
  assert.equal(fmtDwell(3600 + 5 * 60, t), '1 小时 5 分钟');
  assert.equal(fmtDwell(7200, t), '2 小时');
});

const entry = (o) => ({ id: 'c1', title: 'T', url: 'https://github.com/x', site: 'github.com', kind: 'read', dwell: 48, at: at(14, 52), status: {}, redacted: 0, ...o });

test('rows: today newest first, then every earlier capture with its date; meta, time and status', () => {
  const recent = [
    entry({ id: 'a', at: at(15, 10), dwell: 240, status: { webhook: 'queued' } }),
    entry({ id: 'b', at: at(14, 52), status: { webhook: 'sent' }, redacted: 2, shots: 3 }),
    entry({ id: 'c', at: at(14, 40), kind: 'glance', dwell: 0, status: { webhook: 'failed' } }),
    entry({ id: 'd', at: at(14, 0), dwell: undefined, status: { webhook: 'sent' } }),
    entry({ id: 'e', at: at(13, 0), status: {}, shots: 0 }),
    entry({ id: 'old', at: new Date(2026, 10, 9, 23, 59).getTime(), status: { webhook: 'sent' } }),
    entry({ id: 'older', at: new Date(2026, 9, 2, 8, 0).getTime(), status: {} }),
    entry({ id: 'oldq', at: new Date(2026, 10, 8, 8, 0).getTime(), status: { webhook: 'queued' } }),
  ];
  const r = v({ recent, today: { date: '2026-11-10', n: 5 } });
  assert.equal(r.count, '今天 5 页');
  assert.equal(r.showList, true);
  assert.deepEqual(r.rows.map(x => [x.id, x.meta, x.when, x.late, x.read, x.earlier]), [
    ['a', '读了 4 分钟', '待发送', 'queued', true, false],
    ['b', '读了 48 秒 · 遮住 2 处密钥', '14:52', null, true, false],
    ['c', '扫了一眼', '发送失败', 'failed', false, false],
    ['d', '读过', '14:00', null, true, false],
    ['e', '读了 48 秒', '只在本机', 'local', true, false],
    ['old', '读了 48 秒', '11-09', null, true, true],
    ['oldq', '读了 48 秒', '待发送', 'queued', true, true],
    ['older', '读了 48 秒', '只在本机', 'local', true, true],
  ]);
  // Earlier rows carry what the row menu needs.
  assert.deepEqual([r.rows[5].url, r.rows[5].site, r.rows[5].title], ['https://github.com/x', 'github.com', 'T']);
  assert.equal(r.rows[0].site, 'github.com');
  assert.equal(r.delivered, false);
});

test('today count is 0 when the stored day is not today; the tick needs every row of today sent somewhere', () => {
  assert.equal(v({ today: { date: '2026-11-09', n: 9 } }).count, '今天 0 页');
  assert.equal(v({}).delivered, false);
  const sent = { recent: [entry({ at: at(15, 0), status: { webhook: 'sent' } })] };
  assert.equal(v(sent).delivered, true);
  assert.equal(v({ ...sent, 'dest:webhook': { enabled: true }, 'dstate:webhook': { failures: 1 } }).delivered, false);
  // A row recorded while no platform took it was delivered nowhere.
  assert.equal(v({ recent: [...sent.recent, entry({ id: 'x', at: at(14, 0), status: {} })] }).delivered, false);
  assert.equal(v({ recent: [entry({ at: at(15, 0), status: { webhook: 'sent', mem0: 'failed' } })] }).delivered, false);
  // Earlier days do not count, either way.
  assert.equal(v({ recent: [...sent.recent, entry({ id: 'y', at: new Date(2026, 10, 9, 9).getTime(), status: {} })] }).delivered, true);
  assert.equal(v({ recent: [entry({ id: 'y', at: new Date(2026, 10, 9, 9).getTime(), status: { webhook: 'sent' } })] }).delivered, false);
});

test('card: the refresh hint shows the threshold capture uses (3-60 s)', () => {
  assert.equal(v({ settings: { consent: { agreed: true }, thresholdSec: 1 } }).card.big, '看满 3 秒，记下正文');
  assert.equal(v({ settings: { consent: { agreed: true }, thresholdSec: 600 } }).card.big, '看满 60 秒，记下正文');
});

test('banner: network failure on the first failing enabled destination', () => {
  const r = v({
    'dest:webhook': { enabled: false }, 'dstate:webhook': { failures: 3 },
    'dest:supermemory': { enabled: true }, 'dstate:supermemory': { failures: 2 }, 'q:supermemory': ['a', 'b', 'c', 'd'],
    'dest:mem0': { enabled: true }, 'dstate:mem0': { auth: true },
  });
  assert.deepEqual(r.banner, { kind: 'net', text: '无法连接 Supermemory，4 页待发送', button: '重试' });
});

test('banner: auth, worded per destination, goes to settings', () => {
  const hook = v({ 'dest:webhook': { enabled: true, name: 'My box' }, 'dstate:webhook': { auth: true, failures: 0 }, 'q:webhook': ['a'] });
  assert.deepEqual(hook.banner, { kind: 'auth', text: 'My box 拒绝了密钥，1 页待发送', button: '去设置' });
  const mem0 = v({ 'dest:mem0': { enabled: true }, 'dstate:mem0': { auth: true } });
  assert.equal(mem0.banner.text, 'Mem0 拒绝了密钥，0 页待发送');
  assert.equal(v({ 'dest:webhook': { enabled: true }, 'dstate:webhook': { failures: 0 } }).banner, null);
});

test('banner: an HTTP answer says why the platform is not taking pages; network errors keep the old text', () => {
  const st = detail => v({ 'dest:hindsight': { enabled: true }, 'dstate:hindsight': { failures: 1, detail }, 'q:hindsight': ['a', 'b'] }).banner;
  assert.deepEqual(st('HTTP 402 Insufficient credits'), { kind: 'net', text: 'Hindsight 没收下（HTTP 402 Insufficient credits），2 页待发送', button: '重试' });
  assert.equal(st('network error').text, '无法连接 Hindsight，2 页待发送');
  assert.equal(st('timeout').text, '无法连接 Hindsight，2 页待发送');
  assert.equal(st(undefined).text, '无法连接 Hindsight，2 页待发送');
});

const job = (webhook, detail) => ({ id: 'j', body: {}, status: { webhook }, ...(detail ? { detail } : {}) });

test('delete window: 15 min, last hour, today (local midnight) and all (from 0) end now', () => {
  assert.deepEqual(windowRange('15', NOW), { from: NOW - 15 * 60000, to: NOW });
  assert.deepEqual(windowRange('hour', NOW), { from: NOW - 3600000, to: NOW });
  assert.deepEqual(windowRange('today', NOW), { from: new Date(2026, 10, 10).getTime(), to: NOW });
  assert.deepEqual(windowRange('all', NOW), { from: 0, to: NOW });
  assert.equal(new Date(windowRange('all', NOW).from).toISOString(), '1970-01-01T00:00:00.000Z');
});

test('delete dialog: what the selected range does, per connected platform', () => {
  const what = (r, store) => pv.deleteWhat(r, store, t);
  const hook = { 'dest:webhook': { enabled: true } };
  for (const r of ['15', 'hour', 'today']) {
    assert.equal(what(r, hook), '本机删除，Neurosea 上所有电脑记的都作废。');
    assert.equal(what(r, {}), '本机删除。');
  }
  assert.equal(what('all', hook), '本机删除，Neurosea 上所有电脑记的都作废。设置和连接保留。');
  assert.equal(what('all', {}), '本机删除。设置和连接保留。');
  // Switched off still counts: the forget job queues and goes out when it is switched back on.
  assert.equal(what('hour', { 'dest:webhook': { enabled: false, name: 'Box' } }), '本机删除，Box 上所有电脑记的都作废。');
  // Mem0 / Supermemory: whenever configured; one switched off still holds what it received.
  const both = { ...hook, 'dest:supermemory': { enabled: true }, 'dest:mem0': { enabled: true } };
  assert.equal(what('hour', both), '本机删除，Neurosea 上所有电脑记的都作废。Supermemory、Mem0 上的需另外删除。');
  assert.equal(what('all', { 'dest:mem0': { enabled: false } }), '本机删除。设置和连接保留。Mem0 上的需另外删除。');
});

test('Neurosea status: hidden, never "deleted"', () => {
  const store = { 'dest:webhook': { enabled: true } };
  assert.equal(forgetText(job('pending'), store, t), 'Neurosea：待作废');
  assert.equal(forgetText(job('done'), store, t), 'Neurosea：已作废');
  assert.equal(forgetText(job('failed', 'HTTP 400 bad window'), store, t), 'Neurosea：作废失败（HTTP 400 bad window）');
  // Not yet in the popup's copy of storage: it was just queued.
  assert.equal(forgetText(undefined, store, t), 'Neurosea：待作废');
  assert.equal(forgetText(job('done'), { 'dest:webhook': { name: 'Test' } }, t), 'Test：已作废');
});

test('delete notice: local part, Neurosea part, third parties', () => {
  const store = { 'dest:webhook': { enabled: true }, 'dest:mem0': { enabled: true } };
  assert.equal(deleteNotice({ n: 3, sentTo: [], forget: 'queued' }, job('pending'), store, t), '已删除 3 条\nNeurosea：待作废');
  assert.equal(deleteNotice({ n: 0, sentTo: [], forget: 'queued' }, job('done'), store, t), '没有可删的\nNeurosea：已作废');
  assert.equal(deleteNotice({ n: 2, sentTo: ['mem0'], forget: 'queued' }, job('failed', 'HTTP 400'), store, t),
    '已删除 2 条\nNeurosea：作废失败（HTTP 400）\nMem0 上的需另外删除');
  // No Neurosea connected: the local part only (and third parties).
  assert.equal(deleteNotice({ n: 1, sentTo: [], forget: 'none' }, undefined, store, t), '已删除 1 条');
  assert.equal(deleteNotice({ n: 1, sentTo: ['supermemory', 'mem0'], forget: 'none' }, undefined, store, t), '已删除 1 条\nSupermemory、Mem0 上的需另外删除');
});

test('row delete of a capture sent only to Neurosea never says it was not sent', () => {
  const text = deleteNotice({ n: 1, sentTo: [], forget: 'queued' }, undefined, { 'dest:webhook': { enabled: true } }, t);
  assert.equal(text, '已删除 1 条\nNeurosea：待作废');
  assert.ok(!text.includes('没有发出去'));
});

test('persistent line: the newest forget job, while pending or failed', () => {
  assert.equal(v({}).forget, null);
  assert.deepEqual(v({ forgetq: [job('failed', 'x'), job('pending')] }).forget, { text: 'Neurosea：待作废', failed: false });
  assert.deepEqual(v({ forgetq: [job('done'), job('failed', 'HTTP 400')] }).forget, { text: 'Neurosea：作废失败（HTTP 400）', failed: true });
  assert.equal(v({ forgetq: [job('failed', 'x'), job('done')] }).forget, null);
});

test('skip notice: with and without a count; platforms that already got some', () => {
  const none = { n: 0, sentTo: [], forget: 'none' };
  assert.equal(skipNotice('zhihu.com', none, {}, t), '以后不记 zhihu.com 了');
  assert.equal(skipNotice('zhihu.com', { ...none, n: 2 }, {}, t), '以后不记 zhihu.com 了，已删除最近的 2 条。');
  assert.equal(skipNotice('zhihu.com', { n: 2, sentTo: ['hindsight'], forget: 'queued' }, { 'dest:hindsight': { enabled: true } }, t),
    '以后不记 zhihu.com 了，已删除最近的 2 条。\nHindsight 上的需另外删除');
});

test('card: 不记这个网站 only while the page is recorded (reading, saved), with the page\'s site', () => {
  const page = { url: 'https://news.example.com/a', title: 'A', capturing: true, thresholdMs: 10000 };
  for (const dwellMs of [3000, 10000]) {
    const c = v({}, {}, { ...page, dwellMs }).card;
    assert.deepEqual([c.action, c.site], ['不记这个网站', 'news.example.com']);
  }
  const others = [
    popupView({ store: {}, tab: http, page: null, now: NOW }, t).card, // start
    v({ settings: { consent: { agreed: true }, paused: true } }, http, { ...page, dwellMs: 3000 }).card,
    v({}, http).card, // refresh
    v({}, { url: 'chrome://extensions/' }).card,
    v({}, {}, { ...page, capturing: false, dwellMs: 0 }).card,
    v({}, {}, { ...page, url: 'https://my.1password.com/', capturing: false, dwellMs: 0 }).card,
  ];
  for (const c of others) assert.notEqual(c.action, '不记这个网站', c.kind);
});

test('card: right after 不记这个网站 the page still says capturing; the own list wins', () => {
  const page = { url: 'https://news.example.com/a', title: 'A', capturing: true, dwellMs: 3000, thresholdMs: 10000 };
  const c = v({ settings: { consent: { agreed: true }, skipOn: [], skipOwn: ['news.example.com'] } }, {}, page).card;
  assert.deepEqual([c.kind, c.big, c.note, c.action, c.grey], ['skipped', '这页不记', 'news.example.com 在名单里', '改名单', true]);
});

test('card: after the popup\'s own 不记这个网站 the card has no button, before and after the list catches up', () => {
  const page = { url: 'https://news.example.com/a', title: 'A', capturing: true, dwellMs: 3000, thresholdMs: 10000 };
  const own = skipOwn => popupView({ store: { settings: { consent: { agreed: true }, skipOn: [], skipOwn } }, tab: {}, page, now: NOW, skipped: 'news.example.com' }, t).card;
  assert.equal(own([]).action, undefined);
  assert.deepEqual([own(['news.example.com']).kind, own(['news.example.com']).action], ['skipped', undefined]);
});

test('card: after the click, a page skipped by a different own rule still offers 改名单', () => {
  const page = url => ({ url, title: 'B', capturing: false, dwellMs: 0, thresholdMs: 10000 });
  const card = url => popupView({ store: { settings: { consent: { agreed: true }, skipOn: [], skipOwn: ['b.com', 'a.com'] } }, tab: {}, page: page(url), now: NOW, skipped: 'a.com' }, t).card;
  assert.deepEqual([card('https://b.com/x').kind, card('https://b.com/x').action], ['skipped', '改名单']);
  assert.deepEqual([card('https://a.com/x').kind, card('https://a.com/x').action], ['skipped', undefined]);
});
