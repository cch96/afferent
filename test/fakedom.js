// A tiny DOM stand-in for extractor tests: h(tag, attrs, ...children) builds elements.
// Selectors: comma lists of compounds made of tag, .class, [attr], [attr="v"], [attr^="v"], [attr$="v"], [attr*="v"].
const BLOCK = /^(P|DIV|PRE|UL|OL|LI|H[1-6]|TABLE|TR|BLOCKQUOTE|SECTION|ARTICLE|HEADER|FOOTER|NAV|ASIDE|MAIN|FORM|BUTTON)$/;

function compound(sel) {
  const tests = [];
  const re = /^([a-z][a-z0-9]*)|\.([\w-]+)|\[([\w-]+)(?:([\^$*]?)="([^"]*)")?\]/gy;
  let m;
  while (re.lastIndex < sel.length && (m = re.exec(sel))) {
    const [, tag, cls, attr, op, val] = m;
    if (tag) tests.push(e => e.tagName === tag.toUpperCase());
    else if (cls) tests.push(e => (e.attrs.class || '').split(/\s+/).includes(cls));
    else tests.push(e => {
      const v = e.attrs[attr];
      if (v === undefined) return false;
      if (val === undefined) return true;
      return op === '^' ? v.startsWith(val) : op === '$' ? v.endsWith(val) : op === '*' ? v.includes(val) : v === val;
    });
  }
  if (re.lastIndex !== sel.length || !m) throw new Error('fakedom: unsupported selector ' + sel);
  return e => tests.every(t => t(e));
}
const parse = sel => { const fs = sel.split(',').map(s => compound(s.trim())); return e => fs.some(f => f(e)); };

export function h(tag, attrs = {}, ...kids) {
  const e = {
    nodeType: 1, tagName: tag.toUpperCase(), attrs, parentElement: null,
    childNodes: kids.flat().map(k => (typeof k === 'string' ? { nodeType: 3, textContent: k } : k)),
    getAttribute: n => attrs[n] ?? null,
    matches: sel => parse(sel)(e),
    closest(sel) { const f = parse(sel); for (let x = e; x; x = x.parentElement) if (f(x)) return x; return null; },
    querySelectorAll(sel) {
      const f = parse(sel), out = [];
      const walk = x => { for (const c of x.childNodes) if (c.nodeType === 1) { if (f(c)) out.push(c); walk(c); } };
      walk(e);
      return out;
    },
    querySelector: sel => e.querySelectorAll(sel)[0] ?? null,
    get textContent() { return e.childNodes.map(c => c.textContent).join(''); },
    // Like the real one: hidden subtrees give nothing, blocks sit on their own lines.
    get innerText() {
      if ('hidden' in attrs) return '';
      return e.childNodes.map(c => c.nodeType === 3 ? c.textContent : BLOCK.test(c.tagName) ? `\n${c.innerText}\n` : c.innerText)
        .join('').replace(/\n{3,}/g, '\n\n').trim();
    },
  };
  for (const c of e.childNodes) if (c.nodeType === 1) c.parentElement = e;
  return e;
}

// A document whose body is the given children.
export function doc(...kids) {
  const body = h('body', {}, ...kids);
  return { body, querySelectorAll: s => body.querySelectorAll(s), querySelector: s => body.querySelector(s) };
}

// A stand-in HTMLMediaElement; `ranges` backs `played` like the browser's TimeRanges.
export function fakeMedia(over = {}) {
  const el = { tagName: 'VIDEO', currentSrc: 'https://cdn.e.com/v.mp4', paused: false, ended: false, muted: false, volume: 1,
    duration: 600, ranges: [], ...over };
  el.played = { get length() { return el.ranges.length; }, start: i => el.ranges[i][0], end: i => el.ranges[i][1] };
  return el;
}
