// Runs a candidate page in headless Chromium, with the same CSP as the sandbox and all network blocked,
// and reports the JavaScript errors it throws on load and on a little simulated interaction.
// Optional: without playwright-core or a Chromium build, checkPage() returns { skipped: true }.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; " +
  "font-src data:; media-src data:; connect-src 'none'; form-action 'none'; frame-src 'none'; base-uri 'none'";
const URL = "http://check.invalid/";
// The shim every sandbox page gets (window.SITE and friends), so pages are checked as they'll run.
const SHIM = readFileSync(fileURLToPath(new globalThis.URL("./shim.js", import.meta.url)), "utf8").replace("__MAIN_ORIGIN__", "null");
// Made-up window.SITE updates sent during the check, so code that reacts to them runs (and its errors show) before
// the page is published: a busy moment, then an empty one.
const SITE_BUSY = { viewers: 4, version: 12, latest: 12, writing: { text: "make the sky purple", at: Date.now() },
  queue: [{ text: "add a dancing cat", at: 1 }, { text: "more stars", at: 2 }, { text: "a tiny door", at: 3 }],
  recent: [{ text: "add a moon", at: 1 }, { text: "make it rain", at: 2 }], rules: ["Change the title on every edit"],
  lore: ["The cat on the roof is called Biscuit"], era: { n: 2, name: "The Purple Age", at: 1 },
  me: { id: "3fa94c1e", hue: 212, firstSeen: Date.now() - 864e5 * 3, visits: 3, isNew: false, suggested: 2,
    mine: [{ text: "add a moon", version: 11, at: Date.now() - 6e5 }, { text: "a red door", version: 7, at: Date.now() - 864e5 }] },
  people: [{ id: "3fa94c1e", hue: 212, since: Date.now() - 6e5, on: 12, active: true, tabs: 1 },
    { id: "b20d7a55", hue: 117, since: Date.now() - 3e5, on: 12, active: true, tabs: 2 },
    { id: "07c1e9f0", hue: 33, since: Date.now() - 6e4, on: 9, active: false, tabs: 1 },
    { id: "e5a0412b", hue: 301, since: Date.now() - 1e4, on: null, active: false, tabs: 1 }],
  stats: { visitorsToday: 23, visitorsAll: 410, peakToday: 6, peakAll: 19, suggestionsToday: 31, suggestionsAll: 980,
    versions: 12, born: Date.now() - 864e5 * 40 },
  page: { suggestion: "make the sky purple", summary: "Purple sky · Add stars", secs: 41, tokens: 2300, bytes: 18000, at: Date.now() - 6e4 },
  tz: "America/New_York", skew: 1500 };
const SITE_QUIET = { viewers: 1, version: 12, latest: 13, writing: null, queue: [], recent: [], rules: [], lore: [], era: null,
  people: [], page: null };
const sendSite = (data) => window.postMessage({ srp: "site", data }, "*");
// Others' cursors (SITE.cursors, SITE.on("cursors")): two pointers somewhere on the page, then none.
const sendCursors = (list) => window.postMessage({ srp: "cursors", list }, "*");
const CURSORS = [{ id: "c1", v: "b20d7a55", hue: 117, p: "", fx: 0, fy: 0, x: 0.3, y: 200 },
  { id: "c2", v: "07c1e9f0", hue: 33, p: "0", fx: 0.5, fy: 0.5, x: 0.7, y: 420 }];
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
      // No UDP for WebRTC: the CSP doesn't cover it, and routing doesn't see it, so a page could otherwise send STUN
      // packets to any server and reveal this machine's public IP. (With no proxy set, nothing goes out.)
      args: ["--disable-gpu", "--disable-3d-apis", "--force-webrtc-ip-handling-policy=disable_non_proxied_udp"],
      // The server owns shutdown; don't let Playwright swallow signals.
      handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false,
    });
    b.on("disconnected", () => { browserPromise = null; });
    return b;
  })().catch((err) => { browserPromise = null; throw err; });
  return browserPromise;
}

