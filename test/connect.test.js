// The shared connect box: text + pick → platform, disclosure, failure texts, and the click flow.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const zh = JSON.parse(readFileSync(new URL('../_locales/zh_CN/messages.json', import.meta.url), 'utf8'));
// chrome.i18n over the real zh_CN strings; a missing key throws.
const getMessage = (k, subs = []) => zh[k].message.replace(/\$(\d)/g, (_, n) => [].concat(subs)[n - 1]);
globalThis.chrome = { i18n: { getMessage } };
const { resolveKey, disclosure, failText, connect, createConnect } = await import('../src/ui/connect.js');
const { createCore } = await import('../src/lib/core.js');
const { fakeStore, fakeAlarms, fakeClock } = await import('./fakes.js');

const CODE = 'http://192.168.1.20:8070/afferent/v1/pages#token=tok12345&name=家里';
const SM = 'sm_abcdefgh12', M0 = 'm0-abcdefgh12';
const NSK = 'nsk_aHR0cDovLzE5Mi4wLjIuMTA6ODA3MC9hZmZlcmVudC92MS9wYWdlcw.fake-token_AbC-123_xyz000000';

test('resolve: detected text, manual pick, nothing', () => {
  assert.deepEqual(resolveKey(CODE, ''), { id: 'webhook', name: '家里', auto: true, kinds: ['read', 'glance'],
    cfg: { enabled: true, kinds: ['read', 'glance'], sites: [], url: 'http://192.168.1.20:8070/afferent/v1/pages', token: 'tok12345', name: '家里' } });
  assert.deepEqual(resolveKey(' ' + SM + ' ', '').cfg, { enabled: true, kinds: ['read', 'glance'], sites: [], namespace: 'afferent', apiKey: SM });
  // A chip click wins over recognition (the box clears the pick when recognised text is typed).
  assert.deepEqual([resolveKey(SM, 'mem0').id, resolveKey(SM, 'mem0').auto], ['mem0', false]);
  const picked = resolveKey('plainkey123', 'mem0');
  assert.deepEqual(picked, { id: 'mem0', name: 'Mem0', auto: false, kinds: ['read', 'glance'],
    cfg: { enabled: true, kinds: ['read', 'glance'], sites: [], userId: 'afferent', apiKey: 'plainkey123' } });
  assert.equal(resolveKey('plainkey123', ''), null);
  assert.equal(resolveKey('', 'mem0'), null);
  // Picked Neurosea but the text is no URL: platform known, nothing to connect to.
  assert.deepEqual(resolveKey('plainkey123', 'webhook'), { id: 'webhook', name: 'Neurosea', auto: false, kinds: ['read', 'glance'], cfg: null });
});

test('resolve for a saved platform: platform locked, the patch holds the key, the switch and the box\'s fields', () => {
  const old = { enabled: false, kinds: ['read', 'glance'], sites: ['a.com'], namespace: 'mine', apiKey: 'old' };
  const stored = id => (id === 'supermemory' ? old : undefined);
  const r = resolveKey('m0-looksdifferent', '', { lock: 'supermemory', stored });
  assert.deepEqual(r, { id: 'supermemory', name: 'Supermemory', auto: false, kinds: ['read', 'glance'],
    cfg: { enabled: true, kinds: ['read', 'glance'], sites: ['a.com'], namespace: 'mine', apiKey: 'm0-looksdifferent' },
    patch: { enabled: true, name: null, apiKey: 'm0-looksdifferent', namespace: 'mine' } });
  assert.equal(resolveKey(SM, 'mem0', { lock: 'supermemory', stored }).auto, true);
  // 添加平台 on a platform that already has a config patches it too; a new one gets the full default config.
  assert.deepEqual(resolveKey(SM, '', { stored }).patch, { enabled: true, name: null, apiKey: SM });
  assert.equal(resolveKey(M0, '', { stored }).patch, undefined);
  // Glances became a default later: a platform saved with reads only keeps reads only.
  const readOnly = { ...old, kinds: ['read'] };
  const k = resolveKey(SM, '', { stored: id => (id === 'supermemory' ? readOnly : undefined) });
  assert.deepEqual([k.kinds, k.cfg.kinds, 'kinds' in k.patch], [['read'], ['read'], false]);
  // A new connection code without a name drops the old name (null: undefined does not survive sendMessage).
  const hook = { enabled: true, kinds: ['read'], sites: [], url: 'http://a/p', token: 'x', name: 'Old' };
  const h = resolveKey('http://b/p#token=y', '', { lock: 'webhook', stored: () => hook });
  assert.deepEqual(h.cfg, { enabled: true, kinds: ['read'], sites: [], url: 'http://b/p', token: 'y' });
  assert.deepEqual(h.patch, { enabled: true, name: null, url: 'http://b/p', token: 'y' });
});

test('replace after a sites/kinds change keeps that change; a code without a name clears the old name', async () => {
  const store = fakeStore({ 'dest:webhook': { enabled: true, kinds: ['read', 'glance'], sites: [], url: 'http://a/p', token: 'x', name: 'Old' } });
  const core = createCore({ store, alarms: fakeAlarms(), now: fakeClock(), version: 't' });
  // The box resolves the key against what storage holds when the user connects, not when it opened.
  const res = resolveKey('http://b/p#token=y', '', { lock: 'webhook', stored: id => store.data['dest:' + id] });
  await core.patchDest('webhook', { sites: ['b.com'] });
  await core.patchDest('webhook', { kinds: ['read'] });
  await core.patchDest('webhook', res.patch);
  assert.deepEqual(store.data['dest:webhook'], { enabled: true, kinds: ['read'], sites: ['b.com'], url: 'http://b/p', token: 'y' });
});

