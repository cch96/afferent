// Service-worker logic with injected storage/alarms/clock so it runs unchanged under node tests.
// Storage keys (chrome.storage.local):
//   settings            {paused, thresholdSec, skipOn[] (always [] since 0.6.5), skipOwn[] (own sites), consent, stripParams[], secretRules[], recordPlayback,
//                        bilibiliSubs (the 字幕 switch, every site), skip[]}
//                       recordPlayback and shotIntervalSec have no control since 0.5.4: a stored recordPlayback false is still honoured,
//                       shotIntervalSec is ignored.
//                       secretsOff (per-rule switches before 0.5.5) is ignored: every built-in rule always applies.
//                       skip[] is the ≤0.4.2 flat list: read once to convert, never written, because older builds read it as their whole list.
//                       skipOn[] held the optional groups turned on (≤0.6.4); read once to convert, then written as [] so a
//                       rolled-back build neither turns a group back on nor falls back to skip[].
//   dest:<id>           destination config incl. token and sites[] (local only)
//   astate:<id>         adapter's own map: per page a content hash (Supermemory, Mem0) and Mem0's memory id
//   dstate:<id>         {failures, nextAt, auth, detail}
//   q:<id>              [capture_id] pending, in order
//   r:<capture_id>      record awaiting delivery (deleted once no queue holds it)
//   v:<capture_id>      open visit draft {id, tabId, url, title, text, lang, dwellMs, first, last, media[], subtitles,
//                       subtitle_status, subtitle_error, audio, audio_error, at}, or after a delete the tombstone {id, tabId, off: true}:
//                       its page gets {capture: false} until it navigates, and it never becomes a record
//   forgetq             [{id, body: afferent.forget/1 body, status: {webhook: pending|done|failed}, detail}], oldest first
//   shot:<cid>:<seq>, shotq, shotday, settings.screenshots: screenshots (≤0.6.8), removed by dropShotLeftovers
//   recent              last 100 captures for the popup, with how many secrets were redacted; first/last = visit times (ms);
//                       at = last seen (ms; finalize time in entries saved by older versions and for records without visit times)
//   today               {date, n}
import { adapters, getAdapter } from '../adapters/index.js';
import { isSkipped, skipRules, ownSites, onSite } from './skip.js';
import { normalizeUrl } from './url.js';
import { buildRecord, classify, shapeAudio, shapeMedia, shapeSubs } from './record.js';
import { activeRules, redact } from './secrets.js';

const BACKOFF_MS = 30e3, BACKOFF_CAP_MS = 30 * 60e3, HIDDEN_FINALIZE_MS = 30 * 60e3, RECENT_MAX = 100;
const FORGET = 'afferent.forget/1';

