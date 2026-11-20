// Settings (Settings8). Everything saves on change; the page follows chrome.storage, so the service worker's
// writes (new captures, failures, saveDest) show up live. Inputs being edited are never overwritten.
import { t, localize, send, el } from './common.js';
import { adapters, destName } from '../adapters/index.js';
import { ALWAYS_SKIP, ownSites } from '../lib/skip.js';
import { createConnect } from './connect.js';
import { addRule } from './skip-chips.js';
import { destStatus, destHost, clampThr } from './settings-view.js';

localize();
const $ = id => document.getElementById(id);
const sync = (input, value) => { if (document.activeElement !== input) input.value = value; };
const show = (node, text) => { node.textContent = text; node.hidden = !text; };
const setSettings = patch => send({ type: 'setSettings', patch });
const KEYS = ['settings', 'recent', ...adapters.flatMap(a => ['dest:', 'dstate:', 'q:'].map(p => p + a.id))];
let s = await chrome.storage.local.get(KEYS);
const conf = () => s.settings ?? {};
const thrSec = () => clampThr(conf().thresholdSec);

const svg = (w, sw, ...paths) => {
  const e = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  e.setAttribute('viewBox', '0 0 24 24'); e.setAttribute('width', w); e.setAttribute('height', w); e.setAttribute('aria-hidden', 'true');
  e.innerHTML = paths.map(d => `<path d="${d}" fill="none" stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round"/>`).join('');
  return e;
};
const button = (className, text, onclick) => el('button', { type: 'button', className, textContent: text, onclick });
const expander = (btn, panel) => { btn.onclick = () => { panel.hidden = !panel.hidden; btn.setAttribute('aria-expanded', String(!panel.hidden)); }; };

// A connect box in settings mode with a 取消 link; closes itself on success. A platform already saved (lock, 更换)
// only gets its key and fields replaced; the box reads them from storage.
function connectBox(holder, lock, onClose) {
  const close = () => { holder.replaceChildren(); onClose(); };
  const box = createConnect({ mode: 'settings', thresholdSec: thrSec(), lock, stored: id => s['dest:' + id], onDone: close });
  box.querySelector('.c-actions').append(button('lk', t('setCancel'), close));
  holder.replaceChildren(box);
  box.querySelector('input').focus();
}

// ---- 发到哪 ----
const switchBtn = () => {
  const b = el('button', { type: 'button', className: 'switch' }, el('span', { className: 'track' }, el('span', { className: 'knob' })));
  b.setAttribute('role', 'switch');
  return b;
};

