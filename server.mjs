#!/usr/bin/env node
// The site. Two HTTP servers in one process:
//   main origin    (PORT, default 3000): shell page, API, live events. Never serves model output as HTML.
//   sandbox origin (SANDBOX_PORT, default 3001): serves version HTML only, with a strict CSP.
// See README.md for configuration and PLAN.md for the security model.

import http from "node:http";
import { readFileSync, existsSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { makeIdeas } from "./lib/ideas.mjs";
import { rewrite, statusLines, ruleChanges, parseEdits, applyEdits, sensitiveInput, SEED, FEEDBACK_CAP, MODEL, RULE_CAP, SUGGESTION_MS, SIZE_CAP } from "./lib/model.mjs";
import { scriptsLast } from "./lib/scripts-last.mjs";
import { closeChecker } from "./lib/check.mjs";

const ROOT = dirname(fileURLToPath(import.meta.url));
const DATA = join(ROOT, "data");
mkdirSync(DATA, { recursive: true });

// ---------- config ----------
const env = process.env;
const HOST = env.HOST ?? "127.0.0.1";
const PORT = Number(env.PORT ?? 3000);
const SANDBOX_PORT = Number(env.SANDBOX_PORT ?? 3001);
// Public URLs as browsers see them. In production these must be different registrable domains.
const MAIN_ORIGIN = env.MAIN_ORIGIN ?? `http://localhost:${PORT}`;
const SANDBOX_ORIGIN = env.SANDBOX_ORIGIN ?? `http://127.0.0.1:${SANDBOX_PORT}`;
// "cloudflare": trust CF-Connecting-IP (only when the server is reachable solely through Cloudflare).
const TRUST_PROXY = env.TRUST_PROXY ?? "";
const RATE_LIMIT_SECONDS = Number(env.RATE_LIMIT_SECONDS ?? 600); // window for the per-visitor limit below
const RATE_LIMIT_COUNT = Number(env.RATE_LIMIT_COUNT ?? 30);       // suggestions per visitor per window
const QUEUED_PER_VISITOR = Number(env.QUEUED_PER_VISITOR ?? 3);    // a visitor's suggestions waiting or running at once
const QUEUE_MAX = Number(env.QUEUE_MAX ?? 100);
// Optional Cloudflare Turnstile on the suggestion box (both must be set; see LAUNCH.md).
const TURNSTILE_SITE_KEY = env.TURNSTILE_SITE_KEY ?? "";
const TURNSTILE_SECRET = env.TURNSTILE_SECRET ?? "";
const TURNSTILE = Boolean(TURNSTILE_SITE_KEY && TURNSTILE_SECRET);
const HISTORY_PAGE = 250;        // versions sent with the live state; older ones load on demand
const STREAMS_PER_IP = 12;       // open /api/events connections per visitor (tabs, browsers, a household on one IP)
const STREAMS_MAX = 1000;        // and in total
// Memory: the prompt includes the same visitor's recent suggestions (so follow-ups read as corrections) and the
// latest changes by others (so the model knows what was just asked for).
// Each entry costs ~25 prompt tokens (~0.03 s to read), so these are cheap; the risk of more is the model honouring
// stale requests, which the prompt guards against.
const MEMORY_MINE = 8, MEMORY_MINE_MINUTES = 120, MEMORY_OTHERS = 5;
// Standing rules: a suggestion the model reads as "do this on every change" becomes a rule, applied to every later
// change. At most this many are active, site-wide; a new one pushes out the oldest.
const RULES_MAX = Number(env.RULES_MAX ?? 5);

const secretFile = (name) => {
  const p = join(DATA, name);
  if (!existsSync(p)) writeFileSync(p, randomBytes(24).toString("base64url") + "\n", { mode: 0o600 });
  return readFileSync(p, "utf8").trim();
};
const ADMIN_TOKEN = env.ADMIN_TOKEN ?? secretFile("admin-token");
const IP_SALT = secretFile("ip-salt");

if (new URL(MAIN_ORIGIN).origin === new URL(SANDBOX_ORIGIN).origin) {
  console.error("MAIN_ORIGIN and SANDBOX_ORIGIN must differ; the separate origin is the security boundary.");
  process.exit(1);
}

// ---------- storage ----------
const db = new DatabaseSync(join(DATA, "site.db"));
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS versions (
    id INTEGER PRIMARY KEY,
    html TEXT NOT NULL,
    suggestion_id INTEGER,
    note TEXT,                       -- e.g. 'seed', 'restored v5'
    bytes INTEGER NOT NULL,
    secs REAL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS suggestions (
    id INTEGER PRIMARY KEY,
    text TEXT NOT NULL,
    ip_hash TEXT NOT NULL,
    status TEXT NOT NULL,            -- queued | running | done | rejected | failed | removed
    error TEXT,
    version_id INTEGER,
    created_at INTEGER NOT NULL,
    started_at INTEGER,
    finished_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS suggestions_status ON suggestions(status, id);
  CREATE INDEX IF NOT EXISTS suggestions_ip ON suggestions(ip_hash, created_at);
`);
// JavaScript errors the browser check saw in this version (JSON array), shown as a warning in History.
if (!db.prepare("SELECT 1 FROM pragma_table_info('versions') WHERE name = 'errors'").get()) {
  db.exec("ALTER TABLE versions ADD COLUMN errors TEXT");
}
// The model's status lines for this version's edits, joined with " · " ("Making the title wobble · Adding a cloud").
if (!db.prepare("SELECT 1 FROM pragma_table_info('versions') WHERE name = 'summary'").get()) {
  db.exec("ALTER TABLE versions ADD COLUMN summary TEXT");
}
if (!db.prepare("SELECT 1 FROM versions LIMIT 1").get()) {
  db.prepare("INSERT INTO versions (html, note, bytes, created_at) VALUES (?, 'seed', ?, ?)")
    .run(SEED, Buffer.byteLength(SEED), Date.now());
}
// Standing rules. text is the model's wording (what later prompts get); source is the suggestion that made it.
db.exec(`
  CREATE TABLE IF NOT EXISTS rules (
    id INTEGER PRIMARY KEY,
    text TEXT NOT NULL,
    source TEXT NOT NULL,
    suggestion_id INTEGER,
    version_id INTEGER,              -- the version where it was first applied
    ip_hash TEXT NOT NULL,           -- whoever suggested it may remove it
    status TEXT NOT NULL,            -- active | ended | evicted | removed
    created_at INTEGER NOT NULL,
    ended_at INTEGER,
    ended_by TEXT                    -- e.g. 'suggestion #12', 'author', 'admin', 'limit, by #15'
  );
  CREATE INDEX IF NOT EXISTS rules_status ON rules(status, id);
`);
// When a CHANGE RULE last reworded it, and by which suggestion (NULL if never).
if (!db.prepare("SELECT 1 FROM pragma_table_info('rules') WHERE name = 'updated_at'").get()) {
  db.exec("ALTER TABLE rules ADD COLUMN updated_at INTEGER; ALTER TABLE rules ADD COLUMN updated_by TEXT");
}
// A random id for this database, put in version URLs (/v/12?db=…). Version pages are cached forever, and a reset
// starts the numbering over, so without it browsers would keep showing the old database's /v/12.
db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
db.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES ('db_id', ?)").run(randomBytes(6).toString("hex"));
const DB_ID = db.prepare("SELECT value FROM meta WHERE key = 'db_id'").get().value;
// A crash or restart mid-generation leaves a 'running' row. Fail it rather than re-run it: it would go first in
// line again, and a suggestion that keeps the model busy (or brings the server down) would block the line forever.
db.prepare("UPDATE suggestions SET status = 'failed', error = 'interrupted by a server restart', finished_at = ? WHERE status = 'running'")
  .run(Date.now());

const q = {
  latest: db.prepare("SELECT id, html FROM versions ORDER BY id DESC LIMIT 1"),
  versionHtml: db.prepare("SELECT html, errors FROM versions WHERE id = ?"),
  // Newest first, below an id; callers reverse to oldest first.
  history: db.prepare(`
    SELECT v.id, v.note, v.bytes, v.secs, v.created_at, v.errors IS NOT NULL AS broken, v.summary, s.text AS suggestion
    FROM versions v LEFT JOIN suggestions s ON s.id = v.suggestion_id WHERE v.id < ? ORDER BY v.id DESC LIMIT ?`),
  bounds: db.prepare("SELECT MIN(id) AS first, MAX(id) AS last, COUNT(*) AS total FROM versions"),
  queued: db.prepare("SELECT id, text, created_at FROM suggestions WHERE status = 'queued' ORDER BY id"),
  running: db.prepare("SELECT id, text, started_at FROM suggestions WHERE status = 'running' LIMIT 1"),
  recentOutcomes: db.prepare(`
    SELECT id, text, status, error, version_id, finished_at FROM suggestions
    WHERE status IN ('done','rejected','failed') ORDER BY finished_at DESC LIMIT 5`),
  insertSuggestion: db.prepare("INSERT INTO suggestions (text, ip_hash, status, created_at) VALUES (?, ?, 'queued', ?)"),
  // A visitor's most recent suggestions inside the window, newest first.
  recentFromIp: db.prepare("SELECT created_at FROM suggestions WHERE ip_hash = ? AND status != 'removed' AND created_at > ? ORDER BY created_at DESC LIMIT ?"),
  queuedFromIp: db.prepare("SELECT COUNT(*) AS n FROM suggestions WHERE ip_hash = ? AND status IN ('queued','running')"),
  next: db.prepare("SELECT id, text, ip_hash FROM suggestions WHERE status = 'queued' ORDER BY id LIMIT 1"),
  // Newest first; callers reverse to oldest first.
  // With what was actually done: the model's status lines for the version each one became.
  memoryMine: db.prepare(`
    SELECT s.text, s.status, s.error, s.finished_at, s.version_id, v.summary FROM suggestions s LEFT JOIN versions v ON v.id = s.version_id
    WHERE s.ip_hash = ? AND s.id < ? AND s.status IN ('done','rejected','failed') AND s.finished_at > ? ORDER BY s.id DESC LIMIT ?`),
  memoryOthers: db.prepare(`
    SELECT s.text, s.status, s.finished_at, s.version_id, v.summary FROM suggestions s LEFT JOIN versions v ON v.id = s.version_id
    WHERE s.ip_hash != ? AND s.id < ? AND s.status = 'done' ORDER BY s.id DESC LIMIT ?`),
  start: db.prepare("UPDATE suggestions SET status = 'running', started_at = ? WHERE id = ?"),
  finish: db.prepare("UPDATE suggestions SET status = ?, error = ?, version_id = ?, finished_at = ? WHERE id = ?"),
  insertVersion: db.prepare("INSERT INTO versions (html, suggestion_id, note, bytes, secs, created_at, errors, summary) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"),
  remove: db.prepare("UPDATE suggestions SET status = 'removed', finished_at = ? WHERE id = ? AND status = 'queued'"),
  queuedOwner: db.prepare("SELECT ip_hash FROM suggestions WHERE id = ? AND status = 'queued'"),
  // Oldest first: the order they're numbered in the prompt, and the order they're pushed out.
  activeRules: db.prepare("SELECT id, text, source, suggestion_id, version_id, created_at, updated_at, updated_by FROM rules WHERE status = 'active' ORDER BY id"),
  insertRule: db.prepare("INSERT INTO rules (text, source, suggestion_id, version_id, ip_hash, status, created_at) VALUES (?, ?, ?, ?, ?, 'active', ?)"),
  changeRule: db.prepare("UPDATE rules SET text = ?, updated_at = ?, updated_by = ? WHERE id = ? AND status = 'active'"),
  endRule: db.prepare("UPDATE rules SET status = ?, ended_at = ?, ended_by = ? WHERE id = ? AND status = 'active'"),
  ruleOwner: db.prepare("SELECT ip_hash FROM rules WHERE id = ? AND status = 'active'"),
};

// ---------- live state + server-sent events ----------
const clients = new Set();
const streamsByIp = new Map(); // ip hash → open event streams
let progress = null; // { id, chars, expected, tail } while generating
// People here now: visitors (by IP) with an open event stream, plus those polling /api/state in the last 10 s.
const pollers = new Map(); // ip hash → last poll time
function viewers() {
  const cutoff = Date.now() - 10_000;
  for (const [h, t] of pollers) if (t < cutoff) pollers.delete(h);
  return new Set([...streamsByIp.keys(), ...pollers.keys()]).size;
}
let lastViewers = -1;
function broadcastViewers() {
  const n = viewers();
  if (n !== lastViewers) { lastViewers = n; broadcast("viewers", { viewers: n }); }
}

const historyBefore = (before, limit = HISTORY_PAGE) => q.history.all(before, limit).reverse();
function state() {
  const b = q.bounds.get();
  return {
    sandboxOrigin: SANDBOX_ORIGIN,
    dbId: DB_ID,
    current: b.last,
    first: b.first,
    total: b.total,
    history: historyBefore(b.last + 1),   // the latest HISTORY_PAGE versions, oldest first
    turnstileSiteKey: TURNSTILE ? TURNSTILE_SITE_KEY : null,
    running: q.running.get() ?? null,
    queue: q.queued.all(),
    recent: q.recentOutcomes.all(),
    rateLimitSeconds: RATE_LIMIT_SECONDS,
    rateLimitCount: RATE_LIMIT_COUNT,
    feedbackCap: FEEDBACK_CAP,
    rules: q.activeRules.all(),
    rulesMax: RULES_MAX,
    ideas,
    build: build(),
    model: MODEL,
    viewers: viewers(),
    drafted,
  };
}
function send(res, event, data) { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); }
function broadcast(event, data) { for (const c of clients) send(c, event, data); }
const broadcastState = () => broadcast("state", state());
// The site's own code (page, script, styles, and the shim in every sandbox page). Open pages reload when it changes
// (see "build" in app.js). Files are read per request, so an edit to public/ is noticed here without a restart;
// a restart sends it with the first state.
function build() {
  return createHash("sha256").update(["index.html", "app.js", "app.css"].map((n) => staticFile(n).hash).join() + SHIM)
    .digest("hex").slice(0, 12);
}
let lastBuild = null;
setInterval(() => { const b = build(); if (lastBuild && b !== lastBuild) broadcastState(); lastBuild = b; }, 5_000).unref();
// A real event (not a comment), so pages can tell a live connection from one that silently died.
setInterval(() => broadcast("ping", {}), 20_000).unref();
setInterval(broadcastViewers, 5_000).unref();   // pollers time out without a request to notice it

// ---------- untrusted text ----------
// Suggestions come from strangers and error messages from model-written pages. Control characters (ESC, C1 CSI…)
// would let them drive the server's terminal, and bidi overrides would let them disguise text on the shell page.
const BIDI = /[\u202A-\u202E\u2066-\u2069]/g;
const cleanInput = (s) => String(s).replace(/\p{Cc}/gu, " ").replace(BIDI, "").replace(/\s+/g, " ").trim();
// For the terminal: show any control or bidi character as a visible \u escape instead of sending it.
const forLog = (s) => String(s).replace(/[\p{Cc}\u202A-\u202E\u2066-\u2069]/gu, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);

// ---------- live drafts ----------
// While the model writes, each finished edit block is applied to a draft right away, so watchers see the page change
// step by step instead of all at once at the end. Drafts aren't checked (the page shows them labelled as drafts), but
// they're served exactly like versions: from the sandbox origin, under its CSP. Kept in memory, only the last few.
const drafts = new Map();   // seq → html
let draftSeq = 0;
let draftOf = { base: null, blocks: 0 };   // what the current draft was built from, so it's only rebuilt on a new block
let draftVersion = null;   // { id, html }: the latest version when this suggestion started (what a first draft follows)
// text: the reply so far; base: the page that attempt edits. Returns true if there's a new draft.
function updateDraft(text, base) {
  // Only blocks that really ended (with their >>>>>>> line); the one being written has none yet, so it counts as
  // broken. Not repairEdits: on a reply still being written it would close the block in progress early, and the
  // draft would show half a replacement.
  const edits = parseEdits(text).filter((e) => !e.broken);
  if (base === draftOf.base && edits.length === draftOf.blocks) return false;
  draftOf = { base, blocks: edits.length };
  if (!edits.length) return false;
  // One at a time, skipping any that don't apply, so one bad FIND doesn't hide the rest.
  let html = base, applied = 0;
  for (const e of edits) {
    const r = applyEdits(html, [e]);
    if (!r.error) { html = r.html; applied++; }
  }
  html = scriptsLast(html);   // as finished pages are (see lib/scripts-last.mjs), so a draft matches its version
  if (!applied || html === base || Buffer.byteLength(html) > SIZE_CAP || sensitiveInput(html)) return false;
  // Viewers patch their page from the one before (see lib/shim.js), so they get both. Sent as data only: the main
  // origin passes it to the sandboxed frame and never puts it in its own page.
  const prev = progress.draft;
  broadcast("draft", { draft: draftSeq + 1, prev, version: draftVersion.id,
    from: prev ? drafts.get(prev) : draftVersion.html, html });
  drafts.set(++draftSeq, html);
  for (const k of drafts.keys()) if (k <= draftSeq - 4) drafts.delete(k);
  progress.draft = draftSeq;
  progress.draftBlocks = applied;
  return true;
}

// The newest version when it's exactly the last live draft ({ version, draft }): viewers watching that draft keep
// it on screen instead of loading the same page again, so the finished version shows up without a reload.
let drafted = null;

// ---------- worker: one generation at a time ----------
let working = false;
let draining = false;   // a reload is waiting for the suggestion being written: start no new one
async function work() {
  if (working || draining) return;
  working = true;
  try {
    for (let job; !draining && (job = q.next.get()); ) {
      const cur = q.latest.get();
      q.start.run(Date.now(), job.id);
      // Edits are short; ~1.5 KB is typical (the bar caps at 97% if a reply runs longer).
      progress = { id: job.id, stage: "writing", chars: 0, expected: 1500, tail: "", steps: [], rule: null, draft: null, draftBlocks: 0 };
      draftOf = { base: null, blocks: 0 };
      draftVersion = cur;
      const rules = q.activeRules.all();   // as numbered in this prompt; END RULE: n refers to rules[n - 1]
      const context = {
        version: cur.id,
        rules,
        mine: q.memoryMine.all(job.ip_hash, job.id, Date.now() - MEMORY_MINE_MINUTES * 60_000, MEMORY_MINE).reverse(),
        others: q.memoryOthers.all(job.ip_hash, job.id, MEMORY_OTHERS).reverse(),
      };
      broadcastState();
      let lastSent = 0;
      const onText = (text, base) => {
        progress.chars = text.length;
        const newDraft = updateDraft(text, base);
        // A new status line is worth sending right away; plain progress is throttled.
        const steps = statusLines(text);
        const rule = ruleChanges(text).add;
        const newStep = newDraft || steps.length !== progress.steps.length || rule !== progress.rule;
        progress.steps = steps;
        progress.rule = rule;   // shown with textContent only
        const now = Date.now();
        if (newStep) { lastSent = now; progress.tail = text.slice(-2000); return broadcast("progress", progress); }
        if (now - lastSent < 400) return;
        lastSent = now;
        // The tail is shown with textContent on the main origin: displayed as text, never parsed as HTML.
        progress.tail = text.slice(-2000);
        broadcast("progress", progress);
      };
      let r;
      try {
        const onStage = (stage, info) => { if (info) console.log(`#${job.id} ${stage}: ${forLog(info)}`); progress.stage = stage; if (stage !== "testing") { progress.chars = 0; progress.steps = []; }
          // Starting over from the current page: drop the draft. ("fixing" builds on the draft, so it stays.)
          if (stage === "retrying" || stage === "shrinking") { progress.draft = null; progress.draftBlocks = 0; }
          broadcast("progress", progress); };
        // rewrite() keeps to SUGGESTION_MS by itself. The watchdog is a backstop in case something hangs anyway:
        // it aborts the model call and stops waiting, so the line keeps moving.
        const ac = new AbortController();
        let timer;
        const watchdog = new Promise((resolve) => { timer = setTimeout(() => {
          ac.abort();
          resolve({ error: `took longer than ${Math.round(SUGGESTION_MS / 1000) + 20} s`, failed: true });
        }, SUGGESTION_MS + 20_000); });
        r = await Promise.race([rewrite(cur.html, job.text, { onText, onStage, context, signal: ac.signal }), watchdog])
          .finally(() => clearTimeout(timer));
      } catch (err) {
        r = { error: `generation failed: ${err.message}`, failed: true };
      }
      const now = Date.now();
      // Every failed attempt's raw reply, for working out why the model went wrong. Never served.
      if (r.tries?.length) {
        mkdirSync(join(DATA, "attempts"), { recursive: true });
        writeFileSync(join(DATA, "attempts", `${job.id}.txt`), `suggestion: ${job.text}\n` + r.tries.map((t) =>
          `\n===== attempt ${t.attempt}: ${t.error}\n${t.raw}`).join("\n"), { mode: 0o600 });
      }
      if (r.error) {
        q.finish.run(r.failed ? "failed" : "rejected", r.error, null, now, job.id);
        console.log(`#${job.id} ${r.failed ? "failed" : "rejected"}: ${forLog(r.error)}`);
      } else {
        const { lastInsertRowid } = q.insertVersion.run(r.html, job.id,
          [r.partly ? "partly applied" : null, r.edits ? null : "full rewrite", r.attempts > 1 ? `attempt ${r.attempts}` : null].filter(Boolean).join(", ") || null, r.bytes, r.secs, now,
          r.errors?.length ? JSON.stringify(r.errors) : null, r.steps?.length ? r.steps.join(" · ") : null);
        // Partly applied: done, with what went wrong kept in error (shown to whoever suggested it).
        q.finish.run("done", r.partly ? `partly applied: ${String(r.partly).slice(0, 300)}` : null, Number(lastInsertRowid), now, job.id);
        if (r.partly) console.log(`#${job.id} partly applied: ${forLog(r.partly)}`);
        drafted = progress?.draft && drafts.get(progress.draft) === r.html ? { version: Number(lastInsertRowid), draft: progress.draft } : null;
        const ruleNote = applyRuleChanges(r.rules, rules, job, Number(lastInsertRowid), now);
        if (ruleNote) console.log(`#${job.id} rules: ${forLog(ruleNote)}`);
        if (r.skippedRules?.length) console.log(`#${job.id} skipped rule edits: ${forLog(r.skippedRules.join("; "))}`);
        console.log(`#${job.id} → v${lastInsertRowid} ${r.bytes} B ${r.secs.toFixed(0)}s ${r.edits ? `${r.edits} edits` : "full rewrite"}` +
          `${context.mine.length ? ` (+${context.mine.length} earlier)` : ""}${firstNote(r.first)} · ${r.tokens} tokens "${forLog(job.text)}"`);
      }
      progress = null;
      broadcastState();
      refreshIdeas();
    }
  } finally {
    working = false;
    refreshIdeas();
  }
}
// " · first text 1.2 s, 3800/4100 cached" for the log: how long the model read before writing.
const firstNote = (f) => f?.ttft == null ? "" :
  ` · first text ${f.ttft.toFixed(1)} s${f.prompt ? `, ${f.cached ?? "?"}/${f.prompt} cached` : ""}`;

