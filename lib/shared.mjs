// Shared items: what a page's scripts add with SITE.share(channel, data), seen by every visitor (see lib/shim.js).
// Data comes from model-written pages, so it's untrusted. It's only ever sent back into sandboxed pages, never put in
// the shell page. No free text for now: values are numbers, booleans, or short strings without spaces (a choice id,
// a color, a few emoji). The shim checks the same things (keep them in step) so a page learns at once, in the check.

export const CHANNEL = /^[a-z0-9-]{1,24}$/;
export const KEY = /^[A-Za-z_][A-Za-z0-9_]{0,23}$/;
export const TOKEN = /^[A-Za-z0-9#_.-]{1,16}$/;
export const EMOJI = /^(?:\p{Extended_Pictographic}|\p{Emoji_Modifier}|\p{Regional_Indicator}|‍|️|⃣){1,8}$/u;
// An item's key: random, made by the shim when it's shared (so the sharer can remove it at once), unique per era
// and channel. SITE.unshare names an item by it.
export const ITEM_KEY = /^[a-z0-9]{10}$/;
export const KEYS_MAX = 8;
export const BYTES_MAX = 300;

// A clean copy of `data`, or { error } saying what's wrong.
export function cleanData(data) {
  if (data === undefined || data === null) return { data: {} };
  if (typeof data !== "object" || Array.isArray(data)) return { error: "data must be an object like { x: 0.5, color: \"#f80\" }" };
  const keys = Object.keys(data);
  if (keys.length > KEYS_MAX) return { error: `at most ${KEYS_MAX} keys` };
  const out = {};
  for (const k of keys) {
    if (!KEY.test(k)) return { error: `bad key ${JSON.stringify(k.slice(0, 30))}` };
    const v = data[k];
    if (typeof v === "number") {
      if (!Number.isFinite(v)) return { error: `${k} is not a finite number` };
      out[k] = Math.round(Math.max(-1e9, Math.min(1e9, v)) * 1e4) / 1e4;
    } else if (typeof v === "boolean") out[k] = v;
    else if (typeof v === "string") {
      if (!TOKEN.test(v) && !EMOJI.test(v)) return { error: `${k}: strings can only be short ids, colors or emoji (no spaces, at most 16 characters), never text people typed` };
      out[k] = v;
    } else return { error: `${k} must be a number, true/false or a short string` };
  }
  if (Buffer.byteLength(JSON.stringify(out)) > BYTES_MAX) return { error: `data over ${BYTES_MAX} bytes` };
  return { data: out };
}
