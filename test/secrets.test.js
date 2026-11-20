import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DEFAULT_RULES, parseRules, activeRules, redact } from '../src/lib/secrets.js';

// Samples are assembled at run time so no token-shaped literal sits in the repo.
const rep = (s, n) => s.repeat(Math.ceil(n / s.length)).slice(0, n);
const AN = 'aB3dE5fG7hJ9kL1mN2pQ4rS6tU8vW0xYz';
const b64 = rep('MIIEowIBAAKCAQEAx9Zr+q/Lm3', 64);
const HEX32 = '0123456789abcdef0123456789abcdef';
// id → [realistic sample, near miss (wrong length or prefix)]
const SAMPLES = {
  'aws-access-token': ['AKIA' + 'IOSFODNN7EXAMPLE', 'AKIA' + 'IOSFODNN7EXAMPL'],
  'github-pat': ['ghp_' + rep(AN, 36), 'ghp_' + rep(AN, 35)],
  'github-oauth': ['gho_' + rep(AN, 36), 'gho_' + rep(AN, 35)],
  'github-app-token': ['ghs_' + rep(AN, 36), 'ghx_' + rep(AN, 36)],
  'github-refresh-token': ['ghr_' + rep(AN, 36), 'ghr_' + rep(AN, 35)],
  'github-fine-grained-pat': ['github_pat_' + rep(AN, 22) + '_' + rep(AN, 59), 'github_pat_' + rep(AN, 40)],
  'gitlab-pat': ['glpat-' + rep('x-Y_z9', 20), 'glpat-' + rep('xYz9', 19)],
  'openai-api-key': ['sk-proj-' + rep(AN, 74) + 'T3BlbkFJ' + rep(AN, 74), 'sk-proj-' + rep(AN, 156)],
  'anthropic-api-key': ['sk-ant-api03-' + rep(AN + '-_', 93) + 'AA', 'sk-ant-api03-' + rep(AN, 40) + 'AA'],
  'anthropic-admin-api-key': ['sk-ant-admin01-' + rep(AN, 93) + 'AA', 'sk-ant-admin01-' + rep(AN, 95)],
  'gcp-api-key': ['AIza' + rep('Sy' + AN + '-_', 35), 'AIza' + rep(AN, 34)],
  'slack-bot-token': ['xoxb-1234567890-1234567890123-' + rep(AN, 24), 'xoxb-123-456-abc'],
  'slack-user-token': ['xoxp-1234567890-1234567890-1234567890-' + rep(AN, 32), 'xoxp-1234567890-' + rep(AN, 32)],
  'slack-app-token': ['xapp-1-A0123456789-1234567890123-' + rep('0123456789abcdef', 64), 'xapp-x-A01234-' + rep(AN, 20)],
  'slack-webhook-url': ['https://hooks.slack.com/services/T00000000/B00000000/' + rep(AN, 24), 'https://hooks.slack.com/services/T0/B0/x'],
  'stripe-live-key': ['sk_live_' + rep(AN, 24), 'sk_test_' + rep(AN, 24)],
  'npm-access-token': ['npm_' + rep(AN, 36), 'npm_' + rep(AN, 30)],
  'pypi-upload-token': ['pypi-AgEIcHlwaS5vcmc' + rep(AN, 60), 'pypi-AgEIcHlwaS5vcmc' + rep(AN, 20)],
  'huggingface-access-token': ['hf_' + rep('abcdEFGHijklMNOP', 34), 'hf_' + rep('abcdEFGH', 33)],
  'sendgrid-api-token': ['SG.' + rep(AN, 22) + '.' + rep(AN + '-_', 43), 'SG.' + rep(AN, 22) + '.' + rep(AN, 30)],
  'telegram-bot-api-token': ['123456789:AA' + rep(AN + '-_', 33), '123456789:AA' + rep(AN, 20)],
  'alibaba-access-key-id': ['LTAI' + rep(AN, 20), 'LTAI' + rep(AN, 19)],
  'tencent-secret-id': ['AKID' + rep(AN, 32), 'AKID' + rep(AN, 31)],
  'mem0-api-key': ['m0-' + rep(AN, 40), 'm0-' + rep(AN, 20)],
  'supermemory-api-key': ['sm_' + rep(AN, 22) + '_' + rep(AN, 64), 'sm_load_balancer_config_value'],
  'hindsight-api-key': ['hsk_' + HEX32, 'hsk_' + HEX32.slice(1)],
  'neurosea-key': ['nsk_' + rep(AN, 40) + '.' + rep(AN + '-_', 43), 'nsk_' + rep(AN, 40)],
  'neurosea-connection-code': ['#token=' + rep(AN + '-_', 43), '#token=abc'],
  'private-key': [`-----BEGIN RSA PRIVATE KEY-----\n${b64}\n${b64}\n-----END RSA PRIVATE KEY-----`,
    `-----BEGIN PUBLIC KEY-----\n${b64}\n-----END PUBLIC KEY-----`],
};

