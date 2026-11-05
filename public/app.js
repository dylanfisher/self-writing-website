// Shell page. Everything visitors or the model wrote is inserted with textContent, never as HTML.
// Version pages are only ever shown inside the sandboxed iframe from the sandbox origin.
"use strict";

const $ = (id) => document.getElementById(id);
const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem(k); } catch {} },
};

let S = null;               // latest server state (its history is only the newest page of versions)
let progress = null;        // latest progress event
let viewing = null;         // version id being viewed; null = follow the latest
let shownSrc = "";
let showCode = store.get("srp-code", true);
let lastScrolled = null;
let admin = store.get("srp-admin", null);
const mine = new Set(store.get("srp-mine", []));

// Every version row we've seen, by id. The live state carries the newest page; older pages load on demand.
const versions = new Map();
let listOldest = null;      // the History list shows versions from here to the latest
const pending = new Set();  // "before" ids being fetched

function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else el[k] = v;
  }
  for (const kid of kids) if (kid != null) el.append(kid);   // strings become text nodes
  return el;
}

function ago(ms) {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}
const label = (v) => v.suggestion ?? (v.note === "seed" ? "the first page" : v.note ?? "");

// ---------- history pages ----------
async function loadBefore(before) {
  if (pending.has(before)) return [];
  pending.add(before);
  try {
    const r = await fetch(`/api/history?before=${before}`);
    if (!r.ok) return [];
    const { history } = await r.json();
    for (const v of history) versions.set(v.id, v);
    return history;
  } catch { return []; } finally { pending.delete(before); }
}
async function loadOlder() {
  const btn = $("load-older");
  btn.disabled = true;
  const rows = await loadBefore(listOldest);
  listOldest = rows.length ? rows[0].id : S.first;
  btn.disabled = false;
  renderHistory();
  renderStage();
}
// Scrubbing far back: fetch the page holding that version so its label shows (debounced while dragging).
let labelTimer = null;
function ensureLabel(id) {
  if (versions.has(id)) return;
  clearTimeout(labelTimer);
  labelTimer = setTimeout(async () => { await loadBefore(id + 1); if (shownId() === id) renderStage(); }, 200);
}

// ---------- rendering ----------
const latestId = () => S.current;
const shownId = () => viewing ?? latestId();

// A page on the sandbox origin. The shim's hash is in the URL because version pages are cached for good with the
// shim inlined; a new shim needs new URLs.
const sbx = (p) => `${S.sandboxOrigin}/${p}?db=${S.dbId}&s=${S.shim ?? ""}`;

let frameTimer = null;
// frameReady: the frame has loaded shownSrc (or was patched to it), so it can be patched again.
// frameExact: what's on screen is exactly what loading shownSrc would show (a patch can be close but not exact).
let frameReady = false, frameExact = true;
function setFrame(src) {
  if (src === shownSrc) return;
  shownSrc = src;
  frameReady = false;
  frameSubs.clear();
  // While dragging the timeline, only load the version the thumb settles on.
  clearTimeout(frameTimer);
  frameTimer = setTimeout(() => { $("frame").src = src; }, $("frame").src ? 90 : 0);
}
$("frame").addEventListener("load", () => { frameReady = true; frameExact = true; sendSite(true); sendCursors(); });

// window.SITE in the frame (lib/shim.js): live facts the page's own scripts can use. Only what this page already
// shows everyone; sent as data, and only again when it changed (or the frame loaded a new page).
let siteSig = "";
// This visitor as the server sees them (SITE.me): from the boot state, /api/state, "hello" and "me" events.
let meInfo = null;
// Server clock minus ours (SITE.time()). Only moved when it's off by more than a second, so network jitter
// doesn't make a SITE update out of every state.
let skew = 0;
function takeClock(now) {
  if (!Number.isFinite(now)) return;
  const d = now - Date.now();
  if (Math.abs(d - skew) > 1000) skew = Math.round(d / 1000) * 1000;
}
function sendSite(force = false) {
  if (!S || !$("frame").src) return;
  const draft = !!liveDraft();
  const shown = draft ? null : versions.get(shownId());
  const at = (v) => v.created_at;
  const recent = [];
  for (let id = latestId(); id >= S.first && recent.length < 10; id--) {
    const v = versions.get(id);
    if (v?.suggestion) recent.push({ text: v.suggestion, at: at(v) });
  }
  const data = {
    viewers: S.viewers ?? 1,
    version: draft ? latestId() + 1 : shownId(),
    latest: latestId(),
    draft,
    writing: S.running ? { text: S.running.text, at: S.running.started_at } : null,
    queue: S.queue.map((s) => ({ text: s.text, at: s.created_at })),
    recent,
    rules: (S.rules ?? []).map((r) => r.text),
    lore: (S.lore ?? []).map((l) => l.text),
    era: (() => { const e = eraOf(draft ? latestId() : shownId()); return e ? { n: e.n, name: e.name, at: e.started_at } : null; })(),
    me: meInfo,
    people: S.people ?? [],
    stats: S.stats ? { ...S.stats, versions: S.total } : null,
    page: draft ? { suggestion: S.running?.text ?? null, summary: null, secs: null, tokens: null, bytes: null, at: S.running?.started_at ?? 0 }
      : shown ? { suggestion: shown.suggestion ?? null, summary: shown.summary ?? null, secs: shown.secs == null ? null : Math.round(shown.secs),
        tokens: shown.tokens ?? null, bytes: shown.bytes ?? null, at: shown.created_at } : null,
    tz: S.tz ?? null,
    skew,
  };
  const sig = JSON.stringify(data);
  if (sig === siteSig && !force) return;
  siteSig = sig;
  $("frame").contentWindow?.postMessage({ srp: "site", data }, "*");
}
// Replies from lib/shim.js in the frame. The page's own scripts could send these too; at worst a page isn't reloaded.
addEventListener("message", (e) => {
  if (e.source !== $("frame").contentWindow || e.data?.srp !== "morphed") return;
  clearTimeout(morphTimer);
  if (e.data.failed) frameReady = false;   // it's loading the draft instead
  else frameExact = e.data.exact === true;
});