// A stand-in for the server behind SITE.share / SITE.shared / SITE.unshare (see "shared items" in shim.js), so the
// code that draws and erases other visitors' items runs here. A channel starts empty (we can't know what its items
// look like); everything the page shares comes back a moment later as if another visitor had added it (a new key,
// so it gets drawn a second time), and that one is removed a little later as if they'd popped it. The page's own
// removals come back as removals, as from the server.
// Randomness made repeatable, so the old and new page give the same messages run after run: an id or a position
// that changed each run made a problem already on the page look new (#358, #359: five fix-ups for a different
// #bubble-<key> under #lfo-toggle each time; the shim makes the visitor's own item keys with getRandomValues and
// the page placed the bubbles with Math.random). Installed before the shim and the page run.
const SEEDED_RANDOM = `(() => {
  let a = 0x9e3779b9;
  const next = () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  Math.random = next;
  const fill = Crypto.prototype.getRandomValues;
  Crypto.prototype.getRandomValues = function (arr) {
    if (arr instanceof Uint8Array) { for (let i = 0; i < arr.length; i++) arr[i] = Math.floor(next() * 256); return arr; }
    return fill.call(this, arr);
  };
})();`;

const FAKE_SHARED = `(() => {
  // Keys are counted, not random, so the same page gives the same element ids (bubble-k000000001) and the same
  // messages each run: random ones made a problem already on the page look new every time (#358, #359: five
  // fix-ups for a different #bubble-<key> under #lfo-toggle each run).
  let id = 0, n = 0;
  const key = () => "k" + String(++n).padStart(9, "0");
  addEventListener("message", (e) => {
    const d = e.data;
    if (e.source !== window || !d || typeof d.ch !== "string") return;
    if (d.srp === "subscribe") setTimeout(() => postMessage({ srp: "shared", ch: d.ch, items: [] }, "*"), 30);
    else if (d.srp === "share") {
      const k = key(), keep = d.keep !== false;
      setTimeout(() => postMessage({ srp: "shared", ch: d.ch,
        item: { id: keep ? ++id : 0, key: k, by: "b20d7a55", at: Date.now(), data: d.data, mine: false } }, "*"), 120);
      if (keep) setTimeout(() => postMessage({ srp: "shared", ch: d.ch, removed: k }, "*"), 700);
    } else if (d.srp === "unshare") setTimeout(() => postMessage({ srp: "shared", ch: d.ch, removed: d.key }, "*"), 60);
  });
})();`;

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

