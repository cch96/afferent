# afferent.page/1 and afferent.forget/1 — webhook contract (shared by Afferent and every receiver)

One HTTP request carries one record (`afferent.page/1`) or one delete request (`afferent.forget/1`), told apart
by `schema`, both to the same URL.

## Send

`POST <webhook URL>`
Headers: `Content-Type: application/json`, `Authorization: Bearer <token>`.
Body: one JSON object.

What Afferent guarantees for each field:

| field | type | rule |
|---|---|---|
| `schema` | string | exactly `"afferent.page/1"` |
| `capture_id` | string | UUID v4, canonical lowercase (`crypto.randomUUID()`); unique per captured visit; a retry resends the same value |
| `page_key` | string | 64 lowercase hex = SHA-256 of the UTF-8 bytes of `url` (the stored, already-normalized URL); same page, same key across visits |
| `kind` | string | `"read"` (dwell ≥ threshold, or summed `media[].play_s` ≥ 60) or `"glance"` (anything else); there is no record when dwell is 0 and summed `play_s` < 60 |
| `url` | string | `http:` or `https:` only; ≤ 2048 chars; no fragment; no username or password; sensitive query parameters removed (see Afferent's normalizer) |
| `title` | string | ≤ 1000 chars; may be `""` |
| `site` | string | the URL's hostname as the browser reports it (lowercase; IPv6 literals keep their brackets) |
| `text` | string | `read`: visible page text (on `www.bilibili.com/video/…` pages without the video player: on-screen danmaku, player controls, subtitle overlay), ≤ 100000 chars, may be `""`; `glance`: always `""` |
| `dwell_seconds` | integer | 0 ≤ n ≤ 604800; seconds the page was visible and focused, with input from the user in the last 5 minutes, during this visit (seconds the toolbar popup was open over it count as focused); can be 0 for a `read` from playback alone (a `read` from playback alone goes only to the webhook, never to Supermemory or Mem0) |
| `first_seen` | string | UTC ISO 8601 `YYYY-MM-DDTHH:MM:SS.sssZ`; the earliest counted dwell or counted-playback moment of the visit |
| `last_seen` | string | same format, ≥ `first_seen`; the latest counted dwell or counted-playback moment; with no input, the dwell part stops at the last input + 5 minutes |
| `lang` | string | optional, omitted when the page has none (never `null`); ≤ 35 chars |
| `client` | object | `{"name": "afferent", "version": "<string ≤ 50>"}` |
| `media` | array | optional; omitted when empty or when the user turned "record playback" off before 0.5.4, which removed that switch (an old off stays off; never `null`). See below |
| `subtitles` | array | optional, Bilibili video pages only; at most one track. See below |
| `subtitle_status` | string | optional; `"ok"`, `"none"`, `"login"`, `"error"` or `"off"`. See below |
| `subtitle_error` | string | optional, only with `subtitle_status: "error"`; ≤ 100 chars. See below |
| `audio` | object | optional, from 0.7.0; Bilibili video pages without subtitles and Xiaohongshu note pages; never with `audio_error`. See below |
| `audio_error` | string | optional, from 0.7.0; ≤ 100 chars, never a URL; never with `audio`. See below |

All strings are well-formed Unicode (Afferent applies `toWellFormed()`).
Afferent never sends a body over 512 KiB.

## `media`

The videos and audio the user played during the visit, at most 20 entries, each:

```
{ "kind": "video" | "audio", "src": "<http(s) URL>", "duration_s": <number> | null,
  "played": [[<start_s>, <end_s>], ...], "heard": [[<start_s>, <end_s>], ...], "play_s": <integer>,
  "background_s": <integer> }
```

Counted playback is wall-clock time an element was playing (not paused, not ended) while the page was
active (visible and focused), or while the element was audible (not muted, volume > 0). Muted autoplay in a
background tab is not counted.

| field | rule |
|---|---|
| `kind` | `video` or `audio`, from the element tag |
| `src` | present only for `http:`/`https:` sources (absent for `blob:`, `data:`, `mediastream:`, …); normalized like `url` (no fragment, no userinfo, sensitive and tracking parameters removed); ≤ 2048 chars (query cut first, else the field is absent) |
| `duration_s` | the media duration rounded to 0.1 s, or `null` when unknown or live |
| `played` | parts played during the visit, in media seconds rounded to 0.1 s, sorted, ranges ≤ 1 s apart merged; at most 50 (the 50 longest, sorted by start) |
| `heard` | from 0.7.0: the parts of `played` during which the element was unmuted with volume > 0 (muted autoplay in a page you look at is played, not heard), same rounding and merging as `played`; may be `[]`. A seek, loop or reload is a gap. A tab or site muted in Chrome still counts as heard. Absent from older versions: then treat `played` as heard |
| `play_s` | whole seconds of counted playback, ≥ 1 (shorter entries are left out) |
| `background_s` | the part of `play_s` while the page was not active; ≤ `play_s` |

Entries are in order of first play; past 20, the ones with the most `heard` time are kept, then those with the largest `play_s`. An element whose
source changes starts a new entry. A visit with counted playback going on stays open while the page is in
the background (it is not ended by the 30-minute background sweep).

## `subtitles`, `subtitle_status`, `subtitle_error`

Bilibili answers subtitle requests only to logged-in browsers, so the extension fetches them from the page,
with the user's own login, once per visit: on `https://www.bilibili.com/video/BV…` pages (part `?p=`, default
1), starting when the visit's summed counted playback reaches 50 s, and only while "Subtitles" (default on; called
"Bilibili subtitles" before 0.5.4) is on and "record playback" was not switched off before 0.5.4. The answer is recorded only once playback reaches 60 s:
a visit that leaves between 50 and 60 s made the request but records nothing.
If "Subtitles" is off when the visit ends, the record, on any site, has `subtitle_status: "off"` and neither
`subtitles` nor `subtitle_error`. If an old "record playback" off remains and "Subtitles" is on, all three fields are absent.

