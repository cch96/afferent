import { createCore } from './lib/core.js';

const core = createCore({
  store: chrome.storage.local,
  alarms: chrome.alarms,
  version: chrome.runtime.getManifest().version,
  setBadge: ({ text, color }) => { chrome.action.setBadgeText({ text }); chrome.action.setBadgeBackgroundColor({ color }); },
});
chrome.action.setBadgeTextColor({ color: '#FFFFFF' });

const ensureSweep = () => chrome.alarms.create('sweep', { periodInMinutes: 5 });

// 不记这个网站 in the page's right-click menu, on every web page, consent and pause aside: before consent too, a click adds the site to the list and deletes the captures of it still kept here,
// queuing that delete for Neurosea if it is connected.
// shortcut: it still shows on a page already skipped; under a whole-host rule a click there adds nothing, but still deletes any records of the host
// kept from before the rule (a host added in settings deletes none); a rule with a path (myaccount.google.com/apppasswords) or the page's adult
// label makes it add the whole host and delete its records; hide it per tab if that confuses.
const MENU = 'skipSite';

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  ensureSweep();
  core.dropShotLeftovers();
  if (reason === 'install') chrome.tabs.create({ url: 'src/ui/onboarding.html' });
  // removeAll first: an update or a reload must not leave a second item.
  await chrome.contextMenus.removeAll();
  chrome.contextMenus.create({ id: MENU, title: chrome.i18n.getMessage('popSkipSite'), contexts: ['page'],
    documentUrlPatterns: ['http://*/*', 'https://*/*'] });
});
// The patterns match the clicked frame, so an http(s) iframe on another extension's page shows it too.
chrome.contextMenus.onClicked.addListener(info => { if (info.menuItemId === MENU && /^https?:/.test(info.pageUrl)) core.skipSite(new URL(info.pageUrl).hostname); });
chrome.runtime.onStartup.addListener(() => { ensureSweep(); core.dropShotLeftovers(); core.startup(); });
chrome.tabs.onRemoved.addListener(tabId => core.tabRemoved(tabId));
chrome.alarms.onAlarm.addListener(a => core.alarm(a.name));

const UI_ORIGIN = chrome.runtime.getURL('');
const fromPage = {
  start: (m, s) => core.start(s.tab.id, m.url),
  report: (m, s) => core.report(s.tab.id, m),
};
// Only our own extension pages may change settings or read results; a page's content script may not.
const fromUi = {
  consent: m => core.consent(m.agree),
  setSettings: m => core.setSettings(m.patch),
  skipSite: m => core.skipSite(m.site),
  deleteCapture: m => core.deleteCapture(m.id),
  deleteWindow: m => core.deleteWindow(m.from, m.to, m.tabId),
  saveDest: m => core.saveDest(m.id, m.cfg),
  patchDest: m => core.patchDest(m.id, m.patch),
  removeDest: m => core.removeDest(m.id),
  testDest: m => core.testDest(m.id, m.cfg),
  retry: () => core.retry(),
};

chrome.runtime.onMessage.addListener((m, sender, reply) => {
  if (sender.id !== chrome.runtime.id) return;
  const ui = sender.url?.startsWith(UI_ORIGIN);
  const fn = ui ? fromUi[m?.type] : sender.tab && fromPage[m?.type];
  if (!fn) return;
  fn(m, sender).then(reply, e => reply({ error: String(e?.message || e) }));
  return true;
});

core.flush(); // every SW wake: resume any queue whose backoff has passed