test('disclosure: one sentence by kinds and the real threshold; Neurosea\'s also names playback and subtitles', () => {
  const d = (id, name, kinds, thr = 12) => disclosure({ thresholdSec: thr, id, name, kinds });
  assert.equal(d(null), '你看过的网页会存到你连接的平台，方便以后找回：网址、标题、访问时间和停留时长；看满 12 秒的还有正文，含聊天对话。');
  assert.equal(d('hindsight', 'Hindsight', ['read', 'glance'], 7), '你看过的网页会存到 Hindsight，方便以后找回：网址、标题、访问时间和停留时长；看满 7 秒的还有正文，含聊天对话。');
  assert.equal(d('mem0', 'Mem0', ['read']), '你看满 12 秒的网页会存到 Mem0，方便以后找回：网址、标题、正文（含聊天对话）、访问时间和停留时长。');
  assert.equal(d('supermemory', 'Supermemory', ['read', 'glance']), '你看过的网页会存到 Supermemory，方便以后找回：网址、标题、访问时间和停留时长；看满 12 秒的还有正文，含聊天对话。');
  assert.equal(d('webhook', '家里', ['read', 'glance']), '你看过的网页会存到 家里，方便以后找回：网址、标题、访问时间和停留时长；看满 12 秒（或视频播满 1 分钟）的还有正文，含聊天对话；视频还有播放记录、字幕和视频文件地址。');
  assert.equal(d('webhook', 'Neurosea', ['read']), '你看满 12 秒（或视频播满 1 分钟）的网页会存到 Neurosea，方便以后找回：网址、标题、正文（含聊天对话）、访问时间和停留时长；视频还有播放记录、字幕和视频文件地址。');
});

test('failure texts for every reason, platform and mode', () => {
  const f = (reason, text, pick, mode = 'start') => failText(reason, resolveKey(text, pick), mode);
  assert.equal(f('unreachable', CODE), '无法连接 192.168.1.20:8070，请确认服务器已开启。');
  assert.equal(f('unreachable', SM), '无法连接 Supermemory，请检查网络。');
  assert.equal(f('unreachable', 'plainkey123', 'mem0'), '无法连接 Mem0，请检查网络。');
  // 401/403: the same sentence as a key nobody recognises.
  for (const text of [CODE, SM]) assert.equal(f('auth', text), '无法识别这个密钥。', text);
  assert.equal(f('auth', M0, '', 'settings'), '无法识别这个密钥。');
  assert.equal(f('perm', CODE), '未获得权限。再点“同意并开始”，选择“允许”。');
  assert.equal(f('perm', SM, '', 'settings'), '未获得权限。再点“同意并连接”，选择“允许”。');
});

test('click flow: permission first, then test, then consent + save', async () => {
  const run = async (mode, granted, result, text = CODE, opts) => {
    const log = [];
    chrome.permissions = { request: async p => { log.push(['perm', p.origins]); return granted; } };
    chrome.runtime = { sendMessage: async m => { log.push([m.type, m]); return m.type === 'testDest' ? { result } : undefined; } };
    const res = resolveKey(text, '', opts);
    // The permission request must start synchronously, inside the click gesture.
    const p = connect(mode, res);
    assert.equal(log.length, 1, 'request was called before any await');
    return { out: await p, types: log.map(x => x[0]), log, res };
  };
  let r = await run('start', false, 'ok');
  assert.deepEqual([r.out, r.types], [{ reason: 'perm' }, ['perm']]);
  assert.deepEqual(r.log[0][1], ['http://192.168.1.20:8070/*']);

  r = await run('start', true, 'ok');
  assert.deepEqual(r.types, ['perm', 'testDest', 'consent', 'saveDest']);
  assert.deepEqual(r.log[2][1], { type: 'consent', agree: true });
  assert.deepEqual(r.log[3][1], { type: 'saveDest', id: 'webhook', cfg: r.res.cfg });
  assert.deepEqual(r.out, { cfg: r.res.cfg });

  // Settings mode: the disclosure plus 同意并连接 is consent too.
  r = await run('settings', true, 'no_health');
  assert.deepEqual(r.types, ['perm', 'testDest', 'consent', 'saveDest']);
  // A saved platform gets only its credentials patched.
  r = await run('settings', true, 'ok', CODE, { stored: () => ({ enabled: false, kinds: ['read'], sites: ['a.com'], url: 'http://x/p', token: 'z' }) });
  assert.deepEqual(r.types, ['perm', 'testDest', 'consent', 'patchDest']);
  assert.deepEqual(r.log[3][1], { type: 'patchDest', id: 'webhook', patch: r.res.patch });

  for (const [result, reason] of [['auth', 'auth'], ['unreachable', 'unreachable'], ['error', 'unreachable']]) {
    r = await run('start', true, result, SM);
    assert.deepEqual([r.out, r.types], [{ reason }, ['perm', 'testDest']], result);
    assert.deepEqual(r.log[0][1], ['https://api.supermemory.ai/*']);
  }
});

