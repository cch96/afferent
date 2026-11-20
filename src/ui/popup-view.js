// What the popup shows, as plain data: storage + the active tab + the content script's answer -> texts.
import { adapters, destName } from '../adapters/index.js';
import { ALWAYS_SKIP, matchingRule, skipRules } from '../lib/skip.js';
import { clampThr } from './settings-view.js';

const mmdd = ms => new Date(ms).toLocaleDateString('sv').slice(5);
const hhmm = ms => new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

export function fmtDwell(sec, t) {
  if (sec < 60) return t('popSec', [String(sec)]);
  if (sec < 3600) return t('popMin', [String(Math.floor(sec / 60))]);
  const h = String(Math.floor(sec / 3600)), m = Math.floor(sec % 3600 / 60);
  return m ? t('popHourMin', [h, String(m)]) : t('popHour', [h]);
}

// skipped: the site this popup's own card button put on the list; its card then offers nothing, so a second click lands on nothing.
function card(store, tab, page, t, skipped) {
  const s = store.settings || {};
  const off = note => ({ kind: 'off', big: t('popOff'), note, fill: 0, grey: true, done: false });
  if (!s.consent?.agreed) return { kind: 'start', big: t('popStart'), note: '', action: t('popConnect'), fill: 0, grey: false, done: false };
  if (s.paused) return { kind: 'paused', big: t('popPaused'), note: t('popPausedNote'), fill: 0, grey: true, done: false };
  if (!page) {
    return /^https?:/.test(tab?.url ?? '')
      ? { kind: 'refresh', big: t('popWait', [String(clampThr(s.thresholdSec))]), note: t('popRefresh'), fill: 0, grey: false, done: false }
      : off(t('popBrowser'));
  }
  const rule = matchingRule(page.url || tab?.url || '', skipRules(s));
  // A site added from this popup: the page says capturing until its next report.
  if (!page.capturing || rule) {
    // A built-in rule is not in the settings list, so 改名单 would lead nowhere.
    if (Object.values(ALWAYS_SKIP).flat().includes(rule)) return { ...off(t('popSkipBuiltIn', [rule])), kind: 'skipped' };
    return rule ? { ...off(t('popSkipRule', [rule])), kind: 'skipped', ...(rule !== skipped && { action: t('popEditList') }) } : off('');
  }
  const title = page.title || tab?.title || page.url;
  const site = new URL(page.url).hostname;
  const skip = site === skipped ? {} : { action: t('popSkipSite'), site };
  if (page.dwellMs >= page.thresholdMs) return { kind: 'saved', big: t('popSaved'), title, fill: 1, grey: false, done: true, ...skip };
  return { kind: 'reading', big: t('popWait', [String(Math.round(page.thresholdMs / 1000))]), title, fill: page.dwellMs / page.thresholdMs, grey: false, done: false, ...skip };
}

function banner(store, t) {
  for (const a of adapters) {
    const cfg = store['dest:' + a.id], st = store['dstate:' + a.id];
    if (!cfg?.enabled || !(st?.auth || st?.failures > 0)) continue;
    const subs = [destName(a.id, cfg), String((store['q:' + a.id] || []).length)];
    // An HTTP answer: the platform is up but did not take the page; say what it answered.
    if (!st.auth) return { kind: 'net', text: st.detail?.startsWith('HTTP ') ? t('popNotTaken', [...subs, st.detail]) : t('popNet', subs), button: t('popRetry') };
    return { kind: 'auth', text: t('popAuthKey', subs), button: t('popGoSettings') };
  }
  return null;
}

// late: 'queued' | 'failed' | 'local' (no platform took it: kept only here, never sent) | null.
function row(e, earlier, t) {
  const st = Object.values(e.status || {});
  const late = st.includes('queued') ? 'queued' : st.includes('failed') ? 'failed' : st.length ? null : 'local';
  const read = e.kind === 'read';
  let meta = !read ? t('popGlance') : e.dwell == null ? t('popReadOld') : t('popReadFor', [fmtDwell(e.dwell, t)]);
  if (e.redacted > 0) meta += ' · ' + t('popRedacted', [String(e.redacted)]);
  const when = { queued: 'popQueued', failed: 'popFailed', local: 'popLocal' }[late];
  return { id: e.id, title: e.title || e.url, url: e.url, site: e.site, meta, read, late, earlier,
    when: when ? t(when) : earlier ? mmdd(e.at) : hhmm(e.at) };
}