export function createCore({ store, alarms, now = Date.now, version, setBadge = () => {} }) {
  // Every read-modify-write of storage goes through this chain; fetches run outside it.
  let chain = Promise.resolve();
  const locked = fn => { const p = chain.then(fn); chain = p.catch(() => {}); return p; };
  const flushing = new Set();
  const iso = () => new Date(now()).toISOString();
  const day = () => new Date(now()).toLocaleDateString('sv');

  async function settings() {
    const { settings: s } = await store.get('settings');
    const out = { paused: false, thresholdSec: 10, consent: null, stripParams: [], secretRules: [], recordPlayback: true, bilibiliSubs: true, ...s };
    // 0.2.0 allowed 1-3600 s; the slider and every disclosure show 3-60, so capture uses the same.
    // Old-shape skip lists come back converted, so the next write stores the new shape.
    return { ...out, skipOn: [], skipOwn: ownSites(s), thresholdSec: Math.min(60, Math.max(3, out.thresholdSec)) };
  }

  async function enabledDests() {
    const got = await store.get(adapters.map(a => 'dest:' + a.id));
    return adapters.map(a => ({ a, cfg: got['dest:' + a.id] })).filter(d => d.cfg?.enabled);
  }

  // Settings if this URL may be captured right now, else null.
  async function allowed(url) {
    const s = await settings();
    return !s.consent?.agreed || s.paused || !normalizeUrl(url) || isSkipped(url, skipRules(s)) ? null : s;
  }

  const subsOn = s => s.recordPlayback && s.bilibiliSubs;

  // status null: an older version arrived while a newer one waits, so only got changes.
  // got: every destination that received any version, for a delete's sentTo.
  async function setStatus(cid, destId, status) {
    const { recent = [] } = await store.get('recent');
    const e = recent.find(x => x.id === cid);
    if (!e) return;
    if (status) e.status[destId] = status;
    if (status !== 'failed' && !e.got?.includes(destId)) e.got = [...(e.got ?? []), destId];
    await store.set({ recent });
  }

  async function dropIfUnqueued(cid) {
    const qs = await store.get(adapters.map(a => 'q:' + a.id));
    if (!Object.values(qs).some(q => q.includes(cid))) await store.remove('r:' + cid);
  }

  // playOnly: a read from playback alone; only the webhook's consent text names playback.
  // mid: a version sent while the visit stays open; only destinations that keep one copy per page (keepsLatest) take it,
  // and with none of them nothing happens. counted: an earlier version already added this visit to today.
  async function enqueue(rec, redacted = 0, playOnly = false, mid = false, counted = false) {
    // isSkipped is the shared rule matcher; here a match means "allowed".
    const dests = (await enabledDests()).filter(({ a, cfg }) => (!playOnly || a.id === 'webhook') && (!mid || a.keepsLatest)
      && (cfg.kinds ?? a.defaultKinds).includes(rec.kind) && (!cfg.sites?.length || isSkipped(rec.url, cfg.sites)));
    if (mid && !dests.length) return false;
    const status = {};
    if (dests.length) {
      await store.set({ ['r:' + rec.capture_id]: rec });
      for (const { a } of dests) {
        // Queued once: a newer version of a visit moves it to the tail.
        const { ['q:' + a.id]: q = [] } = await store.get('q:' + a.id);
        await store.set({ ['q:' + a.id]: [...q.filter(x => x !== rec.capture_id), rec.capture_id] });
        status[a.id] = 'queued';
      }
    }
    const { recent = [], today } = await store.get(['recent', 'today']);
    // Last seen, not finalize time: startup finalizes yesterday's open tabs today.
    const at = rec.last_seen ? Date.parse(rec.last_seen) : now();
    const row = { id: rec.capture_id, title: rec.title, site: rec.site, url: rec.url, kind: rec.kind, dwell: rec.dwell_seconds, at, status, redacted,
      ...(rec.first_seen && { first: Date.parse(rec.first_seen), last: Date.parse(rec.last_seen) }) };
    // One row per visit: a later version updates it in place.
    const i = recent.findIndex(e => e.id === rec.capture_id);
    if (i < 0) recent.unshift(row);
    else recent[i] = { ...row, status: { ...recent[i].status, ...status }, ...(recent[i].got && { got: recent[i].got }) };
    const n = (today?.date === day() ? today.n : 0) + (!counted && new Date(at).toLocaleDateString('sv') === day() ? 1 : 0);
    await store.set({ recent: recent.slice(0, RECENT_MAX), today: { date: day(), n } });
    return true;
  }

  // The record of the visit as it stands, with its redaction count, or null when it may not or need not be kept.
  async function build(d) {
    const s = await allowed(d.url);
    if (!s) return null;
    // Before buildRecord cuts the text, so a secret at the cut is never half-kept.
    const rules = activeRules(s.secretRules);
    const title = redact(d.title ?? '', rules), text = redact(d.text ?? '', rules);
    const media = s.recordPlayback ? d.media : undefined;
    // Off: the receiver must not fetch subtitles for this page either (YouTube's are fetched there).
    const subs = !s.bilibiliSubs ? { subtitle_status: 'off' } : subsOn(s) ? {} : { subtitle_status: undefined };
    if (!subsOn(s)) Object.assign(subs, { audio: undefined, audio_error: undefined });
    const rec = await buildRecord({ ...d, title: title.text, text: text.text, media, ...subs }, s.thresholdSec * 1000, version, { stripParams: s.stripParams });
    if (!rec) return null;
    return { rec, redacted: title.n + (rec.text ? text.n : 0), playOnly: rec.kind === 'read' && classify(d.dwellMs, s.thresholdSec * 1000) !== 'read' };
  }

  // Queued before the draft goes, so a stop in between leaves the draft for startup to finalize again.
  async function finalize(d) {
    const b = !d.off && await build(d);
    const queued = !!b && await enqueue(b.rec, b.redacted, b.playOnly, false, d.counted);
    await store.remove('v:' + d.id);
    return queued;
  }

  // A version of an open visit: like finalize, but the draft, its id and dwell go on. Marks d once counted.
  async function publish(d) {
    const b = await build(d);
    const queued = !!b && await enqueue(b.rec, b.redacted, b.playOnly, true, d.counted);
    if (queued) d.counted = true;
    return queued;
  }

  async function drafts(pred) {
    const keys = (await store.getKeys()).filter(k => k.startsWith('v:'));
    return Object.values(await store.get(keys)).filter(pred);
  }

  async function finalizeWhere(pred) {
    let any = false;
    for (const d of await drafts(pred)) any = (await finalize(d)) || any;
    return any;
  }

  // Per-destination adapter state; each access is one locked storage step.
  // shortcut: one object per destination, read and rewritten on every set; fine to ~10k pages, store one key per page past that.
  const stateFor = id => {
    const key = 'astate:' + id;
    return {
      get: k => locked(async () => (await store.get(key))[key]?.[k]),
      set: (k, v) => locked(async () => { const { [key]: m = {} } = await store.get(key); m[k] = v; await store.set({ [key]: m }); }),
    };
  };

  // sent: the JSON of the version that went out; a different stored r:<cid> is a newer version, which stays queued.
  async function applyResult(destId, cid, res, sent) {
    const sk = 'dstate:' + destId, qk = 'q:' + destId;
    const { [sk]: st = {}, [qk]: q = [], ['dest:' + destId]: cfg } = await store.get([sk, qk, 'dest:' + destId]);
    // Removed while the request was out: its answer must not bring back state for a platform that is gone.
    if (!cfg) return;
    if (res.outcome === 'done' || res.outcome === 'failed') {
      const { ['r:' + cid]: cur } = await store.get('r:' + cid);
      if (cur && JSON.stringify(cur) !== sent) {
        await store.set({ [sk]: { failures: 0 } });
        if (res.outcome === 'done') await setStatus(cid, destId, null);
        return;
      }
      await store.set({ [qk]: q.filter(x => x !== cid), [sk]: { failures: 0 } });
      await setStatus(cid, destId, res.outcome === 'done' ? 'sent' : 'failed');
      await dropIfUnqueued(cid);
    } else if (res.outcome === 'auth') {
      await store.set({ [sk]: { ...st, auth: true, detail: res.detail } });
    } else {
      const failures = (st.failures || 0) + 1;
      const nextAt = now() + Math.min(BACKOFF_MS * 2 ** (failures - 1), BACKOFF_CAP_MS);
      await store.set({ [sk]: { failures, nextAt, detail: res.detail } });
      alarms.create('flush:' + destId, { when: nextAt });
    }
  }

  async function settleForget(id, res) {
    const { forgetq = [] } = await store.get('forgetq');
    const j = forgetq.find(x => x.id === id);
    if (!j) return;
    j.status.webhook = res.outcome === 'done' ? 'done' : 'failed';
    if (res.outcome === 'failed') j.detail = res.detail;
    await store.set({ forgetq, 'dstate:webhook': { failures: 0 } });
  }

  // sel: {capture_ids} or {from, to, tabId?} in ms; tabId is the popup's active tab. Finds what it removes, queues the forget job, then removes it locally.
  // shortcut: settled jobs stay in forgetq for the popup's status; prune them if deletes ever become frequent.
  async function forget(sel) {
    // Queued while Neurosea is switched off too: flushOne holds it until it is switched back on.
    const { 'dest:webhook': hook } = await store.get('dest:webhook');
    const win = !sel.capture_ids;
    // By visit time, not finalize time: startup finalizes yesterday's drafts today.
    const hit = (id, first, last) => win ? first <= sel.to && last >= sel.from : sel.capture_ids.includes(id);
    const ids = new Set();
    const { recent = [], today } = await store.get(['recent', 'today']);
    for (const e of recent) if (hit(e.id, e.first ?? e.at, e.last ?? e.at)) ids.add(e.id);
    const recs = await store.get((await store.getKeys()).filter(k => k.startsWith('r:')));
    for (const r of Object.values(recs)) if (hit(r.capture_id, Date.parse(r.first_seen), Date.parse(r.last_seen))) ids.add(r.capture_id);
    // A window matches drafts that were seen, plus the popup's own tab: the owner is on it, maybe before its first report.
    const ds = await drafts(d => !d.off && (win && sel.tabId != null && d.tabId === sel.tabId
      || (!win || d.first != null) && hit(d.id, d.first, d.last ?? d.first)));
    for (const d of ds) ids.add(d.id);
    // From every matched id: an open visit's row keeps the time of its last version, which may be outside the window.
    const gone = recent.filter(e => ids.has(e.id));
    if (hook) {
      // A window rule also lists what it removes: old entries matched by finalize time, and the purged open visits.
      const body = { schema: FORGET, ...(win ? { from: new Date(sel.from).toISOString(), to: new Date(sel.to).toISOString(), capture_ids: [...ids] }
        : { capture_ids: sel.capture_ids }) };
      const { forgetq = [] } = await store.get('forgetq');
      forgetq.push({ id: crypto.randomUUID(), body, status: { webhook: 'pending' } });
      await store.set({ forgetq });
    }
    for (const d of ds) await store.set({ ['v:' + d.id]: { id: d.id, tabId: d.tabId, off: true } });
    await store.set({ recent: recent.filter(e => !gone.includes(e)) });
    if (today?.date === day() && win && sel.from <= new Date(now()).setHours(0, 0, 0, 0)) await store.set({ today: { ...today, n: 0 } });
    else {
      const nToday = gone.filter(e => new Date(e.at).toLocaleDateString('sv') === today?.date).length;
      if (nToday) await store.set({ today: { ...today, n: Math.max(0, today.n - nToday) } });
    }
    for (const a of adapters) {
      const { ['q:' + a.id]: q = [] } = await store.get('q:' + a.id);
      await store.set({ ['q:' + a.id]: q.filter(x => !ids.has(x)) });
    }
    for (const id of ids) await store.remove('r:' + id);
    return { n: ids.size, sentTo: adapters.filter(a => (a.id !== 'webhook' || !hook) && gone.some(e => e.status[a.id] === 'sent' || e.got?.includes(a.id))).map(a => a.id),
      forget: hook ? 'queued' : 'none' };
  }
  // The popup answers at once; the forget request goes out in the background (it can take 20 s on a dead host).
  const del = async fn => {
    const r = await locked(fn);
    flush('webhook').catch(() => {});
    await badge();
    return r;
  };

  async function flushOne(a) {
    if (flushing.has(a.id)) return; // the running loop will pick up new records
    flushing.add(a.id);
    try {
      for (;;) {
        const job = await locked(async () => {
          const keys = ['dest:' + a.id, 'dstate:' + a.id, 'q:' + a.id];
          const { [keys[0]]: cfg, [keys[1]]: st = {}, [keys[2]]: q = [] } = await store.get(keys);
          if (!cfg?.enabled || st.auth || st.nextAt > now()) return null;
          if (a.id === 'webhook') {
            const { forgetq = [] } = await store.get('forgetq');
            const f = forgetq.find(j => j.status.webhook === 'pending');
            if (f) return { forget: f, cfg };
          }
          if (!q.length) return null;
          const { ['r:' + q[0]]: rec } = await store.get('r:' + q[0]);
          if (!rec) { await store.set({ [keys[2]]: q.slice(1) }); return 'skip'; }
          return { rec, cfg };
        });
        if (!job) break;
        if (job === 'skip') continue;
        if (job.forget) {
          let res;
          try { res = await a.forget(job.forget.body, job.cfg); } catch { res = { outcome: 'retry', detail: 'adapter error' }; }
          await locked(() => res.outcome === 'done' || res.outcome === 'failed' ? settleForget(job.forget.id, res) : applyResult(a.id, null, res));
          if (res.outcome === 'retry' || res.outcome === 'auth') break;
          continue;
        }
        let res;
        const sent = JSON.stringify(job.rec);
        try { res = await a.send(job.rec, job.cfg, stateFor(a.id)); } catch { res = { outcome: 'retry', detail: 'adapter error' }; }
        await locked(() => applyResult(a.id, job.rec.capture_id, res, sent));
        if (res.outcome === 'retry' || res.outcome === 'auth') break;
      }
    } finally {
      flushing.delete(a.id);
    }
    await badge();
  }

  async function badge() {
    const got = await store.get([...adapters.map(a => 'dstate:' + a.id), 'today']);
    const bad = adapters.some(a => { const s = got['dstate:' + a.id]; return s?.auth || s?.failures > 0; });
    const n = got.today?.date === day() ? got.today.n : 0;
    setBadge(bad ? { text: '!', color: '#AA4539' } : (await settings()).paused ? { text: 'Ⅱ', color: '#7B6659' }
      : { text: n ? String(n) : '', color: '#A0583A' });
  }

  async function putDest(id, cfg) {
    await store.set({ ['dest:' + id]: cfg, ['dstate:' + id]: { failures: 0 } });
    alarms.clear('flush:' + id);
  }

  const flush = async (id) => { for (const a of adapters) if (!id || a.id === id) await flushOne(a); await badge(); };
  // Run fn under the lock; flush afterwards if it queued something.
  const thenFlush = async fn => { const r = await locked(fn); if (r?.queued) await flush(); return r?.reply; };

  return {
    flush,
    enqueue: rec => thenFlush(async () => ({ queued: await enqueue(rec) })),

    start: (tabId, url) => locked(async () => {
      const s = await allowed(url);
      if (!s) return { capture: false };
      // Only Neurosea ever receives subtitles: without it the page must not fetch them.
      const { 'dest:webhook': hook } = await store.get('dest:webhook');
      const id = crypto.randomUUID();
      // Store the normalized URL so tokens never touch disk, even in drafts.
      await store.set({ ['v:' + id]: { id, tabId, url: normalizeUrl(url, s.stripParams), dwellMs: 0, first: null, last: null, at: now() } });
      return { capture: true, id, thresholdMs: s.thresholdSec * 1000, media: s.recordPlayback, subs: !!hook?.enabled && subsOn(s) };
    }),

    report: (tabId, m) => thenFlush(async () => {
      const key = 'v:' + m.id;
      const { [key]: prev } = await store.get(key);
      if (prev?.off) return { reply: { capture: false } };
      const s = await allowed(prev?.url ?? m.url);
      if (!s) { await store.remove(key); return { reply: { capture: false } }; }
      // Unknown id: the visit was already finalized (sweep); the page must start a new one.
      if (!prev) return { reply: { restart: true } };
      const d = { ...prev, dwellMs: m.dwellMs, first: m.first, last: m.last, at: now() };
      for (const k of ['title', 'text', 'lang']) if (m[k] !== undefined) d[k] = m[k];
      // Normalized here, before the draft is stored, like the page URL in start.
      if (!s.recordPlayback) delete d.media;
      else if (m.media !== undefined) d.media = shapeMedia(m.media, s.stripParams);
      if (subsOn(s) && m.subtitle_status !== undefined) Object.assign(d, shapeSubs(m));
      // Same gate as start's subs: only Neurosea ever gets the sound's address. Signed URLs: shaped, never normalized.
      if (subsOn(s) && (m.audio !== undefined || m.audio_error !== undefined)
        && (await store.get('dest:webhook'))['dest:webhook']?.enabled) Object.assign(d, shapeAudio(m));
      if (m.end) return { queued: await finalize(d), reply: { capture: true } };
      const queued = m.publish && await publish(d);
      await store.set({ [key]: d });
      return { queued, reply: { capture: true, thresholdMs: s.thresholdSec * 1000 } };
    }),

    tabRemoved: tabId => thenFlush(async () => ({ queued: await finalizeWhere(d => d.tabId === tabId) })),
    // Browser start: tab ids from the last session are gone, so every open draft is finished.
    startup: () => thenFlush(async () => ({ queued: await finalizeWhere(() => true) })),

    alarm: async name => {
      // Tombstones stay until the tab closes, so a late report from their page never restarts the visit.
      // Always flushes: a flush:<id> retry alarm does not survive an update (see ensureSweep), so this resumes a backed-off queue.
      if (name === 'sweep') return thenFlush(async () => { await finalizeWhere(d => !d.off && now() - d.at > HIDDEN_FINALIZE_MS); return { queued: true }; });
      if (name.startsWith('flush:')) return flush(name.slice(6));
    },

    setSettings: async patch => {
      await locked(async () => store.set({ settings: { ...(await settings()), ...patch } }));
      await badge();
    },
    // Screenshots left by ≤0.6.8 (on update and browser start): nothing sends or deletes them any more.
    dropShotLeftovers: () => locked(async () => {
      await store.remove([...(await store.getKeys()).filter(k => k.startsWith('shot:')), 'shotq', 'shotday']);
      const { settings: st } = await store.get('settings');
      if (st && 'screenshots' in st) { delete st.screenshots; await store.set({ settings: st }); }
    }),
    // 不记这个网站: the own list gains the site (unless a rule already covers it), and every capture from it still
    // here goes like a row delete; open visits become tombstones, so they leave nothing.
    skipSite: site => del(async () => {
      const s = await settings();
      if (!isSkipped('https://' + site + '/', skipRules(s))) await store.set({ settings: { ...s, skipOwn: [...s.skipOwn, site] } });
      const of = url => onSite(url ?? '', site);
      const { recent = [] } = await store.get('recent');
      const recs = Object.values(await store.get((await store.getKeys()).filter(k => k.startsWith('r:'))));
      const ids = new Set([...recent.filter(e => of(e.url)).map(e => e.id), ...recs.filter(r => of(r.url)).map(r => r.capture_id),
        ...(await drafts(d => !d.off && of(d.url))).map(d => d.id)]);
      return ids.size ? forget({ capture_ids: [...ids] }) : { n: 0, sentTo: [], forget: 'none' };
    }),
    consent: agree => locked(async () => store.set({ settings: { ...(await settings()), consent: agree ? { agreed: true, at: iso() } : null } })),

    saveDest: async (id, cfg) => {
      await locked(() => putDest(id, cfg));
      await flush(id);
    },
    // Merge into the stored config under the lock, so edits made from a stale page copy never undo each other.
    // A null value deletes the field. Nothing stored: the platform was removed, and a late patch must not recreate it.
    patchDest: async (id, patch) => {
      await locked(async () => {
        const { ['dest:' + id]: old } = await store.get('dest:' + id);
        if (!old) return;
        const cfg = { ...old, ...patch };
        for (const k in cfg) if (cfg[k] === null) delete cfg[k];
        await putDest(id, cfg);
      });
      await flush(id);
    },

    // 移除: the platform's config, delivery state and queue; a record nobody else waits for; its 'queued' marks in
    // recent, so the popup stops counting them. Neurosea also takes its unfinished forget jobs (a failed one would
    // stay in the popup).
    // astate stays: without it a glance after the platform is added again would replace the page text stored there.
    removeDest: async id => {
      await locked(async () => {
        const { ['q:' + id]: q = [], recent = [], forgetq = [] } = await store.get(['q:' + id, 'recent', 'forgetq']);
        await store.remove(['dest:' + id, 'dstate:' + id, 'q:' + id]);
        for (const cid of q) await dropIfUnqueued(cid);
        for (const e of recent) if (e.status[id] === 'queued') delete e.status[id];
        await store.set({ recent });
        if (id === 'webhook') await store.set({ forgetq: forgetq.filter(j => j.status.webhook === 'done') });
      });
      alarms.clear('flush:' + id);
      await badge();
    },

    // "Retry now": end the backoff of every failing destination; one with a rejected key waits for a new one.
    retry: async () => {
      const ids = await locked(async () => {
        const out = [];
        for (const { a } of await enabledDests()) {
          const sk = 'dstate:' + a.id, { [sk]: st } = await store.get(sk);
          if (st?.failures > 0 && !st.auth) { await store.set({ [sk]: { failures: 0 } }); out.push(a.id); }
        }
        return out;
      });
      for (const id of ids) await flush(id);
    },

    // The webhook gets afferent.forget/1; sentTo names the other platforms that already have a removed capture.
    deleteCapture: id => del(() => forget({ capture_ids: [id] })),
    deleteWindow: (from, to, tabId) => del(() => forget({ from, to, tabId })),

    testDest: (id, cfg) => getAdapter(id).test(cfg),

  };
}
