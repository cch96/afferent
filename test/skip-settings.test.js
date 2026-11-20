// Skip settings in storage: the always-on group, and the user's own sites (skipOwn). The optional groups left in 0.6.5:
// a group that was on (skipOn, or the ≤0.4.2 flat list settings.skip) comes back as its sites among the own sites.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createCore } from '../src/lib/core.js';
import { ALWAYS_SKIP, OPTIONAL_SKIP, ownSites, skipRules } from '../src/lib/skip.js';
import { fakeStore, fakeAlarms, fakeFetch } from './fakes.js';

// 0.4.1 and earlier: every group copied into settings.skip at consent, incl. the sign-in group 0.4.2 dropped.
const V041 = ['paypal.com', 'alipay.com', 'stripe.com', 'wise.com',
  'mail.google.com', 'outlook.live.com', 'outlook.office.com', 'outlook.office365.com', 'mail.qq.com', 'exmail.qq.com', 'mail.163.com', 'mail.126.com',
  'web.whatsapp.com', 'web.telegram.org', 'wx.qq.com', 'web.wechat.com', 'app.slack.com', 'discord.com', 'messenger.com',
  'feishu.cn/next/messenger', 'larksuite.com/next/messenger',
  '1password.com', 'bitwarden.com', 'lastpass.com', 'dashlane.com', 'keepersecurity.com',
  'accounts.google.com', 'login.microsoftonline.com', 'appleid.apple.com', 'github.com/login', 'github.com/sessions'];

function setup(settings) {
  const store = fakeStore({ 'dest:webhook': { enabled: true, url: 'http://127.0.0.1:9/hook', token: 't', kinds: ['read'] } });
  if (settings) store.data.settings = settings;
  globalThis.fetch = fakeFetch([]);
  return { store, core: createCore({ store, alarms: fakeAlarms(), version: '0.4.3' }) };
}
const captured = async (core, url) => (await core.start(1, 'https://' + url + '/')).capture;

test('fresh install, then consent: a rule added to the passwords group in code is skipped', async () => {
  const { core } = setup();
  await core.consent(true);
  const pw = ALWAYS_SKIP.passwords;
  pw.push('vault.example.com');
  try {
    assert.equal(await captured(core, 'vault.example.com'), false);
  } finally { pw.pop(); }
});

test('fresh install: payment, email and chat are captured; passwords are not', async () => {
  const { core } = setup();
  await core.consent(true);
  for (const u of ['mail.google.com', 'paypal.com', 'discord.com']) assert.equal(await captured(core, u), true, u);
  for (const u of ['1password.com', 'account.apple.com']) assert.equal(await captured(core, u), false, u);
});

test('fresh install: writes never store skip; own sites go to skipOwn, skipOn stays empty', async () => {
  const { core, store } = setup();
  await core.consent(true);
  assert.ok(!('skip' in store.data.settings));
  assert.deepEqual([store.data.settings.skipOwn, store.data.settings.skipOn], [[], []]);
  await core.skipSite('zhihu.com');
  const s = store.data.settings;
  assert.ok(!('skip' in s));
  assert.deepEqual([s.skipOwn, s.skipOn], [['zhihu.com'], []]);
  assert.equal(await captured(core, 'www.zhihu.com'), false);
});

test('a group that was on comes back as own sites, no duplicates, and its pages are still skipped', async () => {
  const st = { consent: { agreed: true }, skipOn: ['email'], skipOwn: ['intranet.example.com', 'mail.qq.com'] };
  const own = ['intranet.example.com', 'mail.qq.com', ...OPTIONAL_SKIP.email.filter(r => r !== 'mail.qq.com')];
  assert.deepEqual(ownSites(st), own);
  const { core, store } = setup(st);
  for (const u of ['mail.google.com', 'mail.qq.com', 'intranet.example.com', '1password.com', 'account.apple.com']) assert.equal(await captured(core, u), false, u);
  assert.equal(await captured(core, 'paypal.com'), true);
  // settings() hands out the converted shape, so the next write stores it.
  await core.setSettings({ paused: false });
  assert.deepEqual([store.data.settings.skipOn, store.data.settings.skipOwn], [[], own]);
});

test('old shape: the 0.4.1 list plus one own site converts every group to own sites', async () => {
  const groups = [...OPTIONAL_SKIP.payment, ...OPTIONAL_SKIP.email, ...OPTIONAL_SKIP.chat];
  assert.deepEqual(ownSites({ skip: [...V041, 'intranet.example.com'] }), ['intranet.example.com', ...groups]);
  const { core } = setup({ consent: { agreed: true }, skip: [...V041, 'intranet.example.com'] });
  assert.equal(await captured(core, 'account.apple.com'), false);
  assert.equal(await captured(core, 'accounts.google.com'), true);
  assert.equal(await captured(core, 'discord.com'), false);
});

test('old shape: a group removed entirely stays out; one entry removed brings the whole group; empty brings nothing', () => {
  const old = V041.filter(r => !OPTIONAL_SKIP.chat.includes(r) && r !== 'mail.qq.com');
  assert.deepEqual(ownSites({ skip: old }), [...OPTIONAL_SKIP.payment, ...OPTIONAL_SKIP.email]);
  assert.deepEqual(ownSites({ skip: [] }), []);
  assert.deepEqual(ownSites(undefined), []);
});

test('old shape: the first write persists the new shape and leaves the legacy skip list untouched', async () => {
  const old = [...V041, 'intranet.example.com'];
  const { core, store } = setup({ consent: { agreed: true }, thresholdSec: 20, skip: old });
  const before = JSON.stringify(old);
  await core.setSettings({ paused: true });
  await core.skipSite('zhihu.com');
  const s = store.data.settings;
  assert.equal(JSON.stringify(s.skip), before);
  assert.deepEqual([s.skipOn, s.skipOwn, s.thresholdSec, s.paused],
    [[], ['intranet.example.com', ...OPTIONAL_SKIP.payment, ...OPTIONAL_SKIP.email, ...OPTIONAL_SKIP.chat, 'zhihu.com'], 20, true]);
});

test('new shape with a full legacy skip list (0.4.2 restored defaults after a rollback): own comes from skipOwn only', async () => {
  const st = { consent: { agreed: true }, skipOn: ['email'], skipOwn: ['intranet.example.com'], skip: [...V041] };
  assert.deepEqual(ownSites(st), ['intranet.example.com', ...OPTIONAL_SKIP.email]);
  const { core } = setup(st);
  assert.equal(await captured(core, 'paypal.com'), true);
  assert.equal(await captured(core, 'accounts.google.com'), true);
  assert.equal(await captured(core, 'mail.google.com'), false);
  assert.equal(await captured(core, 'intranet.example.com'), false);
});

test('passwords cannot be turned off: skipOn with it or an unknown id changes nothing', async () => {
  for (const skipOn of [['passwords'], ['nope', 'constructor', '__proto__']]) {
    const { core } = setup({ consent: { agreed: true }, skipOwn: [], skipOn });
    assert.equal(await captured(core, '1password.com'), false);
    assert.equal(await captured(core, 'paypal.com'), true);
    assert.deepEqual(skipRules({ skipOn, skipOwn: [] }), Object.values(ALWAYS_SKIP).flat());
  }
});
