// Settings: adding one of the user's own skip sites.
import test from 'node:test';
import assert from 'node:assert/strict';
import { addRule } from '../src/ui/skip-chips.js';

test('add: parsed, stored without scheme, duplicates ignored, junk refused', () => {
  assert.deepEqual(addRule(['a.com'], ' https://Mail.Company.com/inbox '), ['a.com', 'mail.company.com/inbox']);
  assert.deepEqual(addRule(['a.com'], 'http://a.com'), ['a.com']);
  assert.deepEqual(addRule([], '*.b.org'), ['b.org']);
  assert.equal(addRule(['a.com'], '   '), null);
  assert.equal(addRule(['a.com'], 'two words'), null);
  assert.equal(addRule(['a.com'], 'https://'), null);
});
