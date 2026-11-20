import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const dir = new URL('../_locales/', import.meta.url);
const locales = Object.fromEntries(readdirSync(dir).map(l => [l, readFileSync(new URL(l + '/messages.json', dir), 'utf8')]));

test('locales: same keys in zh_CN and en, and no 海纳 anywhere', () => {
  const keys = {};
  for (const [l, raw] of Object.entries(locales)) {
    assert.ok(!raw.includes('海纳'), l);
    keys[l] = Object.keys(JSON.parse(raw)).sort();
  }
  assert.deepEqual(keys.zh_CN, keys.en);
});

// Lowercase label/note values are adapter field keys, looked up with t(f.label).
test('locales: every literal t(...) and data-i18n key exists in both', () => {
  const src = new URL('../src/', import.meta.url), used = new Set();
  const files = readdirSync(src, { recursive: true }).filter(f => /\.(js|html)$/.test(f));
  for (const f of files) {
    const code = readFileSync(new URL(f, src), 'utf8');
    for (const m of code.matchAll(/\bt\('(\w+)'[,)]|data-i18n="(\w+)"|\b(?:label|note): '([a-z]\w*)'/g)) used.add(m[1] || m[2] || m[3]);
  }
  assert.ok(used.size > 50);
  for (const [l, raw] of Object.entries(locales)) {
    const have = JSON.parse(raw);
    assert.deepEqual([...used].filter(k => !have[k]), [], l);
  }
});

// Built at run time, so no literal names them: t(f.label + 'Bad') in connect.js.
const DYNAMIC = ['fieldNamespaceBad', 'fieldUrlBad', 'fieldBankBad'];

test('locales: every key is used (a quoted literal in src, __MSG_ in the manifest, or DYNAMIC)', () => {
  const src = new URL('../src/', import.meta.url);
  const code = readdirSync(src, { recursive: true }).filter(f => /\.(js|html)$/.test(f))
    .map(f => readFileSync(new URL(f, src), 'utf8')).join('\n') + readFileSync(new URL('../manifest.json', import.meta.url), 'utf8');
  const unused = Object.keys(JSON.parse(locales.en)).filter(k => !DYNAMIC.includes(k) && !new RegExp(`['"\`]${k}['"\`]|__MSG_${k}__`).test(code));
  assert.deepEqual(unused, []);
  for (const [l, raw] of Object.entries(locales)) assert.deepEqual(DYNAMIC.filter(k => !JSON.parse(raw)[k]), [], l);
});

test('locales: every consent sentence says it is to find pages later and names visit time and dwell', () => {
  const want = { zh_CN: ['方便以后找回', '访问时间', '停留时长'], en: ['find them later', 'when and how long'] };
  for (const [l, words] of Object.entries(want)) {
    const msgs = JSON.parse(locales[l]);
    for (const k of ['connSentGlance', 'connSentRead', 'connSentNone', 'connSentGlancePlay', 'connSentReadPlay'])
      for (const w of words) assert.ok(msgs[k].message.includes(w), `${l} ${k}: ${w}`);
  }
});

test('manifest: no optional <all_urls>', () => {
  const m = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
  assert.ok(!m.optional_host_permissions.includes('<all_urls>'));
});
