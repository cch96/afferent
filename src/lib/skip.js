// Rule syntax: <domain>[/<path-prefix>]. The domain matches itself and its subdomains.
// Group lists live only here, never in storage, so a change reaches installed plugins.
// Always skipped. Password managers, and the account pages that show app-specific passwords in plain text.
// (成人内容 is the other fixed group: pages labelled adult, checked by the content script.)
export const ALWAYS_SKIP = {
  passwords: ['1password.com', 'bitwarden.com', 'lastpass.com', 'dashlane.com', 'keepersecurity.com',
    'appleid.apple.com', 'account.apple.com', 'myaccount.google.com/apppasswords',
    'passwords.google.com', 'bitwarden.eu', '1password.eu', '1password.ca', 'pass.proton.me'],
};
// The optional groups 0.6.5 removed. Kept only to convert stored settings: a group that was on comes back as its
// sites among the own sites (ownSites), so nobody who had turned one on starts recording those sites.
export const OPTIONAL_SKIP = {
  payment: ['paypal.com', 'alipay.com', 'stripe.com', 'wise.com'],
  email: ['mail.google.com', 'outlook.live.com', 'outlook.office.com', 'outlook.office365.com', 'mail.qq.com',
    'exmail.qq.com', 'mail.163.com', 'mail.126.com'],
  chat: ['web.whatsapp.com', 'web.telegram.org', 'wx.qq.com', 'web.wechat.com', 'app.slack.com', 'discord.com',
    'messenger.com', 'feishu.cn/next/messenger', 'larksuite.com/next/messenger'],
};
// Entries a release before 0.4.3 copied into settings.skip: the groups above plus 0.4.1's sign-in group.
// Built from the current lists, so a later edit to them only changes how not-yet-rewritten old stores convert,
// and only toward skipping more: a dropped entry stays skipped as an own site; an added one the user had typed brings its group.
const RELEASED = [...Object.values(ALWAYS_SKIP), ...Object.values(OPTIONAL_SKIP)].flat()
  .concat('accounts.google.com', 'login.microsoftonline.com', 'appleid.apple.com', 'github.com/login', 'github.com/sessions');

// Stored settings of any shape -> the user's own sites, with the sites of every optional group that was on.
// Before 0.4.3 settings.skip was one flat list with the defaults copied in: a group was on if any of its
// entries is still there, and own sites are the entries no release put there. Once skipOn exists, skip is ignored.
export function ownSites(s) {
  const old = s?.skip ?? [];
  const on = s?.skipOn ?? Object.keys(OPTIONAL_SKIP).filter(id => OPTIONAL_SKIP[id].some(r => old.includes(r)));
  const own = s?.skipOn ? s.skipOwn ?? [] : old.filter(r => !RELEASED.includes(r));
  return [...new Set([...own, ...on.filter(id => Object.hasOwn(OPTIONAL_SKIP, id)).flatMap(id => OPTIONAL_SKIP[id])])];
}

// The rules in effect: the always-on group, then own sites.
export function skipRules(s) {
  return [...Object.values(ALWAYS_SKIP).flat(), ...ownSites(s)];
}

export function parseRule(line) {
  const s = line.trim().replace(/^[a-z]+:\/\//i, '').replace(/^\*\./, '');
  if (!s) return null;
  const i = s.indexOf('/');
  const domain = (i < 0 ? s : s.slice(0, i)).toLowerCase().replace(/:\d+$/, '');
  return domain ? { domain, path: i < 0 ? '' : s.slice(i) } : null;
}

// The first rule that matches the URL, as written; null when none does or the URL does not parse.
export function matchingRule(url, rules) {
  let u;
  try { u = new URL(url); } catch { return null; }
  const host = u.hostname.toLowerCase();
  return rules.find(line => {
    const r = parseRule(line);
    // Plain prefix (not segment-aware) on purpose: when unsure, skip more.
    return r && (host === r.domain || host.endsWith('.' + r.domain)) && u.pathname.startsWith(r.path);
  })?.trim() ?? null;
}

export function isSkipped(url, rules) {
  if (!URL.canParse(url)) return true;
  return matchingRule(url, rules) !== null;
}

// Deleting by site (不记这个网站). Skipping errs toward more; a delete cannot be undone, so a one-word site
// (dev, localhost) deletes only its exact host. A dotted site covers its subdomains, as the rule does.
export function onSite(url, site) {
  if (matchingRule(url, [site]) === null) return false;
  const d = parseRule(site).domain;
  return d.includes('.') || new URL(url).hostname.toLowerCase() === d;
}