// Just enough DOM for createConnect: elements are plain objects, children in .kids.
function fakeDocument() {
  const make = tag => {
    const e = { tagName: tag.toUpperCase(), kids: [], attrs: {}, on: {}, value: '',
      classes: new Set(), classList: { toggle: (c, on) => { if (on) e.classes.add(c); else e.classes.delete(c); } },
      append: (...k) => e.kids.push(...k), replaceChildren: (...k) => { e.kids = k; },
      setAttribute: (n, v) => { e.attrs[n] = String(v); }, removeAttribute: n => { delete e.attrs[n]; },
      getAttribute: n => e.attrs[n] ?? null,
      addEventListener: (type, f) => { e.on[type] = f; } };
    return e;
  };
  return { createElement: make, createElementNS: (_, tag) => make(tag) };
}
const walk = e => [e, ...(e.kids || []).filter(k => typeof k === 'object').flatMap(walk)];
// The text a user sees: hidden subtrees skipped.
const seen = e => e.hidden ? '' : (e.textContent ?? '') + (e.kids || []).map(k => typeof k === 'object' ? seen(k) : String(k)).join('');
const open = (opts = {}) => {
  globalThis.document = fakeDocument();
  const root = createConnect({ mode: 'start', thresholdSec: 10, onDone() {}, ...opts });
  root.isConnected = true;
  const q = () => {
    const all = walk(root);
    return { all, input: all.find(e => e.tagName === 'INPUT'), btn: all.find(e => e.className === 'c-btn'),
      chips: all.filter(e => e.className === 'c-pill'), row: seen(all.find(e => e.className === 'c-row')),
      line: seen(all.find(e => e.className === 'c-line')), asks: askInputs(all),
      pressed: all.filter(e => e.className === 'c-pill' && e.attrs['aria-pressed'] === 'true').map(e => e.textContent) };
  };
  const type = text => { const { input } = q(); input.value = text; input.on.input(); return q(); };
  const chip = name => { q().chips.find(c => c.textContent === name).onclick(); return q(); };
  const click = cls => { walk(root).find(e => e.className === cls && !e.hidden).onclick(); return q(); };
  return { root, q, type, chip, click };
};

test('box: chips in the design order, chosen by click or by recognised text; a click wins until recognised text is typed', () => {
  const b = open();
  let s = b.q();
  assert.deepEqual(s.chips.map(c => c.textContent), ['Hindsight', 'Supermemory', 'Mem0']);
  for (const c of s.chips) assert.equal(c.kids.length, 0, 'nothing after the name of ' + c.textContent);
  assert.deepEqual(s.pressed, []);
  assert.deepEqual(b.type(SM).pressed, ['Supermemory']);
  assert.deepEqual(b.type('fake_key_00000000000000').pressed, []);
  assert.deepEqual(b.chip('Mem0').pressed, ['Mem0']);
  assert.deepEqual(b.type(SM).pressed, ['Supermemory'], 'recognised text clears the pick');
  assert.deepEqual(b.chip('Hindsight').pressed, ['Hindsight'], 'a click wins over recognition');
  // The address field Hindsight opened by itself is untouched, so it pins nothing.
  assert.deepEqual(b.type(SM + 'x').pressed, ['Supermemory']);
  // A chip first, then the key.
  const c = open();
  c.chip('Mem0');
  assert.deepEqual(c.type('fake_key_00000000000000').pressed, ['Mem0']);
  assert.equal(c.q().btn.disabled, false);
  // Locked to a saved platform: no chips.
  const l = open({ mode: 'settings', lock: 'mem0', stored: () => ({ kinds: ['read'], sites: [] }) });
  assert.equal(walk(l.root).find(e => e.className === 'c-picks').hidden, true);
  delete globalThis.document;
});

test('box: with no chip picked, a pasted Neurosea key (nsk_ or URL#token=) connects as webhook', async () => {
  for (const text of [NSK, CODE]) {
    const b = open();
    const log = [];
    chrome.permissions = { request: async () => true };
    chrome.runtime = { sendMessage: async m => { log.push(m); return m.type === 'testDest' ? { result: 'ok' } : undefined; } };
    const s = b.type(text);
    assert.equal(s.btn.disabled, false, text);
    s.btn.onclick();
    await new Promise(r => setTimeout(r, 10));
    assert.deepEqual(log.map(m => m.type), ['testDest', 'consent', 'saveDest'], text);
    assert.equal(log.at(-1).id, 'webhook', text);
  }
  delete globalThis.document;
});

test('box: placeholder names the chosen platform; the input has an accessible name; the h1 is the title', () => {
  const b = open();
  let s = b.q();
  assert.deepEqual([s.input.placeholder, s.input.attrs['aria-label']], ['贴上 API 密钥', 'API 密钥']);
  assert.ok(s.all.some(e => e.tagName === 'H1' && seen(e) === '连接记忆平台'));
  assert.equal(b.chip('Hindsight').input.placeholder, '贴上 Hindsight 的 API 密钥');
  // Settings: a visible label instead of the h1.
  const st = open({ mode: 'settings' });
  s = st.q();
  assert.ok(s.all.some(e => e.tagName === 'LABEL' && e.textContent === 'API 密钥' && e.htmlFor === s.input.id));
  assert.ok(!s.all.some(e => e.tagName === 'H1'));
  delete globalThis.document;
});

