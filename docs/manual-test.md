# Manual test checklist

This checklist is the browser test. Use Chromium or a Chrome/Edge build that still honours Load unpacked
(any build, through `chrome://extensions`).

## Setup

1. Start the throwaway receiver. It also serves the test pages:
   ```
   node e2e/receiver.mjs 8799
   ```
   - Key: `nsk_aHR0cDovLzEyNy4wLjAuMTo4Nzk5L2hvb2s.test-token` (shown as "Neurosea").
   - Older connection code, still accepted: `http://127.0.0.1:8799/hook#token=test-token&name=Test`. It sets the
     name "Test" that the rows below expect.
   - Pages: `http://127.0.0.1:8799/page.html`, `http://127.0.0.1:8799/other.html`.
   - Each stored record is printed as `record <kind> <url> <dwell> <chars>`.
   - Each delete is printed as `afferent.forget/1 <n> ids [<from>..<to>]`.
   - It sends no CORS headers, so the extension reaches it only through the host permission granted when you connect.
2. Open `chrome://extensions`, turn on Developer mode, then **Load unpacked** this folder. Expect no errors
   on the card. Pin Afferent to the toolbar.

Labels are quoted in English; the Chinese UI has the same layout (同意并开始 = Agree and start, 管理 = Manage, 不记的网站 = Skip list).

## First run

| # | do | expect |
|---|---|---|
| 1 | Install | The first-run page opens. The popup says "Not recording yet" with **Connect**. Visiting pages sends nothing. |
| 2 | Look before pasting; then click **Hindsight** | The key box is focused. Chips Hindsight, Supermemory, Mem0 (no Neurosea chip); under the box "No key? Pick a platform above first."; the sentence names "the platform you connect" and says pages are saved so you can find them later. Hindsight: "No key? Get one from Hindsight ↗ Self-hosted? Change server URL". The button does not move. |
| 2b | Paste `fake_key_00000000000000` with no chip; then click **Hindsight** | "This key isn't recognised. Pick a platform above.", red outline, button off. With Hindsight: an empty "Server URL" field asking for your address, no error, button off until an http(s) address is typed. |
| 2c | Paste the key | No chip is lit; the sentence names Neurosea, says what is saved and when, and is one sentence ending with playback, subtitles and the video file address for videos. |
| 2d | Replace it with the connection code | Still no chip lit; the sentence now names Test. |
| 3 | Click **Agree and start** and **deny** Chrome's prompt | "No permission. Click "Agree and start" again and choose "Allow"." Nothing is saved. |
| 4 | Paste the connection code with `token=wrong`, Agree, allow the prompt | "This key isn't recognised." with the red outline. |
| 5 | Paste the right connection code, Agree | "Connected to Test" with the pin hint; **Done** closes the tab. |
| 6 | Reinstall, click **Don't record yet** | The tab closes; nothing is recorded; the popup still offers **Connect**. |

## Popup and capture

