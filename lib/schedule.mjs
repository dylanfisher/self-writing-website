// Scheduled changes: "SCHEDULE: daily 07:00 | make it sunny" or "SCHEDULE: 2026-11-05 08:00 | add a cake" (see
// SYSTEM in lib/model.mjs). Times are the site's own clock: the server's local time zone, DST included.

const pad = (n) => String(n).padStart(2, "0");

// The "when" part of a SCHEDULE line → { daily, h, m, at?, spec } or null. spec is the normalized form that's
// stored and shown to the model ("daily 07:00", "2026-11-05 08:00"). at: the moment of a one-off, in ms.
export function parseWhen(s) {
  const t = String(s ?? "").trim().replace(/\s+/g, " ");
  let m = /^(?:daily|every ?day)(?: at)? (\d{1,2}):(\d{2})$/i.exec(t);
  if (m) {
    const h = Number(m[1]), min = Number(m[2]);
    if (h > 23 || min > 59) return null;
    return { daily: true, h, m: min, spec: `daily ${pad(h)}:${pad(min)}` };
  }
  m = /^(?:once )?(\d{4})-(\d{2})-(\d{2})(?: at|T| )\s*(\d{1,2}):(\d{2})$/i.exec(t);
  if (m) {
    const [y, mo, d, h, min] = m.slice(1).map(Number);
    const date = new Date(y, mo - 1, d, h, min);
    // Rejects 2026-02-30 and 25:00, which Date would roll over into another day.
    if (date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d || date.getHours() !== h || date.getMinutes() !== min) return null;
    return { daily: false, h, m: min, at: date.getTime(), spec: `${y}-${pad(mo)}-${pad(d)} ${pad(h)}:${pad(min)}` };
  }
  return null;
}

// The next time a schedule fires strictly after `after` (ms), or null if a one-off is already past.
export function nextRun(when, after = Date.now()) {
  if (!when.daily) return when.at > after ? when.at : null;
  const d = new Date(after);
  d.setHours(when.h, when.m, 0, 0);
  if (d.getTime() <= after) { d.setDate(d.getDate() + 1); d.setHours(when.h, when.m, 0, 0); }
  return d.getTime();
}

// For the prompt: "every day at 07:00", "on 2026-11-05 at 08:00".
export function describeWhen(spec) {
  const w = parseWhen(spec);
  if (!w) return String(spec);
  const hm = `${pad(w.h)}:${pad(w.m)}`;
  return w.daily ? `every day at ${hm}` : `on ${w.spec.slice(0, 10)} at ${hm}`;
}

// "Wednesday 2026-11-04 02:01": the site's clock right now, for the prompt.
export function siteNow(now = Date.now()) {
  const d = new Date(now);
  const day = d.toLocaleDateString("en-US", { weekday: "long" });
  return `${day} ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
