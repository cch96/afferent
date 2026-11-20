// Classic script (shared with content.js in the isolated world), also importable by node tests.
// On ChatGPT and Claude conversation pages, returns only the user and assistant turns, so the record has
// no sidebar titles, buttons or input box, and no tool output. Tool results are where a memory connector's
// recalled content shows up; keeping them would feed a memory its own content back.
// Returns null when the page is not a known chat page or no turn is found: content.js then uses body text.
(() => {
  // Markers per site. Update here when a site changes its markup.
  // turns: [selector, role]; role is fixed, or '@attr' = last ':'-separated part of that attribute's value.
  const SITES = [
    {
      // Markers as observed by Hister's ChatGPT extractor (github.com/asciimoo/hister, facts only) and by
      // chat-md-exporter (MIT, github.com/infinitr0us/chat-md-exporter), which documents the 2026-10 layout
      // without role attributes.
      hosts: ['chatgpt.com', 'chat.openai.com'],
      paths: [/^\/c\/[^/]+\/?$/, /^\/g\/[^/]+\/c\/[^/]+\/?$/, /^\/share\/[^/]+\/?$/],
      label: 'ChatGPT',
      turns: [
        ['[data-message-author-role]', '@data-message-author-role'],
        ['[data-testid^="conversation-turn-"][data-turn]', '@data-turn'],
        ['[data-chatgpt-search-unit-key]', '@data-chatgpt-search-unit-key'],
        ['[data-content-search-unit-key]', '@data-content-search-unit-key'],
      ],
      drop: '.sr-only, [data-markdown-copy="exclude"], .turn-action-controls, [class*="group/activity-header"], button',
    },
    {
      // Markers from chat-md-exporter (MIT, see above) and chat-exporter-for-claude
      // (MIT, github.com/brokoskokoli/chat-exporter-for-claude).
      hosts: ['claude.ai'],
      paths: [/^\/chat\/[^/]+\/?$/, /^\/share\/[^/]+\/?$/],
      label: 'Claude',
      turns: [
        ['[data-testid="user-message"]', 'user'],
        ['.font-claude-response', 'assistant'],
        ['.font-claude-message', 'assistant'],
        ['[data-is-streaming]', 'assistant'],
      ],
      drop: '[data-testid="tool-call"], [data-cds="TurnStatus"], [data-cds="Icon"], [data-testid="message-actions"], .sr-only, button',
    },
  ];
  // Not aria-hidden: modal dialogs set it on the whole page behind them.
  const HIDDEN = '[hidden]';
  const BLOCK = /^(P|DIV|PRE|UL|OL|LI|H[1-6]|TABLE|TR|BLOCKQUOTE|SECTION|ARTICLE|HEADER|FOOTER|DETAILS|FIGURE)$/;

  // innerText where possible (it follows the layout); walk down only around parts that must go.
  function textOf(n, skip, root = false) {
    if (n.nodeType === 3) return n.textContent;
    if (n.nodeType !== 1 || (!root && n.matches(skip))) return '';
    if (!n.querySelector(skip)) return n.innerText;
    return [...n.childNodes].map(c => (BLOCK.test(c.tagName) ? `\n${textOf(c, skip)}\n` : textOf(c, skip))).join('');
  }

  function extract(loc, doc) {
    const u = new URL(loc.href);
    const site = SITES.find(s => s.hosts.includes(u.hostname) && s.paths.some(p => p.test(u.pathname)));
    if (!site) return null;
    const all = site.turns.map(([sel]) => sel).join(', ');
    const role = n => {
      const r = site.turns.find(([sel]) => n.matches(sel))[1];
      return r[0] === '@' ? (n.getAttribute(r.slice(1)) || '').split(':').pop().trim().toLowerCase() : r;
    };
    const isTurn = n => ['user', 'assistant'].includes(role(n));
    const blocks = [];
    for (const n of doc.querySelectorAll(all)) {
      // A wrapper around another turn is not the message itself; the inner one is.
      if (!isTurn(n) || n.closest(HIDDEN) || [...n.querySelectorAll(all)].some(isTurn)) continue;
      // Marker nodes still inside are tool or system parts: dropped with the site's UI parts.
      const text = textOf(n, site.drop + ', ' + all, true).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
      if (text) blocks.push(`${role(n) === 'user' ? 'User' : site.label}:\n${text}`);
    }
    return blocks.length ? { text: blocks.join('\n\n') } : null;
  }

  // Body text of any page. On Bilibili video pages it leaves out the player: on-screen danmaku, controls, subtitle overlay.
  // Player root seen live on 2026-11-12; danmaku sit in .bpx-player-render-dm-wrap inside it. Walking down past
  // innerText means unrendered elements must go too: innerText of a script or style is its source.
  const BILI_SKIP = '[id="bilibili-player"], script, style, noscript, template';
  function pageText(loc, doc) {
    const u = new URL(loc.href);
    if (u.hostname !== 'www.bilibili.com' || !u.pathname.startsWith('/video/') || !doc.body) return doc.body?.innerText ?? '';
    try { return textOf(doc.body, BILI_SKIP, true).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim(); } catch { return doc.body.innerText; }
  }

  globalThis.AfferentExtract = { extract, pageText };
})();
