// Replays recent visitor suggestions against the page each one was made on, one reply each, and reports how good
// the first reply was: did it parse, how many SEARCH parts missed the page, and would it pass the site's own checks
// (lint and the headless browser) with no fix-up round. For comparing prompts, sampling and models; doesn't change
// the site. No memory (rules, lore, history), so it measures the edits, not the whole prompt.
//   node scripts/eval-format.mjs [count=30]
//   MODEL=<omlx id>          another model than the site's (omlx swaps models: only in a quiet spell)
//   MODEL_TEMPERATURE=0.4    another sampling temperature
//   EVAL_THINK=1             let the model think first (THINK_TOKENS at most)
//   MODEL_LIB=../lib/x.mjs   another copy of lib/model.mjs, to compare prompts (it must sit in lib/, for its imports)
// It competes with live suggestions for the model, so their times (and these) are slower while it runs.
import { DatabaseSync } from "node:sqlite";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { lint } from "../lib/lint.mjs";
import { checkPage } from "../lib/check.mjs";
const { buildMessages, generate, extract, parseEdits, repairEdits, tidy, MODEL, TEMPERATURE } =
  await import(process.env.MODEL_LIB ?? "../lib/model.mjs");

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const db = new DatabaseSync(join(root, "data", "site.db"), { readOnly: true });
const count = Number(process.argv[2] ?? 30);
const think = process.env.EVAL_THINK === "1";
// Visitor suggestions that made a version, with the version they were made on (the newest before theirs).
const rows = db.prepare(`SELECT s.id, s.text, s.version_id,
    (SELECT html FROM versions v WHERE v.id < s.version_id ORDER BY v.id DESC LIMIT 1) AS base
  FROM suggestions s WHERE s.status = 'done' AND s.kind IS NULL AND s.version_id IS NOT NULL
  ORDER BY s.id DESC LIMIT ?`).all(count).reverse().filter((r) => r.base);

console.log(`model: ${MODEL}, temperature ${TEMPERATURE}${think ? ", thinking" : ""}, ${rows.length} suggestions`);
const t = { parsed: 0, clean: 0, edits: 0, missed: 0, secs: 0, tokens: 0, ttft: 0, why: {} };
const fault = (k) => { t.why[k] = (t.why[k] ?? 0) + 1; return k; };
for (const r of rows) {
  const page = tidy(r.base);
  const out = await generate(buildMessages(page, r.text, { context: { version: r.version_id - 1 } }), { think });
  const res = extract(out.text, out.finish, page);
  const edits = parseEdits(repairEdits(out.text)).length;
  // SEARCH parts that weren't on the page (miscopied) or were on it more than once.
  const missed = (res.failures ?? []).filter((f) => /SEARCH text/.test(f.error)).length;
  t.edits += edits; t.missed += missed;
  t.secs += out.secs; t.tokens += out.usage.completion_tokens ?? 0; t.ttft += out.ttft ?? 0;
  let verdict;
  if (res.error) verdict = fault(res.error.replace(/\s*\(.*$/s, "").replace(/\d+ of \d+/, "N of N"));
  else {
    t.parsed++;
    // The same bar the site sets before publishing: no new lint problem, JS error, dead click or dead animation.
    const baseKeys = new Set(lint(page).problems.map((p) => p.key));
    const fresh = lint(res.html).problems.filter((p) => !baseKeys.has(p.key));
    const [before, after] = await Promise.all([checkPage(page), checkPage(res.html)]);
    const quiet = (c) => [...(c.unclickable ?? []), ...(c.animations ?? [])];
    const errs = after.skipped ? [] : (after.errors ?? []).filter((e) => !(before.errors ?? []).includes(e));
    const dead = after.skipped ? [] : quiet(after).filter((u) => !quiet(before).includes(u));
    if (fresh.length) verdict = fault(`lint: ${fresh[0].msg.slice(0, 70)}`);
    else if (errs.length) verdict = fault(`JS error: ${errs[0].slice(0, 70)}`);
    else if (dead.length) verdict = fault(`dead: ${dead[0].slice(0, 70)}`);
    else { t.clean++; verdict = "clean"; }
  }
  console.log(`#${r.id} ${verdict === "clean" ? "✓" : "✗"} ${verdict === "clean" ? `${res.edits} edits` : verdict.slice(0, 90)}` +
    `${missed ? ` (${missed} SEARCH missed)` : ""} · ${out.secs.toFixed(1)} s, ${out.usage.completion_tokens ?? "?"} tokens · ` +
    JSON.stringify(r.text.slice(0, 50)));
}
const n = rows.length;
console.log(`\n${t.clean}/${n} clean on the first try (pass every check) · ${t.parsed}/${n} parsed and applied · ` +
  `${t.missed}/${t.edits} SEARCH parts missed\nmean ${(t.secs / n).toFixed(1)} s, ${(t.ttft / n).toFixed(1)} s to first ` +
  `text, ${Math.round(t.tokens / n)} tokens, ${(t.tokens / Math.max(1, t.secs - t.ttft)).toFixed(1)} tok/s writing`);
console.log(Object.entries(t.why).sort((a, b) => b[1] - a[1]).map(([k, v]) => `  ${v}× ${k}`).join("\n"));
process.exit(0);   // checkPage's browser would keep the process alive
