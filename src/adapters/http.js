// Shared by adapters: one fetch with a timeout, and the page text/metadata the memory platforms store.
import { sha256Hex } from '../lib/url.js';

const TIMEOUT_MS = 20000; // under the 25 s budget

// Resolves to the Response; throws on network error or timeout (see netDetail).
export async function request(url, init) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: ctl.signal, credentials: 'omit', cache: 'no-store' });
  } finally {
    clearTimeout(timer);
  }
}

export const netDetail = e => e.name === 'AbortError' ? 'timeout' : 'network error';

export async function json(res) {
  try { return await res.json(); } catch { return {}; }
}

export const pageContent = r => `${r.title}\n${r.url}` + (r.text ? `\n\n${r.text}` : '');

// Flat values only: both platforms reject or flatten nested metadata.
export const pageMetadata = r => ({ url: r.url, title: r.title, site: r.site, kind: r.kind,
  dwell_seconds: r.dwell_seconds, first_seen: r.first_seen, last_seen: r.last_seen, capture_id: r.capture_id,
  page_key: r.page_key, source: 'afferent' });

// The paid platforms bill each write, so a page whose content is byte-identical to the last write is
// skipped. Metadata (dwell, last_seen) is then not refreshed there. `key` is unique per page and scope.
// A glance has no text: on a page written before it would replace the full text with title + URL.
export async function unchanged(state, key, record, content) {
  const hash = await sha256Hex(content), stored = await state.get(key + '#sha');
  return { same: stored === hash || (record.kind === 'glance' && stored !== undefined),
    save: () => state.set(key + '#sha', hash) };
}

// Default status table. 413: this one page is too large, give it up; anything unlisted keeps the page queued.
export const classify = s => s >= 200 && s < 300 ? 'done' : s === 401 || s === 403 ? 'auth' : s === 413 ? 'failed' : 'retry';

export const UNCHANGED = { outcome: 'done', detail: 'unchanged' };
