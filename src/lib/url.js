const SENSITIVE = new Set(['token', 'access_token', 'id_token', 'refresh_token', 'code', 'key', 'api_key',
  'apikey', 'sig', 'signature', 'x-amz-signature', 'x-amz-credential', 'x-amz-security-token', 'password', 'passwd',
  'pwd', 'secret', 'client_secret', 'auth', 'authorization', 'session', 'sessionid', 'sid', 'jwt', 'otp']);
const SENSITIVE_PART = /token|secret|password|signature/;
// Ad and mail click ids: they never change the page, and they would split one page into many page_keys.
const TRACKING = new Set(['fbclid', 'gclid', 'dclid', 'gbraid', 'wbraid', 'msclkid', 'yclid', 'igshid', 'twclid',
  'mc_cid', 'mc_eid', '_hsenc', '_hsmi', 'mkt_tok', 'spm']);

function paramName(raw) {
  try { return decodeURIComponent(raw.replace(/\+/g, ' ')).toLowerCase(); } catch { return raw.toLowerCase(); }
}

// Returns the URL without fragment, userinfo, sensitive and tracking query params and the user's own
// `extra` names, or null for non-http(s) URLs.
// Works on the raw query string so kept params keep their exact original encoding and order.
export function normalizeUrl(input, extra = []) {
  const user = new Set(extra.map(x => x.trim().toLowerCase()));
  let u;
  try { u = new URL(input); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  u.hash = '';
  u.username = '';
  u.password = '';
  const kept = u.search.slice(1).split('&').filter(pair => {
    if (!pair) return false;
    const name = paramName(pair.split('=')[0]);
    return !SENSITIVE.has(name) && !SENSITIVE_PART.test(name) && !TRACKING.has(name) && !name.startsWith('utm_')
      && !user.has(name);
  });
  u.search = kept.length ? '?' + kept.join('&') : '';
  return u.href;
}

export async function sha256Hex(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

export const pageKey = sha256Hex;