// ---------- other visitors' cursors ----------
// The frame's shim reports where our pointer is on the page ({ srp: "pointer" }); we post it with what we're
// looking at (cursorKey) to the server, which sends every page the cursors on the same one ("cursors" events).
// Those go back into the frame, where the shim draws them. Only with a working event stream (it gives us the id
// and token); a polling page shows none. Positions are page data, not trusted: the server checks them.
// Over the shell's own controls, our cursor is { z, fx, fy } instead: a zone (data-cz in index.html: header, page
// bar, scrub bar, sidebar) and where in its box. Those are the same on every version, so the server sends them to
// every page ("chrome-cursors" events) and we draw them here, positioned in each zone as it is on this screen.
let me = null;              // { id, token } from the stream's "hello"
let cursorKey = null;       // "v<id>" or "d<suggestion id>" (a live draft); null: none
let myCursor = null, cursorTimer = null, lastCursorPost = 0, cursorsData = null, chromeData = null;
const hueOf = (id) => parseInt(String(id).slice(0, 6), 16) % 360 || 0;
function pageKey() {
  if (!S || !streamWorks || !me || document.hidden) return null;
  return liveDraft() ? `d${S.running.id}` : `v${shownId()}`;
}
function postCursor() {
  cursorTimer = null;
  if (!me) return;
  lastCursorPost = Date.now();
  const c = myCursor && (myCursor.z || cursorKey) ? myCursor : null;
  if (liveSend({ t: "cursor", k: cursorKey, c })) return;
  fetch("/api/cursor", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: me.token, k: cursorKey, c }) }).catch(() => {});
}
function queueCursor() {
  cursorTimer ??= setTimeout(postCursor, Math.max(0, 130 - (Date.now() - lastCursorPost)));
}
function syncCursorKey() {
  const k = pageKey();
  if (k === cursorKey) return;
  cursorKey = k;
  if (!myCursor?.z || !k) myCursor = null;
  queueCursor();
  sendCursors();
}
function sendCursors() {
  if (!$("frame").src) return;
  const list = cursorsData && cursorsData.k === cursorKey && frameReady
    ? cursorsData.list.filter((c) => c.id !== me?.id).map((c) => ({ ...c, hue: hueOf(c.v ?? c.id) }))
    : [];
  $("frame").contentWindow?.postMessage({ srp: "cursors", list }, "*");
}
addEventListener("message", (e) => {
  if (e.source !== $("frame").contentWindow || e.data?.srp !== "pointer") return;
  const d = e.data;
  // "gone" can arrive after the shell already saw the pointer over its controls: it only clears a page cursor.
  if (d.gone) { if (myCursor && !myCursor.z) myCursor = null; }
  else myCursor = { p: String(d.p ?? "").slice(0, 200), fx: +d.fx || 0, fy: +d.fy || 0, x: +d.x || 0, y: +d.y || 0 };
  if (me) queueCursor();
});
document.addEventListener("visibilitychange", () => syncCursorKey());

// ---------- shared items (SITE.share in lib/shim.js) ----------
// The frame asks for a channel ({ srp: "subscribe", ch }): we fetch what's there and pass it in, then pass on new
// items and removals from the stream ("shared" events). Its own items ({ srp: "share" }) and removals
// ({ srp: "unshare" }) we send over the WebSocket, or post with our stream token; without a working stream they
// stay on this screen. Page data, not trusted: the server checks it, and it only ever goes
// back into the sandboxed frame. When the admin clears a channel the frame uses, we load the page again.
const frameSubs = new Set();   // channels the page in the frame asked for (cleared when it loads another page)
let sharesInFlight = 0;
const ITEM_KEY = /^[a-z0-9]{10}$/;
// Over the WebSocket, else posted (a few at a time) with the stream token.
function sendShared(path, m) {
  if (liveSend(m)) return;
  if (sharesInFlight >= 4) return;
  const { t, ...rest } = m;
  const body = JSON.stringify({ token: me.token, ...rest });
  if (body.length > 900) return;
  sharesInFlight++;
  fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body })
    .catch(() => {}).finally(() => { sharesInFlight--; });
}
const markMine = (item) => ({ ...item, mine: !!meInfo?.id && item.by === meInfo.id });
addEventListener("message", async (e) => {
  if (e.source !== $("frame").contentWindow) return;
  const d = e.data, ch = typeof d?.ch === "string" && d.ch.length <= 24 ? d.ch : null;
  if (!ch) return;
  if (d.srp === "subscribe" && frameSubs.size < 20) {
    frameSubs.add(ch);
    try {
      const r = await fetch(`/api/shared?ch=${encodeURIComponent(ch)}`);
      if (!r.ok) return;
      const { items } = await r.json();
      e.source.postMessage({ srp: "shared", ch, items: items.map(markMine) }, "*");
    } catch {}
  } else if (d.srp === "share" && me && streamWorks && (d.key == null || ITEM_KEY.test(d.key))) {
    // No key: a page from before keys (its shim was cached); the server makes one.
    sendShared("/api/share", { t: "share", ch, data: d.data, keep: d.keep !== false, key: d.key ?? undefined, k: cursorKey });
  } else if (d.srp === "unshare" && me && streamWorks && ITEM_KEY.test(d.key)) {
    sendShared("/api/unshare", { t: "unshare", ch, key: d.key });
  }
});
function takeShared(m) {
  if (!frameSubs.has(m.ch)) return;
  const out = typeof m.removed === "string" ? { srp: "shared", ch: m.ch, removed: m.removed } : { srp: "shared", ch: m.ch, item: markMine(m.item) };
  $("frame").contentWindow?.postMessage(out, "*");
}
function sharedReset(m) {
  if (!(m.all ? frameSubs.size : frameSubs.has(m.ch)) || !shownSrc) return;
  frameSubs.clear();
  frameReady = false;
  $("frame").src = shownSrc;   // the same URL again: loads it afresh
}

// Our pointer over the shell's controls.
function setChromeCursor(c) {
  if (!c && !myCursor?.z) return;
  myCursor = c;
  if (me) queueCursor();
}
document.addEventListener("pointermove", (e) => {
  if (e.pointerType === "touch" || !e.isTrusted) return;
  const z = e.target instanceof Element ? e.target.closest("[data-cz]") : null;
  const r = z?.getBoundingClientRect();
  if (!r?.width || !r.height) return setChromeCursor(null);
  const f = (n) => Math.round(Math.min(1, Math.max(0, n)) * 1000) / 1000;
  setChromeCursor({ z: z.dataset.cz, fx: f((e.clientX - r.left) / r.width), fy: f((e.clientY - r.top) / r.height) });
}, { passive: true, capture: true });
document.addEventListener("pointerout", (e) => {
  if (e.pointerType !== "touch" && (!e.relatedTarget || e.relatedTarget === $("frame"))) setChromeCursor(null);
});
addEventListener("blur", () => setChromeCursor(null));

