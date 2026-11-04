#!/usr/bin/env node
// Runs server.mjs as a cluster worker and keeps the site's ports open across code reloads, so a deploy never
// shows anyone an error page. This process owns ports 3000/3001 (so `lsof -tiTCP:3000 -sTCP:LISTEN` finds it) and
// is kept tiny so it never needs reloading itself.
//
// kill -USR2 <this pid>: reload with no downtime.
//   1. The live worker finishes the suggestion being written (starting no new one) and says "drained".
//   2. A new worker starts with the new code; the old one keeps serving meanwhile.
//   3. Once the new one listens ("ready"), the old one stops taking connections and exits. Open pages' event streams
//      reconnect to the new one by themselves.
//   If the new code exits or hangs before it's ready, it's dropped and the old worker carries on (see its error in
//   the log). A second USR2 while waiting, or a suggestion past its time limit, replaces the worker at once: that
//   suggestion fails and there's a gap of about a second, like a plain restart.
// A worker that crashes is started again (after 5 s if it died within 10 s of starting, so it doesn't spin).
// SIGINT/SIGTERM: stop the worker(s) and exit 0.
import cluster from "node:cluster";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
process.chdir(ROOT);
cluster.setupPrimary({ exec: join(ROOT, "server.mjs") });

const START_MS = 60_000;   // a new worker that isn't listening by then is dropped
const log = (s) => console.log(`${new Date().toLocaleString("sv").slice(0, 19)} run: ${s}`);

// Read for every new worker, so a reload picks up new keys (the values never go to the log).
function secrets() {
  const env = {};
  try {
    for (const line of readFileSync(join(ROOT, "data/secrets.env"), "utf8").split("\n")) {
      const m = /^\s*(?:export\s+)?([A-Za-z_]\w*)=(.*?)\s*$/.exec(line);
      if (m) env[m[1]] = m[2].replace(/^(["'])(.*)\1$/, "$2");
    }
  } catch {}
  return env;
}

let live = null;            // the worker serving the site
let next = null;            // the new worker during a reload, until it's ready
let phase = null;           // null | "draining" (live finishing its suggestion) | "starting" (next) | "replacing"
let stopping = false;
const retired = new WeakSet();   // workers told to exit
const startedAt = new WeakMap();
let startTimer = null;

function fork() {
  const w = cluster.fork(secrets());
  startedAt.set(w, Date.now());
  w.on("message", (m) => onMessage(w, m));
  w.on("exit", (code, signal) => onExit(w, code, signal));
  return w;
}

function retire(w) {
  if (!w || retired.has(w)) return;
  retired.add(w);
  try { w.send({ cmd: "exit" }); } catch {}
  setTimeout(() => { if (!w.isDead()) w.process.kill("SIGKILL"); }, 15_000).unref();
}

function onMessage(w, m) {
  if (m?.cmd === "drained" && w === live && phase === "draining") {
    if (m.busy) { log("the suggestion ran past its time limit; replacing the worker now"); return replace(); }
    phase = "starting";
    log("starting the new code");
    next = fork();
    startTimer = setTimeout(() => {
      if (next && !next.isDead()) { log(`the new code isn't listening after ${START_MS / 1000} s; dropping it`); next.process.kill("SIGKILL"); }
    }, START_MS);
  } else if (m?.cmd === "ready" && w === next) {
    clearTimeout(startTimer);
    const old = live;
    live = next; next = null; phase = null;
    retire(old);
    log(`reload done: worker ${live.process.pid} is live`);
  } else if (m?.cmd === "ready" && w === live && !retired.has(w)) {
    log(`worker ${w.process.pid} is live`);
  }
}

// No overlap: the live worker is still writing a suggestion, and two workers must never write at once.
function replace() {
  phase = "replacing";
  retire(live);   // onExit starts the new one
}

function onExit(w, code, signal) {
  const how = signal ? `signal ${signal}` : `code ${code}`;
  if (stopping) {
    if (!Object.keys(cluster.workers).length) process.exit(0);
    return;
  }
  if (w === next) {   // the new code failed to start: keep the old
    clearTimeout(startTimer);
    next = null; phase = null;
    log(`reload failed: the new code exited (${how}) before it was ready; the old code keeps running (see the error above)`);
    if (live && !live.isDead()) { try { live.send({ cmd: "resume" }); } catch {} }
    else live = fork();
    return;
  }
  if (retired.has(w)) {
    if (w === live && phase === "replacing") { phase = null; live = fork(); }
    return;
  }
  if (w !== live) return;
  // A crash. If a reload was waiting on this worker, it's moot now: the new worker is the new code anyway.
  live = null;
  if (next) { log(`worker exited (${how}); the new code takes over when it's ready`); return; }
  phase = null;
  const quick = Date.now() - (startedAt.get(w) ?? 0) < 10_000;
  log(`worker exited (${how}); starting it again${quick ? " in 5 s" : ""}`);
  setTimeout(() => { if (!stopping && !live) live = fork(); }, quick ? 5000 : 0);
}

process.on("SIGUSR2", () => {
  if (stopping) return;
  if (!live) return log("SIGUSR2: no worker running yet; ignored");
  if (phase === "draining") { log("SIGUSR2 again: replacing the worker now (the suggestion being written fails)"); return replace(); }
  if (phase) return log(`SIGUSR2: a reload is already ${phase}`);
  phase = "draining";
  log("SIGUSR2: reloading once the current suggestion is done (the site stays up)");
  try { live.send({ cmd: "drain" }); } catch { phase = null; }
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    if (stopping) return;
    stopping = true;
    log(`${sig}: stopping`);
    const workers = Object.values(cluster.workers);
    if (!workers.length) process.exit(0);
    for (const w of workers) w.process.kill("SIGTERM");
    setTimeout(() => process.exit(0), 10_000).unref();
  });
}

live = fork();
