// Real-browser check of the sound's address (audio contract): real Chrome, fresh profile, no login, software
// rendering, this extension pointed at a local receiver (e2e/receiver.mjs) with Neurosea connected and Subtitles on.
//   SITE_COOKIE=CN node e2e/audio-url.mjs <page url> ...   (Bilibili video pages and Xiaohongshu / rednote note pages)
// SITE_COOKIE=CN presets Bilibili's user_site cookie: from an overseas IP Bilibili otherwise moves the page to
// /zh-Hans/video/… or /en/video/…, which the extension does not treat as a video page.
// Each page is played muted for PLAY_S, then left, so its record is delivered. Prints counts and fields only:
// never a media URL (only the first URL's host).
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, cpSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startReceiver } from './receiver.mjs';

const urls = process.argv.slice(2);
const chrome = process.env.CHROME || '/opt/google/chrome/chrome';
const PLAY_S = Number(process.env.PLAY_S || 66);
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const tmp = mkdtempSync(join(tmpdir(), 'afferent-audio-')), ext = join(tmp, 'ext'), profile = join(tmp, 'profile');
for (const d of ['src', '_locales', 'icons']) cpSync(join(root, d), join(ext, d), { recursive: true });
const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
manifest.host_permissions = ['<all_urls>'];
writeFileSync(join(ext, 'manifest.json'), JSON.stringify(manifest));

const rx = await startReceiver(0, 'audio-check-token');
const proc = spawn(chrome, ['--headless=new', '--no-sandbox', '--change-stack-guard-on-fork=disable', '--disable-gpu',
  '--use-angle=swiftshader', '--in-process-gpu', '--mute-audio', '--autoplay-policy=no-user-gesture-required', '--user-agent=' + UA,
  '--lang=zh-CN', '--no-first-run', '--enable-unsafe-extension-debugging', '--remote-debugging-pipe', '--user-data-dir=' + profile, 'about:blank'],
{ stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
const quit = code => {
  proc.kill(); rx.server.close();
  setTimeout(() => { rmSync(tmp, { recursive: true, force: true }); process.exit(code); }, 1000);
};
setTimeout(() => { console.error('timed out'); quit(1); }, (urls.length * (PLAY_S + 60) + 60) * 1000).unref();

let buf = '', seq = 0;
const pending = new Map();
proc.stdio[4].on('data', d => {
  buf += d;
  for (let i; (i = buf.indexOf('\0')) >= 0; buf = buf.slice(i + 1)) {
    const m = JSON.parse(buf.slice(0, i));
    if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  }
});
const call = (method, params = {}, sessionId) => new Promise((ok, fail) => {
  pending.set(++seq, m => m.error ? fail(new Error(`${method}: ${m.error.message}`)) : ok(m.result));
  proc.stdio[3].write(JSON.stringify({ id: seq, method, params, sessionId }) + '\0');
});
const attach = async targetId => (await call('Target.attachToTarget', { targetId, flatten: true })).sessionId;
const evaluate = async (sessionId, expression) => {
  const r = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
};
const until = async (what, fn, ms = 20000) => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(500)) { const v = await fn(); if (v) return v; }
  throw new Error('waited too long for ' + what);
};

