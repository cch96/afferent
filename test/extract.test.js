import test from 'node:test';
import assert from 'node:assert/strict';
import '../src/content/extract.js';
import { h, doc } from './fakedom.js';
const { extract } = globalThis.AfferentExtract;
const at = href => ({ href });

const chatgptPage = () => doc(
  h('nav', {}, h('a', { href: '/c/1' }, 'Old chat about taxes'), h('a', {}, 'Trip planning')),
  h('main', {},
    h('article', { 'data-testid': 'conversation-turn-1', 'data-turn': 'user' },
      h('h5', { class: 'sr-only' }, 'You said:'),
      h('div', { 'data-message-author-role': 'user' }, h('div', {}, 'What is 2+2?'))),
    h('article', { 'data-testid': 'conversation-turn-2', 'data-turn': 'assistant' },
      h('h6', { class: 'sr-only' }, 'ChatGPT said:'),
      h('div', { 'data-message-author-role': 'tool' }, 'TOOL OUTPUT recalled memory'),
      h('div', { 'data-message-author-role': 'assistant' },
        h('p', {}, 'It is ', h('strong', {}, '4'), '.'),
        h('pre', {}, h('div', { 'data-markdown-copy': 'exclude' }, 'python', h('button', {}, 'Copy code')),
          h('code', {}, 'print(2+2)'))),
      h('div', { class: 'turn-action-controls' }, h('button', {}, 'Copy'), h('button', {}, 'Good response'))),
    h('div', { 'data-message-author-role': 'system' }, 'SYSTEM PROMPT'),
    h('div', { hidden: '' }, h('div', { 'data-message-author-role': 'assistant' }, 'HIDDEN DRAFT')),
    h('article', { 'data-testid': 'conversation-turn-3', 'data-turn': 'user' },
      h('div', { 'data-message-author-role': 'user' }, 'Thanks!')),
    h('form', {}, h('textarea', {}, 'draft in the input box'), h('button', {}, 'Send'))),
  h('footer', {}, 'ChatGPT can make mistakes.'));

const CHATGPT_TEXT = 'User:\nWhat is 2+2?\n\nChatGPT:\nIt is 4.\n\nprint(2+2)\n\nUser:\nThanks!';

for (const url of ['https://chatgpt.com/c/6820-ab', 'https://chatgpt.com/g/g-abc-helper/c/6820-ab',
  'https://chatgpt.com/share/6820-ab', 'https://chat.openai.com/c/6820-ab', 'https://chatgpt.com/c/6820-ab?model=x']) {
  test(`chatgpt: ${url} keeps only user and assistant turns, in order`, () => {
    assert.deepEqual(extract(at(url), chatgptPage()), { text: CHATGPT_TEXT });
  });
}

test('chatgpt: 2026-10 layout without role attributes (search unit keys)', () => {
  const d = doc(
    h('nav', {}, 'Sidebar title'),
    h('div', { 'data-turn-key': 'k1' },
      h('div', { 'data-chatgpt-search-unit-key': 'k1:0:user' }, h('div', { 'data-user-message-bubble': '' }, 'Plan a trip')),
      h('div', { class: 'group/activity-header' }, 'Searched 3 sites'),
      h('div', { 'data-chatgpt-search-unit-key': 'k1:1:assistant' },
        h('div', { 'data-content-search-unit-key': 'k1:1:assistant' }, h('p', {}, 'Day 1: Kyoto.')))),
    h('button', {}, 'Share'));
  assert.deepEqual(extract(at('https://chatgpt.com/c/1'), d), { text: 'User:\nPlan a trip\n\nChatGPT:\nDay 1: Kyoto.' });
});

const claudePage = () => doc(
  h('nav', {}, h('a', {}, 'Recents'), h('a', {}, 'Quarterly report draft')),
  h('main', {},
    h('div', { 'data-testid': 'user-message' }, h('p', {}, 'Summarize this.')),
    h('div', { 'data-is-streaming': 'false' },
      h('div', { class: 'font-claude-response' },
        h('div', { 'data-testid': 'tool-call' }, 'web_search', h('div', {}, 'RESULT from the tool')),
        h('div', { 'data-cds': 'TurnStatus' }, 'Searched the web'),
        h('p', {}, 'Here is the summary.')),
      h('div', { 'data-testid': 'message-actions' }, h('button', {}, 'Copy'), h('button', {}, 'Retry'))),
    h('div', { 'data-testid': 'user-message' }, 'Shorter please.'),
    h('div', { 'data-is-streaming': 'true' }, h('div', { class: 'font-claude-response' }, 'Short summary.')),
    h('fieldset', {}, h('div', { contenteditable: 'true' }, 'typing in the input'), h('button', {}, 'Send'))),
  h('footer', {}, 'Claude can make mistakes.'));

const CLAUDE_TEXT = 'User:\nSummarize this.\n\nClaude:\nHere is the summary.\n\nUser:\nShorter please.\n\nClaude:\nShort summary.';

for (const url of ['https://claude.ai/chat/0b1c-22', 'https://claude.ai/share/0b1c-22']) {
  test(`claude: ${url} keeps only user and assistant turns, no tool output`, () => {
    assert.deepEqual(extract(at(url), claudePage()), { text: CLAUDE_TEXT });
  });
}

test('older claude markup (.font-claude-message) still counts as Claude', () => {
  const d = doc(h('div', { 'data-testid': 'user-message' }, 'Hi'), h('div', { class: 'font-claude-message' }, 'Hello!'));
  assert.deepEqual(extract(at('https://claude.ai/chat/1'), d), { text: 'User:\nHi\n\nClaude:\nHello!' });
});

test('no markers → null, so the page falls back to body text', () => {
  const d = doc(h('nav', {}, 'Sidebar'), h('main', {}, h('p', {}, 'Loading…')));
  assert.equal(extract(at('https://chatgpt.com/c/1'), d), null);
  assert.equal(extract(at('https://claude.ai/chat/1'), d), null);
  assert.equal(extract(at('https://chatgpt.com/c/1'), doc(h('div', { 'data-message-author-role': 'tool' }, 'x'))), null);
});

test('non-chat URLs on those hosts and other hosts → null', () => {
  for (const url of ['https://chatgpt.com/', 'https://chatgpt.com/gpts', 'https://chatgpt.com/g/g-abc-helper',
    'https://chatgpt.com/c/', 'https://chatgpt.com/library', 'https://claude.ai/', 'https://claude.ai/new',
    'https://claude.ai/settings/profile', 'https://claude.ai/projects', 'https://claude.ai/recents',
    'https://example.com/c/1', 'https://notchatgpt.com/c/1']) {
    assert.equal(extract(at(url), chatgptPage()), null, url);
    assert.equal(extract(at(url), claudePage()), null, url);
  }
});