// Others' cursors over the shell: a fixed layer above everything, positions recomputed each frame from the zones
// (they move with scrolling and layout). A cursor in a zone that's hidden here (full-page mode) isn't shown.
const chromeCursors = new Map();   // id → { el, z, fx, fy, x, y }
let chromeLayer = null, chromeRaf = 0;
function chromeArrow(hue) {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 16 20");
  svg.setAttribute("class", "rc");
  const path = document.createElementNS(ns, "path");
  path.setAttribute("d", "M1 1 L1 16 L5 12.5 L8 19 L10.5 18 L7.6 11.6 L13 11.6 Z");
  path.setAttribute("fill", `hsl(${hue} 75% 52%)`);
  path.setAttribute("stroke", "#fff");
  path.setAttribute("stroke-width", "1.4");
  path.setAttribute("stroke-linejoin", "round");
  svg.append(path);
  return svg;
}
function chromeFrame() {
  chromeRaf = 0;
  let moving = false;
  for (const c of chromeCursors.values()) {
    if (c.left) continue;
    const r = document.querySelector(`[data-cz="${c.z}"]`)?.getBoundingClientRect();
    if (!r?.width || !r.height) { c.el.classList.add("gone"); c.x = null; continue; }
    const tx = r.left + c.fx * r.width, ty = r.top + c.fy * r.height;
    if (c.x === null) { c.x = tx; c.y = ty; }
    c.x += (tx - c.x) * 0.3; c.y += (ty - c.y) * 0.3;
    if (Math.abs(tx - c.x) > 0.3 || Math.abs(ty - c.y) > 0.3) moving = true;
    c.el.classList.remove("gone");
    c.el.style.transform = `translate(${c.x.toFixed(1)}px,${c.y.toFixed(1)}px)`;
  }
  if (moving) chromeTick();
}
const chromeTick = () => { if (!chromeRaf && chromeCursors.size) chromeRaf = requestAnimationFrame(chromeFrame); };
addEventListener("scroll", chromeTick, { passive: true, capture: true });
addEventListener("resize", chromeTick);
setInterval(chromeTick, 500);
function renderChromeCursors() {
  if (!chromeLayer) {
    chromeLayer = h("div", { class: "remote-cursors" });
    chromeLayer.setAttribute("aria-hidden", "true");
    document.body.append(chromeLayer);
  }
  const zones = new Set(["top", "bar", "scrub", "side"]);
  const list = streamWorks && !document.hidden && chromeData ? chromeData.list : [];
  const now = new Set();
  for (const c of list.slice(0, 50)) {
    const id = String(c?.id ?? "");
    if (!id || id === me?.id || now.has(id) || !zones.has(c.z)) continue;
    now.add(id);
    let k = chromeCursors.get(id);
    if (!k) {
      k = { el: chromeArrow(hueOf(c.v ?? id)), x: null, y: null };
      chromeCursors.set(id, k);
      chromeLayer.append(k.el);
    }
    clearTimeout(k.drop);
    k.left = false;
    Object.assign(k, { z: c.z, fx: Math.min(1, Math.max(0, +c.fx || 0)), fy: Math.min(1, Math.max(0, +c.fy || 0)) });
  }
  for (const [id, k] of chromeCursors) {
    if (now.has(id) || k.left) continue;
    k.left = true;   // fade out, then drop
    k.el.classList.add("gone");
    k.drop = setTimeout(() => { k.el.remove(); chromeCursors.delete(id); }, 450);
  }
  chromeTick();
}

// Live drafts: the frame patches itself from the draft on screen to the next one instead of reloading
// (lib/shim.js). The HTML is model output: it's only ever handed to the sandboxed frame, never used here.
let draftData = null;   // the latest "draft" event: { draft, prev, version, from, html }
// The last few drafts' HTML by number. After the first draft the server leaves out `from` (it's draft `prev`,
// which we got before); without it here, the draft is loaded by URL instead of patched.
const draftHtml = new Map();
function takeDraft(d) {
  if (typeof d.from !== "string" && d.prev) d.from = draftHtml.get(d.prev);
  draftHtml.set(d.draft, d.html);
  for (const k of draftHtml.keys()) if (k <= d.draft - 4) draftHtml.delete(k);
  draftData = d;
}
let morphTimer = null;
function showDraft(n) {
  const src = sbx(`d/${n}`);
  if (src === shownSrc) return;
  const d = draftData?.draft === n ? draftData : null;
  const from = d && sbx(d.prev ? `d/${d.prev}` : `v/${d.version}`);
  if (!d || typeof d.from !== "string" || !frameReady || shownSrc !== from) return setFrame(src);
  clearTimeout(frameTimer);
  shownSrc = src;
  frameExact = false;
  $("frame").contentWindow.postMessage({ srp: "morph", from: d.from, html: d.html, url: src }, "*");
  // No reply: a page cached with an older shim that can't patch. Load the draft instead.
  clearTimeout(morphTimer);
  morphTimer = setTimeout(() => { if (shownSrc === src) { shownSrc = ""; setFrame(src); } }, 1000);
}

// Like scrollIntoView({ block: "nearest" }), but only scrolls the list, never the page (which matters on phones,
// where the list is part of the scrolling page).
function scrollIntoList(el, box) {
  if (!el) return;
  const e = el.getBoundingClientRect(), b = box.getBoundingClientRect();
  if (e.top < b.top) box.scrollTop -= b.top - e.top;
  else if (e.bottom > b.bottom) box.scrollTop += e.bottom - b.bottom;
}

// The live draft of the suggestion being written, when following the latest version (not while looking back).
function liveDraft() {
  const r = S?.running;
  return viewing === null && r && progress?.id === r.id && progress.draft ? progress : null;
}

function renderStage() {
  syncCursorKey();
  const id = shownId();
  const v = versions.get(id);
  const draft = liveDraft();
  if (draft) {
    // Unchecked: each finished edit appears as it's written. The checked version replaces it when done.
    showDraft(draft.draft);
    $("viewing").replaceChildren(`v${id + 1}`, h("span", { class: "badge draft", title: "Being written right now. It hasn't been tested yet, so it may look broken for a moment." },
      h("span", { class: "dot" }), `Draft · ${draft.draftBlocks} ${draft.draftBlocks === 1 ? "change" : "changes"} so far`));
    $("viewing-suggestion").textContent = `“${S.running.text}” · being written`;
    $("to-latest").hidden = true;
    return;
  }
  const src = sbx(`v/${id}`);
  // The finished version is exactly the draft on screen: keep it (same page, same origin and CSP), no reload.
  if (S.drafted?.version === id && frameExact && shownSrc === sbx(`d/${S.drafted.draft}`)) {
    shownSrc = src;
  } else setFrame(src);

  const isLatest = id === latestId();
  $("viewing").replaceChildren(`v${id}`, ...(isLatest ? [h("span", { class: "badge" }, h("span", { class: "dot" }), "Latest")] : []));
  $("viewing-suggestion").textContent = v ? `“${label(v)}” · ${ago(v.created_at)}` : "";
  if (!v) ensureLabel(id);
  $("to-latest").hidden = isLatest;
  $("to-latest").textContent = `Latest v${latestId()} →`;

  const sc = $("scrubber");
  sc.min = S.first; sc.max = latestId(); sc.value = id;
  $("scrub-pos").textContent = `${id} / ${latestId()}`;
  $("prev").disabled = id <= S.first;
  $("next").disabled = isLatest;

  if (location.hash !== `#v${id}` && !isLatest) history.replaceState(null, "", `#v${id}`);
  if (isLatest && location.hash) history.replaceState(null, "", location.pathname);

  for (const li of $("history").children) {
    const on = Number(li.dataset.id) === id;
    li.classList.toggle("active", on);
    const r = li.querySelector(".restore");
    if (r) r.hidden = !(on && admin && !isLatest);
  }
  if (id !== lastScrolled) {
    lastScrolled = id;
    scrollIntoList($("history").querySelector("li.active"), $("history-scroll"));
  }
}

