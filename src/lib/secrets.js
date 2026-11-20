// Secret redaction for page title and text, run in the service worker before a record is built.
// Most default patterns are adapted from gitleaks (MIT, Copyright (c) 2019 Zachary Rice),
// config/gitleaks.toml; see THIRD_PARTY_NOTICES.md. Rules marked "own" are not from gitleaks.
// gitlab-pat takes 20 or more chars: newer tokens are longer.
// Only prefix-anchored, high-precision formats: broad rules (JWT, generic "key = ...") would eat ordinary text.
// No word boundaries: page text often glues a key to the label or button next to it ("Tokenghp_...Copy").
// A fixed-length key is cut at its length; a variable-length one (Stripe, GitLab, Slack, PyPI) may take a
// few glued letters into the mask.

const rule = (id, label, src, flags = '') => ({ id, label, pattern: new RegExp(src, 'g' + flags) });

export const DEFAULT_RULES = [
  // A 16-char body made only of DNA/RNA letters is a sequence, not a key; a real base32 body is like that about once in 10^12.
  rule('aws-access-token', 'AWS access key ID', String.raw`(?:A3T[A-Z0-9]|AKIA|ASIA|ABIA|ACCA)(?![ACGTUN]{16})[A-Z2-7]{16}`),
  rule('github-pat', 'GitHub personal access token (ghp_)', String.raw`ghp_[0-9a-zA-Z]{36}`),
  rule('github-oauth', 'GitHub OAuth token (gho_)', String.raw`gho_[0-9a-zA-Z]{36}`),
  rule('github-app-token', 'GitHub app token (ghu_, ghs_)', String.raw`(?:ghu|ghs)_[0-9a-zA-Z]{36}`),
  rule('github-refresh-token', 'GitHub refresh token (ghr_)', String.raw`ghr_[0-9a-zA-Z]{36}`),
  rule('github-fine-grained-pat', 'GitHub fine-grained token (github_pat_)', String.raw`github_pat_\w{82}`),
  rule('gitlab-pat', 'GitLab personal access token (glpat-)', String.raw`glpat-[\w-]{20,}`),
  rule('openai-api-key', 'OpenAI API key', String.raw`(?:sk-(?:proj|svcacct|admin)-(?:[A-Za-z0-9_-]{74}|[A-Za-z0-9_-]{58})T3BlbkFJ(?:[A-Za-z0-9_-]{74}|[A-Za-z0-9_-]{58})|sk-[a-zA-Z0-9]{20}T3BlbkFJ[a-zA-Z0-9]{20})`),
  rule('anthropic-api-key', 'Anthropic API key (sk-ant-api03-)', String.raw`sk-ant-api03-[a-zA-Z0-9_-]{93}AA`),
  rule('anthropic-admin-api-key', 'Anthropic admin key (sk-ant-admin01-)', String.raw`sk-ant-admin01-[a-zA-Z0-9_-]{93}AA`),
  rule('gcp-api-key', 'Google API key (AIza)', String.raw`AIza[\w-]{35}`),
  rule('slack-bot-token', 'Slack bot token (xoxb-)', String.raw`xoxb-[0-9]{10,13}-[0-9]{10,13}[a-zA-Z0-9-]*`),
  rule('slack-user-token', 'Slack user token (xoxp-, xoxe-)', String.raw`xox[pe](?:-[0-9]{10,13}){3}-[a-zA-Z0-9-]{28,34}`),
  rule('slack-app-token', 'Slack app token (xapp-)', String.raw`xapp-\d-[A-Z0-9]+-\d+-[a-z0-9]+`, 'i'),
  rule('slack-webhook-url', 'Slack webhook URL', String.raw`(?:https?://)?hooks\.slack\.com/(?:services|workflows|triggers)/[A-Za-z0-9+/]{43,56}`),
  // gitleaks also matches test keys; only live keys move money.
  rule('stripe-live-key', 'Stripe live key (sk_live_, rk_live_)', String.raw`(?:sk|rk)_live_[a-zA-Z0-9]{10,99}`),
  rule('npm-access-token', 'npm token (npm_)', String.raw`npm_[a-zA-Z0-9]{36}`),
  rule('pypi-upload-token', 'PyPI upload token', String.raw`pypi-AgEIcHlwaS5vcmc[\w-]{50,1000}`),
  rule('huggingface-access-token', 'Hugging Face token (hf_)', String.raw`hf_[a-zA-Z]{34}`),
  rule('sendgrid-api-token', 'SendGrid API key (SG.)', String.raw`SG\.[a-zA-Z0-9=_.-]{66}`),
  // own: gitleaks needs a "telegram" keyword nearby; the bot id plus ":AA" and exact length stands alone.
  rule('telegram-bot-api-token', 'Telegram bot token', String.raw`[0-9]{8,10}:AA[a-zA-Z0-9_-]{33}`),
  rule('alibaba-access-key-id', 'Alibaba Cloud AccessKey ID (LTAI)', String.raw`LTAI[a-zA-Z0-9]{20}`),
  // own: Tencent Cloud SecretId is AKID plus 32 letters and digits; gitleaks has no rule for it.
  rule('tencent-secret-id', 'Tencent Cloud SecretId (AKID)', String.raw`AKID[a-zA-Z0-9]{32}`),
  // own: keys of the platforms Afferent sends to, so a key made in their console is not recorded with the page.
  rule('mem0-api-key', 'Mem0 API key (m0-)', String.raw`m0-[A-Za-z0-9]{32,}`),
  rule('supermemory-api-key', 'Supermemory API key (sm_)', String.raw`sm_[A-Za-z0-9]{16,}_[A-Za-z0-9]{32,}`),
  // Shape from hindsight-api 0.10.3 extensions/memory_defense.py: token_hex(16), optional hex signature, hsk_sys_ for
  // system keys. Looser shapes eat names like hsk_vocabulary_flashcards (HSK is also the Chinese proficiency exam).
  rule('hindsight-api-key', 'Hindsight API key (hsk_)', String.raw`hsk_(?:sys_)?[0-9a-f]{32}(?:_[0-9a-f]{8,})?`),
  // The token after the first dot may hold dots (docs/webhook.md), e.g. a JWT; a sentence's full stop may go too.
  rule('neurosea-key', 'Neurosea key (nsk_)', String.raw`nsk_[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_.-]{20,}`),
  // own: only the fragment; the receiver URL and &name= stay readable.
  rule('neurosea-connection-code', 'Neurosea connection code token (#token=)', String.raw`#token=[^\s&]{16,}`),
  rule('private-key', 'Private key (PEM block)', String.raw`-----BEGIN[ A-Z0-9_-]{0,100}PRIVATE KEY(?: BLOCK)?-----[\s\S]{64,}?KEY(?: BLOCK)?-----`, 'i'),
];

const NAME = /^[\w.-]{1,40}$/;

// lines: "name: regex", one user rule each. Bad lines come back in errors so Options can refuse to save.
export function parseRules(lines = []) {
  const rules = [], errors = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    const i = line.indexOf(':'), id = line.slice(0, i).trim(), src = line.slice(i + 1).trim();
    let pattern;
    try { pattern = i > 0 && NAME.test(id) && src && new RegExp(src, 'g'); } catch { pattern = null; }
    // A pattern that matches empty text would insert a marker between every character.
    if (!pattern || new RegExp(src).test('')) errors.push(line);
    else rules.push({ id, label: id, pattern });
  }
  return { rules, errors };
}

// Every built-in rule always applies; the user can only add.
export const activeRules = (custom = []) => [...DEFAULT_RULES, ...parseRules(custom).rules];

export function redact(s, rules) {
  let n = 0;
  for (const r of rules) s = s.replace(r.pattern, () => (n++, `[redacted:${r.id}]`));
  return { text: s, n };
}
