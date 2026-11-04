// Runs a candidate page in headless Chromium, with the same CSP as the sandbox and all network blocked,
// and reports the JavaScript errors it throws on load and on a little simulated interaction.
// Optional: without playwright-core or a Chromium build, checkPage() returns { skipped: true }.

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; " +
  "font-src data:; media-src data:; connect-src 'none'; form-action 'none'; frame-src 'none'; base-uri 'none'";
const URL = "http://check.invalid/";
const BG_WRAPPER = fileURLToPath(new globalThis.URL("./chromium-bg.sh", import.meta.url));

// The Chromium build that matches the installed playwright-core (never an older one left in the cache, since
// this browser runs untrusted code). Prefers the lighter headless shell of the same revision.
// Update both with: npm install playwright-core@latest && npx playwright-core install chromium
export function findChromium(chromium) {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const full = chromium.executablePath();
  const m = /[\\/]ms-playwright[\\/]chromium-(\d+)[\\/]/.exec(full);
  if (m) {
    const dir = join(full.slice(0, m.index), "ms-playwright", `chromium_headless_shell-${m[1]}`);
    if (existsSync(dir)) {
      for (const sub of readdirSync(dir)) {
        const p = join(dir, sub, "chrome-headless-shell");
        if (existsSync(p)) return p;
      }
    }
  }
  return existsSync(full) ? full : null;
}

let browserPromise = null;
async function browser() {
  browserPromise ??= (async () => {
    const { chromium } = await import("playwright-core");
    const realPath = findChromium(chromium);
    if (!realPath) throw new Error("no Chromium found (run: npx playwright-core install chromium)");
    // On macOS, launch through taskpolicy -b so checked pages only get leftover CPU (see chromium-bg.sh).
    const bg = process.platform === "darwin" && existsSync("/usr/sbin/taskpolicy");
    const executablePath = bg ? BG_WRAPPER : realPath;
    const b = await chromium.launch({
      executablePath,
      env: bg ? { ...process.env, CHECK_CHROMIUM: realPath } : process.env,
      headless: true,
      // No GPU: pages can't use WebGL/WebGPU to compete with the model for the GPU.
      args: ["--disable-gpu", "--disable-3d-apis"],
      // The server owns shutdown; don't let Playwright swallow signals.
      handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false,
    });
    b.on("disconnected", () => { browserPromise = null; });
    return b;
  })().catch((err) => { browserPromise = null; throw err; });
  return browserPromise;
}

// Records element lookups that came back empty (getElementById / querySelector), so a "Cannot read properties of
// null" error can be explained with every missing element at once, not just the first one a script hit.
const RECORD_MISSING = `(() => {
  const missing = new Set();
  const wrap = (proto, name, show) => {
    const orig = proto[name];
    proto[name] = function (arg) { const r = orig.apply(this, arguments); if (r == null && missing.size < 20) missing.add(show(String(arg))); return r; };
  };
  wrap(Document.prototype, "getElementById", (id) => "#" + id);
  wrap(Document.prototype, "querySelector", (s) => s);
  wrap(Element.prototype, "querySelector", (s) => s);
  Object.defineProperty(window, "__checkMissing", { value: () => [...missing] });
})();`;

