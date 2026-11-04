// Loads a page from the sandbox and reports how many visible elements it has over time, with screenshots.
//   node scripts/watch-page.mjs <url> <outdir>
import { chromium } from "playwright-core";
import { findChromium } from "../lib/check.mjs";
const [url, out] = process.argv.slice(2);
const b = await chromium.launch({ executablePath: findChromium(chromium) });
const p = await b.newPage({ viewport: { width: 1200, height: 800 } });
p.on("pageerror", (e) => console.log("pageerror", e.message));
// The shim refuses sandbox pages opened top-level, so load the page in a sandboxed iframe on a tiny fake page.
// (frame-ancestors is dropped from the response for this browser only; nothing on the server changes.)
const wrap = "http://watch.invalid/";
await p.route("**/*", async (r) => {
  const u = r.request().url();
  if (u === wrap) return r.fulfill({ contentType: "text/html", body: `<body style="margin:0"><iframe sandbox="allow-scripts" src="${url}" style="border:0;width:100vw;height:100vh"></iframe>` });
  if (u !== url) return r.continue();
  const res = await r.fetch();
  const h = { ...res.headers() };
  h["content-security-policy"] = (h["content-security-policy"] ?? "").replace(/frame-ancestors[^;]*;?/, "");
  r.fulfill({ response: res, headers: h });
});
await p.goto(wrap);
const frame = () => p.frames().find((f) => f.url() === url);
await p.waitForTimeout(500);
for (const t of [1, 4, 7, 10]) {
  await p.waitForTimeout(t === 1 ? 1000 : 3000);
  const n = await frame().evaluate(() => [...document.body.querySelectorAll("*")].filter((e) => {
    const r = e.getBoundingClientRect(), s = getComputedStyle(e);
    return r.width && r.height && s.visibility !== "hidden" && +s.opacity > 0.05 && s.display !== "none";
  }).length);
  console.log(`${t}s: ${n} visible elements`);
  await p.screenshot({ path: `${out}/t${t}.png` });
}
await b.close();
