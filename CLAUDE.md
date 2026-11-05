# Self-rewriting page: notes for Claude

A live, public site: visitors' suggestions are queued and a local model (omlx, `127.0.0.1:8000`) edits the page.
Read `README.md` (how it works), `LAUNCH.md` (running it, restarting) and `PLAN.md` (design, security) first.

## It's live: people are using it

- **Reloading code** (`server.mjs`, `lib/`): `kill -USR2 $(lsof -tiTCP:3000 -sTCP:LISTEN)` (that's `run.mjs`). It
  finishes the suggestion being written, then hands off to a new worker with no downtime; if the new code fails to
  start, the old keeps running (check `data/server.log` for `run: reload done` or `run: reload failed`).
  `run.mjs` itself only changes with a full restart. Never `launchctl kickstart -k` or
  `bootout` for a code change: they fail the suggestion being written and restart the tunnels.
- **`scripts/reset.sh` deletes all history.** It is not a restart. Only when the owner asks for a fresh start.
- `public/` files are read per request, so they need no reload, and open pages reload themselves when they change
  (the `build` id in the state). Save whole files (a half-written `app.js` would be loaded by every open page).
- Don't change omlx settings or swap models while suggestions are running (omlx unloads the model: HTTP 409s).
  Switch the site's model with `scripts/use-model.sh <id>` (no argument lists them), not by editing code.
- Check what's running before anything disruptive:
  `sqlite3 data/site.db "select id,status,text from suggestions where status in ('queued','running')"`

## Data

- `data/site.db` (WAL). Tables: `suggestions` (queued | running | done | rejected | failed | removed), `versions`
  (append-only; never edit or delete), `rules` (active | ended | evicted | removed), `lore` (active | faded | removed), `eras` (one row per era,
  from its first version), `schedules` (active | done | missed | ended | evicted | removed), `favicons` (the model-drawn tab icons; newest is live), `shared` (items pages added with SITE.share,
  per era and channel, each with a `key`: active | gone (a page removed it with SITE.unshare) | evicted (past 300 per
  channel) | cleared (by a suggestion's `CLEAR SHARED: <channel>` line) | removed (by the admin); clear with
  `/api/admin/shared/clear`). `suggestions.kind` is
  `'era'` for the server's weekly era suggestion, `'scheduled'` for a scheduled change that came due and
  `'cleanup'` for a refactor the server queued in a quiet spell (see README). The server reads rules and the
  line per suggestion, so a careful DB edit applies without a restart. Back up first:
  `sqlite3 data/site.db ".backup data/backups/<name>.db"`.
- Don't put a version in by hand while a suggestion is running: it's built from the version before and would
  replace yours. To change the live page, submit a suggestion as admin:
  `curl -s -X POST http://127.0.0.1:3000/api/suggest -H "Content-Type: application/json" -H "Authorization: Bearer $(tr -d '\n' < data/admin-token)" -d '{"text":"…"}'`
- `data/server.log`: one line per suggestion with timings ("first text N s, cached/prompt tokens", output tokens),
  retries and rule changes. `data/attempts/<id>.txt`: the raw replies of failed attempts. Prompts aren't stored;
  rebuild one with `buildMessages` from `lib/model.mjs` and the memory queries in `server.mjs`.
- `data/admin-token`, `data/ip-salt`, `data/secrets.env` are secrets: never print, commit or send them.

## Checks

- `node --check` on what you edited; `node scripts/test-shim.mjs` and `node scripts/test-shim-history.mjs` for
  `lib/shim.js` (live-draft patching).
- Model output is untrusted: it's only ever served from the sandbox origin, and rule text is shown with textContent.
