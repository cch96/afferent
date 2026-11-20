// The settings page, run on a stand-in DOM: what each 管理 panel holds, the 移除 flow, and the 不记的网站 block.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ALWAYS_SKIP, OPTIONAL_SKIP } from '../src/lib/skip.js';

const zh = JSON.parse(readFileSync(new URL('../_locales/zh_CN/messages.json', import.meta.url), 'utf8'));

// Elements are plain objects, children in .kids; selectors: one .class or one tag name.
function fakeDocument() {
  const doc = { activeElement: null, byId: {} };
  const walk = e => [e, ...(e.kids || []).filter(k => typeof k === 'object').flatMap(walk)];
  const match = sel => sel.startsWith('.') ? e => (e.className || '').split(' ').includes(sel.slice(1)) : e => e.tagName === sel.toUpperCase();
  const make = tag => {
    const e = { tagName: tag.toUpperCase(), kids: [], attrs: {}, on: {}, dataset: {}, value: '', className: '',
      style: { setProperty() {} }, classList: { toggle() {}, add() {}, remove() {} }, getBoundingClientRect: () => ({ bottom: 0 }),
      append: (...k) => e.kids.push(...k), replaceChildren: (...k) => { e.kids = k; },
      setAttribute: (n, v) => { e.attrs[n] = String(v); }, removeAttribute: n => { delete e.attrs[n]; },
      getAttribute: n => e.attrs[n] ?? null, addEventListener: (type, f) => { e.on[type] = f; },
      focus: () => { doc.activeElement = e; }, scrollIntoView() {}, isConnected: true, get firstChild() { return e.kids[0] ?? null; },
      querySelectorAll: sel => walk(e).slice(1).filter(match(sel)), querySelector: sel => e.querySelectorAll(sel)[0] ?? null };
    return e;
  };
  return Object.assign(doc, { walk, createElement: make, createElementNS: (_, tag) => make(tag),
    getElementById: id => (doc.byId[id] ??= Object.assign(make('div'), { id })),
    querySelectorAll: () => [], documentElement: {} });
}
// The text a user sees: hidden subtrees skipped.
const seen = e => e.hidden ? '' : (e.textContent ?? '') + (e.kids || []).map(k => typeof k === 'object' ? seen(k) : String(k)).join('');

const store = {
  settings: { consent: { agreed: true, at: 'x' }, skipOn: ['email'], skipOwn: ['news.example.com', 'mail.qq.com'] },
  'dest:webhook': { enabled: true, kinds: ['read'], sites: [], url: 'http://192.0.2.10:8070/afferent/v1/pages', token: 'fake_key_00000000000000' },
  'dest:mem0': { enabled: true, kinds: ['read', 'glance'], sites: [], userId: 'afferent', apiKey: 'fake_key_00000000000000' },
  'dest:hindsight': { enabled: true, kinds: ['read', 'glance'], sites: [], url: 'http://10.0.0.5:8888', bank: 'afferent', apiKey: 'hsk_fake_key_00000000' },
  'q:hindsight': ['a', 'b', 'c'],
};
const sent = [];
globalThis.chrome = {
  i18n: { getMessage: (k, subs = []) => zh[k].message.replace(/\$(\d)/g, (_, n) => [].concat(subs)[n - 1]), getUILanguage: () => 'zh-CN' },
  storage: { local: { get: async keys => Object.fromEntries(keys.filter(k => k in store).map(k => [k, structuredClone(store[k])])) },
    onChanged: { addListener() {} } },
  runtime: { sendMessage: async m => { sent.push(m); } },
  permissions: { request: async () => true },
};
const document = globalThis.document = fakeDocument();
globalThis.location = { hash: '' };
const winOn = {};
globalThis.window = { addEventListener: (type, f) => { winOn[type] = f; } };
globalThis.innerHeight = 800;
await import('../src/ui/options.js');