// Elements the page made clickable (a click/press listener, or an inline onclick) that a visitor can't actually
// click: pointer-events: none (on it or inherited), or another element on top of it. The browser reports no error
// for either, so the model can't tell why "clicking X does nothing" (#283-#288: a frog copied pointer-events:none
// from a decoration, and four suggestions rewrote its sound code instead). Messages are fixed text per element, so
// pages can be compared (one already on the current page doesn't count against an edit).
const RECORD_CLICKABLE = `(() => {
  const els = new Set();
  const types = new Set(["click", "dblclick", "mousedown", "mouseup", "pointerdown", "pointerup", "touchstart", "touchend"]);
  const add = EventTarget.prototype.addEventListener;
  EventTarget.prototype.addEventListener = function (type) {
    if (types.has(type) && this instanceof Element && els.size < 300) els.add(this);
    return add.apply(this, arguments);
  };
  for (const prop of ["onclick", "onmousedown", "onpointerdown", "ontouchstart"]) {
    const d = Object.getOwnPropertyDescriptor(HTMLElement.prototype, prop);
    if (!d?.set) continue;
    Object.defineProperty(HTMLElement.prototype, prop, { ...d, set(v) { if (v && els.size < 300) els.add(this); d.set.call(this, v); } });
  }
  const name = (el) => el.id ? "#" + el.id : "<" + el.tagName.toLowerCase() +
    (typeof el.className === "string" && el.className.trim() ? "." + el.className.trim().split(/\\s+/)[0] : "") + ">";
  Object.defineProperty(window, "__checkClickable", { value: () => {
    const out = [];
    const all = new Set([...els, ...document.querySelectorAll("[onclick],[onmousedown],[onpointerdown],[ontouchstart]")]);
    for (const el of all) {
      if (out.length >= 5) break;
      if (!el.isConnected || el === document.body || el === document.documentElement) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 4 || r.height < 4) continue;
      const cs = getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden" || Number(cs.opacity) === 0) continue;
      const x = r.left + r.width / 2, y = r.top + r.height / 2;
      if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) continue;
      if (cs.pointerEvents === "none") {
        const own = /pointer-events\\s*:\\s*none/i.test(el.getAttribute("style") || "");
        out.push(name(el) + " has a click handler but pointer-events: none" + (own ? " in its style" : " (from its CSS or a parent)") +
          ", so clicks go straight through it and the handler never runs");
        continue;
      }
      const hit = document.elementFromPoint(x, y);
      if (hit && hit !== el && !el.contains(hit) && !hit.contains(el)) {
        out.push(name(el) + " has a click handler but " + name(hit) + " is on top of it, so clicks never reach it" +
          " (give " + name(hit) + " pointer-events: none, or " + name(el) + " a higher z-index)");
      }
    }
    return out;
  } });
  // Centres of the clickable elements a click can reach (up to 8), so the check can click each one: errors in
  // click handlers only show when the handler runs (#295: the frog's sound code called a method that doesn't
  // exist, and the one fixed click at 600,400 never hit the frog). Links are left out (a click would navigate).
  Object.defineProperty(window, "__checkTargets", { value: () => {
    const out = [];
    for (const el of els) {
      if (out.length >= 8) break;
      if (!el.isConnected || el === document.body || el === document.documentElement || el.closest("a[href], form")) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 4 || r.height < 4) continue;
      const x = r.left + r.width / 2, y = r.top + r.height / 2;
      if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) continue;
      const hit = document.elementFromPoint(x, y);
      if (hit && (hit === el || el.contains(hit))) out.push({ x, y });
      // A handler on a container that acts on the child clicked (e.target.closest(".item")): its centre can be a
      // gap between children, which runs nothing (#418, #419: a sequencer's step clicks threw on every click and
      // the check never saw it). So click its first child that a click can reach too.
      for (const c of el.children) {
        if (out.length >= 10) break;
        const cr = c.getBoundingClientRect();
        if (cr.width < 4 || cr.height < 4) continue;
        const cx = cr.left + cr.width / 2, cy = cr.top + cr.height / 2;
        if (cx < 0 || cy < 0 || cx >= innerWidth || cy >= innerHeight) continue;
        if (Math.abs(cx - x) < 1 && Math.abs(cy - y) < 1) break;   // the same spot as the centre click
        const ch = document.elementFromPoint(cx, cy);
        if (ch && (ch === c || c.contains(ch))) { out.push({ x: cx, y: cy }); break; }
      }
    }
    return out;
  } });
})();`;