```
"subtitles": [ { "source": "bilibili", "lang": "<Bilibili lan, e.g. zh-CN or ai-zh>", "auto": <bool>,
                 "lines": [[<from_s>, <to_s>, "<text>"], ...] } ],
"subtitle_status": "ok" | "none" | "login" | "error" | "off",
"subtitle_error": "<which call and what, e.g. 'wbi/v2 code -352', 'view HTTP 412'>"
```

| field | rule |
|---|---|
| `subtitles` | only with `ok`; one track: the uploader's (a `lang` without the `ai-` prefix) if any, else `ai-zh`, else the first listed. `auto` is `true` for AI subtitles (`lang` starts with `ai-`) |
| `lines` | in the file's order; times in seconds rounded to 0.1 s; text capped at 60,000 characters in total (later lines dropped) |
| `subtitle_status` | on every record where the fetch ran: `ok` (a track is in `subtitles`), `none` (the list was empty), `login` (the list was empty and Bilibili said subtitles need login), `error` (a request failed or its answer was not understood). Also `off` on any page record, not only Bilibili ones: the user switched "Subtitles" off, so the receiver should not fetch subtitles for that page either |
| `subtitle_error` | only with `error`: the call (`view`, `wbi/v2`, `subtitle`) and what went wrong (`HTTP <status>`, `code <code>`, `not JSON`, `network error`, …) |

A record still fits in 512 KiB: the page `text` is shortened first, then subtitle lines from the end.
The fetch may also not have finished when the visit ends; then the three fields are absent.

## `audio`, `audio_error`

Where the video's sound (Bilibili) or file (Xiaohongshu) can be downloaded, so the receiver can transcribe the
parts the user played. The extension only looks up the address; it downloads nothing. Sent only to this
webhook (Neurosea): Hindsight, Supermemory and Mem0 never get either field. Same gate as subtitles: only while
Neurosea is connected and "Subtitles" is on; switched off before the visit ends, both fields are dropped.
Once per visit, when the visit's summed counted playback reaches 60 s (on Bilibili looked up from 50 s and recorded from 60 s, like subtitles):