// The 管理 panel: one label | control grid; everything that belongs to this platform and nothing else.
function destRow(a) {
  const id = a.id, cfg = () => s['dest:' + id], name = () => destName(id, cfg());
  // Only the changed field: the service worker merges it into what is stored now.
  const save = patch => send({ type: 'patchDest', id, patch });
  const dot = el('span', { className: 'dot' }), nameEl = el('span', { className: 'name' }), status = el('span', { className: 'status' });
  const manage = button('soft', t('setManage'));
  const sw = switchBtn();
  const rowMsg = el('p', { className: 'err row-msg', hidden: true });
  rowMsg.setAttribute('role', 'alert');

  // Permission first: it must be the first await inside the click.
  sw.onclick = async () => {
    const on = !cfg().enabled;
    if (on) {
      let ok = false;
      try { ok = await chrome.permissions.request({ origins: a.origins(cfg()) }); } catch {}
      if (!ok) return show(rowMsg, t('connFailPerm', [t('setSendTo', [name()])]));
    }
    show(rowMsg, '');
    await save({ enabled: on });
  };

  // 地址 and 更换, whose connect box opens under it.
  const addrLabel = el('span', { className: 't', textContent: t('setAddr') }), host = el('code', { className: 'addr' });
  const replaceHolder = el('div', { className: 'wide' });
  const replace = button('soft', t('setChange'), () => {
    const open = !replaceHolder.firstChild;
    if (open) connectBox(replaceHolder, id, () => { replace.setAttribute('aria-expanded', 'false'); replace.focus(); });
    else replaceHolder.replaceChildren();
    replace.setAttribute('aria-expanded', String(open));
  });
  replace.setAttribute('aria-expanded', 'false');
  const addr = el('div', { className: 'ctl' }, host, replace);

  const kindsLabel = el('span', { className: 't', id: 'kinds-' + id, textContent: t('setKinds') });
  const kindBtns = [['read'], ['read', 'glance']].map((kinds, i) =>
    button('seg-btn', t(i ? 'setKindsAll' : 'setKindsRead'), () => save({ kinds })));
  const seg = el('div', { className: 'seg' }, ...kindBtns);
  seg.setAttribute('role', 'group'); seg.setAttribute('aria-labelledby', kindsLabel.id);

  // Neurosea only: the 字幕 switch (a setting, read by the service worker for Neurosea alone).
  let subs = null;
  if (id === 'webhook') {
    const label = el('span', { className: 't', id: 'setSubs-t', textContent: t('setSubs') });
    const sub = el('span', { className: 'sub grow', id: 'setSubs-sub', textContent: t('setSubsSub') });
    const b = switchBtn();
    b.setAttribute('aria-labelledby', label.id); b.setAttribute('aria-describedby', sub.id);
    b.onclick = () => setSettings({ bilibiliSubs: conf().bilibiliSubs === false });
    subs = { b, nodes: [label, el('div', { className: 'ctl' }, sub, b)] };
  }

  // 移除: the first click only asks; nothing is sent before the second.
  const removeRow = el('div', { className: 'wide rm-row' });
  const rm = button('quiet rm', t('setRemove'), () => {
    const n = (s['q:' + id] ?? []).length;
    const ask = el('span', { className: 'rm-ask', textContent: n ? t('setRemoveAskN', [name(), String(n)]) : t('setRemoveAsk', [name()]) });
    ask.setAttribute('role', 'status');
    const cancel = button('quiet', t('setCancel'), () => { removeRow.replaceChildren(rm); rm.focus(); });
    removeRow.replaceChildren(ask, cancel, button('rm-go', t('setRemove'), async () => {
      await send({ type: 'removeDest', id });
      // 添加平台 is hidden while its card is open; the card's key input is then the visible place to land.
      (addBtn.hidden ? addCard.querySelector('input') : addBtn).focus();
    }));
    cancel.focus();
  });
  removeRow.append(rm);

  const panel = el('div', { className: 'panel', hidden: true },
    addrLabel, addr, replaceHolder, kindsLabel, seg, ...(subs ? subs.nodes : []), removeRow);
  expander(manage, panel);
  manage.setAttribute('aria-expanded', 'false');

  const root = el('div', { className: 'dest' },
    el('div', { className: 'row' }, dot, el('div', { className: 'grow col' }, el('span', {}, nameEl), status), manage, sw), rowMsg, panel);
  return {
    root,
    refresh() {
      const c = cfg(), st = destStatus(id, c, { dstate: s['dstate:' + id], q: s['q:' + id], recent: s.recent });
      root.dataset.tone = st.tone;
      nameEl.textContent = name();
      status.textContent = st.text;
      sw.setAttribute('aria-checked', String(!!c.enabled));
      sw.setAttribute('aria-label', t('setSendTo', [name()]));
      manage.setAttribute('aria-label', t('setManageX', [name()]));
      host.textContent = destHost(a, c);
      addrLabel.hidden = addr.hidden = !host.textContent;
      replace.setAttribute('aria-label', t('setChangeX', [name()]));
      const all = (c.kinds ?? a.defaultKinds).includes('glance');
      kindBtns.forEach((b, i) => b.setAttribute('aria-pressed', String(!!i === all)));
      if (subs) subs.b.setAttribute('aria-checked', String(conf().bilibiliSubs !== false));
    },
  };
}

const rows = new Map();
let rowIds = '';
function renderDests() {
  for (const a of adapters) if (s['dest:' + a.id] && !rows.has(a.id)) rows.set(a.id, destRow(a));
  for (const id of rows.keys()) if (!s['dest:' + id]) rows.delete(id);
  const ids = adapters.filter(a => rows.has(a.id)).map(a => a.id);
  // Re-append only when the set changed: moving a node drops its focus.
  if (ids.join() !== rowIds) { $('dests').replaceChildren(...ids.map(id => rows.get(id).root)); rowIds = ids.join(); }
  rows.forEach(r => r.refresh());
}