// CSS animations that silently do nothing: a value a script set that isn't valid CSS (the browser ignores it:
// "bounce 1.5s infinite ease-in-out 2s infinite ease-in-out", #298), or an animation name with no @keyframes
// (#286 deleted the keyframes the visitors danced with, and #298 named nine that never existed). No error either
// way. Messages are fixed text per name/value, so pages can be compared.
const RECORD_ANIMATIONS = `(() => {
  const bad = new Set();
  const supports = CSS.supports.bind(CSS);
  // Chromium's style properties aren't accessors that could be wrapped (they're looked up by name), so these are
  // accessors that do the same through get/setProperty: an invalid value is still ignored, as it would be.
  const { getPropertyValue, setProperty } = CSSStyleDeclaration.prototype;
  for (const [prop, css] of [["animation", "animation"], ["animationName", "animation-name"]]) {
    Object.defineProperty(CSSStyleDeclaration.prototype, prop, { configurable: true, enumerable: true,
      get() { return getPropertyValue.call(this, css); },
      set(v) {
        const s = String(v ?? "").trim();
        if (s && bad.size < 20 && !/var\\(/.test(s) && !supports(css, s)) bad.add(s.slice(0, 100));
        setProperty.call(this, css, v == null ? "" : String(v));
      } });
  }
  Object.defineProperty(window, "__checkAnimations", { value: () => {
    const out = [];
    if (bad.size) out.push('a script sets animation to "' + [...bad][0] + '"' + (bad.size > 1 ? " (and " + (bad.size - 1) +
      " more like it)" : "") + ", which is not valid CSS, so the browser ignores it and nothing moves " +
      "(give each part once: name duration timing-function iteration-count)");
    const names = new Set();
    const walk = (rules) => { for (const r of rules) {
      if (r instanceof CSSKeyframesRule) names.add(r.name);
      else if (r.cssRules) try { walk(r.cssRules); } catch {}
    } };
    for (const sh of document.styleSheets) try { walk(sh.cssRules); } catch {}
    const missing = new Set();
    // Names in the invalid values too: they never got applied, so no element shows them.
    const words = /^(none|infinite|normal|reverse|alternate|alternate-reverse|forwards|backwards|both|running|paused|linear|ease|ease-in|ease-out|ease-in-out|step-start|step-end|initial|inherit|unset|revert)$/i;
    for (const s of bad) for (const part of s.replace(/\\([^)]*\\)/g, "()").split(",")) {
      const n = part.trim().split(/\\s+/).find((t) => /^-?[A-Za-z_][\\w-]*$/.test(t) && !words.test(t));
      if (n && !names.has(n) && missing.size < 5) missing.add(n);
    }
    for (const el of document.getElementsByTagName("*")) {
      const v = getComputedStyle(el).animationName;
      if (!v || v === "none") continue;
      for (const n of v.split(",").map((s) => s.trim().replace(/^"|"$/g, ""))) if (n && n !== "none" && !names.has(n)) missing.add(n);
      if (missing.size >= 5) break;
    }
    for (const n of missing) out.push('the animation "' + n + '" has no @keyframes ' + n + ", so it never plays (add the @keyframes or use an existing one)");
    return out.slice(0, 5);
  } });
})();`;

// Every method and property name of the browser's built-in objects, read from a blank page (never the checked
// one, whose code could change them). For "x.foo is not a function", the closest real name is added to the
// detail for the model (#295: exponentialRampToTimeAtTime, which the model invented, for exponentialRampToValueAtTime).
let apiNames = null;
const API_NAMES = () => {
  const s = new Set();
  const add = (o) => { try { for (const n of Object.getOwnPropertyNames(o)) s.add(n); } catch {} };
  for (const k of Object.getOwnPropertyNames(window)) {
    s.add(k);
    let v;
    try { v = window[k]; } catch { continue; }
    if (typeof v === "function") {
      add(v);
      for (let p = v.prototype; p && p !== Object.prototype; p = Object.getPrototypeOf(p)) add(p);
    } else if (v && typeof v === "object" && k !== "window" && k !== "self" && k !== "globalThis" && k !== "frames") add(v);
  }
  add(Object.prototype);
  return [...s].filter((n) => /^[A-Za-z_$][\w$]*$/.test(n));
};
function distance(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cur = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
  }
  return row[b.length];
}
// "osc.frequency.exponentialRampToTimeAtTime is not a function" → "exponentialRampToValueAtTime". Only for a
// method called on an object, whose name is no built-in at all, and only a close match.
export function didYouMean(msg, names) {
  const m = /\.([A-Za-z_$][\w$]*) is not a function/.exec(msg);
  if (!m || !names?.length || names.includes(m[1])) return null;
  const wrong = m[1], max = Math.max(2, Math.floor(wrong.length / 4));
  let best = null, bestD = max + 1;
  for (const n of names) {
    if (Math.abs(n.length - wrong.length) > max) continue;
    const d = distance(wrong.toLowerCase(), n.toLowerCase());
    if (d < bestD) { best = n; bestD = d; }
  }
  return best;
}

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