let historySig = "";
// "5m ago" in each History row, updated in place (rebuilding 250 rows to change their times is wasteful).
function renderHistoryTimes() {
  for (const li of $("history").children) {
    const v = versions.get(Number(li.dataset.id)), t = li.querySelector(".when");
    if (v && t) t.textContent = ago(v.created_at);
  }
}
function renderHistory(force = false) {
  $("history-count").textContent = S.total;
  // Polling re-sends the state every few seconds; only rebuild the list when it changed (or to refresh times).
  // (S.history is only the newest few after the first state; versions has them all, and never change once written.)
  const sig = `${S.current}|${listOldest}|${versions.size}|${!!admin}|${(S.eras ?? []).length}`;
  const eraStarts = new Map((S.eras ?? []).map((e) => [e.version_id, e]));
  if (sig === historySig && !force) return;
  historySig = sig;
  const rows = [];
  for (let id = latestId(); id >= listOldest; id--) {
    const v = versions.get(id);
    if (!v) continue;
    const li = h("li", {},
      h("button", { class: "row", type: "button", onclick: () => show(v.id) },
        h("span", { class: "vid" }, `v${v.id}`),
        h("span", { class: "s" },
          eraStarts.has(v.id) ? h("span", { class: "era-tag", title: `A new era began here, ${new Date(eraStarts.get(v.id).started_at).toLocaleDateString()}` }, eraName(eraStarts.get(v.id))) : null,
          v.broken ? h("span", { class: "broken" }, "⚠ ") : null, label(v)),
        h("span", { class: "tag when" }, ago(v.created_at))),
      h("button", { class: "btn small restore", type: "button", hidden: true, onclick: () => restore(v.id) },
        `Make v${v.id} the latest again`));
    li.dataset.id = v.id;
    rows.push(li);
  }
  $("history").replaceChildren(...rows);
  const older = listOldest - S.first;
  $("load-older").hidden = older <= 0;
  $("load-older").textContent = `Show older versions (${older} more)`;
}

// ---------- history popover ----------
// Shown beside a History row on hover (mouse) or keyboard focus. Everything is inserted as text.
const vtip = $("vtip");
let vtipId = null;
function showVtip(row) {
  const id = Number(row.closest("li")?.dataset.id);
  const v = versions.get(id);
  if (!v) return hideVtip();
  if (vtipId !== id) {
    vtipId = id;
    const meta = [
      v.secs ? `written in ${Math.round(v.secs)} s` : null,
      `${(v.bytes / 1000).toFixed(1)} KB`,
      v.note && v.note !== "seed" ? v.note : null,
    ].filter(Boolean).join(" · ");
    const steps = v.summary ? v.summary.split(" · ") : [];
    vtip.replaceChildren(...[
      h("div", { class: "vtip-head" },
        h("span", { class: "vid" }, `v${v.id}`),
        id === latestId() ? h("span", { class: "badge" }, "Latest") : null,
        h("span", { class: "when" }, `${ago(v.created_at)} · ${new Date(v.created_at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`)),
      h("div", { class: "vtip-text" }, v.suggestion ? `“${v.suggestion}”` : label(v)),
      steps.length ? h("ol", { class: "steps" }, ...steps.map((s) => h("li", {}, s))) : null,
      h("div", { class: "vtip-meta" }, [eraOf(id) ? eraName(eraOf(id)) : null, meta].filter(Boolean).join(" · ")),
      v.broken ? h("div", { class: "vtip-warn" }, "⚠ This version has a JavaScript error.") : null,
    ].filter(Boolean));
  }
  vtip.hidden = false;
  const r = row.getBoundingClientRect(), w = vtip.offsetWidth, ht = vtip.offsetHeight;
  let left = r.left - w - 10, top = r.top + r.height / 2 - ht / 2;
  if (left < 8) { left = Math.max(8, Math.min(r.left, innerWidth - w - 8)); top = r.bottom + 6; }
  vtip.style.left = `${left}px`;
  vtip.style.top = `${Math.max(8, Math.min(top, innerHeight - ht - 8))}px`;
}
function hideVtip() { vtip.hidden = true; vtipId = null; }
const canHover = matchMedia("(hover: hover)").matches;
$("history").addEventListener("mouseover", (e) => { const row = e.target.closest("button.row"); if (row && canHover) showVtip(row); });
$("history").addEventListener("mouseleave", hideVtip);
$("history").addEventListener("focusin", (e) => { const row = e.target.closest("button.row"); if (row?.matches(":focus-visible")) showVtip(row); });
$("history").addEventListener("focusout", hideVtip);
$("history-scroll").addEventListener("scroll", hideVtip, { passive: true });

function renderQueue() {
  const n = S.queue.length;
  $("queue-count").textContent = n || "";
  $("queue-empty").hidden = n > 0;
  $("queue").replaceChildren(...S.queue.map((s, i) =>
    h("li", { class: mine.has(s.id) ? "mine" : "" },
      h("span", { class: "pos" }, `${i + 1}`),
      h("span", { class: "txt" }, s.kind === "scheduled" ? `⏰ ${s.text}` : s.kind === "cleanup" ? `🧹 ${s.text}` : s.text),
      mine.has(s.id) ? h("span", { class: "tag" }, "yours")
        : h("span", { class: "tag" }, s.kind === "scheduled" ? "scheduled" : s.kind === "cleanup" ? "cleanup" : ago(s.created_at)),
      mine.has(s.id) || admin ? h("button", { class: "link", type: "button", onclick: () => removeItem(s.id) },
        mine.has(s.id) ? "Cancel" : "Remove") : null)));

  $("recent").replaceChildren(...S.recent.filter((r) => r.status !== "done" && fresh(r)).slice(0, 3).map((r) =>
    h("li", {}, h("span", { class: "bad" }, r.status === "failed" ? "Failed" : "Skipped"),
      ` “${r.text}”: ${r.error}`)));
}

// Skipped/failed notices (and "yours became v12") fade out after a few minutes.
const NOTICE_MS = 3 * 60_000;
const fresh = (r) => Date.now() - (r.finished_at ?? 0) < NOTICE_MS;

function renderRules() {
  const rules = S.rules ?? [], max = S.rulesMax ?? 10;
  $("rules-count").textContent = `${rules.length}/${max}`;
  $("rules-empty").hidden = rules.length > 0;
  $("help-rules-max").textContent = String(max);
  // Newest first. When every slot is taken, the oldest goes when the next rule comes in.
  $("rules").replaceChildren(...rules.map((r, i) => {
    const yours = mine.has(r.suggestion_id);
    const tags = [
      yours ? h("span", { class: "tag yours" }, "yours") : null,
      rules.length >= max && i === 0 ? h("span", { class: "tag next", title: "The next new rule replaces this one" }, "goes next") : null,
      h("span", { class: "tag", title: `Added ${new Date(r.created_at).toLocaleString()}` +
        (r.updated_at ? `, last updated ${new Date(r.updated_at).toLocaleString()}` : "") },
        r.updated_at ? `updated ${ago(r.updated_at)}` : ago(r.created_at)),
      yours || admin ? h("button", { class: "link", type: "button", onclick: () => removeRule(r.id) }, "Remove") : null,
    ];
    return h("li", { class: yours ? "mine" : "", title: `From the suggestion “${r.source}”${r.version_id ? `, first applied in v${r.version_id}` : ""}` +
      (r.updated_by ? `. Last changed by “${r.updated_by}”` : "") },
      h("span", { class: "pos" }, `${i + 1}`),
      h("span", { class: "txt" }, r.text),
      h("span", { class: "meta" }, ...tags));
  }).reverse());
}

