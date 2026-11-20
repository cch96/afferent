import test from 'node:test';
import assert from 'node:assert/strict';
import { isSkipped, matchingRule, ALWAYS_SKIP, OPTIONAL_SKIP, parseRule } from '../src/lib/skip.js';

const rules = ['paypal.com', 'feishu.cn/next/messenger'];

test('domain and subdomains match', () => {
  assert.ok(isSkipped('https://paypal.com/x', rules));
  assert.ok(isSkipped('https://www.paypal.com/x', rules));
  assert.ok(isSkipped('https://a.b.PAYPAL.com/', rules));
});

test('look-alike domains do not match', () => {
  assert.ok(!isSkipped('https://notpaypal.com/', rules));
  assert.ok(!isSkipped('https://paypal.com.evil.io/', rules));
});

test('path prefix must match too', () => {
  assert.ok(isSkipped('https://abc.feishu.cn/next/messenger/chat/1', rules));
  assert.ok(isSkipped('https://feishu.cn/next/messenger', rules));
  assert.ok(!isSkipped('https://abc.feishu.cn/docx/123', rules));
  assert.ok(!isSkipped('https://feishu.cn/next/meeting', rules));
});

test('SPA URL change into and out of a skipped prefix is judged per visit', () => {
  const visits = ['https://x.feishu.cn/docx/1', 'https://x.feishu.cn/next/messenger/c/9', 'https://x.feishu.cn/wiki/2'];
  assert.deepEqual(visits.map(u => isSkipped(u, rules)), [false, true, false]);
});

test('rules tolerate scheme, wildcard and case', () => {
  assert.deepEqual(parseRule(' https://*.Example.com/A/ '), { domain: 'example.com', path: '/A/' });
  assert.equal(parseRule(''), null);
  assert.ok(isSkipped('https://sub.example.com/A/b', ['*.example.com']));
});

const ALL = [...Object.values(ALWAYS_SKIP), ...Object.values(OPTIONAL_SKIP)].flat();

test('groups: passwords always, payment, email and chat optional', () => {
  assert.deepEqual(Object.keys(ALWAYS_SKIP), ['passwords']);
  assert.deepEqual(Object.keys(OPTIONAL_SKIP), ['payment', 'email', 'chat']);
  for (const rs of Object.values(OPTIONAL_SKIP)) assert.ok(rs.length > 0);
  assert.ok(OPTIONAL_SKIP.chat.includes('larksuite.com/next/messenger'));
});

test('passwords: password managers and the Apple and Google app-password pages, no sign-in pages', () => {
  assert.deepEqual(ALWAYS_SKIP.passwords, ['1password.com', 'bitwarden.com', 'lastpass.com', 'dashlane.com', 'keepersecurity.com',
    'appleid.apple.com', 'account.apple.com', 'myaccount.google.com/apppasswords',
    'passwords.google.com', 'bitwarden.eu', '1password.eu', '1password.ca', 'pass.proton.me']);
  const all = ALL;
  for (const u of ['https://passwords.google.com/', 'https://vault.bitwarden.eu/#/vault', 'https://my.1password.eu/home',
    'https://my.1password.ca/home', 'https://pass.proton.me/u/0']) assert.ok(isSkipped(u, all), u);
  assert.equal(matchingRule('https://account.apple.com/account/manage', all), 'account.apple.com');
  assert.equal(matchingRule('https://myaccount.google.com/apppasswords', all), 'myaccount.google.com/apppasswords');
  assert.equal(matchingRule('https://accounts.google.com/v3/signin/identifier', all), null);
  assert.equal(matchingRule('https://myaccount.google.com/', all), null);
});

test('matchingRule returns the rule as written, or null', () => {
  assert.equal(matchingRule('https://www.paypal.com/x', rules), 'paypal.com');
  assert.equal(matchingRule('https://x.feishu.cn/next/messenger/1', rules), 'feishu.cn/next/messenger');
  assert.equal(matchingRule('https://example.com/', rules), null);
  assert.equal(matchingRule('not a url', rules), null);
  assert.ok(isSkipped('not a url', rules)); // unparsable stays skipped
});

test('a one-word rule covers its subdomains, as in 0.6.6', () => {
  assert.ok(isSkipped('http://dev/a', ['dev']));
  assert.ok(isSkipped('https://go.dev/doc', ['dev']));
  assert.ok(isSkipped('http://app.localhost/', ['localhost']));
  assert.ok(isSkipped('https://wiki.corp/x', ['corp']));
  assert.ok(isSkipped('https://wiki.corp/x', ['*.corp']));
});