// Element leaks, in two steps. Suspect: the element count rises at each of 3 samples over the last ~1.5 s of the
// run, by at least LEAK_MIN in total (pages without a leak stay flat; a leaking one, at the check's low CPU
// priority, adds only ~4-8 a second, since painting what it added slows its own timers). Confirm (only then):
// load the page again with VIRTUAL_TIME and fast-forward its timers LEAK_SECONDS; it leaks if that adds at least
// LEAK_PER_SEC a second. That tells a cap or cleanup that hasn't kicked in yet (keep the last 40 dots, remove
// critters after 4 s) from real growth, which 2.5 s of real time can't. Usually well under a second.
const LEAK = "the page keeps adding elements and never removes them, so it gets slower the longer it is open";
const LEAK_MIN = 6;
const LEAK_SECONDS = 30;
const LEAK_PER_SEC = 5;
const LEAK_CONFIRM_MS = 4000;
// Replaces the page's timers and clocks with virtual ones that only run when __leakRun(ms) is called, which runs
// every callback due in the next ms of virtual time in one synchronous loop. (Playwright's page.clock does the
// same from outside, one round-trip per callback: 20x slower than real time at the check's background priority.)
// Stops early after MAX callbacks or WALL ms of real time and returns false, so a busy page can't hang the check.
const VIRTUAL_TIME = `(() => {
  const MAX = 20000, WALL = 1500, realNow = performance.now.bind(performance), start = Date.now();
  let now = 0, seq = 0, nextId = 1;
  const timers = new Map();
  const add = (fn, ms, every, args) => {
    const id = nextId++;
    if (typeof fn === "function") timers.set(id, { fn, at: now + Math.max(0, +ms || 0), every, args, seq: seq++ });
    return id;
  };
  window.setTimeout = (fn, ms, ...a) => add(fn, ms, 0, a);
  window.setInterval = (fn, ms, ...a) => add(fn, ms, Math.max(1, +ms || 0), a);
  window.clearTimeout = window.clearInterval = (id) => { timers.delete(id); };
  window.requestAnimationFrame = (fn) => add(() => fn(now), 16 - (now % 16) || 16, 0, []);
  window.cancelAnimationFrame = window.clearTimeout;
  Date.now = () => start + now;
  performance.now = () => now;
  Object.defineProperty(window, "__leakRun", { value: (ms) => {
    const end = now + ms, t0 = realNow();
    for (let n = 0; ; n++) {
      if (n >= MAX || realNow() - t0 > WALL) return false;
      let id = null, t = null;
      for (const [k, v] of timers) if (!t || v.at < t.at || (v.at === t.at && v.seq < t.seq)) { id = k; t = v; }
      if (!t || t.at > end) break;
      now = t.at;
      if (t.every) { t.at += t.every; t.seq = seq++; } else timers.delete(id);
      try { t.fn(...t.args); } catch {}
    }
    now = end;
    return true;
  } });
})();`;
// Remembers which elements exist now, so NEW_ELEMENTS can say where the added ones went.
const MARK_ELEMENTS = () => {
  const all = document.getElementsByTagName("*");
  Object.defineProperty(window, "__checkOld", { value: new WeakSet(all), configurable: true });
  return all.length;
};
// The most common "parent > tag" among elements added since MARK_ELEMENTS, e.g. "body > div (36 added)".
const NEW_ELEMENTS = () => {
  const old = window.__checkOld, by = new Map();
  if (!old) return null;
  for (const el of document.getElementsByTagName("*")) {
    if (old.has(el)) continue;
    const p = el.parentElement;
    const k = `${p ? (p.id ? `#${p.id}` : p.tagName.toLowerCase()) : "?"} > ${el.tagName.toLowerCase()}`;
    by.set(k, (by.get(k) ?? 0) + 1);
  }
  const [k, n] = [...by].sort((a, b) => b[1] - a[1])[0] ?? [];
  return k ? `${k} (${n} added)`.slice(0, 80) : null;
};

// Returns { errors: string[], details: string[], missing: string[] } or { skipped: true, reason }.
// A page that freezes (e.g. an infinite loop) counts as an error; the browser is killed and relaunched next time.
export async function checkPage(html, { ms = 2500, limit = 12_000 } = {}) {
  let b;
  try { b = await browser(); } catch (err) { return { skipped: true, reason: err.message }; }
  let timer;
  const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve("froze"), limit); });
  const result = await Promise.race([run(b, html, ms), timeout]);
  clearTimeout(timer);
  if (result !== "froze") return result;
  browserPromise = null;
  const proc = b.process?.();
  await Promise.race([b.close(), new Promise((r) => setTimeout(r, 2000))]).catch(() => {});
  proc?.kill("SIGKILL");
  const froze = "the page froze (an endless loop?) and never finished running";
  return { errors: [froze], details: [froze] };
}

