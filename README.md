# This page rewrites itself

Visitors leave one suggestion each. A local model (Qwen on omlx, `127.0.0.1:8000`) changes the page to follow it by
answering with find/replace edit blocks, which the server applies to the current version (a reply that is a whole
document is accepted as a full rewrite). The prompt also carries memory: the same visitor's last 8 suggestions from the
past 2 hours, so follow-ups read as corrections, and the last 5 changes by others, each with how long ago it was and
what was actually done (the model's status lines for that version). Constants at the top of `server.mjs`. Every version is kept. See `PLAN.md` for the design and security model.

Node ≥ 22.5 (built-in `node:sqlite`). One optional dependency, `playwright-core`, runs each new page in headless
Chromium before it's published (`npm install`; Chromium is found in `~/Library/Caches/ms-playwright`, or set
`CHROMIUM_PATH`). Without it the site still works, but broken JavaScript gets published and copied forward.

## Run it

```sh
node server.mjs
```

It prints three URLs:

- **main** `http://localhost:3000`: the site. Shows history, queue, live progress and the suggestion box.
- **sandbox** `http://127.0.0.1:3001`: serves version pages only, under a strict CSP. You never open it directly.
- **admin** `http://localhost:3000/#admin=<token>`: open once and the browser remembers it. As admin you skip the
  rate limit, can remove queued suggestions and can make an old version the latest again. The token lives in
  `data/admin-token`.

How a suggestion is handled: the model writes the page (streamed live to every visitor), the edits are applied and the page is run in a
headless browser; if an edit doesn't match, the page is too big or it throws a new JavaScript error, the model gets up
to three more attempts (`MAX_ATTEMPTS`, 4 in all) with the problem spelled out. When only some edits miss, the ones
that applied are kept and the model is asked for the missing ones only (much shorter than writing them all again,
and the draft stays on screen). An edit whose replacement equals its FIND changes nothing and is skipped. A page that
is still worse than the current one is skipped and shown under Up next. A suggestion that fails is never re-run, and
neither is one interrupted by a restart (see LAUNCH.md, "Restarting while people are using it").

**The line.** Up to `QUEUED_PER_VISITOR` (3) suggestions per IP waiting or being written (everyone on one network
shares them), `QUEUE_MAX` (100) site-wide. Whoever sent a suggestion (same IP) can cancel it while it waits; the admin
can remove any. Cancelled ones don't count toward the rate limit.

**Live drafts.** While the model writes, each finished edit block is applied to a draft at once, and visitors
following the latest version see the page change step by step, labelled "Draft · n changes so far". Drafts aren't
checked (the checked version replaces the draft when done); they're served like versions, from the sandbox
origin under its CSP, at `/d/<n>`, kept in memory (last 4) and never cached. A retry from scratch drops the draft.
Viewers don't reload for each draft: the server also sends the draft's HTML (and the HTML it follows) over the
event stream, the main page hands both to the sandboxed frame with `postMessage`, and the shim in the frame
(`lib/shim.js`) patches only what changed by comparing the two sources, so CSS, text and markup update in place and
whatever the page's own scripts built or moved stays put. A draft that changes a script is loaded instead. When
the checked version is exactly the draft on screen it isn't loaded again, unless markup changed on a page with
scripts (those could have set the new markup up differently on a real load).

**Prompt cache.** The log shows, per version, how long the first text took and how many prompt tokens the model
server had cached. Only the system prompt is ever reused: for this hybrid model omlx resumes from the end of the
system prompt or from whole 4096-token blocks, and a prompt (system prompt and page) is usually shorter than that.
So pre-reading the next page while idle saves nothing, and isn't done.

**Time limits and loops.** A reply can take as long as it needs while it makes progress: each edit block must
finish within `EDIT_BLOCK_SECONDS` (120) of the previous one, and text must keep arriving (30 s). A reply that
repeats itself (the same text over and over, or the same line with only numbers changing) or grows longer than any
page is stopped at once and retried with looser sampling and a note to use a loop in code instead. `SUGGESTION_SECONDS` (600) caps
a whole suggestion, all attempts included, as a safety net, with a server watchdog 20 s after that.

