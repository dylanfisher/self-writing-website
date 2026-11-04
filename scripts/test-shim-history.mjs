// Replays real version pairs (v[n-1] → v[n]) through lib/shim.js's patching: how many would patch in place,
// and whether patching throws. node scripts/test-shim-history.mjs [count=40]
import http from "node:http";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { chromium } from "playwright-core";
import { findChromium } from "../lib/check.mjs";

const db = new DatabaseSync(new URL("../data/site.db", import.meta.url).pathname, { readOnly: true });
const rows = db.prepare("SELECT id, html FROM versions ORDER BY id DESC LIMIT ?").all(Number(process.argv[2] ?? 40) + 1).reverse();
const SHIM = readFileSync(new URL("../lib/shim.js", import.meta.url), "utf8");
let origin, from = "";
const srv = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8",
    "Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:" });
  const shim = `<script data-srp>${SHIM.replace("__MAIN_ORIGIN__", () => JSON.stringify(origin))}</script>`;
  // As server.mjs's withShim: after <head>, else after <html>, else first.
  const m = /<head\b[^>]*>/i.exec(from) ?? /<html\b[^>]*>/i.exec(from);
  res.end(m ? from.slice(0, m.index + m[0].length) + shim + from.slice(m.index + m[0].length) : shim + from);
});
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
origin = `http://127.0.0.1:${srv.address().port}`;
const browser = await chromium.launch({ executablePath: findChromium(chromium) });
const tally = { exact: 0, approx: 0, reload: 0 };
for (let i = 1; i < rows.length; i++) {
  from = rows[i - 1].html;
  const page = await browser.newPage();
  const errs = [];
  await page.goto(`${origin}/d/1`);
  await page.waitForTimeout(150);
  page.on("pageerror", (e) => errs.push(e.message));
  const t = Date.now();
  const r = await page.evaluate(([from, html]) => new Promise((resolve) => {
    addEventListener("message", (e) => { if (e.data?.srp === "morphed") resolve(e.data); });
    setTimeout(() => resolve({ timeout: true }), 3000);
    postMessage({ srp: "morph", from, html, url: "/nowhere" }, location.origin);
  }), [from, rows[i].html]).catch(() => ({ failed: true }));
  const kind = r.failed || r.timeout ? "reload" : r.exact ? "exact" : "approx";
  // An exact patch must leave the same document as loading the new version.
  let differs = "";
  if (kind === "exact") {
    const dom = (p) => p.evaluate(() => document.documentElement.outerHTML.replace(/<script data-srp>[\s\S]*?<\/script>/, ""));
    const patched = await dom(page);
    from = rows[i].html;
    const fresh = await browser.newPage();
    await fresh.goto(`${origin}/d/1`);
    const loaded = await dom(fresh);
    await fresh.close();
    if (patched !== loaded) {
      let k = 0; while (patched[k] === loaded[k]) k++;
      differs = ` DIFFERS at ${k}: ${JSON.stringify(patched.slice(k - 20, k + 40))} vs ${JSON.stringify(loaded.slice(k - 20, k + 40))}`;
      tally.differs = (tally.differs ?? 0) + 1;
    }
  }
  tally[kind]++;
  console.log(`v${rows[i - 1].id}→v${rows[i].id} ${kind}${r.timeout ? " (timeout)" : ""} ${Date.now() - t} ms${errs.length ? ` errors: ${errs[0].slice(0, 80)}` : ""}${differs}`);
  await page.close();
}
console.log(tally);
await browser.close();
srv.close();
