// Screenshots were removed in 0.6.9: an update or a browser start clears what an older build queued, through the real background.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeStore, fakeFetch } from './fakes.js';

const tick = () => new Promise(r => setImmediate(r));
const settle = async () => { for (let i = 0; i < 20; i++) await tick(); };

const leftovers = () => ({
  shotq: ['shot:c1:1', 'shot:c1:2'], 'shot:c1:1': { data: 'x' }, 'shot:c1:2': { data: 'y' }, 'shot:c2:1': { data: 'z' },
  shotday: { date: '2026-11-16', n: 3 },
});

test('an update and a browser start remove queued screenshots and the old switch; pages, drafts and other settings stay', async () => {
  const on = {};
  const ev = name => ({ addListener: f => { on[name] = f; } });
  const store = fakeStore({
    settings: { consent: { agreed: true }, skipOn: [], skipOwn: [], screenshots: true, thresholdSec: 20 },
    'r:c9': { capture_id: 'c9' }, 'q:webhook': ['c9'], 'v:c1': { id: 'c1', tabId: 1, url: 'https://a.example/' }, ...leftovers(),
  });
  globalThis.fetch = fakeFetch([]);
  globalThis.chrome = {
    storage: { local: store, onChanged: ev('changed') },
    alarms: { create() {}, clear() {}, onAlarm: ev('alarm') },
    runtime: { id: 'x', getManifest: () => ({ version: '0.6.9' }), getURL: p => 'chrome-extension://x/' + p,
      onInstalled: ev('installed'), onStartup: ev('startup'), onMessage: ev('message') },
    tabs: { onRemoved: ev('removed'), create() {}, query: async () => [] },
    action: { setBadgeText() {}, setBadgeBackgroundColor() {}, setBadgeTextColor() {} },
    i18n: { getMessage: k => k },
    contextMenus: { create() {}, removeAll: async () => {}, onClicked: ev('clicked') },
  };
  await import('../src/background.js');
  await on.installed({ reason: 'update' });
  await settle();
  const shotKeys = () => Object.keys(store.data).filter(k => k === 'shotq' || k === 'shotday' || k.startsWith('shot:'));
  assert.deepEqual(shotKeys(), []);
  assert.deepEqual(store.data.settings, { consent: { agreed: true }, skipOn: [], skipOwn: [], thresholdSec: 20 });
  assert.deepEqual(store.data['r:c9'], { capture_id: 'c9' });
  assert.deepEqual(store.data['q:webhook'], ['c9']);
  assert.ok(store.data['v:c1'], 'an update does not finalize open visits');

  Object.assign(store.data, leftovers());
  await on.startup();
  await settle();
  assert.deepEqual(shotKeys(), []);
});
