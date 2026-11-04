// Usage: node .claude/skills/retro/digest.mjs [--last N | --hours H] [--full]
// Read-only digest of recent suggestions for a retrospective: what was asked, what the model did, what went wrong.
// Safe while the server runs. Prints no secrets (only "#<id> " lines of server.log are read).
import { DatabaseSync } from "node:sqlite";
import { readFileSync, existsSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const DATA = join(ROOT, "data");
const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
const full = process.argv.includes("--full");
const hours = Number(arg("--hours")) || 0;
const last = Number(arg("--last")) || 30;

const db = new DatabaseSync(join(DATA, "site.db"), { readOnly: true });
const rows = hours
  ? db.prepare("SELECT * FROM suggestions WHERE created_at >= ? ORDER BY id").all(Date.now() - hours * 3600_000)
  : db.prepare("SELECT * FROM (SELECT * FROM suggestions ORDER BY id DESC LIMIT ?) ORDER BY id").all(last);
if (!rows.length) { console.log("No suggestions in that window."); process.exit(0); }

const version = db.prepare("SELECT id, bytes, summary, errors, note FROM versions WHERE suggestion_id = ? ORDER BY id DESC LIMIT 1");
const before = db.prepare("SELECT bytes FROM versions WHERE id < ? ORDER BY id DESC LIMIT 1");
const rulesBy = db.prepare("SELECT id, text, status, ended_by FROM rules WHERE suggestion_id = ?");
const loreBy = db.prepare("SELECT id, text, status FROM lore WHERE suggestion_id = ?");
const endedBy = db.prepare("SELECT id, text, status FROM rules WHERE ended_by = ? OR updated_by = ?");

// server.log lines for these suggestions, by id
const ids = new Set(rows.map((r) => r.id));
const log = new Map();
const logPath = join(DATA, "server.log");
if (existsSync(logPath)) {
  for (const line of readFileSync(logPath, "utf8").split("\n")) {
    const m = /^#(\d+) /.exec(line);
    if (m && ids.has(+m[1])) (log.get(+m[1]) ?? log.set(+m[1], []).get(+m[1])).push(line.slice(m[0].length));
  }
}

const clip = (s, n = 300) => { s = String(s ?? "").replace(/\\u000a/g, "\n"); return full || s.length <= n ? s : s.slice(0, n) + "…"; };
const when = (ms) => ms ? new Date(ms).toLocaleString("sv-SE").slice(0, 16) : "?";
const stats = { status: {}, kind: {}, retried: 0, retries: 0, secs: [], tokens: [], reasons: {} };
const reasonOf = (s) => (/FIND is not in the page/.test(s) ? "FIND not in page"
  : /malformed/.test(s) ? "malformed block" : /changed nothing/.test(s) ? "changed nothing"
  : /crashed|JavaScript|error/i.test(s) ? "JS error" : /repeat|loop/i.test(s) ? "repetition loop"
  : /too big|limit|KB/.test(s) ? "size" : /no edit blocks/.test(s) ? "no edit blocks" : /code outside/.test(s) ? "code outside block"
  : /FIND is empty/.test(s) ? "empty FIND" : /too slow/.test(s) ? "too slow"
  : /worse/.test(s) ? "worse than current" : /time|stall|deadline/i.test(s) ? "timeout" : "other");

const out = [];
for (const s of rows) {
  stats.status[s.status] = (stats.status[s.status] ?? 0) + 1;
  stats.kind[s.kind ?? "visitor"] = (stats.kind[s.kind ?? "visitor"] ?? 0) + 1;
  if (s.secs) stats.secs.push(s.secs);
  if (s.tokens) stats.tokens.push(s.tokens);
  const lines = log.get(s.id) ?? [];
  const retries = lines.filter((l) => l.startsWith("retrying"));
  if (retries.length) { stats.retried++; stats.retries += retries.length; }
  for (const r of retries) { const k = reasonOf(r); stats.reasons[k] = (stats.reasons[k] ?? 0) + 1; }
  if (s.error) { const k = "final: " + reasonOf(s.error); stats.reasons[k] = (stats.reasons[k] ?? 0) + 1; }

  out.push(`\n## #${s.id} [${s.status}${s.kind ? `, ${s.kind}` : ""}] ${when(s.created_at)} · visitor ${String(s.ip_hash).slice(0, 6)}`);
  out.push(`Asked: ${clip(s.text, 500)}`);
  const v = version.get(s.id);
  if (v) {
    const b = before.get(v.id);
    out.push(`Result: v${v.id}, ${v.bytes} B${b ? ` (${v.bytes - b.bytes >= 0 ? "+" : ""}${v.bytes - b.bytes})` : ""}` +
      `${s.secs ? `, ${Math.round(s.secs)} s` : ""}${s.tokens ? `, ${s.tokens} tokens` : ""}${v.note ? `, note: ${v.note}` : ""}`);
    if (v.summary) out.push(`Model said: ${clip(v.summary)}`);
    if (v.errors) out.push(`Page errors kept: ${clip(v.errors)}`);
  }
  if (s.error) out.push(`Error: ${clip(s.error)}`);
  for (const r of rulesBy.all(s.id)) out.push(`Rule made: r${r.id} "${r.text}" (${r.status}${r.ended_by ? `, ended by ${r.ended_by}` : ""})`);
  for (const r of endedBy.all(`suggestion #${s.id}`, `suggestion #${s.id}`)) out.push(`Rule ended/changed: r${r.id} "${r.text}"`);
  for (const l of loreBy.all(s.id)) out.push(`Lore: "${l.text}" (${l.status})`);
  for (const l of lines.filter((l) => !l.startsWith("→"))) out.push(`log: ${clip(l, 240)}`);
  const att = join(DATA, "attempts", `${s.id}.txt`);
  if (existsSync(att)) out.push(`Raw failed attempts: data/attempts/${s.id}.txt (${statSync(att).size} B)`);
}

const med = (a) => a.length ? [...a].sort((x, y) => x - y)[a.length >> 1] : 0;
const head = [
  `# Retro digest: #${rows[0].id}–#${rows.at(-1).id} (${rows.length} suggestions, ${when(rows[0].created_at)} → ${when(rows.at(-1).created_at)})`,
  `Status: ${Object.entries(stats.status).map(([k, n]) => `${k} ${n}`).join(", ")}`,
  `Kinds: ${Object.entries(stats.kind).map(([k, n]) => `${k} ${n}`).join(", ")}`,
  `Retried: ${stats.retried} suggestions, ${stats.retries} retries in all`,
  `Problems: ${Object.entries(stats.reasons).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(", ") || "none"}`,
  `Median: ${Math.round(med(stats.secs))} s, ${med(stats.tokens)} output tokens`,
  `Active now: ${db.prepare("SELECT COUNT(*) n FROM rules WHERE status='active'").get().n} rules, ` +
    `${db.prepare("SELECT COUNT(*) n FROM lore WHERE status='active'").get().n} lore`,
];
console.log(head.join("\n") + "\n" + out.join("\n"));
