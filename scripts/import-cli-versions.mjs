#!/usr/bin/env node
// Copies the CLI experiment (versions/v*.html + versions/log.jsonl) into data/site.db,
// so the site starts with a history to browse. Only runs on a database that holds nothing but the seed.
// Stop the server first. To start over: rm data/site.db*
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const dbPath = join(ROOT, "data", "site.db");
if (!existsSync(dbPath)) { console.error("Run the server once first to create data/site.db."); process.exit(1); }
const db = new DatabaseSync(dbPath);

const count = db.prepare("SELECT count(*) n FROM versions").get().n;
const sugg = db.prepare("SELECT count(*) n FROM suggestions").get().n;
if (count !== 1 || sugg !== 0) { console.error(`Database already has ${count} versions / ${sugg} suggestions; not importing.`); process.exit(1); }

const log = readFileSync(join(ROOT, "versions", "log.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((e) => e.ok);
const insS = db.prepare("INSERT INTO suggestions (text, ip_hash, status, version_id, created_at, started_at, finished_at) VALUES (?, 'cli', 'done', ?, ?, ?, ?)");
const insV = db.prepare("INSERT INTO versions (html, suggestion_id, note, bytes, secs, created_at) VALUES (?, ?, ?, ?, ?, ?)");
const setV = db.prepare("UPDATE suggestions SET version_id = ? WHERE id = ?");

// Versions in the CLI form a chain (each from the previous), so import them in order.
let t = Date.now() - log.length * 90_000;
db.exec("BEGIN");
for (const e of log.sort((a, b) => a.version - b.version)) {
  const html = readFileSync(join(ROOT, "versions", `v${e.version}.html`), "utf8");
  t += 90_000;
  const s = insS.run(e.feedback, null, t - e.secs * 1000, t - e.secs * 1000, t);
  const v = insV.run(html, Number(s.lastInsertRowid), null, Buffer.byteLength(html), e.secs, t);
  setV.run(Number(v.lastInsertRowid), Number(s.lastInsertRowid));
}
db.exec("COMMIT");
console.log(`Imported ${log.length} versions.`);
