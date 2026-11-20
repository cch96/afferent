// The one paste box that connects a platform: first-run page (mode 'start') and settings (mode 'settings').
//
//   createConnect({ mode, thresholdSec, lock, stored, onDone }) → HTMLElement (div.connect)
//     mode          'start' | 'settings': title or label, button text
//     thresholdSec  seconds shown in the disclosure sentence
//     lock          optional platform id: 更换 in a saved platform's panel. The platform cannot change, the chips,
//                   label and disclosure are hidden, the button says 连接, and fields with a default show too
//     stored        optional id => saved config or undefined; a saved platform only gets its key and the box's fields patched
//     onDone({ id, cfg, name })      after testDest passed and consent + saveDest/patchDest were sent; never once
//                                    the box left the page (取消)
//   Chips pick the platform; text a platform recognises picks it too. Under the key one fixed row holds a hint,
//   an error, or gives way to the ask-fields (configFields with ask: true). Without lock those stay hidden and
//   use their default until 改地址, a refusal, or a self-hosted key (oddKeySelfHosted) opens them; with lock
//   all show, prefilled from the saved config, with Neurosea's note (the address is in the key) under them.
//   Callers may append buttons to .c-actions.
//   Styles: connect.css (start look by default; settings overrides under .connect.settings).
//
// Pure helpers (unit-tested): resolveKey, disclosure, failText, and connect() for the click flow.
import { t, send, el } from './common.js';
import { adapters, getAdapter, detectKey, destName } from '../adapters/index.js';

// The box's fields: ask-fields, and with lock also the other fields with a default (namespace, user id).
const boxFields = (a, lock) => a.configFields.filter(f => f.ask || lock && 'default' in f);
// Their values: typed in the box (an emptied ask-field stays empty, any other field falls back to its default),
// else saved, else the default.
const askValues = (id, asked, old, lock) => Object.fromEntries(boxFields(getAdapter(id), lock)
  .map(f => [f.name, f.name in asked ? asked[f.name] || (f.ask ? '' : f.default) : old?.[f.name] || f.default]));
const askOk = (f, v) => !!v && (f.type === 'url' ? /^https?:$/.test(URL.parse(v)?.protocol) : !f.pattern || new RegExp(`^(?:${f.pattern})$`).test(v));

// Text + manual pick → { id, cfg, patch, name, auto, kinds, bad? } or null. cfg is the config to test (and to save
// for a new platform), null if the picked platform cannot read the text (picked Neurosea, text is no URL).
// patch, for a platform stored() already has: only the credentials, the switch and the box's fields, so kinds and
// sites are whatever storage holds when it is applied. name: null clears an old name (undefined does not
// survive sendMessage). asked: what the user typed in the ask-fields, by
// name; their values go into cfg and patch. bad: the message key of the first ask-field whose value is invalid.
export function resolveKey(text, pick, { lock, stored = () => undefined, asked = {} } = {}) {
  const v = text.trim();
  if (!v) return null;
  const found = detectKey(v);
  // A chip click wins; the box drops the pick when recognised text is typed.
  const id = lock ?? (pick || found?.id || null);
  if (!id) return null;
  const a = getAdapter(id);
  const auto = found?.id === id;
  const parsed = auto ? found.cfg : a.fromKey(v, true);
  const old = stored(id);
  const extras = Object.fromEntries(a.configFields.filter(f => 'default' in f).map(f => [f.name, f.default]));
  const { name: _, ...kept } = old ?? {};
  const ask = askValues(id, asked, old, lock);
  const bad = boxFields(a, lock).find(f => !askOk(f, ask[f.name]));
  const cfg = parsed && { kinds: a.defaultKinds, sites: [], ...extras, ...kept, enabled: true, ...parsed, ...ask };
  const patch = old && parsed ? { enabled: true, name: null, ...parsed, ...ask } : undefined;
  return { id, cfg, ...(patch && { patch }), name: destName(id, parsed), auto, kinds: old?.kinds ?? a.defaultKinds,
    ...(bad && { bad: bad.label + 'Bad' }) };
}

// The "what is sent where" sentence. id null: no platform chosen yet.
export function disclosure({ thresholdSec, id, name, kinds }) {
  const thr = String(thresholdSec);
  if (!id) return t('connSentNone', [thr]);
  // Only the webhook gets the record's `media` (playback recording and subtitles).
  const hook = id === 'webhook', glance = kinds.includes('glance');
  const key = glance ? (hook ? 'connSentGlancePlay' : 'connSentGlance') : hook ? 'connSentReadPlay' : 'connSentRead';
  return t(key, [name, thr]);
}

// mode 'change': the settings box with lock.
const button = mode => t({ start: 'connStart', change: 'setChangeGo' }[mode] ?? 'connConnect');

// reason: 'perm' | 'auth' | 'unreachable' | 'refused' (message: the platform's locale key)
export function failText(reason, res, mode, message) {
  if (reason === 'refused') return t(message);
  if (reason === 'perm') return t('connFailPerm', [button(mode)]);
  if (reason === 'auth') return t('connNoMatch');
  return res.id === 'webhook' ? t('connFailHost', [new URL(res.cfg.url).host || res.name]) : t('connFailNet', [res.name]);
}

