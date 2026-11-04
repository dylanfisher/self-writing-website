#!/usr/bin/env node
// One rewrite round from the command line, for tuning the prompt without the server.
//   node rewrite.mjs "make it about frogs"          (thinking off)
//   node rewrite.mjs --think "make it about frogs"  (thinking on)
// Reads the latest versions/vN.html, saves versions/v(N+1).html and appends to versions/log.jsonl.
// Model output is untrusted text: it is only ever written to versions/v<number>.html.

import { readFileSync, writeFileSync, appendFileSync, readdirSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { rewrite, SEED, FEEDBACK_CAP } from "./lib/model.mjs";

const DIR = join(dirname(fileURLToPath(import.meta.url)), "versions");
mkdirSync(DIR, { recursive: true });

const args = process.argv.slice(2);
const think = args[0] === "--think";
if (think) args.shift();
const feedback = args.join(" ").trim().slice(0, FEEDBACK_CAP);
if (!feedback) {
  console.error('usage: node rewrite.mjs [--think] "suggestion"');
  process.exit(1);
}

const nums = readdirSync(DIR).map((f) => /^v(\d+)\.html$/.exec(f)?.[1]).filter(Boolean).map(Number);
if (nums.length === 0) { writeFileSync(join(DIR, "v0.html"), SEED); nums.push(0); }
const cur = Math.max(...nums);
const current = readFileSync(join(DIR, `v${cur}.html`), "utf8");
const log = (entry) => appendFileSync(join(DIR, "log.jsonl"), JSON.stringify(entry) + "\n");

let r;
try {
  r = await rewrite(current, feedback, { think });
} catch (err) {
  log({ from: cur, feedback, think, ok: false, error: String(err) });
  console.error("request failed:", err.message);
  process.exit(1);
}

if (r.error) {
  log({ from: cur, feedback, think, ok: false, error: r.error, secs: r.secs, out_tokens: r.tokens, attempts: r.attempts });
  writeFileSync(join(DIR, `rejected-${Date.now()}.txt`), String(r.raw ?? ""));
  console.error(`rejected: ${r.error}  (v${cur} stays current)`);
  process.exit(2);
}

const next = cur + 1;
writeFileSync(join(DIR, `v${next}.html`), r.html);
log({ version: next, from: cur, feedback, think, ok: true, bytes: r.bytes, secs: r.secs, out_tokens: r.tokens, attempts: r.attempts });
console.log(`v${next}.html  ${r.bytes} B  ${r.secs.toFixed(0)}s  ${r.tokens} tok  (${r.attempts} attempt${r.attempts > 1 ? "s" : ""})`);
