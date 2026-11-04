// Times the model on real prompts: the latest page from data/site.db and a few typical suggestions.
// For comparing model-server settings (speculative decoding, caching). Doesn't change the site.
//   node scripts/bench-model.mjs [rounds=1]
// Prints, per reply: wait for first text, output tokens, writing speed, total, and prompt tokens cached.
import { DatabaseSync } from "node:sqlite";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildMessages, generate, tidy } from "../lib/model.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const db = new DatabaseSync(join(root, "data", "site.db"), { readOnly: true });
const cur = db.prepare("SELECT id, html FROM versions ORDER BY id DESC LIMIT 1").get();
const SUGGESTIONS = [
  "make the background a sunset gradient",
  "add a little cat that walks across the bottom",
  "rename every heading to something more dramatic",
];
const rounds = Number(process.argv[2] ?? 1);
const rows = [];
for (let r = 0; r < rounds; r++) {
  for (const s of SUGGESTIONS) {
    const out = await generate(buildMessages(tidy(cur.html), s, { context: { version: cur.id } }));
    const n = out.usage.completion_tokens ?? 0;
    const row = {
      suggestion: s.slice(0, 32),
      ttft: +(out.ttft ?? 0).toFixed(2),
      tokens: n,
      "tok/s": +(n / Math.max(0.01, out.secs - (out.ttft ?? 0))).toFixed(1),
      secs: +out.secs.toFixed(1),
      cached: `${out.usage.prompt_tokens_details?.cached_tokens ?? "?"}/${out.usage.prompt_tokens ?? "?"}`,
    };
    rows.push(row);
    console.log(JSON.stringify(row));
  }
}
const sum = (k) => rows.reduce((a, r) => a + r[k], 0);
console.log(`v${cur.id}: mean ${(sum("tokens") / sum("secs")).toFixed(1)} tok/s overall, ` +
  `${(rows.reduce((a, r) => a + r.tokens, 0) / rows.reduce((a, r) => a + r.secs - r.ttft, 0)).toFixed(1)} tok/s writing, ` +
  `${(sum("ttft") / rows.length).toFixed(2)} s to first text`);
