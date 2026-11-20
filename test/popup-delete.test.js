// Runs the real popup.js over stand-in DOM and chrome: the window delete carries the popup's active tab id.
import test from 'node:test';
import assert from 'node:assert/strict';

const tick = () => new Promise(r => setImmediate(r));

// stateReply: what the page's content script answers to { type: 'state' }. query: a cache-busting suffix so each
// test runs popup.js afresh.
async function deleteHour(stateReply, query = '') {
  const els = {};
  const node = () => ({
    style: {}, dataset: {}, hidden: false, className: '', textContent: '', kids: [],
    classList: { add() {}, remove() {}, toggle() {} }, focus() {}, showModal() { this.open = true; }, close() { this.open = false; },
    setAttribute() {}, append() {}, replaceChildren(...k) { this.kids = k; }, querySelector: () => node(), querySelectorAll: () => [],
    content: { cloneNode: () => node() },
  });
  globalThis.document = { documentElement: {}, getElementById: id => (els[id] ??= node()), createElement: node, querySelectorAll: () => [] };
  globalThis.addEventListener = () => {};
  globalThis.setInterval = () => 0;
  const sent = [];
  globalThis.chrome = {
    i18n: { getMessage: k => k, getUILanguage: () => 'zh-CN' },
    runtime: { sendMessage: async m => { sent.push(m); return null; }, openOptionsPage() {}, getURL: p => p },
    storage: { local: { get: async () => ({ settings: { consent: { agreed: true } } }) }, onChanged: { addListener() {} } },
    tabs: {
      query: async () => [{ id: 7, url: 'https://e.com/a', title: 'A' }],
      sendMessage: stateReply,
    },
  };
  await import('../src/ui/popup.js' + query);
  const settle = async () => { for (let i = 0; i < 20; i++) await tick(); };
  await settle();
  els.del.onclick(); // the trash icon: 最近 1 小时 is preselected
  assert.equal(els.delDlg.open, true);
  els.delGo.onclick(); // 删除
  assert.equal(els.delDlg.open, false);
  await settle();
  const m = sent.find(x => x.type === 'deleteWindow');
  assert.ok(m, JSON.stringify(sent));
  return m;
}

test('popup: trash icon → 最近 1 小时 → 删除 sends deleteWindow with the active tab id', async () => {
  const m = await deleteHour(async () => ({ url: 'https://e.com/a', title: 'A', capturing: true, dwellMs: 0, thresholdMs: 10000 }));
  assert.equal(m.tabId, 7);
  assert.ok(m.to - m.from === 3600000);
});

test('popup: the delete carries the tab id even while the page never answers (blocked main thread)', async () => {
  const m = await deleteHour(() => new Promise(() => {}), '?hang');
  assert.equal(m.tabId, 7);
});