const addBtn = $('add'), addCard = $('add-card');
addBtn.onclick = () => {
  addBtn.hidden = true; addCard.hidden = false;
  connectBox(addCard, undefined, () => { addCard.hidden = true; addBtn.hidden = false; addBtn.focus(); });
};

// ---- 看满几秒 ----
const thr = $('thr');
const thrLabel = () => {
  $('thr-out').textContent = t('setSec', [thr.value]);
  thr.style.setProperty('--p', `calc(13px + (100% - 26px) * ${(thr.value - 3) / 57})`);
};
$('thr-min').textContent = t('setSec', ['3']);
$('thr-max').textContent = t('setSec', ['60']);
thr.addEventListener('input', thrLabel);
thr.addEventListener('change', () => setSettings({ thresholdSec: Number(thr.value) }));

// ---- 不记的网站 ----
// Only the user's own sites: the built-in ones are not complete, so they are not shown as a list to manage.
const X = ['M6 6l12 12', 'M18 6L6 18'];
let chipsShown = '';
function renderSkip(force) {
  const own = ownSites(conf());
  if (!force && JSON.stringify(own) === chipsShown) return;
  chipsShown = JSON.stringify(own);
  $('own-sites').replaceChildren(...own.map((r, i) => {
    const x = el('button', { type: 'button', className: 'x', onclick: () => saveSkip(own.filter(o => o !== r), () => {
      const xs = $('own-sites').querySelectorAll('.x');
      return xs[Math.min(i, xs.length - 1)] ?? $('skip-in');
    }) }, svg(15, 2.4, ...X));
    x.setAttribute('aria-label', t('setSkipRemove', [r]));
    return el('li', {}, el('span', { textContent: r }), x);
  }));
}
// Render at once from the converted list (an old group or flat list must not come back twice), then refocus.
async function saveSkip(skipOwn, focusEl) {
  s.settings = { ...conf(), skipOn: [], skipOwn };
  renderSkip(true);
  focusEl?.()?.focus();
  await setSettings({ skipOwn });
}
function addSkip() {
  const next = addRule(ownSites(conf()), $('skip-in').value);
  if (!next) return show($('skip-msg'), $('skip-in').value.trim() ? t('setSkipBad') : '');
  show($('skip-msg'), '');
  $('skip-in').value = '';
  saveSkip(next);
}
$('skip-in').placeholder = t('setSkipPh');
$('skip-in').addEventListener('keydown', e => { if (e.key === 'Enter') addSkip(); });
$('skip-add').onclick = addSkip;

// ⓘ card: shown on hover, focus and click, hidden once the pointer leaves the ⓘ and the card (both in .lab), on blur and Escape; above the ⓘ when there is no room below.
{
  const b = $('skip-info'), tip = $('skip-tip');
  b.setAttribute('aria-label', t('setSkipInfo'));
  $('skip-tip1').textContent = t('setSkipTip1', [String(ALWAYS_SKIP.passwords.length)]);
  const open = () => {
    tip.hidden = false;
    tip.classList.remove('up');
    tip.style.setProperty('--caret', b.offsetLeft + 21 + 'px');
    // 16px: room for the shadow, so a card does not end flush with the window edge.
    if (tip.getBoundingClientRect().bottom > innerHeight - 16) tip.classList.add('up');
  };
  const close = () => { tip.hidden = true; };
  b.addEventListener('mouseenter', open);
  b.addEventListener('focus', open);
  b.addEventListener('click', open);
  $('skip-lab').addEventListener('mouseleave', close);
  b.addEventListener('blur', close);
  window.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });
}

function render() {
  renderDests();
  sync(thr, thrSec());
  thrLabel();
  renderSkip();
}

render();
if (location.hash === '#skip') $('skip').scrollIntoView();
chrome.storage.onChanged.addListener(async () => { s = await chrome.storage.local.get(KEYS); render(); });