const rows = () => document.getElementById('dests').kids;
const row = name => rows().find(r => seen(r.querySelector('.name')) === name);
const all = r => document.walk(r);
const buttons = (r, text) => all(r).filter(e => e.tagName === 'BUTTON' && !e.hidden && seen(e) === text);
// Every 管理 panel open.
for (const r of rows()) buttons(r, '管理')[0].onclick();

test('panel: no 测试连接, no 只发这些网站 box, no loose fields, no notes', () => {
  for (const r of rows()) {
    const text = seen(r.querySelector('.panel'));
    for (const gone of ['测试连接', '换密钥', '只发这些网站', '用户 ID', '命名空间', '密钥只存在这个浏览器里。']) assert.ok(!text.includes(gone), gone);
    assert.equal(r.querySelectorAll('textarea').length, 0);
    assert.equal(r.querySelectorAll('input').length, 0, 'no input until 更换 is clicked');
  }
});

test('panel: rows in order 地址 | 发哪些页 | (Neurosea: 字幕) | 移除', () => {
  const labels = r => r.querySelector('.panel').kids.filter(k => k.className === 't').map(seen);
  assert.deepEqual(labels(row('Neurosea')), ['地址', '发哪些页', '字幕']);
  assert.deepEqual(labels(row('Mem0')), ['地址', '发哪些页']);
  assert.equal(seen(row('Neurosea').querySelector('.panel').kids.at(-1)), '移除');
});

test('panel: the 字幕 switch is in Neurosea\'s panel and in no other', () => {
  const switches = r => all(r.querySelector('.panel')).filter(e => e.className === 'switch');
  assert.equal(switches(row('Neurosea')).length, 1);
  for (const name of ['Mem0', 'Hindsight']) assert.equal(switches(row(name)).length, 0, name);
  const text = seen(row('Neurosea').querySelector('.panel'));
  assert.ok(text.includes('看满 1 分钟的视频，存下字幕；没字幕的转成文字。'));
  const html = readFileSync(new URL('../src/ui/options.html', import.meta.url), 'utf8');
  for (const id of ['bsubs', 'shot', 'shot-msg', 'shot-sub']) assert.ok(!html.includes(`id="${id}"`), id);
});

test('panel: 地址 shows the host only, from the saved URL or the platform\'s fixed origin', () => {
  const addr = name => seen(row(name).querySelector('.addr'));
  assert.deepEqual(['Neurosea', 'Mem0', 'Hindsight'].map(addr), ['192.0.2.10:8070', 'api.mem0.ai', '10.0.0.5:8888']);
  const change = buttons(row('Mem0'), '更换')[0];
  assert.equal(change.attrs['aria-label'], '更换 Mem0 的连接信息');
});

test('panel: 更换 opens the box under 地址 with 取消, and closes it again', () => {
  const r = row('Mem0'), change = buttons(r, '更换')[0];
  change.onclick();
  assert.equal(change.attrs['aria-expanded'], 'true');
  const box = r.querySelector('.connect');
  assert.ok(box);
  assert.deepEqual(r.querySelectorAll('input').map(e => e.placeholder ?? e.value), ['贴上 Mem0 的新密钥', '']);
  assert.ok(seen(box).includes('取消'));
  buttons(box, '取消')[0].onclick();
  assert.equal(r.querySelector('.connect'), null);
  assert.equal(document.activeElement, change);
});

test('panel: 移除 asks first; 取消 sends nothing and refocuses 移除; the second 移除 sends removeDest', async () => {
  sent.length = 0;
  const r = row('Hindsight');
  let rm = buttons(r, '移除')[0];
  rm.onclick();
  assert.deepEqual(sent, []);
  assert.ok(seen(r).includes('移除 Hindsight？密钥和待发的 3 页会从这个浏览器删掉。'));
  buttons(r, '取消').at(-1).onclick();
  assert.deepEqual(sent, []);
  assert.ok(!seen(r).includes('移除 Hindsight？'));
  rm = buttons(r, '移除')[0];
  assert.equal(document.activeElement, rm);
  rm.onclick();
  await buttons(r, '移除').at(-1).onclick();
  assert.deepEqual(sent, [{ type: 'removeDest', id: 'hindsight' }]);
  assert.equal(document.activeElement, document.getElementById('add'));
  // Nothing waiting: the short sentence.
  buttons(row('Mem0'), '移除')[0].onclick();
  assert.ok(seen(row('Mem0')).includes('移除 Mem0？密钥会从这个浏览器删掉。'));
});

