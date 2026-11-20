import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeUrl, pageKey } from '../src/lib/url.js';

test('drops fragment and sensitive params, keeps order and raw encoding', () => {
  assert.equal(
    normalizeUrl('https://Example.com/a/b?x=1&token=abc&y=a%20b+c&Access_Token=z#frag'),
    'https://example.com/a/b?x=1&y=a%20b+c');
});

test('code and fragment are dropped, state stays', () => {
  assert.equal(normalizeUrl('https://e.com/p?code=1&state=2#x'), 'https://e.com/p?state=2');
});

test('a lone code param leaves no trailing ?', () => {
  assert.equal(normalizeUrl('https://e.com/p?code=1#x'), 'https://e.com/p');
});

test('substring rule: names containing token/secret/password/signature', () => {
  assert.equal(normalizeUrl('https://e.com/?csrf_token=1&mySecretKey=2&oldPassword=3&reqSignatureV2=4&keep=5'),
    'https://e.com/?keep=5');
});

test('encoded names are decoded before matching', () => {
  assert.equal(normalizeUrl('https://e.com/?%74oken=1&%54OKEN=2&ok=3'), 'https://e.com/?ok=3');
  assert.equal(normalizeUrl('https://e.com/?api%5Fkey=2&ok=3'), 'https://e.com/?ok=3');
  assert.equal(normalizeUrl('https://e.com/?X-Amz-Signature=1&X%2DAmz%2DCredential=2&ok=3'), 'https://e.com/?ok=3');
});

test('repeated params: all sensitive copies removed, others kept', () => {
  assert.equal(normalizeUrl('https://e.com/?sid=1&a=1&sid=2&a=2'), 'https://e.com/?a=1&a=2');
});

test('exact list does not over-match (keyboard, statement stay)', () => {
  assert.equal(normalizeUrl('https://e.com/?keyboard=1&statement=2&q=code'), 'https://e.com/?keyboard=1&statement=2&q=code');
});

test('malformed escapes do not throw', () => {
  assert.equal(normalizeUrl('https://e.com/?%E0%A4%A=1&token%ZZ=2'), 'https://e.com/?%E0%A4%A=1&token%ZZ=2'.replace('&token%ZZ=2', ''));
});

test('non-http schemes are rejected', () => {
  assert.equal(normalizeUrl('chrome://settings'), null);
  assert.equal(normalizeUrl('file:///etc/passwd'), null);
  assert.equal(normalizeUrl('not a url'), null);
});

test('page_key is sha256 hex of the normalized url', async () => {
  assert.equal(await pageKey('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('username and password are removed', () => {
  assert.equal(normalizeUrl('https://user:pass@example.com/a?x=1#f'), 'https://example.com/a?x=1');
});

test('tracking params are stripped: utm_* by prefix and the known click ids', () => {
  assert.equal(normalizeUrl('https://e.com/a?id=7&utm_source=x&UTM_Medium=y&utm_whatever=z&fbclid=1&gclid=2&dclid=3'
    + '&gbraid=4&wbraid=5&msclkid=6&yclid=7&igshid=8&twclid=9&mc_cid=10&mc_eid=11&_hsenc=12&_hsmi=13&mkt_tok=14&spm=15'),
  'https://e.com/a?id=7');
});

test('generic names like ref and from are kept', () => {
  assert.equal(normalizeUrl('https://e.com/?ref=hn&from=home&utm=1'), 'https://e.com/?ref=hn&from=home&utm=1');
});

test('same page with and without utm_source has the same page_key', async () => {
  const a = normalizeUrl('https://e.com/post?p=1'), b = normalizeUrl('https://e.com/post?utm_source=news&p=1');
  assert.equal(a, b);
  assert.equal(await pageKey(a), await pageKey(b));
});

test('user-added names are stripped, case-insensitively, and only when passed in', () => {
  assert.equal(normalizeUrl('https://e.com/?Invite=9&x=1&tab=2', ['invite', ' TAB ']), 'https://e.com/?x=1');
  assert.equal(normalizeUrl('https://e.com/?invite=9&x=1'), 'https://e.com/?invite=9&x=1');
});

test('state and nonce are ordinary params and stay (e.g. GitHub ?state=closed)', () => {
  assert.equal(normalizeUrl('https://github.com/o/r/issues?state=closed'), 'https://github.com/o/r/issues?state=closed');
  assert.equal(normalizeUrl('https://e.com/cb?nonce=n1&x=1'), 'https://e.com/cb?nonce=n1&x=1');
});

// The 网址参数 ⓘ card in settings shows these two; keep its claim true.
test('settings card examples: token and key are dropped', () => {
  assert.equal(normalizeUrl('https://example.com/login?token=8f3k'), 'https://example.com/login');
  assert.equal(normalizeUrl('https://example.com/reset?key=4b7e'), 'https://example.com/reset');
});