async function run(b, html, ms) {
  const ctx = await b.newContext({ viewport: { width: 1200, height: 800 }, javaScriptEnabled: true });
  const errors = [];
  let missing = [];
  let leak = null, suspect = false;
  try {
    const page = await ctx.newPage();
    await page.addInitScript(RECORD_MISSING);
    page.on("pageerror", (e) => errors.push(e));
    await serve(ctx, html);
    await page.goto(URL, { waitUntil: "load", timeout: 10_000 }).catch((e) => errors.push(`load: ${e.message.split("\n")[0]}`));
    // A little interaction to run mouse/click/scroll handlers, where many errors hide.
    const step = ms / 5;
    await page.mouse.move(300, 300).catch(() => {});
    await page.waitForTimeout(step);
    await page.mouse.move(700, 500, { steps: 5 }).catch(() => {});
    await page.mouse.click(600, 400).catch(() => {});
    await page.waitForTimeout(step);
    await page.mouse.wheel(0, 600).catch(() => {});
    await page.keyboard.press("Space").catch(() => {});
    // Leak watch during the last part of the run (no extra time): a page whose element count rises at every
    // sample keeps adding elements without removing them, and slows down the longer it stays open.
    const counts = [await page.evaluate(MARK_ELEMENTS).catch(() => null)];
    for (let i = 0; i < 3; i++) {
      await page.waitForTimeout(step);
      counts.push(await page.evaluate(() => document.getElementsByTagName("*").length).catch(() => null));
    }
    suspect = counts.every((n) => n != null) && counts.every((n, i) => i === 0 || n > counts[i - 1]) &&
      counts[3] - counts[0] >= LEAK_MIN;
    // The page's own code could tamper with this; it's only ever a hint for the model.
    missing = await page.evaluate(() => (window.__checkMissing?.() ?? []).map(String).slice(0, 20)).catch(() => []);
  } catch (err) {
    errors.push(`check: ${err.message.split("\n")[0]}`);
  } finally {
    await ctx.close().catch(() => {});
  }
  if (suspect) leak = await confirmLeak(b, html);
  // errors: messages (stable, used to compare pages). details: message plus the failing line, for the model.
  const lines = html.split("\n");
  const seen = new Map();
  for (const e of errors) {
    const msg = typeof e === "string" ? e : e.message;
    if (seen.has(msg)) continue;
    const m = typeof e === "string" ? null : /check\.invalid\/:(\d+):\d+/.exec(e.stack ?? "");
    const code = m && lines[Number(m[1]) - 1]?.trim().slice(0, 200);
    seen.set(msg, code ? `${msg} (line ${m[1]}: ${code})` : msg);
  }
  // The message is fixed (pages are compared by message, so a leak already on the current page doesn't count
  // against an edit); the rate and where the elements go are only in the details, for the model.
  if (leak && seen.size < 5) seen.set(LEAK, leak);
  return { errors: [...seen.keys()].slice(0, 5), details: [...seen.values()].slice(0, 5),
    missing: missing.filter((s) => typeof s === "string").map((s) => s.slice(0, 80)) };
}

// Serves the page ourselves and refuses everything else, so the check never touches the network.
function serve(ctx, html) {
  return ctx.route("**/*", (route) => {
    if (route.request().url() === URL) {
      return route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", headers: { "Content-Security-Policy": CSP }, body: html });
    }
    return route.abort();
  });
}

// Loads the page with virtual time and runs its timers (and animation frames) LEAK_SECONDS ahead. Returns the
// detail line for the model if elements kept piling up, null if not or if it can't tell in time.
async function confirmLeak(b, html) {
  const ctx = await b.newContext({ viewport: { width: 1200, height: 800 } });
  let timer;
  try {
    const page = await ctx.newPage();
    await page.addInitScript(VIRTUAL_TIME);
    await serve(ctx, html);
    const go = (async () => {
      await page.goto(URL, { waitUntil: "load", timeout: LEAK_CONFIRM_MS });
      if (!(await page.evaluate(() => window.__leakRun(2000)))) return null;
      const before = await page.evaluate(MARK_ELEMENTS);
      if (!(await page.evaluate((ms) => window.__leakRun(ms), LEAK_SECONDS * 1000))) return null;
      const after = await page.evaluate(() => document.getElementsByTagName("*").length);
      const perSec = Math.round((after - before) / LEAK_SECONDS);
      if (perSec < LEAK_PER_SEC) return null;
      const where = await page.evaluate(NEW_ELEMENTS).catch(() => null);
      return `${LEAK} (${after - before} more elements after ${LEAK_SECONDS} s, about ${perSec} a second` +
        `${where ? `, mostly ${where}` : ""}): remove old ones or keep only a fixed number`;
    })();
    const out = new Promise((r) => { timer = setTimeout(() => r(null), LEAK_CONFIRM_MS); });
    return await Promise.race([go, out]).catch(() => null);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    await ctx.close().catch(() => {});
  }
}

export async function closeChecker() {
  if (browserPromise) (await browserPromise.catch(() => null))?.close();
}
