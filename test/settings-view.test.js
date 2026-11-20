// Settings page texts derived from storage.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const zh = JSON.parse(readFileSync(new URL('../_locales/zh_CN/messages.json', import.meta.url), 'utf8'));
globalThis.chrome = { i18n: { getMessage: (k, subs = []) => zh[k].message.replace(/\$(\d)/g, (_, n) => [].concat(subs)[n - 1]) } };
const { destStatus, destHost, clampThr } = await import('../src/ui/settings-view.js');
const { adapters } = await import('../src/adapters/index.js');

const NOW = new Date(2026, 10, 10, 15).getTime(), Y = NOW - 24 * 3600e3;

test('destination status line, in priority order', () => {
  const recent = [
    { at: NOW - 1000, status: { webhook: 'sent', mem0: 'queued' } },
    { at: NOW - 2000, status: { webhook: 'queued' } },
    { at: NOW - 3000, status: { webhook: 'failed' } },
    { at: Y, status: { webhook: 'sent' } },
  ];
  const s = (id, cfg, live) => destStatus(id, cfg, { recent, ...live }, NOW);
  assert.deepEqual(s('webhook', { enabled: true }, {}), { text: '已连接，今天 2 页', tone: 'ok' });
  assert.deepEqual(s('mem0', { enabled: true }, {}), { text: '已连接，今天 1 页', tone: 'ok' });
  assert.deepEqual(s('supermemory', { enabled: true }, { recent: undefined }), { text: '已连接，今天 0 页', tone: 'ok' });
  assert.deepEqual(s('webhook', { enabled: true }, { dstate: { failures: 2 }, q: ['a', 'b', 'c'] }), { text: '无法连接，3 页待发送', tone: 'bad' });
  assert.deepEqual(s('webhook', { enabled: true }, { dstate: { auth: true, failures: 2 }, q: ['a'] }), { text: '密钥被拒，1 页待发送', tone: 'bad' });
  assert.deepEqual(s('mem0', { enabled: true }, { dstate: { auth: true } }), { text: '密钥被拒，0 页待发送', tone: 'bad' });
  assert.deepEqual(s('mem0', { enabled: false }, { dstate: { auth: true } }), { text: '已停用', tone: 'off' });
});

test('threshold is shown clamped to the slider', () => {
  assert.deepEqual([undefined, 1, 3, 12, 60, 3600, 7.6].map(clampThr), [10, 3, 3, 12, 60, 60, 8]);
});

test('the page has three blocks: 发到哪, 看满几秒记正文, 不记的网站; 字幕 lives in Neurosea\'s panel', () => {
  const html = readFileSync(new URL('../src/ui/options.html', import.meta.url), 'utf8');
  const blocks = [...html.matchAll(/<h2[^>]*>(?:<label[^>]*>)?/g)].map(m => m[0].match(/data-i18n="(\w+)"/)).map(m => zh[m[1]].message);
  assert.deepEqual(blocks, ['发到哪', '看满几秒记正文', '不记的网站']);
  assert.equal(zh.setSubsSub.message, '看满 1 分钟的视频，存下字幕；没字幕的转成文字。');
  for (const id of ['adv', 'secret-rules', 'play', 'shot-every', 'times', 'stats']) assert.ok(!html.includes(`id="${id}"`), id);
  const js = readFileSync(new URL('../src/ui/options.js', import.meta.url), 'utf8');
  for (const s of ["$('play')", 'secretsOff', "type: 'checkbox'", 'shot-every', 'shotIntervalSec', "$('times')", "$('stats')", 'secretRules', 'stripParams']) assert.ok(!js.includes(s), s);
});

test('地址: the host only, from the saved URL or the platform\'s fixed origin; nothing without either', () => {
  const a = id => adapters.find(x => x.id === id);
  assert.equal(destHost(a('supermemory'), { apiKey: 'sm_fake_key_00000000' }), 'api.supermemory.ai');
  assert.equal(destHost(a('mem0'), undefined), 'api.mem0.ai');
  assert.equal(destHost(a('hindsight'), { url: 'http://10.0.0.5:8888' }), '10.0.0.5:8888');
  assert.equal(destHost(a('webhook'), { url: 'http://192.0.2.10:8070/afferent/v1/pages' }), '192.0.2.10:8070');
  assert.equal(destHost(a('webhook'), {}), '');
  assert.equal(destHost({ origins: () => [] }, {}), '');
});
