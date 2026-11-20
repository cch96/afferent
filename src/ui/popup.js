import { t, localize, send, el } from './common.js';
import { adapters } from '../adapters/index.js';
import { popupView, deleteNotice, skipNotice, windowRange, deleteWhat } from './popup-view.js';

localize();
const $ = id => document.getElementById(id);
const KEYS = ['settings', 'recent', 'today', 'forgetq', ...adapters.flatMap(a => ['dest:' + a.id, 'dstate:' + a.id, 'q:' + a.id])];
// lastDel: the delete the notice reports, so its Neurosea part follows forgetq while it shows.
// tabId: the active tab the card describes; a window delete also quiets its page.
// range: the delete dialog's selected range.
// skipped: the site the card's own button put on the list.
let store = {}, view = null, openId = null, lastDel = null, noticeTimer, tabId, range, skipped;

$('card').setAttribute('aria-label', t('popThisPage'));
$('settings').setAttribute('aria-label', t('popSettings'));
$('settings').onclick = () => chrome.runtime.openOptionsPage();
$('del').setAttribute('aria-label', t('popDelTitle'));
$('del').title = t('popDelTitle');

async function pageState() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  tabId = tab?.id; // before the page's reply, which a blocked page never sends
  // Rejects when no content script runs there: a browser page, or a tab opened before install.
  const page = tab ? await chrome.tabs.sendMessage(tab.id, { type: 'state' }).catch(() => null) : null;
  return { tab, page };
}

function say(text, del = null) {
  lastDel = del;
  $('notice').textContent = text;
  $('notice').classList.add('on');
  drawForget();
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => { lastDel = null; $('notice').classList.remove('on'); drawForget(); }, 4000);
}

// at: forgetq's length before the request, so forgetq[at] is the job it queued (undefined until storage catches up).
const delText = () => deleteNotice(lastDel.answer, store.forgetq?.[lastDel.at], store, t);
async function skip(site) {
  const answer = await send({ type: 'skipSite', site });
  if (answer?.sentTo) say(skipNotice(site, answer, store, t));
}
async function del(msg) {
  const at = (store.forgetq || []).length;
  const answer = await send(msg);
  if (answer?.sentTo) say(deleteNotice(answer, store.forgetq?.[at], store, t), { answer, at });
}

// The persistent line steps aside while the notice says the same thing.
function drawForget() {
  const f = view?.forget;
  $('forget').hidden = !f || !!lastDel;
  $('forget').textContent = f?.text ?? '';
  $('forget').className = f?.failed ? 'failed' : '';
}

function pickRange(r) {
  range = r;
  for (const b of $('delRanges').querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.r === r));
  $('delWhat').textContent = deleteWhat(r, store, t);
}
// Focus starts on the selected range, not the first button.
$('del').onclick = () => { pickRange('hour'); $('delDlg').showModal(); $('delRanges').querySelector('[aria-pressed="true"]').focus(); };
$('delRanges').onclick = e => { const r = e.target.closest('[data-r]')?.dataset.r; if (r) pickRange(r); };
$('delNo').onclick = () => $('delDlg').close();
// No notice: the list redraws from storage, and the #forget line follows the Neurosea job.
$('delGo').onclick = () => { $('delDlg').close(); send({ type: 'deleteWindow', ...windowRange(range, Date.now()), tabId }); };
$('delDlg').onclose = () => $('del').focus();

function closeMenu() { if (openId) { openId = null; drawRows(); } }

