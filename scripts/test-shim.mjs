// Tests lib/shim.js's live-draft patching in headless Chromium: node scripts/test-shim.mjs
import http from "node:http";
import { readFileSync } from "node:fs";
import { chromium } from "playwright-core";

const SHIM = readFileSync(new URL("../lib/shim.js", import.meta.url), "utf8");
const pages = new Map();
let origin;
const srv = http.createServer((req, res) => {
  const html = pages.get(new URL(req.url, "http://x").pathname) ?? "missing";
  const shim = `<script data-srp>${SHIM.replace("__MAIN_ORIGIN__", () => JSON.stringify(origin))}</script>`;
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(html.replace(/<head>/, `<head>${shim}`));
});
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
origin = `http://127.0.0.1:${srv.address().port}`;
const { findChromium } = await import("../lib/check.mjs");
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? findChromium(chromium), timeout: 20_000 });
let failed = 0;
const ok = (cond, msg) => { console.log(`${cond ? "ok  " : "FAIL"} ${msg}`); if (!cond) failed++; };

// The page posts to itself: at the top level, parent is the window and the origin is the server's.
async function run(from, to) {
  const page = await browser.newPage();
  pages.set("/d/1", from); pages.set("/d/2", to);
  await page.goto(`${origin}/d/1`);
  await page.evaluate(() => { window.marker = 1; });
  // A reply that's lost because the page navigates away counts as failed.
  const reply = await page.evaluate(([from, html]) => new Promise((resolve) => {
    addEventListener("message", (e) => { if (e.data?.srp === "morphed") resolve(e.data); });
    setTimeout(() => resolve({ timeout: true }), 3000);
    postMessage({ srp: "morph", from, html, url: "/d/2" }, location.origin);
  }), [from, to]).catch(() => ({ failed: true }));
  await page.waitForTimeout(300);
  const reloaded = await page.evaluate(() => window.marker !== 1).catch(() => true);
  return { page, reply, reloaded };
}

const SCRIPT = `<script>const d=document.createElement("div");d.id="made";document.body.append(d);
document.querySelector("#box").style.left="50px";</script>`;
const base = (style, body, script = SCRIPT) =>
  `<!doctype html><html><head><title>T</title><style>${style}</style></head><body>\n${body}\n${script}\n</body></html>`;
const BODY = `<h1 class="a">Hello</h1>\n<div id="box" style="position:absolute">box</div>\n<p>one</p>`;

{ // CSS only
  const { page, reply, reloaded } = await run(base("h1{color:red}", BODY), base("h1{color:blue}", BODY));
  ok(!reloaded && reply.exact === true, "CSS change patched in place, exact");
  ok(await page.evaluate(() => getComputedStyle(document.querySelector("h1")).color) === "rgb(0, 0, 255)", "new CSS applies");
  ok(await page.evaluate(() => !!document.querySelector("#made") && document.querySelector("#box").style.left === "50px"), "script-made node and moved box kept");
}
{ // markup: text, attribute, new element, removed element
  const to = BODY.replace("Hello", "Hi there").replace('class="a"', 'class="b"').replace("<p>one</p>", "<p>two</p>\n<span id=new>new</span>");
  const { page, reply, reloaded } = await run(base("", BODY), base("", to));
  ok(!reloaded && reply.exact === false, "markup change patched in place, marked not exact (page has scripts)");
  const s = await page.evaluate(() => ({ h: document.querySelector("h1").outerHTML, p: document.querySelector("p").textContent,
    n: !!document.querySelector("#new"), made: !!document.querySelector("#made"), left: document.querySelector("#box").style.left,
    srp: !!document.querySelector("script[data-srp]") }));
  ok(s.h === '<h1 class="b">Hi there</h1>', `heading patched (${s.h})`);
  ok(s.p === "two" && s.n, "paragraph changed and new element added");
  ok(s.made && s.left === "50px" && s.srp, "script-made node, moved box and shim kept");
}
{ // no scripts: exact
  const { reply, reloaded } = await run(base("", BODY, ""), base("", BODY + "\n<p>more</p>", ""));
  ok(!reloaded && reply.exact === true, "markup change on a page without scripts is exact");
}
{ // script changed → loads the new page
  const { page, reply, reloaded } = await run(base("", BODY), base("", BODY, SCRIPT.replace("50px", "60px")));
  ok(reply.failed && reloaded, "script change falls back to loading");
  ok(page.url().endsWith("/d/2") && await page.evaluate(() => document.querySelector("#box").style.left) === "60px", "and shows the new page");
}
await browser.close();
srv.close();
process.exit(failed ? 1 : 0);