test('box: the fixed row under the input holds one hint, error or address field', () => {
  const b = open();
  assert.equal(b.q().row, '没有密钥？先点上面的平台。');
  let s = b.chip('Hindsight');
  assert.equal(s.row, '没有密钥？去 Hindsight 拿 ↗自己部署的？改地址');
  assert.equal(s.all.find(e => e.tagName === 'A' && !e.hidden).href, 'https://ui.hindsight.vectorize.io');
  assert.equal(b.chip('Supermemory').row, '没有密钥？去 Supermemory 拿 ↗');
  assert.equal(b.chip('Mem0').row, '没有密钥？去 Mem0 拿 ↗');
  // A saved Neurosea, text is not its code.
  s = open({ mode: 'settings', lock: 'webhook', stored: () => ({ kinds: ['read'], sites: [], url: 'http://a/p', token: 'x' }) }).type('fake_key_00000000000000');
  assert.deepEqual([s.row, s.btn.disabled, s.input.classes.has('failed')], ['无法识别这个密钥。', true, true]);
  // Nobody recognises it and nothing is chosen. Short text is not judged yet.
  const n = open();
  s = n.type('fake_key_00000000000000');
  assert.deepEqual([s.row, s.btn.disabled, s.input.classes.has('failed')], ['无法识别这个密钥，在上面选一下平台。', true, true]);
  s = n.type('fake');
  assert.deepEqual([s.row, s.input.classes.has('failed')], ['没有密钥？先点上面的平台。', false]);
  // Key fine: self-hostable platforms keep the 改地址 offer, the others an empty row.
  assert.deepEqual([n.type(SM).row, n.q().btn.disabled], ['', false]);
  assert.equal(n.type('hsk_fake_key_00000000').row, '自己部署的？改地址');
  // 改地址: the row becomes the address field, prefilled with the official address.
  s = n.click('lk c-own');
  assert.deepEqual([s.row, s.asks.map(e => e.value)], ['', ['https://api.hindsight.vectorize.io']]);
  assert.ok(!s.all.some(e => e.className === 'c-row' && !e.hidden));
  assert.equal(s.btn.disabled, false);
  delete globalThis.document;
});

test('box: Hindsight chosen with a key that is not hsk_ opens an empty, required address field', async () => {
  const b = open();
  b.chip('Hindsight');
  let s = b.type('fake_key_00000000000000');
  assert.deepEqual(s.asks.map(e => [e.value, e.placeholder]), [['', '你的服务器地址，例如 http://192.168.1.10:8888']]);
  assert.deepEqual([s.row, s.btn.disabled], ['', true]);
  // A cloud key closes it again; the official address is used.
  s = b.type('hsk_fake_key_00000000');
  assert.deepEqual([s.asks, s.btn.disabled], [[], false]);
  assert.equal(resolveKey('hsk_fake_key_00000000', '').cfg.url, 'https://api.hindsight.vectorize.io');
  s = b.chip('Hindsight');
  s = b.type('fake_key_00000000000000');
  s.asks[0].value = 'http://10.0.0.5:8888'; s.asks[0].on.input();
  s = b.q();
  assert.equal(s.btn.disabled, false);
  const log = [];
  chrome.permissions = { request: async p => { log.push(p.origins); return true; } };
  chrome.runtime = { sendMessage: async m => { log.push(m); return m.type === 'testDest' ? { result: 'ok' } : undefined; } };
  s.btn.onclick();
  await new Promise(r => setTimeout(r, 10));
  assert.deepEqual(log[0], ['http://10.0.0.5:8888/*']);
  assert.deepEqual(log.at(-1).cfg, { enabled: true, kinds: ['read', 'glance'], sites: [], url: 'http://10.0.0.5:8888', bank: 'afferent', apiKey: 'fake_key_00000000000000' });
  delete globalThis.document;
});

test('box: a rejected key reads like an unrecognised one, with the red outline on the key', async () => {
  const b = open();
  chrome.permissions = { request: async () => true };
  chrome.runtime = { sendMessage: async m => (m.type === 'testDest' ? { result: 'auth' } : undefined) };
  b.type(SM).btn.onclick();
  await new Promise(r => setTimeout(r, 10));
  const s = b.q();
  assert.deepEqual([s.row, s.input.classes.has('failed')], ['无法识别这个密钥。', true]);
  delete globalThis.document;
});

test('box: a rejected key on a self-hostable platform keeps 自己部署的？改地址 after the error; other failures do not', async () => {
  const run = async (key, result) => {
    const b = open();
    chrome.permissions = { request: async () => true };
    chrome.runtime = { sendMessage: async m => (m.type === 'testDest' ? { result } : undefined) };
    b.type(key).btn.onclick();
    await new Promise(r => setTimeout(r, 10));
    return b;
  };
  let b = await run(HSK, 'auth');
  assert.equal(b.q().row, '无法识别这个密钥。自己部署的？改地址');
  // 改地址 opens the address field; the error stays until something is typed.
  const s = b.click('lk c-own');
  assert.deepEqual(s.asks.map(e => e.value), ['https://api.hindsight.vectorize.io']);
  assert.equal(s.row, '无法识别这个密钥。');
  // Not for platforms without an address, not for network errors.
  assert.equal((await run(SM, 'auth')).q().row, '无法识别这个密钥。');
  assert.equal((await run(HSK, 'unreachable')).q().row, '无法连接 Hindsight，请检查网络。');
  delete globalThis.document;
});