const out = [];
const span = rs => rs && Math.round(rs.reduce((n, [a, b]) => n + b - a, 0));
try {
  const { id } = await call('Extensions.loadUnpacked', { path: ext });
  const sw = await until('service worker', async () => (await call('Target.getTargets')).targetInfos.find(t => t.type === 'service_worker' && t.url.includes(id)), 5000);
  const swSession = await attach(sw.targetId);
  await sleep(300);
  for (const t of (await call('Target.getTargets')).targetInfos)
    if (t.type === 'page' && t.url.includes('onboarding.html')) await call('Target.closeTarget', { targetId: t.targetId });
  const seed = { settings: { consent: { agreed: true, at: 'x' }, thresholdSec: 10, bilibiliSubs: true },
    'dest:webhook': { enabled: true, url: `http://127.0.0.1:${rx.port}/hook`, token: rx.token, kinds: ['read', 'glance'] } };
  await evaluate(swSession, `chrome.storage.local.clear().then(() => chrome.storage.local.set(${JSON.stringify(seed)}))`);

  const { targetId: tab } = await call('Target.createTarget', { url: 'about:blank' });
  const s = await attach(tab);
  await call('Emulation.setFocusEmulationEnabled', { enabled: true }, s);
  await call('Network.setUserAgentOverride', { userAgent: UA, acceptLanguage: 'zh-CN,zh;q=0.9' }, s);
  await call('Page.enable', {}, s);
  // Counts the page's own clears of its resource list (rednote does this), which could drop the note's .mp4 entry.
  await call('Page.addScriptToEvaluateOnNewDocument', { source: 'window.__clears = 0; { const c = performance.clearResourceTimings.bind(performance); performance.clearResourceTimings = () => { window.__clears++; c(); }; }' }, s);
  if (process.env.SITE_COOKIE) await call('Network.setCookie', { name: 'user_site', value: process.env.SITE_COOKIE, domain: '.bilibili.com', path: '/' }, s);
  for (const url of urls) {
    const n = rx.records.length;
    await call('Page.navigate', { url }, s);
    await sleep(8000);
    // Started from the page and left unmuted: Chrome's --mute-audio silences the machine, not the element.
    const started = await evaluate(s, `(async () => { const v = document.querySelector('video'); if (!v) return 'no video';
      try { await v.play(); } catch (e) { return 'play failed: ' + e.name; } return 'playing'; })()`);
    const t0 = Date.now();
    // Keep it playing (some players pause on their own) until PLAY_S seconds of playback.
    while (Date.now() - t0 < PLAY_S * 1000) {
      await sleep(5000);
      // A short note shorter than PLAY_S reaches it only by looping: restart it if the player does not loop.
      await evaluate(s, `(() => { const v = document.querySelector('video'); if (v && (v.paused || v.ended)) v.play().catch(() => {}); })()`);
    }
    const state = await evaluate(s, `(() => { const v = document.querySelector('video');
      return v && { t: Math.round(v.currentTime), duration: Math.round(v.duration), loop: v.loop, muted: v.muted, volume: v.volume, src: v.currentSrc.split(':')[0],
        resources: performance.getEntriesByType('resource').length, page_clears: window.__clears }; })()`);
    const final = await evaluate(s, 'location.href');
    await call('Page.navigate', { url: 'about:blank' }, s); // ends the visit, so its record is delivered
    const rec = await until('record at the receiver', () => rx.records.slice(n).find(r => r.media?.length || r.url === final), 30000).catch(() => null);
    out.push({ page: url, landed_on: new URL(final).hostname, started, video: state, record: rec && {
      kind: rec.kind, play_s: rec.media?.reduce((a, m) => a + m.play_s, 0) ?? 0, subtitle_status: rec.subtitle_status,
      // The main entry (most play): seconds of played vs heard ranges.
      main_media: (m => m && { play_s: m.play_s, played_s: span(m.played), heard_s: span(m.heard), heard_ranges: m.heard?.length })(
        [...(rec.media ?? [])].sort((a, b) => b.play_s - a.play_s)[0]),
      subtitle_lines: rec.subtitles?.[0]?.lines.length,
      audio: rec.audio && { source: rec.audio.source, urls: rec.audio.urls.length, first_host: new URL(rec.audio.urls[0]).hostname,
        expires_in_min: rec.audio.expires === null ? null : Math.round((rec.audio.expires - Date.now() / 1000) / 60) },
      audio_error: rec.audio_error, fields: Object.keys(rec).sort() } });
    console.error(JSON.stringify(out.at(-1)));
  }
  console.log(JSON.stringify({ chrome, pages: out.length, with_audio: out.filter(o => o.record?.audio).length, out }, null, 1));
  quit(0);
} catch (e) {
  console.error(e.message);
  console.log(JSON.stringify({ error: e.message, out }, null, 1));
  quit(1);
}
