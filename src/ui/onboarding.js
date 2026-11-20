import { t, localize, el } from './common.js';
import { createConnect } from './connect.js';
import { clampThr } from './settings-view.js';

localize();
const $ = id => document.getElementById(id);
const { settings = {} } = await chrome.storage.local.get('settings');
$('puzzle').setAttribute('aria-label', t('onbPuzzle'));
$('pin').setAttribute('aria-label', t('onbPin'));

function onDone({ name }) {
  $('done-title').textContent = t('onbDone', [name]);
  $('setup').hidden = true;
  $('done').hidden = false;
}

const box = createConnect({ mode: 'start', thresholdSec: clampThr(settings.thresholdSec), onDone });
box.querySelector('.c-actions').append(
  el('button', { type: 'button', className: 'quiet', textContent: t('onbNotNow'), onclick: () => window.close() }));
$('setup').append(box);
box.querySelector('input').focus();
$('finish').onclick = () => window.close();