// Returns { errors: string[], details: string[], missing: string[], unclickable: string[], animations: string[] } or { skipped: true, reason }.
// unclickable: elements with a click handler that clicks can't reach (not an error: the page works, a feature doesn't).
// animations: CSS animations that can't play (an invalid value set by a script, or no @keyframes); same.
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
  let missing = [], unclickable = [], animations = [];
  let leak = null, suspect = false;
  try {
    const page = await ctx.newPage();
    if (!apiNames) apiNames = await page.evaluate(API_NAMES).catch(() => null);
    await page.addInitScript(SEEDED_RANDOM);
    await page.addInitScript(SHIM);
    await page.addInitScript(FAKE_SHARED);
    await page.addInitScript(RECORD_MISSING);
    await page.addInitScript(RECORD_CLICKABLE);
    await page.addInitScript(RECORD_ANIMATIONS);
    page.on("pageerror", (e) => errors.push(e));
    await serve(ctx, html);
    await page.goto(URL, { waitUntil: "load", timeout: 10_000 }).catch((e) => errors.push(`load: ${e.message.split("\n")[0]}`));
    // A little interaction to run mouse/click/scroll handlers, where many errors hide.
    const step = ms / 5;
    await page.evaluate(sendSite, SITE_BUSY).catch(() => {});
    await page.evaluate(sendCursors, CURSORS).catch(() => {});
    await page.mouse.move(300, 300).catch(() => {});
    await page.waitForTimeout(step);
    await page.mouse.move(700, 500, { steps: 5 }).catch(() => {});
    await page.mouse.click(600, 400).catch(() => {});
    // Then each element with a click handler, where most of a page's interactive code runs.
    const targets = await page.evaluate(() => window.__checkTargets?.() ?? []).catch(() => []);
    for (const t of Array.isArray(targets) ? targets.slice(0, 10) : []) {
      if (!Number.isFinite(t?.x) || !Number.isFinite(t?.y)) continue;
      await page.mouse.click(t.x, t.y).catch(() => {});
      await page.waitForTimeout(40);
    }
    await page.waitForTimeout(step);
    await page.evaluate(sendSite, SITE_QUIET).catch(() => {});
    await page.evaluate(sendCursors, []).catch(() => {});
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
    unclickable = await page.evaluate(() => (window.__checkClickable?.() ?? []).map(String).slice(0, 5)).catch(() => []);
    animations = await page.evaluate(() => (window.__checkAnimations?.() ?? []).map(String).slice(0, 5)).catch(() => []);
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
    const real = didYouMean(msg, apiNames);
    const hint = real ? ` (there is no such built-in method: did you mean ${real}?)` : "";
    seen.set(msg, (code ? `${msg} (line ${m[1]}: ${code})` : msg) + hint);
  }
  // The message is fixed (pages are compared by message, so a leak already on the current page doesn't count
  // against an edit); the rate and where the elements go are only in the details, for the model.
  if (leak && seen.size < 5) seen.set(LEAK, leak);
  return { errors: [...seen.keys()].slice(0, 5), details: [...seen.values()].slice(0, 5),
    missing: missing.filter((s) => typeof s === "string").map((s) => s.slice(0, 80)),
    unclickable: unclickable.filter((s) => typeof s === "string").map((s) => s.slice(0, 240)),
    animations: animations.filter((s) => typeof s === "string").map((s) => s.slice(0, 300)) };
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
    await page.addInitScript(SHIM);
    await page.addInitScript(FAKE_SHARED);
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

