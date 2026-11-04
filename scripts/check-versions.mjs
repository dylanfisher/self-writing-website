#!/usr/bin/env node
// Runs every version (or the ids given) through the browser check and records its JavaScript errors,
// so History can mark broken versions. Usage: node scripts/check-versions.mjs [id ...]
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { checkPage, closeChecker } from "../lib/check.mjs";

const db = new DatabaseSync(join(dirname(fileURLToPath(import.meta.url)), "..", "data", "site.db"));
const ids = process.argv.slice(2).map(Number);
const rows = ids.length
  ? ids.map((id) => db.prepare("SELECT id, html FROM versions WHERE id = ?").get(id)).filter(Boolean)
  : db.prepare("SELECT id, html FROM versions ORDER BY id").all();
const set = db.prepare("UPDATE versions SET errors = ? WHERE id = ?");
for (const v of rows) {
  const r = await checkPage(v.html);
  if (r.skipped) { console.error(`check unavailable: ${r.reason}`); process.exit(1); }
  set.run(r.errors.length ? JSON.stringify(r.errors) : null, v.id);
  if (r.errors.length) console.log(`v${v.id}: ${r.details[0].slice(0, 160)}`);
}
await closeChecker();
console.log(`checked ${rows.length} versions`);
