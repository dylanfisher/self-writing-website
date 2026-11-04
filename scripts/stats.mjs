// Usage: node scripts/stats.mjs [days]   (default 14)
// Traffic that reached this machine, visitors, and model work, per day. See lib/stats.mjs for what's counted.
// Read-only; safe to run while the server is up (the last minute of traffic may not be written yet).
import { DatabaseSync } from "node:sqlite";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const days = Math.max(1, Number(process.argv[2]) || 14);
const db = new DatabaseSync(join(dirname(fileURLToPath(import.meta.url)), "..", "data", "site.db"), { readOnly: true });
const has = (t) => db.prepare("SELECT 1 FROM sqlite_master WHERE name = ?").get(t);
if (!has("traffic")) { console.log("No traffic recorded yet (the server starts counting after its next restart)."); process.exit(0); }

const mb = (n) => n >= 1e9 ? `${(n / 1e9).toFixed(2)} GB` : n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${(n / 1e3).toFixed(0)} KB`;
const pad = (s, n) => String(s).padStart(n);
const localDay = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
const since = new Date(); since.setHours(0, 0, 0, 0); since.setDate(since.getDate() - days + 1);
const from = localDay(since.getTime());

const traffic = db.prepare("SELECT day, SUM(requests) r, SUM(bytes_in) i, SUM(bytes_out) o FROM traffic WHERE day >= ? GROUP BY day").all(from);
const visitors = new Map(db.prepare("SELECT day, COUNT(*) n FROM visitors WHERE day >= ? GROUP BY day").all(from).map((r) => [r.day, r.n]));
const peaks = new Map(db.prepare("SELECT day, peak_viewers n FROM daily WHERE day >= ?").all(from).map((r) => [r.day, r.n]));
const work = new Map();
for (const s of db.prepare("SELECT created_at, status, tokens, secs FROM suggestions WHERE created_at >= ?").all(since.getTime())) {
  const d = localDay(s.created_at);
  const w = work.get(d) ?? { n: 0, done: 0, tokens: 0, secs: 0 };
  w.n++; if (s.status === "done") w.done++;
  w.tokens += s.tokens ?? 0; w.secs += s.secs ?? 0;
  work.set(d, w);
}
const allDays = [...new Set([...traffic.map((t) => t.day), ...work.keys()])].sort();
const byDay = new Map(traffic.map((t) => [t.day, t]));

console.log(`Last ${days} days (origin only: Cloudflare-cached requests aren't counted here)\n`);
console.log("day          requests        in       out  visitors  peak  suggestions  done   tokens  model time");
const tot = { r: 0, i: 0, o: 0, n: 0, done: 0, tokens: 0, secs: 0 };
for (const d of allDays) {
  const t = byDay.get(d) ?? { r: 0, i: 0, o: 0 }, w = work.get(d) ?? { n: 0, done: 0, tokens: 0, secs: 0 };
  console.log(`${d} ${pad(t.r, 10)} ${pad(mb(t.i), 9)} ${pad(mb(t.o), 9)} ${pad(visitors.get(d) ?? "", 9)} ${pad(peaks.get(d) ?? "", 5)}` +
    ` ${pad(w.n, 12)} ${pad(w.done, 5)} ${pad(w.tokens || "", 8)} ${pad(w.secs ? `${(w.secs / 60).toFixed(0)} min` : "", 11)}`);
  tot.r += t.r; tot.i += t.i; tot.o += t.o; tot.n += w.n; tot.done += w.done; tot.tokens += w.tokens; tot.secs += w.secs;
}
const uniq = db.prepare("SELECT COUNT(DISTINCT ip_hash) n FROM visitors WHERE day >= ?").get(from).n;
console.log(`${"total".padEnd(10)} ${pad(tot.r, 10)} ${pad(mb(tot.i), 9)} ${pad(mb(tot.o), 9)} ${pad(uniq, 9)} ${pad("", 5)}` +
  ` ${pad(tot.n, 12)} ${pad(tot.done, 5)} ${pad(tot.tokens || "", 8)} ${pad(tot.secs ? `${(tot.secs / 60).toFixed(0)} min` : "", 11)}`);

console.log("\nBy route");
console.log("host     route              requests        in       out");
for (const r of db.prepare(`SELECT host, route, SUM(requests) r, SUM(bytes_in) i, SUM(bytes_out) o FROM traffic
    WHERE day >= ? GROUP BY host, route ORDER BY o DESC`).all(from)) {
  console.log(`${r.host.padEnd(8)} ${r.route.padEnd(16)} ${pad(r.r, 10)} ${pad(mb(r.i), 9)} ${pad(mb(r.o), 9)}`);
}
console.log("\n(tokens and model time are counted from the restart that added them; earlier suggestions show blank)");