test('box: the disclosure is always there, with the agree button pointing at it', () => {
  const b = open({ thresholdSec: 9 });
  let s = b.q();
  assert.equal(s.line, '你看过的网页会存到你连接的平台，方便以后找回：网址、标题、访问时间和停留时长；看满 9 秒的还有正文，含聊天对话。');
  assert.equal(s.btn.attrs['aria-describedby'], s.all.find(e => e.className === 'c-line').id);
  assert.equal(b.chip('Mem0').line, '你看过的网页会存到 Mem0，方便以后找回：网址、标题、访问时间和停留时长；看满 9 秒的还有正文，含聊天对话。');
  assert.equal(b.type(NSK).line, '你看过的网页会存到 Neurosea，方便以后找回：网址、标题、访问时间和停留时长；看满 9 秒（或视频播满 1 分钟）的还有正文，含聊天对话；视频还有播放记录、字幕和视频文件地址。');
  assert.equal(b.chip('Hindsight').line, '你看过的网页会存到 Hindsight，方便以后找回：网址、标题、访问时间和停留时长；看满 9 秒的还有正文，含聊天对话。');
  delete globalThis.document;
});

// --- 更换: the box with lock, under 地址 in a saved platform's 管理 panel ---

const change = (id, saved) => open({ mode: 'settings', thresholdSec: 9, lock: id, stored: () => saved });
const note = s => seen(s.all.find(e => e.className === 'c-note') ?? {});

test('更换: no disclosure, no visible label, the button says 连接, the key box asks for the new key', () => {
  const b = change('mem0', { kinds: ['read'], sites: [], userId: 'me', apiKey: 'old' });
  const s = b.q();
  assert.equal(s.line, '');
  assert.equal(s.btn.textContent, '连接');
  assert.equal(s.btn.attrs['aria-describedby'], undefined);
  assert.ok(!s.all.some(e => e.tagName === 'LABEL' && e.textContent === 'API 密钥'));
  assert.deepEqual([s.input.placeholder, s.input.attrs['aria-label']], ['贴上 Mem0 的新密钥', '贴上 Mem0 的新密钥']);
  // A refused permission names the button the user sees.
  assert.equal(failText('perm', resolveKey('fake_key_00000000000000', '', { lock: 'mem0' }), 'change'), '未获得权限。再点“连接”，选择“允许”。');
  delete globalThis.document;
});

test('更换: fields with a default show too, prefilled from the saved config (else the default), and are patched', async () => {
  let s = change('supermemory', { kinds: ['read'], sites: [], namespace: 'mine', apiKey: 'old' }).q();
  assert.deepEqual(s.asks.map(e => e.value), ['mine']);
  assert.ok(s.all.some(e => e.className === 'c-ask' && seen(e) === '命名空间'));
  s = change('mem0', { kinds: ['read'], sites: [], apiKey: 'old' }).q();
  assert.deepEqual(s.asks.map(e => e.value), ['afferent']);
  assert.deepEqual(change('hindsight', { kinds: ['read'], sites: [], url: 'http://10.0.0.5:8888', bank: 'b1', apiKey: 'old' }).q().asks.map(e => e.value),
    ['http://10.0.0.5:8888', 'b1']);
  assert.deepEqual(change('webhook', { kinds: ['read'], sites: [], url: 'http://a/p', token: 'x' }).q().asks, []);
  // Changed and connected: the new value goes into the patch; a bad one blocks the button and says why.
  const b = change('supermemory', { kinds: ['read'], sites: [], namespace: 'mine', apiKey: 'old' });
  b.type('sm_fake_key_00000000');
  const ns = b.q().asks[0];
  ns.value = 'bad space'; ns.on.input();
  assert.deepEqual([b.q().btn.disabled, b.q().row], [true, '只能用字母、数字和 _ : -']);
  ns.value = 'pages'; ns.on.input();
  const log = [];
  chrome.permissions = { request: async () => true };
  chrome.runtime = { sendMessage: async m => { log.push(m); return m.type === 'testDest' ? { result: 'ok' } : undefined; } };
  b.q().btn.onclick();
  await new Promise(r => setTimeout(r, 10));
  assert.deepEqual(log.at(-1), { type: 'patchDest', id: 'supermemory',
    patch: { enabled: true, name: null, apiKey: 'sm_fake_key_00000000', namespace: 'pages' } });
  // An emptied field with a default falls back to the default, as the old panel field did.
  ns.value = ''; ns.on.input();
  assert.equal(b.q().btn.disabled, false);
  assert.equal(resolveKey('sm_fake_key_00000000', '', { lock: 'supermemory', stored: () => ({ namespace: 'mine' }), asked: { namespace: '' } }).patch.namespace, 'afferent');
  delete globalThis.document;
});