// ---------- placeholder ideas for the suggestion box ----------
// Written by the model after each new version (a short call, ~3 s, alongside the next rewrite; never waited on).
// If versions arrive faster than that, it catches up with the newest one when it's done.
let ideas = [], ideasFor = null, ideasBusy = false;
async function refreshIdeas() {
  const cur = q.latest.get();
  if (ideasBusy || !cur || ideasFor === cur.id) return;
  ideasBusy = true;
  try {
    const last = db.prepare("SELECT s.text FROM versions v JOIN suggestions s ON s.id = v.suggestion_id WHERE v.id = ?").get(cur.id)?.text ?? null;
    const recent = db.prepare("SELECT text FROM suggestions ORDER BY id DESC LIMIT 20").all().map((r) => r.text);
    const fresh = await makeIdeas(cur.html, last, recent);
    ideasFor = cur.id;
    if (fresh.length) { ideas = fresh; broadcastState(); }
  } finally {
    ideasBusy = false;
  }
  if (q.latest.get()?.id !== ideasFor) refreshIdeas();
}

// A finished version's standing-rule changes, all at once: a rule it reworded and rules it ended (by their number
// in its prompt), then a new rule, then the oldest pushed out past RULES_MAX. Returns a note for the log.
function applyRuleChanges(changes, shown, job, versionId, now) {
  if (!changes || (!changes.add && !changes.end?.length && !changes.change)) return "";
  const notes = [];
  db.exec("BEGIN");
  try {
    // Reworded in place: it keeps its place in the list and whoever suggested it can still remove it.
    const ch = changes.change, old = ch && shown[ch.n - 1];
    const newText = old ? cleanInput(ch.text).slice(0, RULE_CAP) : "";
    if (newText && newText !== old.text && q.changeRule.run(newText, now, job.text, old.id).changes) notes.push(`changed "${old.text}" to "${newText}"`);
    for (const n of changes.end) {
      const r = shown[n - 1];
      if (r && q.endRule.run("ended", now, `suggestion #${job.id}`, r.id).changes) notes.push(`ended "${r.text}"`);
    }
    const text = changes.add ? cleanInput(changes.add).slice(0, RULE_CAP) : "";
    const active = q.activeRules.all();
    if (text && !active.some((r) => r.text.toLowerCase() === text.toLowerCase())) {
      q.insertRule.run(text, job.text, job.id, versionId, job.ip_hash, now);
      notes.push(`new "${text}"`);
      for (const old of active.slice(0, Math.max(0, active.length + 1 - RULES_MAX))) {
        q.endRule.run("evicted", now, `limit, by #${job.id}`, old.id);
        notes.push(`pushed out "${old.text}"`);
      }
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    console.log(`#${job.id} rules not saved: ${err.message}`);
    return "";
  }
  return notes.join("; ");
}

// ---------- request helpers ----------
function clientIp(req) {
  if (TRUST_PROXY === "cloudflare" && req.headers["cf-connecting-ip"]) return rateKey(String(req.headers["cf-connecting-ip"]));
  return rateKey(req.socket.remoteAddress ?? "unknown");
}
// IPv6 visitors usually control a whole /64 (2^64 addresses), so they're counted by that prefix; otherwise one
// person could switch address on every request and get around the rate limit.
function rateKey(ip) {
  if (!ip.includes(":")) return ip;                                      // IPv4
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) return mapped[1];                                          // IPv4-mapped IPv6
  const addr = ip.split("%")[0];
  const [head, tail] = addr.split("::");
  const h = head ? head.split(":") : [], t = tail ? tail.split(":") : [];
  const groups = tail === undefined ? h : [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill("0"), ...t];
  const prefix = groups.slice(0, 4).map((g) => parseInt(g, 16));
  if (prefix.length < 4 || prefix.some((n) => !(n >= 0 && n <= 0xffff))) return ip;
  return prefix.map((n) => n.toString(16)).join(":") + "::/64";
}
const ipHash = (ip) => createHash("sha256").update(IP_SALT + ip).digest("hex").slice(0, 32);

