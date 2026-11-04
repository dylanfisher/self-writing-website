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

Using the site: type a suggestion and press Enter. Step through versions with ← → (Home/End jump to the ends),
drag the slider, or click a row in History. A link like `/#v12` opens that version. **Full page** (or F) hides
everything but the built page and a small warning pill; Esc or **Show controls** brings it back. History lists the
newest 250 versions and loads older ones in pages; the slider always covers all of them.

### Other files

| | |
|---|---|
| `lib/model.mjs` | prompt (with memory), streaming call, parsing and applying edits, validation, retries |
| `lib/scripts-last.mjs` | moves every `<script>` to just before `</body>` (in order) on each new page and draft, so scripts never run before the elements they look up exist |
| `lib/lint.mjs` | fast static checks before the browser run: JS syntax, CSS braces, unclosed tags, duplicate ids, missing elements (milliseconds) |
| `lib/check.mjs` | runs a page in headless Chromium (sandbox CSP, no network) and reports JS errors, freezes and element leaks (a page that keeps adding elements, confirmed by fast-forwarding its timers 30 s) |
| `scripts/profile-page.mjs` | `node scripts/profile-page.mjs <url> [seconds]`: fps per frame, long tasks, DOM size and the hottest JS functions, for finding what slows a page down |
| `scripts/check-versions.mjs` | re-checks stored versions and marks broken ones (⚠ in History) |
| `lib/shim.js` | added to every sandbox page: storage stand-in, and in-place patching of live drafts |
| `scripts/test-shim.mjs` / `scripts/test-shim-history.mjs` | tests the patching; replays real version pairs through it |
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
