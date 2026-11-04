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

let frameTimer = null;
// frameReady: the frame has loaded shownSrc (or was patched to it), so it can be patched again.
// frameExact: what's on screen is exactly what loading shownSrc would show (a patch can be close but not exact).
let frameReady = false, frameExact = true;
function setFrame(src) {
  if (src === shownSrc) return;
  shownSrc = src;
  frameReady = false;
  // While dragging the timeline, only load the version the thumb settles on.
  clearTimeout(frameTimer);
  frameTimer = setTimeout(() => { $("frame").src = src; }, $("frame").src ? 90 : 0);
}
$("frame").addEventListener("load", () => { frameReady = true; frameExact = true; });
// Replies from lib/shim.js in the frame. The page's own scripts could send these too; at worst a page isn't reloaded.
addEventListener("message", (e) => {
  if (e.source !== $("frame").contentWindow || e.data?.srp !== "morphed") return;
  clearTimeout(morphTimer);
  if (e.data.failed) frameReady = false;   // it's loading the draft instead
  else frameExact = e.data.exact === true;
});

// Live drafts: the frame patches itself from the draft on screen to the next one instead of reloading
// (lib/shim.js). The HTML is model output: it's only ever handed to the sandboxed frame, never used here.
let draftData = null;   // the latest "draft" event: { draft, prev, version, from, html }
let morphTimer = null;
function showDraft(n) {
  const src = `${S.sandboxOrigin}/d/${n}?db=${S.dbId}`;
  if (src === shownSrc) return;
  const d = draftData?.draft === n ? draftData : null;
  const from = d && `${S.sandboxOrigin}/${d.prev ? `d/${d.prev}` : `v/${d.version}`}?db=${S.dbId}`;
  if (!d || !frameReady || shownSrc !== from) return setFrame(src);
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
  const src = `${S.sandboxOrigin}/v/${id}?db=${S.dbId}`;
  // The finished version is exactly the draft on screen: keep it (same page, same origin and CSP), no reload.
  if (S.drafted?.version === id && frameExact && shownSrc === `${S.sandboxOrigin}/d/${S.drafted.draft}?db=${S.dbId}`) {
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
function renderHistory(force = false) {
  $("history-count").textContent = S.total;
  // Polling re-sends the state every few seconds; only rebuild the list when it changed (or to refresh times).
  const sig = `${S.current}|${listOldest}|${versions.size}|${S.history.filter((v) => v.broken).length}|${!!admin}`;
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
      h("div", { class: "vtip-meta" }, meta),
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
      h("span", { class: "txt" }, s.text),
      mine.has(s.id) ? h("span", { class: "tag" }, "yours") : h("span", { class: "tag" }, ago(s.created_at)),
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
  // The model's status line for each edit; the last one is being written (until the browser test starts).
  const steps = p?.steps ?? [];
  const writing = p?.stage !== "testing";
  $("now-steps").replaceChildren(
    ...(p?.rule ? [h("li", { class: "rule" }, `New rule: ${p.rule}`)] : []),
    ...steps.map((s, i) => h("li", { class: writing && i === steps.length - 1 ? "current" : "" }, s)));
  $("now-code").hidden = !showCode;
  if (showCode) $("now-code").textContent = p?.tail || "Waiting for the first lines…";   // text, never HTML
  $("code-toggle").textContent = showCode ? "Hide code" : "Show code";
  tickElapsed();
}

function tickElapsed() {
  const r = S?.running;
  if (!r || !r.started_at) return;
  const s = Math.max(0, Math.round((Date.now() - r.started_at) / 1000));
  const p = progress && progress.id === r.id ? progress : null;
  const stage = { writing: "writing", testing: "testing in a browser", fixing: "fixing a bug it found", shrinking: "too long, trimming",
    retrying: "an edit missed, retrying" }[p?.stage] ?? "writing";
  $("now-elapsed").textContent = `${s}s · ${stage}${p && p.stage !== "testing" ? ` · ${Math.round(p.chars / 100) / 10} KB` : ""}`;
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
    msg.textContent = rule ? `Yours became v${rec.version_id} and a standing rule: “${rule.text}”.` : `Yours became v${rec.version_id}.`;
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

// "?" and "i" boxes: click to open, click outside or Esc to close. One open at a time.
const pops = [...document.querySelectorAll(".help")].map((w) => ({ btn: w.querySelector(".help-btn"), box: w.querySelector(".help-box") }));
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
$("history-scroll").closest(".side").addEventListener("scroll", () => setHelp(false), { passive: true });
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
    $("turnstile").hidden = false;
    tsWidget = window.turnstile.render("#turnstile", {
      sitekey: key, appearance: "interaction-only", size: "flexible",
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

function applyState(next) {
  const first = !S;
  S = next;
  if (build === null) build = S.build ?? null;
  else if (S.build && S.build !== build) { build = S.build; reloadForUpdate(); }
  for (const v of S.history) versions.set(v.id, v);
  const pageOldest = S.history[0]?.id ?? S.first;
  if (listOldest === null || pageOldest < listOldest) listOldest = pageOldest;
  if (first) {
    const m = /^#v(\d+)$/.exec(location.hash);
    if (m) viewing = Math.max(S.first, Math.min(Number(m[1]), latestId()));
    if (viewing === latestId()) viewing = null;
  }
  render();
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
    const r = await fetch("/api/state");
    if (!r.ok) return;
    const data = await r.json();
    progress = data.progress ?? null;
    delete data.progress;
    applyState(data);
  } catch {}
}

// Live updates. If the stream dies without the browser noticing (sleep, network change) or is refused (too many
// tabs), nothing arrives; a watchdog then reconnects, and polls in the meantime so the page keeps moving.
let es = null, lastEvent = 0;
function connect() {
  es?.close();
  es = new EventSource("/api/events");
  const alive = () => { lastEvent = Date.now(); streamWorks = true; };
  es.addEventListener("ping", alive);
  es.addEventListener("state", (e) => { alive(); applyState(JSON.parse(e.data)); });
  es.addEventListener("viewers", (e) => { alive(); if (S) { S.viewers = JSON.parse(e.data).viewers; renderViewers(); } });
  es.addEventListener("draft", (e) => { alive(); draftData = JSON.parse(e.data); });
  es.addEventListener("progress", (e) => {
    alive();
    const before = progress?.draft;
    progress = JSON.parse(e.data);
    if (!S) return;
    renderNow();
    if (progress.draft !== before) renderStage();
  });
  const self = es;
  setTimeout(() => { if (!streamWorks && es === self) { self.close(); startPolling(); } }, 4000);
}
function startPolling() {
  streamWorks = false;
  poll();
  polling ??= setInterval(poll, 3000);
}
setInterval(() => {
  if (!streamWorks || document.hidden) return;
  if (es.readyState === EventSource.CLOSED || Date.now() - lastEvent > 45_000) {
    startPolling();     // keep the page current until the stream is back
    connect();
  }
}, 5000);
// Coming back to a tab that slept: catch up at once rather than waiting for the watchdog.
document.addEventListener("visibilitychange", () => { if (!document.hidden && Date.now() - lastEvent > 45_000) { poll(); connect(); } });

adminFromHash();
connect();
setInterval(tickElapsed, 1000);
setInterval(() => { if (S) { renderHistory(true); renderStage(); renderQueue(); renderRules(); renderMine(); } }, 15_000);