// ---------- looks the same? (for the server's cleanup suggestions, which must not change the page's look) ----------

// Like VIRTUAL_TIME, but the same every time: a fixed clock and a seeded Math.random, so two renders of one page
// come out alike and a difference between two pages is theirs.
const FROZEN = VIRTUAL_TIME.replace("start = Date.now()", "start = 1767268800000") + `
(() => { let s = 0x2f6b9a1d; Math.random = () => { s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; })();`;
const LOOK_VIEWPORTS = [{ width: 1200, height: 800 }, { width: 390, height: 844 }];
const LOOK_HEIGHT = 2400;   // how much of a long page is compared

// One frozen render per viewport: { shots: [png Buffer], text } (text: what the page says, whitespace squeezed).
async function snapshot(b, html) {
  const shots = [];
  let text = "";
  for (const viewport of LOOK_VIEWPORTS) {
    const ctx = await b.newContext({ viewport, deviceScaleFactor: 1 });
    try {
      const page = await ctx.newPage();
      await page.addInitScript(FROZEN);
      await page.addInitScript(SHIM);
      await page.addInitScript(FAKE_SHARED);
      await serve(ctx, html);
      await page.goto(URL, { waitUntil: "load", timeout: 10_000 }).catch(() => {});
      await page.evaluate(sendSite, SITE_QUIET).catch(() => {});
      await page.evaluate(() => window.__leakRun?.(3000)).catch(() => {});
      const h = await page.evaluate(() => document.documentElement.scrollHeight).catch(() => viewport.height);
      shots.push(await page.screenshot({ animations: "disabled", caret: "hide", fullPage: true,
        clip: { x: 0, y: 0, width: viewport.width, height: Math.max(viewport.height, Math.min(LOOK_HEIGHT, h || 0)) } }));
      if (!text) text = await page.evaluate(() => document.body?.innerText ?? "").catch(() => "");
    } finally {
      await ctx.close().catch(() => {});
    }
  }
  return { shots, text: text.replace(/\s+/g, " ").trim() };
}

// The share of pixels that differ clearly between two screenshots (1 if their sizes differ), worked out in a blank
// page of the same browser (no image library needed).
async function pixelDiff(b, a, c) {
  const ctx = await b.newContext();
  try {
    const page = await ctx.newPage();
    return await page.evaluate(async ([a, c]) => {
      const load = (src) => new Promise((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = no; i.src = src; });
      const [x, y] = await Promise.all([load(a), load(c)]);
      if (x.width !== y.width || x.height !== y.height) return 1;
      const px = (img) => { const cv = new OffscreenCanvas(img.width, img.height), g = cv.getContext("2d");
        g.drawImage(img, 0, 0); return g.getImageData(0, 0, img.width, img.height).data; };
      const p = px(x), q = px(y);
      let n = 0;
      for (let i = 0; i < p.length; i += 4) {
        if (Math.max(Math.abs(p[i] - q[i]), Math.abs(p[i + 1] - q[i + 1]), Math.abs(p[i + 2] - q[i + 2])) > 40) n++;
      }
      return n / (p.length / 4);
    }, [a, c].map((s) => `data:image/png;base64,${s.toString("base64")}`));
  } finally {
    await ctx.close().catch(() => {});
  }
}

