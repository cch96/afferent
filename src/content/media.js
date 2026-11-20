// Classic script (shared with content.js in the isolated world), also importable by node tests.
// Per visit: which media elements played, which parts (and which of those with the sound on), and for how long.
// Counted playback = playing while the page is active, or while audible. Measured from timestamps, because
// background timers are throttled; the service worker rounds, caps and normalizes what list() returns.
globalThis.AfferentMedia = {
  createMedia() {
    const GAP_CAP_MS = 65000; // a longer gap between samples means the machine slept
    const els = new Map();    // element -> {e: current entry or null, on: counting, bg: page not active, au: unmuted, volume > 0, ct: currentTime}
    const entries = [];       // in order of first counted play
    let last = null, firstOn = null, lastOn = null;

    // Union of sorted ranges; keeps ranges from before a reload (the element's `played` resets then).
    const union = rs => rs.sort((a, b) => a[0] - b[0]).reduce((out, r) => {
      const p = out.at(-1);
      if (p && r[0] <= p[1]) p[1] = Math.max(p[1], r[1]); else out.push([...r]);
      return out;
    }, []);
    const ranges = tr => Array.from({ length: tr?.length ?? 0 }, (_, i) => [tr.start(i), tr.end(i)]);

    return {
      see(el) { if (!els.has(el)) els.set(el, { e: null, on: false, bg: false, au: false, ct: 0 }); },
      sample(t, active) {
        const dt = last === null ? 0 : Math.min(Math.max(t - last, 0), GAP_CAP_MS);
        last = t;
        for (const [el, s] of els) {
          if (s.on) { s.e.playMs += dt; if (s.bg) s.e.bgMs += dt; lastOn = t; }
          // Heard: the stretch since the last sample, if the sound was on and it is a plausible advance (a seek,
          // loop or reload is a gap). shortcut: a tab or "Mute site" mute leaves el.muted and el.volume alone, so it
          // counts as heard; upgrade by having the service worker read sender.tab.mutedInfo if it ever matters.
          const d = el.currentTime - s.ct;
          if (s.on && s.au && s.e.src === el.currentSrc && d >= 0 && d <= dt / 1000 * (el.playbackRate || 1) + 1)
            s.e.heard = union([...s.e.heard, [s.ct, el.currentTime]]);
          s.ct = el.currentTime;
          s.on = !el.paused && !el.ended && (active || (!el.muted && el.volume > 0));
          s.bg = !active;
          s.au = !el.muted && el.volume > 0;
          if (s.on && s.e?.src !== el.currentSrc) {
            s.e = { kind: el.tagName === 'AUDIO' ? 'audio' : 'video', src: el.currentSrc, duration: el.duration, played: [], heard: [], playMs: 0, bgMs: 0 };
            entries.push(s.e);
            firstOn ??= t;
          }
          if (s.e?.src === el.currentSrc) {
            s.e.duration = el.duration;
            s.e.played = union([...s.e.played, ...ranges(el.played)]);
          }
        }
      },
      list: () => entries.filter(e => e.playMs > 0),
      counting: () => [...els.values()].some(s => s.on),
      first: () => firstOn,
      last: () => lastOn,
    };
  },
};
