// Screenshot one page of the real extension in headless Chromium (dev tool, no deps).
//
//   node e2e/shots.mjs <page> <out.png> [options]
//     <page>          popup | options | onboarding, or a path inside the extension (src/ui/x.html)
//     --size WxH      viewport, default 380x560 for the popup, 1100x900 otherwise
//     --seed f.json   chrome.storage.local is cleared and set to this object before the page loads
//     --dark          prefers-color-scheme: dark
//     --over URL      open URL first as the active tab (focus emulated, so dwell counts) and the page
//                     as a background tab in the same window, so tabs.query({active, currentWindow})
//                     finds URL. Serve one with: node e2e/receiver.mjs 8799  (http://127.0.0.1:8799/page.html)
//     --dwell ms      with --over: time on URL before the page opens (default 3000)
//     --eval JS       run in the page before the shot (awaited); repeatable, in order
//     --wait ms       pause after load and after each --eval (default 400)
//     --lang xx       browser UI language, default zh-CN
//     --chrome path   default: Playwright's chromium-1223 (it can load unpacked extensions over CDP)
//
// Needs --in-process-gpu (else the GPU process crashes here) and --no-zygote (else every renderer
// segfaults on this 64K-page arm64 kernel); --load-extension does not work on this build, so the
// extension is loaded with Extensions.loadUnpacked over --remote-debugging-pipe.
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const opt = { evals: [], wait: 400, dwell: 3000, lang: 'zh-CN',
  chrome: process.env.HOME + '/.cache/ms-playwright/chromium-1223/chrome-linux/chrome' };
const pos = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i], next = () => args[++i];
  if (a === '--size') opt.size = next();
  else if (a === '--seed') opt.seed = JSON.parse(readFileSync(next(), 'utf8'));
  else if (a === '--dark') opt.dark = true;
  else if (a === '--over') opt.over = next();
  else if (a === '--dwell') opt.dwell = +next();
  else if (a === '--eval') opt.evals.push(next());
  else if (a === '--wait') opt.wait = +next();
  else if (a === '--lang') opt.lang = next();
  else if (a === '--chrome') opt.chrome = next();
  else pos.push(a);
}
const [page, out] = pos;
if (!page || !out) { console.error(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\nimport')[0]); process.exit(2); }
const path = /^(popup|options|onboarding)$/.test(page) ? `src/ui/${page}.html` : page;
const [w, h] = (opt.size || (page === 'popup' ? '380x560' : '1100x900')).split('x').map(Number);
const ext = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sleep = ms => new Promise(r => setTimeout(r, ms));

const profile = mkdtempSync(join(tmpdir(), 'afferent-shots-'));
const proc = spawn(opt.chrome, ['--headless=new', '--no-sandbox', '--no-zygote', '--in-process-gpu', '--use-angle=swiftshader',
  '--enable-unsafe-extension-debugging', '--remote-debugging-pipe', '--user-data-dir=' + profile, '--lang=' + opt.lang,
  '--hide-scrollbars', 'about:blank'], { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
const quit = code => { proc.kill(); setTimeout(() => { rmSync(profile, { recursive: true, force: true }); process.exit(code); }, 300); };
setTimeout(() => { console.error('timed out'); quit(1); }, 60000).unref();

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
async function evaluate(sessionId, expression) {
  const r = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
}

try {
  const { id } = await call('Extensions.loadUnpacked', { path: ext });
  // The service worker holds chrome.storage; seed through it.
  let sw;
  for (let i = 0; i < 50 && !sw; i++, await sleep(100))
    sw = (await call('Target.getTargets')).targetInfos.find(t => t.type === 'service_worker' && t.url.includes(id));
  if (!sw) throw new Error('extension service worker did not start');
  const swSession = await attach(sw.targetId);
  // Close the first-run tab the install opens, so it never is the active tab.
  await sleep(300);
  for (const t of (await call('Target.getTargets')).targetInfos)
    if (t.type === 'page' && t.url.includes('onboarding.html')) await call('Target.closeTarget', { targetId: t.targetId });
  if (opt.seed) await evaluate(swSession, `chrome.storage.local.clear().then(() => chrome.storage.local.set(${JSON.stringify(opt.seed)}))`);

  if (opt.over) {
    const { targetId } = await call('Target.createTarget', { url: 'about:blank' });
    const s = await attach(targetId);
    await call('Emulation.setFocusEmulationEnabled', { enabled: true }, s);
    await call('Page.enable', {}, s);
    await call('Page.navigate', { url: opt.over }, s);
    await sleep(opt.dwell);
  }

  const { targetId } = await call('Target.createTarget', { url: 'about:blank', background: !!opt.over });
  const s = await attach(targetId);
  await call('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false }, s);
  if (opt.dark) await call('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] }, s);
  await call('Page.enable', {}, s);
  await call('Page.navigate', { url: `chrome-extension://${id}/${path}` }, s);
  await sleep(opt.wait);
  for (const js of opt.evals) { await evaluate(s, `(async () => { ${js} })()`); await sleep(opt.wait); }
  const { data } = await call('Page.captureScreenshot', { format: 'png' }, s);
  writeFileSync(out, Buffer.from(data, 'base64'));
  console.log(out);
  quit(0);
} catch (e) {
  console.error(e.message);
  quit(1);
}
