// Classic script (shared with content.js in the isolated world), also importable by node tests.
// Bilibili subtitles, fetched from the page with the user's own login (the server gets HTTP 412 there).
// Recipe from yt-dlp's BiliBili extractor; Bilibili's API docs are gone, so this may need updating.
// shortcut: wbi/v2 and wbi/playurl are called unsigned; if they start answering code -352, add WBI signing.
{
  // One API call: its JSON, or an Error naming the call and what went wrong.
  const get = async (f, name, url, credentials) => {
    let res, j;
    try { res = await f(url, { credentials }); } catch { throw new Error(`${name} network error`); }
    if (!res.ok) throw new Error(`${name} HTTP ${res.status}`);
    try { j = await res.json(); } catch { throw new Error(`${name} not JSON`); }
    if (j?.code !== undefined && j.code !== 0) throw new Error(`${name} code ${j.code}`);
    return j;
  };
  const cidOf = async (f, bvid, p) => {
    const view = (await get(f, 'view', 'https://api.bilibili.com/x/web-interface/view?bvid=' + bvid, 'include')).data;
    const cid = view?.pages?.[p - 1]?.cid ?? view?.cid;
    if (!cid) throw new Error('view no cid');
    return cid;
  };
  const web = u => typeof u === 'string' && /^https?:\/\//i.test(u) && u.length <= 4096 && URL.canParse(u);

  globalThis.AfferentBilibili = {
    // {bvid, p} on www.bilibili.com/video/BV… pages, else null.
    // shortcut: locale-prefixed overseas paths (/zh-Hans/video/…, /en/video/…) are not matched; widen if the owner browses from abroad.
    video(href) {
      let u;
      try { u = new URL(href); } catch { return null; }
      const m = u.hostname === 'www.bilibili.com' && u.pathname.match(/^\/video\/(BV[0-9A-Za-z]+)/);
      return m ? { bvid: m[1], p: Math.max(1, parseInt(u.searchParams.get('p'), 10) || 1) } : null;
    },

    // Never throws: -> {subtitle_status, subtitles?, subtitle_error?} (media contract §1b).
    async subtitles({ bvid, p }, f = fetch) {
      try {
        const cid = await cidOf(f, bvid, p);
        const pl = (await get(f, 'wbi/v2', `https://api.bilibili.com/x/player/wbi/v2?bvid=${bvid}&cid=${cid}`, 'include')).data;
        const list = pl?.subtitle?.subtitles ?? [];
        if (!list.length) return { subtitle_status: pl?.need_login_subtitle ? 'login' : 'none' };
        const ai = t => String(t.lan ?? '').startsWith('ai-');
        const t = list.find(x => !ai(x)) ?? list.find(x => x.lan === 'ai-zh') ?? list[0];
        const url = String(t.subtitle_url ?? '');
        if (!url) throw new Error('subtitle no url');
        // Without cookies: the subtitle host answers with a wildcard CORS header.
        const body = (await get(f, 'subtitle', url.startsWith('//') ? 'https:' + url : url, 'omit')).body;
        if (!Array.isArray(body)) throw new Error('subtitle no body');
        const lang = String(t.lan ?? '');
        return { subtitle_status: 'ok', subtitles: [{ source: 'bilibili', lang, auto: ai(t),
          lines: body.map(l => [l?.from, l?.to, l?.content]) }] };
      } catch (e) {
        return { subtitle_status: 'error', subtitle_error: String(e?.message ?? e) }; // cut to 100 in the service worker
      }
    },

    // Never throws: -> {audio} or {audio_error} (audio contract). Only the address: nothing is downloaded.
    // The URLs are signed: kept exactly as Bilibili gave them.
    async audio({ bvid, p }, f = fetch) {
      try {
        const cid = await cidOf(f, bvid, p);
        const list = (await get(f, 'playurl', `https://api.bilibili.com/x/player/wbi/playurl?bvid=${bvid}&cid=${cid}&fnval=16`, 'include')).data?.dash?.audio;
        if (!Array.isArray(list) || !list.length) throw new Error('playurl no audio');
        const bw = a => (Number.isFinite(a?.bandwidth) ? a.bandwidth : Infinity);
        const lo = list.reduce((a, b) => (bw(b) < bw(a) ? b : a));
        const backups = lo?.backupUrl ?? lo?.backup_url;
        const urls = [lo?.baseUrl ?? lo?.base_url, ...(Array.isArray(backups) ? backups : [])].filter(web).slice(0, 4);
        if (!urls.length) throw new Error('playurl no url');
        const d = new URL(urls[0]).searchParams.get('deadline');
        return { audio: { source: 'bilibili', urls, expires: /^\d{1,12}$/.test(d ?? '') ? Number(d) : null } };
      } catch (e) {
        return { audio_error: String(e?.message ?? e) };
      }
    },
  };
}
