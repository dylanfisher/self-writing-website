// Traffic counts for our own logs (read them with scripts/stats.mjs). Totals are kept in memory and written to the
// database once a minute, so the cost per request is a few additions.
//
// These count only what reaches this machine. Requests Cloudflare answers from its cache never get here; its own
// dashboard (Analytics) has the totals for everything visitors downloaded.
//
//   traffic   (day, host, route) → requests, bytes_in, bytes_out    bytes are bodies only, not headers
//   visitors  (day, ip_hash)      one row per visitor per day        same salted hash as suggestions use
//   daily     (day)               peak_viewers                       most people on the page at once

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS traffic (
    day TEXT NOT NULL, host TEXT NOT NULL, route TEXT NOT NULL,
    requests INTEGER NOT NULL DEFAULT 0, bytes_in INTEGER NOT NULL DEFAULT 0, bytes_out INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (day, host, route)
  ) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS visitors (day TEXT NOT NULL, ip_hash TEXT NOT NULL, PRIMARY KEY (day, ip_hash)) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS daily (day TEXT PRIMARY KEY, peak_viewers INTEGER NOT NULL DEFAULT 0);
`;

// Local date, e.g. "2026-11-03". Recomputed once a minute rather than per request.
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

const size = (chunk) => typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk?.length ?? 0;

export function makeStats(db) {
  db.exec(SCHEMA);
  const addTraffic = db.prepare(`INSERT INTO traffic (day, host, route, requests, bytes_in, bytes_out) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (day, host, route) DO UPDATE SET requests = requests + excluded.requests,
      bytes_in = bytes_in + excluded.bytes_in, bytes_out = bytes_out + excluded.bytes_out`);
  const addVisitor = db.prepare("INSERT OR IGNORE INTO visitors (day, ip_hash) VALUES (?, ?)");
  const setPeak = db.prepare(`INSERT INTO daily (day, peak_viewers) VALUES (?, ?)
    ON CONFLICT (day) DO UPDATE SET peak_viewers = MAX(peak_viewers, excluded.peak_viewers)`);

  let day = today();
  let counts = new Map();     // "day\thost\troute" → { requests, bytesIn, bytesOut }
  let seen = new Set();       // "day\tip_hash"
  let peaks = new Map();      // day → most viewers

  const bucket = (host, route) => {
    const key = `${day}\t${host}\t${route}`;
    let b = counts.get(key);
    if (!b) counts.set(key, b = { requests: 0, bytesIn: 0, bytesOut: 0 });
    return b;
  };

  function flush() {
    const c = counts, s = seen, p = peaks;
    counts = new Map(); seen = new Set(); peaks = new Map();
    day = today();
    if (!c.size && !s.size && !p.size) return;
    try {
      db.exec("BEGIN");
      for (const [key, b] of c) addTraffic.run(...key.split("\t"), b.requests, b.bytesIn, b.bytesOut);
      for (const key of s) addVisitor.run(...key.split("\t"));
      for (const [d, n] of p) setPeak.run(d, n);
      db.exec("COMMIT");
    } catch (err) {
      try { db.exec("ROLLBACK"); } catch {}
      console.log(`stats not saved: ${err.message}`);
    }
  }
  setInterval(flush, 60_000).unref();

  return {
    flush,
    // Counts every request to server. routeOf(path) must return one of a fixed set of names (never the raw path,
    // which anyone can make up). Runs before the server's own handler so it sees the whole response.
    track(server, host, routeOf) {
      server.prependListener("request", (req, res) => {
        let path = "/";
        try { path = new URL(req.url, "http://x").pathname; } catch {}
        const route = routeOf(path);
        const b = bucket(host, route);
        b.requests++;
        b.bytesIn += Number(req.headers["content-length"]) || 0;
        // Counted as written (looking the bucket up again each time), so a long-lived event stream adds up as it
        // goes and lands in the right day.
        const write = res.write, end = res.end;
        res.write = function (chunk, ...rest) { bucket(host, route).bytesOut += size(chunk); return write.call(this, chunk, ...rest); };
        res.end = function (chunk, ...rest) {
          if (typeof chunk !== "function") bucket(host, route).bytesOut += size(chunk);
          return end.call(this, chunk, ...rest);
        };
      });
    },
    visitor(ipHash) { seen.add(`${day}\t${ipHash}`); },
    viewers(n) { if (n > (peaks.get(day) ?? 0)) peaks.set(day, n); },
  };
}