function drawRows() {
  const head = el('li', { className: 'earlier-head', textContent: t('popEarlier') });
  $('rows').replaceChildren(...view.rows.flatMap((r, i) => {
    const open = r.id === openId;
    const more = el('button', { type: 'button', className: 'more', onclick: () => { openId = open ? null : r.id; drawRows(); if (!open) $('rows').querySelector('.menu button')?.focus(); } },
      $('dots').content.cloneNode(true));
    more.setAttribute('aria-label', t('popMore', [r.title]));
    more.setAttribute('aria-expanded', String(open));
    const menu = open && el('div', { className: 'menu' },
      el('button', { type: 'button', textContent: t('popDelete'), onclick: async () => {
        openId = null;
        drawRows();
        del({ type: 'deleteCapture', id: r.id });
      } }),
      el('button', { type: 'button', textContent: t('popSkipSite'), onclick: async () => {
        openId = null;
        drawRows();
        skip(r.site);
      } }));
    const li = el('li', { className: r.read ? 'read' : 'glance' },
      el('div', { className: 'row' },
        el('span', { className: 'dot' }),
        el('div', { className: 'what' },
          el('a', { href: r.url, target: '_blank', textContent: r.title, title: r.title }),
          el('div', { className: 'meta' }, el('span', { textContent: r.site }), el('span', { textContent: r.meta }))),
        el('span', { className: 'when' + (r.late === 'failed' ? ' failed' : ''), textContent: r.when }),
        more),
      menu || null);
    return r.earlier && !view.rows[i - 1]?.earlier ? [head, li] : [li];
  }));
}

function drawCard(card) {
  $('card').className = card.grey ? 'grey' : '';
  $('fill').style.width = card.fill * 100 + '%';
  $('done').style.display = card.done ? '' : 'none';
  $('big').textContent = card.big;
  $('sub').textContent = card.title ?? card.note;
  $('sub').className = card.title ? 'title' : '';
  $('action').hidden = !card.action;
  $('actionLabel').textContent = card.action ?? '';
  $('action').onclick = () => card.site ? (skipped = card.site, $('action').hidden = true, skip(card.site)) : card.kind === 'start'
    ? chrome.tabs.create({ url: chrome.runtime.getURL('src/ui/onboarding.html') })
    : chrome.tabs.create({ url: chrome.runtime.getURL('src/ui/options.html#skip') });
}

// The page answer moves every second (dwell); only the card follows it.
async function redrawCard() {
  const { tab, page } = await pageState();
  drawCard(popupView({ store, tab, page, now: Date.now(), skipped }, t).card);
}

async function render() {
  const [s, { tab, page }] = await Promise.all([chrome.storage.local.get(KEYS), pageState()]);
  store = s;
  view = popupView({ store, tab, page, now: Date.now(), skipped }, t);
  const { card, pause, banner } = view;

  $('pause').hidden = !pause;
  if (pause) {
    $('pause').classList.toggle('paused', pause.paused);
    $('pause').setAttribute('aria-pressed', String(pause.paused));
    $('pauseLabel').textContent = pause.label;
  }

  drawCard(card);

  $('banner').hidden = !banner;
  if (banner) {
    $('banner').className = banner.kind;
    $('bannerText').textContent = banner.text;
    $('bannerBtn').textContent = banner.button;
    $('bannerBtn').onclick = () => (banner.kind === 'net' ? send({ type: 'retry' }) : chrome.runtime.openOptionsPage());
  }

  $('head').hidden = !view.showList;
  $('count').textContent = view.count;
  $('delivered').hidden = !view.delivered;
  if (!view.rows.some(r => r.id === openId)) openId = null;
  drawRows();
  drawForget();
  if (lastDel) $('notice').textContent = delText();
}

$('pause').onclick = () => send({ type: 'setSettings', patch: { paused: !view.pause.paused } });
addEventListener('keydown', e => {
  if (e.key !== 'Escape' || !(openId || $('delDlg').open)) return;
  e.preventDefault(); // else Escape also closes the popup
  if ($('delDlg').open) return $('delDlg').close();
  const id = openId;
  closeMenu();
  [...$('rows').querySelectorAll('.more')].find((b, i) => view.rows[i].id === id)?.focus();
});
addEventListener('click', e => {
  if (openId && !e.target.closest('.menu, .more')) closeMenu();
});
// Only the keys the list reads: drafts (every 15 s) must not rebuild it and take keyboard focus.
chrome.storage.onChanged.addListener(changes => { if (Object.keys(changes).some(k => KEYS.includes(k))) render(); });
render();
setInterval(redrawCard, 1000); // ends with the popup's page