**Standing rules.** A suggestion that asks for something on every future change ("update the title on every edit")
becomes a rule. The model decides: it starts its reply with `RULE: <the rule in its own words>`, and the rule is
saved only if that version is published. Every later prompt lists the active rules (numbered, before the page), and
the model applies each as its own edit with a "Rule N:" status line. "stop changing the title" makes it answer with
`END RULE: N`, and also removes anything on the page that only carried that rule out (a script it added).
"update the haiku rule so …" makes it answer with `CHANGE RULE N: <the whole new wording>`: the rule is reworded in
place (same position and owner) and the panel shows when it was last updated. At most `RULES_MAX` (5) rules are active site-wide; a new one pushes out the oldest. The Rules panel
lists them, and whoever suggested a rule (same IP) or the admin can remove it. Removing one with the button only stops
it: nothing on the page is undone. Ended rules stay in the `rules` table. Every rule costs an edit on every later
suggestion (a rule that rewrites a long line costs seconds each time), so fewer, short rules keep things fast.

**Lore.** When a suggestion names something or gives the page's world a story ("add a fox called Pip"), the model
starts its reply with `LORE: <the fact>`, saved if that version is published. Every later prompt lists the active
lore after the page, so the page keeps its own canon even after the element itself is gone. It costs no edit, only
~20 prompt tokens each. At most `LORE_MAX` (12); a new one fades out the oldest. Shown under "The page remembers" in
the Rules panel; whoever suggested it (same IP) or the admin can remove it (Forget). The system prompt alone rarely
got lore written, so a one-line reminder follows the suggestion in every prompt (`LORE_NOTE`). Lore is numbered in the prompt, and a
suggestion that asks to forget some writes `FORGET LORE: <n>` (at most two), which removes it once that version is
published. Changes to the page itself (what was added or removed, rules, how scripts work) are not lore.

