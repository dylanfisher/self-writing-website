// Loads a page from the sandbox and reports how many visible elements it has over time, with screenshots.
//   node scripts/watch-page.mjs <url> <outdir>
import { chromium } from "playwright-core";
import { findChromium } from "../lib/check.mjs";
const [url, out] = process.argv.slice(2);
const b = await chromium.launch({ executablePath: findChromium(chromium) });
const p = await b.newPage({ viewport: { width: 1200, height: 800 } });
p.on("pageerror", (e) => console.log("pageerror", e.message));
await p.goto(url);
for (const t of [1, 4, 7, 10]) {
  await p.waitForTimeout(t === 1 ? 1000 : 3000);
  const n = await p.evaluate(() => [...document.body.querySelectorAll("*")].filter((e) => {
    const r = e.getBoundingClientRect(), s = getComputedStyle(e);
    return r.width && r.height && s.visibility !== "hidden" && +s.opacity > 0.05 && s.display !== "none";
  }).length);
  console.log(`${t}s: ${n} visible elements`);
  await p.screenshot({ path: `${out}/t${t}.png` });
}
await b.close();