// Cloudflare Turnstile: true if the token is valid (or Turnstile isn't configured).
async function turnstileOk(token, ip) {
  if (!TURNSTILE) return true;
  if (typeof token !== "string" || !token || token.length > 4096) return false;
  try {
    const r = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      body: new URLSearchParams({ secret: TURNSTILE_SECRET, response: token, remoteip: ip }),
      signal: AbortSignal.timeout(10_000),
    });
    return (await r.json()).success === true;
  } catch (err) {
    console.log(`turnstile check failed: ${forLog(err.message)}`);
    return false;
  }
}

function isAdmin(req) {
  const m = /^Bearer (.+)$/.exec(req.headers.authorization ?? "");
  if (!m) return false;
  const a = Buffer.from(m[1]), b = Buffer.from(ADMIN_TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
}

function json(res, status, data, extra = {}) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...extra });
  res.end(JSON.stringify(data));
}

async function readJson(req, limit = 2048) {
  // Requiring JSON forces a CORS preflight for cross-site posts, which we never approve.
  if (!/^application\/json\b/.test(req.headers["content-type"] ?? "")) throw new Error("expected application/json");
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > limit) throw new Error("body too large");
  }
  return JSON.parse(body || "{}");
}

const TS_ORIGIN = TURNSTILE ? " https://challenges.cloudflare.com" : "";
const MAIN_CSP = [
  "default-src 'none'", `script-src 'self'${TS_ORIGIN}`, "style-src 'self'", "img-src 'self' data:",
  "connect-src 'self'", `frame-src ${SANDBOX_ORIGIN}${TS_ORIGIN}`, "frame-ancestors 'none'",
  "base-uri 'none'", "form-action 'none'",
].join("; ");