**Eras.** Every `ERA_DAYS` (7) the server queues a suggestion of its own (`kind = 'era'`, shown as "A new week, a new
era…"; the model gets `ERA_SUGGESTION`): a light tidy-up that keeps the page's character, and a name for the new era
(`ERA: <name>`). Era 1 is the site's start. History marks where each era begins, and every prompt says which era it
is. Checked hourly; a failed era waits for the next interval. To start one now (admin):
`curl -s -X POST http://127.0.0.1:3000/api/admin/era -H "Authorization: Bearer $(tr -d '\n' < data/admin-token)" -H "Content-Type: application/json" -d '{}'`

**Cleanups.** After `CLEANUP_AFTER` (20) visitor suggestions since the last published cleanup, once nothing has
finished for `CLEANUP_IDLE_MINUTES` (10), the server queues a refactor of its own (`kind = 'cleanup'`, shown as
"🧹 Tidying the code: …"). Each one is a single narrow job from `CLEANUPS` in `lib/model.mjs`, taken in turn: unused
CSS, dead script, duplicates, leftovers. It sees no standing rules, memory or schedules, and any RULE/LORE/SCHEDULE
lines it writes are ignored. It's published only if the page got smaller and `compareLooks` (`lib/check.mjs`) finds it
looks exactly the same. That check renders the old and new page at 1200×800 and 390×844 with the clock and
`Math.random` frozen, compares the pixels and the text, and allows only as much difference as the old page has
against itself. A visitor's suggestion stops a cleanup that's being written. To keep the model from staying awake,
the check (every 5 minutes) is only a database query, and it queues a cleanup only if the model is still loaded and
at least one visitor suggestion has finished since the last cleanup was tried. `CLEANUP_AFTER=0` turns cleanups off.
To queue one now (admin):
`curl -s -X POST http://127.0.0.1:3000/api/admin/cleanup -H "Authorization: Bearer $(tr -d '\n' < data/admin-token)" -H "Content-Type: application/json" -d '{}'`

**Scheduled changes.** A suggestion for later ("every morning, make it sunny", "tomorrow at noon add a cake") makes
the model start its reply with `SCHEDULE: daily 07:00 | <what to do>` or `SCHEDULE: 2026-11-05 12:00 | …`, and add
only a small note to the page announcing it. Times are the server's clock (its local time zone); every prompt says
what time it is (`siteNow`), and a reminder follows the suggestion when it mentions a time (`TIME_WORDS`). Saved in
`schedules` if that version is published and the time parses (`lib/schedule.mjs`), is ahead and at most 31 days out;
that reply's RULE and LORE lines are dropped (the model tended to restate the schedule as a rule). Every 30 s the
server queues each due one at the end of the line (`kind = 'scheduled'`, `schedule_id`; the model gets
`scheduledSuggestion`, and its own schedule is left out of the list it sees). A run missed by over 3 h (server down)
is skipped. Era and scheduled suggestions can't schedule anything. Listed numbered in every prompt; "cancel the
lanterns" makes it answer `END SCHEDULE: <n>`. At most `SCHEDULES_MAX` (5) site-wide and `SCHEDULES_PER_VISITOR` (2)
each; a new one pushes out the oldest. Shown under "Scheduled" in the Rules panel, with Remove for whoever suggested
it (same IP) or the admin. Statuses: active | done (a one-off that ran) | missed | ended | evicted | removed.

**`window.SITE`.** Page scripts can read live facts about the site: `SITE.viewers`, `version`, `latest`,
`old` (an older version is being viewed), `draft`, `writing` (`{text, at}` or null), `queue` and `recent`
(`[{text, at}]`), `rules`, `lore`, `era` (`{n, name, at}`), `page` (how the shown version was made:
`{suggestion, summary, secs, tokens, bytes, at}`), `stats` (visitors today/all, peaks, changes today/all, versions,
`born`), `SITE.time()` and `SITE.tz` (the server's clock and timezone), and `SITE.on("change", fn)`.
Who's here: `SITE.me` (`{id, hue, firstSeen, visits, isNew, suggested, mine}`, sent only to that visitor),
`SITE.people` (`[{id, hue, since, on, active, tabs}]`, one per visitor) and `SITE.cursors` (others' pointers on
this page in viewport pixels, `[{id, hue, x, y}]`, with `SITE.on("cursors", fn)`). A visitor's `id` is 8 hex
characters, an HMAC of their IP (/64 for IPv6) with `data/ip-salt`: stable across visits, shared by everyone
behind one IP, and deliberately not `ip_hash`, so pages can't tie a visitor to what they suggested. Visitor
counts and `visits` come from the stats tables (`lib/stats.mjs`), so they only go back as far as those do. The shim defines it with
safe defaults; the shell page sends updates with `postMessage` when the frame loads and when something changes
(version pages are cached forever, so nothing live is baked into them). Read-only: nothing goes back. The page
check sends two made-up updates during its run, so code reacting to them is tested before publishing.

**Other visitors' cursors.** The shim reports where the pointer is (relative to the element under it: its child-index
path from `<body>` and the spot in its box, so it lands on the same content at any screen width) and draws other
visitors' cursors in a closed shadow root that live-draft patching leaves alone. The shell page sends ours over its
live connection with what it's viewing (`v<version>` or `d<suggestion>` for a live draft); the server sends each
page the cursors on the same one, batched every 120 ms, at most 30.
Mouse and pen only; none while polling (quick tunnels). Sandbox URLs carry the shim's hash (`&s=`) because version
pages are cached forever with the shim inlined.

**Shared items (multiplayer).** `SITE.share(channel, data, {keep})` adds something every visitor sees;
`SITE.shared(channel, onAdd, onRemove)` calls `onAdd(item)` for each item already there and then each new one, and
`onRemove(item)` for each one removed (`item: {key, data, by, hue, at, mine}`, plus data's keys: `item.x`).
`SITE.unshare(item)` (or its key) removes one for everyone; anyone may remove any item, and the remover's
`onRemove` runs at once. The shim makes each item's random `key` (10 of `[a-z0-9]`) when it's shared, so the sharer
can remove it right away; keys are unique per era and channel. The shim remembers recently removed keys, so a
removal that arrives before its item (before the channel's list, or while it was being fetched) keeps it away.
The prompt makes visitor-added things ("clicking adds a bubble") shared by default, and pops `SITE.unshare` rather
than timers. No free text for now: `data` holds at most 8 keys of numbers, booleans or short strings without spaces
(ids, colors, emoji), checked in the shim (bad data throws, so the page check catches it) and again on the server
(`lib/shared.mjs`). The shell sends items and removals over its live connection (so polling pages only share with
themselves) and passes in what's there from `GET /api/shared?ch=` and new items and removals (`{ch, removed: key}`)
from `shared` events. Stored in `shared`, per era and channel: a new era starts empty. Rows are kept: a removal
marks the row `gone`. A channel keeps its newest 300 active items (what pages get): adding past that marks the
oldest `evicted` and sends it as a removal. An era holds at most 3000 active items across channels; past that, new
items are refused (409). Limits: 20 items or removals burst, then 4/s per visitor; 20 channels per era;
`keep: false` is sent without storing (and can't be removed). The page check echoes shares back as another
visitor's items and removes them a moment later, and echoes removals, so both callbacks run. Admin:
`POST /api/admin/shared/clear` with `{ch}`, `{visitor}`, both or neither (this era; marks rows `removed`, and pages
using the channel reload).

**Live connection.** Each open page holds one: a WebSocket (`/api/ws`, using `ws`) when it gets through, else an
event stream (`/api/events`), else polling `/api/state` every 3 s. Both connections get the same events. Over a
WebSocket the page also sends its cursor and shared items (`{t: "cursor" | "share" | "unshare", …}`); an
event-stream page posts them to `/api/cursor`, `/api/share` and `/api/unshare` with the token from its `hello`. The upgrade only accepts
`Origin: MAIN_ORIGIN` (no CORS check guards WebSockets), messages are capped at 2 KB and 30 a second (more closes
the socket with 1008), and the server pings every 25 s (Cloudflare drops a socket idle for 100 s). On a reload
or stop, sockets are closed with 1012 and pages reconnect after a random 0.2–2 s.

Using the site: type a suggestion and press Enter. Step through versions with ← → (Home/End jump to the ends),
drag the slider, or click a row in History. A link like `/#v12` opens that version. **Full page** (or F) hides
everything but the built page and a small warning pill; Esc or **Show controls** brings it back. History lists the
newest 250 versions and loads older ones in pages; the slider always covers all of them.

### Other files

| | |
|---|---|
| `lib/model.mjs` | prompt (with memory), streaming call, parsing and applying edits, validation, retries |
| `lib/scripts-last.mjs` | moves every `<script>` to just before `</body>` (in order) on each new page and draft, so scripts never run before the elements they look up exist |
| `lib/schedule.mjs` | parses a SCHEDULE line's time and works out the next run (server's clock, DST included) |
| `lib/lint.mjs` | fast static checks before the browser run: JS syntax, CSS braces, unclosed tags, duplicate ids, missing elements (milliseconds) |
| `lib/check.mjs` | runs a page in headless Chromium (sandbox CSP, no network) and reports JS errors, freezes and element leaks (a page that keeps adding elements, confirmed by fast-forwarding its timers 30 s) |
| `scripts/profile-page.mjs` | `node scripts/profile-page.mjs <url> [seconds]`: fps per frame, long tasks, DOM size and the hottest JS functions, for finding what slows a page down |
| `scripts/check-versions.mjs` | re-checks stored versions and marks broken ones (⚠ in History) |
| `lib/shim.js` | added to every sandbox page: storage stand-in, one shared `AudioContext` per page (resumed on the first click or key), `window.SITE` (read-only: writes throw), in-place patching of live drafts, cursors, shared items |
| `lib/shared.mjs` | checks the data of shared items (`SITE.share`) on the server; the shim checks the same |
| `scripts/test-shim.mjs` / `scripts/test-shim-history.mjs` | tests the patching and cursors; replays real version pairs through it |
| `scripts/bench-model.mjs` | times the model on the latest page (first text, tokens/s), for comparing model-server settings |
| `rewrite.mjs` | the same rewrite from the command line, writing to `versions/` (for tuning the prompt) |
| `scripts/import-cli-versions.mjs` | copies `versions/` into a fresh `data/site.db` so the site has history |
| `data/attempts/` | raw replies of failed attempts, per suggestion id, for debugging the prompt |
| `data/` | `site.db`, `admin-token`, `ip-salt` (all created on first run; keep private) |

Start over: `scripts/reset.sh` (asks first; `-y` skips the question). It stops the server, saves the database to
`data/backups/`, deletes it and starts the server again with just the first page. Admin link, IP salt and secrets
are kept.

## Configuration (environment variables)

| Variable | Default | |
|---|---|---|
| `HOST` | `127.0.0.1` | Interface to listen on. Keep it for Cloudflare Tunnel; `0.0.0.0` for LAN/Tailscale testing. |
| `PORT` / `SANDBOX_PORT` | `3000` / `3001` | |
| `MAIN_ORIGIN` | `http://localhost:3000` | The site's public URL, as browsers see it. |
| `SANDBOX_ORIGIN` | `http://127.0.0.1:3001` | The sandbox's public URL. Must be a different origin; in production a **different registrable domain**. |
| `TRUST_PROXY` | (unset) | `cloudflare` to rate-limit by `CF-Connecting-IP`. Only set it when the server is reachable solely through Cloudflare. |
| `RATE_LIMIT_SECONDS` / `RATE_LIMIT_COUNT` | `600` / `30` | Up to 30 suggestions per visitor per 10 minutes. |
| `QUEUED_PER_VISITOR` | `3` | How many of one visitor's suggestions can be in line (or running) at once. |
| `QUEUE_MAX` | `100` | New suggestions are refused while the line is this long. |
| `RULES_MAX` | `5` | Standing rules active at once, site-wide. |
| `LORE_MAX` | `12` | Lore active at once; a new one fades out the oldest. |
| `ERA_DAYS` | `7` | Days between new eras. |
| `CLEANUP_AFTER` / `CLEANUP_IDLE_MINUTES` | `20` / `10` | Visitor suggestions between cleanups / quiet minutes before one (`0` turns them off). |
| `SCHEDULES_MAX` / `SCHEDULES_PER_VISITOR` | `5` / `2` | Scheduled changes active at once, site-wide / per visitor; a new one pushes out the oldest. |
| `EDIT_BLOCK_SECONDS` | `120` | Longest the model may spend on one edit block. |
| `SUGGESTION_SECONDS` | `600` | Safety cap on a whole suggestion, all attempts included. |
| `ADMIN_TOKEN` | from `data/admin-token` | |
| `TURNSTILE_SITE_KEY` / `TURNSTILE_SECRET` | (unset) | Cloudflare Turnstile on the suggestion box; both needed. `start-remote.sh` reads them from `data/secrets.env`. |

### Testing from another computer

```sh
./start-remote.sh lan        # any device on the home Wi-Fi: http://<lan-ip>:3000
./start-remote.sh tailscale  # only devices running Tailscale: http://<magicdns-name>:3000
```

`lan` puts both origins on the LAN IP on different ports (separate origins; fine for testing, since the iframe is
sandboxed and the site sets no cookies). `.local` names are avoided because many devices can't resolve them.
`tailscale` listens on the Tailscale IP only. The admin link is printed in the server output.

## Going public

Follow `LAUNCH.md`. In short:

```sh
./start-remote.sh tunnel                                     # two Cloudflare quick tunnels, no domain needed
./start-remote.sh tunnel rewrites.example rewrites-sandbox.example   # your own named tunnel
```

Both listen on `127.0.0.1` only and trust `CF-Connecting-IP` for rate limiting. Quick tunnels hold back the
event stream, so the page falls back to polling `/api/state` every 3 s.
