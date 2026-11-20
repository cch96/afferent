// The one paste box: connection codes and API keys recognised per platform.
import test from 'node:test';
import assert from 'node:assert/strict';
import { detectKey, destName, getAdapter } from '../src/adapters/index.js';

const webhook = getAdapter('webhook'), sm = getAdapter('supermemory'), m0 = getAdapter('mem0');
const TOK = 'Ab3+x/y==z';

test('connection code with and without a name', () => {
  assert.deepEqual(detectKey(`http://10.0.0.5:8070/afferent/v1/pages#token=${TOK}&name=Neurosea`),
    { id: 'webhook', cfg: { url: 'http://10.0.0.5:8070/afferent/v1/pages', token: TOK, name: 'Neurosea' } });
  assert.deepEqual(detectKey(`https://h.example/p#token=${TOK}`),
    { id: 'webhook', cfg: { url: 'https://h.example/p', token: TOK } });
});

test('encoded Chinese name is decoded', () => {
  assert.equal(detectKey('http://h:1/p#token=t&name=%E5%AE%B6%E9%87%8C').cfg.name, '家里');
});

test('token with + and = is kept verbatim', () => {
  assert.equal(webhook.fromKey(`http://h/p#token=${TOK}`).token, TOK);
});

test('plain URL: not detected, accepted when the platform was picked', () => {
  assert.equal(detectKey('http://h:1/hook'), null);
  assert.deepEqual(webhook.fromKey('http://h:1/hook', true), { url: 'http://h:1/hook', token: '' });
  assert.deepEqual(webhook.fromKey(' https://h/p#token=abc ', true), { url: 'https://h/p', token: 'abc' });
});

test('invalid URLs are refused', () => {
  for (const s of ['ftp://h/p#token=x', 'http://#token=x', 'not a url', ''])
    for (const picked of [false, true]) assert.equal(webhook.fromKey(s, picked), null, s);
  assert.equal(detectKey('http:// h/p#token=x'), null);
});

// Same vectors as the server's tests.
const NSK = [
  ['nsk_aHR0cHM6Ly9tZW1vcnkuZXhhbXBsZS50ZXN0L2FmZmVyZW50L3YxL3BhZ2Vz.fake_token_0000000000000000',
    'https://memory.example.test/afferent/v1/pages', 'fake_token_0000000000000000'],
  ['nsk_aHR0cDovLzE5Mi4wLjIuMTA6ODA3MC9hZmZlcmVudC92MS9wYWdlcw.fake-token_AbC-123_xyz000000',
    'http://192.0.2.10:8070/afferent/v1/pages', 'fake-token_AbC-123_xyz000000'],
];
const b64u = s => btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

test('nsk_ key: pasted alone picks Neurosea; picked by hand reads the same', () => {
  for (const [key, url, token] of NSK) {
    assert.deepEqual(detectKey(key), { id: 'webhook', cfg: { url, token } });
    assert.deepEqual(webhook.fromKey(` ${key} `, true), { url, token });
  }
});

test('nsk_ key: everything after the first dot is the token', () => {
  assert.deepEqual(webhook.fromKey(`nsk_${b64u('https://h.example/p')}.fake.tok.en`), { url: 'https://h.example/p', token: 'fake.tok.en' });
});

test('nsk_ key: bad base64url, a non-http URL or an empty token is refused', () => {
  for (const s of ['nsk_aHR0c*Ah.tok', 'nsk_aHR0cDovL2g+cA.tok', `nsk_${b64u('ftp://h/p')}.tok`, `nsk_${b64u('not a url')}.tok`,
    `nsk_${b64u('https://h/p')}.`, `nsk_${b64u('https://h/p')}`, 'nsk_.tok'])
    for (const picked of [false, true]) assert.equal(webhook.fromKey(s, picked), null, s);
});

test('nsk_ key: whitespace inside the token is a damaged key, refused', () => {
  for (const s of [`nsk_${b64u('https://h/p')}.tok en`, `nsk_${b64u('https://h/p')}.tok\nen`])
    for (const picked of [false, true]) assert.equal(webhook.fromKey(s, picked), null, s);
});

test('Supermemory and Mem0 keys', () => {
  assert.deepEqual(detectKey('sm_abcdefgh12'), { id: 'supermemory', cfg: { apiKey: 'sm_abcdefgh12' } });
  assert.deepEqual(detectKey('m0-abcdefgh12'), { id: 'mem0', cfg: { apiKey: 'm0-abcdefgh12' } });
  assert.equal(detectKey('sm_abc'), null);
  assert.equal(detectKey('m0-abc'), null);
  assert.equal(detectKey('random-key'), null);
  assert.deepEqual(sm.fromKey('anykey', true), { apiKey: 'anykey' });
  assert.deepEqual(m0.fromKey('anykey', true), { apiKey: 'anykey' });
  for (const a of [sm, m0]) { assert.equal(a.fromKey('', true), null); assert.equal(a.fromKey('a b', true), null); }
});

test('surrounding whitespace is trimmed', () => {
  assert.deepEqual(detectKey('  sm_abcdefgh12\n'), { id: 'supermemory', cfg: { apiKey: 'sm_abcdefgh12' } });
  assert.deepEqual(detectKey('\thttp://h/p#token=t&name=A \n'), { id: 'webhook', cfg: { url: 'http://h/p', token: 't', name: 'A' } });
});

test('destination names: the code name, else the platform label', () => {
  assert.equal(webhook.label, 'Neurosea');
  assert.equal(destName('webhook', { name: '家里' }), '家里');
  assert.equal(destName('webhook', {}), 'Neurosea');
  assert.equal(destName('mem0', undefined), 'Mem0');
});