// Lore: what the page remembers about its world. Newest first; the oldest fades when the list is full.
function renderLore() {
  const lore = S.lore ?? [], max = S.loreMax ?? 12;
  $("lore-count").textContent = lore.length ? `${lore.length}/${max}` : "";
  $("help-lore-max").textContent = String(max);
  $("lore-empty").hidden = lore.length > 0;
  $("lore").replaceChildren(...lore.map((l, i) => {
    const yours = mine.has(l.suggestion_id);
    return h("li", { class: yours ? "mine" : "", title: `From the suggestion “${l.source}”${l.version_id ? `, in v${l.version_id}` : ""}` },
      h("span", { class: "pos" }, "✦"),
      h("span", { class: "txt" }, l.text),
      h("span", { class: "meta" },
        yours ? h("span", { class: "tag yours" }, "yours") : null,
        lore.length >= max && i === 0 ? h("span", { class: "tag next", title: "The next new memory replaces this one" }, "fades next") : null,
        h("span", { class: "tag", title: `Remembered since ${new Date(l.created_at).toLocaleString()}` }, ago(l.created_at)),
        yours || admin ? h("button", { class: "link", type: "button", onclick: () => removeLore(l.id) }, "Forget") : null));
  }).reverse());
}
// Scheduled changes: newest first, like rules. when_spec is on the site's clock; next_at shows it in the viewer's.
function renderSchedules() {
  const list = S.schedules ?? [], max = S.schedulesMax ?? 5;
  $("sched-count").textContent = list.length ? `${list.length}/${max}` : "";
  $("help-sched-max").textContent = String(max);
  $("sched-empty").hidden = list.length > 0;
  $("sched").replaceChildren(...list.map((c, i) => {
    const yours = mine.has(c.suggestion_id);
    const daily = /^daily /.test(c.when_spec);
    const next = c.next_at ? new Date(c.next_at) : null;
    const time = next?.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) ?? "";
    const when = !next ? "" : daily ? `daily ${time}`
      : `${next.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })} ${time}`;
    return h("li", { class: yours ? "mine" : "", title: `From the suggestion “${c.source}”` +
      (next ? `. Next: ${next.toLocaleString()}` : "") + (c.runs ? `. Ran ${c.runs} ${c.runs === 1 ? "time" : "times"}` : "") },
      h("span", { class: "pos" }, "⏰"),
      h("span", { class: "txt" }, c.text),
      h("span", { class: "meta" },
        yours ? h("span", { class: "tag yours" }, "yours") : null,
        list.length >= max && i === 0 ? h("span", { class: "tag next", title: "The next new one replaces this one" }, "goes next") : null,
        h("span", { class: "tag" }, when),
        yours || admin ? h("button", { class: "link", type: "button", onclick: () => removeSchedule(c.id) }, "Remove") : null));
  }).reverse());
}
async function removeSchedule(id) {
  const r = await api("/api/schedules/remove", { id });
  if (!r.ok) sticky($("suggest-msg"), "bad", r.data.error ?? "Couldn't remove that.");
}

async function removeLore(id) {
  const r = await api("/api/lore/remove", { id });
  if (!r.ok) sticky($("suggest-msg"), "bad", r.data.error ?? "Couldn't remove that.");
}

// The era a version belongs to: { n, name, version_id, started_at } (eras are oldest first).
function eraOf(id) {
  let e = null;
  for (const x of S?.eras ?? []) if (x.version_id <= id) e = x;
  return e;
}
const eraName = (e) => e.name ? `Era ${e.n}: ${e.name}` : `Era ${e.n}`;

async function removeRule(id) {
  const r = await api("/api/rules/remove", { id });
  if (!r.ok) sticky($("suggest-msg"), "bad", r.data.error ?? "Couldn't remove that rule.");
}

function renderNow() {
  const r = S.running;
  $("now-idle").hidden = !!r;
  $("now-busy").hidden = !r;
  $("code-toggle").hidden = !r;
  if (!r) return;
  $("now-text").textContent = `“${r.text}”${mine.has(r.id) ? " (yours)" : ""}`;
  const p = progress && progress.id === r.id ? progress : null;
  const pct = !p ? 2 : p.stage === "testing" ? 99 : Math.min(97, (p.chars / Math.max(1, p.expected * 1.05)) * 100);
  $("now-bar").style.width = `${pct}%`;
  // Thinking writes nothing for up to ~30 s: the bar sweeps instead of sitting at 0.
  $("now-bar").parentElement.classList.toggle("thinking", p?.stage === "thinking");
  // The model's status line for each edit; the last one is being written (until the browser test starts).
  const steps = p?.steps ?? [];
  const writing = p?.stage !== "testing";
  $("now-steps").replaceChildren(
    ...(p?.rule ? [h("li", { class: "rule" }, `New rule: ${p.rule}`)] : []),
    ...(p?.lore ? [h("li", { class: "lore" }, `Remembering: ${p.lore}`)] : []),
    ...(p?.schedule ? [h("li", { class: "sched" }, `Scheduling: ${p.schedule}`)] : []),
    ...steps.map((s, i) => h("li", { class: writing && i === steps.length - 1 ? "current" : "" }, s)));
  $("now-code").hidden = !showCode;
  const tail = p && code.id === p.id ? code.text : "";
  if (showCode) $("now-code").textContent = tail || (p?.stage === "waking" ? "Waking the model up…" : p?.stage === "thinking" ? "Thinking it through before writing the fix…" : "Waiting for the first lines…");   // text, never HTML
  $("code-toggle").textContent = showCode ? "Hide code" : "Show code";
  tickElapsed();
}

// The model's reply so far (its last 2000 characters) for "Show code". Progress from a stream carries only what
// was added (`add` at offset `at`); a full `tail` (ending at `end`) comes with a new reply (`reply` counts them),
// in every state and when a stream opens. A piece that doesn't follow what we have waits for the next full one.
let code = { id: null, reply: null, end: 0, text: "" };
let codeAsked = 0;
function takeCode(p) {
  if (!p) return;
  if (typeof p.tail === "string") {
    // A state fetched while the stream runs can be older than what the stream already gave us: keep ours.
    if (p.id === code.id && p.reply !== undefined && (p.reply < code.reply || (p.reply === code.reply && p.end < code.end))) return;
    code = { id: p.id, reply: p.reply, end: p.end ?? p.tail.length, text: p.tail };
    return;
  }
  if (typeof p.add !== "string") return;   // no new text (a stage change)
  if (p.id === code.id && p.reply === code.reply && p.at <= code.end) {
    const add = p.add.slice(code.end - p.at);
    code.text = (code.text + add).slice(-2000);
    code.end += add.length;
  } else if (Date.now() - codeAsked > 5000) { codeAsked = Date.now(); refresh(); }
}

