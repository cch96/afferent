// Settings page texts derived from storage (pure, unit-tested).
import { t } from './common.js';

const day = ms => new Date(ms).toLocaleDateString('sv');

// Row status of a saved destination. live: dstate:<id>, q:<id> and recent from storage.
export function destStatus(id, cfg, { dstate = {}, q = [], recent = [] }, now = Date.now()) {
  if (!cfg.enabled) return { text: t('setOff'), tone: 'off' };
  if (dstate.auth) return { text: t('setRejected', [t('setKey'), String(q.length)]), tone: 'bad' };
  if (dstate.failures > 0) return { text: t('setDown', [String(q.length)]), tone: 'bad' };
  const k = recent.filter(e => day(e.at) === day(now) && ['sent', 'queued'].includes(e.status[id])).length;
  return { text: t('setOk', [String(k)]), tone: 'ok' };
}

// 地址 in the 管理 panel: the host pages go to, from the saved URL, else the platform's fixed origin; '' when
// there is neither (a platform not yet given an address).
export function destHost(a, cfg) {
  try { return new URL(cfg?.url ?? a.origins(cfg ?? {})[0]).host; } catch { return ''; }
}

// The old page allowed 1–3600; the slider shows 3–60.
export const clampThr = v => Math.min(60, Math.max(3, Math.round(Number(v) || 10)));