// Must be called straight from the click: the permission request is its first await.
// alive() false (the box was cancelled meanwhile): nothing is sent.
export async function connect(mode, res, alive = () => true) {
  let granted = false;
  try { granted = await chrome.permissions.request({ origins: getAdapter(res.id).origins(res.cfg) }); } catch {}
  if (!granted) return { reason: 'perm' };
  const r = await send({ type: 'testDest', id: res.id, cfg: res.cfg }).catch(() => null);
  if (r?.result === 'auth') return { reason: 'auth' };
  if (r?.result === 'refused') return { reason: 'refused', message: r.message };
  if (r?.result !== 'ok' && r?.result !== 'no_health') return { reason: 'unreachable' };
  if (!alive()) return { cancelled: true };
  // The disclosure plus the button is consent, on the first-run page and in settings alike.
  await send({ type: 'consent', agree: true });
  await send(res.patch ? { type: 'patchDest', id: res.id, patch: res.patch } : { type: 'saveDest', id: res.id, cfg: res.cfg });
  return { cfg: res.cfg };
}

// Chip order of the design: Hindsight first, any other adapter in registry order.
// Neurosea (webhook) has no chip until it opens to the public; a pasted key still picks it.
const FIRST = ['hindsight'];
const chipAdapters = [...FIRST.map(getAdapter), ...adapters.filter(a => !FIRST.includes(a.id) && a.id !== 'webhook')];