function tickElapsed() {
  const r = S?.running;
  if (!r || !r.started_at) return;
  const s = Math.max(0, Math.round((Date.now() - r.started_at) / 1000));
  const p = progress && progress.id === r.id ? progress : null;
  const stage = { waking: "the model was asleep, waking it up (~10 s)", writing: "writing", testing: "testing in a browser", fixing: "fixing a bug it found", thinking: "thinking it through", shrinking: "too long, trimming",
    retrying: "an edit missed, retrying" }[p?.stage] ?? "writing";
  $("now-elapsed").textContent = `${s}s · ${stage}${p && p.stage !== "testing" && p.stage !== "thinking" ? ` · ${Math.round(p.chars / 100) / 10} KB` : ""}`;
  $("now-elapsed").classList.toggle("thinking", p?.stage === "thinking");
}

function renderMine() {
  const msg = $("suggest-msg");
  if (msg.dataset.sticky === "1") return;
  const ids = [...mine].sort((a, b) => b - a);
  const last = ids[0];
  if (!last) return;
  const pos = S.queue.findIndex((s) => s.id === last);
  const rec = S.recent.find((s) => s.id === last);
  msg.className = "msg";
  if (S.running?.id === last) msg.textContent = "Yours is being written now.";
  else if (pos >= 0) msg.textContent = pos === 0 && !S.running ? "Yours is next." : `You're #${pos + 1} in line.`;
  else if (rec && !fresh(rec)) msg.textContent = "";
  else if (rec?.status === "done") {
    msg.className = "msg good";
    const rule = (S.rules ?? []).find((r) => r.suggestion_id === last);
    const sched = (S.schedules ?? []).find((c) => c.suggestion_id === last);
    msg.textContent = rule ? `Yours became v${rec.version_id} and a standing rule: “${rule.text}”.`
      : sched ? `Yours became v${rec.version_id} and is scheduled: “${sched.text}”.` : `Yours became v${rec.version_id}.`;
    // Published with only the edits that applied: say so, and what was left out.
    if (rec.error) { msg.className = "msg"; msg.textContent += ` Only part of it, though: ${rec.error.replace(/^partly applied: /, "")}.`; }
  }
  else if (rec) { msg.className = "msg bad"; msg.textContent = `Yours was skipped: ${rec.error}.`; }
  else msg.textContent = "";
}

function render() {
  if (!S) return;
  renderHistory();
  renderStage();
  renderQueue();
  renderRules();
  renderLore();
  renderSchedules();
  renderNow();
  renderMine();
  $("admin-badge").hidden = !admin;
  renderViewers();
  if (S.model) $("help-model").textContent = S.model.replace(/-MLX.*$/i, "");
  setupTurnstile();
}

function renderViewers() {
  const n = S?.viewers ?? 0;
  $("viewers").hidden = n < 1;
  $("viewers-n").textContent = String(n);
  $("viewers").title = n === 1 ? "Just you" : `${n} people have this page open`;
}

// The "AI-written" and "i" boxes: click to open, click outside or Esc to close. One open at a time.
const pops = [...document.querySelectorAll(".help")].map((w) => ({ btn: w.querySelector(".help-btn, .warn"), box: w.querySelector(".help-box") }));
function setHelp(open, which = null) {
  for (const p of pops) {
    const on = open && p === which;
    p.box.hidden = !on;
    p.btn.setAttribute("aria-expanded", String(on));
    if (on) placeSidePop(p);
  }
}
// A box opened from inside the sidebar would be cut off by the sidebar's scrolling, so on wide screens it opens to
// the left of the sidebar, level with its button (like the History popover). Narrow screens: below the button.
const wideLayout = matchMedia("(min-width: 861px)");
function placeSidePop(p) {
  const side = p.btn.closest(".side");
  p.box.classList.toggle("beside", Boolean(side && wideLayout.matches));
  if (!p.box.classList.contains("beside")) { p.box.style.top = p.box.style.right = ""; return; }
  const b = p.btn.getBoundingClientRect();
  p.box.style.right = `${innerWidth - side.getBoundingClientRect().left + 10}px`;
  p.box.style.top = `${Math.max(8, Math.min(b.top - 14, innerHeight - p.box.offsetHeight - 8))}px`;
}
// Capture: also closes on scrolling a list inside the sidebar (the Rules list holds the lore "i").
$("history-scroll").closest(".side").addEventListener("scroll", () => setHelp(false), { passive: true, capture: true });
addEventListener("resize", () => setHelp(false));
for (const p of pops) p.btn.onclick = (e) => { e.stopPropagation(); setHelp(p.box.hidden, p); };
document.addEventListener("click", (e) => { if (!e.target.closest(".help")) setHelp(false); });

// ---------- navigation ----------
function show(id, { fromPlay = false } = {}) {
  if (!S) return;
  if (!fromPlay) stopPlay();   // any manual navigation takes over from playback
  id = Math.max(S.first, Math.min(latestId(), Number(id)));
  viewing = id === latestId() ? null : id;
  renderStage();
}
$("prev").onclick = () => show(shownId() - 1);
$("next").onclick = () => show(shownId() + 1);
$("to-latest").onclick = () => show(latestId());
$("scrubber").oninput = (e) => show(e.target.value);
$("load-older").onclick = loadOlder;

// ---------- playback: steps through every version, one after another ----------
// Each version stays up for a moment after its frame has loaded (so slow pages still get their turn). Keeps
// going through versions that arrive while playing, and stops on the latest.
const SPEEDS = [4, 8, 1];   // starts fast; the button cycles through these
const DWELL_MS = 1800;
let speed = SPEEDS.includes(store.get("srp-speed", 4)) ? store.get("srp-speed", 4) : 4;
let playTimer = null, playing = false;
const frameLoaded = () => new Promise((resolve) => {
  const done = () => { clearTimeout(t); $("frame").removeEventListener("load", done); resolve(); };
  const t = setTimeout(done, 5000);   // a page that never fires load doesn't stall playback
  $("frame").addEventListener("load", done);
});
function renderPlay() {
  $("play").classList.toggle("playing", playing);
  $("play").setAttribute("aria-label", playing ? "Pause" : "Play through every version");
  $("play").title = playing ? "Pause (P)" : "Play (P)";
  $("speed").textContent = `${speed}×`;
}
async function playStep() {
  if (!playing) return;
  if (shownId() >= latestId()) return stopPlay();
  const loaded = frameLoaded();
  show(shownId() + 1, { fromPlay: true });
  await loaded;
  if (playing) playTimer = setTimeout(playStep, DWELL_MS / speed);
}
function startPlay() {
  if (!S || playing) return;
  playing = true;
  renderPlay();
  // From the latest, start over at the beginning; otherwise carry on from the version shown.
  if (shownId() >= latestId()) {
    const loaded = frameLoaded();
    show(S.first, { fromPlay: true });
    loaded.then(() => { if (playing) playTimer = setTimeout(playStep, DWELL_MS / speed); });
  } else playTimer = setTimeout(playStep, DWELL_MS / speed / 2);
}
function stopPlay() {
  if (!playing) return;
  playing = false;
  clearTimeout(playTimer);
  renderPlay();
}
$("play").onclick = () => (playing ? stopPlay() : startPlay());
$("speed").onclick = () => {
  speed = SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length];
  store.set("srp-speed", speed);
  renderPlay();
};
renderPlay();