const STATIC = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/app.js": ["app.js", "text/javascript; charset=utf-8"],
  "/app.css": ["app.css", "text/css; charset=utf-8"],
  "/favicon.svg": ["favicon.svg", "image/svg+xml"],
};

// Assets are linked as /app.js?v=<hash of the file>, so every change gets a new URL and Cloudflare and browsers
// can keep each one forever. Files are read per request (cached by mtime), so edits show up without a restart.
const fileCache = new Map(); // name → { mtime, body, hash }
function staticFile(name) {
  const p = join(ROOT, "public", name);
  const mtime = statSync(p).mtimeMs;
  let f = fileCache.get(name);
  if (!f || f.mtime !== mtime) {
    const body = readFileSync(p);
    f = { mtime, body, hash: createHash("sha256").update(body).digest("hex").slice(0, 12) };
    fileCache.set(name, f);
  }
  return f;
}
function indexHtml() {
  return staticFile("index.html").body.toString("utf8")
    .replace(/(href|src)="\/(app\.css|app\.js|favicon\.svg)"/g, (_, attr, name) => `${attr}="/${name}?v=${staticFile(name).hash}"`);
}

// ---------- main origin ----------
const main = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const path = url.pathname;
  try {
    if ((req.method === "GET" || req.method === "HEAD") && STATIC[path]) {
      const [file, type] = STATIC[path];
      // The page itself is never cached; an asset is cached for good only when asked for by its current hash.
      const f = staticFile(file);
      const pinned = path !== "/" && url.searchParams.get("v") === f.hash;
      res.writeHead(200, {
        "Content-Type": type,
        "Content-Security-Policy": MAIN_CSP,
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
        "Cache-Control": pinned ? "public, max-age=31536000, immutable" : "no-store",
      });
      return res.end(path === "/" ? indexHtml() : f.body);
    }

    // Polling fallback for connections that buffer the event stream (e.g. Cloudflare quick tunnels).
    if (req.method === "GET" && path === "/api/state") {
      pollers.set(ipHash(clientIp(req)), Date.now());
      return json(res, 200, { ...state(), progress });
    }

    // Older history, a page at a time: versions with id < before, oldest first.
    if (req.method === "GET" && path === "/api/history") {
      const before = Number(url.searchParams.get("before"));
      if (!Number.isInteger(before) || before < 1) return json(res, 400, { error: "before must be a version id" });
      return json(res, 200, { history: historyBefore(before) });
    }

    if (req.method === "GET" && path === "/api/events") {
      // Each stream is an open connection; cap them so one visitor can't hold thousands.
      const who = ipHash(clientIp(req));
      const mineOpen = streamsByIp.get(who) ?? 0;
      if (mineOpen >= STREAMS_PER_IP || clients.size >= STREAMS_MAX) return json(res, 429, { error: "too many live connections" });
      streamsByIp.set(who, mineOpen + 1);
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      clients.add(res);
      send(res, "state", state());
      if (progress) send(res, "progress", progress);
      broadcastViewers();
      req.on("close", () => {
        clients.delete(res);
        const n = (streamsByIp.get(who) ?? 1) - 1;
        if (n > 0) streamsByIp.set(who, n); else streamsByIp.delete(who);
        broadcastViewers();
      });
      return;
    }

    if (req.method === "POST" && path === "/api/suggest") {
      const admin = isAdmin(req);
      const body = await readJson(req, 8192);   // Turnstile tokens can be ~2 KB
      const text = cleanInput(body.text ?? "");
      if (!text) return json(res, 400, { error: "Write a suggestion first." });
      if (text.length > FEEDBACK_CAP) return json(res, 400, { error: `Keep it under ${FEEDBACK_CAP} characters.` });
      const h = admin ? "admin" : ipHash(clientIp(req));
      if (!admin) {
        if (q.queuedFromIp.get(h).n >= QUEUED_PER_VISITOR) return json(res, 429, { error: QUEUED_PER_VISITOR === 1
          ? "Your last suggestion is still in line or being written. You can add another once it's done."
          : `You already have ${QUEUED_PER_VISITOR} suggestions in line or being written (counting everyone on your network). You can add another once one is done.` });
        // Up to RATE_LIMIT_COUNT per window: once full, wait until the oldest of them leaves the window.
        const recent = q.recentFromIp.all(h, Date.now() - RATE_LIMIT_SECONDS * 1000, RATE_LIMIT_COUNT);
        if (recent.length >= RATE_LIMIT_COUNT) {
          const wait = Math.max(1, Math.ceil((recent.at(-1).created_at + RATE_LIMIT_SECONDS * 1000 - Date.now()) / 1000));
          const mins = Math.round(RATE_LIMIT_SECONDS / 60);
          return json(res, 429, { error: `That's ${RATE_LIMIT_COUNT} suggestions in ${mins} minutes, the most for now.`, retryAfter: wait }, { "Retry-After": String(wait) });
        }
        if (q.queued.all().length >= QUEUE_MAX) return json(res, 503, { error: "The line is full right now. Try again in a bit." });
        if (!(await turnstileOk(body.turnstile, clientIp(req)))) return json(res, 403, { error: "Couldn't verify you're human. Try again." });
      }
      const { lastInsertRowid } = q.insertSuggestion.run(text, h, Date.now());
      broadcastState();
      work();
      return json(res, 202, { id: Number(lastInsertRowid) });
    }

    // Taking a suggestion out of line before it runs: whoever suggested it, or the admin.
    if (req.method === "POST" && path === "/api/suggestions/remove") {
      const body = await readJson(req);
      const id = Number(body.id);
      const row = Number.isInteger(id) && q.queuedOwner.get(id);
      if (!row) return json(res, 404, { error: "That suggestion isn't waiting in line any more." });
      if (!isAdmin(req) && row.ip_hash !== ipHash(clientIp(req))) return json(res, 403, { error: "Only whoever suggested it can cancel it." });
      q.remove.run(Date.now(), id);
      broadcastState();
      return json(res, 200, { ok: true });
    }

    // Removing a standing rule: whoever suggested it, or the admin.
    if (req.method === "POST" && path === "/api/rules/remove") {
      const body = await readJson(req);
      const id = Number(body.id);
      const rule = Number.isInteger(id) && q.ruleOwner.get(id);
      if (!rule) return json(res, 404, { error: "That rule isn't active any more." });
      const admin = isAdmin(req);
      if (!admin && rule.ip_hash !== ipHash(clientIp(req))) return json(res, 403, { error: "Only whoever suggested a rule can remove it." });
      q.endRule.run("removed", Date.now(), admin ? "admin" : "author", id);
      broadcastState();
      return json(res, 200, { ok: true });
    }

    if (req.method === "POST" && path.startsWith("/api/admin/")) {
      if (!isAdmin(req)) return json(res, 403, { error: "forbidden" });
      const body = await readJson(req);
      if (path === "/api/admin/check") return json(res, 200, { ok: true });
      if (path === "/api/admin/restore") {
        // Restoring copies an old version forward, so history stays append-only.
        const id = Number(body.id);
        const v = Number.isInteger(id) && q.versionHtml.get(id);
        if (!v) return json(res, 404, { error: "no such version" });
        const { lastInsertRowid } = q.insertVersion.run(v.html, null, `restored v${id}`, Buffer.byteLength(v.html), null, Date.now(), v.errors, null);
        broadcastState();
        return json(res, 200, { id: Number(lastInsertRowid) });
      }
      if (path === "/api/admin/remove") {
        q.remove.run(Date.now(), Number(body.id));
        broadcastState();
        return json(res, 200, { ok: true });
      }
    }

    json(res, 404, { error: "not found" });
  } catch (err) {
    if (!res.headersSent) json(res, 400, { error: err.message });
  }
});