test('更换: under the fields, Neurosea says the address changes with the key; others nothing', () => {
  assert.equal(note(change('webhook', { kinds: ['read'], sites: [], url: 'http://a/p', token: 'x' }).q()), '地址在密钥里，会一起换。');
  for (const id of ['supermemory', 'mem0', 'hindsight']) assert.equal(note(change(id, { kinds: ['read'], sites: [] }).q()), '', id);
  // The 添加平台 box has none.
  assert.equal(note(open({ mode: 'settings' }).type(NSK)), '');
  delete globalThis.document;
});

test('box: a pill click while connecting changes nothing', () => {
  globalThis.document = fakeDocument();
  chrome.permissions = { request: () => new Promise(() => {}) };
  const all = walk(createConnect({ mode: 'settings', thresholdSec: 10, onDone() {} }));
  const input = all.find(e => e.tagName === 'INPUT'), btn = all.find(e => e.className === 'c-btn');
  const pills = all.filter(e => e.className === 'c-pill');
  input.value = 'plainkey12345'; input.on.input();
  pills[2].onclick(); // Supermemory
  assert.equal(btn.disabled, false);
  btn.onclick();
  assert.deepEqual([btn.disabled, btn.textContent], [true, '正在连接…']);
  pills[1].onclick();
  assert.deepEqual([btn.disabled, btn.textContent, pills[2].attrs['aria-pressed']], [true, '正在连接…', 'true']);
  delete globalThis.document;
});

test('box: cancelled while connecting sends neither consent nor save, and calls no onDone; a newer box is untouched', async () => {
  globalThis.document = fakeDocument();
  const log = [];
  let answer;
  chrome.permissions = { request: async () => true };
  chrome.runtime = { sendMessage: m => { log.push(m.type); return m.type === 'testDest' ? new Promise(r => { answer = r; }) : Promise.resolve(); } };
  // The settings holder: onDone closes whatever box it holds.
  let holder = null;
  const open = () => {
    const box = createConnect({ mode: 'settings', thresholdSec: 10, onDone: () => { done.push(box); holder = null; } });
    box.isConnected = true;
    holder = box;
    return box;
  };
  const done = [];
  const old = open(), all = walk(old);
  const input = all.find(e => e.tagName === 'INPUT');
  input.value = SM; input.on.input();
  all.find(e => e.className === 'c-btn').onclick();
  await new Promise(r => setTimeout(r));
  assert.deepEqual(log, ['testDest']);
  old.isConnected = false; // 取消: the holder drops the box
  const fresh = open();
  answer({ result: 'ok' });
  await new Promise(r => setTimeout(r, 10));
  assert.deepEqual(log, ['testDest']);
  assert.deepEqual(done, []);
  assert.equal(holder, fresh);
  delete globalThis.document;
});

// --- fields a platform asks for before the first connect (Hindsight: server URL and bank) ---

const HSK = 'hsk_abcdefgh12';

test('resolve: ask-fields go into the config and, for a saved platform, into the patch', () => {
  assert.deepEqual(resolveKey(HSK, '').cfg, { enabled: true, kinds: ['read', 'glance'], sites: [], url: 'https://api.hindsight.vectorize.io',
    bank: 'afferent', apiKey: HSK });
  const asked = { url: 'http://10.0.0.5:8888', bank: 'pages' };
  assert.deepEqual(resolveKey('anykey12', 'hindsight', { asked }).cfg, { enabled: true, kinds: ['read', 'glance'], sites: [], ...asked, apiKey: 'anykey12' });
  // Replacing the key of a saved Hindsight keeps its server and bank unless the user changed them in the box.
  const old = { enabled: true, kinds: ['read'], sites: [], url: 'http://10.0.0.5:8888', bank: 'pages', apiKey: 'old' };
  const stored = id => (id === 'hindsight' ? old : undefined);
  const r = resolveKey('newkey12', '', { lock: 'hindsight', stored });
  assert.deepEqual(r.patch, { enabled: true, name: null, apiKey: 'newkey12', url: 'http://10.0.0.5:8888', bank: 'pages' });
  assert.deepEqual(resolveKey('newkey12', '', { lock: 'hindsight', stored, asked: { bank: 'b2' } }).patch.bank, 'b2');
  // Asked values only apply to the platform that asks for them.
  assert.deepEqual(resolveKey(SM, '', { asked }).cfg.url, undefined);
  // A URL that does not parse as http(s) cannot connect.
  for (const url of ['hs.example.com', 'ftp://x', 'http://']) assert.equal(resolveKey(HSK, '', { asked: { url } }).bad, 'fieldUrlBad', url);
  assert.equal(resolveKey(HSK, '', { asked }).bad, undefined);
  assert.equal('bad' in resolveKey(SM, ''), false);
});

test('click flow: ask values reach the permission, the test and the save; a refusal saves nothing', async () => {
  const log = [];
  chrome.permissions = { request: async p => { log.push(['perm', p.origins]); return true; } };
  let result = { result: 'ok' };
  chrome.runtime = { sendMessage: async m => { log.push([m.type, m]); return m.type === 'testDest' ? result : undefined; } };
  const res = resolveKey(HSK, '', { asked: { url: 'http://10.0.0.5:8888/', bank: 'pages' } });
  assert.deepEqual(await connect('settings', res), { cfg: res.cfg });
  assert.deepEqual(log[0], ['perm', ['http://10.0.0.5:8888/*']]);
  assert.deepEqual([log[1][1].cfg.url, log[1][1].cfg.bank], ['http://10.0.0.5:8888/', 'pages']);
  assert.deepEqual(log[3][1], { type: 'saveDest', id: 'hindsight', cfg: res.cfg });

  log.length = 0;
  result = { result: 'refused', message: 'hsRefuseExtracts' };
  assert.deepEqual(await connect('settings', res), { reason: 'refused', message: 'hsRefuseExtracts' });
  assert.deepEqual(log.map(x => x[0]), ['perm', 'testDest']);
  assert.equal(failText('refused', res, 'settings', 'hsRefuseExtracts'), '这个库会用模型提炼内容。换一个新的库名。');
  assert.equal(failText('refused', res, 'settings', 'hsRefuseSetup'), '这台 Hindsight 不让设置库，没法只存原文。');
});

