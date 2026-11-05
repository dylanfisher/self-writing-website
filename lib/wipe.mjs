// Blank slate: a suggestion that asks for everything to be erased and the site started over. Instead of having the
// model delete the page edit by edit (slow, and rules, lore and schedules survive it), the server does it at once:
// the first page comes back and every standing rule, piece of lore, schedule and shared item is ended (see
// blankSlate in server.mjs). Two checks, so ordinary suggestions pay nothing and partial ones aren't caught:
//   1. looksLikeWipe: a cheap pattern on the text (a wipe verb with "everything"/"all …", or a start-over phrase).
//   2. confirmWipe: a short yes/no call to the local model, which tells "delete everything" from "delete everything
//      blue" or "start over with a cat on it".

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { API, MODEL } from "./model.mjs";

const START_OVER = /\b(blank|clean|empty) (slate|page|canvas)\b|\bstart(ing)? (it |the (page|site) )?(all )?(over|fresh|again from (nothing|scratch))\b|\bfrom scratch\b|\bfactory reset\b|\breset (it|the (whole |entire )?(page|site|thing)|everything)\b|\bwipe (it|the (whole |entire )?(page|site|thing)|everything)( clean| out)?\b|\bnuke (it|the (page|site)|everything)\b/i;
const VERB = /\b(delete|remove|clear|erase|wipe|destroy|nuke|reset|purge|get rid of|scrap|trash|kill)\b/i;
const ALL = /\beverything\b|\ball of it\b|\b(the )?(whole|entire) (page|site|thing|website)\b|\ball (the )?(rules|html|code|content|elements|memor(y|ies)|lore|javascript|css|scripts|styles)\b/i;
// "everything except the frog", "but keep the rules": not a blank slate. Left to the usual rewrite.
const KEEP = /\b(except|apart from|other than|besides|but (keep|leave|not)|keep(ing)? (the|only|just)|leave (the|only|just)|only (the|keep))\b/i;

export function looksLikeWipe(text) {
  const t = String(text ?? "");
  if (KEEP.test(t)) return false;
  return START_OVER.test(t) || (VERB.test(t) && ALL.test(t));
}

let apiKey;
const key = () => (apiKey ??= process.env.MODEL_API_KEY ?? readFileSync(join(homedir(), ".omlx", "api-key"), "utf8").trim());

const SYSTEM = `You read one suggestion that a visitor typed for a web page that visitors keep changing. Besides the page
itself, the site keeps standing rules, memories and scheduled changes from earlier suggestions.
Decide whether the visitor wants ALL of it erased so the site starts over from an empty page: all the page's content
and code, and all the rules, memories and scheduled changes, with nothing kept.
Answer NO if they want anything kept, want only some things removed (only certain elements, only the rules, only the
styling, everything of one color or kind), want something new put on the page after clearing it, or are asking a
question or joking about it. If unsure, answer NO.
Reply with one word: YES or NO.`;

// true only on a clear YES; any problem (model busy, timeout, odd reply) is false and the suggestion runs as usual.
export async function confirmWipe(text, { signal } = {}) {
  try {
    const res = await fetch(API, {
      method: "POST",
      headers: { Authorization: `Bearer ${key()}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: MODEL, max_tokens: 5, temperature: 0, chat_template_kwargs: { enable_thinking: false },
        messages: [{ role: "system", content: SYSTEM }, { role: "user", content: `Suggestion: "${String(text).slice(0, 300)}"` }] }),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
    });
    if (!res.ok) return false;
    const out = String((await res.json()).choices?.[0]?.message?.content ?? "").replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
    return /^yes\b/i.test(out);
  } catch {
    return false;
  }
}
