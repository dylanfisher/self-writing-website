// Profiles a page: fps per frame, long tasks, DOM size, and the hottest JS functions (CPU profile).
//   node scripts/profile-page.mjs [url] [seconds]
import { chromium } from "playwright-core";
import { findChromium } from "../lib/check.mjs";
const url = process.argv[2] ?? "http://localhost:3000";
const secs = Number(process.argv[3] ?? 6);
const b = await chromium.launch({ executablePath: findChromium(chromium), args: ["--enable-gpu"] });
const p = await b.newPage({ viewport: { width: 1400, height: 900 } });
p.on("pageerror", (e) => console.log("pageerror", e.message));
await p.goto(url);
await p.waitForTimeout(3000);
const cdp = await p.context().newCDPSession(p);
await cdp.send("Profiler.enable");
await cdp.send("Profiler.setSamplingInterval", { interval: 500 });
await cdp.send("Profiler.start");
const probe = (s) => new Promise((res) => {
  let n = 0, worst = 0, last = performance.now(), long = 0, longMs = 0;
  try { new PerformanceObserver((l) => l.getEntries().forEach((e) => { long++; longMs += e.duration; })).observe({ type: "longtask" }); } catch {}
  const t0 = last;
  const f = (t) => { n++; worst = Math.max(worst, t - last); last = t; if (t - t0 < s * 1000) requestAnimationFrame(f); else res({ fps: +(n / s).toFixed(1), worstFrameMs: Math.round(worst), longTasks: long, longTaskMs: Math.round(longMs), elements: document.querySelectorAll("*").length, animations: document.getAnimations?.().length }); };
  requestAnimationFrame(f);
});
const results = await Promise.all(p.frames().map(async (fr) => ({ frame: fr.url().slice(0, 70), ...(await fr.evaluate(probe, secs).catch((e) => ({ err: e.message.slice(0, 80) }))) })));
const { profile } = await cdp.send("Profiler.stop");
const m = await cdp.send("Performance.enable").then(() => cdp.send("Performance.getMetrics"));
console.table(results);
const pick = ["JSHeapUsedSize", "Nodes", "LayoutCount", "RecalcStyleCount", "LayoutDuration", "RecalcStyleDuration", "ScriptDuration", "TaskDuration"];
console.log(Object.fromEntries(m.metrics.filter((x) => pick.includes(x.name)).map((x) => [x.name, +x.value.toFixed(2)])));
// self time per function
const dt = {}; const ids = profile.samples; const deltas = profile.timeDeltas;
ids.forEach((id, i) => (dt[id] = (dt[id] ?? 0) + deltas[i]));
const byFn = {};
for (const n of profile.nodes) {
  const cf = n.callFrame; const k = `${cf.functionName || "(anon)"}  ${cf.url.split("/").slice(-2).join("/")}:${cf.lineNumber + 1}`;
  byFn[k] = (byFn[k] ?? 0) + (dt[n.id] ?? 0) / 1000;
}
const total = Object.values(byFn).reduce((a, c) => a + c, 0);
console.log(`\nTop self-time (ms over ${secs}s, total ${Math.round(total)}):`);
Object.entries(byFn).sort((a, c) => c[1] - a[1]).slice(0, 20).forEach(([k, v]) => console.log(String(Math.round(v)).padStart(7), k));
await b.close();
