# This page rewrites itself

Visitors leave one suggestion each. A local model (Qwen on omlx, `127.0.0.1:8000`; see "Switching models") changes the page to follow it by
answering with SEARCH/REPLACE edit blocks, which the server applies to the current version (a reply that is a whole
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
and the draft stays on screen). An edit whose replacement equals its SEARCH text changes nothing and is skipped. A page that
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

**Edit format.** Each edit is a status line, then `<<<<<<< SEARCH`, the text to find, `=======`, the replacement and
`>>>>>>> REPLACE` (the form coding models are trained on; the older `<<<<<<< FIND` header is still accepted). The
user message ends with a one-line reminder of the form. The commonest bad reply was a status line and nothing else:
then the model is started again on its own lines plus a `<<<<<<< SEARCH` line, with the same prompt, and it goes on
from there (an attempt, but no rejection note). Compare prompts or models on recent real suggestions with
`node scripts/eval-format.mjs [count]` (format only: no memory, no browser check; only in a quiet spell, since it
competes with live suggestions for the model).

**Switching models.** `scripts/use-model.sh` lists the models in `~/.omlx/models` and which one is in use;
`scripts/use-model.sh <id>` writes `data/model` and reloads (the suggestion being written finishes on the old model;
omlx loads the new one on the next request). `$MODEL` in `data/secrets.env` would win over `data/model`. In use:
`Qwen3.6-35B-A3B-oQ4e-mtp` (22 GB, omlx's oQ4e 4-bit with the model's own multi-token-prediction head kept and
`mtp_enabled` on in omlx; since 2026-11-04). Before it: `Qwen3.6-35B-A3B-MLX-6bit` (27 GB, still in `~/.omlx/models`;
its conversion dropped the MTP weights, and the `Qwen3.6-35B-A3B-DFlash` draft model is set for it with `dflash_enabled` off).
Tried and dropped (2026-11-04, `eval-format.mjs` on 12 recent suggestions): `Qwen3-Coder-Next` 4-bit (45 GB, 80B
total, 3B active) was usable on the first try 7/12 against 12/12, at 22 tok/s against ~70 (about 60 s a suggestion
against 20 s), and needed the GPU memory limit raised above macOS's default 48 GB (`iogpu.wired_limit_mb`) and
omlx's `memory_guard_custom_ceiling_gb` to match.
Also tried 2026-11-04 (`eval-format.mjs 20` for first-try quality, `bench-model.mjs 2` for speed), none worth keeping:
the baseline was 14/20 clean, 71 tok/s writing (and 10–14/20 is noise at 20 replies). DFlash on: 10/20, 61 tok/s
(slower on every reply, worst on short ones, despite ~4.7 tokens accepted per step), and with the custom kernels ~74
tok/s, no real gain. KV cache compression (`affine8`): 12/20, 66 tok/s (prompts are only ~10k tokens). 4-bit
(`Qwen3.6-35B-A3B-oQ4e-mtp`, MTP off): 11/20, 71 tok/s, so no faster: with 3B active parameters decoding isn't
limited by memory bandwidth here. The same 4-bit with MTP on (kept): 16/20, 0 SEARCH parts missed, 90 tok/s
(~5 tokens accepted per step), the only change that helped. Prefill is the same in all of them (~600 tok/s). Thinking is
already off, and the SSD prefix cache already on (`~/.omlx/cache`); omlx sets its 4096-token blocks itself for this
model, and only whole blocks are reused, so a few hundred tokens more of page can mean ~1 s more to first text.
This model's cache resumes only from snapshots (the end of the system prompt, and every 4096 tokens), so a changed
page used to mean reading on from the end of the system prompt (~10 s to first text). Now, once the line is empty
after the page changed, the server has the model read the system prompt and the new page once (`warmCache`, one
token; logged as `cache warmed for vN`), so the next suggestion resumes from the snapshot inside the page: ~4 s. It
only helps when the system prompt and page pass 8192 tokens (a page over ~3,600 tokens), costs ~5–9 s of idle model
time per version, stops for a visitor's suggestion, never wakes the model, and `CACHE_WARM=0` turns it off.
omlx is built with its native kernels (`brew reinstall omlx --with-custom-kernel`, needs Xcode's Metal Toolchain:
`xcodebuild -downloadComponent MetalToolchain`); check with `curl -s localhost:8000/api/status` → `custom_kernels`.
They gave ~2% on the 6-bit model; without them omlx falls back silently.

**Sampling and thinking.** Replies use temperature 0.7 (`MODEL_TEMPERATURE` overrides it; 0.4 scored the same on
30 replayed suggestions). The model never thinks. Tried 2026-11-04 on the 4-bit MTP model: thinking on every reply
made 15 of 20 first replies clean against 16, at 34 s against 12 s; thinking in the fix-up rounds after a reply
broke the page (26 broken replies replayed) fixed 24 against 23, at 76 s against 39 s. (On the old 6-bit model,
thinking on every reply had made 27 of 30 clean against 23, at 45 s against 15 s.) `EVAL_THINK=1` still tries it.

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