export function popupView({ store, tab, page, now, skipped }, t) {
  const c = card(store, tab, page, t, skipped);
  const started = c.kind !== 'start';
  const midnight = new Date(now).setHours(0, 0, 0, 0);
  // Today's rows, then every earlier capture (each can still be deleted on its own).
  const rows = started ? [...(store.recent || [])].sort((a, b) => b.at - a.at).map(e => row(e, e.at < midnight, t)) : [];
  const todays = rows.filter(r => !r.earlier);
  const b = started ? banner(store, t) : null;
  const today = store.today?.date === new Date(now).toLocaleDateString('sv') ? store.today.n : 0;
  const paused = !!store.settings?.paused;
  return {
    card: c,
    pause: started ? { paused, label: t(paused ? 'popResume' : 'popPause') } : null,
    banner: b,
    showList: started,
    count: t('popToday', [String(today)]),
    // Not in the spec's wording: an empty day, or a row today not sent anywhere, is not "delivered".
    // !late: the row has statuses and every one is 'sent'.
    delivered: todays.length > 0 && !b && todays.every(r => !r.late),
    rows,
    forget: forgetLine(store, t),
  };
}

// The delete dialog's ranges, in ms, ending now: 15 minutes, the last hour, today from local midnight, or everything.
export const windowRange = (kind, now) => ({ from: { 15: now - 900000, hour: now - 3600000, all: 0 }[kind] ?? new Date(now).setHours(0, 0, 0, 0), to: now });

// The dialog's line for the selected range. Neurosea counts while switched off: its forget job waits in the queue.
export function deleteWhat(kind, store, t) {
  const hook = store['dest:webhook'], all = kind === 'all';
  const there = adapters.filter(a => a.id !== 'webhook' && store['dest:' + a.id]).map(a => destName(a.id, store['dest:' + a.id]));
  return t(hook ? (all ? 'popDelAllHook' : 'popDelHook') : (all ? 'popDelAllLocal' : 'popDelLocal'), [destName('webhook', hook)])
    + (there.length ? t('popDelThere', [there.join(t('popSep'))]) : '');
}

// job: an entry of forgetq, or undefined while the popup's copy of storage has not caught up (so pending).
// The server hides; it does not erase, so this never says "deleted".
export function forgetText(job, store, t) {
  const name = destName('webhook', store['dest:webhook']), st = job?.status.webhook;
  if (st === 'done') return t('popForgetDone', [name]);
  if (st === 'failed') return t('popForgetFailed', [name, job.detail || '?']);
  return t('popForgetPending', [name]);
}

// One line while the newest forget job is not done.
function forgetLine(store, t) {
  const job = store.forgetq?.at(-1);
  return job && job.status.webhook !== 'done' ? { text: forgetText(job, store, t), failed: job.status.webhook === 'failed' } : null;
}

// answer: the service worker's {n, sentTo, forget} for deleteCapture or deleteWindow; job: the forget job it queued.
export function deleteNotice({ n, sentTo, forget }, job, store, t) {
  const parts = [n ? t('popDeletedN', [String(n)]) : t('popDeletedNone')];
  if (forget === 'queued') parts.push(forgetText(job, store, t));
  if (sentTo.length) parts.push(t('popDeleteThere', [sentTo.map(id => destName(id, store['dest:' + id])).join(t('popSep'))]));
  return parts.join('\n');
}

// answer: the service worker's {n, sentTo} for skipSite.
export function skipNotice(site, { n, sentTo }, store, t) {
  const parts = [n ? t('popSkippedN', [site, String(n)]) : t('popSkipped', [site])];
  if (sentTo.length) parts.push(t('popDeleteThere', [sentTo.map(id => destName(id, store['dest:' + id])).join(t('popSep'))]));
  return parts.join('\n');
}