// ---------- sandbox origin ----------
const SANDBOX_CSP = [
  "default-src 'none'", "script-src 'unsafe-inline'", "style-src 'unsafe-inline'",
  "img-src data:", "font-src data:", "media-src data:", "connect-src 'none'", "form-action 'none'",
  "frame-src 'none'", "base-uri 'none'", `frame-ancestors ${MAIN_ORIGIN}`,
].join("; ");

// Added when serving (not stored): a storage stand-in and live-draft patching. See lib/shim.js.
const SHIM = `<script data-srp>${readFileSync(join(ROOT, "lib", "shim.js"), "utf8")
  .replace("__MAIN_ORIGIN__", () => JSON.stringify(MAIN_ORIGIN))}</script>`;
function withShim(html) {
  const m = /<head\b[^>]*>/i.exec(html) ?? /<html\b[^>]*>/i.exec(html);
  return m ? html.slice(0, m.index + m[0].length) + SHIM + html.slice(m.index + m[0].length) : SHIM + html;
}

const sandbox = http.createServer((req, res) => {
  const path = new URL(req.url, "http://x").pathname;
  const get = req.method === "GET" || req.method === "HEAD";
  // A live draft (see updateDraft): never cached, gone a few drafts later.
  const d = get && /^\/d\/(\d{1,9})$/.exec(path);
  if (d && drafts.has(Number(d[1]))) {
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": SANDBOX_CSP,
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Cross-Origin-Resource-Policy": "cross-origin",
      "Cache-Control": "no-store",
    });
    return res.end(withShim(drafts.get(Number(d[1]))));
  }
  const m = get && /^\/v\/(\d{1,9})$/.exec(path);
  const v = m && q.versionHtml.get(Number(m[1]));
  if (!v) {
    res.writeHead(404, { "Content-Type": "text/plain", "Content-Security-Policy": "default-src 'none'" });
    return res.end("not found");
  }
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Security-Policy": SANDBOX_CSP,
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Cross-Origin-Resource-Policy": "cross-origin",
    // Versions never change, so Cloudflare and browsers can cache them forever.
    "Cache-Control": "public, max-age=31536000, immutable",
  });
  res.end(withShim(v.html));
});