// Full-page mode: hides everything but the built page, plus a small pill that keeps the warning visible.
function setFocus(on) {
  document.body.classList.toggle("focus", on);
  $("focus-pill").hidden = !on;
  store.set("srp-focus", on);
}
$("focus-btn").onclick = () => setFocus(true);
$("unfocus-btn").onclick = () => setFocus(false);
setFocus(store.get("srp-focus", false));

// The Rules panel (rules, lore, scheduled) collapses to its header; remembered per browser.
function setRulesOpen(open) {
  $("rules-toggle").setAttribute("aria-expanded", String(open));
  $("rules-toggle").closest(".panel").classList.toggle("collapsed", !open);
  store.set("srp-rules-open", open);
}
$("rules-toggle").addEventListener("click", () => setRulesOpen($("rules-toggle").getAttribute("aria-expanded") !== "true"));
setRulesOpen(store.get("srp-rules-open", true));

addEventListener("keydown", (e) => {
  if (e.target.closest?.("textarea, input, select") || e.metaKey || e.ctrlKey || e.altKey) return;
  if (!S) return;
  if (e.key === "ArrowLeft") { show(shownId() - 1); e.preventDefault(); }
  if (e.key === "ArrowRight") { show(shownId() + 1); e.preventDefault(); }
  if (e.key === "Home") show(S.first);
  if (e.key === "End") show(latestId());
  if (e.key === "p" || e.key === "P") playing ? stopPlay() : startPlay();
  if (e.key === "f" || e.key === "F") setFocus(!document.body.classList.contains("focus"));
  if (e.key === "Escape") { setFocus(false); setHelp(false); }
});

// ---------- suggesting ----------
const text = $("suggest-text");
text.value = store.get("srp-unsent", "");
store.del("srp-unsent");
text.addEventListener("input", () => { $("count").textContent = `${text.value.length} / ${S?.feedbackCap ?? 200}`; });
text.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); $("suggest-form").requestSubmit(); }
});

// Cloudflare Turnstile, only when the server has it configured (and not for the admin).
let tsWidget = null, tsToken = "", tsLoading = false;
function setupTurnstile() {
  const key = S?.turnstileSiteKey;
  if (!key || admin || tsWidget !== null || tsLoading) return;
  tsLoading = true;
  const s = document.createElement("script");
  s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
  s.async = true;
  s.onload = () => {
    const box = $("turnstile");
    box.classList.add("idle");
    box.hidden = false;
    tsWidget = window.turnstile.render("#turnstile", {
      sitekey: key, appearance: "interaction-only", size: "flexible",
      "before-interactive-callback": () => box.classList.remove("idle"),
      "after-interactive-callback": () => box.classList.add("idle"),
      callback: (t) => { tsToken = t; }, "expired-callback": () => { tsToken = ""; }, "error-callback": () => { tsToken = ""; },
    });
  };
  document.head.append(s);
}
function resetTurnstile() {
  tsToken = "";
  if (tsWidget !== null) try { window.turnstile.reset(tsWidget); } catch {}
}

async function api(path, body) {
  const headers = { "Content-Type": "application/json" };
  if (admin) headers.Authorization = `Bearer ${admin}`;
  const res = await fetch(path, { method: "POST", headers, body: JSON.stringify(body ?? {}) });
  let data = {};
  try { data = await res.json(); } catch {}
  return { ok: res.ok, status: res.status, data };
}

function sticky(msg, cls, textContent) {
  msg.className = `msg ${cls}`;
  msg.textContent = textContent;
  msg.dataset.sticky = "1";
  setTimeout(() => { msg.dataset.sticky = ""; }, 8000);
}

$("suggest-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const msg = $("suggest-msg");
  const value = text.value.trim();
  if (!value) return;
  if (S?.turnstileSiteKey && !admin && !tsToken) return sticky(msg, "bad", "Checking you're human… try again in a moment.");
  $("suggest-btn").disabled = true;
  try {
    const r = await api("/api/suggest", { text: value, turnstile: tsToken });
    if (r.ok) {
      mine.add(r.data.id);
      store.set("srp-mine", [...mine].slice(-20));
      text.value = "";
      nextIdea();
      $("count").textContent = `0 / ${S?.feedbackCap ?? 200}`;
      msg.dataset.sticky = "";
      viewing = null;               // follow the latest so they see theirs land
      render();
      refresh();                    // don't rely on the live stream to show it
    } else {
      let err = r.data.error ?? `Something went wrong (${r.status}).`;
      if (r.data.retryAfter) err += ` Try again in ${Math.ceil(r.data.retryAfter / 60)} min.`;
      sticky(msg, "bad", err);
    }
  } catch {
    sticky(msg, "bad", "Couldn't reach the server.");
  } finally {
    $("suggest-btn").disabled = false;
    resetTurnstile();
  }
});

$("code-toggle").onclick = () => { showCode = !showCode; store.set("srp-code", showCode); renderNow(); };

// ---------- admin ----------
async function restore(id) {
  const r = await api("/api/admin/restore", { id });
  if (r.ok) viewing = null;
}
async function removeItem(id) {
  const r = await api("/api/suggestions/remove", { id });
  if (!r.ok) sticky($("suggest-msg"), "bad", r.data.error ?? "Couldn't cancel that suggestion.");
}
$("admin-logout").onclick = () => { admin = null; store.del("srp-admin"); render(); };

async function adminFromHash() {
  const m = /^#admin=(.+)$/.exec(location.hash);
  if (!m) return;
  history.replaceState(null, "", location.pathname);
  admin = decodeURIComponent(m[1]);
  const r = await api("/api/admin/check");
  if (r.ok) store.set("srp-admin", admin); else admin = null;
  render();
}

// ---------- live updates ----------
// The site's code changed (the server says so with a new build): reload to get it. Not while someone is typing a
// suggestion; whatever is in the box is kept for after the reload.
let build = null;
function reloadForUpdate() {
  if (document.activeElement === text && text.value.trim()) return setTimeout(reloadForUpdate, 2000);
  if (text.value.trim()) store.set("srp-unsent", text.value);
  location.reload();
}

// The tab icon, which the model redraws now and then to match the page (an easter egg). A new link element rather
// than a new href: some browsers only notice a changed icon that way.
function setFavicon(href) {
  const old = document.querySelector('link[rel="icon"]');
  if (old?.getAttribute("href") === href) return;
  const link = document.createElement("link");
  link.rel = "icon";
  link.type = "image/png";
  link.href = href;
  old?.remove();
  document.head.append(link);
}