**Blank slate.** A visitor's suggestion that asks to erase everything and start over ("BLANK SLATE", "delete
everything, rules too") is done by the server, not the model (`lib/wipe.mjs`). It's caught in two steps: a cheap pattern on the
text (a wipe verb with "everything"/"all the rules…" or a start-over phrase, and nothing like "except" or "but keep"),
then a one-word YES/NO call to the model (~0.3 s) that turns down partial wipes ("remove all elements of color"),
"clear everything and make it red" and questions. On a YES, the first page (`SEED`) becomes a new version (note
`blank slate`). Every active rule, piece of lore and schedule is ended (`ended_by = 'blank slate #<id>'`), scheduled
runs already waiting in the queue are taken out, and this era's shared items are cleared. Later prompts leave out
suggestions from before it as "earlier suggestions". On any doubt or error, the suggestion runs as usual. To undo
one (admin; shared items and the earlier-suggestions memory don't come back):
`curl -s -X POST http://127.0.0.1:3000/api/admin/unwipe -H "Authorization: Bearer $(tr -d '\n' < data/admin-token)" -H "Content-Type: application/json" -d '{"id":<suggestion id>}'`

**Eras.** Every `ERA_DAYS` (7) the server queues a suggestion of its own (`kind = 'era'`, shown as "A new week, a new
era…"; the model gets `ERA_SUGGESTION`): a light tidy-up that keeps the page's character, and a name for the new era
(`ERA: <name>`). Era 1 is the site's start. History marks where each era begins, and every prompt says which era it
is. Checked hourly; a failed era waits for the next interval. To start one now (admin):
`curl -s -X POST http://127.0.0.1:3000/api/admin/era -H "Authorization: Bearer $(tr -d '\n' < data/admin-token)" -H "Content-Type: application/json" -d '{}'`

**Favicon.** An easter egg: once the line has been quiet for `FAVICON_IDLE_MINUTES` (5) after the page changed
(cleanups don't count), the model redraws the site's favicon to match the page. It's a short call of its own
(`lib/favicon.mjs`, ~10 s), not a suggestion: no version, nothing in the line. The model writes a 32×32 SVG, which
is never served; `renderIcon` in `lib/check.mjs` draws it to a 64×64 PNG in the checking browser (scripts off, no
network) and rejects blank or single-color ones. PNGs go in the `favicons` table and are served from the main origin
at `/favicon/<db id>-<id>.png`; the state's `favicon` names the newest, and open pages swap their tab icon. One try
per change, only while the model is loaded, and a visitor's suggestion stops one being drawn. Redraw now:
`curl -s -X POST http://127.0.0.1:3000/api/admin/favicon -H "Authorization: Bearer $(tr -d '\n' < data/admin-token)" -H "Content-Type: application/json" -d '{}'`

**Cleanups.** After `CLEANUP_AFTER` (10) visitor suggestions since the last published cleanup, once nothing has
finished for `CLEANUP_IDLE_MINUTES` (10), or for `CLEANUP_BUSY_IDLE_MINUTES` (3) once twice that many have piled up
(a busy day), the server queues a refactor of its own (`kind = 'cleanup'`, shown as
"🧹 Tidying the code: …"). Each one is a single narrow job from `CLEANUPS` in `lib/model.mjs`, taken in turn: unused
CSS, dead script, duplicates, leftovers. It sees no standing rules, memory or schedules, and any RULE/LORE/SCHEDULE
lines it writes are ignored. It's published only if the page got smaller and `compareLooks` (`lib/check.mjs`) finds it
looks exactly the same. That check renders the old and new page at 1200×800 and 390×844 with the clock and
`Math.random` frozen, compares the pixels and the text, and allows only as much difference as the old page has
against itself. A visitor's suggestion stops a cleanup that's being written. To keep the model from staying awake,
the check (every minute) is only a database query, and it queues a cleanup only if the model is still loaded and
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
items are refused (409). Limits: 20 items or removals burst, then 4/s per visitor (the shim keeps to that too:
past it, items are dropped before they're shown and the page gets one error per channel); 20 channels per era;
`keep: false` is sent without storing (and can't be removed), from its own bucket (16 burst, then 10/s), and the
shim paces them: at most one every 125 ms leaves the page, the newest per channel (the page's own callbacks still
get each at once). The shell also caps what a page sends at 16, then 14/s, below the socket's limit.
**Movement** is shared by default (prompt): motion worked out from `SITE.time()` when it can be; else
`keep: false` positions sent every 200 ms, eased toward on the other screens. For one thing everyone sees,
`SITE.host()` picks the page that runs it: the longest-here visitor on the same version whose pointer moved
lately (else the longest here), or this page when it can't tell. The page check sweeps the pointer over the page
(made-up move events) and fails a page whose move handlers store items (#463 stored one per mousemove). The page check echoes shares back as another
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
| `scripts/eval-format.mjs` | replays recent suggestions on the page each was made on: how many replies are usable edits on the first try (`MODEL=…`, `MODEL_LIB=…` to compare) |
| `scripts/use-model.sh` | lists the omlx models, or switches the site to one (`data/model`) with a reload |
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
| `CLEANUP_AFTER` / `CLEANUP_IDLE_MINUTES` / `CLEANUP_BUSY_IDLE_MINUTES` | `10` / `10` / `3` | Visitor suggestions between cleanups / quiet minutes before one / quiet minutes once twice `CLEANUP_AFTER` have piled up (`0` turns them off). |
| `FAVICON_IDLE_MINUTES` | `5` | Quiet minutes after a change before the favicon is redrawn (`0` turns it off). |
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
