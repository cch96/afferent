// Classic script (shared with content.js in the isolated world), also importable by node tests.
// Xiaohongshu (rednote abroad) plays notes from blob: URLs, but the mp4 the player fetched is in resource timing.
// shortcut: the most recent video-looking file is taken as the note's; after an SPA hop between video notes it may
// still be the previous note's if the new one has not fetched yet. Upgrade if wrong pairings show up.
{
  const CDN = /(^|\.)(xhscdn|rednotecdn)\.com$/, VIDEO = /\.mp4$/i;
  const video = n => {
    if (typeof n !== 'string' || n.length > 4096 || !/^https?:\/\//i.test(n) || !URL.canParse(n)) return false;
    const u = new URL(n);
    return CDN.test(u.hostname) && VIDEO.test(u.pathname);
  };
  globalThis.AfferentXhs = {
    // The note id on www.xiaohongshu.com / www.rednote.com note pages, else null.
    note(href) {
      let u;
      try { u = new URL(href); } catch { return null; }
      const m = /^www\.(xiaohongshu|rednote)\.com$/.test(u.hostname) && u.pathname.match(/^\/(?:explore|discovery\/item)\/([0-9A-Za-z]+)\/?$/);
      return m ? m[1] : null;
    },
    // -> {audio} or {audio_error}. The URL is signed: kept exactly as the page fetched it.
    audio(entries = performance.getEntriesByType('resource')) {
      const hit = entries.filter(e => video(e?.name)).sort((a, b) => a.startTime - b.startTime).at(-1);
      return hit ? { audio: { source: 'xiaohongshu', urls: [hit.name], expires: null } } : { audio_error: 'xhs no video url' };
    },
  };
}
