# Afferent

Afferent is a Manifest V3 browser extension for Chrome and Edge. It captures the pages you actually read and
sends them to memory destinations **you** choose, such as your own Neurosea server (any server that speaks the webhook contract), Supermemory, Mem0 or Hindsight.
Neurosea is not open to the public yet, so the platform list offers Hindsight, Supermemory and Mem0.

- Plain JavaScript ES modules: no build step, no runtime dependencies, no remote code, no analytics.
- Talks only to destinations you configure. Nothing is ever sent to the developer.
- MIT licensed.

## Privacy model

| | |
|---|---|
| **Read** (page visible *and* focused, with input in the last 5 min, for ≥ threshold, default 10 s) | URL, title, visible text (`document.body.innerText`, or only the conversation on ChatGPT and Claude, or without the video player on Bilibili video pages, ≤ 100 000 chars), secrets redacted |
| **Glance** (focused for less than the threshold) | URL and title only; text is always `""` |
| **Never** | incognito windows (`"incognito": "not_allowed"`), tabs never seen focused, pages on the skip list, pages labelled adult, anything while paused or before consent |

- **Consent first.** Nothing is captured until you pick a platform and paste its key on
  the first-run page (it opens on install), read what will be sent where, and click **Agree and start**.
  "Don't record yet" leaves the extension inactive.
- **URL cleaning.** The fragment, any `user:password@` and secret-looking query parameters are removed before
  anything is stored (`token`, `code`, `key`, `sig`, `password`, `session`, `sid`, `jwt`, …, plus any name containing
  `token`, `secret`, `password` or `signature`). See `src/lib/url.js`. Exception: the video sound addresses sent to
  Neurosea (`audio.urls`) are kept and sent as given, because they are signed.
  - Tracking parameters are removed too: `utm_*`, `fbclid`, `gclid`, `dclid`, `gbraid`, `wbraid`, `msclkid`,
    `yclid`, `igshid`, `twclid`, `mc_cid`, `mc_eid`, `_hsenc`, `_hsmi`, `mkt_tok`, `spm`. So the same page
    reached from a newsletter and from a search has one URL and one `page_key`. Generic names such as `ref`
    or `from` are kept.
  - Names stored in `stripParams` (added in settings before 0.6.5) are removed the same way; settings no
    longer show them.
