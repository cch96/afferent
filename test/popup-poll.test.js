// Runs the real popup.js over stand-in DOM and chrome: while it is open it re-asks the page every second.
import test from 'node:test';
import assert from 'node:assert/strict';

const tick = () => new Promise(r => setImmediate(r));

test('popup: the "this page" card follows the page answer each second, then shows saved; the list redraws only on its own keys', async t => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const els = {};
  const node = () => ({
    style: {}, dataset: {}, hidden: false, className: '', textContent: '',
    classList: { add() {}, remove() {}, toggle() {} },
    setAttribute() {}, append() {}, replaceChildren() { this.draws = (this.draws ?? 0) + 1; }, querySelector: () => null, querySelectorAll: () => [],
    content: { cloneNode: () => node() },
  });
  globalThis.document = { documentElement: {}, getElementById: id => (els[id] ??= node()), createElement: node, querySelectorAll: () => [] };
  globalThis.addEventListener = () => {};
  let dwellMs = 0, changed;
  const asked = [];
  globalThis.chrome = {
    i18n: { getMessage: (k, subs) => k + (subs ? ':' + subs.join(',') : ''), getUILanguage: () => 'zh-CN' },
    runtime: { sendMessage: async () => null, openOptionsPage() {}, getURL: p => p },
    storage: { local: { get: async () => ({ settings: { consent: { agreed: true } } }) }, onChanged: { addListener: fn => { changed = fn; } } },
    tabs: {
      query: async () => [{ id: 7, url: 'https://e.com/a', title: 'A' }],
      sendMessage: async (id, m) => { asked.push([id, m.type]); return { url: 'https://e.com/a', title: 'A', capturing: true, dwellMs, thresholdMs: 10000 }; },
    },
  };
  await import('../src/ui/popup.js');
  const settle = async () => { for (let i = 0; i < 20; i++) await tick(); };
  await settle();
  assert.equal(els.fill.style.width, '0%');
  dwellMs = 4000;
  t.mock.timers.tick(1000);
  await settle();
  assert.equal(els.fill.style.width, '40%');
  assert.equal(els.big.textContent, 'popWait:10');
  dwellMs = 10000;
  t.mock.timers.tick(1000);
  await settle();
  assert.equal(els.fill.style.width, '100%');
  assert.equal(els.big.textContent, 'popSaved');
  assert.equal(els.done.style.display, '');
  assert.ok(asked.length >= 3 && asked.every(([id, type]) => id === 7 && type === 'state'), JSON.stringify(asked));
  // A draft written meanwhile must not rebuild the list (it would take keyboard focus away).
  const draws = els.rows.draws;
  changed({ 'v:1': {} }, 'local');
  await settle();
  assert.equal(els.rows.draws, draws);
  changed({ recent: {} }, 'local');
  await settle();
  assert.equal(els.rows.draws, draws + 1);
});
