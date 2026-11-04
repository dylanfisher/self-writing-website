// Tests lib/shim.js's live-draft patching in headless Chromium: node scripts/test-shim.mjs
import http from "node:http";
import { readFileSync } from "node:fs";
import { chromium } from "playwright-core";

const SHIM = readFileSync(new URL("../lib/shim.js", import.meta.url), "utf8");
const pages = new Map();
let origin;
const srv = http.createServer((req, res) => {
  const html = pages.get(new URL(req.url, "http://x").pathname) ?? "missing";
  const shim = `<script data-srp>${SHIM.replace("window.top === window", "false").replace("__MAIN_ORIGIN__", () => JSON.stringify(origin))}</script>`;
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
{ // cursors: reported relative to the element under the pointer, drawn at that element, kept through a patch
  const body = `<h1>Title</h1>\n<div id="a" style="margin:40px 0 0 100px;width:200px;height:100px;background:#eee">a</div>\n<p>after</p>`;
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  // Only here: open the overlay's shadow root so the test can see where cursors are drawn.
  await page.addInitScript(() => { const a = Element.prototype.attachShadow; Element.prototype.attachShadow = function () { return a.call(this, { mode: "open" }); }; });
  pages.set("/d/1", base("body{margin:0}", body, ""));
  await page.goto(`${origin}/d/1`);
  const got = page.evaluate(() => new Promise((resolve) => {
    addEventListener("message", (e) => { if (e.data?.srp === "pointer" && !e.data.gone) resolve(e.data); });
    setTimeout(() => resolve(null), 2000);
  }));
  const box = await page.locator("#a").boundingBox();
  await page.mouse.move(box.x + 50, box.y + 25);
  const ptr = await got;
  ok(ptr && ptr.p === "1" && ptr.fx === 0.25 && ptr.fy === 0.25, `pointer reported on its element (${JSON.stringify(ptr)})`);
  const draw = (list) => page.evaluate((list) => postMessage({ srp: "cursors", list }, location.origin), list);
  const drawn = () => page.waitForTimeout(700).then(() => page.evaluate(() => {
    const host = document.querySelector("srp-cursors");
    if (!host?.isConnected) return null;
    return [...host.shadowRoot.querySelectorAll(".c")].map((c) => ({ gone: c.classList.contains("gone"),
      ...(([x, y]) => ({ x: Math.round(x), y: Math.round(y) }))(/translate\(([-\d.]+)px,\s*([-\d.]+)px/.exec(c.style.transform).slice(1).map(Number)) }));
  }));
  // Someone else's cursor on the same spot of #a; another on an element this page doesn't have (fallback x/y).
  await draw([{ id: "abc123", hue: 200, ...ptr }, { id: "def456", hue: 10, p: "9.9", fx: 0, fy: 0, x: 0.5, y: 300 }]);
  let c = await drawn();
  ok(c?.length === 2 && c[0].x === Math.round(box.x + 50) && c[0].y === Math.round(box.y + 25), `cursor drawn on its element (${JSON.stringify(c?.[0])})`);
  ok(c?.[1].x === 400 && c[1].y === 300, `unknown element falls back to page position (${JSON.stringify(c?.[1])})`);
  // The element moves (another screen size, a script): the cursor follows it.
  await page.evaluate(() => { document.querySelector("#a").style.marginLeft = "300px"; });
  c = await drawn();
  ok(c?.[0].x === Math.round(box.x + 250), `cursor follows its element (${c?.[0].x})`);
  // Gone from the list: fades and is removed.
  await draw([{ id: "abc123", hue: 200, ...ptr }]);
  c = await drawn();
  ok(c?.length === 1, "cursor that left is removed");
  // Patched to the next draft: the overlay stays (it's ours, data-srp).
  await page.evaluate(([from, html]) => postMessage({ srp: "morph", from, html, url: "/d/2" }, location.origin),
    [base("body{margin:0}", body, ""), base("body{margin:0}", body + "\n<p>more</p>", "")]);
  c = await drawn();
  ok(c?.length === 1 && await page.evaluate(() => document.body.textContent.includes("more")), "overlay kept through a patch");
  // A page that wipes everything: drawn again on the next update.
  await page.evaluate(() => { document.documentElement.innerHTML = "<head></head><body><p>wiped</p></body>"; });
  await draw([{ id: "abc123", hue: 200, ...ptr }]);
  c = await drawn();
  ok(c?.length === 1, "overlay comes back after the page wipes it");
  // Bad input from a page's own scripts is ignored, not thrown.
  await draw([{ id: "x", p: "<img>", fx: "nope", y: -5 }, null, { id: "" }]);
  c = await drawn();
  ok(c?.length === 1, "junk cursor data handled");
  // Leaving the page reports "gone".
  const gone = page.evaluate(() => new Promise((resolve) => {
    addEventListener("message", (e) => { if (e.data?.gone) resolve(true); });
    setTimeout(() => resolve(false), 2000);
  }));
  await page.mouse.move(-10, -10);
  await page.dispatchEvent("html", "pointerout", { relatedTarget: null, pointerType: "mouse" }).catch(() => {});
  ok(await gone, "leaving reports gone");
}
await browser.close();
srv.close();
process.exit(failed ? 1 : 0);