function applyState(next) {
  const first = !S;
  if (next.me) meInfo = next.me;
  takeClock(next.now);
  S = next;
  if (build === null) build = S.build ?? null;
  else if (S.build && S.build !== build) { build = S.build; reloadForUpdate(); }
  if (S.favicon) setFavicon(S.favicon);
  for (const v of S.history) {
    // A row can change after it's written (scripts/check-versions.mjs marks broken ones): rebuild the list then.
    const old = versions.get(v.id);
    if (old && (old.broken !== v.broken || old.suggestion !== v.suggestion || old.summary !== v.summary)) historySig = "";
    versions.set(v.id, v);
  }
  const pageOldest = S.history[0]?.id ?? S.first;
  if (listOldest === null || pageOldest < listOldest) listOldest = pageOldest;
  if (first) {
    const m = /^#v(\d+)$/.exec(location.hash);
    if (m) viewing = Math.max(S.first, Math.min(Number(m[1]), latestId()));
    if (viewing === latestId()) viewing = null;
  }
  render();
  sendSite();
  if ((S.ideas ?? []).join("\n") !== ideasSig) { ideasSig = (S.ideas ?? []).join("\n"); nextIdea(); }
}

// The suggestion box's placeholder: the model's ideas for the newest version, a new one after every suggestion
// sent, never the same one twice for this viewer. Model text, so it only ever goes in the placeholder attribute.
let ideasSig = "";
const usedIdeas = new Set();
function nextIdea() {
  const pick = (S?.ideas ?? []).find((i) => !usedIdeas.has(i));
  if (!pick) return;
  usedIdeas.add(pick);
  text.placeholder = pick;
}

// Some proxies (Cloudflare quick tunnels) hold back the event stream. If nothing arrives soon, poll instead.
let streamWorks = false;
let polling = null;
async function poll() {
  if (streamWorks) { clearInterval(polling); polling = null; return; }
  await refresh();
}
async function refresh() {
  try {
    // Once we have the history, only the newest few versions (they're merged in, like broadcasts). The full state
    // again when that leaves a gap (a tab that slept through many versions) or the database was reset.
    const had = S;
    let r = await fetch(had ? "/api/state?recent=1" : "/api/state");
    if (!r.ok) return;
    let data = await r.json();
    if (had && (data.dbId !== had.dbId || (data.history[0]?.id ?? 0) > had.current + 1)) {
      r = await fetch("/api/state");
      if (!r.ok) return;
      data = await r.json();
    }
    progress = data.progress ?? null;
    takeCode(progress);
    delete data.progress;
    applyState(data);
  } catch {}
}

// Live updates: a WebSocket (/api/ws), which also carries our cursor and shared items up; an event stream
// (/api/events) where WebSockets don't get through (we post those instead); polling where neither does.
// If the connection dies without the browser noticing (sleep, network change) or is refused (too many tabs),
// nothing arrives; a watchdog then reconnects, and polls in the meantime so the page keeps moving.
let es = null, ws = null, lastEvent = 0;
let wsWorked = false;       // a WebSocket has worked on this page (so a failed one is the server, not the network)
let wsBroken = false;       // WebSockets don't get through here: use the event stream
let wsTries = 0, wsTimer = null;
const handlers = {
  ping() {},
  hello(d) {
    me = d; cursorKey = null; cursorsData = null; syncCursorKey();
    if (me.me) { meInfo = me.me; sendSite(); }
  },
  me(d) { meInfo = d; sendSite(); },
  people(d) { if (S) { S.people = d.people; sendSite(); } },
  cursors(d) { cursorsData = d; sendCursors(); },
  shared(d) { takeShared(d); },
  "shared-reset"(d) { sharedReset(d); },
  "chrome-cursors"(d) { chromeData = d; renderChromeCursors(); },
  state(d) { applyState(d); },
  viewers(d) { if (S) { S.viewers = d.viewers; renderViewers(); sendSite(); } },
  draft(d) { takeDraft(d); },
  progress(d) {
    const before = progress?.draft;
    progress = d;
    takeCode(progress);
    if (!S) return;
    renderNow();
    if (progress.draft !== before) { renderStage(); sendSite(); }
  },
};
function onEvent(name, d) {
  lastEvent = Date.now(); streamWorks = true;
  if (Object.hasOwn(handlers, name)) handlers[name](d);
}
// Sends over the WebSocket if there's one open; false if not (then the caller posts instead).
function liveSend(m) {
  if (ws?.readyState !== WebSocket.OPEN) return false;
  ws.send(JSON.stringify(m));
  return true;
}
function closeLive() {
  clearTimeout(wsTimer); wsTimer = null;
  es?.close(); es = null;
  if (ws) { const w = ws; ws = null; w.onclose = w.onmessage = null; try { w.close(); } catch {} }
}
function connect() {
  closeLive();
  if (!wsBroken && "WebSocket" in window) return connectWs();
  es = new EventSource("/api/events?delta=1");   // delta: we take incremental progress and drafts
  for (const name of Object.keys(handlers)) es.addEventListener(name, (e) => { try { onEvent(name, JSON.parse(e.data)); } catch {} });
  const self = es;
  setTimeout(() => { if (!streamWorks && es === self) { self.close(); startPolling(); } }, 4000);
}
function connectWs() {
  const w = ws = new WebSocket(location.origin.replace(/^http/, "ws") + "/api/ws");
  let got = false;
  w.onmessage = (e) => {
    if (!got) { got = true; wsWorked = true; wsTries = 0; }
    let m;
    try { m = JSON.parse(e.data); } catch { return; }
    if (m && typeof m.event === "string") onEvent(m.event, m.data);
  };
  // Never got a message: on a network where it never worked, use the event stream; where it did, the server is
  // restarting or busy, so try again (after a growing wait, then the event stream). Closed after working (a
  // reload sends 1012): reconnect after a short random wait, so open pages don't all come back at once.
  const failed = () => {
    if (ws !== w) return;
    ws = null; w.onclose = w.onmessage = null;
    try { w.close(); } catch {}
    streamWorks = false;
    if (got) { wsTimer = setTimeout(connect, 200 + Math.random() * 1800); return; }
    if (!wsWorked || ++wsTries > 5) { wsBroken = true; return connect(); }
    wsTimer = setTimeout(connect, Math.min(30_000, 1000 * 2 ** wsTries) * (0.5 + Math.random()));
  };
  w.onclose = failed;
  setTimeout(() => { if (!got) failed(); }, 4000);
}
function startPolling() {
  streamWorks = false;
  poll();
  polling ??= setInterval(poll, 3000);
}
setInterval(() => {
  if (!streamWorks || document.hidden) return;
  if ((!es && !ws) || es?.readyState === EventSource.CLOSED || Date.now() - lastEvent > 45_000) {
    startPolling();     // keep the page current until the connection is back
    connect();
  }
}, 5000);
// Coming back to a tab that slept: catch up at once rather than waiting for the watchdog.
document.addEventListener("visibilitychange", () => { if (!document.hidden && Date.now() - lastEvent > 45_000) { poll(); connect(); } });

adminFromHash();
// The server puts the current state in the page (#boot), so the first paint already has the lists filled in and
// nothing jumps when the stream's first state arrives.
try {
  const boot = JSON.parse($("boot")?.textContent || "null");
  if (boot) { progress = boot.progress ?? null; takeCode(progress); delete boot.progress; applyState(boot); }
} catch {}
connect();
setInterval(tickElapsed, 1000);
setInterval(() => { if (S) { renderHistoryTimes(); renderStage(); renderQueue(); renderRules(); renderLore(); renderSchedules(); renderMine(); } }, 15_000);
