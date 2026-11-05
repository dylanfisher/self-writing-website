// Added to every page the sandbox serves (inlined by server.mjs, never stored with the page). Runs first in <head>.
// The server fills in the site's origin (ORIGIN below) when it starts.
(() => {
  const ORIGIN = __MAIN_ORIGIN__;

  // Anyone can open a sandbox URL as a top-level page. There it isn't sandboxed (navigation, popups and forms
  // reach any server) and has no "AI-written" banner, so it could pose as a real site and send typed text away.
  // On the real site (ORIGIN is a string; the server's page check passes null) refuse: write a notice and turn
  // the rest of the document into inert text with <plaintext>, then stop. Deliberately no way to switch this off.
  if (typeof ORIGIN === "string" && window.top === window) {
    try {
      const id = /^\/v\/(\d+)$/.exec(location.pathname)?.[1];
      const href = ORIGIN + (id ? "/#v" + id : "/");
      const esc = (t) => t.replace(/[&<>"']/g, (c) => "&#" + c.charCodeAt(0) + ";");
      document.write('<meta charset="utf-8"><title>Self-rewriting page</title>'
        + '<body style="font:16px system-ui,sans-serif;margin:2em"><p>This page only works inside its site. '
        + '<a href="' + esc(href) + '">Open it there</a>.</p><plaintext style="display:none">');
    } catch {}
    return;
  }

  // WebRTC sends UDP straight to any server a page names (the CSP doesn't cover it), leaking viewers' IPs. Turn it off.
  for (const n of ["RTCPeerConnection", "webkitRTCPeerConnection"]) {
    try {
      const proto = window[n]?.prototype;
      if (proto) {
        for (const k of Reflect.ownKeys(proto)) {
          if (k === "constructor") continue;
          try {
            const d = Object.getOwnPropertyDescriptor(proto, k);
            const off = function () { throw new DOMException("WebRTC is turned off on this site", "NotAllowedError"); };
            if (d.get || d.set) Object.defineProperty(proto, k, { get: off, set: off, configurable: true });
            else if (typeof d.value === "function") Object.defineProperty(proto, k, { value: off, configurable: true, writable: true });
          } catch {}
        }
      }
      delete window[n];
    } catch {}
  }

  // One AudioContext per page. Pages often make a new one per sound and never close them (70 of the first 335
  // versions did), so they pile up until sound stops. new AudioContext() (and webkitAudioContext) returns the same
  // one; close() on it does nothing, so one script can't silence another. A context made at load starts suspended
  // (autoplay rules) and many pages never resume it: the first click, tap or key resumes it. Subclasses
  // (class X extends AudioContext) and OfflineAudioContext get their own, as before.
  try {
    const Real = window.AudioContext ?? window.webkitAudioContext;
    if (typeof Real === "function") {
      let shared = null;
      const Shared = new Proxy(Real, {
        construct(target, args, newTarget) {
          if (newTarget !== Shared) return Reflect.construct(Real, args, newTarget);
          if (!shared || shared.state === "closed") {
            shared = Reflect.construct(Real, [], Real);
            Object.defineProperty(shared, "close", { value: () => Promise.resolve(), configurable: true, writable: true });
          }
          return shared;
        },
      });
      for (const n of ["AudioContext", "webkitAudioContext"]) {
        if (n in window) Object.defineProperty(window, n, { value: Shared, writable: true, configurable: true });
      }
      const wake = () => { if (shared?.state === "suspended") shared.resume().catch(() => {}); };
      for (const t of ["pointerdown", "keydown", "touchend"]) addEventListener(t, wake, { capture: true, passive: true });
    }
  } catch {}

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

  // ---------- window.SITE: live facts about the site, for the page's own scripts ----------
  // Read-only. Mostly what the shell page shows anyone; besides that, SITE.me (this visitor's public id, visits and
  // own past changes, sent only to them) and SITE.people (everyone here, by public id). The parent sends
  // { srp: "site", data } when the frame loads and whenever something changes; until then SITE holds safe
  // defaults, so a page can read it at any time. Listeners: SITE.on("change", fn), called with SITE after each
  // update; SITE.on("cursors", fn) when others' cursors move (SITE.cursors). Visitor text in here (suggestions,
  // rules) is shown by page scripts however they like: it's model territory, inside the sandbox.
  const listeners = new Set(), cursorListeners = new Set();
  const ME = Object.freeze({ id: "", hue: 0, firstSeen: 0, visits: 1, isNew: true, suggested: 0, mine: Object.freeze([]) });
  const STATS = Object.freeze({ visitorsToday: 1, visitorsAll: 1, peakToday: 1, peakAll: 1, suggestionsToday: 0,
    suggestionsAll: 0, versions: 0, born: 0 });
  const data = { viewers: 1, version: 0, latest: 0, old: false, draft: false, writing: null, queue: [],
    recent: [], rules: [], lore: [], era: null, me: ME, people: Object.freeze([]), stats: STATS, page: null,
    tz: "UTC", updated: 0 };
  let skew = 0;   // server clock minus ours
  const str = (s, n) => String(s ?? "").slice(0, n);
  const num = (n) => Number.isFinite(+n) ? Math.max(0, Math.floor(+n)) : 0;
  const hue = (n) => num(n) % 360;
  const pid = (s) => /^[0-9a-f]{1,16}$/.test(s) ? s : "";
  const orNull = (x, f) => x === null || x === undefined ? null : f(x);
  const texts = (a, n) => (Array.isArray(a) ? a : []).slice(0, n)
    .map((x) => Object.freeze({ text: str(x?.text, 300), at: num(x?.at) }));
  const call = (set) => {
    for (const fn of [...set]) {
      // One broken listener must not stop the others; its error still shows (and the check still sees it).
      try { fn(SITE); } catch (err) { try { reportError(err); } catch { setTimeout(() => { throw err; }); } }
    }
  };
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
    const m = d.me && typeof d.me === "object" ? d.me : null;
    data.me = !m ? ME : Object.freeze({ id: pid(m.id), hue: hue(m.hue), firstSeen: num(m.firstSeen), visits: Math.max(1, num(m.visits)),
      isNew: m.isNew === true, suggested: num(m.suggested),
      mine: Object.freeze((Array.isArray(m.mine) ? m.mine : []).slice(0, 5)
        .map((x) => Object.freeze({ text: str(x?.text, 300), version: num(x?.version), at: num(x?.at) }))) });
    data.people = Object.freeze((Array.isArray(d.people) ? d.people : []).slice(0, 50).map((p) => Object.freeze({
      id: pid(p?.id), hue: hue(p?.hue), since: num(p?.since), on: orNull(p?.on, num), active: p?.active === true,
      tabs: Math.max(1, num(p?.tabs)) })));
    const t = d.stats && typeof d.stats === "object" ? d.stats : null;
    data.stats = !t ? STATS : Object.freeze(Object.fromEntries(Object.keys(STATS).map((k) => [k, num(t[k])])));
    const p = d.page && typeof d.page === "object" ? d.page : null;
    data.page = !p ? null : Object.freeze({ suggestion: orNull(p.suggestion, (x) => str(x, 300)), summary: orNull(p.summary, (x) => str(x, 300)),
      secs: orNull(p.secs, num), tokens: orNull(p.tokens, num), bytes: orNull(p.bytes, num), at: num(p.at) });
    data.tz = /^[A-Za-z0-9_+\-/]{1,64}$/.test(d.tz) ? d.tz : "UTC";
    skew = Number.isFinite(+d.skew) ? Math.max(-864e5, Math.min(864e5, +d.skew)) : 0;
    data.updated = Date.now();
    call(listeners);
  }
  const SITE = {};
  for (const k of Object.keys(data)) Object.defineProperty(SITE, k, { get: () => data[k], enumerable: true });
  // Others' cursors on this page, where they're shown on this screen right now (viewport pixels, like clientX).
  Object.defineProperty(SITE, "cursors", { get: () => cursorList(), enumerable: true });
  SITE.time = () => Date.now() + skew;   // the server's clock, in ms; its timezone is SITE.tz
  SITE.on = (type, fn) => {
    const set = type === "cursors" ? cursorListeners : listeners;
    if (typeof fn === "function" && set.size < 100) set.add(fn);
  };
  SITE.off = (type, fn) => { listeners.delete(fn); cursorListeners.delete(fn); };
  // Shared items, seen by every visitor (see "shared items" below).
  SITE.share = (ch, d, opts) => share(ch, d, opts);
  SITE.shared = (ch, fn, onRemove) => sharedList(ch, fn, onRemove);
  SITE.unshare = (x) => unshare(x);
  Object.freeze(SITE);
  // Read-only, and loud about it: frozen alone, SITE.share = wrapper does nothing in a sloppy-mode script, without
  // an error (v330's bubble sounds never played). Throwing makes the page check catch it.
  const readOnly = () => { throw new TypeError("SITE is read-only: don't assign to it or wrap its functions. React to shared items in the SITE.shared(ch, onAdd, onRemove) callbacks, and to changes with SITE.on(\"change\", fn)"); };
  const SITE_RO = new Proxy(SITE, { set: readOnly, defineProperty: readOnly, deleteProperty: readOnly, setPrototypeOf: readOnly });
  // Configurable, so a page that declares its own `let SITE` still runs.
  Object.defineProperty(window, "SITE", { value: SITE_RO, writable: true, configurable: true });
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
  const cursors = new Map();   // id → { el, target, x, y, v, hue }
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
        const h = Math.max(0, Math.min(359, Math.floor(Number(c.hue) || 0)));
        k = { el: arrow(h), x: null, y: null, v: pid(String(c.v ?? "")), hue: h };
        cursors.set(id, k);
        r.append(k.el);
      }
      k.el.classList.remove("gone");
      k.target = t;
    }
    for (const [id, k] of cursors) if (!now.has(id)) k.target = null;
    tick();
    call(cursorListeners);
  }
  // For SITE.cursors: { id (as in SITE.people), hue, x, y } for each cursor shown, where its arrow is heading.
  function cursorList() {
    const out = [];
    for (const c of cursors.values()) {
      if (!c.target) continue;
      const [x, y] = where(c.target);
      out.push(Object.freeze({ id: c.v, hue: c.hue, x: Math.round(x), y: Math.round(y) }));
    }
    return Object.freeze(out);
  }
  addEventListener("message", (e) => {
    // From the shell page, or (in the page check, where this page is the top window) from the check itself.
    if (e.source !== parent || e.data?.srp !== "cursors" || (e.origin !== ORIGIN && parent !== window)) return;
    try { setCursors(e.data.list); } catch {}
  });
  // ---------- shared items: SITE.share(channel, data) and SITE.shared(channel, onAdd, onRemove) ----------
  // Things visitors add that everyone sees (bubbles, votes, pixels), kept by the server per era and channel.
  // SITE.share(ch, data, { keep }) adds one: shown here at once (onAdd gets it with mine: true) and sent to the parent
  // ({ srp: "share" }), which posts it to the server; keep: false sends it to whoever's here without storing it.
  // SITE.shared(ch, onAdd, onRemove) calls onAdd(item) for every item already there, oldest first, then for each new
  // one, and onRemove(item) for each one removed (by anyone, here at once; or pushed out by newer ones past
  // S_KEEP); it returns the items so far. item: { key, data, by (visitor id, as in SITE.people), hue, at, mine },
  // plus data's keys. SITE.unshare(item) (or its key) removes one for everyone ({ srp: "unshare", ch, key }).
  // The first use of a channel asks the parent for it ({ srp: "subscribe", ch }); the parent answers
  // { srp: "shared", ch, items } and then passes on new ones as { srp: "shared", ch, item } and removals as
  // { srp: "shared", ch, removed: key }. A removal can come before its item (before the list, or while the parent
  // was fetching it), so recently removed keys are remembered and their items never come back.
  // Data is checked as in lib/shared.mjs (keep them in step): no free text. Bad data throws, so the page check
  // catches it before the page is published.
  const S_CHANNEL = /^[a-z0-9-]{1,24}$/, S_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,23}$/, S_TOKEN = /^[A-Za-z0-9#_.-]{1,16}$/;
  const S_EMOJI = /^(?:\p{Extended_Pictographic}|\p{Emoji_Modifier}|\p{Regional_Indicator}|‍|️|⃣){1,8}$/u;
  const S_ITEM = /^[a-z0-9]{10}$/;   // an item's key (ITEM_KEY in lib/shared.mjs)
  const S_KEEP = 300, S_CHANNELS = 10, S_GONE = 1000;
  // ch → { items (oldest first), byKey, fns, rmFns, gone (recently removed keys), last (highest server id seen),
  // loaded, early (messages before the list) }
  const chans = new Map();
  const toParent = (m) => { try { parent.postMessage(m, ORIGIN ?? "*"); } catch {} };
  const safe = (fn, x) => { try { fn(x); } catch (err) { try { reportError(err); } catch { setTimeout(() => { throw err; }); } } };
  const hueOfId = (id) => parseInt(String(id).slice(0, 6), 16) % 360 || 0;
  const newKey = () => Array.from(crypto.getRandomValues(new Uint8Array(10)), (b) => "abcdefghijklmnopqrstuvwxyz0123456789"[b % 36]).join("");
  function cleanShared(d) {
    if (d === undefined || d === null) return {};
    if (typeof d !== "object" || Array.isArray(d)) throw new TypeError('SITE.share: data must be an object like { x: 0.5, color: "#f80" }');
    const keys = Object.keys(d);
    if (keys.length > 8) throw new TypeError("SITE.share: at most 8 keys");
    const out = {};
    for (const k of keys) {
      if (!S_KEY.test(k)) throw new TypeError(`SITE.share: bad key "${String(k).slice(0, 30)}"`);
      const v = d[k];
      if (typeof v === "number") {
        if (!Number.isFinite(v)) throw new TypeError(`SITE.share: ${k} is not a finite number`);
        out[k] = Math.round(Math.max(-1e9, Math.min(1e9, v)) * 1e4) / 1e4;
      } else if (typeof v === "boolean") out[k] = v;
      else if (typeof v === "string") {
        if (!S_TOKEN.test(v) && !S_EMOJI.test(v)) throw new TypeError(`SITE.share: ${k}: strings can only be short ids, colors or emoji (no spaces, at most 16 characters), never text people typed`);
        out[k] = v;
      } else throw new TypeError(`SITE.share: ${k} must be a number, true/false or a short string`);
    }
    if (new TextEncoder().encode(JSON.stringify(out)).length > 300) throw new TypeError("SITE.share: data over 300 bytes");
    return out;
  }
  // The data's keys are on the item too (item.x as well as item.data.x: pages reach for both); ours win a clash.
  const mkItem = (clean, key, by, hue, at, mine) =>
    Object.freeze({ ...clean, data: Object.freeze(clean), key, by, hue, at, mine });
  function chan(ch) {
    if (typeof ch !== "string" || !S_CHANNEL.test(ch)) throw new TypeError('SITE.share: the channel is a short lowercase name like "bubbles"');
    let c = chans.get(ch);
    if (!c) {
      if (chans.size >= S_CHANNELS) throw new TypeError(`SITE.share: at most ${S_CHANNELS} channels on a page`);
      chans.set(ch, c = { items: [], byKey: new Map(), fns: new Set(), rmFns: new Set(), gone: new Set(), last: 0, loaded: false, early: [] });
      toParent({ srp: "subscribe", ch });
    }
    return c;
  }
  function forget(c, key) {
    c.gone.add(key);
    if (c.gone.size > S_GONE) c.gone.delete(c.gone.values().next().value);
  }
  // Drops a kept item from the list and tells the page; false if it isn't there.
  function drop(c, key) {
    const item = c.byKey.get(key);
    forget(c, key);
    if (!item) return false;
    c.byKey.delete(key);
    c.items.splice(c.items.indexOf(item), 1);
    for (const fn of [...c.rmFns]) safe(fn, item);
    return true;
  }
  // keep: false items reach the listeners but aren't in the list (they're not stored, so a reload wouldn't have
  // them, and they can't be removed).
  function deliver(c, item, keep) {
    if (keep) {
      if (c.byKey.has(item.key) || c.gone.has(item.key)) return;
      c.items.push(item);
      c.byKey.set(item.key, item);
    }
    for (const fn of [...c.fns]) safe(fn, item);
    // Past the cap the oldest goes, as on the server (which also sends that removal: then it's gone here already).
    while (c.items.length > S_KEEP) drop(c, c.items[0].key);
  }
  function share(ch, d, opts) {
    const c = chan(ch), clean = cleanShared(d), keep = opts?.keep !== false, key = newKey();
    const item = mkItem(clean, key, data.me.id, data.me.hue, SITE.time(), true);
    toParent({ srp: "share", ch, data: clean, keep, key });
    deliver(c, item, keep);
    return item;
  }
  function sharedList(ch, fn, onRemove) {
    const c = chan(ch);
    // #412 passed data here as if it stored it, and nothing was shared. Reported, not thrown, so pages already
    // live that do it keep running; the page check sees it as an uncaught error and the model is told why.
    if ((fn != null && typeof fn !== "function") || (onRemove != null && typeof onRemove !== "function")) {
      const err = new TypeError("SITE.shared(channel, onAdd, onRemove) only subscribes: it takes callbacks, not data, and stores nothing. To add an item for everyone use SITE.share(channel, data); to remove one, SITE.unshare(item)");
      try { reportError(err); } catch { setTimeout(() => { throw err; }); }
    }
    if (typeof onRemove === "function" && c.rmFns.size < 20) c.rmFns.add(onRemove);
    if (typeof fn === "function" && c.fns.size < 20 && !c.fns.has(fn)) {
      c.fns.add(fn);
      for (const item of c.items.slice()) safe(fn, item);
    }
    return Object.freeze(c.items.slice());
  }
  // SITE.unshare(item) or SITE.unshare(key): removes it here at once and for everyone. false if it's not (or no
  // longer) here: someone else removed it first, or it was a keep: false item.
  function unshare(x) {
    const key = typeof x === "string" ? x : x && typeof x === "object" ? x.key : undefined;
    if (typeof key !== "string" || !S_ITEM.test(key)) throw new TypeError("SITE.unshare: pass an item from SITE.shared (or its item.key)");
    for (const [ch, c] of chans) {
      if (!c.byKey.has(key)) continue;
      drop(c, key);
      toParent({ srp: "unshare", ch, key });
      return true;
    }
    return false;
  }
  function takeItem(c, raw) {
    if (!raw || typeof raw !== "object") return;
    const id = num(raw.id);
    if (id && id <= c.last) return;   // had it already
    const key = typeof raw.key === "string" && S_ITEM.test(raw.key) ? raw.key : null;
    if (!key && id) return;           // a stored item always has a key
    let clean;
    try { clean = cleanShared(raw.data); } catch { return; }
    if (id) c.last = id;
    const by = pid(raw.by);
    deliver(c, mkItem(clean, key ?? newKey(), by, hueOfId(by), num(raw.at), raw.mine === true), id > 0);
  }
  function take(c, m) {
    if (typeof m.removed === "string") { if (S_ITEM.test(m.removed)) drop(c, m.removed); }
    else takeItem(c, m.item);
  }
  addEventListener("message", (e) => {
    // From the shell page, or (in the page check, where this page is the top window) from the check itself.
    if (e.source !== parent || e.data?.srp !== "shared" || (e.origin !== ORIGIN && parent !== window)) return;
    const c = chans.get(e.data.ch);
    if (!c) return;
    if (Array.isArray(e.data.items)) {
      c.loaded = true;
      // Removals that came first go first, so their items aren't drawn.
      const early = c.early.splice(0);
      for (const m of early) if (typeof m.removed === "string" && S_ITEM.test(m.removed)) forget(c, m.removed);
      for (const raw of e.data.items.slice(-S_KEEP)) takeItem(c, raw);
      for (const m of early) take(c, m);
    } else if (!c.loaded) { if (c.early.length < S_KEEP) c.early.push({ item: e.data.item, removed: e.data.removed }); }
    else take(c, e.data);
  });
})();