- **Bilibili** (`https://www.bilibili.com/video/BV…`): right after the subtitle fetch, only when its
  `subtitle_status` is not `"ok"`. The page calls `x/web-interface/view` (cid of part `?p=`) and then
  `x/player/wbi/playurl?bvid=…&cid=…&fnval=16` (unsigned, with the user's login), and takes the DASH audio stream
  with the lowest bandwidth.
- **Xiaohongshu** (`www.xiaohongshu.com` and `www.rednote.com`, at `/explore/<id>` and `/discovery/item/<id>`):
  the most recent `.mp4` file on an `xhscdn.com` or `rednotecdn.com` host in the page's resource timing.

Every later version of the same visit's record carries the latest address. While the page stays open, a Bilibili
address with under 30 minutes left before `expires` is looked up again, at most once every 10 minutes; a failed
lookup is tried again 10 minutes later, and the old address is kept until it expires. A record built at or after `expires` (for instance when the visit ends long after the lookup) still
carries that address; the receiver drops dead addresses.

```
"audio": { "source": "bilibili" | "xiaohongshu", "urls": ["<url>", ...], "expires": <unix seconds> | null },
"audio_error": "<which call and what, e.g. 'playurl HTTP 412', 'playurl code -352', 'view code -404', 'xhs no video url'>"
```

| field | rule |
|---|---|
| `urls` | 1–4 absolute http(s) URLs, each ≤ 4096 chars, to try in order. Bilibili: the stream's `baseUrl`, then its `backupUrl`s; Xiaohongshu: the note's video file. Sent exactly as Bilibili or the page gave them, never normalized or stripped of params: they are signed. A Bilibili URL carries the user's IP, account id and device id, so keep it only until the sound is fetched |
| `expires` | when the URLs stop working, in unix seconds: Bilibili's `deadline` param of the first URL; else `null` |
| `audio_error` | the lookup failed: the call (`view`, `playurl`, `xhs`) and what went wrong (`HTTP <status>`, `code <code>`, `not JSON`, `network error`, `no audio`, `no url`, `no video url`) |

## `afferent.shot/1`

From 0.6.9 Afferent no longer sends screenshots (`afferent.shot/1`). The page and forget contracts are unchanged.
Legacy fields, for hiding screenshots sent before 0.6.9: `capture_id` is the visit's, as in its page record; `taken_at` is UTC ISO 8601 with milliseconds, when the capture started.

## `afferent.forget/1` — delete requests

Sent when the user deletes one capture or a range ("last 15 minutes", "last hour", "today", "all") in Afferent, or stops
recording a site ("Don't record this site", since 0.6.6), with the same headers as a page record. A rule has `capture_ids`, a `from`/`to` window, or both:

```
{ "schema": "afferent.forget/1", "capture_ids": ["<capture_id>", ...] }
{ "schema": "afferent.forget/1", "from": "2026-11-11T00:00:00.000Z", "to": "2026-11-11T09:30:00.000Z", "capture_ids": ["<capture_id>", ...] }
```

| field | rule |
|---|---|
| `capture_ids` | a list of strings (may be empty): the visits to hide, by the `capture_id` of their page records |
| `from`, `to` | ISO 8601 (Afferent sends UTC with milliseconds), both or neither, any length; "all" sends `from` `1970-01-01T00:00:00.000Z` |

At least one selector is present. Afferent sends `capture_ids` alone for a deleted row (one id) or a stopped site (every capture from it the
extension still held, often many), and for a deleted window
`from`/`to` plus the ids of every capture it removed locally (an older entry or a visit that never reached the
receiver may not overlap the window by its own times).

- Store the rule and answer `200 {"status":"stored"}`.
- From then on hide every matching capture from every reader, including captures that arrive after the rule (a
  record still queued in the browser, a retry). A capture is hidden if its `capture_id` is listed in a rule, or if
  its `first_seen`–`last_seen` overlaps a rule's `[from, to]` (both ends inclusive). A screenshot (sent before 0.6.9) is hidden if its
  `capture_id` is listed, its capture is hidden (joined by `capture_id`), or its `taken_at` falls in a window.
- v1 hides; it does not erase. A receiver may erase later, but must keep hiding until then.
- Answer 400 only to a rule it cannot read: `capture_ids` not a list of strings, only one of `from`/`to`, an
  unparseable time, no selector at all. A 400 marks the request failed in
  Afferent for good; a receiver that predates this schema answers 400 too, and the user sees that.
- 401/403, 5xx and network errors are handled as for records below: the request stays queued (it survives a
  browser restart) and is sent again.

## Receiving

- Reject (400) only records you cannot store or use: wrong `schema`, missing or wrongly typed fields. A 400 makes the client drop the record for good, so do not reject over details the client already guarantees above.
- Accept any valid JSON string, and ignore unknown fields (forward compatible).
- The same `capture_id` can arrive twice: a response was lost and the client retried. A receiver may answer `duplicate` and skip the second copy, or store both and dedupe by `capture_id` when reading.
- Receivers may reject bodies over 1 MiB with 413.

## Responses

The same for both schemas.

| status | body | client action |
|---|---|---|
| 2xx | `{"status":"stored"}` or `{"status":"duplicate"}` | done, remove from queue |
| 400 | `{"error":"<short reason>"}` | mark this record failed, do not retry |
| 401 / 403 | — | keep the record queued; mark the destination "auth error"; stop retrying until settings change |
| 411 / 413 / 415 | — | mark this record failed, do not retry |
| 408 / 429 / 5xx / anything else / network error / timeout | — | retry with exponential backoff (start 30 s, cap 30 min) |

## Key

A receiver hands the user one key that holds everything Afferent needs:

`nsk_` + base64url(webhook URL) + `.` + token

- base64url is RFC 4648's URL-safe alphabet (`-` and `_`) over the URL's UTF-8 bytes, with no `=` padding.
- The URL is the full webhook URL (for Neurosea, the pages endpoint).
- Everything after the first `.` is the token, so the token may contain dots.
- Afferent recognises pasted text that starts with `nsk_` as a Neurosea key. A part that is not base64url, a URL
  that is not `http`/`https`, or an empty token is refused.

Example: `nsk_aHR0cHM6Ly9tZW1vcnkuZXhhbXBsZS5jb20vYWZmZXJlbnQvdjEvcGFnZXM.YOUR_TOKEN`
(URL `https://memory.example.com/afferent/v1/pages`, token `YOUR_TOKEN`).

<a id="connection-code"></a>Still accepted, the older connection code:
`<webhook URL>#token=<token>[&name=<display name>]`, e.g.
`https://memory.example.com/afferent/v1/pages#token=YOUR_TOKEN&name=Home%20server`.
The part after `#` is a URL fragment, so it is never sent over the network; `name` is URL-encoded and shown to the
user instead of "Neurosea". Afferent recognises it when it starts with `http://` or `https://` and contains `#token=`.

When the user agrees, Afferent stores the URL, token and name in local extension storage, asks Chrome for
permission to reach the URL's origin, and checks the server with the health check below before it saves anything.

## Health check

`GET <webhook URL>` with the same `Authorization` header → `200 {"status":"ok"}` when the token is valid, `401` otherwise.
Afferent no longer reads `accepts` (from 0.6.9); a receiver may still send it.
Afferent uses this when the user connects. A receiver without it answers 404/405; Afferent treats that as reachable and connects anyway.

## CORS

Afferent sends from its service worker after the user grants host permission for the webhook's origin, so receivers need no CORS headers.
