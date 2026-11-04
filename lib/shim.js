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

  // ---------- live drafts: patch the page in place instead of reloading it ----------
  // The parent sends { srp: "morph", from, html, url }: `from` is the source this page was loaded from (or last
  // patched to), `html` the next draft. Comparing the two sources, not the live DOM, finds what the edit changed,
  // and only that is changed on the live page, so whatever the page's own scripts built or moved stays as it is.
  // Changed scripts can't be patched in (they'd have to run again), so then, or if anything doesn't line up, the
  // page loads `url` instead. Replies { srp: "morphed", exact } (false when scripts might have set up the patched
  // markup differently on a real load) or { srp: "morphed", failed: true } just before loading.
  const ORIGIN = __MAIN_ORIGIN__;
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
})();
