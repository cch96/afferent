// Runs the real popup.js over stand-in DOM and chrome: after the card's own 不记这个网站 the card offers nothing.
import test from 'node:test';
import assert from 'node:assert/strict';

const tick = () => new Promise(r => setImmediate(r));
const settle = async () => { for (let i = 0; i < 20; i++) await tick(); };

// settings: what storage holds when the popup opens. query: a cache-busting suffix so each test runs popup.js afresh.
async function open(settings, query) {
  const els = {}, sent = [];
  const node = () => ({
    style: {}, dataset: {}, hidden: false, className: '', textContent: '',
    classList: { add() {}, remove() {}, toggle() {} },
    setAttribute() {}, append() {}, replaceChildren() {}, querySelector: () => null, querySelectorAll: () => [],
    content: { cloneNode: () => node() },
  });
  globalThis.document = { documentElement: {}, getElementById: id => (els[id] ??= node()), createElement: node, querySelectorAll: () => [] };
  globalThis.addEventListener = () => {};
  globalThis.setInterval = () => 0;
  const store = { settings }, popup = { els, sent, store };
  globalThis.chrome = {
    i18n: { getMessage: k => k, getUILanguage: () => 'zh-CN' },
    runtime: { sendMessage: m => { sent.push(m); return new Promise(r => { popup.answer = r; }); }, openOptionsPage() { sent.push('options'); }, getURL: p => p },
    storage: { local: { get: async () => store }, onChanged: { addListener: fn => { popup.changed = fn; } } },
    tabs: {
      query: async () => [{ id: 7, url: 'https://news.example.com/a', title: 'A' }],
      sendMessage: async () => ({ url: 'https://news.example.com/a', title: 'A', capturing: true, dwellMs: 3000, thresholdMs: 10000 }),
    },
  };
  await import('../src/ui/popup.js' + query);
  await settle();
  return popup;
}

test('popup: the card button goes the moment it is clicked, and the skipped card it makes has no button', async () => {
  const p = await open({ consent: { agreed: true }, skipOn: [], skipOwn: [] }, '?own');
  assert.deepEqual([p.els.action.hidden, p.els.actionLabel.textContent], [false, 'popSkipSite']);
  p.els.action.onclick();
  assert.equal(p.els.action.hidden, true, 'a second click during the round trip finds nothing');
  p.store.settings = { ...p.store.settings, skipOwn: ['news.example.com'] };
  p.answer({ n: 1, sentTo: [] });
  p.changed({ settings: {} });
  await settle();
  // The click left the label as it was, so an empty label and the skipped texts show the card was drawn again.
  assert.deepEqual([p.els.action.hidden, p.els.actionLabel.textContent, p.els.big.textContent, p.els.sub.textContent],
    [true, '', 'popOff', 'popSkipRule'], 'the skipped card this click made, without 改名单');
});

test('popup: a site already skipped when the popup opens keeps 改名单', async () => {
  const p = await open({ consent: { agreed: true }, skipOn: [], skipOwn: ['news.example.com'] }, '?later');
  assert.deepEqual([p.els.action.hidden, p.els.actionLabel.textContent], [false, 'popEditList']);
});
