# Launch checklist

Work top to bottom. Stage 1 is enough for sharing a link with friends; stage 2 is for posting it publicly.
Security model and reasoning: `PLAN.md`. Day-to-day running: `README.md`.

## 0. Before any public exposure (this machine)

- [ ] **Chromium checker is current.** It runs model-written JavaScript on `mbp2021`, so an old build is the most
      likely way in. Update, then restart the server:
      ```sh
      npm install playwright-core@latest && npx playwright-core install chromium
      ```
      `lib/check.mjs` always uses the build matching the installed `playwright-core`. Redo this monthly.
- [ ] **omlx only on localhost.** `~/.omlx/settings.json` → `"host": "127.0.0.1"`, restart omlx, then
      `lsof -nP -iTCP:8000 -sTCP:LISTEN` shows `127.0.0.1:8000`, not `*:8000`.
- [ ] **Server only reachable through the tunnel.** Stop any `lan`/`tailscale` server first
      (`lsof -nP -iTCP:3000 -sTCP:LISTEN` must show nothing, or only `127.0.0.1:3000`). Then start with
      `./start-remote.sh tunnel …`. It sets `HOST=127.0.0.1` and `TRUST_PROXY=cloudflare`; the two only make sense
      together.
- [ ] **Admin link kept private.** It's in `data/admin-token` (`scripts/admin-url.sh` prints the link; the log only shows it masked). Anyone with it can restore
      versions and skip rate limits. To rotate: stop the server, delete `data/admin-token`, start again.
      `data/server.log` should be `-rw-------` (`chmod 600 data/server.log`).
- [ ] Fresh start if wanted: `scripts/reset.sh` (keeps a backup in `data/backups/`).

## Running it

As a launchd agent (`~/Library/LaunchAgents/com.dylanfisher.self-rewriting-page.plist`): runs in the background,
independent of any terminal, starts at login, and launchd restarts the script if it fails.
```sh
A=gui/$(id -u)/com.dylanfisher.self-rewriting-page
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.dylanfisher.self-rewriting-page.plist   # start
launchctl bootout $A                                     # stop (it starts again at the next login while the plist is there)
launchctl kickstart -k $A                                # full restart (new quick-tunnel URLs)
launchctl print $A | grep -E '^\s+(state|pid) ='           # status
grep -E '^(Public|main)' data/server.log | tail -2       # current URLs
scripts/admin-url.sh                                    # admin link (secret)
```
Don't also start it by hand (`nohup ./start-remote.sh tunnel …`): two copies would fight over the ports.
- **Crash:** `run.mjs` starts the server again (at once, or after 5 s if it died right after starting); the
  tunnels stay up, so the URLs don't change.
- **Reload after editing `server.mjs`/`lib/`:** `kill -USR2 $(lsof -tiTCP:3000 -sTCP:LISTEN)` (that's `run.mjs`,
  which owns the ports). No downtime; see below. (Files in `public/` need no reload.)
- **Stop everything:** `launchctl bootout $A`. To stop it starting at login too, also delete the plist.

### Restarting while people are using it

| | Suggestion being written | Line | URLs | Downtime |
|---|---|---|---|---|
| `kill -USR2 <pid>` (code reload) | finishes first, then the handoff | kept | same | none |
| crash | marked failed ("interrupted by a server restart") | kept | same | ~1 s (~6 s if it crashes at startup) |
| `launchctl kickstart -k $A` / `bootout` | marked failed | kept | quick tunnels get new URLs | longer |
| `scripts/reset.sh` | **not a restart: deletes all history** (backup in `data/backups/`) | | | |

- **Use USR2 for code changes.** `run.mjs` (started by `start-remote.sh`) owns ports 3000/3001 and runs
  `server.mjs` as a cluster worker. On USR2 the worker finishes the suggestion being written (log: `reload: waiting
  for #N to finish`; no new one starts meanwhile, up to `SUGGESTION_SECONDS`), then a new worker starts with the
  new code while the old one keeps serving, and the old one exits once the new one listens (`run: reload done`).
  Open pages' live connections (WebSocket or event stream) reconnect by themselves.
- **A bad deploy doesn't take the site down.** If the new code exits or hangs before it listens, `run.mjs` drops it
  and the old code carries on (`run: reload failed …`, with the error above it). Fix it and send USR2 again.
- A second USR2 while it waits replaces the worker at once, failing the suggestion being written (~1 s gap).
- `node server.mjs` on its own still works: then USR2 exits with code 75 for whatever started it to restart.
- **An interrupted suggestion is never re-run.** It used to go back to the front of the line, so a suggestion that
  kept the model busy (or crashed the server) blocked the line on every restart.
- **During a crash gap** suggestions can't be sent (the box shows an error) and open pages reconnect by themselves.
- **Open pages reload themselves** when the site's own code changes: `public/` files (noticed within 5 s, no
  restart needed) or `lib/shim.js` (on restart). Changes to `server.mjs`/`lib/model.mjs` alone don't reload anyone.
  Someone typing a suggestion isn't interrupted: the reload waits until they leave the box, and their text is kept.
- **Changing omlx settings or the model while serving** makes omlx unload the model; requests then get HTTP 409
  ("busy … unload pending") until it's back. Suggestions wait through it, but do it when the line is empty.
- **Rules and suggestions live in `data/site.db`**, which the server reads per suggestion: an edit there (say,
  rewording a rule) applies without a restart. Back up first: `sqlite3 data/site.db ".backup data/backups/<name>.db"`.