| # | do | expect |
|---|---|---|
| 7 | Settings: threshold 5 s. Open page.html, open the popup at once | "Read 5 s to save" with a filling bar and the page title. |
| 7b | Threshold 10 s. Open a fresh page.html, open the popup at once and keep it open | The bar fills a little each second and flips to "Saved" about 10 s later (the popup's open seconds count as reading). |
| 8 | Keep page.html focused 8 s, then open the popup | "Saved". Leave the page: the receiver prints one `read …/page.html` with text; the row shows its time, the badge 1, "Delivered" at the list head. |
| 9 | On other.html for 2 s, then close the tab | `glance` record, 0 chars; the row says "Glanced". |
| 10 | Popup on `chrome://extensions` | "Browser page". |
| 11 | Popup on a built-in skipped site (e.g. `bitwarden.com`), then on a site you added to the skip list | "Not recorded" and "Built in, not recorded: bitwarden.com", no **Edit list**; on your own site "… is on the skip list", **Edit list** opens settings at the skip list. |
| 11b | A page with `<meta name="rating" content="adult">` (add it to a copy of page.html), stay 15 s, leave | No record; the popup says "Not recorded". |
| 12 | Click **Pause**, read page.html 8 s, leave | Card "Paused", badge **Ⅱ**, no record. **Resume**: the badge shows the count again. |
| 13 | Row menu (⋯) → **Delete** on a sent row | Notice "1 deleted" and "Test: hidden" ("Test: hide pending" may show for a moment first); the receiver prints `afferent.forget/1 1 ids`; today's count drops by one. |
| 14 | Stop the receiver, read a page, leave; then **Delete** that queued row | Notice "1 deleted" and "Test: hide pending"; the popup keeps that line until the receiver is back. After row 17's **Retry**, the receiver prints `afferent.forget/1 1 ids` and the line disappears. |
| 15 | Read page.html 8 s and leave, then row menu → **Don't record this site** | Notice "127.0.0.1 won’t be recorded from now on. Recent records deleted: 1."; the site's rows go and today's count drops; the receiver prints `afferent.forget/1 1 ids`; revisit page.html 8 s: no record. Remove the chip in settings afterwards. |
| 15b | Open page.html, open the popup while "Read … to save" or "Saved" shows, click **Don't record this site** on the card | The card turns grey: "Not recorded", "127.0.0.1 is on the skip list", no button (a double click does nothing more); the notice names the site and the count; nothing for this visit reaches the receiver except its `afferent.forget/1`. The card has no such button on a browser page, a skipped page, while paused or before consent. Remove the chip afterwards. |
| 15c | Right-click on page.html → **Don't record this site** | The site appears in settings' skip list, its rows leave the popup and the badge count drops; no notice. The item is missing on `chrome://` pages; it shows while paused and before consent. Remove the chip afterwards. |
| 16 | Receiver still stopped: read a page, leave | Banner "Can't reach Test · N queued" with **Retry**; badge **!**; rows say "Queued". |
| 17 | Restart the receiver, click **Retry** | The records arrive at once, the banner goes, the badge shows the count, "Delivered". |
| 18 | Restart the receiver with a different token (edit `token` in `receiver.mjs`), read a page | Banner "Test rejected the key · N queued" with **Settings**; no repeated attempts. A new key in settings resumes sending. |
| 19 | Open page.html in a background tab (middle-click), wait, close it without viewing | No record. |
| 20 | Read page.html 8 s, then quit the whole browser and restart it | A `read` record arrives shortly after the restart. |
| 21 | `page.html?token=abc&x=1#frag` for 8 s, then leave | The record url is `…/page.html?x=1`. |
| 22 | SPA: on any SPA site (e.g. GitHub), read one view 12 s, click to another view, read 3 s, leave | A `read` for the first URL with its own text, then a `glance` for the second. |
| 23 | SPA into a skipped prefix: add `feishu.cn/next/messenger` to the skip list; on `*.feishu.cn`, go from a doc to `/next/messenger/…` | The doc is recorded, and nothing is recorded for messenger. |
| 24 | Open an incognito window | The extension is unavailable there. |
| 25 | In the extension's details page, remove its access to 127.0.0.1. Read page.html 8 s, leave | The send fails: banner and **!**. Settings → Manage → **Change**, paste the connection code, allow the prompt: the record arrives. |

## Settings (everything saves on change)

| # | do | expect |
|---|---|---|
| 26 | Open settings | Test is listed "Connected · N today", with a switch and **Manage**. |
| 27 | Switch Test off, read a page | Status "Off"; nothing is sent; the row says "Local only" and there is no "Delivered". Switch it on: that page is still not sent (pages read while a platform is off never are). **Delete** it: "1 deleted" and "Test: hidden" ("Test: hide pending" may show for a moment first); the receiver prints `afferent.forget/1 1 ids`. |
| 27b | Switch Test off; popup trash icon → **Last hour** (selected) → **Delete**; then switch Test on | The dialog closes with no notice; the last hour's rows go; while off the popup shows "Test: hide pending". After switching on, the receiver prints one `afferent.forget/1` and the line disappears. |
| 27c | Popup trash icon → **All time**, read the line, → **Delete** | The line says everything here and on Test is hidden, settings and connections stay. The list is empty and today's count is 0; the receiver prints `afferent.forget/1 <n> ids [1970-01-01T00:00:00.000Z..<now>]`; Test stays connected. **Esc** or **Cancel** instead closes the dialog and focus is back on the trash icon. |
| 29 | Manage → Which pages: **Read pages only**; glance at other.html 2 s | No glance is printed. Switch back to **Every page I open**. |
| 30 | Drag the threshold slider to 15 s, close and reopen settings | It stays at 15 s; the popup says "Read 15 s…". |
| 31 | Skip list: add `example.com`, then remove it with its **×** | Only your own sites show, each a chip with **×**; no lock, no group chips, no list of built-in sites. `example.com` appears as a chip and goes on **×**. |
| 31a | On a profile that had **Email** turned on in 0.6.4, update and open settings | The mail sites (`mail.google.com`, …) are chips among your own sites, each once. `mail.google.com` is still not recorded. |
| 31b | Point at the ⓘ after "Skip list" and press **Esc**; point at it again, move onto the card, then away; Tab to it, press **Esc**, Tab on; click it; scroll until it is near the window bottom and Tab to it | The card says "You can also add a site from a page’s right-click menu or from the popup.", then "Built in: 13 password-manager sites (such as 1password.com) and pages that label themselves adult." and, in bold, "The built-in list is not complete. Add what it misses." It shows on hover, focus and click, stays while the pointer is on the ⓘ or the card, and hides on leaving both, on **Esc** and when focus moves on. Near the window bottom it opens above, its caret pointing down at the ⓘ. |
| 32 | **Add platform**: pick a chip or paste a key | The same connect box as the first-run page (label "API key" instead of the title), ending in **Agree and connect**. **Cancel** closes it. Manage → **Change** shows no chips and every field (Hindsight: server URL and bank) prefilled. |
| 33 | Look over the whole page | Exactly three blocks: Send to, Save text after, Skip list. No Advanced, no Sensitive info, no box for your own key rules or address parameters. |

## Supermemory and Mem0

Needs your own keys. Use a throwaway namespace / user id (e.g. `afferent-manual`); the data stays on the
platform until you delete it there. `scripts/platform-check.mjs` checks the API side automatically; these
steps check the browser side.

| # | do | expect |
|---|---|---|
| 37 | Settings → **Add platform**, paste the Supermemory key (`sm_…`), **Agree and connect** | It is recognised as Supermemory; Chrome asks for `api.supermemory.ai` only. Then Manage → **Change**: paste the key again, namespace `afferent-manual`, **Connect**. |
| 38 | Manage → **Change**: paste the key, namespace `a.b` | The field's error; **Connect** is off and nothing is saved. Set it back. |
| 39 | **Change** `sm_wrongwrong` | "This key isn't recognised." Restore the key. |
| 40 | Read any page 12 s, leave | The popup item is *sent* for Supermemory. In the Supermemory console the namespace has one document with the page's title, URL and text. |
| 41 | Read the same page again (change something on it if you can), leave | Still one document for that page, now with the latest text. |
| 42 | Read the same page again without changes, leave | The popup item is *sent*, but no new request reaches Supermemory (no new entry in its console activity, no credit used). |
| 43 | Glance at a page (2 s) | Sent to Supermemory as title and URL only (default: reads and glances). |
| 45 | Mem0: user id `afferent-manual` | Chrome asked for `api.mem0.ai` only. |
| 46 | Read a page 12 s, leave; read it again, leave | The Mem0 dashboard shows one memory for user `afferent-manual`, holding the latest text. |
| 47 | Revoke the Mem0 key in Mem0's dashboard, read a page | **!** and the popup banner "Mem0 rejected the key · N queued"; the row says "Queued". Manage → **Change** with a fresh key: it is sent. |

## Hindsight

Needs a Hindsight key (cloud) or a self-hosted server. Use a bank name that does not exist yet (e.g.
`afferent-manual`); delete it on the server afterwards. `scripts/platform-check.mjs` checks the API side.

| # | do | expect |
|---|---|---|
| 48a | Settings → **Add platform**, click **Hindsight**, paste your self-hosted key (not `hsk_…`) | An empty **Server URL** field appears under the box; no bank field; the button is off. Type `x` as the URL: an error, the button stays off. (A cloud `hsk_…` key instead hides the field; **Change server URL** shows it with the cloud default.) |
| 48b | Set your server URL, **Agree and connect** (to test a refused bank: first **Change** with bank `afferent-manual`) | Chrome asks for that server's origin only. Connected. On the server the bank exists with `retain_extraction_mode: chunks` and `enable_observations: false`. Manage shows no URL/bank fields. |
| 48c | **Change** with the same key and the bank of an existing bank that extracts (the server's default mode) | "This bank runs a model over what it stores. Use a new bank name." Nothing changes, and that bank's config is unchanged. |
| 48d | Read a page 12 s, leave | The popup item is *sent* for Hindsight. The bank has one document with the page's title, URL and text. |
| 48e | Read the same page again with a change, leave | Still one document for that page, now with the latest text. |
| 48f | **Change** `hsk_wrongwrong` | "This key isn't recognised."; nothing saved. |
| 48g | Revoke the key on the server, read a page | **!** and the banner "Hindsight rejected the key · N queued". **Change** with a valid key: it is sent. |

## Chat pages and redaction

Use your own ChatGPT and Claude accounts. Add a chat with at least one web search or tool call. The
receiver prints `<chars>`; to see the text, look at the record in the receiver output or add a `console.log`.

| # | do | expect |
|---|---|---|
| 49 | ChatGPT: open a conversation (`chatgpt.com/c/…`) with a few turns and a web search, read 12 s, leave | The record text is `User:` / `ChatGPT:` blocks in order. No sidebar titles, no "Copy" / "Share" labels, no input-box text, no search-result or tool output. |
| 50 | ChatGPT: a custom GPT chat (`/g/…/c/…`) and a shared link (`/share/…`) | The same format. |
| 51 | ChatGPT home page and settings, read 12 s | The record is the plain page text (no `User:` blocks). |
| 52 | Claude: open a conversation (`claude.ai/chat/…`) that used a tool (web search, analysis), read 12 s, leave | `User:` / `Claude:` blocks in order; no sidebar, no tool call or result blocks, no buttons. |
| 53 | Claude: `claude.ai/new` and `claude.ai/projects`, read 12 s | Plain page text. |
| 54 | If a chat comes out as plain page text, the site's markup changed | Update the marker table in `src/content/extract.js`. |
| 55 | Serve a local page (e.g. `python3 -m http.server`) containing a fake key, e.g. `ghp_` followed by 36 letters and digits, and `AKIA` followed by `IOSFODNN7EXAMPLE`. Read it 12 s, leave | The record text shows `[redacted:github-pat]` and `[redacted:aws-access-token]`. The popup row shows "2 keys masked". |
| 56 | On a profile that unticked "GitHub personal access token" before 0.5.5, read the page again | Both are still redacted: every default rule always applies. |
| 57 | On a profile that saved `badge: EMP-\d{6}` under Advanced → Sensitive info → "Keys" before 0.6.5, update; put `EMP-123456` on the page and read it | `[redacted:badge]`: stored rules keep applying. |
| 58 | Same profile, with `invite` saved under "Address parameters" before 0.6.5: read `page.html?invite=1&x=2&utm_source=t` | The record url is `…/page.html?x=2`. |

## Playback

The receiver prints `<chars>` only; to check `media`, look at the record body in the receiver output.

| # | do | expect |
|---|---|---|
| 59 | YouTube: watch a video 0:00–0:30, seek to 1:00, watch to 1:30, leave | A `read` record whose `media` has one `video` entry, `played` about `[[0,30],[60,90]]`, `play_s` about 60. YouTube plays from a `blob:` URL, so `src` is absent. |
| 60 | Bilibili: watch a video 2 min, click the next video in the list (same tab), watch 1 min, leave | Two records (one per URL), each with its own `media` entry. |
| 61 | A podcast page with a plain `<audio>` player: play it, switch to another tab for 3 min, come back, close the tab | One `read` record; `media[0].kind` is `audio`, `src` is the episode URL without sensitive parameters, `background_s` about 180, `play_s` ≥ `background_s`. |
| 62 | Start audible playback, switch to another tab and leave it for 35 min, then close the playing tab | One record arrives only at the close (the 30-min sweep did not end it early), with `background_s` about 2100 and `dwell_seconds` small. |
| 63 | Open a page with muted autoplay (e.g. a news site with a muted video) in a background tab, wait 2 min, close it unseen | No record. |
| 64 | Only on a profile that had **Record playback** switched off before 0.5.4: repeat 59 | The record has no `media`. |

## Subtitles

Logged in to Bilibili in this Chrome, Settings → Neurosea → Manage → **Subtitles** on (default). Watch each video at least 70 s, then leave. Look at `subtitle_status`, `subtitles[0].lang`,
`auto` and the first lines in the record body.

| # | do | expect |
|---|---|---|
| B1 | 10 Bilibili videos: at least 3 with uploader (CC) subtitles, 3 with only AI subtitles, 1 multi-part video opened at `?p=2`, 1 without any subtitles, the rest whatever you watch | Uploader videos: `ok`, `lang` like `zh-CN`, `auto: false`. AI-only: `ok`, `lang` `ai-zh` (or another `ai-…`), `auto: true`. `?p=2`: the lines match part 2, not part 1. No subtitles: `none`. For each video also note which element plays it (DevTools → Elements: `<video>`, or Bilibili's custom `<bwp-video>`; the latter is not tracked yet, so report it). **Gate: at least 8 of the 10 that have subtitles end with `ok`.** |
| B2 | Any `error` in B1 | `subtitle_error` names the call and what failed, e.g. `wbi/v2 code -352` (Bilibili now wants signed requests: tell the developer), `view HTTP 412`. |
| B3 | Watch a video only 40 s, leave | No `subtitle_status` (60 s of playback not reached). |
| B4 | Watch one video 2 min, click the next in the list (same tab), watch 70 s | Each record has its own subtitles. |
| B5 | Log out of Bilibili, watch a video that has subtitles | `login` or `none`, no `subtitles`. Log back in. |
| B6 | Turn **Subtitles** off, then open a video in a **new tab** (switches are read when a visit starts; a page already open keeps the old setting) and watch it 70 s; then read any other page, e.g. a YouTube video | Both records have `subtitle_status: "off"` and no other `subtitle_*` field, and DevTools → Network of the Bilibili page shows no `x/player/wbi/v2` request from the extension. Switch it back on. |
| B8 | A Bilibili non-video page (home, a bangumi `/bangumi/play/…` page) for 2 min | No `subtitle_*` fields. |
