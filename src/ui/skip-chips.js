// Settings: the user's own skip sites.
import { parseRule } from '../lib/skip.js';

// New rule list, or null if the text is no rule.
export function addRule(rules, text) {
  const p = parseRule(text);
  if (!p || /\s/.test(p.domain + p.path)) return null;
  const r = p.domain + p.path;
  return rules.includes(r) ? rules : [...rules, r];
}
