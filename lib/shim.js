// Added to every page the sandbox serves (inlined by server.mjs, never stored with the page). Runs first in <head>.
// The server fills in the site's origin (ORIGIN below) when it starts.
(() => {
  // Sandboxed pages have no storage and throw on localStorage access, which kills the page's whole script;
  // give them an in-memory stand-in instead.
  const mk = () => {
    const m = new Map();
    return { getItem: (k) => m.has(String(k)) ? m.get(String(k)) : null, setItem: (k, v) => { m.set(String(k), String(v)); },
      removeItem: (k) => { m.delete(String(k)); }, clear: () => m.clear(), key: (i) => [...m.keys()][i] ?? null,
      get length() { return m.size; } };
  };
  for (const n of ["localStorage", "sessionStorage"]) {
    try { window[n]; } catch { try { Object.defineProperty(window, n, { value: mk(), configurable: true }); } catch {} }
  }

  const ORIGIN = __MAIN_ORIGIN__;

  // ---------- window.SITE: live facts about the site, for the page's own scripts ----------
  // Read-only and public (only what the shell page already shows anyone). The parent sends { srp: "site", data }
  // when the frame loads and whenever something changes; until then SITE holds safe defaults, so a page can read
  // it at any time. Listeners: SITE.on("change", fn), called with SITE after each update. Visitor text in here
  // (suggestions, rules) is shown by page scripts however they like: it's model territory, inside the sandbox.
  const listeners = new Set();
  const data = { viewers: 1, version: 0, latest: 0, old: false, draft: false, writing: null, queue: [],
    recent: [], rules: [], lore: [], era: null, updated: 0 };
  const str = (s, n) => String(s ?? "").slice(0, n);
  const num = (n) => Number.isFinite(+n) ? Math.max(0, Math.floor(+n)) : 0;
  const texts = (a, n) => (Array.isArray(a) ? a : []).slice(0, n)
    .map((x) => Object.freeze({ text: str(x?.text, 300), at: num(x?.at) }));
  function setSite(d) {
    if (!d || typeof d !== "object") return;
    data.viewers = Math.max(1, num(d.viewers));
    data.version = num(d.version);
    data.latest = Math.max(data.version, num(d.latest));
    data.draft = d.draft === true;
    data.old = !data.draft && data.version < data.latest;
    data.writing = d.writing ? Object.freeze({ text: str(d.writing.text, 300), at: num(d.writing.at) }) : null;
    data.queue = Object.freeze(texts(d.queue, 100));
    data.recent = Object.freeze(texts(d.recent, 20));
    data.rules = Object.freeze((Array.isArray(d.rules) ? d.rules : []).slice(0, 10).map((r) => str(r, 300)));
    data.lore = Object.freeze((Array.isArray(d.lore) ? d.lore : []).slice(0, 30).map((r) => str(r, 300)));
    data.era = d.era ? Object.freeze({ n: Math.max(1, num(d.era.n)), name: d.era.name ? str(d.era.name, 100) : null, at: num(d.era.at) }) : null;
    data.updated = Date.now();
    for (const fn of [...listeners]) {
      // One broken listener must not stop the others; its error still shows (and the check still sees it).
      try { fn(SITE); } catch (err) { try { reportError(err); } catch { setTimeout(() => { throw err; }); } }
    }
  }
  const SITE = {};
  for (const k of Object.keys(data)) Object.defineProperty(SITE, k, { get: () => data[k], enumerable: true });
  SITE.on = (type, fn) => { if (typeof fn === "function" && listeners.size < 100) listeners.add(fn); };
  SITE.off = (type, fn) => { listeners.delete(fn); };
  Object.freeze(SITE);
  // Configurable, so a page that declares its own `let SITE` still runs.
  Object.defineProperty(window, "SITE", { value: SITE, writable: true, configurable: true });
  addEventListener("message", (e) => {
    // From the shell page, or (in the page check, where this page is the top window) from the check itself.
    if (e.source !== parent || e.data?.srp !== "site" || (e.origin !== ORIGIN && parent !== window)) return;
    setSite(e.data.data);
  });

  // ---------- live drafts: patch the page in place instead of reloading it ----------
  // The parent sends { srp: "morph", from, html, url }: `from` is the source this page was loaded from (or last
  // patched to), `html` the next draft. Comparing the two sources, not the live DOM, finds what the edit changed,
  // and only that is changed on the live page, so whatever the page's own scripts built or moved stays as it is.
  // Changed scripts can't be patched in (they'd have to run again), so then, or if anything doesn't line up, the
  // page loads `url` instead. Replies { srp: "morphed", exact } (false when scripts might have set up the patched
  // markup differently on a real load) or { srp: "morphed", failed: true } just before loading.
  const parse = (h) => new DOMParser().parseFromString(h, "text/html");
  const ours = (n) => n.nodeType === 1 && n.hasAttribute("data-srp");
  const kids = (n) => [...n.childNodes].filter((c) => (c.nodeType === 1 || c.nodeType === 3) && !ours(c));
  const key = (n) => n.nodeType === 1 ? n.outerHTML : "#" + n.data;
  const same = (a, b) => a.nodeName === b.nodeName && (a.nodeType !== 1 || a.id === b.id);
  const scripts = (d) => [...d.querySelectorAll("script")].filter((s) => !ours(s)).map((s) => s.outerHTML).join("\0");

  // The live nodes that came from the source children `a`, in order, skipping nodes scripts added. null if some
  // can't be found.
  function live(a, l) {
    const lk = kids(l), out = [];
    let j = 0;
    for (const n of a) {
      while (j < lk.length && !same(n, lk[j])) j++;
      if (j === lk.length) return null;
      out.push(lk[j++]);
    }
    return out;
  }
  function attrs(a, b, l) {
    for (const { name, value } of b.attributes) if (a.getAttribute(name) !== value) l.setAttribute(name, value);
    for (const { name } of a.attributes) if (!b.hasAttribute(name)) l.removeAttribute(name);
  }
  // Longest common subsequence of two key lists, as steps: [keep, i, j] | [del, i] | [add, j].
  function align(ak, bk) {
    const n = ak.length, m = bk.length;
    if (n * m > 250_000) return null;
    const t = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--)
      t[i][j] = ak[i] === bk[j] ? t[i + 1][j + 1] + 1 : Math.max(t[i + 1][j], t[i][j + 1]);
    const ops = [];
    for (let i = 0, j = 0; i < n || j < m; ) {
      if (i < n && j < m && ak[i] === bk[j]) ops.push(["keep", i++, j++]);
      else if (i < n && (j === m || t[i + 1][j] >= t[i][j + 1])) ops.push(["del", i++]);
      else ops.push(["add", j++]);
    }
    return ops;
  }
  // Makes live node l (which came from source a) match source b. false if it can't.
  function morph(a, b, l) {
    if (key(a) === key(b)) return true;
    if (a.nodeType === 3) { l.data = b.data; return true; }
    attrs(a, b, l);
    if (/^(STYLE|TITLE|TEXTAREA)$/.test(a.nodeName)) { l.textContent = b.textContent; return true; }
    const ak = kids(a), bk = kids(b), lk = live(ak, l);
    const ops = lk && align(ak.map(key), bk.map(key));
    if (!ops) return false;
    let prev = null;   // the live node the next one goes after (null: first in l)
    const put = (n) => { if (prev) prev.after(n); else l.prepend(n); prev = n; };
    for (let k = 0; k < ops.length; ) {
      if (ops[k][0] === "keep") { prev = lk[ops[k][1]]; k++; continue; }
      // A run of deletions and additions: pair them up in order, so a changed element is patched, not replaced.
      const dels = [], adds = [];
      for (; k < ops.length && ops[k][0] !== "keep"; k++) (ops[k][0] === "del" ? dels : adds).push(ops[k][1]);
      for (let x = 0; x < Math.max(dels.length, adds.length); x++) {
        const i = dels[x], j = adds[x];
        if (i !== undefined && j !== undefined && same(ak[i], bk[j])) {
          if (!morph(ak[i], bk[j], lk[i])) return false;
          prev = lk[i];
        } else {
          if (i !== undefined) lk[i].remove();
          if (j !== undefined) put(document.importNode(bk[j], true));
        }
      }
    }
    return true;
  }
  function patch(from, html) {
    const A = parse(from), B = parse(html);
    if (scripts(A) !== scripts(B)) return null;
    attrs(A.documentElement, B.documentElement, document.documentElement);
    if (!morph(A.head, B.head, document.head)) return null;
    const bodyChanged = key(A.body) !== key(B.body);
    if (!morph(A.body, B.body, document.body)) return null;
    // Scripts may have set up the old markup when the page loaded (handlers, positions); new markup missed that.
    return { exact: !bodyChanged || !scripts(B) };
  }
  addEventListener("message", (e) => {
    const d = e.data;
    if (e.source !== parent || e.origin !== ORIGIN || d?.srp !== "morph") return;
    let r = null;
    try { r = patch(String(d.from), String(d.html)); } catch {}
    if (r) return parent.postMessage({ srp: "morphed", exact: r.exact }, ORIGIN);
    parent.postMessage({ srp: "morphed", failed: true }, ORIGIN);
    const u = new URL(String(d.url), location.href);
    if (u.host === location.host && /^\/[dv]\/\d+$/.test(u.pathname)) location.replace(u.href);
  });

  // ---------- other visitors' cursors ----------
  // Pages reflow differently on every screen, so a position is sent relative to the element under the pointer:
  // its path from <body> (child indexes, skipping our nodes) and where in its box the pointer is, plus a fallback
  // (x as a fraction of the page width, y in page pixels) for when that element isn't found. The parent relays
  // ours to the server ({ srp: "pointer" }) and sends back the others on this page ({ srp: "cursors" }).
  const els = (n) => [...n.children].filter((c) => !ours(c));
  const clamp01 = (n) => Math.min(1, Math.max(0, Number.isFinite(+n) ? +n : 0));
  const r3 = (n) => Math.round(n * 1000) / 1000;
  function pathOf(el) {
    const p = [];
    for (let n = el; n && n !== document.body && p.length < 40; n = n.parentElement) {
      const up = n.parentElement;
      if (!up) return null;
      p.unshift(els(up).indexOf(n));
    }
    return p.join(".");
  }
  function byPath(p) {
    let n = document.body;
    for (const i of p ? p.split(".") : []) { n = n && els(n)[+i]; if (!n) return null; }
    return n;
  }
  let lastSent = 0, pending = null, sendTimer = null;
  const flush = () => { sendTimer = null; lastSent = Date.now(); parent.postMessage({ srp: "pointer", ...pending }, ORIGIN); };
  function sendPointer(d) {
    pending = d;
    if (!sendTimer) sendTimer = setTimeout(flush, Math.max(0, 100 - (Date.now() - lastSent)));
  }
  addEventListener("pointermove", (e) => {
    if (e.pointerType === "touch" || !document.body || !e.isTrusted) return;
    const el = e.target instanceof Element && document.body.contains(e.target) ? e.target : null;
    const p = el && pathOf(el);
    const r = el?.getBoundingClientRect();
    const de = document.documentElement;
    sendPointer({
      p: p ?? "", fx: r && r.width ? r3(clamp01((e.clientX - r.left) / r.width)) : 0,
      fy: r && r.height ? r3(clamp01((e.clientY - r.top) / r.height)) : 0,
      x: r3(clamp01((e.clientX + scrollX) / Math.max(1, de.clientWidth))), y: Math.round(Math.max(0, e.clientY + scrollY)),
    });
  }, { passive: true, capture: true });
  // Leaving the frame (into the shell page or out of the window).
  addEventListener("pointerout", (e) => { if (!e.relatedTarget && e.pointerType !== "touch") sendPointer({ gone: true }); });
  addEventListener("blur", () => sendPointer({ gone: true }));

  // The overlay: one element of ours (data-srp, so live-draft patching leaves it alone) holding a shadow root,
  // so the page's CSS can't reach the cursors inside. Fixed to the viewport; positions are recomputed every frame
  // from the elements, so they follow scrolling, layout changes and animations. Shown cursors glide to new spots.
  let host = null, root = null;
  const cursors = new Map();   // id → { el, target, x, y, seen }
  function overlay() {
    if (host?.isConnected) return root;
    host = document.createElement("srp-cursors");
    host.setAttribute("data-srp", "");
    host.setAttribute("aria-hidden", "true");
    for (const [k, v] of Object.entries({ position: "fixed", inset: "0", width: "auto", height: "auto", margin: "0",
      padding: "0", border: "0", "pointer-events": "none", "z-index": "2147483647", overflow: "hidden", display: "block",
      transform: "none", opacity: "1", visibility: "visible", contain: "strict" })) host.style.setProperty(k, v, "important");
    // A new root each time: a page that wiped the old host (innerHTML on <html>) took its root with it.
    root = host.attachShadow({ mode: "closed" });
    const st = document.createElement("style");
    st.textContent = `.c{position:absolute;left:0;top:0;width:16px;height:20px;will-change:transform;
      transition:opacity .4s;filter:drop-shadow(0 1px 1.5px rgba(0,0,0,.35))}.c.gone{opacity:0}`;
    root.append(st, ...[...cursors.values()].map((c) => c.el));
    document.documentElement.append(host);
    return root;
  }
  function arrow(hue) {
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", "0 0 16 20");
    svg.setAttribute("class", "c");
    const path = document.createElementNS(ns, "path");
    path.setAttribute("d", "M1 1 L1 16 L5 12.5 L8 19 L10.5 18 L7.6 11.6 L13 11.6 Z");
    path.setAttribute("fill", `hsl(${hue} 75% 52%)`);
    path.setAttribute("stroke", "#fff");
    path.setAttribute("stroke-width", "1.4");
    path.setAttribute("stroke-linejoin", "round");
    svg.append(path);
    return svg;
  }
  function where(t) {
    const el = t.p !== "" ? byPath(t.p) : null;
    if (el) { const r = el.getBoundingClientRect(); if (r.width || r.height) return [r.left + t.fx * r.width, r.top + t.fy * r.height]; }
    return [t.x * document.documentElement.clientWidth - scrollX, t.y - scrollY];
  }
  let raf = 0;
  function frame() {
    raf = 0;
    let moving = false;
    for (const [id, c] of cursors) {
      if (!c.target) {   // left: fade out, then drop
        if (!c.el.classList.contains("gone")) { c.el.classList.add("gone"); setTimeout(() => { if (!cursors.get(id)?.target) { c.el.remove(); cursors.delete(id); } }, 450); }
        continue;
      }
      const [tx, ty] = where(c.target);
      if (c.x === null) { c.x = tx; c.y = ty; }
      c.x += (tx - c.x) * 0.3; c.y += (ty - c.y) * 0.3;
      if (Math.abs(tx - c.x) > 0.3 || Math.abs(ty - c.y) > 0.3) moving = true;
      c.el.style.transform = `translate(${c.x.toFixed(1)}px,${c.y.toFixed(1)}px)`;
    }
    // Keep following while anything glides; otherwise only on scroll, resize or a new update (below).
    if (moving) tick();
  }
  const tick = () => { if (!raf && cursors.size) raf = requestAnimationFrame(frame); };
  addEventListener("scroll", tick, { passive: true, capture: true });
  addEventListener("resize", tick);
  setInterval(tick, 500);   // the page's own scripts may move things around
  function setCursors(list) {
    if (!document.body) return;
    const r = overlay();
    const now = new Set();
    for (const c of (Array.isArray(list) ? list : []).slice(0, 50)) {
      const id = String(c?.id ?? "").slice(0, 32);
      if (!id || now.has(id)) continue;
      now.add(id);
      const t = { p: /^\d{1,4}(\.\d{1,4}){0,39}$/.test(c.p) ? c.p : "", fx: clamp01(c.fx), fy: clamp01(c.fy),
        x: clamp01(c.x), y: Math.max(0, Math.min(1e6, Number(c.y) || 0)) };
      let k = cursors.get(id);
      if (!k) {
        k = { el: arrow(Math.max(0, Math.min(359, Math.floor(Number(c.hue) || 0)))), x: null, y: null };
        cursors.set(id, k);
        r.append(k.el);
      }
      k.el.classList.remove("gone");
      k.target = t;
    }
    for (const [id, k] of cursors) if (!now.has(id)) k.target = null;
    tick();
  }
  addEventListener("message", (e) => {
    if (e.source !== parent || e.origin !== ORIGIN || e.data?.srp !== "cursors") return;
    try { setCursors(e.data.list); } catch {}
  });
})();