// Does `after` look like `before`? Renders `before` twice to see how much it differs from itself (a page whose
// look depends on things the freeze doesn't cover), and allows that much plus `slack`.
// Returns { same, diff: [share per viewport], noise, text: whether the text matches } or { skipped: true, reason }.
export async function compareLooks(before, after, { slack = 0.001, limit = 40_000 } = {}) {
  let b;
  try { b = await browser(); } catch (err) { return { skipped: true, reason: err.message }; }
  let timer;
  const work = (async () => {
    const [old1, old2, neu] = [await snapshot(b, before), await snapshot(b, before), await snapshot(b, after)];
    const noise = [], diff = [];
    for (let i = 0; i < LOOK_VIEWPORTS.length; i++) {
      noise.push(await pixelDiff(b, old1.shots[i], old2.shots[i]));
      diff.push(await pixelDiff(b, old1.shots[i], neu.shots[i]));
    }
    const text = old1.text === neu.text || old1.text !== old2.text;
    const same = text && diff.every((d, i) => d <= noise[i] + slack);
    return { same, diff, noise, text };
  })();
  const out = new Promise((r) => { timer = setTimeout(() => r({ skipped: true, reason: "took too long" }), limit); });
  try { return await Promise.race([work, out]); }
  catch (err) { return { skipped: true, reason: err.message.split("\n")[0] }; }
  finally { clearTimeout(timer); }
}

// ---------- the favicon (see lib/favicon.mjs) ----------

const ICON_PX = 64;
// Draws a model-written SVG to a 64×64 PNG: scripts off, no network, nothing but inline styles and data: images.
// Returns { png: Buffer } or { error } (also when it comes out blank or a single flat color).
export async function renderIcon(svg, { limit = 15_000 } = {}) {
  let b;
  try { b = await browser(); } catch (err) { return { error: err.message }; }
  if (!/^<svg\b[^>]*\bviewBox=/i.test(svg)) svg = svg.replace(/^<svg\b/i, '<svg viewBox="0 0 32 32"');
  const html = `<!doctype html><style>html,body{margin:0;background:transparent;overflow:hidden}` +
    `svg{display:block;width:${ICON_PX}px!important;height:${ICON_PX}px!important}</style>${svg}`;
  let timer;
  const work = (async () => {
    const ctx = await b.newContext({ viewport: { width: ICON_PX, height: ICON_PX }, deviceScaleFactor: 1, javaScriptEnabled: false });
    let png;
    try {
      await ctx.route("**/*", (route) => route.request().url() === URL
        ? route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: html,
          headers: { "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; img-src data:" } })
        : route.abort());
      const page = await ctx.newPage();
      await page.goto(URL, { waitUntil: "load", timeout: 10_000 });
      png = await page.screenshot({ omitBackground: true, animations: "disabled", clip: { x: 0, y: 0, width: ICON_PX, height: ICON_PX } });
    } finally {
      await ctx.close().catch(() => {});
    }
    // How much of the square it covers and how many colors it uses, worked out in a blank page (our code only).
    const ctx2 = await b.newContext();
    try {
      const page = await ctx2.newPage();
      const { cover, colors } = await page.evaluate(async (src) => {
        const img = new Image();
        await new Promise((ok, no) => { img.onload = ok; img.onerror = no; img.src = src; });
        const cv = new OffscreenCanvas(img.width, img.height), g = cv.getContext("2d");
        g.drawImage(img, 0, 0);
        const p = g.getImageData(0, 0, img.width, img.height).data, seen = new Set();
        let n = 0;
        for (let i = 0; i < p.length; i += 4) {
          if (p[i + 3] < 40) continue;
          n++;
          seen.add(`${p[i] >> 5},${p[i + 1] >> 5},${p[i + 2] >> 5}`);
        }
        return { cover: n / (p.length / 4), colors: seen.size };
      }, `data:image/png;base64,${png.toString("base64")}`);
      if (cover < 0.1) return { error: `it came out nearly empty (${Math.round(cover * 100)}% drawn)` };
      if (colors < 2) return { error: "it came out a single flat color" };
      return { png };
    } finally {
      await ctx2.close().catch(() => {});
    }
  })();
  const out = new Promise((r) => { timer = setTimeout(() => r({ error: "took too long" }), limit); });
  try { return await Promise.race([work, out]); }
  catch (err) { return { error: err.message.split("\n")[0] }; }
  finally { clearTimeout(timer); }
}
