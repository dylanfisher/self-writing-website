#!/usr/bin/env node
// The site. Two HTTP servers in one process:
//   main origin    (PORT, default 3000): shell page, API, live events. Never serves model output as HTML.
//   sandbox origin (SANDBOX_PORT, default 3001): serves version HTML only, with a strict CSP.
// See README.md for configuration and PLAN.md for the security model.

import http from "node:http";
import cluster from "node:cluster";
import { readFileSync, existsSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { makeIdeas } from "./lib/ideas.mjs";
import { looksLikeWipe, confirmWipe } from "./lib/wipe.mjs";
import { rewrite, modelLoaded, warmCache, statusLines, ruleChanges, parseEdits, applyEdits, sensitiveInput, SEED, FEEDBACK_CAP, MODEL, RULE_CAP, LORE_CAP, ERA_CAP, ERA_TEXT, ERA_SUGGESTION, SCHEDULE_CAP, scheduledSuggestion, SUGGESTION_MS, SIZE_CAP, CLEANUPS, cleanupText, cleanupSuggestion } from "./lib/model.mjs";
import { compareLooks, renderIcon } from "./lib/check.mjs";
import { drawIcon } from "./lib/favicon.mjs";
import { parseWhen, nextRun } from "./lib/schedule.mjs";
import { scriptsLast } from "./lib/scripts-last.mjs";
import { closeChecker } from "./lib/check.mjs";
import { makeStats } from "./lib/stats.mjs";
import { cleanData, CHANNEL, ITEM_KEY } from "./lib/shared.mjs";
import { WebSocketServer } from "ws";

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
// Lore: facts about the page's world the model chose to remember ("LORE: …"), listed in every later prompt. Cheap
// (no edit per change, ~20 tokens each). At most this many; a new one pushes out the oldest.
const LORE_MAX = Number(env.LORE_MAX ?? 12);
// Eras: every ERA_DAYS the server queues a suggestion of its own that tidies the page up and names the new era.
const ERA_MS = Number(env.ERA_DAYS ?? 7) * 86_400_000;
// Cleanups: after CLEANUP_AFTER visitor suggestions since the last cleanup that was published, once the line has been
// quiet for CLEANUP_IDLE_MINUTES (CLEANUP_BUSY_IDLE_MINUTES once overdue), the server queues a refactor of its own (one of CLEANUPS, in turn). Only while the
// model is still loaded (it sleeps after ~30 min idle; a cleanup never wakes it), and only after at least one
// visitor suggestion since the last cleanup tried, so cleanups can't keep the model awake by themselves. Published
// only if the page looks exactly the same (compareLooks) and got smaller. Checked every minute (a database query;
// the model isn't asked). CLEANUP_AFTER=0 turns them off.
const CLEANUP_AFTER = Number(env.CLEANUP_AFTER ?? 10);
const CLEANUP_IDLE_MS = Number(env.CLEANUP_IDLE_MINUTES ?? 10) * 60_000;
// Overdue (twice CLEANUP_AFTER without one, as on a busy day): a short gap in the line is enough.
const CLEANUP_BUSY_IDLE_MS = Number(env.CLEANUP_BUSY_IDLE_MINUTES ?? 3) * 60_000;
// Favicon: once the line has been quiet for FAVICON_IDLE_MINUTES after the page changed, the model redraws the
// site's favicon to match the page (a short call of its own, not a suggestion; see drawFavicon). Once per change
// (cleanups don't count), only while the model is loaded. FAVICON_IDLE_MINUTES=0 turns it off.
const FAVICON_IDLE_MS = Number(env.FAVICON_IDLE_MINUTES ?? 5) * 60_000;
// Scheduled changes: a suggestion the model reads as "do this at 7:00 every day" or "tomorrow at noon" is saved and
// queued by the server when its time comes (checked every 30 s, at the end of the line). Each run costs a whole
// suggestion, so few: at most SCHEDULES_MAX site-wide and SCHEDULES_PER_VISITOR each; a new one pushes out the oldest.
const SCHEDULES_MAX = Number(env.SCHEDULES_MAX ?? 5);
const SCHEDULES_PER_VISITOR = Number(env.SCHEDULES_PER_VISITOR ?? 2);
const SCHEDULE_AHEAD_MS = 31 * 86_400_000;   // a one-off at most this far ahead
const SCHEDULE_LATE_MS = 3 * 3_600_000;      // a run missed by more than this (server down) is skipped

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
  -- For recentOutcomes (every state): reads the newest few instead of sorting every finished suggestion.
  CREATE INDEX IF NOT EXISTS suggestions_finished ON suggestions(finished_at);
`);
// JavaScript errors the browser check saw in this version (JSON array), shown as a warning in History.
if (!db.prepare("SELECT 1 FROM pragma_table_info('versions') WHERE name = 'errors'").get()) {
  db.exec("ALTER TABLE versions ADD COLUMN errors TEXT");
}
// The model's status lines for this version's edits, joined with " · " ("Adding cloud styles · Placing the cloud").
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
// Lore (see LORE_MAX). Like rules: whoever suggested it (same IP) or the admin can remove it.
db.exec(`
  CREATE TABLE IF NOT EXISTS lore (
    id INTEGER PRIMARY KEY,
    text TEXT NOT NULL,
    source TEXT NOT NULL,            -- the suggestion it came from
    suggestion_id INTEGER,
    version_id INTEGER,
    ip_hash TEXT NOT NULL,
    status TEXT NOT NULL,            -- active | faded (pushed out by newer lore) | removed
    created_at INTEGER NOT NULL,
    ended_at INTEGER,
    ended_by TEXT
  );
  CREATE INDEX IF NOT EXISTS lore_status ON lore(status, id);
  -- One row per era; an era starts at version_id. Era 1 is the site's beginning.
  CREATE TABLE IF NOT EXISTS eras (
    id INTEGER PRIMARY KEY,
    name TEXT,
    suggestion_id INTEGER,
    version_id INTEGER NOT NULL,
    started_at INTEGER NOT NULL
  );
`);
// kind: NULL for a visitor's suggestion, 'era' for one the server queued to start a new era, 'scheduled' for a
// scheduled change that came due, 'cleanup' for a refactor the server queued in a quiet spell.
if (!db.prepare("SELECT 1 FROM pragma_table_info('suggestions') WHERE name = 'kind'").get()) {
  db.exec("ALTER TABLE suggestions ADD COLUMN kind TEXT");
}
if (!db.prepare("SELECT 1 FROM eras LIMIT 1").get()) {
  const first = db.prepare("SELECT id, created_at FROM versions ORDER BY id LIMIT 1").get();
  db.prepare("INSERT INTO eras (name, version_id, started_at) VALUES (NULL, ?, ?)").run(first.id, first.created_at);
}
// Scheduled changes (see SCHEDULES_MAX). when_spec: "daily 07:00" or "2026-11-05 08:00" on the server's clock.
db.exec(`
  CREATE TABLE IF NOT EXISTS schedules (
    id INTEGER PRIMARY KEY,
    text TEXT NOT NULL,              -- the model's wording of what to do (what the scheduled suggestion says)
    when_spec TEXT NOT NULL,
    source TEXT NOT NULL,            -- the suggestion it came from
    suggestion_id INTEGER,
    version_id INTEGER,
    ip_hash TEXT NOT NULL,           -- whoever suggested it may remove it
    status TEXT NOT NULL,            -- active | done (a one-off that ran) | missed | ended | evicted | removed
    next_at INTEGER,
    runs INTEGER NOT NULL DEFAULT 0,
    last_run_at INTEGER,
    created_at INTEGER NOT NULL,
    ended_at INTEGER,
    ended_by TEXT
  );
  CREATE INDEX IF NOT EXISTS schedules_status ON schedules(status, id);
`);
// The schedule a 'scheduled' suggestion was queued for.
if (!db.prepare("SELECT 1 FROM pragma_table_info('suggestions') WHERE name = 'schedule_id'").get()) {
  db.exec("ALTER TABLE suggestions ADD COLUMN schedule_id INTEGER");
}
// Shared items (SITE.share, see lib/shared.mjs): what visitors added through the page's scripts, seen by everyone.
// Per era and channel, so a new era starts empty. visitor is the public id (as in SITE.people), deliberately not
// ip_hash. key: the item's id for pages (made by the shim, see ITEM_KEY). status: active | gone (a page removed it
// with SITE.unshare) | evicted (the channel went past SHARED_KEEP) | cleared (a suggestion's CLEAR SHARED line) |
// removed (by the admin). Rows are kept.
db.exec(`
  CREATE TABLE IF NOT EXISTS shared (
    id INTEGER PRIMARY KEY,
    era INTEGER NOT NULL,
    ch TEXT NOT NULL,
    data TEXT NOT NULL,              -- JSON, checked by cleanData
    visitor TEXT NOT NULL,
    version_id INTEGER,              -- the version it was added from (NULL: a live draft)
    status TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS shared_ch ON shared(era, ch, status, id);
`);
if (!db.prepare("SELECT 1 FROM pragma_table_info('shared') WHERE name = 'key'").get()) {
  db.exec("ALTER TABLE shared ADD COLUMN key TEXT");
  // Rows from before keys: give each one, so they can be removed too.
  const all = db.prepare("SELECT id FROM shared").all(), set = db.prepare("UPDATE shared SET key = ? WHERE id = ?");
  db.exec("BEGIN");
  try { for (const r of all) set.run(newItemKey(), r.id); db.exec("COMMIT"); } catch (err) { db.exec("ROLLBACK"); throw err; }
}
// Like the shim's: 10 of [a-z0-9]. Only for rows (and old pages' items) that came without one.
function newItemKey() {
  const A = "abcdefghijklmnopqrstuvwxyz0123456789";
  return [...randomBytes(10)].map((b) => A[b % 36]).join("");
}
// key unique per era and channel; the active items (what pages get, and the caps) from a small partial index.
db.exec(`
  CREATE UNIQUE INDEX IF NOT EXISTS shared_key ON shared(era, ch, key);
  CREATE INDEX IF NOT EXISTS shared_live ON shared(era, ch, id) WHERE status = 'active';
`);
// A random id for this database, put in version URLs (/v/12?db=…). Version pages are cached forever, and a reset
// starts the numbering over, so without it browsers would keep showing the old database's /v/12.
// Favicons the model drew (see drawFavicon): the newest is the site's. svg is the model's (never served); png is
// what renderIcon drew from it, served at /favicon/<db id>-<id>.png.
db.exec(`CREATE TABLE IF NOT EXISTS favicons (
  id INTEGER PRIMARY KEY, version_id INTEGER NOT NULL, svg TEXT NOT NULL, png BLOB NOT NULL, created_at INTEGER NOT NULL)`);
db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
db.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES ('db_id', ?)").run(randomBytes(6).toString("hex"));
const DB_ID = db.prepare("SELECT value FROM meta WHERE key = 'db_id'").get().value;
// A crash or restart mid-generation leaves a 'running' row. Fail it rather than re-run it: it would go first in
// line again, and a suggestion that keeps the model busy (or brings the server down) would block the line forever.
// Model work per suggestion (done or not): output tokens and seconds spent writing.
if (!db.prepare("SELECT 1 FROM pragma_table_info('suggestions') WHERE name = 'tokens'").get()) {
  db.exec("ALTER TABLE suggestions ADD COLUMN tokens INTEGER; ALTER TABLE suggestions ADD COLUMN secs REAL");
}
// Of secs, the time spent writing after the first text (without reading the prompt): the raw generation speed.
if (!db.prepare("SELECT 1 FROM pragma_table_info('suggestions') WHERE name = 'gen_secs'").get()) {
  db.exec("ALTER TABLE suggestions ADD COLUMN gen_secs REAL");
}
const stats = makeStats(db);
db.prepare("UPDATE suggestions SET status = 'failed', error = 'interrupted by a server restart', finished_at = ? WHERE status = 'running'")
  .run(Date.now());

const q = {
  latest: db.prepare("SELECT id, html FROM versions ORDER BY id DESC LIMIT 1"),
  versionHtml: db.prepare("SELECT html, errors FROM versions WHERE id = ?"),
  // Newest first, below an id; callers reverse to oldest first.
  history: db.prepare(`
    SELECT v.id, v.note, v.bytes, v.secs, v.created_at, v.errors IS NOT NULL AS broken, v.summary, s.text AS suggestion, s.tokens
    FROM versions v LEFT JOIN suggestions s ON s.id = v.suggestion_id WHERE v.id < ? ORDER BY v.id DESC LIMIT ?`),
  bounds: db.prepare("SELECT MIN(id) AS first, MAX(id) AS last, COUNT(*) AS total FROM versions"),
  queued: db.prepare("SELECT id, text, created_at, kind FROM suggestions WHERE status = 'queued' ORDER BY id"),
  queuedCount: db.prepare("SELECT COUNT(*) AS n FROM suggestions WHERE status = 'queued'"),
  running: db.prepare("SELECT id, text, started_at, kind FROM suggestions WHERE status = 'running' LIMIT 1"),
  // "+status": keeps SQLite off the status index, which would sort every finished suggestion; this walks
  // suggestions_finished from the newest and stops after 5.
  recentOutcomes: db.prepare(`
    SELECT id, text, status, error, version_id, finished_at FROM suggestions
    WHERE +status IN ('done','rejected','failed') ORDER BY finished_at DESC LIMIT 5`),
  insertSuggestion: db.prepare("INSERT INTO suggestions (text, ip_hash, status, created_at) VALUES (?, ?, 'queued', ?)"),
  // A visitor's most recent suggestions inside the window, newest first.
  recentFromIp: db.prepare("SELECT created_at FROM suggestions WHERE ip_hash = ? AND status != 'removed' AND created_at > ? ORDER BY created_at DESC LIMIT ?"),
  queuedFromIp: db.prepare("SELECT COUNT(*) AS n FROM suggestions WHERE ip_hash = ? AND status IN ('queued','running')"),
  next: db.prepare(`SELECT s.id, s.text, s.ip_hash, s.kind, s.schedule_id, c.when_spec FROM suggestions s LEFT JOIN schedules c ON c.id = s.schedule_id
    WHERE s.status = 'queued' ORDER BY s.id LIMIT 1`),
  activeLore: db.prepare("SELECT id, text, source, suggestion_id, version_id, created_at FROM lore WHERE status = 'active' ORDER BY id"),
  insertLore: db.prepare("INSERT INTO lore (text, source, suggestion_id, version_id, ip_hash, status, created_at) VALUES (?, ?, ?, ?, ?, 'active', ?)"),
  endLore: db.prepare("UPDATE lore SET status = ?, ended_at = ?, ended_by = ? WHERE id = ? AND status = 'active'"),
  loreOwner: db.prepare("SELECT ip_hash FROM lore WHERE id = ? AND status = 'active'"),
  eras: db.prepare("SELECT id, name, version_id, started_at FROM eras ORDER BY id"),
  lastEra: db.prepare("SELECT MAX(id) AS id FROM eras"),
  // Newest first; callers reverse to oldest first.
  sharedItems: db.prepare("SELECT id, key, data, visitor, created_at FROM shared WHERE era = ? AND ch = ? AND status = 'active' ORDER BY id DESC LIMIT ?"),
  sharedOldest: db.prepare("SELECT id, key FROM shared WHERE era = ? AND ch = ? AND status = 'active' ORDER BY id LIMIT ?"),
  sharedCount: db.prepare("SELECT COUNT(*) AS n FROM shared WHERE era = ? AND ch = ? AND status = 'active'"),
  sharedEraCount: db.prepare("SELECT COUNT(*) AS n FROM shared WHERE era = ? AND status = 'active'"),
  sharedHasKey: db.prepare("SELECT 1 FROM shared WHERE era = ? AND ch = ? AND key = ?"),
  sharedGone: db.prepare("UPDATE shared SET status = 'gone' WHERE era = ? AND ch = ? AND key = ? AND status = 'active'"),
  sharedEvict: db.prepare("UPDATE shared SET status = 'evicted' WHERE id = ?"),
  sharedChannels: db.prepare("SELECT DISTINCT ch FROM shared WHERE era = ?"),
  insertShared: db.prepare("INSERT INTO shared (era, ch, key, data, visitor, version_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'active', ?)"),
  sharedActive: db.prepare("SELECT ch, COUNT(*) AS n FROM shared WHERE era = ? AND status = 'active' GROUP BY ch ORDER BY ch"),
  sharedClear: db.prepare("UPDATE shared SET status = 'cleared' WHERE era = ? AND ch = ? AND status = 'active'"),
  clearShared: db.prepare("UPDATE shared SET status = 'removed' WHERE era = ? AND (? IS NULL OR ch = ?) AND (? IS NULL OR visitor = ?) AND status = 'active'"),
  insertEra: db.prepare("INSERT INTO eras (name, suggestion_id, version_id, started_at) VALUES (?, ?, ?, ?)"),
  // The last time a new era was started or tried (a failed attempt waits for the next interval too).
  lastEraTry: db.prepare(`SELECT MAX(t) AS t FROM (SELECT MAX(started_at) AS t FROM eras
    UNION ALL SELECT MAX(created_at) FROM suggestions WHERE kind = 'era')`),
  eraWaiting: db.prepare("SELECT 1 FROM suggestions WHERE kind = 'era' AND status IN ('queued','running') LIMIT 1"),
  insertEraSuggestion: db.prepare("INSERT INTO suggestions (text, ip_hash, status, created_at, kind) VALUES (?, 'era', 'queued', ?, 'era')"),
  latestFavicon: db.prepare("SELECT id, version_id FROM favicons ORDER BY id DESC LIMIT 1"),
  faviconPng: db.prepare("SELECT png FROM favicons WHERE id = ?"),
  insertFavicon: db.prepare("INSERT INTO favicons (version_id, svg, png, created_at) VALUES (?, ?, ?, ?)"),
  // Versions after this one that changed the page (a cleanup's don't).
  changedSince: db.prepare(`SELECT COUNT(*) AS n FROM versions v LEFT JOIN suggestions s ON s.id = v.suggestion_id
    WHERE v.id > ? AND s.kind IS NOT 'cleanup'`),
  insertCleanup: db.prepare("INSERT INTO suggestions (text, ip_hash, status, created_at, kind) VALUES (?, 'cleanup', 'queued', ?, 'cleanup')"),
  // For queueCleanup: cleanups tried so far and when the last was queued, when the last one published was, how many
  // visitor suggestions were published since then and since the last try, and when anything last finished.
  cleanupState: db.prepare(`SELECT
    (SELECT COUNT(*) FROM suggestions WHERE kind = 'cleanup') AS tries,
    (SELECT COALESCE(MAX(created_at), 0) FROM suggestions WHERE kind = 'cleanup') AS lastTry,
    (SELECT COALESCE(MAX(created_at), 0) FROM suggestions WHERE kind = 'cleanup' AND status = 'done') AS lastDone,
    (SELECT MAX(finished_at) FROM suggestions WHERE +status IN ('done','rejected','failed')) AS lastFinished`),
  visitorDoneSince: db.prepare("SELECT COUNT(*) AS n FROM suggestions WHERE kind IS NULL AND +status = 'done' AND finished_at > ?"),
  // Newest first; callers reverse to oldest first.
  // With what was actually done: the model's status lines for the version each one became.
  memoryMine: db.prepare(`
    SELECT s.text, s.status, s.error, s.finished_at, s.version_id, v.summary FROM suggestions s LEFT JOIN versions v ON v.id = s.version_id
    WHERE s.ip_hash = ? AND s.id < ? AND s.id > ? AND s.status IN ('done','rejected','failed') AND s.finished_at > ? ORDER BY s.id DESC LIMIT ?`),
  memoryOthers: db.prepare(`
    SELECT s.text, s.status, s.finished_at, s.version_id, v.summary FROM suggestions s LEFT JOIN versions v ON v.id = s.version_id
    WHERE s.ip_hash != ? AND s.id < ? AND s.id > ? AND s.status = 'done' ORDER BY s.id DESC LIMIT ?`),
  start: db.prepare("UPDATE suggestions SET status = 'running', started_at = ? WHERE id = ?"),
  finish: db.prepare("UPDATE suggestions SET status = ?, error = ?, version_id = ?, finished_at = ? WHERE id = ?"),
  usage: db.prepare("UPDATE suggestions SET tokens = ?, secs = ?, gen_secs = ? WHERE id = ?"),
  // For SITE.me and SITE.stats (see "window.SITE" below).
  myDone: db.prepare("SELECT text, version_id, finished_at FROM suggestions WHERE ip_hash = ? AND status = 'done' ORDER BY created_at DESC LIMIT 5"),
  myCounts: db.prepare("SELECT COUNT(*) AS n, MIN(created_at) AS first FROM suggestions WHERE ip_hash = ? AND status = 'done'"),
  doneSince: db.prepare("SELECT COUNT(*) AS n FROM suggestions WHERE finished_at >= ? AND +status = 'done'"),
  doneAll: db.prepare("SELECT COUNT(*) AS n FROM suggestions WHERE status = 'done'"),
  // Average writing speed over the last 20 suggestions the model wrote anything for (tokens over seconds, so
  // long ones weigh more; seconds include reading the prompt and any retries).
  speed: db.prepare(`SELECT SUM(tokens) AS tokens, SUM(secs) AS secs FROM
    (SELECT tokens, secs FROM suggestions WHERE tokens > 0 AND secs > 0 ORDER BY id DESC LIMIT 20)`),
  // The same, counting only the time after the first text: the model's raw generation speed.
  genSpeed: db.prepare(`SELECT SUM(tokens) AS tokens, SUM(gen_secs) AS secs FROM
    (SELECT tokens, gen_secs FROM suggestions WHERE tokens > 0 AND gen_secs > 0 ORDER BY id DESC LIMIT 20)`),
  born: db.prepare("SELECT created_at FROM versions ORDER BY id LIMIT 1"),
  insertVersion: db.prepare("INSERT INTO versions (html, suggestion_id, note, bytes, secs, created_at, errors, summary) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"),
  remove: db.prepare("UPDATE suggestions SET status = 'removed', finished_at = ? WHERE id = ? AND status = 'queued'"),
  queuedOwner: db.prepare("SELECT ip_hash FROM suggestions WHERE id = ? AND status = 'queued'"),
  // Oldest first: the order they're numbered in the prompt, and the order they're pushed out.
  activeRules: db.prepare("SELECT id, text, source, suggestion_id, version_id, created_at, updated_at, updated_by FROM rules WHERE status = 'active' ORDER BY id"),
  insertRule: db.prepare("INSERT INTO rules (text, source, suggestion_id, version_id, ip_hash, status, created_at) VALUES (?, ?, ?, ?, ?, 'active', ?)"),
  changeRule: db.prepare("UPDATE rules SET text = ?, updated_at = ?, updated_by = ? WHERE id = ? AND status = 'active'"),
  endRule: db.prepare("UPDATE rules SET status = ?, ended_at = ?, ended_by = ? WHERE id = ? AND status = 'active'"),
  ruleOwner: db.prepare("SELECT ip_hash FROM rules WHERE id = ? AND status = 'active'"),
  // Oldest first, as numbered in the prompt (END SCHEDULE: n).
  activeSchedules: db.prepare("SELECT id, text, when_spec, source, suggestion_id, version_id, ip_hash, next_at, runs, last_run_at, created_at FROM schedules WHERE status = 'active' ORDER BY id"),
  insertSchedule: db.prepare("INSERT INTO schedules (text, when_spec, source, suggestion_id, version_id, ip_hash, status, next_at, created_at) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)"),
  endSchedule: db.prepare("UPDATE schedules SET status = ?, ended_at = ?, ended_by = ? WHERE id = ? AND status = 'active'"),
  scheduleOwner: db.prepare("SELECT ip_hash FROM schedules WHERE id = ? AND status = 'active'"),
  dueSchedules: db.prepare("SELECT id, text, when_spec, next_at FROM schedules WHERE status = 'active' AND next_at <= ? ORDER BY next_at"),
  scheduleRan: db.prepare("UPDATE schedules SET next_at = ?, runs = runs + ?, last_run_at = COALESCE(?, last_run_at), status = ?, ended_at = ?, ended_by = ? WHERE id = ?"),
  scheduleWaiting: db.prepare("SELECT 1 FROM suggestions WHERE schedule_id = ? AND status IN ('queued','running') LIMIT 1"),
  insertScheduled: db.prepare("INSERT INTO suggestions (text, ip_hash, status, created_at, kind, schedule_id) VALUES (?, 'schedule', 'queued', ?, 'scheduled', ?)"),
};
// What pages get: no ip_hash. `mine` is worked out in the page from suggestion_id, as for rules.
const schedulesForState = () => q.activeSchedules.all().map(({ ip_hash, ...s }) => s);

// ---------- live state + server-sent events ----------
const clients = new Set();
const streamsByIp = new Map(); // ip hash → open event streams
let progress = null; // { id, chars, expected, tail, end, reply, … } while generating (see onText in work())
// People here now: visitors (by IP) with an open event stream, plus those polling /api/state in the last 10 s.
const pollers = new Map(); // ip hash → { t: last poll time, v: visitor id, since }
function viewers() {
  const cutoff = Date.now() - 10_000;
  for (const [h, p] of pollers) if (p.t < cutoff) pollers.delete(h);
  return new Set([...streamsByIp.keys(), ...pollers.keys()]).size;
}

// ---------- window.SITE: who's here, who you are, counts, server time (sent to pages, see lib/shim.js) ----------
// A visitor's public id: 8 hex characters from their IP (the same /64 for IPv6, see clientIp), keyed with the
// secret salt so it can't be reversed. Deliberately not ip_hash (that's stored on suggestions, rules and lore, and
// would tie a visitor to what they wrote). Stable across visits; a household behind one IP shares it.
const visitorId = (ip) => createHmac("sha256", IP_SALT).update("visitor:" + ip).digest("hex").slice(0, 8);
const hueOf = (id) => parseInt(String(id).slice(0, 6), 16) % 360 || 0;   // as in public/app.js
const PEOPLE_MAX = 50;
// People here now, one per visitor (all their tabs together), longest here first. on: the version they're
// looking at (a live draft counts as latest + 1, as SITE.version does), null if unknown (polling, hidden tab).
function people() {
  viewers();   // drops pollers that went away
  const now = Date.now(), latest = q.bounds.get().last, by = new Map();
  const add = (v, since) => {
    let p = by.get(v);
    if (!p) by.set(v, p = { id: v, hue: hueOf(v), since, on: null, active: false, tabs: 0 });
    p.tabs++;
    p.since = Math.min(p.since, since);
    return p;
  };
  for (const s of streams.values()) {
    const p = add(s.v, s.since);
    const on = s.k ? (s.k[0] === "v" ? Number(s.k.slice(1)) : latest + 1) : null;
    const moving = !!s.cur && now - s.at < CURSOR_IDLE_MS;
    if (on !== null && (p.on === null || moving)) p.on = on;
    if (moving) p.active = true;
  }
  for (const p of pollers.values()) if (!by.has(p.v)) add(p.v, p.since);
  return [...by.values()].sort((a, b) => a.since - b.since).slice(0, PEOPLE_MAX);
}
let peopleSig = "";
setInterval(() => {
  const list = people(), sig = JSON.stringify(list);
  if (sig !== peopleSig) { peopleSig = sig; broadcast("people", { people: list }); }
}, 1_500).unref();
// What one visitor gets about themselves (only ever sent to them). firstSeen: the earlier of their first day in
// the visitor stats (local midnight) and their first change that made it onto the page.
function meOf(h, v) {
  const seen = stats.seen(h), c = q.myCounts.get(h);
  const firstSeen = Math.min(seen.first ?? Infinity, c.first ?? Infinity);
  return {
    id: v, hue: hueOf(v),
    firstSeen: Number.isFinite(firstSeen) ? firstSeen : Date.now(),
    visits: Math.max(1, seen.days), isNew: seen.days <= 1 && !c.n,
    suggested: c.n,
    mine: q.myDone.all(h).map((r) => ({ text: r.text, version: r.version_id, at: r.finished_at })),
  };
}
const meOfReq = (req) => { const ip = clientIp(req); return meOf(ipHash(ip), visitorId(ip)); };
// Counts for SITE.stats. Visitor counts start when the stats tables did. Cached: it's in every state broadcast.
let siteStatsOf = { at: 0, v: null };
function siteStats() {
  if (Date.now() - siteStatsOf.at < 30_000) return siteStatsOf.v;
  const v = stats.summary();
  v.suggestionsToday = q.doneSince.get(new Date().setHours(0, 0, 0, 0)).n;
  v.suggestionsAll = q.doneAll.get().n;
  v.born = q.born.get()?.created_at ?? 0;
  siteStatsOf = { at: Date.now(), v };
  return v;
}
const perSecond = (r) => r?.secs ? Math.round(r.tokens / r.secs * 10) / 10 : null;
const tokensPerSecond = () => perSecond(q.speed.get());
const genTokensPerSecond = () => perSecond(q.genSpeed.get());
const SERVER_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
let lastViewers = -1;
function broadcastViewers() {
  const n = viewers();
  stats.viewers(n);
  if (n !== lastViewers) { lastViewers = n; broadcast("viewers", { viewers: n }); }
}

// Eras numbered from 1, oldest first.
const eras = () => q.eras.all().map((e, i) => ({ n: i + 1, name: e.name, version_id: e.version_id, started_at: e.started_at }));
const historyBefore = (before, limit = HISTORY_PAGE) => q.history.all(before, limit).reverse();
// A page's first state has the latest HISTORY_PAGE versions. Later broadcasts carry only the latest
// BROADCAST_HISTORY (the page merges them into what it has; versions never change once written), so a broadcast is
// ~4 KB instead of ~60 KB. A page that misses more than that reconnects and gets the full state again.
const BROADCAST_HISTORY = 20;
function state(historyLimit = HISTORY_PAGE) {
  const b = q.bounds.get();
  return {
    sandboxOrigin: SANDBOX_ORIGIN,
    dbId: DB_ID,
    current: b.last,
    first: b.first,
    total: b.total,
    history: historyBefore(b.last + 1, historyLimit),   // the latest versions, oldest first
    turnstileSiteKey: TURNSTILE ? TURNSTILE_SITE_KEY : null,
    running: q.running.get() ?? null,
    queue: q.queued.all(),
    recent: q.recentOutcomes.all(),
    rateLimitSeconds: RATE_LIMIT_SECONDS,
    rateLimitCount: RATE_LIMIT_COUNT,
    feedbackCap: FEEDBACK_CAP,
    rules: q.activeRules.all(),
    rulesMax: RULES_MAX,
    lore: q.activeLore.all(),
    loreMax: LORE_MAX,
    eras: eras(),
    schedules: schedulesForState(),
    schedulesMax: SCHEDULES_MAX,
    ideas,
    reactions,
    favicon: faviconUrl(),
    build: build(),
    shim: SHIM_HASH,   // in sandbox URLs: version pages are cached for good, with the shim inlined
    model: MODEL,
    viewers: viewers(),
    people: people(),
    stats: siteStats(),
    tps: tokensPerSecond(),
    genTps: genTokensPerSecond(),
    now: Date.now(),   // the server's clock (SITE.time()), and its timezone
    tz: SERVER_TZ,
    drafted,
  };
}
// A client that never reads would make Node buffer every broadcast (a draft is ~50 KB) forever, so cut it off;
// it reconnects. Closing fires the connection's "close", which does the cleanup.
// A client is an event-stream response, or a { ws } for a WebSocket (see "live connections"). A frame's data is
// serialized once, however many clients it goes to; each kind gets its own short wrapper around it.
const STREAM_BACKLOG_MAX = 2 * 1024 * 1024;
const frame = (event, data) => ({ event, json: JSON.stringify(data) });
function write(res, f) {
  if (res.ws) {
    if (res.ws.bufferedAmount > STREAM_BACKLOG_MAX) return res.ws.terminate();
    if (res.ws.readyState === 1) res.ws.send(`{"event":${JSON.stringify(f.event)},"data":${f.json}}`);
    return;
  }
  if (res.writableLength > STREAM_BACKLOG_MAX) return res.destroy();
  res.write(`event: ${f.event}\ndata: ${f.json}\n\n`);
}
const send = (res, event, data) => write(res, frame(event, data));
// Serialized once, however many pages are open. `legacy`: what a page still running an app.js from before
// incremental progress and drafts gets instead (its stream has no ?delta=1). Such a page reloads to the new
// app.js within seconds (the build changes), so that frame is only built while one is still connected.
function broadcast(event, data, legacy) {
  let f = null, lf = null;
  for (const c of clients) {
    if (legacy && !c.delta) write(c, lf ??= frame(event, legacy));
    else write(c, f ??= frame(event, data));
  }
}
const broadcastState = () => broadcast("state", state(BROADCAST_HISTORY));
// The site's own code (page, script, styles, and the shim in every sandbox page). Open pages reload when it changes
// (see "build" in app.js). Files are read per request, so an edit to public/ is noticed here without a restart;
// a restart sends it with the first state.
// Cached: it's in every state, and hashing the ~15 KB shim each time adds up. Recomputed when a file's hash changes.
let buildOf = { files: null, build: null };
function build() {
  const files = ["index.html", "app.js", "app.css"].map((n) => staticFile(n).hash).join();
  if (files !== buildOf.files) buildOf = { files, build: createHash("sha256").update(files + SHIM).digest("hex").slice(0, 12) };
  return buildOf.build;
}
let lastBuild = null;
setInterval(() => { const b = build(); if (lastBuild && b !== lastBuild) broadcastState(); lastBuild = b; }, 5_000).unref();
// A real event (not a comment), so pages can tell a live connection from one that silently died.
setInterval(() => broadcast("ping", {}), 20_000).unref();
setInterval(broadcastViewers, 5_000).unref();   // pollers time out without a request to notice it

// ---------- cursors: where other visitors' pointers are on the page ----------
// Each event stream gets a public id (shown to others) and a secret token (to post its own cursor). A page posts
// what it's looking at (k: "v<version>" or "d<suggestion id>" for a live draft) and, while the pointer is over the
// page, where (see lib/shim.js). Every CURSOR_MS each page gets the cursors on the same k, its own included (the
// page leaves it out). Only pages with a working stream take part; polling pages (quick tunnels) see none.
const CURSOR_MS = 120;          // broadcast interval, and the fastest a page may post
const CURSOR_IDLE_MS = 15_000;  // a cursor that hasn't moved for this long is hidden
const CURSORS_SHOWN = 30;       // per page, the most recently moved
const streams = new Map();      // token → { id, v, who, since, res, k, cur, at, posted }
const dirtyKeys = new Set();
const CURSOR_KEY = /^[vd]\d{1,9}$/, CURSOR_PATH = /^\d{1,4}(\.\d{1,4}){0,39}$/;
// Cursors over the shell's own controls (header, page bar, scrub bar, sidebar) are the same on every version, so
// they go to every page: { z: zone, fx, fy }, a position in that zone's box (data-cz in public/index.html).
const CURSOR_ZONES = new Set(["top", "bar", "scrub", "side"]);
let chromeDirty = false, chromeShown = 0;
const unit = (n) => Number.isFinite(n) ? Math.round(Math.min(1, Math.max(0, n)) * 1000) / 1000 : 0;
// s: the poster's stream (from its token over HTTP, or its WebSocket).
function postCursor(s, body) {
  if (!s) return false;
  const now = Date.now();
  if (now - s.posted < CURSOR_MS / 2) return true;   // too fast: dropped, not an error
  s.posted = now;
  const k = CURSOR_KEY.test(body.k) ? body.k : null;
  const c = body.c;
  const cur = !c || typeof c !== "object" ? null
    : CURSOR_ZONES.has(c.z) ? { z: c.z, fx: unit(c.fx), fy: unit(c.fy) }
    : k && (c.p === "" || CURSOR_PATH.test(c.p))
      ? { p: c.p, fx: unit(c.fx), fy: unit(c.fy), x: unit(c.x), y: Math.round(Math.min(1e6, Math.max(0, Number(c.y) || 0))) }
      : null;
  if (s.cur?.z || cur?.z) chromeDirty = true;
  // Both pages change: the one left loses this cursor, the one joined gains it (and the joiner needs the list).
  if (s.k) dirtyKeys.add(s.k);
  if (k) dirtyKeys.add(k);
  s.k = k; s.cur = cur;
  if (cur) s.at = now;
  return true;
}
let cursorsShown = new Map();   // k → number of cursors sent last time, so expiring ones are cleared
setInterval(() => {
  const now = Date.now();
  const byKey = new Map();
  for (const s of streams.values()) {
    if (!s.k) continue;
    if (!byKey.has(s.k)) byKey.set(s.k, { list: [], pages: [] });
    const g = byKey.get(s.k);
    g.pages.push(s.res);
    if (s.cur && !s.cur.z && now - s.at < CURSOR_IDLE_MS) g.list.push(s);
  }
  for (const [k, g] of byKey) {
    // Expired cursors change what's shown without a post.
    if (!dirtyKeys.has(k) && g.list.length === (cursorsShown.get(k) ?? 0)) continue;
    const list = g.list.sort((a, b) => b.at - a.at).slice(0, CURSORS_SHOWN).map((s) => ({ id: s.id, v: s.v, ...s.cur }));
    const f = frame("cursors", { k, list });
    for (const res of g.pages) write(res, f);
    cursorsShown.set(k, g.list.length);
  }
  for (const k of cursorsShown.keys()) if (!byKey.has(k)) cursorsShown.delete(k);
  dirtyKeys.clear();
  const chrome = [...streams.values()].filter((s) => s.cur?.z && now - s.at < CURSOR_IDLE_MS);
  if (chromeDirty || chrome.length !== chromeShown) {
    const list = chrome.sort((a, b) => b.at - a.at).slice(0, CURSORS_SHOWN).map((s) => ({ id: s.id, v: s.v, ...s.cur }));
    const f = frame("chrome-cursors", { list });
    for (const s of streams.values()) write(s.res, f);
    chromeShown = chrome.length;
  }
  chromeDirty = false;
}, CURSOR_MS).unref();

// ---------- shared items: SITE.share(channel, data), seen by every visitor (see lib/shared.mjs) ----------
// A page posts one through its shell (with the stream token, so only pages with a working stream can add). Each
// visitor (all their tabs) has a bucket of SHARE_BURST that refills SHARE_PER_SEC a second, for adding and removing;
// past it, they're dropped (the page still showed them to its own viewer). keep: false sends without storing (a
// ping, a sound). Every item has a key (the shim makes it); SITE.unshare(item) removes it for everyone (anyone may),
// marking the row gone. A channel keeps its newest SHARED_KEEP: adding past that evicts the oldest, and an era holds
// at most SHARED_ERA_MAX across channels (then new items are refused, rather than evicting other channels).
// Every page gets every item and removal ("shared" events: { ch, item } or { ch, removed: key }) and its shim keeps
// those for the channels the page uses; a page asks for what's there already with GET /api/shared?ch=. The admin
// can clear a channel ("shared-reset": pages using it reload).
const SHARE_BURST = 20, SHARE_PER_SEC = 4;
// keep: false items have their own bucket, roomier: movement everyone sees (the shim sends at most 8 a second).
const LIVE_BURST = 16, LIVE_PER_SEC = 10;
const SHARED_SENT = 300;        // items a page gets per channel, the newest
const SHARED_KEEP = 300;        // active items kept per channel (the same, so what's kept is what pages get)
const SHARED_ERA_MAX = 3000;    // active items per era, all channels
const SHARED_CHANNELS = 20;     // per era
const shareBuckets = new Map(); // ip hash → { n, at }
let sharedEra = q.lastEra.get().id;
let sharedChannels = new Set(q.sharedChannels.all(sharedEra).map((r) => r.ch));
function newSharedEra() {
  sharedEra = q.lastEra.get().id;
  sharedChannels = new Set();
  broadcast("shared-reset", { all: true });
}
setInterval(() => { const t = Date.now() - 60_000; for (const [h, b] of shareBuckets) if (b.at < t) shareBuckets.delete(h); }, 60_000).unref();
// One from the visitor's bucket (live: the one for keep: false items); false if it's empty.
const takeShareToken = (s, now, live = false) =>
  live ? takeToken(`${s.who}:live`, now, LIVE_BURST, LIVE_PER_SEC) : takeToken(s.who, now, SHARE_BURST, SHARE_PER_SEC);
function takeToken(id, now, burst, perSec) {
  const b = shareBuckets.get(id) ?? { n: burst, at: now };
  b.n = Math.min(burst, b.n + (now - b.at) / 1000 * perSec);
  b.at = now;
  shareBuckets.set(id, b);
  if (b.n < 1) return false;
  b.n -= 1;
  return true;
}
const removedFrame = (ch, key) => frame("shared", { ch, removed: key });
// Returns [status, body].
function postShare(s, body) {
  if (!s) return [410, { error: "no live connection" }];
  const ch = String(body.ch ?? "");
  if (!CHANNEL.test(ch)) return [400, { error: "bad channel" }];
  const c = cleanData(body.data);
  if (c.error) return [400, { error: c.error }];
  // Pages from before keys (an old shim) send none: make one.
  const key = body.key == null ? newItemKey() : String(body.key);
  if (!ITEM_KEY.test(key)) return [400, { error: "bad key" }];
  const now = Date.now();
  const keep = body.keep !== false;
  if (!takeShareToken(s, now, !keep)) return [429, { error: "too fast" }];
  let id = 0;
  const evicted = [];
  if (keep) {
    if (!sharedChannels.has(ch) && sharedChannels.size >= SHARED_CHANNELS) return [409, { error: "too many channels this era" }];
    if (q.sharedHasKey.get(sharedEra, ch, key)) return [409, { error: "duplicate key" }];
    const n = q.sharedCount.get(sharedEra, ch).n;
    // A full channel evicts its own oldest, so only a channel with room adds to the era's total.
    if (n < SHARED_KEEP && q.sharedEraCount.get(sharedEra).n >= SHARED_ERA_MAX) return [409, { error: "too many items this era" }];
    sharedChannels.add(ch);
    const v = /^v(\d{1,9})$/.exec(String(body.k ?? ""));
    db.exec("BEGIN");
    try {
      id = Number(q.insertShared.run(sharedEra, ch, key, JSON.stringify(c.data), s.v, v ? Number(v[1]) : null, now).lastInsertRowid);
      for (const r of q.sharedOldest.all(sharedEra, ch, Math.max(0, n + 1 - SHARED_KEEP))) {
        q.sharedEvict.run(r.id);
        evicted.push(r.key);
      }
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
  // Not back to the page that added it: it showed the item already.
  const f = frame("shared", { ch, item: { id, key, by: s.v, at: now, data: c.data } });
  for (const o of streams.values()) if (o !== s) write(o.res, f);
  // Evictions to everyone, the adder too (its page drops the oldest the same way).
  for (const k of evicted) { const rf = removedFrame(ch, k); for (const o of clients) write(o, rf); }
  return [200, { id, key }];
}
// SITE.unshare: anyone may remove any item. To every page, the remover's too (its shim ignores a key it removed).
function postUnshare(s, body) {
  if (!s) return [410, { error: "no live connection" }];
  const ch = String(body.ch ?? ""), key = String(body.key ?? "");
  if (!CHANNEL.test(ch)) return [400, { error: "bad channel" }];
  if (!ITEM_KEY.test(key)) return [400, { error: "bad key" }];
  if (!takeShareToken(s, Date.now())) return [429, { error: "too fast" }];
  if (!q.sharedGone.run(sharedEra, ch, key).changes) return [404, { error: "no such item" }];
  const f = removedFrame(ch, key);
  for (const o of clients) write(o, f);
  return [200, { removed: key }];
}
const sharedOf = (ch) => q.sharedItems.all(sharedEra, ch, SHARED_SENT).reverse()
  .map((r) => ({ id: r.id, key: r.key, by: r.visitor, at: r.created_at, data: JSON.parse(r.data) }));

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
  // Viewers patch their page from the one before (see lib/shim.js), so they need both. Sent as data only: the main
  // origin passes it to the sandboxed frame and never puts it in its own page. After the first draft, `from` is
  // the previous draft, which pages already got (one that didn't loads the draft's URL instead); only the first
  // carries it (the version's HTML, which pages don't have).
  const prev = progress.draft;
  const msg = { draft: draftSeq + 1, prev, version: draftVersion.id, html };
  const from = prev ? drafts.get(prev) : draftVersion.html;
  broadcast("draft", prev ? msg : { ...msg, from }, { ...msg, from });
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
let interruptible = null;   // the cleanup being written: { id, ac, interrupted }, aborted when a visitor suggests something
let draining = false;   // a reload is waiting for the suggestion being written: start no new one
async function work() {
  if (working || draining) return;
  working = true;
  try {
    for (let job; !draining && (job = q.next.get()); ) {
      const cur = q.latest.get();
      q.start.run(Date.now(), job.id);
      // Edits are short; ~1.5 KB is typical (the bar caps at 97% if a reply runs longer).
      const cleanup = job.kind === "cleanup" ? (CLEANUPS.find((c) => cleanupText(c) === job.text) ?? CLEANUPS[0]) : null;
      progress = { id: job.id, stage: "writing", chars: 0, expected: job.kind === "era" ? 4000 : 1500, tail: "", end: 0, reply: 0, steps: [], rule: null, lore: null, schedule: null, draft: null, draftBlocks: 0 };
      draftOf = { base: null, blocks: 0 };
      draftVersion = cur;
      // "revert" / "undo": the server puts the page before the last change back, instead of the model rebuilding it
      // from memory (#684 took 30 s, #687 failed four times) and leaving that change's rule active (r31).
      const revert = !job.kind && parseRevert(job.text);
      if (revert) {
        revertLast(job, revert);
        progress = null;
        broadcastState();
        refreshIdeas();
        continue;
      }
      // "Delete everything, start over": done at once by the server, not edit by edit (see lib/wipe.mjs).
      if (!job.kind && looksLikeWipe(job.text) && await confirmWipe(job.text)) {
        blankSlate(job);
        progress = null;
        broadcastState();
        refreshIdeas();
        continue;
      }
      const rules = q.activeRules.all();   // as numbered in this prompt; END RULE: n refers to rules[n - 1]
      const lore = q.activeLore.all();     // likewise FORGET LORE: n refers to lore[n - 1]
      const schedules = q.activeSchedules.all();   // and END SCHEDULE: n to schedules[n - 1]
      // A cleanup sees no standing rules ("on every edit" would change the look), schedules, memory or shared
      // channels: only the page, the lore (what it must keep) and the era.
      const context = cleanup ? { version: cur.id, rules: [], lore, schedules: [], era: eras().at(-1), mine: [], others: [], shared: [], cleanup: true } : {
        version: cur.id,
        rules,
        lore,
        // Not a scheduled change's own schedule: listed there, under "don't make them now", the model didn't.
        schedules: job.kind === "scheduled" ? schedules.filter((c) => c.id !== job.schedule_id) : schedules,
        scheduled: job.kind === "scheduled",   // its text is the change itself, not a request to schedule one
        era: eras().at(-1),
        // A scheduled change's "earlier suggestions" would be other schedules' runs, not one visitor's follow-ups.
        mine: job.kind === "scheduled" ? [] : q.memoryMine.all(job.ip_hash, job.id, wipedAfter, Date.now() - MEMORY_MINE_MINUTES * 60_000, MEMORY_MINE).reverse(),
        others: q.memoryOthers.all(job.ip_hash, job.id, wipedAfter, MEMORY_OTHERS).reverse(),
        // What CLEAR SHARED can name. Not for an era: the new era starts with none anyway.
        shared: job.kind === "era" ? [] : q.sharedActive.all(sharedEra).map((r) => ({ ch: r.ch, n: Number(r.n) })),
      };
      // The model server unloads the model when idle; the first suggestion after that waits while it loads.
      if (await modelLoaded() === false) { progress.stage = "waking"; console.log(`#${job.id} waking the model`); }
      broadcastState();
      broadcast("progress", progress);
      // The reply goes to pages as what was added since the last progress (`add`, starting at offset `at`), not
      // the whole tail every 400 ms. A reply that doesn't continue the one sent (a new attempt) goes in full
      // (`tail`, ending at `end`) with a new `reply` number. The stored progress always has the full tail: it's
      // what new streams, /api/state and the boot state get.
      let lastSent = 0, sentText = "", latest = "";
      const sendProgress = (text) => {
        const fresh = !text.startsWith(sentText);
        // The tail is shown with textContent on the main origin: displayed as text, never parsed as HTML.
        progress.tail = text.slice(-2000);
        progress.end = text.length;
        if (fresh) progress.reply++;
        const at = sentText.length;
        sentText = text;
        if (fresh) return broadcast("progress", progress);
        broadcast("progress", { ...progress, tail: undefined, at, add: text.slice(at) }, progress);
      };
      const onText = (text, base) => {
        if (progress.stage === "waking") progress.stage = "writing";
        progress.chars = text.length;
        latest = text;
        const newDraft = updateDraft(text, base);
        // A new status line is worth sending right away; plain progress is throttled.
        const steps = statusLines(text);
        const meta = ruleChanges(text);
        // Only a visitor's suggestion can schedule something (see applyScheduleChanges), and then its RULE and LORE
        // lines are dropped (see below), so they aren't shown either.
        const schedule = !job.kind && meta.schedule ? `${meta.schedule.when} · ${meta.schedule.text}` : null;
        const rule = schedule ? null : meta.add, lore = schedule ? null : meta.lore;
        const newStep = newDraft || steps.length !== progress.steps.length || rule !== progress.rule || lore !== progress.lore || schedule !== progress.schedule;
        progress.steps = steps;
        progress.rule = rule;   // shown with textContent only
        progress.lore = lore;
        progress.schedule = schedule;
        const now = Date.now();
        if (!newStep && now - lastSent < 400) return;
        lastSent = now;
        sendProgress(text);
      };
      let r;
      try {
        const onStage = (stage, info) => { if (info) console.log(`#${job.id} ${stage}: ${forLog(info)}`);
          if (latest !== sentText) sendProgress(latest);   // the end of the reply, which the throttle may have held back
          progress.stage = stage; if (stage !== "testing") { progress.chars = 0; progress.steps = []; }
          // Starting over from the current page: drop the draft. ("fixing" builds on the draft, so it stays.)
          if (stage === "retrying" || stage === "shrinking") { progress.draft = null; progress.draftBlocks = 0; }
          // The text is unchanged: no tail (pages keep theirs).
          broadcast("progress", { ...progress, tail: undefined }, progress); };
        // rewrite() keeps to SUGGESTION_MS by itself. The watchdog is a backstop in case something hangs anyway:
        // it aborts the model call and stops waiting, so the line keeps moving.
        const ac = new AbortController();
        if (cleanup) interruptible = { id: job.id, ac, interrupted: false };
        let timer;
        const watchdog = new Promise((resolve) => { timer = setTimeout(() => {
          ac.abort();
          resolve({ error: `took longer than ${Math.round(SUGGESTION_MS / 1000) + 20} s`, failed: true });
        }, SUGGESTION_MS + 20_000); });
        r = await Promise.race([rewrite(cur.html, job.kind === "era" ? ERA_SUGGESTION : cleanup ? cleanupSuggestion(cleanup)
          : job.kind === "scheduled" ? scheduledSuggestion(job.text, job.when_spec ?? "") : job.text, { onText, onStage, context, signal: ac.signal }), watchdog])
          .finally(() => clearTimeout(timer));
        if (cleanup) r = await checkCleanup(r, cur, job, onStage);
      } catch (err) {
        r = { error: `generation failed: ${err.message}`, failed: true };
      } finally {
        interruptible = null;
      }
      const now = Date.now();
      q.usage.run(r.tokens ?? null, r.secs ?? null, r.genSecs ?? null, job.id);
      // The raw reply of every attempt when there was more than one (failed ones, then the accepted one), for working
      // out why the model went wrong. Never served.
      if (r.tries?.length) {
        mkdirSync(join(DATA, "attempts"), { recursive: true, mode: 0o700 });
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
        // A visitor's scheduled change is only that: the model tends to also restate it as a new rule ("every
        // morning…") or as lore, and the rule would make the change on every edit from now on.
        if (!job.kind && r.rules?.schedule && parseWhen(r.rules.schedule.when)) r.rules = { ...r.rules, add: null, lore: null };
        // A cleanup changes nothing but the code.
        if (cleanup) r.rules = null;
        // "rule: …" from a visitor and no rule line in the reply (#680, #682): the visitor's words are the rule.
        const asked = !job.kind && RULE_ASK.exec(job.text);
        if (asked && !r.rules?.add && !r.rules?.change && !r.rules?.end?.length && !r.rules?.schedule) {
          const text = asked[1].split(/\s+/).slice(0, 20).join(" ");
          if (text) r.rules = { ...(r.rules ?? { end: [], forget: [], unschedule: [], clear: [] }), add: text };
        }
        const ruleNote = applyRuleChanges(r.rules, rules, job, Number(lastInsertRowid), now);
        if (ruleNote) console.log(`#${job.id} rules: ${forLog(ruleNote)}`);
        // An era's own LORE line only restates the era, which every prompt already gives.
        const loreNote = job.kind === "era" ? "" : addLore(r.rules, lore, job, Number(lastInsertRowid), now);
        if (loreNote) console.log(`#${job.id} lore: ${forLog(loreNote)}`);
        // Only a visitor's suggestion: an era or a scheduled change that scheduled more would keep itself going.
        const scheduleNote = job.kind ? "" : applyScheduleChanges(r.rules, schedules, job, Number(lastInsertRowid), now);
        if (scheduleNote) console.log(`#${job.id} schedules: ${forLog(scheduleNote)}`);
        const clearNote = job.kind === "era" ? "" : clearSharedChannels(r.rules, job);
        if (clearNote) console.log(`#${job.id} shared: ${forLog(clearNote)}`);
        if (job.kind === "era") {
          const name = r.rules?.era ? cleanInput(r.rules.era).slice(0, ERA_CAP) : null;
          q.insertEra.run(name, job.id, Number(lastInsertRowid), now);
          newSharedEra();
          console.log(`#${job.id} new era ${eras().length}: ${forLog(name ?? "(no name)")}`);
        }
        if (job.ip_hash && job.ip_hash !== "admin" && job.ip_hash !== "schedule" && job.ip_hash !== "cleanup") {
          let me = null;
          for (const st of streams.values()) if (st.who === job.ip_hash) send(st.res, "me", me ??= meOf(st.who, st.v));
        }
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
    warmUp().catch((err) => console.log(`cache warm-up failed: ${err.message}`));
  }
}
// " · first text 1.2 s, 3800/4100 cached" for the log: how long the model read before writing.
const firstNote = (f) => f?.ttft == null ? "" :
  ` · first text ${f.ttft.toFixed(1)} s${f.prompt ? `, ${f.cached ?? "?"}/${f.prompt} cached` : ""}`;

// ---------- placeholder ideas for the suggestion box, and the reactions for the react button ----------
// Written by the model after each new version (a short call, ~5 s, alongside the next rewrite; never waited on).
// If versions arrive faster than that, it catches up with the newest one when it's done. See "reactions" for those.
let ideas = [], ideasFor = null, ideasBusy = false;
async function refreshIdeas() {
  const cur = q.latest.get();
  if (ideasBusy || !cur || ideasFor === cur.id) return;
  ideasBusy = true;
  try {
    const last = db.prepare("SELECT s.text FROM versions v JOIN suggestions s ON s.id = v.suggestion_id WHERE v.id = ?").get(cur.id)?.text ?? null;
    const recent = db.prepare("SELECT text FROM suggestions ORDER BY id DESC LIMIT 20").all().map((r) => r.text);
    const sent = [...reactSent].sort((a, b) => b[1] - a[1]);
    const fresh = await makeIdeas(cur.html, last, recent, { viewers: viewers(), reactions: reactions.list.slice(1), sent });
    ideasFor = cur.id;
    let changed = false;
    if (fresh.ideas.length) { ideas = fresh.ideas; changed = true; }
    if (fresh.reactions.length >= REACTIONS_MIN) { newReactions(fresh.reactions); changed = true; }
    if (changed) broadcastState();
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

// A finished version's lore: pieces it forgot (by their number in its prompt), then its new lore line, if any, saved
// unless it's already known, with the oldest fading past LORE_MAX. Returns a note for the log.
function addLore(changes, shown, job, versionId, now) {
  const forget = changes?.forget ?? [];
  const text = changes?.lore ? cleanInput(changes.lore).slice(0, LORE_CAP) : "";
  if (!text && !forget.length) return "";
  const notes = [];
  db.exec("BEGIN");
  try {
    for (const n of forget) {
      const l = shown[n - 1];
      if (l && q.endLore.run("removed", now, `suggestion #${job.id}`, l.id).changes) notes.push(`forgot "${l.text}"`);
    }
    const active = q.activeLore.all();
    if (text && !active.some((l) => l.text.toLowerCase() === text.toLowerCase())) {
      q.insertLore.run(text, job.text, job.id, versionId, job.ip_hash, now);
      notes.push(`new "${text}"`);
      for (const old of active.slice(0, Math.max(0, active.length + 1 - LORE_MAX))) {
        q.endLore.run("faded", now, `limit, by #${job.id}`, old.id);
        notes.push(`faded "${old.text}"`);
      }
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    console.log(`#${job.id} lore not saved: ${err.message}`);
    return "";
  }
  return notes.join("; ");
}

// ---------- blank slate ----------
// A suggestion that asked for everything to be erased (lib/wipe.mjs): the first page comes back as a new version,
// and every active rule, piece of lore, schedule and shared item (this era) is ended, all marked "blank slate #id"
// so the admin can bring them back (/api/admin/unwipe). Scheduled changes already in line are taken out. Prompts
// after it don't list suggestions from before it as earlier suggestions (wipedAfter).
let wipedAfter = db.prepare("SELECT COALESCE(MAX(suggestion_id), 0) AS id FROM versions WHERE note = 'blank slate'").get().id;
function blankSlate(job) {
  const t0 = Date.now(), by = `blank slate #${job.id}`;
  let versionId, counts;
  db.exec("BEGIN");
  try {
    versionId = Number(q.insertVersion.run(SEED, job.id, "blank slate", Buffer.byteLength(SEED), 0, t0, null, "Starting over from a blank slate").lastInsertRowid);
    counts = {
      rules: q.activeRules.all().filter((r) => q.endRule.run("ended", t0, by, r.id).changes).length,
      lore: q.activeLore.all().filter((l) => q.endLore.run("removed", t0, by, l.id).changes).length,
      schedules: q.activeSchedules.all().filter((c) => q.endSchedule.run("ended", t0, by, c.id).changes).length,
      queued: Number(db.prepare("UPDATE suggestions SET status = 'removed', finished_at = ? WHERE status = 'queued' AND kind = 'scheduled'").run(t0).changes),
      shared: Number(db.prepare("UPDATE shared SET status = 'cleared' WHERE era = ? AND status = 'active'").run(sharedEra).changes),
    };
    q.usage.run(0, (Date.now() - t0) / 1000, null, job.id);
    q.finish.run("done", null, versionId, Date.now(), job.id);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    q.finish.run("failed", `blank slate failed: ${err.message}`, null, Date.now(), job.id);
    console.log(`#${job.id} blank slate failed: ${err.message}`);
    return;
  }
  wipedAfter = job.id;
  drafted = null;
  sharedChannels = new Set();
  broadcast("shared-reset", { all: true });
  if (job.ip_hash && job.ip_hash !== "admin") {
    let me = null;
    for (const st of streams.values()) if (st.who === job.ip_hash) send(st.res, "me", me ??= meOf(st.who, st.v));
  }
  console.log(`#${job.id} → v${versionId} blank slate: ended ${counts.rules} rules, ${counts.lore} lore, ${counts.schedules} schedules ` +
    `(${counts.queued} queued runs), cleared ${counts.shared} shared "${forLog(job.text)}"`);
}

// A suggestion sent mid-thought (Enter sends): "make all" twice in 6 s (#669, #670), and the model made up a change
// for each, one undoing the visitor's own gradient. Ends on a word no request ends on, or is two words at most ending
// on one that needs more after it ("make all", "add some"; "remove them all" is fine). Not prepositions: "choose a
// record to listen to" (#536) is a whole request.
const DANGLING = /\b(the|a|an|and|or|but|than|my|your|their|very)\s*$/i;
const DANGLING_SHORT = /^\s*\S+\s+(all|more|some|every|each|many|less)\s*$|^\s*(make|add|change|put|turn|give|let)\s*$/i;
const unfinished = (text) => !parseRevert(text) && (DANGLING.test(text) || DANGLING_SHORT.test(text));

// A suggestion that says outright it's a standing rule: "rule: …", "new rule - …". [1]: the rule itself.
const RULE_ASK = /^\s*(?:new\s+|standing\s+|add\s+(?:a\s+)?(?:new\s+)?)?rule\s*[:\-–—]\s*(\S.*)$/is;

// ---------- revert ----------
// A suggestion that is only a revert, done by the server instead of the model rebuilding the old page from memory:
// "revert" / "undo (that, the last change…)" undoes the latest version, "undo the last 3 edits" that many, and
// "revert to v580" / "go back to v12" brings that version back. The old page comes back as a new version (history
// stays append-only), noted "revert v<the earliest one undone>", so a revert right after another goes one further
// back ("undo, undo"). Rules, lore and schedules the undone versions' suggestions made are ended, and rules and lore
// they ended (or a blank slate one was) come back. A CHANGE RULE's old wording isn't kept, so that stays.
// Returns null (not a revert) | { steps } | { to: version id }.
const NUMBER_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
const REVERT_VERB = String.raw`(?:please\s+)?(?:revert|undo|go\s+back|put\s+it\s+back|roll\s*back|restore)`;
const REVERT_TAIL = String.raw`(?:\s+please)?[\s.!]*$`;
const REVERT_ONE = new RegExp(String.raw`^\s*${REVERT_VERB}(?:\s+(?:it|that|this|(?:this|that|the)\s+(?:change|edit)|(?:the\s+)?(?:last|latest|previous)\s+(?:change|edit|one|version)|(?:the\s+)?changes?|one\s+(?:step|change|version)))?${REVERT_TAIL}`, "i");
const REVERT_N = new RegExp(String.raw`^\s*${REVERT_VERB}\s+(?:the\s+)?(?:last\s+)?(\d+|${Object.keys(NUMBER_WORDS).join("|")})\s+(?:changes|edits|versions|steps)${REVERT_TAIL}`, "i");
const REVERT_TO = new RegExp(String.raw`^\s*${REVERT_VERB}\s+(?:back\s+)?(?:to\s+)?(?:version\s*|v\s*)(\d+)${REVERT_TAIL}`, "i");
function parseRevert(text) {
  if (REVERT_ONE.test(text)) return { steps: 1 };
  let m = REVERT_N.exec(text);
  if (m) { const n = NUMBER_WORDS[m[1].toLowerCase()] ?? Number(m[1]); return n >= 1 && n <= 20 ? { steps: n } : null; }
  // Not "undo v80": that means taking away what v80 did, which isn't bringing v80 back.
  m = REVERT_TO.exec(text);
  return m && !/^\s*(?:please\s+)?undo\b(?![\s\S]*\bto\b)/i.test(text) ? { to: Number(m[1]) } : null;
}
const prevVersion = db.prepare("SELECT id, html, errors, note, suggestion_id FROM versions WHERE id < ? ORDER BY id DESC LIMIT 1");
const versionRow = db.prepare("SELECT id, html, errors, note, suggestion_id FROM versions WHERE id = ?");
function revertLast(job, how) {
  const t0 = Date.now();
  const latest = versionRow.get(q.latest.get().id);
  // target: the version that comes back; undone: the versions it takes away (their suggestions' rules and lore go).
  let target = null, undone = [];
  if (how.to) {
    target = how.to < latest.id ? versionRow.get(how.to) : null;
    if (target) undone = db.prepare("SELECT id, note, suggestion_id FROM versions WHERE id > ? ORDER BY id").all(target.id);
  } else {
    let pos = latest;
    for (let i = 0; i < how.steps && pos; i++) {
      for (let m; pos && (m = /^revert v(\d+)$/.exec(pos.note ?? "")); ) pos = prevVersion.get(Number(m[1]));
      if (!pos) break;
      undone.unshift(pos);
      pos = prevVersion.get(pos.id);
    }
    target = undone.length === how.steps ? pos : null;
  }
  if (!target || !undone.length) {
    const why = how.to ? (how.to >= latest.id ? `v${how.to} is the latest version or newer` : `there's no v${how.to}`)
      : "there aren't that many earlier versions to go back to";
    q.usage.run(0, 0, null, job.id);
    q.finish.run("rejected", why, null, Date.now(), job.id);
    console.log(`#${job.id} revert: ${why}`);
    return;
  }
  const by = `revert #${job.id}`, notes = [];
  let versionId;
  db.exec("BEGIN");
  try {
    const first = undone[0], span = undone.length > 1 ? `v${first.id}–v${undone.at(-1).id}` : `v${first.id}`;
    versionId = Number(q.insertVersion.run(target.html, job.id, `revert v${first.id}`, Buffer.byteLength(target.html), 0, t0,
      target.errors, `Undoing ${span}: back to v${target.id}`).lastInsertRowid);
    for (const sid of new Set(undone.map((v) => v.suggestion_id).filter(Boolean))) {
      for (const t of ["rules", "lore", "schedules"]) {
        const n = Number(db.prepare(`UPDATE ${t} SET status = 'ended', ended_at = ?, ended_by = ? WHERE suggestion_id = ? AND status = 'active'`).run(t0, by, sid).changes);
        if (n) notes.push(`ended ${n} ${t}`);
      }
      for (const t of ["rules", "lore"]) {
        const n = Number(db.prepare(`UPDATE ${t} SET status = 'active', ended_at = NULL, ended_by = NULL WHERE ended_by IN (?, ?)`)
          .run(`suggestion #${sid}`, `blank slate #${sid}`).changes);
        if (n) notes.push(`brought back ${n} ${t}`);
      }
    }
    q.usage.run(0, (Date.now() - t0) / 1000, null, job.id);
    q.finish.run("done", null, versionId, Date.now(), job.id);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    q.finish.run("failed", `revert failed: ${err.message}`, null, Date.now(), job.id);
    console.log(`#${job.id} revert failed: ${err.message}`);
    return;
  }
  drafted = null;
  if (job.ip_hash && job.ip_hash !== "admin") {
    let me = null;
    for (const st of streams.values()) if (st.who === job.ip_hash) send(st.res, "me", me ??= meOf(st.who, st.v));
  }
  console.log(`#${job.id} → v${versionId} revert of ${undone.length} (back to v${target.id})${notes.length ? `: ${notes.join(", ")}` : ""} "${forLog(job.text)}"`);
}

// A finished version's CLEAR SHARED lines: every active item in those channels (this era's only) marked cleared,
// and pages using them reload. Only shared items: anyone may already remove any one of them with SITE.unshare.
function clearSharedChannels(changes, job) {
  const notes = [];
  for (const ch of changes?.clear ?? []) {
    if (!sharedChannels.has(ch)) continue;
    const n = Number(q.sharedClear.run(sharedEra, ch).changes);
    if (!n) continue;
    notes.push(`cleared ${n} in ${ch}`);
    broadcast("shared-reset", { ch });
  }
  return notes.join("; ");
}

// A finished version's scheduled changes: ones it cancelled (by their number in its prompt), then its new one, if
// the time is valid and ahead, with the oldest pushed out past SCHEDULES_PER_VISITOR (theirs) and SCHEDULES_MAX
// (anyone's). Returns a note for the log.
function applyScheduleChanges(changes, shown, job, versionId, now) {
  const cancel = changes?.unschedule ?? [], add = changes?.schedule;
  if (!add && !cancel.length) return "";
  const notes = [];
  db.exec("BEGIN");
  try {
    for (const n of cancel) {
      const c = shown[n - 1];
      if (c && q.endSchedule.run("ended", now, `suggestion #${job.id}`, c.id).changes) notes.push(`ended "${c.text}"`);
    }
    const when = add && parseWhen(add.when);
    const text = add ? cleanInput(add.text).slice(0, SCHEDULE_CAP) : "";
    const next = when && nextRun(when, now);
    if (add && !when) notes.push(`not saved: can't read the time "${add.when}"`);
    else if (add && (!next || next - now > SCHEDULE_AHEAD_MS)) notes.push(`not saved: "${when.spec}" is ${next ? "too far ahead" : "already past"}`);
    else if (text) {
      const active = q.activeSchedules.all();
      if (active.some((c) => c.when_spec === when.spec && c.text.toLowerCase() === text.toLowerCase())) notes.push(`already scheduled "${text}"`);
      else {
        q.insertSchedule.run(text, when.spec, job.text, job.id, versionId, job.ip_hash, next, now);
        notes.push(`new ${when.spec} "${text}"`);
        const theirs = job.ip_hash === "admin" ? [] : active.filter((c) => c.ip_hash === job.ip_hash);
        const out = new Set(theirs.slice(0, Math.max(0, theirs.length + 1 - SCHEDULES_PER_VISITOR)));
        const left = active.filter((c) => !out.has(c));
        for (const c of left.slice(0, Math.max(0, left.length + 1 - SCHEDULES_MAX))) out.add(c);
        for (const c of out) {
          q.endSchedule.run("evicted", now, `limit, by #${job.id}`, c.id);
          notes.push(`pushed out "${c.text}"`);
        }
      }
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    console.log(`#${job.id} schedules not saved: ${err.message}`);
    return "";
  }
  return notes.join("; ");
}

// Queues each scheduled change whose time has come, at the end of the line. A run missed by more than
// SCHEDULE_LATE_MS (the server was down) is skipped, not made up: a "morning" change shouldn't land at night.
// One still waiting from last time isn't queued twice.
function queueSchedules() {
  const now = Date.now();
  let queued = 0;
  const due = q.dueSchedules.all(now);
  for (const c of due) {
    const when = parseWhen(c.when_spec);
    const next = when?.daily ? nextRun(when, now) : null;
    const late = now - c.next_at > SCHEDULE_LATE_MS;
    const waiting = q.scheduleWaiting.get(c.id);
    const run = !late && !waiting && when;
    if (run) { q.insertScheduled.run(c.text, now, c.id); queued++; }
    const status = next ? "active" : run ? "done" : "missed";
    q.scheduleRan.run(next, run ? 1 : 0, run ? now : null, status, next ? null : now, next ? null : late ? "late" : "server", c.id);
    console.log(`schedule #${c.id} ${run ? "queued" : late ? "missed (late)" : waiting ? "skipped (last run still waiting)" : "dropped"}: ${forLog(c.text)}`);
  }
  if (due.length) broadcastState();   // the panel shows each one's next time
  if (queued) work();
}
setInterval(queueSchedules, 30_000).unref();

// Queues the suggestion that starts a new era, at the end of the line. Weekly by itself (checked hourly), or by
// the admin. Not while one is waiting; a failed one waits for the next interval rather than retrying every hour.
function queueEra(force = false) {
  if (q.eraWaiting.get()) return false;
  if (!force && Date.now() - (q.lastEraTry.get()?.t ?? 0) < ERA_MS) return false;
  q.insertEraSuggestion.run(ERA_TEXT, Date.now());
  console.log(`queued a new era${force ? " (admin)" : ""}`);
  broadcastState();
  work();
  return true;
}
setInterval(queueEra, 3_600_000).unref();

// Queues a cleanup if it's time (see CLEANUP_AFTER). force (the admin): now, whatever the counts and the model.
async function queueCleanup(force = false) {
  if (!force && (!CLEANUP_AFTER || working || draining || favicon || q.queuedCount.get().n || q.running.get())) return false;
  const st = q.cleanupState.get();
  if (!force) {
    const since = q.visitorDoneSince.get(st.lastDone).n;
    if (since < CLEANUP_AFTER) return false;
    if (Date.now() - (st.lastFinished ?? 0) < (since >= 2 * CLEANUP_AFTER ? CLEANUP_BUSY_IDLE_MS : CLEANUP_IDLE_MS)) return false;
    if (!q.visitorDoneSince.get(st.lastTry).n) return false;   // nothing new since the last try
    if (await modelLoaded() !== true) return false;   // asleep (or unknown): don't wake it for this
    if (working || favicon || q.queuedCount.get().n) return false;   // someone came along meanwhile
  }
  const c = CLEANUPS[Number(st.tries) % CLEANUPS.length];
  q.insertCleanup.run(cleanupText(c), Date.now());
  console.log(`queued a cleanup (${c.label})${force ? " (admin)" : ""}`);
  broadcastState();
  work();
  return true;
}
setInterval(() => queueCleanup().catch((err) => console.log(`cleanup check failed: ${err.message}`)), 60_000).unref();

// Redraws the favicon if it's time (see FAVICON_IDLE_MINUTES): the model draws an SVG from the page, renderIcon
// turns it into a PNG, and pages swap their tab icon (the favicon URL in the state). force (the admin): now.
// A visitor's suggestion stops one being drawn (see /api/suggest); it's tried again in the next quiet spell.
let favicon = null;        // the one being drawn: { ac }
let faviconTried = null;   // the version last tried, so a failed drawing isn't retried until the page changes
const faviconUrl = () => { const f = q.latestFavicon.get(); return f ? `/favicon/${DB_ID}-${f.id}.png` : null; };
async function drawFavicon(force = false) {
  if (favicon || draining) return { ok: false, error: favicon ? "already drawing one" : "reloading" };
  const cur = q.latest.get();
  if (!cur) return { ok: false, error: "no page yet" };
  if (!force) {
    if (!FAVICON_IDLE_MS || working || q.queuedCount.get().n || q.running.get() || faviconTried === cur.id) return { ok: false };
    if (!q.changedSince.get(q.latestFavicon.get()?.version_id ?? 0).n) return { ok: false };
    if (Date.now() - (q.cleanupState.get().lastFinished ?? 0) < FAVICON_IDLE_MS) return { ok: false };
    if (await modelLoaded() !== true) return { ok: false };   // asleep (or unknown): don't wake it for this
    if (working || favicon || q.queuedCount.get().n) return { ok: false };   // someone came along meanwhile
  }
  faviconTried = cur.id;
  favicon = { ac: new AbortController() };
  const started = Date.now();
  try {
    const recent = db.prepare(`SELECT text FROM suggestions WHERE status = 'done' AND (kind IS NULL OR kind = 'scheduled')
      ORDER BY id DESC LIMIT 5`).all().map((r) => r.text);
    const drawn = await drawIcon(cur.html, { era: eras().at(-1)?.name, lore: q.activeLore.all().map((l) => l.text), recent,
      signal: favicon.ac.signal });
    const r = drawn.error ? drawn : await renderIcon(drawn.svg);
    if (favicon.ac.signal.aborted) { faviconTried = null; return { ok: false, error: "stopped for a visitor's suggestion" }; }
    if (r.error) {
      console.log(`favicon for v${cur.id} not drawn: ${forLog(r.error)}`);
      return { ok: false, error: r.error };
    }
    const { lastInsertRowid } = q.insertFavicon.run(cur.id, drawn.svg, r.png, Date.now());
    console.log(`new favicon ${lastInsertRowid} for v${cur.id} (${drawn.svg.length} characters of SVG, ${((Date.now() - started) / 1000).toFixed(0)} s)${force ? " (admin)" : ""}`);
    broadcastState();
    return { ok: true, id: Number(lastInsertRowid) };
  } finally {
    favicon = null;
  }
}
setInterval(() => drawFavicon().catch((err) => console.log(`favicon check failed: ${err.message}`)), 60_000).unref();

// Cache warm-up: once the line is empty after the page changed, the model reads the system prompt and the new page
// (warmCache in lib/model.mjs), so the next suggestion resumes from the model server's cache inside the page: ~4 s
// to first text against ~10 s. ~9 s of the model's time per version. A visitor's suggestion stops it (see
// /api/suggest). Only while the model is loaded, never to wake it. CACHE_WARM=0 turns it off.
const CACHE_WARM = env.CACHE_WARM !== "0";
let warming = null;     // the warm-up running: { ac }
let warmedFor = null;   // the version last warmed (or tried), so each is read once
async function warmUp() {
  const busy = () => warming || draining || working || favicon || q.queuedCount.get().n || q.running.get();
  if (!CACHE_WARM || busy()) return;
  const cur = q.latest.get();
  if (!cur || warmedFor === cur.id) return;
  if (await modelLoaded() !== true || busy()) return;   // asleep (or unknown), or someone came along meanwhile
  warmedFor = cur.id;
  warming = { ac: new AbortController() };
  try {
    const r = await warmCache(cur.html, { signal: warming.ac.signal });
    if (warming.ac.signal.aborted) return;   // a suggestion is reading this page now anyway
    console.log(r.error ? `cache warm-up for v${cur.id} failed: ${forLog(r.error)}`
      : `cache warmed for v${cur.id} (${r.secs.toFixed(1)} s, ${r.cached ?? "?"}/${r.prompt ?? "?"} cached)`);
  } finally {
    warming = null;
  }
}
setInterval(() => warmUp().catch((err) => console.log(`cache warm-up failed: ${err.message}`)), 60_000).unref();

// A cleanup's result is published only if it's smaller and looks exactly like the page before it (two screen sizes,
// clock and randomness frozen); anything else, or a visitor's suggestion arriving meanwhile, rejects it.
async function checkCleanup(r, cur, job, onStage) {
  if (interruptible?.interrupted) return { ...r, error: "stopped for a visitor's suggestion", failed: false, html: undefined };
  if (r.error) return r;
  if (r.bytes >= Buffer.byteLength(cur.html)) return { ...r, error: `the page didn't get smaller (${r.bytes} B)` };
  onStage?.("testing");
  const look = await compareLooks(cur.html, r.html);
  const pct = (d) => `${(d * 100).toFixed(2)}%`;
  if (look.skipped) return { ...r, error: `couldn't compare the looks: ${look.reason}` };
  if (interruptible?.interrupted) return { ...r, error: "stopped for a visitor's suggestion" };
  if (!look.same) return { ...r, error: `the page looked different (${look.text ? "" : "text changed; "}pixels ${look.diff.map(pct).join(" / ")})` };
  console.log(`#${job.id} cleanup looks the same (pixels ${look.diff.map(pct).join(" / ")}), ${Buffer.byteLength(cur.html) - r.bytes} B smaller`);
  return r;
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
  // The WebSocket's origin spelled out: older Safari doesn't count ws:/wss: as 'self'.
  `connect-src 'self' ${MAIN_ORIGIN.replace(/^http/, "ws")}`, `frame-src ${SANDBOX_ORIGIN}${TS_ORIGIN}`, "frame-ancestors 'none'",
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
// The current state goes in the page as JSON (a data block, not a script, so the CSP is unchanged): app.js renders
// it before the first paint, so the lists don't fill in and shift the layout a moment later. "<" is escaped so
// visitor or model text can't close the tag.
function indexHtml(req) {
  const boot = JSON.stringify({ ...state(), me: meOfReq(req), progress }).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
  return staticFile("index.html").body.toString("utf8")
    .replace(/(href|src)="\/(app\.css|app\.js|favicon\.svg)"/g, (_, attr, name) => `${attr}="/${name}?v=${staticFile(name).hash}"`)
    .replace(/<link rel="icon"[^>]*>/, (tag) => { const f = faviconUrl(); return f ? `<link rel="icon" href="${f}" type="image/png">` : tag; })
    .replace("</head>", () => `<script id="boot" type="application/json">${boot}</script>\n</head>`);
}

// ---------- reactions: the react button's short messages, sent to everyone here ----------
// A set of a fixed greeting plus a few the model writes with the ideas after each version (lib/ideas.mjs), so they
// fit the page and the room. A page sends one by its number in a set ({ set, i }), never its text, so all anyone
// can send is what the server offered: no free text between visitors. The set before stays good for a little while
// (a tap as a new set arrives). Each is sent at once to every other live page ("react" events: { id: the sender's
// stream id, as in cursors; by: their visitor id; text; at }); the sender's page shows its own already. Not stored.
// How often each was sent goes into the next set's prompt, then starts again.
const REACT_GREETING = "👋 hi";
const REACTIONS_MIN = 3;            // fewer good ones from the model: keep the set we have
const REACT_OLD_MS = 15_000;        // the set before still accepted this long
const REACT_BURST = 5, REACT_PER_SEC = 0.6;   // per visitor (all their tabs)
let reactions = { id: 1, list: [REACT_GREETING] };
let oldReactions = null, oldUntil = 0;
const reactSent = new Map();        // text → times sent, for the set now
function newReactions(list) {
  oldReactions = reactions; oldUntil = Date.now() + REACT_OLD_MS;
  reactions = { id: reactions.id + 1, list: [REACT_GREETING, ...list] };
  reactSent.clear();
}
// Returns [status, body].
function postReact(s, body) {
  if (!s) return [410, { error: "no live connection" }];
  const now = Date.now(), set = Number(body.set), i = Number(body.i);
  const from = set === reactions.id ? reactions : set === oldReactions?.id && now < oldUntil ? oldReactions : null;
  const text = from && Number.isInteger(i) ? from.list[i] : undefined;
  if (text === undefined) return [409, { error: "not a current reaction" }];
  if (!takeToken(`${s.who}:react`, now, REACT_BURST, REACT_PER_SEC)) return [429, { error: "too fast" }];
  if (from === reactions) reactSent.set(text, (reactSent.get(text) ?? 0) + 1);
  const f = frame("react", { id: s.id, by: s.v, text, at: now });
  for (const o of streams.values()) if (o !== s) write(o.res, f);
  return [200, { ok: true }];
}

// ---------- live connections: a WebSocket (/api/ws) or, as a fallback, an event stream (/api/events) ----------
// Both get the same events (see write()); a WebSocket also takes the page's cursor and shared items as messages,
// where an event stream page posts them (/api/cursor, /api/share, /api/unshare, /api/react) with the token from its
// "hello".
const liveRoom = (who) => (streamsByIp.get(who) ?? 0) < STREAMS_PER_IP && clients.size < STREAMS_MAX;
// Starts one; returns its cleanup (call once, when it closes).
function openLive(c, ip) {
  const who = ipHash(ip), v = visitorId(ip);
  streamsByIp.set(who, (streamsByIp.get(who) ?? 0) + 1);
  clients.add(c);
  const token = randomBytes(16).toString("hex");
  const s = { id: randomBytes(6).toString("hex"), v, who, since: Date.now(), res: c, k: null, cur: null, at: 0, posted: 0 };
  streams.set(token, s);
  c.stream = s;
  send(c, "hello", { id: s.id, token, me: meOf(who, v) });
  chromeDirty = true;   // the new page needs the cursors over the controls
  send(c, "state", state());
  if (progress) send(c, "progress", progress);
  broadcastViewers();
  return () => {
    clients.delete(c);
    streams.delete(token);
    if (s.k) dirtyKeys.add(s.k);
    if (s.cur?.z) chromeDirty = true;
    const n = (streamsByIp.get(who) ?? 1) - 1;
    if (n > 0) streamsByIp.set(who, n); else streamsByIp.delete(who);
    broadcastViewers();
  };
}

// WebSockets. Browsers send Origin on the upgrade but no CORS check guards it, so any site could open one: only our
// own page may. Small messages only (cursors, shared items), no compression (memory, and its past DoS bugs).
// Messages: { t: "cursor", k, c }, { t: "share", ch, data, keep, key }, { t: "unshare", ch, key } and
// { t: "react", set, i }, the same bodies the HTTP routes take.
const wss = new WebSocketServer({ noServer: true, maxPayload: 2048, perMessageDeflate: false, clientTracking: false });
const WS_MSGS_PER_SEC = 30;     // more than that from one socket closes it (a page posts ~8 a second at most)
const WS_PING_MS = 25_000;      // Cloudflare drops a socket after 100 s of silence; also finds dead ones
const sockets = new Set();      // { ws } clients, to ping and to close on shutdown
const MAIN_ORIGIN_ONLY = new URL(MAIN_ORIGIN).origin;
function refuseUpgrade(socket, code, text) {
  try { socket.end(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); } catch {}
  socket.destroy();
}
// Registered on the main server below.
function onUpgrade(req, socket, head) {
  socket.on("error", () => {});
  try {
    let path;
    try { path = new URL(req.url, "http://x").pathname; } catch { return refuseUpgrade(socket, 400, "Bad Request"); }
    if (path !== "/api/ws") return refuseUpgrade(socket, 404, "Not Found");
    if (req.headers.origin !== MAIN_ORIGIN_ONLY) return refuseUpgrade(socket, 403, "Forbidden");
    const ip = clientIp(req);
    if (!liveRoom(ipHash(ip))) return refuseUpgrade(socket, 429, "Too Many Requests");
    wss.handleUpgrade(req, socket, head, (ws) => {
      const c = { ws, delta: true, alive: true, n: 0, sec: 0 };
      sockets.add(c);
      const done = openLive(c, ip);
      ws.on("pong", () => { c.alive = true; });
      ws.on("message", (raw, isBinary) => {
        const sec = Math.floor(Date.now() / 1000);
        if (sec !== c.sec) { c.sec = sec; c.n = 0; }
        if (++c.n > WS_MSGS_PER_SEC || isBinary) return ws.close(1008, "too fast");
        let m;
        try { m = JSON.parse(raw.toString()); } catch { return; }
        if (!m || typeof m !== "object") return;
        try {
          if (m.t === "cursor") postCursor(c.stream, m);
          else if (m.t === "share") postShare(c.stream, m);
          else if (m.t === "unshare") postUnshare(c.stream, m);
          else if (m.t === "react") postReact(c.stream, m);
        } catch (err) { console.log(`ws message failed: ${forLog(err.message)}`); }
      });
      ws.on("error", () => {});
      ws.on("close", () => { sockets.delete(c); done(); });
    });
  } catch (err) {
    console.log(`upgrade failed: ${forLog(err.message)}`);
    refuseUpgrade(socket, 500, "Internal Server Error");
  }
}
setInterval(() => {
  for (const c of sockets) {
    if (!c.alive) { c.ws.terminate(); continue; }
    c.alive = false;
    try { c.ws.ping(); } catch {}
  }
}, WS_PING_MS).unref();
// On shutdown or a reload handoff: tell pages the server is restarting (1012), so they reconnect after a short
// random wait instead of all at once.
function closeSockets() {
  for (const c of sockets) { try { c.ws.close(1012, "restarting"); } catch {} }
}

// ---------- main origin ----------
const main = http.createServer(async (req, res) => {
  // A request target like "//%zz" makes new URL throw; outside the try that would take the whole process down.
  let url;
  try { url = new URL(req.url, "http://x"); } catch { return json(res, 400, { error: "bad request" }); }
  const path = url.pathname;
  try {
    const fav = (req.method === "GET" || req.method === "HEAD") && /^\/favicon\/([0-9a-f]+)-(\d+)\.png$/.exec(path);
    if (fav) {
      // Drawn here from the model's SVG (never the SVG itself): an inert image, so it can come from this origin.
      const row = fav[1] === DB_ID ? q.faviconPng.get(Number(fav[2])) : null;
      if (!row) return json(res, 404, { error: "not found" });
      res.writeHead(200, { "Content-Type": "image/png", "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'", "Cache-Control": "public, max-age=31536000, immutable" });
      return res.end(req.method === "HEAD" ? undefined : Buffer.from(row.png));
    }
    if ((req.method === "GET" || req.method === "HEAD") && STATIC[path]) {
      const [file, type] = STATIC[path];
      // The page itself is never cached; an asset is cached for good only when asked for by its current hash.
      const f = staticFile(file);
      const pinned = path !== "/" && url.searchParams.get("v") === f.hash;
      if (path === "/" && req.method === "GET") stats.visitor(ipHash(clientIp(req)));
      res.writeHead(200, {
        "Content-Type": type,
        "Content-Security-Policy": MAIN_CSP,
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
        // Turnstile is an iframe and needs no opener; allow-popups is kept in case its challenge ever opens one.
        "Cross-Origin-Opener-Policy": "same-origin-allow-popups",
        "Cache-Control": pinned ? "public, max-age=31536000, immutable" : "no-store",
      });
      return res.end(path === "/" ? indexHtml(req) : f.body);
    }

    // Polling fallback for connections that buffer the event stream (e.g. Cloudflare quick tunnels).
    if (req.method === "GET" && path === "/api/state") {
      const ip = clientIp(req), h = ipHash(ip), v = visitorId(ip);
      pollers.set(h, { t: Date.now(), v, since: pollers.get(h)?.since ?? Date.now() });
      // ?recent=1: a page that already has the history gets only the newest few, like a broadcast.
      return json(res, 200, { ...state(url.searchParams.has("recent") ? BROADCAST_HISTORY : HISTORY_PAGE), me: meOf(h, v), progress });
    }

    // Older history, a page at a time: versions with id < before, oldest first.
    if (req.method === "GET" && path === "/api/history") {
      const before = Number(url.searchParams.get("before"));
      if (!Number.isInteger(before) || before < 1) return json(res, 400, { error: "before must be a version id" });
      return json(res, 200, { history: historyBefore(before) });
    }

    if (req.method === "GET" && path === "/api/events") {
      // Each stream is an open connection; cap them so one visitor can't hold thousands.
      const ip = clientIp(req), who = ipHash(ip);
      if (!liveRoom(who)) return json(res, 429, { error: "too many live connections" });
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      res.delta = url.searchParams.has("delta");   // an app.js that takes incremental progress and drafts
      const done = openLive(res, ip);
      req.on("close", done);
      return;
    }

    // A page's cursor (see "cursors" above). Cheap and frequent: no rate limit beyond the per-stream one.
    if (req.method === "POST" && path === "/api/cursor") {
      const body = await readJson(req, 600);
      const ok = postCursor(streams.get(String(body?.token ?? "")), body);
      res.writeHead(ok ? 204 : 410, { "Cache-Control": "no-store" });
      return res.end();
    }

    // Shared items (see "shared items" above).
    if (req.method === "POST" && path === "/api/share") {
      const body = await readJson(req, 1024);
      const [status, out] = postShare(streams.get(String(body?.token ?? "")), body);
      return json(res, status, out);
    }
    if (req.method === "POST" && path === "/api/unshare") {
      const body = await readJson(req, 600);
      const [status, out] = postUnshare(streams.get(String(body?.token ?? "")), body);
      return json(res, status, out);
    }
    if (req.method === "POST" && path === "/api/react") {
      const body = await readJson(req, 300);
      const [status, out] = postReact(streams.get(String(body?.token ?? "")), body);
      return json(res, status, out);
    }
    if (req.method === "GET" && path === "/api/shared") {
      const ch = url.searchParams.get("ch") ?? "";
      if (!CHANNEL.test(ch)) return json(res, 400, { error: "bad channel" });
      return json(res, 200, { ch, items: sharedOf(ch) });
    }

    if (req.method === "POST" && path === "/api/suggest") {
      const admin = isAdmin(req);
      const body = await readJson(req, 8192);   // Turnstile tokens can be ~2 KB
      const text = cleanInput(body.text ?? "");
      if (!text) return json(res, 400, { error: "Write a suggestion first." });
      if (text.length > FEEDBACK_CAP) return json(res, 400, { error: `Keep it under ${FEEDBACK_CAP} characters.` });
      // Before the human check, so its token isn't spent; the box keeps the text.
      if (unfinished(text)) return json(res, 400, { error: "That looks unfinished. Finish the thought and send it again." });
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
        if (q.queuedCount.get().n >= QUEUE_MAX) return json(res, 503, { error: "The line is full right now. Try again in a bit." });
        if (!(await turnstileOk(body.turnstile, clientIp(req)))) return json(res, 403, { error: "Couldn't verify you're human. Try again." });
      }
      const { lastInsertRowid } = q.insertSuggestion.run(text, h, Date.now());
      // A cleanup being written gives way: it's thrown away and tried again in a later quiet spell.
      if (interruptible && !interruptible.interrupted) {
        interruptible.interrupted = true;
        interruptible.ac.abort();
        console.log(`#${interruptible.id} cleanup stopped for a visitor's suggestion`);
      }
      if (favicon && !favicon.ac.signal.aborted) {
        favicon.ac.abort();
        console.log("favicon drawing stopped for a visitor's suggestion");
      }
      if (warming && !warming.ac.signal.aborted) warming.ac.abort();
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

    // Removing a scheduled change: whoever suggested it, or the admin.
    if (req.method === "POST" && path === "/api/schedules/remove") {
      const body = await readJson(req);
      const id = Number(body.id);
      const c = Number.isInteger(id) && q.scheduleOwner.get(id);
      if (!c) return json(res, 404, { error: "That isn't scheduled any more." });
      const admin = isAdmin(req);
      if (!admin && c.ip_hash !== ipHash(clientIp(req))) return json(res, 403, { error: "Only whoever scheduled it can remove it." });
      q.endSchedule.run("removed", Date.now(), admin ? "admin" : "author", id);
      broadcastState();
      return json(res, 200, { ok: true });
    }

    // Removing lore: whoever suggested it, or the admin.
    if (req.method === "POST" && path === "/api/lore/remove") {
      const body = await readJson(req);
      const id = Number(body.id);
      const lore = Number.isInteger(id) && q.loreOwner.get(id);
      if (!lore) return json(res, 404, { error: "The page doesn't remember that any more." });
      const admin = isAdmin(req);
      if (!admin && lore.ip_hash !== ipHash(clientIp(req))) return json(res, 403, { error: "Only whoever suggested it can remove it." });
      q.endLore.run("removed", Date.now(), admin ? "admin" : "author", id);
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
      // Undoing a blank slate ({ id }: its suggestion): its rules, lore and schedules come back, and the page from
      // before it is restored as a new version. (Shared items and the earlier-suggestions memory don't come back.)
      if (path === "/api/admin/unwipe") {
        const id = Number(body.id);
        const w = Number.isInteger(id) && db.prepare("SELECT id FROM versions WHERE suggestion_id = ? AND note = 'blank slate'").get(id);
        if (!w) return json(res, 404, { error: "no blank slate for that suggestion" });
        const by = `blank slate #${id}`, now = Date.now();
        const back = (t) => Number(db.prepare(`UPDATE ${t} SET status = 'active', ended_at = NULL, ended_by = NULL WHERE ended_by = ?`).run(by).changes);
        const out = { rules: back("rules"), lore: back("lore"), schedules: 0 };
        for (const c of db.prepare("SELECT id, when_spec FROM schedules WHERE ended_by = ?").all(by)) {
          const when = parseWhen(c.when_spec), next = when && nextRun(when, now);
          if (next) out.schedules += Number(db.prepare("UPDATE schedules SET status = 'active', next_at = ?, ended_at = NULL, ended_by = NULL WHERE id = ?").run(next, c.id).changes);
        }
        const prev = db.prepare("SELECT id FROM versions WHERE id < ? ORDER BY id DESC LIMIT 1").get(w.id);
        if (prev) {
          const v = q.versionHtml.get(prev.id);
          out.version = Number(q.insertVersion.run(v.html, null, `restored v${prev.id}`, Buffer.byteLength(v.html), null, now, v.errors, null).lastInsertRowid);
        }
        console.log(`admin: undid blank slate #${id}: ${JSON.stringify(out)}`);
        broadcastState();
        return json(res, 200, out);
      }
      if (path === "/api/admin/era") {
        return json(res, 200, { ok: queueEra(true) });
      }
      if (path === "/api/admin/favicon") {
        return json(res, 200, await drawFavicon(true));
      }
      if (path === "/api/admin/cleanup") {
        return json(res, 200, { ok: await queueCleanup(true) });
      }
      // Shared items in this era: { ch } one channel, { visitor } one visitor's, both, or neither (everything).
      if (path === "/api/admin/shared/clear") {
        const ch = body.ch == null ? null : String(body.ch), who = body.visitor == null ? null : String(body.visitor);
        const r = q.clearShared.run(sharedEra, ch, ch, who, who);
        broadcast("shared-reset", ch ? { ch } : { all: true });
        return json(res, 200, { removed: Number(r.changes) });
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

main.on("upgrade", onUpgrade);

// ---------- sandbox origin ----------
const SANDBOX_CSP = [
  "default-src 'none'", "script-src 'unsafe-inline'", "style-src 'unsafe-inline'",
  "img-src data:", "font-src data:", "media-src data:", "connect-src 'none'", "form-action 'none'",
  "frame-src 'none'", "base-uri 'none'", `frame-ancestors ${MAIN_ORIGIN}`,
].join("; ");

// Added when serving (not stored): a storage stand-in and live-draft patching. See lib/shim.js.
const SHIM = `<script data-srp>${readFileSync(join(ROOT, "lib", "shim.js"), "utf8")
  .replace("__MAIN_ORIGIN__", () => JSON.stringify(MAIN_ORIGIN))}</script>`;
const SHIM_HASH = createHash("sha256").update(SHIM).digest("hex").slice(0, 8);
// The shim goes first in the document (after a doctype, which must stay first for standards mode), so nothing
// the model wrote can run before it, whatever it puts ahead of <head>.
function withShim(html) {
  const m = /^(?:\s|<!--[\s\S]*?-->)*<!doctype[^>]*>/i.exec(html);
  const at = m ? m[0].length : 0;
  return html.slice(0, at) + SHIM + html.slice(at);
}

// Headers shared by every sandbox page, so /v/ and /d/ can't drift. The permissions policy turns off features
// the page has no business using even if the sandbox attribute is ever loosened.
const SANDBOX_PAGE_HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "Content-Security-Policy": SANDBOX_CSP,
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cross-Origin-Resource-Policy": "cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), display-capture=(), usb=(), serial=(), hid=(), bluetooth=(), payment=(), publickey-credentials-get=(), clipboard-read=()",
  "X-DNS-Prefetch-Control": "off",
};

const sandbox = http.createServer((req, res) => {
  // Nothing in here may throw: this handler is sync, so an exception would be uncaught and end the process.
  try {
    // A bad request target (e.g. "//%zz") makes new URL throw.
    let path;
    try { path = new URL(req.url, "http://x").pathname; } catch {
      res.writeHead(400, { "Content-Type": "text/plain", "Content-Security-Policy": "default-src 'none'" });
      return res.end("bad request");
    }
    const get = req.method === "GET" || req.method === "HEAD";
    // A live draft (see updateDraft): never cached, gone a few drafts later.
    const d = get && /^\/d\/(\d{1,9})$/.exec(path);
    if (d && drafts.has(Number(d[1]))) {
      res.writeHead(200, { ...SANDBOX_PAGE_HEADERS, "Cache-Control": "no-store" });
      return res.end(withShim(drafts.get(Number(d[1]))));
    }
    const m = get && /^\/v\/(\d{1,9})$/.exec(path);
    const v = m && q.versionHtml.get(Number(m[1]));
    if (!v) {
      res.writeHead(404, { "Content-Type": "text/plain", "Content-Security-Policy": "default-src 'none'" });
      return res.end("not found");
    }
    // Versions never change, so Cloudflare and browsers can cache them forever.
    res.writeHead(200, { ...SANDBOX_PAGE_HEADERS, "Cache-Control": "public, max-age=31536000, immutable" });
    res.end(withShim(v.html));
  } catch (err) {
    console.log(`sandbox request failed: ${forLog(err.message)}`);
    if (!res.headersSent) res.writeHead(500, { "Content-Type": "text/plain", "Content-Security-Policy": "default-src 'none'" });
    res.end();
  }
});

// Fixed route names for the traffic counts (never the raw path, which anyone can make up).
const MAIN_ROUTES = new Set(["/", "/api/state", "/api/events", "/api/history", "/api/suggest", "/api/cursor", "/api/share", "/api/unshare", "/api/react", "/api/shared"]);
stats.track(main, "main", (p) => MAIN_ROUTES.has(p) ? p : STATIC[p] || p.startsWith("/favicon/") ? "assets" : p.startsWith("/api/") ? "/api/other" : "other");
stats.track(sandbox, "sandbox", (p) => /^\/v\/\d+$/.test(p) ? "/v" : /^\/d\/\d+$/.test(p) ? "/d" : "other");

main.listen(PORT, HOST, () => {
  sandbox.listen(SANDBOX_PORT, HOST, () => {
    console.log(`main     ${MAIN_ORIGIN}  (listening ${HOST}:${PORT})`);
    console.log(`sandbox  ${SANDBOX_ORIGIN}  (listening ${HOST}:${SANDBOX_PORT})`);
    // Masked: the log is kept for good. The full link: scripts/admin-url.sh
    console.log(`admin    ${MAIN_ORIGIN}/#admin=${ADMIN_TOKEN.slice(0, 4)}…  (full link: scripts/admin-url.sh)`);
    work();
    refreshIdeas();
    queueEra();
    process.send?.({ cmd: "ready" });   // under run.mjs: the new code is serving, so the old worker can go
  });
});

// A generation in progress when the process stops is marked failed on the next start, never re-run (see the UPDATE
// near the top); a reload waits for it instead.
// SIGINT/SIGTERM stop (exit 0). Two ways to run:
// - Under run.mjs (start-remote.sh): this is a cluster worker and run.mjs owns the ports. A reload is a handoff with
//   no downtime: run.mjs sends "drain", this worker finishes the suggestion being written and answers "drained",
//   run.mjs starts the new code, and once it's listening ("ready") sends this one "exit". If the new code fails to
//   start, run.mjs sends "resume" and this worker carries on.
// - On its own (node server.mjs): SIGUSR2 exits with 75 after the drain; whatever started it starts it again.
const stop = (code) => {
  closeSockets();
  setTimeout(() => process.exit(code), 3000).unref();
  stats.flush();
  closeChecker().finally(() => process.exit(code));
};
for (const [sig, code] of [["SIGINT", 0], ["SIGTERM", 0]]) {
  process.on(sig, () => { console.log(`${sig}: shutting down`); stop(code); });
}
// Waits for the suggestion being written to finish (it would be failed otherwise; see the UPDATE near the top) and
// starts no new one meanwhile. Suggestions in line stay queued for the next process. Calls done(busy): busy is true
// when the suggestion ran past its own time limit and is still going.
function drainThen(done) {
  draining = true;
  if (!working) return done(false);
  console.log(`reload: waiting for #${progress?.id ?? "?"} to finish`);
  const until = Date.now() + SUGGESTION_MS + 30_000;
  const t = setInterval(() => {
    if (working && Date.now() < until) return;
    clearInterval(t);
    done(working);
  }, 500);
}
if (cluster.isWorker) {
  process.on("message", (m) => {
    if (m?.cmd === "drain") drainThen((busy) => process.send({ cmd: "drained", busy }));
    else if (m?.cmd === "resume") { draining = false; console.log("reload: cancelled, carrying on"); work(); }
    else if (m?.cmd === "exit") { main.close(); sandbox.close(); stop(0); }   // close: no new connections come here
  });
  process.on("disconnect", () => stop(0));   // run.mjs is gone: don't keep generating with nobody serving
}
// run.mjs handles SIGUSR2 itself (lsof finds it, since it owns the ports); a worker ignores one sent to it.
// On its own: a second SIGUSR2, or a suggestion that runs past its own time limit, restarts at once.
process.on("SIGUSR2", () => {
  if (cluster.isWorker) return;
  if (draining) { console.log("SIGUSR2: restarting"); return stop(75); }
  console.log("SIGUSR2: restarting once the current suggestion is done");
  drainThen(() => { console.log("SIGUSR2: restarting"); stop(75); });
});
