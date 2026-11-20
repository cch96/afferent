# Afferent privacy policy

_Last updated: 2026-11-20_

Afferent is an open-source browser extension. It does not collect any data for its developer.

## What Afferent processes

Afferent processes data only after you connect a platform on its first-run page and click "Agree and
start", and only while capturing is not paused. Connecting any platform, on the first-run page or in
settings, first shows what will be sent and where, before you agree. For web pages you view in normal (non-incognito) windows, it processes:

- **The page address (URL) and title.** Fragments, any user name or password in the address, secret-looking
  query parameters, tracking parameters (such as `utm_*` and `fbclid`) and any parameter names you listed in a version before 0.6.5
  are removed first.
- **The visible text of the page**, only when the page was visible and focused for at least your read
  threshold (default 10 seconds). On ChatGPT and Claude conversation pages, only the conversation's user and
  assistant messages are kept. On Bilibili video pages (`www.bilibili.com/video/…`), the video player (on-screen
  danmaku, player controls, subtitle overlay) is left out.
- **Redaction happens in your browser.** Before anything is sent, text in the title and page text that looks
  like a secret (API keys, access tokens, private keys, and any rules you added before 0.6.5) is replaced with
  `[redacted:<rule>]`. Only the redacted record is queued for sending; the draft of a visit still in progress
  keeps the raw text in local extension storage until the visit ends and never leaves your browser. The default
  rules always apply.
- **Timing:** how long the page was visible and focused, and when. The seconds the toolbar popup is open over a
  page count as reading that page.
- **Playback** (if you switched off "Record playback" before 0.5.4, it stays off): which videos and audio on the
  page you played, which parts (and which of them with the sound on), for how long, and how much of that was while
  the page was in the background;
  and the media file's address, cleaned like the page address (sensitive parameters removed; addresses that
  are not ordinary web links are left out). Nothing about the media content itself (no frames or sound) is
  recorded; for subtitles on Bilibili, see the next point. Muted videos playing in a tab you are not looking at are ignored. A page you only
  listened to in the background for at least a minute is recorded as read, with its text; such a record goes
  only to a webhook, never to Supermemory, Mem0 or Hindsight.
- **Subtitles**, only with Neurosea connected (without it, no subtitles are fetched) and unless you switch off Settings → Neurosea → Manage → Subtitles: on a Bilibili video page (`www.bilibili.com/video/…`) that you play for 50 seconds, the extension
  asks Bilibili, with your Bilibili login, for that video's subtitle list and then fetches one subtitle file
  (the uploader's, else the AI one). Apart from the sound's address below, nothing else is requested from Bilibili. The subtitle text is added to
  that page's record once you have played 60 seconds; leave between 50 and 60 seconds and the request was made but nothing is recorded. Your webhook receiver may fetch subtitles of other videos, such as YouTube ones, itself.
  With the switch off, nothing is fetched from Bilibili for pages opened afterwards, and every page record tells
  the receiver not to fetch subtitles for that page. A page already open keeps its setting and may still fetch,
  but the result is dropped: not stored or sent.
- **Video file addresses**, under the same switch and only with Neurosea connected: for a Bilibili video without
  subtitles, and a Xiaohongshu (rednote) video, that you play for 60 seconds (on Bilibili looked up from 50 seconds, like the subtitles), the extension also looks up where the
  video's sound or file can be downloaded (on Bilibili by asking Bilibili, with your login; on Xiaohongshu from the
  files the page already loaded) and sends that address to Neurosea only, never to Supermemory, Mem0 or Hindsight.
  Neurosea downloads it to transcribe the parts you played, then deletes the sound and the address. The extension
  itself downloads nothing. A Bilibili address contains your IP address and Bilibili account and device ids.

Afferent never processes pages on your skip list. Password managers (their sites and Apple's and Google's
app-password pages) and pages that label themselves as adult content are always skipped. "Label themselves" means a
`rating` meta tag (`adult` or the RTA label, as Google SafeSearch reads it), checked when the page loads and when it
navigates in place; a page that only sends the HTTP header, or adds the tag later, is recorded. The built-in list is
short (common password managers) and not complete: add any other site you do not want recorded under Settings → Skip list. If
you had turned on the payment, email or chat group of an earlier version, its sites are now on your own
list. It also skips pages in tabs you never looked at, unless you played audible media there for at least a minute.

## Where the data goes

- **To the destinations you configure, and nowhere else.** An example is your own Neurosea server, or any
  server you control that speaks Afferent's webhook contract. Afferent sends each record over HTTP(S) directly from your browser to that destination.
  Whatever the destination does with it is governed by that destination's own terms.
- **Third-party memory platforms.** If you enable a hosted platform such as Supermemory or Mem0, the
  records are sent to that company's servers with your API key, and from then on they fall under that
  platform's own privacy policy and terms, not this one. Hindsight works the same way and
  receives the same records; they are sent to your own or a hosted Hindsight server, which
  governs them from then on. Afferent sends them nothing unless you enable
  that destination. A per-platform site allowlist saved before 0.6.5 still limits which sites it receives;
  settings no longer show it.
- **Nothing goes to the developer.** Afferent has no analytics, telemetry, crash reporting or advertising,
  and loads no remote code.
- **Local storage.** Records waiting to be sent, a list of your last 100 captures, settings, destination
  tokens and API keys, (for Mem0) a map from each page to its memory id, and (for Supermemory, Mem0 and Hindsight) a hash of the content
  last sent for each page are kept in your browser's local extension storage. A record is deleted locally once every
  destination has accepted it. Tokens are never synced.

## Your controls

- **Pause** capturing at any time from the toolbar popup.
- **Delete** any single capture from its row menu in the popup, or a range with the trash icon next to Pause:
  the last 15 minutes, the last hour, today, or all. This removes those local records. On Neurosea it marks them removed, including those recorded on your other computers, so they can no longer
  be found or viewed; the raw text stays on your server and its backups until a later erase feature. "All time" does
  this for everything, here and on Neurosea; your settings and platform connections stay. Supermemory, Mem0 and
  Hindsight are not touched: data already sent there must be deleted there. The old "Delete local records" in Settings is gone.
- **Stop capturing a site** with one click (on the popup's card, in a recorded row's menu, or in the page's right-click
  menu), or edit the skip list. The click also deletes what was recently recorded from that site, as Delete does.
- **Uninstall** the extension to remove all of its local data.

## Permissions

`activeTab`: when you click the Afferent icon, Chrome lets Afferent read the current tab's address, so the
popup can say whether this page is being recorded. Nothing about it is stored or sent. Host permission is
asked only for the platforms you connect. If you turned screenshots on in a version before 0.6.9, Chrome keeps
the access to all sites granted then (removing it could also remove the access to your destination); you can
remove it in Chrome's extension settings.

`contextMenus`: adds "Don't record this site" to a page's right-click menu. It reads nothing until you click it,
and then only that page's site.

## Data sale and use

Afferent does not sell user data. It transfers data only to the destinations you connect, and only to save your pages there. It does not use or transfer data for any
purpose unrelated to its single purpose: sending your reading history to destinations you chose. It does
not use data to determine creditworthiness or for lending.

## Contact

Open an issue in the project's repository.