test('panel: 移除 while the 添加平台 card is open focuses its key input, not the hidden 添加平台 button', async () => {
  const add = document.getElementById('add'), card = document.getElementById('add-card');
  add.onclick();
  assert.equal(add.hidden, true);
  const r = row('Mem0');
  buttons(r, '取消').at(-1)?.onclick();
  buttons(r, '移除')[0].onclick();
  await buttons(r, '移除').at(-1).onclick();
  assert.equal(document.activeElement, card.querySelector('input'));
  buttons(card, '取消')[0].onclick();
});

test('不记的网站: only own sites (an old group\'s sites among them, once), each with ×; then the input and 添加', () => {
  const chips = document.getElementById('own-sites').kids;
  assert.deepEqual(chips.map(li => seen(li.kids[0])), ['news.example.com', 'mail.qq.com', ...OPTIONAL_SKIP.email.filter(r => r !== 'mail.qq.com')]);
  for (const li of chips) assert.equal(li.kids[1].attrs['aria-label'], '移除 ' + seen(li.kids[0]));
  const html = readFileSync(new URL('../src/ui/options.html', import.meta.url), 'utf8');
  for (const gone of ['id="chips"', 'id="chip-sites"', 'class="lock"']) assert.ok(!html.includes(gone), gone);
  for (const kept of ['id="own-sites"', 'id="skip-in"', 'id="skip-add"']) assert.ok(html.includes(kept), kept);
  assert.ok(!readFileSync(new URL('../src/ui/options.js', import.meta.url), 'utf8').includes("className: 'lock'"));
});

test('不记的网站 ⓘ: named, opens on hover, focus and click, closes on leave, blur and Escape; its number is the list length', () => {
  const b = document.getElementById('skip-info'), tip = document.getElementById('skip-tip');
  assert.equal(b.attrs['aria-label'], '不记的网站的说明');
  assert.equal(seen(document.getElementById('skip-tip1')),
    `内置：${ALWAYS_SKIP.passwords.length} 个密码管理器网站（如 1password.com）、自己标了成人内容的网页。`);
  for (const [open, close] of [[() => b.on.mouseenter(), () => document.getElementById('skip-lab').on.mouseleave()],
    [() => b.on.focus(), () => b.on.blur()], [() => b.on.click(), () => winOn.keydown({ key: 'Escape' })]]) {
    open(); assert.equal(tip.hidden, false);
    close(); assert.equal(tip.hidden, true);
  }
  const html = readFileSync(new URL('../src/ui/options.html', import.meta.url), 'utf8');
  assert.ok(html.includes('data-i18n="setSkipTip2"') && /<strong[^>]*data-i18n="setSkipTip2"/.test(html), 'the last line in bold');
  // Three lines: where else a site can be added, the built-in list, then the bold one.
  const lines = html.slice(html.indexOf('id="skip-tip"'), html.indexOf('</div>', html.indexOf('id="skip-tip"'))).match(/<p[\s\S]*?<\/p>/g);
  assert.equal(lines.length, 3);
  assert.match(lines[0], /data-i18n="setSkipTip0"/);
  assert.equal(zh.setSkipTip0.message, '网页上右键、弹窗里点「不记这个网站」也能加。');
  assert.match(lines[1], /id="skip-tip1"/);
});

test('no 高级 block: no 敏感信息 row, no key-rule or URL-parameter box', () => {
  const html = readFileSync(new URL('../src/ui/options.html', import.meta.url), 'utf8');
  for (const gone of ['setAdvanced', 'setSensitive', 'secret-custom', 'id="strip"', 'secrets-manage', 'tip-keys', 'tip-params']) assert.ok(!html.includes(gone), gone);
});