let seq = 0;
export function createConnect({ mode, thresholdSec, lock, stored, onDone }) {
  const id = 'connect-key-' + ++seq;
  let pick = '', phase = '', reason = '', message = '', res = null, askFor = null, askKey = null;
  // Per platform: what was typed in the ask-fields, and the fields opened by 改地址, by typing or by a refusal.
  let asked = {}, opened = new Set(), askIns = [];

  const input = el('input', { id, type: 'text', className: 'c-input', spellcheck: false, autocomplete: 'off' });
  const fail = el('p', { className: 'c-fail', hidden: true });
  fail.setAttribute('role', 'alert');
  const pills = chipAdapters.map(a => el('button', { type: 'button', className: 'c-pill', textContent: a.label,
    onclick: () => { if (phase !== 'connecting') { pick = a.id; phase = ''; update(); } } }));
  const picks = el('div', { className: 'c-picks', hidden: !!lock }, ...pills);
  picks.setAttribute('role', 'group');
  picks.setAttribute('aria-label', t('connPickGroup'));
  const asks = el('div', { className: 'c-asks' });
  const askRow = (f, value) => {
    const input = el('input', { id: `${id}-${f.name}`, type: 'text', className: 'c-input c-ask-in', spellcheck: false,
      autocomplete: 'off', value, placeholder: f.type === 'url' ? t('connAddrPh') : '' });
    askIns.push({ f, input });
    input.addEventListener('input', () => {
      if (phase !== 'connecting') {
        // Typing keeps the field and its value; a typed address pins the platform like 改地址.
        asked[f.name] = input.value.trim(); opened.add(f.name); if (f.type === 'url') pick = askFor;
        phase = ''; update();
      }
    });
    return el('label', { className: 'c-ask', htmlFor: input.id }, el('span', { textContent: t(f.label) }), input);
  };
  // The fixed row under the key: one hint, one error, or (in its place) the ask-fields above it.
  const help = el('span'), keyLink = el('a', { className: 'lk', target: '_blank', rel: 'noopener' });
  const own = el('span', { textContent: t('connSelfHosted') });
  const ownBtn = el('button', { type: 'button', className: 'lk c-own', textContent: t('connChangeAddr'),
    // Opening the address pins the platform, so a typed self-hosted address never gives way to a vendor's.
    onclick: () => { pick = askFor; opened.add('url'); update(); } });
  const row = el('div', { className: 'c-row' }, fail, help, keyLink, own, ownBtn);
  const line = el('p', { className: 'c-line', id: id + '-what' });
  const btn = el('button', { type: 'button', className: 'c-btn' });
  const kind = lock ? 'change' : mode;
  // 更换 sends no disclosure: the platform was agreed to when it was added.
  line.hidden = !!lock;
  if (!lock) btn.setAttribute('aria-describedby', line.id);
  if (mode === 'start') input.setAttribute('aria-label', t('connLabel'));
  const lockName = lock && destName(lock, stored?.(lock));
  if (lock) input.setAttribute('aria-label', t('setChangePh', [lockName]));
  const root = el('div', { className: 'connect ' + mode },
    mode === 'start' ? el('h1', { className: 'c-title', textContent: t('connTitle') }) : lock ? null : el('label', { htmlFor: id, textContent: t('connLabel') }),
    el('div', { className: 'c-field' }, picks, input, asks, lock === 'webhook' ? el('p', { className: 'c-note', textContent: t('setChangeNs') }) : null, row),
    el('div', { className: 'c-go' }, line, el('div', { className: 'c-actions' }, btn)));

  function update() {
    const text = input.value, v = text.trim(), long = v.length >= 8;
    const first = resolveKey(text, pick, { lock, stored });
    const pid = first?.id ?? lock ?? (pick || null);
    // An emptied key box (no platform) keeps what was typed and opened.
    if (pid && pid !== askFor) { askFor = pid; asked = {}; opened = new Set(); }
    const a = pid && getAdapter(pid);
    const fields = a ? boxFields(a, lock) : [];
    // Picked by hand and the key lacks the cloud's shape: a self-hosted server, whose key must never go to the cloud.
    const self = !lock && !!a?.oddKeySelfHosted && pick === pid && long && !!first?.cfg && !first.auto;
    // With lock (new key for a saved platform) every ask-field shows, prefilled from the saved config.
    const shown = fields.filter(f => lock || opened.has(f.name) || (self && f.type === 'url'));
    const vals = Object.fromEntries(shown.map(f => [f.name,
      self && f.type === 'url' && !(f.name in asked) ? '' : askValues(pid, asked, stored?.(pid), lock)[f.name]]));
    res = resolveKey(text, pick, { lock, stored, asked: vals });
    const key = [pid, self, ...shown.map(f => f.name)].join();
    // Rebuilt only when the set of fields changes, so typing keeps focus.
    if (key !== askKey) { askKey = key; askIns = []; asks.replaceChildren(...shown.map(f => askRow(f, vals[f.name]))); }

    const failed = phase === 'failed', refused = failed && reason === 'refused';
    const keyErr = long && (!pid ? 'connNoMatchPick' : !res?.cfg ? 'connNoMatch' : '');
    // An emptied field only blocks the button; lock keeps 0.6.1's message for it.
    const badF = shown.find(f => !askOk(f, vals[f.name]));
    const err = failed ? failText(reason, res, kind, message) : keyErr ? t(keyErr) : badF && (lock || vals[badF.name]) ? t(badF.label + 'Bad') : '';
    const ok = !!res?.cfg && !res.bad && long;
    fail.textContent = err;
    fail.hidden = !err;
    const quiet = !!err || shown.length > 0 || !!lock;
    help.hidden = quiet || (!!pid && !!v);
    help.textContent = t(pid ? 'connHintNoKey' : 'connHintPick');
    keyLink.hidden = help.hidden || !a?.keyPage;
    keyLink.href = a?.keyPage ?? '';
    keyLink.textContent = a ? t('connGetKey', [a.label]) : '';
    // A rejected key may be a self-hosted one: 改地址 stays after the error while the address is hidden.
    const authOwn = failed && reason === 'auth' && !shown.some(f => f.type === 'url');
    own.hidden = ownBtn.hidden = (quiet && !authOwn) || !fields.some(f => f.type === 'url');
    row.hidden = !err && (shown.length > 0 || !!lock);
    input.classList.toggle('failed', !!keyErr || (failed && !refused));
    input.placeholder = lock ? t('setChangePh', [lockName]) : a ? t('connPhFor', [a.label]) : t('connPh');
    input.readOnly = phase === 'connecting';
    for (const { f, input } of askIns) {
      input.readOnly = phase === 'connecting';
      input.classList.toggle('failed', refused && f.type !== 'url');
    }
    pills.forEach((p, i) => p.setAttribute('aria-pressed', String(pid === chipAdapters[i].id)));
    line.textContent = disclosure({ thresholdSec, id: pid, name: res?.name ?? a?.label,
      kinds: res?.kinds ?? stored?.(pid)?.kinds ?? a?.defaultKinds });
    btn.textContent = phase === 'connecting' ? t('connBusy') : button(kind);
    btn.disabled = !ok || phase === 'connecting';
    if (phase === 'connecting') btn.setAttribute('aria-busy', 'true'); else btn.removeAttribute('aria-busy');
  }

  input.addEventListener('input', () => {
    // Recognised text lights its own chip again, unless the user opened or typed the address.
    if (!opened.has('url') && detectKey(input.value.trim())) pick = '';
    phase = ''; update();
  });
  btn.onclick = () => {
    if (btn.disabled) return;
    const r = res;
    phase = 'connecting'; update();
    // isConnected: 取消 or the 更换 button removes the box; its late result must touch nothing.
    connect(mode, r, () => root.isConnected).catch(() => ({ reason: 'unreachable' })).then(out => {
      if (out.cancelled || !root.isConnected) return;
      if (out.reason) {
        // A refusal opens the platform's other ask-fields (Hindsight: the bank) for the user to change.
        if (out.reason === 'refused') for (const f of getAdapter(r.id).configFields) if (f.ask && f.type !== 'url') opened.add(f.name);
        phase = 'failed'; ({ reason, message } = out); update(); return;
      }
      phase = ''; update();
      onDone({ id: r.id, cfg: out.cfg, name: r.name });
    });
  };
  update();
  return root;
}
