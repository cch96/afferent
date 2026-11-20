// Tracks one visit at a time: page load or SPA URL change -> leave. Reports to the service worker,
// which keeps the draft so closing the tab or browser does not lose it.
(() => {
  const { createDwell } = globalThis.AfferentDwell, { extract, pageText } = globalThis.AfferentExtract, { createMedia } = globalThis.AfferentMedia, bili = globalThis.AfferentBilibili, xhs = globalThis.AfferentXhs;
  const TICK_MS = 1000, REPORT_MS = 15000, QUIET_MS = 1000, MAX_TEXT = 100000, READ_PLAY_MS = 60000, LOOKUP_PLAY_MS = 50000;
  // Room past the record's cut so the SW redacts a key at the cut whole (a PEM block is the longest match).
  const MARGIN = 4096;
  // The open popup takes focus from the page and asks for state each second: its open time counts as reading.
  const ASKED_MS = 1500;
  let askedAt = -Infinity;
  const active = () => document.visibilityState === 'visible' && (document.hasFocus() || Date.now() - askedAt < ASKED_MS);
  // Reading time also needs the owner there: input in the last IDLE_MS. Idle stops the clock at lastInput + IDLE_MS
  // (never at the tick that notices, which may come after a sleep), and neither sends nor ends the visit.
  const IDLE_MS = 5 * 60 * 1000;
  let lastInput = Date.now();
  const capped = t => Math.min(t, lastInput + IDLE_MS);
  const setDwell = (dwell, a, t) => dwell?.set(a && t < lastInput + IDLE_MS, capped(t));
  const href = () => location.href.split('#')[0];

  let v = null;            // current visit: {url, off} or {url, id, thresholdMs, dwell, media, subs, subsOut, note, audioOut, sound, preview, crossed, texted, on, sentAt}
  let pendingUrl = null, quietTimer = null;
  function send(m) {
    // Throws synchronously once the extension was reloaded/updated under this page.
    try { return chrome.runtime.sendMessage(m).catch(() => null); } catch { return Promise.resolve(null); }
  }

  // Google SafeSearch's two labels. No start means no visit, so nothing of the page is kept.
  // shortcut: only pages that label themselves are caught, and the HTTP Rating header is not read; upgrade if
  // adult pages show up in records.
  const ADULT = ['adult', 'rta-5042-1996-1400-1577-rta'];
  const adult = () => [...document.querySelectorAll('meta')].some(m =>
    m.getAttribute('name')?.toLowerCase() === 'rating' && ADULT.includes(m.getAttribute('content')?.trim().toLowerCase()));

  async function start() {
    const url = href(), placeholder = { url, off: true };
    v = placeholder;
    const r = adult() ? null : await send({ type: 'start', url });
    if (v !== placeholder) return; // URL moved on while we waited
    if (r?.capture) v = { url, id: r.id, thresholdMs: r.thresholdMs, dwell: createDwell(Date.now(), active() && Date.now() < lastInput + IDLE_MS), media: r.media ? createMedia() : null,
      subs: r.subs ? bili.video(url) : null, subsOut: null, note: r.subs && !!xhs.note(url), audioOut: null, crossed: false, texted: false, on: active(), sentAt: Date.now() };
  }

  // pageInfo=false on SPA exits: the DOM already shows the next page, so keep the last snapshot. Idle does the same,
  // so the page is mostly not re-read after the visit's last (lastInput + IDLE_MS) and a delete window over that
  // stretch still finds the visit. Two exceptions: while media plays (last moves with it), and a visit's first read
  // snapshot, so a read is never sent without text (when first seen after a sleep it is read at the wake, after last).
  // A hide or pagehide within IDLE_MS of the last input, after focus was lost, can also read past last.
  // publish: the service worker sends this version now, while the visit goes on.
  async function report(visit, end, pageInfo = true, publish = false) {
    if (!visit || visit.off) return;
    const t = Date.now(), ms = visit.dwell.ms(capped(t)), media = visit.media;
    // first/last span focused time and counted playback, so a record from playback alone has real times.
    const span = (f, ...xs) => (xs = xs.filter(x => x !== null && x !== undefined)).length ? f(...xs) : null;
    const m = { type: 'report', id: visit.id, url: visit.url, dwellMs: ms, end, ...(publish && { publish }),
      first: span(Math.min, visit.dwell.first(), media?.first()), last: span(Math.max, visit.dwell.last(capped(t)), media?.last()) };
    if (media) m.media = media.list();
    // Looked up from 50 s, recorded only from 60 s: a visit left before then keeps neither, in draft or record.
    if (playMs(visit) >= READ_PLAY_MS) {
      if (visit.subsOut) { Object.assign(m, visit.subsOut); visit.subsOut = null; } // the draft keeps them
      if (visit.audioOut) { Object.assign(m, visit.audioOut); visit.audioOut = null; }
    }
    if (pageInfo && (t < lastInput + IDLE_MS || media?.counting() || (!visit.texted && isRead(visit, t)))) {
      m.title = document.title;
      m.lang = document.documentElement.lang || '';
      if (isRead(visit, t)) {
        let chat = null;
        try { chat = extract(location, document); } catch {} // a broken extractor must not lose the page
        let text = chat ? chat.text : pageText(location, document);
        // Koala's transcript preview is a dialog removed on close: keep its last text and add it back once closed.
        if (koala(visit)) {
          const d = document.querySelector('[role="dialog"]');
          if (d) visit.preview = d.innerText;
          else if (visit.preview) text += '\n\n' + visit.preview;
        }
        m.text = text.slice(0, MAX_TEXT + MARGIN);
        visit.texted = true;
      }
    }
    visit.sentAt = t;
    const r = await send(m);
    if (end || visit !== v) return;
    if (r?.restart) start();
    else if (r && !r.capture) v = { url: visit.url, off: true };
  }

  function checkUrl() {
    const u = href();
    if (v && u === v.url) return;
    if (v) { const old = v; v = null; old.dwell?.set(false, capped(Date.now())); report(old, true, false); }
    if (u !== pendingUrl) {
      pendingUrl = u;
      clearTimeout(quietTimer);
      quietTimer = setTimeout(() => { pendingUrl = null; if (href() === u) start(); }, QUIET_MS);
    }
  }

  const koala = visit => { const u = new URL(visit.url); return u.hostname === 'app.koala-oss.club' && u.pathname.startsWith('/videos/'); };
  const playMs = visit => visit.media?.list().reduce((n, e) => n + e.playMs, 0) ?? 0;
  const isRead = (visit, t) => visit.dwell.ms(capped(t)) >= visit.thresholdMs || playMs(visit) >= READ_PLAY_MS;
  const update = () => { const t = Date.now(), a = active(); setDwell(v?.dwell, a, t); v?.media?.sample(t, a); };
  // Settle an idle stop at the old lastInput first: after a sleep the waking input can come before any tick.
  const touch = () => { const t = Date.now(), a = active(); setDwell(v?.dwell, a, t); lastInput = t; setDwell(v?.dwell, a, t); };
  // The falling edge of active() after the threshold, once per edge (the tick and visibilitychange both look).
  const fell = visit => { const a = active(), was = visit.on; visit.on = a; return was && !a && visit.crossed; };

  setInterval(() => {
    if (document.prerendering) return; // its URL watcher would start the visit
    checkUrl(); // SPA URL changes (pushState, popstate) are caught here within a tick
    if (!v?.dwell) return;
    update();
    // Sampled every tick so a quick glance is kept too: the dialog's text is gone once it closes.
    const pv = koala(v) && document.querySelector('[role="dialog"]')?.innerText;
    if (pv && pv !== v.preview) { v.preview = pv; report(v, false); }
    const t = Date.now(), left = fell(v);
    // Snapshot right when the threshold is crossed, so an SPA exit soon after still has text; it is also sent then.
    if (!v.crossed && isRead(v, t)) { v.crossed = true; report(v, false, true, true); }
    // Switched away: send this version now, for an Agent asked about the page next.
    else if (left) report(v, false, true, true);
    // Playback in a background tab keeps reporting, so the 30-minute sweep does not end the visit.
    else if ((active() || v.media?.counting()) && t - v.sentAt >= REPORT_MS) report(v, false);
    // Once per visit (subs is cleared), from 50 s; the answer goes out with a report once 60 s is reached, and later reports carry
    // the latest sound address. Neurosea only gets the visit's final version, so a Bilibili address (dead at its
    // deadline, about 2 h) is looked up again when under 30 min is left, at most once every 10 min (a fast clock or
    // a short deadline must not loop); a failed lookup is tried again 10 min later, the old address kept meanwhile.
    if (v.subs && playMs(v) >= LOOKUP_PLAY_MS) {
      const visit = v, video = v.subs;
      visit.subs = null;
      // No subtitles: where the sound can be downloaded instead (Neurosea transcribes it).
      bili.subtitles(video).then(async out => {
        visit.subsOut = out;
        if (out.subtitle_status !== 'ok') {
          visit.audioOut = await bili.audio(video);
          if (visit.audioOut.audio?.expires) visit.sound = { video, expires: visit.audioOut.audio.expires, at: Date.now() };
        }
      });
    }
    // A held answer goes out at the first tick at 60 s or later (report keeps it below 60 s).
    if ((v.subsOut || v.audioOut) && playMs(v) >= READ_PLAY_MS) report(v, false);
    const snd = v.sound;
    if (snd && !snd.busy && snd.expires * 1000 - t < 30 * 60e3 && t - snd.at >= 10 * 60e3) {
      const visit = v;
      snd.busy = true;
      bili.audio(snd.video).then(out => {
        snd.busy = false;
        snd.at = Date.now();
        if (!out.audio) return; // failed: keep the old address, try again 10 min later
        snd.expires = out.audio.expires;
        if (!snd.expires) visit.sound = null; // no deadline: nothing more to refresh
        visit.audioOut = out;
        if (visit === v) report(visit, false);
      });
    }
    if (v.note && playMs(v) >= READ_PLAY_MS) {
      v.note = false;
      v.audioOut = xhs.audio();
      report(v, false);
    }
  }, TICK_MS);

  // Not scroll: a page scrolls itself (a streaming chat). Not the popup's asks, not media, not events a script dispatches.
  for (const type of ['pointermove', 'pointerdown', 'keydown', 'wheel', 'touchstart']) addEventListener(type, e => e.isTrusted && touch(), { capture: true, passive: true });
  addEventListener('focus', touch); // the window's own focus: element focus does not bubble
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') touch(); update(); if (document.visibilityState === 'hidden' && v?.dwell) report(v, false, true, fell(v)); });
  addEventListener('pagehide', () => { update(); const old = v; v = null; report(old, true); });
  // Media events do not bubble, so listen in the capture phase. timeupdate also finds elements already playing.
  // shortcut: elements inside shadow roots or iframes are not seen; upgrade if a major site hides its player there.
  for (const type of ['play', 'playing', 'pause', 'ended', 'volumechange', 'timeupdate', 'emptied', 'loadstart']) {
    document.addEventListener(type, e => {
      if (!v?.media || !/^(VIDEO|AUDIO)$/.test(e.target?.tagName)) return;
      v.media.see(e.target);
      update();
    }, true);
  }
  // The owner's own navigation brings these pages into view: presence counts from then, not from script load.
  addEventListener('pageshow', e => { if (e.persisted) { touch(); start(); } }); // back/forward cache restore

  // The popup asks for the live state; the stored draft is up to REPORT_MS old.
  chrome.runtime.onMessage.addListener((m, _, reply) => {
    if (m?.type !== 'state' || document.prerendering) return;
    askedAt = Date.now();
    update();
    const on = !!v?.dwell;
    reply({ url: href(), title: document.title, capturing: on, dwellMs: on ? v.dwell.ms(Date.now()) : 0, thresholdMs: on ? v.thresholdMs : null });
  });

  // Chrome may prerender a likely next page in the owner's tab, reporting with that tab's id: start once it is shown.
  if (document.prerendering) document.addEventListener('prerenderingchange', () => { touch(); start(); }, { once: true });
  else start();
})();