test('defaults: every rule has id, label, global pattern and a sample', () => {
  assert.ok(DEFAULT_RULES.length >= 20 && DEFAULT_RULES.length <= 30);
  for (const r of DEFAULT_RULES) {
    assert.ok(r.id && r.label && r.pattern instanceof RegExp && r.pattern.global, r.id);
    assert.ok(SAMPLES[r.id], 'no sample for ' + r.id);
  }
  assert.deepEqual(Object.keys(SAMPLES).sort(), DEFAULT_RULES.map(r => r.id).sort());
});

for (const [id, [hit, miss]] of Object.entries(SAMPLES)) {
  test(`rule ${id}: redacts a sample in context, leaves the near miss alone`, () => {
    const got = redact(`my key is ${hit}\nnext line`, DEFAULT_RULES);
    assert.equal(got.text, `my key is [redacted:${id}]\nnext line`);
    assert.equal(got.n, 1);
    const kept = redact(`my key is ${miss}\nnext line`, DEFAULT_RULES);
    assert.equal(kept.n, 0, `${id} near miss redacted as ${kept.text}`);
  });
}

const ZH = `今天下午我们讨论了新版本的发布计划。产品经理认为，用户最关心的是数据去了哪里，所以隐私说明要写得直白。
工程这边会先把浏览器扩展的读取逻辑整理清楚：只有页面在前台、窗口有焦点，并且停留超过十秒，才算真正读过。
对话页面需要单独处理，比如只保留用户和助手的发言，去掉侧边栏、按钮和输入框里的文字。
另外，网址里的追踪参数会在发送前去掉，同一篇文章不会因为来源不同而被当成两页。
最后，大家同意下周三之前完成手动测试，并在周五的例会上汇报结果。版本号暂定为 0.3.0，发布日期是 2026-11-20。`;

test('no redaction on ordinary text: README, docs and Chinese prose', () => {
  const files = ['README.md', 'PRIVACY.md', 'docs/webhook.md', 'docs/manual-test.md'];
  for (const f of files) {
    const s = readFileSync(new URL('../' + f, import.meta.url), 'utf8');
    assert.equal(redact(s, DEFAULT_RULES).n, 0, f);
  }
  assert.equal(redact(ZH, DEFAULT_RULES).n, 0);
});

test('built-in rules always fire; a user rule is added', () => {
  const s = `a ${SAMPLES['github-pat'][0]} b EMP-123456 c`;
  const rules = activeRules(['employee-id: EMP-\\d{6}']);
  assert.equal(redact(s, rules).text, 'a [redacted:github-pat] b [redacted:employee-id] c');
  assert.equal(redact(s, activeRules()).text, 'a [redacted:github-pat] b EMP-123456 c');
});

test('user rules: invalid regex, empty match and bad lines are reported', () => {
  assert.deepEqual(parseRules(['ok: a+b', '', '  ']).errors, []);
  assert.equal(parseRules(['ok: a+b']).rules[0].id, 'ok');
  for (const bad of ['broken: (unclosed', 'empty: x*', 'no colon here', ': nameless', 'bad name!: x']) {
    assert.deepEqual(parseRules([bad]).errors, [bad], bad);
  }
});

test('redacting 100000 chars with all defaults takes at most 50 ms', () => {
  const text = (ZH + readFileSync(new URL('../README.md', import.meta.url), 'utf8')).repeat(20).slice(0, 100000);
  const ms = [];
  for (let i = 0; i < 5; i++) { const t0 = performance.now(); redact(text, DEFAULT_RULES); ms.push(performance.now() - t0); }
  console.log(`redact 100000 chars: first ${ms[0].toFixed(1)} ms, runs ${ms.map(x => x.toFixed(1)).join(' ')}`);
  assert.ok(Math.max(...ms) <= 50, ms.join(' '));
});

// Rules that once ended on gitleaks' delimiter group: page text puts prose punctuation or CJK right after a key.
const END_RULES = ['openai-api-key', 'anthropic-api-key', 'anthropic-admin-api-key', 'gcp-api-key', 'stripe-live-key',
  'npm-access-token', 'huggingface-access-token', 'sendgrid-api-token', 'telegram-bot-api-token', 'alibaba-access-key-id'];