const askInputs = all => all.filter(e => e.tagName === 'INPUT' && e.className.includes('c-ask-in'));

test('box: without lock the address hides behind 改地址, the bank never shows, and shown values are what gets saved', async () => {
  const log = [];
  chrome.permissions = { request: async p => { log.push(['perm', p.origins]); return true; } };
  chrome.runtime = { sendMessage: async m => { log.push([m.type, m]); return m.type === 'testDest' ? { result: 'ok' } : undefined; } };
  const b = open();
  for (const text of [CODE, SM, M0, HSK]) assert.deepEqual(b.type(text).asks, [], text);
  let s = b.click('lk c-own');
  assert.deepEqual(s.asks.map(e => e.value), ['https://api.hindsight.vectorize.io']);
  s.asks[0].value = 'http://10.0.0.5:8888'; s.asks[0].on.input();
  b.q().btn.onclick();
  await new Promise(r => setTimeout(r, 10));
  assert.deepEqual(log[0], ['perm', ['http://10.0.0.5:8888/*']]);
  assert.deepEqual(log.at(-1)[1].cfg, { enabled: true, kinds: ['read', 'glance'], sites: [], url: 'http://10.0.0.5:8888', bank: 'afferent', apiKey: HSK });
  // A bad URL disables the button and says why; an empty one only disables it.
  s = b.q();
  s.asks[0].value = 'not a url'; s.asks[0].on.input();
  s = b.q();
  assert.deepEqual([s.btn.disabled, s.row], [true, '地址要以 http:// 或 https:// 开头。']);
  s.asks[0].value = ''; s.asks[0].on.input();
  s = b.q();
  assert.deepEqual([s.btn.disabled, s.row], [true, '']);
  delete globalThis.document;
});

// The config the box would test when its button is clicked now.
const testedCfg = async b => {
  const log = [];
  chrome.permissions = { request: async () => true };
  chrome.runtime = { sendMessage: async m => { log.push(m); return m.type === 'testDest' ? { result: 'ok' } : undefined; } };
  b.q().btn.onclick();
  await new Promise(r => setTimeout(r, 10));
  return log.find(m => m.type === 'testDest')?.cfg;
};

test('box: emptying the key box keeps a typed self-hosted address', async () => {
  const b = open();
  b.type('hsk_fake_key_00000000');
  let s = b.click('lk c-own');
  s.asks[0].value = 'http://10.0.0.5:8888'; s.asks[0].on.input();
  b.type('');
  s = b.type('hsk_fake_key_00000000');
  assert.deepEqual([s.pressed, s.asks.map(e => e.value)], [['Hindsight'], ['http://10.0.0.5:8888']]);
  assert.equal((await testedCfg(b)).url, 'http://10.0.0.5:8888');
  delete globalThis.document;
});

test('box: with the address field open, a key shaped like another vendor\'s keeps the platform and address', async () => {
  for (const [chip, key, addr] of [['Hindsight', SM, 'http://10.0.0.5:8888'], ['Hindsight', M0, 'http://10.0.0.5:8888']]) {
    const b = open();
    b.chip(chip);
    let s = b.click('lk c-own');
    s.asks[0].value = addr; s.asks[0].on.input();
    s = b.type(key);
    assert.deepEqual([s.pressed, s.asks.map(e => e.value)], [[chip], [addr]], key);
    const cfg = await testedCfg(b);
    assert.deepEqual([cfg.url, cfg.apiKey], [addr, key], key);
  }
  delete globalThis.document;
});

test('box: an address typed into the field Hindsight opened by itself stays when an hsk_ key is pasted', async () => {
  const b = open();
  b.chip('Hindsight');
  let s = b.type('fake_key_00000000000000');
  s.asks[0].value = 'http://10.0.0.5:8888'; s.asks[0].on.input();
  s = b.type('hsk_fake_key_00000000');
  assert.deepEqual([s.pressed, s.asks.map(e => e.value)], [['Hindsight'], ['http://10.0.0.5:8888']]);
  assert.equal((await testedCfg(b)).url, 'http://10.0.0.5:8888');
  delete globalThis.document;
});

test('box: a chip clicked and no address field open, recognised text of another platform still switches', () => {
  const b = open();
  b.chip('Mem0');
  const s = b.type(SM);
  assert.deepEqual([s.pressed, s.asks], [['Supermemory'], []]);
  delete globalThis.document;
});