main.listen(PORT, HOST, () => {
  sandbox.listen(SANDBOX_PORT, HOST, () => {
    console.log(`main     ${MAIN_ORIGIN}  (listening ${HOST}:${PORT})`);
    console.log(`sandbox  ${SANDBOX_ORIGIN}  (listening ${HOST}:${SANDBOX_PORT})`);
    console.log(`admin    ${MAIN_ORIGIN}/#admin=${ADMIN_TOKEN}`);
    work();
    refreshIdeas();
  });
});

// A generation in progress when the process stops is marked failed on the next start, never re-run (see the UPDATE
// near the top); a SIGUSR2 reload waits for it instead.
// SIGINT/SIGTERM stop (exit 0). SIGUSR2 exits with 75, which start-remote.sh's loop treats like a crash and
// restarts: a code reload that keeps the tunnels and their URLs.
const stop = (code) => {
  setTimeout(() => process.exit(code), 3000).unref();
  closeChecker().finally(() => process.exit(code));
};
for (const [sig, code] of [["SIGINT", 0], ["SIGTERM", 0]]) {
  process.on(sig, () => { console.log(`${sig}: shutting down`); stop(code); });
}
// A code reload waits for the suggestion being written to finish (it would be failed otherwise; see the UPDATE near
// the top) and starts no new one meanwhile. Suggestions in line stay queued for the new process. A second SIGUSR2,
// or a suggestion that runs past its own time limit, restarts at once.
process.on("SIGUSR2", () => {
  if (draining || !working) { console.log("SIGUSR2: restarting"); return stop(75); }
  draining = true;
  console.log(`SIGUSR2: restarting once #${progress?.id ?? "?"} is done`);
  const until = Date.now() + SUGGESTION_MS + 30_000;
  const t = setInterval(() => {
    if (working && Date.now() < until) return;
    clearInterval(t);
    console.log("SIGUSR2: restarting");
    stop(75);
  }, 500);
});