for (const id of END_RULES) {
  test(`rule ${id}: a key followed by prose punctuation or CJK is redacted`, () => {
    const [hit] = SAMPLES[id];
    for (const tail of ['，', '。', ',', '.', ')', '帮']) {
      assert.equal(redact(`我的 key 是 ${hit}${tail}帮我看看`, DEFAULT_RULES).text, `我的 key 是 [redacted:${id}]${tail}帮我看看`, JSON.stringify(tail));
    }
  });
}

// innerText adds nothing between adjacent inline elements: <span>Token</span><code>key</code><button>Copy</button>.
// Variable-length rules may take the glued letters into the mask, so only that they fire is checked.
const VARIABLE = ['stripe-live-key', 'gitlab-pat', 'slack-bot-token', 'slack-app-token', 'slack-user-token',
  'slack-webhook-url', 'pypi-upload-token', 'mem0-api-key', 'supermemory-api-key', 'hindsight-api-key', 'neurosea-key',
  'neurosea-connection-code'];

for (const [id, [hit]] of Object.entries(SAMPLES)) {
  if (id === 'private-key') continue;
  test(`rule ${id}: a key glued to the words around it is redacted`, () => {
    const got = redact(`Token${hit}Copy`, DEFAULT_RULES);
    assert.ok(got.n >= 1, `${id} missed: ${got.text}`);
    if (!VARIABLE.includes(id)) assert.equal(got.text, `Token[redacted:${id}]Copy`);
  });
}

test('no redaction on glued base64, hex, UUIDs, DNA/RNA sequences and prose', () => {
  const base64 = rep('Q29udGVudC1UeXBlOiB0ZXh0L3BsYWluOyBjaGFyc2V0PXV0Zi04DQpIZWxsbyB3b3JsZCE+/', 4000);
  const hex = rep('9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08', 64 * 8);
  const uuids = rep('123e4567-e89b-12d3-a456-426614174000f47ac10b-58cc-4372-a567-0e02b2c3d479', 72 * 10);
  const dna = rep('GCCACCATGGTGAGCAAGGGCGAGGAGCTGTTCACCGGG', 2000);
  const rna = dna.replaceAll('T', 'U');
  const en = `Click Copy to copy the token. Keep your API key secret and rotate it often.
Settings > Developer settings > Personal access tokens. Last used 3 days ago. Expires on 2026-12-31.`;
  for (const s of [base64, base64.toUpperCase(), hex, uuids, dna, rna, en, ZH, (en + ZH).replace(/[^\p{L}\p{N}]/gu, '')]) {
    const got = redact(s, DEFAULT_RULES);
    assert.equal(got.n, 0, got.text.slice(0, 200));
  }
});

test('own platforms: an old Neurosea connection code loses only its token; near misses stay', () => {
  const tok = rep(AN + '-_', 43);
  assert.equal(redact(`Code https://memory.example.com/afferent/v1/pages#token=${tok}&name=Home`, DEFAULT_RULES).text,
    'Code https://memory.example.com/afferent/v1/pages[redacted:neurosea-connection-code]&name=Home');
  for (const s of ['call sm_get_user_profile_by_id_v2 here', 'the nsk_value field', 'see page.html#token=abc&x=1', 'm0-config', 'hsk_short'])
    assert.equal(redact(s, DEFAULT_RULES).n, 0, s);
});

test('hindsight: only the real key shape (hsk_ + 32 hex, optional signature, hsk_sys_); HSK exam names stay', () => {
  for (const s of ['hsk_vocabulary_flashcards', 'hsk_standard_course_level_6-workbook', 'hsk_level_4_word_list_2024'])
    assert.equal(redact(`see ${s} here`, DEFAULT_RULES).n, 0, s);
  for (const k of ['hsk_' + HEX32, 'hsk_' + HEX32 + '_' + HEX32.slice(0, 16), 'hsk_sys_' + HEX32])
    assert.equal(redact(`key ${k} here`, DEFAULT_RULES).text, 'key [redacted:hindsight-api-key] here', k);
});

test('neurosea: a dotted (JWT-like) token is redacted whole', () => {
  const k = 'nsk_' + rep(AN, 40) + '.' + 'a'.repeat(24) + '.' + 'b'.repeat(24) + '.' + 'c'.repeat(24);
  assert.equal(redact(`key ${k} here`, DEFAULT_RULES).text, 'key [redacted:neurosea-key] here');
});