- **Sensitive-content redaction.** Before a record is built, text in the title and page text that looks like
  a secret is replaced with `[redacted:<rule>]` in this browser, before anything is sent. The send queue
  holds only the redacted record; the open visit draft keeps the raw text in local storage until the visit
  ends, like the page itself, and never leaves this browser profile.
  This happens before the 100 000-char cut, so a secret is never half-kept by the cut.
  - About thirty high-precision default rules, most adapted from
    [gitleaks](https://github.com/gitleaks/gitleaks) (MIT, see `THIRD_PARTY_NOTICES.md`): AWS access key IDs,
    GitHub, GitLab, OpenAI, Anthropic, Google API, Slack, Stripe live, npm, PyPI, Hugging Face, SendGrid,
    Telegram bot, Alibaba Cloud and Tencent Cloud keys, PEM private-key blocks, and the keys of the platforms
    Afferent sends to (Mem0, Supermemory, Hindsight, a Neurosea key and the token of an old connection code). Broad patterns such as
    JWTs are left out because they would eat ordinary text. See `src/lib/secrets.js`.
  - The default rules always apply; they cannot be switched off. Rules stored in `secretRules` (added in settings
    before 0.6.5, `name: regex`) keep applying; settings no longer show them.
  - The popup shows "N keys masked" on a capture that had redactions. The URL is not redacted; URL cleaning
    covers it.
- **Skip list.** One rule per line: `<domain>[/<path-prefix>]`. The domain also covers its subdomains.
  Always skipped: password managers (their sites and Apple's and Google's app-password pages) and adult content
  (pages with `<meta name="rating" content="adult">` or the RTA label, Google SafeSearch's two tags; checked by the
  content script when the page loads and on in-page navigation; a page that only sends the HTTP header, or adds the
  tag later, is recorded). The built-in list lives only in `src/lib/skip.js` and is not complete; settings show
  only your own sites (`skipOwn`), with an ⓘ that says what is built in. The payment, email and chat groups of
  0.6.4 and earlier are gone: a group that was on (`skipOn`) comes back as its sites among your own, and `skipOn` is
  then stored empty. The flat `skip` list of 0.4.2 and earlier is read once to convert the same way and never
  written, so going back to an older version finds the list it had. Rules are checked at every visit start, including SPA URL changes, and again on
  every report.
- **Tokens** are kept in `chrome.storage.local` only, never in sync storage. They are never logged and
  never shown in the popup.
- **Local data.** A record stays in `chrome.storage.local` until every destination has accepted it, and is
  then deleted. The popup keeps a list of the last 100 captures (metadata only).
  To delete, use Delete in a popup row's menu, or the trash icon next to Pause, which offers four ranges: last
  15 minutes, last hour, today, all. Either removes the local copies and asks Neurosea to hide those captures
  (`afferent.forget/1`), including what other computers recorded in that range. Neurosea hides them; it does not
  erase them. "All time" covers everything, here and on Neurosea; settings and platform connections stay. Data already
  sent to Supermemory, Mem0 or Hindsight must be deleted there. The settings page no longer has "Delete local records".

## Install (Load unpacked)

1. `git clone` this repo.
2. Open `chrome://extensions` (or `edge://extensions`) and turn on **Developer mode**.
3. Click **Load unpacked** and choose the repo folder.
4. On the first-run page, pick a platform (or just paste: a Neurosea [`nsk_` key](docs/webhook.md#key)
   and Supermemory, Mem0 and Hindsight cloud keys are recognised), paste its key and click **Agree and start**.
   Self-hosted Hindsight: **Change server URL** (a picked Hindsight with a key that is not `hsk_…` asks
   for the address by itself). Allow Chrome's prompt; Afferent tests the connection first.

Requires Chrome/Edge 130+.

## Configuration

The popup shows whether this page is recorded, Pause, the delete dialog (trash icon), today's list and the earlier ones (each row's menu: delete, or
**Don't record this site**). **Don't record this site** is also on the popup's card while the page is being recorded, and in the
page's right-click menu (http(s) pages): it adds the site to your own skip list and deletes
every capture from it the extension still holds, the way Delete does (Neurosea is asked to hide them; an open visit sends
nothing more, but past the read threshold Hindsight, Supermemory and Mem0 may already have a copy of it, which you delete there). The badge shows today's count, **Ⅱ** while paused, or **!** while a destination is failing.
Settings save on change: platforms (add, switch off, **Manage**: address and **Change**, which pages,
Neurosea's subtitles switch, **Remove**), the read threshold (default 10 s) and the skip list.
If a response is lost, the retry can reach the
receiver twice, so a receiver may answer `duplicate` or dedupe by `capture_id`.

## Destinations

You can enable any mix of them. Each has its own queue, its own *Which pages* setting (reads only, or reads and
glances). A site allowlist (`sites`, in the skip-list syntax) saved before 0.6.5 still applies: a record goes to a
destination only if its kind is selected there and, when that list is not empty, its URL matches it. Settings no
longer show it.
Every platform sends reads and glances by default; a platform connected before 0.6.2 keeps what it had.
Supermemory and Mem0 count or bill every write, and Mem0's free tier is capped by number of memories, so glances
use that up faster; switch to reads only under *Which pages* in settings.

| | Neurosea (webhook) | Supermemory | Mem0 | Hindsight |
|---|---|---|---|---|
| sends | the `afferent.page/1` record as is | one document per page | one memory per page | one document per page |
| default kinds | reads and glances | reads and glances | reads and glances | reads and glances |
| revisit | a new record each visit (dedupe by `page_key`) | replaces the page's document, unless unchanged | replaces the page's memory, unless unchanged | replaces the page's document, unless unchanged |
| host permission | your URL's origin | `https://api.supermemory.ai/*` | `https://api.mem0.ai/*` | the server URL's origin |

Supermemory and Mem0 were checked against their hosted services on 2026-11-13.
Hindsight was checked against a self-hosted server (0.10.3) on 2026-11-13; its cloud service has not been checked.

The memory platforms store `title`, newline, `url`, blank line, page text (a glance: title and url only)
plus flat metadata: `url`, `title`, `site`, `kind`, `dwell_seconds`, `first_seen`, `last_seen`,
`capture_id`, `page_key`, `source: "afferent"`.

**Unchanged pages.** The platforms bill each write, so Afferent keeps a SHA-256 of the content it last
wrote for each page (per namespace, user id, or Hindsight server and bank) in this browser. If a revisit's content is the same, nothing
is sent and the capture counts as *sent* (`unchanged`). A glance at a page already written there is
treated the same way, so it never replaces the stored text with title and URL. The page's metadata there (`dwell_seconds`,
`last_seen`, `capture_id`) is then not refreshed. The hash is stored only after a successful write. The webhook still receives every visit.

**Neurosea (webhook).** Afferent's public contract, [`afferent.page/1`](docs/webhook.md): one JSON record per POST,
with bearer auth, a defined response table and a GET health check. Your server gives you a connection
code that holds the URL, token and display name.

**Supermemory** (API v5). Settings: API key and namespace (default `afferent`; letters, digits, `_ : -`).
- Each page is one document whose id is the page's `page_key`. A visit `PATCH`es it, which replaces the
  content; if it does not exist yet (404) it is created with `POST`. Afferent never re-POSTs an existing id,
  because that appends instead of replacing.
- `taskType: "superrag"`: chunked and indexed for search, no fact extraction. Cheaper than the default
  pipeline, but still billed against your credits
  ([billing](https://supermemory.ai/docs/overview/billing.md)).
- HTTP 401/403: key rejected; 413: that page is given up; any other error, out of credits (402) included, keeps
  the page queued and the popup shows the server's answer.
- Writes are queued on Supermemory's side: a page becomes searchable, and a revisit's text replaces the old one,
  some seconds after it was sent. A page of 100,000 Chinese characters was stored whole (checked 2026-11-13).

**Mem0** (platform API). Settings: API key and user id (default `afferent`).
- Pages are added with `infer: false`: stored verbatim, no extraction LLM. Mem0 has no caller-chosen id, so
  Afferent remembers each page's memory id in this browser and updates that memory (`PUT`) on a revisit; if
  it is gone (404) it adds a new one. Afferent never uses search, which the free tier limits to 1k retrievals a month.
- Mem0 refuses an add of more than 100,000 tokens (HTTP 400); Afferent then gives up that page for Mem0 only. In
  practice this concerns pages of about 100,000 Chinese characters (measured: about one token per Chinese character);
  text in Latin scripts stays far below it at Afferent's 100,000-character cap. A page of 99,000 Chinese characters
  was stored whole (checked 2026-11-13).
- Costs: Mem0's free tier requires your own LLM key after 30 days, and it is not documented whether
  `infer:false` adds are exempt. See [Mem0 pricing](https://docs.mem0.ai/platform/pricing).
- Key: Mem0 advises keeping API keys server-side. Afferent stores it only in this browser
  (`chrome.storage.local`); use a key you can revoke at any time.

**Hindsight** (API v0.10, cloud or self-hosted). Asked when connecting: API key (cloud keys start with `hsk_`).
The server URL (default `https://api.hindsight.vectorize.io`) shows only after **Change server URL**, or by itself,
empty and required, when Hindsight was picked and the key is not `hsk_…` (a self-hosted server accepts any key, and
that key must not go to the cloud). The bank (default `afferent`) shows only when the server refused it. **Change**
shows both and tests again.
- Store only: connecting creates a missing bank with `retain_extraction_mode: "chunks"` and
  `enable_observations: false`, so pages are chunked and indexed without running your LLM. An existing bank in any
  other mode is refused (use a new bank name); Afferent never changes a bank it did not create.
- Each page is one document (`document_id` = `page_key`), written with `update_mode: "replace"` and `async: true`;
  metadata values are sent as strings. Only an answer with `success: true` counts as sent.
- HTTP 401/403: key rejected; 413: that page is given up; any other error keeps the page queued and the popup
  shows the server's answer.
- Do not delete the bank on the server while Hindsight is switched on in Afferent: the next write makes Hindsight
  re-create it in its default mode, which runs your LLM. To delete it, switch Hindsight off in Afferent first, delete
  the bank on the server, then connect again with **Change** (not with the switch), which creates the bank store-only
  again before anything is sent.

All keys and tokens stay in `chrome.storage.local`, are sent only to their own platform, and are never logged.

### Adding a destination

Each destination is one module in `src/adapters/`, exporting:

- `id`, `label`, `defaultKinds`, `configFields` (`{name, type, label, default?, pattern?, ask?}`; `ask: true`:
  asked in the connect box before the first connect; **Change** under Manage edits them, and the fields with a default);
- `origins(config)`, the host permissions to request;
- `send(record, config, state)`, resolving to `{outcome: 'done'|'failed'|'auth'|'retry', detail}`. `state`
  is a small per-destination store (`get(key)`, `set(key, value)`) in `chrome.storage.local`; most adapters
  ignore it;
- `test(config)`, resolving to `{result: 'ok'|'auth'|'unreachable'|'error'|'refused', ...}`; `refused` carries
  `message`, a message key the connect box shows instead of saving.

`classify(status)` in `src/adapters/http.js` is the default status table (2xx done, 401/403 auth, 413 failed,
anything else retry).

The core reaches adapters only through `src/adapters/index.js`, so adding a destination means one file plus
one line there.

## Capture and reliability design

```
content script (per tab)                      service worker
  visit start ── {start,url} ───────────────▶ consent? paused? skip rule?
             ◀── {capture,id,threshold} ────  creates draft v:<id> (normalized URL)
  dwell accumulator (visible && focused && input ≤ 5 min ago)
  every 15 s while active, at threshold,
  on hidden ── {report,dwell,title,text} ───▶ updates draft (re-checks rules)
  at threshold, on active → inactive
            ── {report,publish} ────────────▶ record → queue (per-page platforms) → flush; draft stays
  on leave  ── {report,end} ────────────────▶ finalize → record → queue → flush
                                  tabs.onRemoved ─▶ finalize that tab's drafts
                                  runtime.onStartup ─▶ finalize all drafts (browser was closed)
                                  alarm "sweep" (5 min) ─▶ finalize drafts silent for 30 min
```

- **A visit** runs from page load, or from an SPA URL change, until the user leaves. Leaving means: the
  URL changes, the page hides (`pagehide`), or the tab closes.
  - SPA changes (`pushState`, `replaceState`, back/forward) are detected by a 1 s tick that compares the URL.
  - Hash-only changes stay in the same visit.
  - The next visit starts after 1 s of a stable URL.
- **Dwell** is counted by a pure accumulator (`src/content/dwell.js`) that counts only while the document is
  visible *and* focused, and you gave input in the last 5 minutes: pointer, key, wheel or touch, the page
  loading or becoming visible, the window gaining focus, a back/forward-cache restore or a prerender activation
  (not scrolling, which pages also do themselves, not the popup, not playback). After 5 minutes without input the clock stops at the last input + 5 minutes, also across a
  sleep, and the next input starts it again. Idle neither sends the page nor ends the visit, and the title, language and text are not re-read while idle, except while media plays and for a visit's first read snapshot. The open toolbar popup takes focus from the page but asks it for its state each second;
  each ask counts as focus for 1.5 s, so the seconds the popup is open count as reading that page. The same 1 s tick samples focus; `visibilitychange` updates it at once and sends a
  snapshot when the tab is hidden, and `pageshow` restarts a visit after a back/forward-cache restore.
- **Chat pages.** On ChatGPT (`chatgpt.com`, `chat.openai.com`: `/c/<id>`, `/g/<gpt>/c/<id>`, `/share/<id>`)
  and Claude (`claude.ai`: `/chat/<id>`, `/share/<id>`) conversations, `src/content/extract.js` sends only the
  user and assistant turns, in order, as `User:` / `ChatGPT:` or `Claude:` blocks separated by a blank line.
  - Left out: other conversations in the sidebar, buttons, the input box, the footer, and tool, system and
    hidden turns. Tool results are where a memory connector's recalled content appears, so keeping them would
    send a memory its own content back.
  - The page markers are a small table at the top of `extract.js`. If none are found (or the site changed
    its markup), the page falls back to `document.body.innerText`, so nothing is lost.
  - On Bilibili video pages (`www.bilibili.com/video/…`) the text is the page without the video player
    (on-screen danmaku, player controls, subtitle overlay).
  - Only turns the page has rendered are seen; Claude renders long chats lazily as you scroll.
- **Text** is re-read at each report once dwell has crossed the threshold, so a growing page (e.g. a chat)
  is captured late. When an SPA URL changes, the DOM already shows the next page, so the exit report keeps
  the last snapshot. An extra report fires the moment the threshold is crossed, so that snapshot always
  exists.
- **Sent while reading.** At the threshold, and each time the page stops being active after it (another tab, another
  program, a click in a window beside it), the visit's record as it stands goes to the destinations that keep one copy
  per page: Hindsight, Supermemory and Mem0. The visit goes on; it keeps one popup row and counts once
  today. Neurosea gets one record, when the visit ends.
- **No lost reads.** The draft lives in `chrome.storage.local`, not in the page, so closing the tab or the
  whole browser still produces the record:
  - tab close: `tabs.onRemoved`;
  - browser close: on the next start, from the stored drafts.
  - At worst the last ≤ 15 s of dwell is missing.
  - If a long-hidden draft was already finalized by the sweep, a later report gets `{restart:true}` and the
    page starts a fresh visit.
- **Queue.** Each record is written to storage (`r:<id>`, `q:<dest>`) before any send.
  - One queue per destination, sent in order. A visit is queued once: a newer version replaces its record and
    moves it to the tail, and an answer for an older version that was out meanwhile leaves the newer one queued.
  - Only the service worker fetches, with a 20 s timeout.
  - The response handling follows the contract table:
    - 2xx: the record leaves the queue.
    - 400/411/413/415: the record is marked failed.
    - 401/403: the record is kept, and the destination stops sending until its settings change.
    - 408/429/5xx/network/timeout: retry with backoff of 30 s × 2ⁿ, capped at 30 min, scheduled with
      `chrome.alarms`. Statuses the contract does not list are treated the same way.
  - The queue flushes on every SW wake and whenever a record arrives.
- **Concurrency.** All storage read-modify-writes in the SW go through one promise chain. Fetches run
  outside it, and one flush loop per destination prevents double sends.

## Permissions

| permission | why |
|---|---|
| `storage`, `unlimitedStorage` | drafts, the queue and settings live in `chrome.storage.local`; queued texts can exceed 10 MB while a destination is down |
| `alarms` | retry backoff and the draft sweep survive service-worker shutdown |
| `activeTab` | when you click the Afferent icon, the popup may read the current tab's address to say whether this page is recorded; nothing about it is stored or sent |
| `contextMenus` | the **Don't record this site** item in a page's right-click menu |
| content scripts on `http://*/*`, `https://*/*` | dwell and text capture |
| `optional_host_permissions` `http://*/*`, `https://*/*` | only the origin of a platform you connect is requested, when you click Agree |

Afferent does not use `tabs`, `webNavigation`, `history` or `scripting`. `tabs.onRemoved` and
`tabs.create` (to open the first-run page) work without the `tabs` permission.

## Development

```
node --test            # unit + content-script tests (Node 24, no dependencies)
```

- `test/extract.test.js` runs the chat extractors against a small fake DOM (`test/fakedom.js`).
- `test/secrets.test.js` checks each redaction rule, the ordinary-text corpus and the 100 000-char timing.
- `test/content.test.js` runs the real content scripts in a `vm` with a fake DOM, wired to the real
  service-worker core over fake storage.
- [`docs/manual-test.md`](docs/manual-test.md) is the manual checklist, the browser test.
- `e2e/receiver.mjs` is a throwaway receiver for local testing. It sends no CORS headers, so a missing host
  permission shows up as a failed send.