## 1. Quick tunnels: friends only, no domain

```sh
./start-remote.sh tunnel
```

Prints two random `https://….trycloudflare.com` URLs (site and sandbox). They are separate sites because
`trycloudflare.com` is on the Public Suffix List, so the sandbox boundary holds. Share the site URL.

Known limits:
- New URLs on every start. No uptime guarantee; Cloudflare's terms apply.
- Cloudflare holds back the event stream on quick tunnels (tested 2026-11-03: headers arrive, events never do).
  Pages try a WebSocket first; whether quick tunnels pass it is untested.
  The page notices after 4 s and polls `/api/state` every 3 s instead, so live progress updates in steps.
- No Cloudflare rate-limit rules (there's no zone of yours to attach them to). Only the app's own limits apply:
  5 suggestions per visitor per 10 min, 1 in line at a time, 25 in line in total, 4 live connections per visitor.
  IPv6 visitors are counted per /64, so switching addresses within one connection doesn't get around it.
- Turnstile works here too (its widget isn't tied to a zone); see stage 2.

## 2. Named tunnel on your own domains: public

### Domains
- [ ] Two **different registrable domains** in your Cloudflare account, e.g. `rewrites.example` (site) and
      `rewrites-sandbox.example` (sandbox). A subdomain of the site is not enough: it would share cookies and
      count as same-site. (Alternative: a sandbox host on another Public Suffix List domain you control.)

### Tunnel
- [ ] `cloudflared tunnel login`, then `cloudflared tunnel create self-rewriting-page`.
- [ ] Public hostnames: `rewrites.example` → `http://localhost:3000`, `rewrites-sandbox.example` →
      `http://localhost:3001`. Nothing else, and never port 8000.
- [ ] Run the tunnel (`cloudflared tunnel run self-rewriting-page`, or `sudo cloudflared service install` so it starts
      at boot), and the server with:
      ```sh
      ./start-remote.sh tunnel rewrites.example rewrites-sandbox.example
      ```
- [ ] Check that live progress streams (no 3-second steps). Pages use a WebSocket (`/api/ws`; tunnels pass them
      through, and WebSockets are on by default in the zone's Network settings), else `/api/events`. Tested
      2026-11-04 on the named tunnel: the WebSocket connects and reconnects after a reload.

### Rate limiting (site domain → Security → WAF → Rate limiting rules)
The app already limits each visitor to 30 suggestions per 10 min, 3 in line at a time. The Cloudflare rule stops scripts and floods
before they reach `mbp2021`, and per-IP counting there can't be faked.
- [ ] Rule **"suggest flood"**:
      - If: `http.request.method eq "POST" and http.request.uri.path eq "/api/suggest"`
      - Count by: IP
      - Rate: **40 requests per 10 minutes** if your plan allows that period; on the Free plan (short periods only),
        **2 requests per 10 seconds**
      - Action: Block, for the longest duration the plan allows
- [ ] If the plan has a second rule, **"api flood"**: `starts_with(http.request.uri.path, "/api/")`, about
      **60 requests per minute** per IP (or the plan's nearest period), Block. Normal visitors make 1 long-lived
      live connection (one request, then messages over the WebSocket) plus the occasional suggestion, far below
      this. A page on the event-stream fallback posts its cursor up to ~8 times a second instead, which a rule like
      this would block: leave `/api/cursor` and `/api/share` out of it.
- [ ] Test it: send POSTs to `/api/suggest` in a loop from a phone hotspot and check you get blocked by Cloudflare
      (a Cloudflare page or 429), not only by the app's own "… the most for now" / "still in line" messages.

### Other Cloudflare settings
- [ ] Turnstile on the suggestion box (code is ready, off until configured). Cloudflare dashboard → Turnstile →
      Add widget: hostname = the site domain (or the `trycloudflare.com` one for stage 1), mode Managed. Put the
      keys in `data/secrets.env` (`chmod 600`), then restart the script (a USR2 reload is enough):
      ```sh
      TURNSTILE_SITE_KEY=0x4AAAA…
      TURNSTILE_SECRET=0x4AAAA…
      ```
      The admin skips it. Test: a suggestion from a private window should go through; `curl -X POST` to
      `/api/suggest` without a token should get 403 "Couldn't verify you're human".
- [ ] Security → Bots → Bot Fight Mode on (site domain).
- [ ] Sandbox domain cache rule: cache everything for `/v/*` (version pages never change and are sent as
      `immutable`).
- [ ] Don't turn on anything that buffers or rewrites responses on the site domain (e.g. Rocket Loader, Email
      Obfuscation, response-buffering features). They break `/api/events` or the CSP.

### Content
- [ ] Decide on one, cheapest first: share the link only with people you know; add a moderation pass (second short
      model call before publishing); or approval mode (new versions wait for you). See `PLAN.md` Phase 6.
- [ ] Know the cleanup moves: remove a queued suggestion, restore an older version (both in admin mode).
- [ ] Expect convincing fake "system" pages, like v53's "Keeper's Protocol" refusal. Pages with no input fields
      get past the personal-details filter. The banner outside the iframe is the main defense.

## 3. After launch

- [ ] Watch `data/server.log` and the History panel for the first day.
- [ ] Monthly: update Chromium (stage 0), `brew upgrade cloudflared`, then restart.
- [ ] If the GPU is busy all day: tighten `RATE_LIMIT_COUNT` / `RATE_LIMIT_SECONDS` / `QUEUE_MAX` or the Cloudflare rule.