test('box: an ask-field typed in while connecting changes nothing', async () => {
  globalThis.document = fakeDocument();
  const log = [];
  chrome.permissions = { request: async () => true };
  chrome.runtime = { sendMessage: m => { log.push(m.type); return m.type === 'testDest' ? new Promise(() => {}) : Promise.resolve(); } };
  const root = createConnect({ mode: 'start', thresholdSec: 10, onDone() {} });
  root.isConnected = true;
  const input = walk(root).find(e => e.tagName === 'INPUT');
  input.value = HSK; input.on.input();
  walk(root).find(e => e.className === 'lk c-own').onclick();
  const btn = walk(root).find(e => e.className === 'c-btn');
  btn.onclick();
  await new Promise(r => setTimeout(r));
  const asks = askInputs(walk(root));
  assert.deepEqual(asks.map(e => e.readOnly), [true]);
  asks[0].value = 'http://other'; asks[0].on.input();
  assert.deepEqual([btn.disabled, btn.textContent, input.readOnly], [true, '正在连接…', true]);
  btn.onclick();
  await new Promise(r => setTimeout(r));
  assert.deepEqual(log, ['testDest']);
  delete globalThis.document;
});

test('box: an emptied ask-field is invalid, never a hidden fallback', async () => {
  for (const [i, msg] of [[0, '地址要以 http:// 或 https:// 开头。'], [1, '库名不能为空。']]) {
    globalThis.document = fakeDocument();
    const log = [];
    chrome.permissions = { request: async () => true };
    chrome.runtime = { sendMessage: async m => { log.push(m.type); return m.type === 'testDest' ? { result: 'ok' } : undefined; } };
    const old = { enabled: true, kinds: ['read'], sites: [], url: 'http://10.0.0.5:8888', bank: 'pages', apiKey: 'old' };
    const root = createConnect({ mode: 'settings', thresholdSec: 10, lock: 'hindsight', stored: () => old, onDone() {} });
    root.isConnected = true;
    const input = walk(root).find(e => e.tagName === 'INPUT');
    input.value = 'newkey12345'; input.on.input();
    const ask = askInputs(walk(root))[i];
    ask.value = '  '; ask.on.input();
    const all = walk(root), btn = all.find(e => e.className === 'c-btn');
    assert.equal(btn.disabled, true, msg);
    assert.equal(all.find(e => e.className === 'c-fail').textContent, msg);
    btn.onclick();
    await new Promise(r => setTimeout(r, 10));
    assert.deepEqual(log, [], msg);
    delete globalThis.document;
  }
  assert.equal(resolveKey(HSK, '', { asked: { url: '' } }).bad, 'fieldUrlBad');
  assert.equal(resolveKey(HSK, '', { asked: { bank: '' } }).bad, 'fieldBankBad');
});

test('box: replacing the key of a saved Hindsight prefills its server and bank, and patches them', async () => {
  globalThis.document = fakeDocument();
  const log = [];
  chrome.permissions = { request: async () => true };
  chrome.runtime = { sendMessage: async m => { log.push(m); return m.type === 'testDest' ? { result: 'ok' } : undefined; } };
  const old = { enabled: true, kinds: ['read'], sites: [], url: 'http://10.0.0.5:8888', bank: 'pages', apiKey: 'old' };
  const root = createConnect({ mode: 'settings', thresholdSec: 10, lock: 'hindsight', stored: () => old, onDone() {} });
  root.isConnected = true;
  assert.deepEqual(askInputs(walk(root)).map(e => e.value), ['http://10.0.0.5:8888', 'pages']);
  const input = walk(root).find(e => e.tagName === 'INPUT');
  input.value = 'newkey12345'; input.on.input();
  walk(root).find(e => e.className === 'c-btn').onclick();
  await new Promise(r => setTimeout(r, 10));
  assert.deepEqual(log.at(-1), { type: 'patchDest', id: 'hindsight',
    patch: { enabled: true, name: null, apiKey: 'newkey12345', url: 'http://10.0.0.5:8888', bank: 'pages' } });
  delete globalThis.document;
});

test('box: a refusal shows its message and saves nothing', async () => {
  globalThis.document = fakeDocument();
  const log = [];
  let done = 0;
  chrome.permissions = { request: async () => true };
  chrome.runtime = { sendMessage: async m => { log.push(m.type); return m.type === 'testDest' ? { result: 'refused', message: 'hsRefuseExtracts' } : undefined; } };
  const root = createConnect({ mode: 'start', thresholdSec: 10, onDone: () => done++ });
  root.isConnected = true;
  const input = walk(root).find(e => e.tagName === 'INPUT');
  input.value = HSK; input.on.input();
  walk(root).find(e => e.className === 'c-btn').onclick();
  await new Promise(r => setTimeout(r, 10));
  assert.deepEqual([log, done], [['testDest'], 0]);
  const fail = walk(root).find(e => e.className === 'c-fail');
  assert.deepEqual([fail.hidden, fail.textContent], [false, '这个库会用模型提炼内容。换一个新的库名。']);
  // The bank appears, prefilled, with the red outline on it rather than on the key.
  const asks = askInputs(walk(root));
  assert.deepEqual(asks.map(e => [e.value, e.classes.has('failed')]), [['afferent', true]]);
  assert.equal(input.classes.has('failed'), false);
  asks[0].value = 'pages'; asks[0].on.input();
  assert.deepEqual([askInputs(walk(root))[0].classes.has('failed'), fail.hidden], [false, true]);
  delete globalThis.document;
});
