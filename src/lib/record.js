import { normalizeUrl, pageKey } from './url.js';

export const MAX_TEXT = 100000;
export const MAX_BODY = 512 * 1024;
const MAX_DWELL_S = 604800, READ_PLAY_S = 60, MAX_MEDIA = 20, MAX_RANGES = 50, MAX_SUB_TEXT = 60000;

export function classify(dwellMs, thresholdMs, playS = 0) {
  if (playS >= READ_PLAY_S) return 'read';
  if (!(dwellMs > 0)) return null;
  return dwellMs >= thresholdMs ? 'read' : 'glance';
}

// Same 2048-char rule as the page url: cut the query, then give up.
export function fitUrl(url) {
  if (url && url.length > 2048) url = url.split('?')[0];
  return url && url.length <= 2048 ? url : null;
}

const r1 = x => Math.round(x * 10) / 10;
const num = x => (Number.isFinite(x) ? x : 0);

function shapeRanges(rs) {
  const merged = (Array.isArray(rs) ? rs : []).map(([a, b]) => [r1(num(a)), r1(num(b))]).filter(([a, b]) => b > a)
    .sort((x, y) => x[0] - y[0]).reduce((out, r) => {
      const p = out.at(-1);
      if (p && r[0] <= p[1] + 1) p[1] = Math.max(p[1], r[1]); else out.push(r);
      return out;
    }, []);
  if (merged.length <= MAX_RANGES) return merged;
  return merged.sort((x, y) => (y[1] - y[0]) - (x[1] - x[0])).slice(0, MAX_RANGES).sort((x, y) => x[0] - y[0]);
}

// Content-script media list -> contract entries. Runs before a draft is stored, so raw media URLs never touch disk.
export function shapeMedia(list, stripParams) {
  const out = (Array.isArray(list) ? list : []).map(e => {
    const play_s = Math.floor(num(e.playMs) / 1000), d = num(e.duration);
    const m = { kind: e.kind === 'audio' ? 'audio' : 'video' };
    const src = fitUrl(typeof e.src === 'string' ? normalizeUrl(e.src, stripParams) : null);
    if (src) m.src = src;
    Object.assign(m, { duration_s: d > 0 ? r1(d) : null, played: shapeRanges(e.played), heard: shapeRanges(e.heard), play_s,
      background_s: Math.min(Math.floor(num(e.bgMs) / 1000), play_s) });
    return m;
  }).filter(m => m.play_s >= 1);
  if (out.length <= MAX_MEDIA) return out;
  // What was heard is what Neurosea transcribes: on a feed of muted autoplay clips, the one heard must survive.
  const heardS = m => m.heard.reduce((n, [a, b]) => n + b - a, 0);
  const keep = new Set([...out].sort((a, b) => heardS(b) - heardS(a) || b.play_s - a.play_s).slice(0, MAX_MEDIA));
  return out.filter(m => keep.has(m));
}

// Content-script subtitle answer -> the contract's fields ({} when there is no status). Idempotent.
export function shapeSubs({ subtitles, subtitle_status: status, subtitle_error: error }) {
  if (status === 'error') return { subtitle_status: status, subtitle_error: cut(error, 100).toWellFormed() };
  if (status !== 'ok') return status ? { subtitle_status: status } : {};
  const t = subtitles[0];
  let left = MAX_SUB_TEXT;
  const lines = [];
  for (const l of Array.isArray(t.lines) ? t.lines : []) {
    const s = String(l?.[2] ?? '').toWellFormed();
    if (s.length > left) break; // later lines dropped
    left -= s.length;
    lines.push([r1(num(l[0])), r1(num(l[1])), s]);
  }
  return { subtitle_status: status, subtitles: [{ source: 'bilibili', lang: t.lang.toWellFormed(), auto: t.auto === true, lines }] };
}

// Content-script audio answer -> the audio contract's fields ({} when neither is usable). Idempotent.
// The URLs are signed: checked, never normalized or stripped of params.
const AUDIO_SOURCES = ['bilibili', 'xiaohongshu'];
const webUrl = u => typeof u === 'string' && u.length <= 4096 && /^https?:\/\//i.test(u) && URL.canParse(u);
export function shapeAudio({ audio: a, audio_error: error }) {
  const urls = Array.isArray(a?.urls) ? a.urls.filter(webUrl).slice(0, 4) : [];
  if (AUDIO_SOURCES.includes(a?.source) && urls.length)
    return { audio: { source: a.source, urls, expires: Number.isSafeInteger(a.expires) && a.expires > 0 ? a.expires : null } };
  return typeof error === 'string' ? { audio_error: cut(error, 100).toWellFormed() } : {};
}

// Cut to n UTF-16 units without leaving half a surrogate pair.
function cut(s, n) {
  s = String(s ?? '');
  if (s.length <= n) return s;
  s = s.slice(0, n);
  return /[\uD800-\uDBFF]$/.test(s) ? s.slice(0, -1) : s;
}

const bytes = o => new TextEncoder().encode(JSON.stringify(o)).length;

// draft: {id, url, title, lang, text, dwellMs, first, last} (times in ms since epoch). Returns null when no record.
export async function buildRecord(draft, thresholdMs, version, { stripParams = [] } = {}) {
  const media = draft.media ?? [];
  const kind = classify(draft.dwellMs, thresholdMs, media.reduce((n, m) => n + m.play_s, 0));
  const url = fitUrl(normalizeUrl(draft.url, stripParams));
  if (!kind || !url) return null;
  const first = draft.first ?? draft.last;
  const last = Math.max(draft.last ?? first, first);
  const rec = {
    schema: 'afferent.page/1',
    capture_id: draft.id,
    page_key: await pageKey(url),
    kind,
    url,
    title: cut(draft.title, 1000).toWellFormed(),
    site: new URL(url).hostname.toLowerCase(),
    // The page sends a margin past MAX_TEXT; the caller has redacted it, so this cut keeps no half secret.
    text: kind === 'read' ? cut(draft.text, MAX_TEXT).toWellFormed() : '',
    dwell_seconds: Math.min(Math.floor(draft.dwellMs / 1000), MAX_DWELL_S),
    first_seen: new Date(first).toISOString(),
    last_seen: new Date(last).toISOString(),
    client: { name: 'afferent', version: String(version).slice(0, 50) },
  };
  if (draft.lang && draft.lang.length <= 35) rec.lang = draft.lang;
  if (media.length) rec.media = media;
  Object.assign(rec, shapeSubs(draft), shapeAudio(draft));
  // Escape-heavy text can blow past the body limit even under the char cap. Page text gives way first.
  for (let lines = rec.subtitles?.[0].lines; bytes(rec) > MAX_BODY;) {
    if (rec.text) rec.text = cut(rec.text, Math.floor(rec.text.length * 0.8));
    else if (lines?.length) lines.length = Math.floor(lines.length * 0.8);
    else break;
  }
  return rec;
}
