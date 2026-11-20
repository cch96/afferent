// The page's right-click item 不记这个网站: the real background.js over a stand-in chrome.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeStore, fakeFetch } from './fakes.js';

const tick = () => new Promise(r => setImmediate(r));
const settle = async () => { for (let i = 0; i < 20; i++) await tick(); };

test('created once on install and on update, for http(s) pages, always shown there; a click runs the action for the page\'s site', async () => {
  const on = {}, menus = [], updates = [], badges = [];
  const ev = name => ({ addListener: f => { on[name] = f; } });
  const store = fakeStore({ recent: [{ id: 'c1', site: 'news.example.com', url: 'https://news.example.com/a', at: 0, status: {} }] });
  const storageEv = ev('changed');
  globalThis.fetch = fakeFetch([]);
  globalThis.chrome = {
    storage: { local: store, onChanged: storageEv },
    alarms: { create() {}, clear() {}, onAlarm: ev('alarm') },
    runtime: { id: 'x', getManifest: () => ({ version: '0.6.6' }), getURL: p => 'chrome-extension://x/' + p,
      onInstalled: ev('installed'), onStartup: ev('startup'), onMessage: ev('message') },
    tabs: { onRemoved: ev('removed'), create() {}, query: async () => [] },
    action: { setBadgeText: b => badges.push(b.text), setBadgeBackgroundColor() {}, setBadgeTextColor() {} },
    i18n: { getMessage: k => k },
    contextMenus: { create: m => menus.push(m), removeAll: async () => { menus.length = 0; }, update: (id, p) => updates.push([id, p]), onClicked: ev('clicked') },
  };
  await import('../src/background.js');
  await on.installed({ reason: 'install' });
  await settle();
  assert.deepEqual(menus, [{ id: 'skipSite', title: 'popSkipSite', contexts: ['page'], documentUrlPatterns: ['http://*/*', 'https://*/*'] }]);

  on.changed?.({ settings: { newValue: { consent: { agreed: true }, paused: true } } });
  assert.deepEqual(updates, [], 'settings never change it');

  store.data.settings = { consent: { agreed: true }, skipOn: [], skipOwn: [] };
  await on.installed({ reason: 'update' });
  await settle();
  assert.equal(menus.length, 1, 'an update or reinstall never leaves two');

  badges.length = 0;
  on.clicked({ menuItemId: 'other', pageUrl: 'https://cook.example.org/' }, { id: 3 });
  // An http(s) iframe on another extension's page: Chrome matches the frame, but the site would be the extension id.
  on.clicked({ menuItemId: 'skipSite', pageUrl: 'chrome-extension://abcdefghijklmnop/newtab.html', frameUrl: 'https://ads.example.net/f' }, { id: 3 });
  await settle();
  assert.deepEqual(store.data.settings.skipOwn, [], 'a page that is not a web page adds nothing');
  on.clicked({ menuItemId: 'skipSite', pageUrl: 'https://News.Example.com/a?x=1' }, { id: 3 });
  await settle();
  assert.deepEqual(store.data.settings.skipOwn, ['news.example.com']);
  assert.deepEqual(store.data.recent, []);
  assert.ok(badges.length > 0, 'the badge follows');
});
