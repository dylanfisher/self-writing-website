// Placeholder ideas for the suggestion box: a few short, fresh suggestions written by the local model after each
// new version, based on the page as it is now and the last change. Untrusted model text: the page only ever puts
// it in the textarea's placeholder attribute.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { API, MODEL, sensitiveInput } from "./model.mjs";

let apiKey;
const key = () => (apiKey ??= process.env.MODEL_API_KEY ?? readFileSync(join(homedir(), ".omlx", "api-key"), "utf8").trim());

// One short, non-streamed call (its own, so it stays independent of the page-writing call in model.mjs).
async function ask(messages) {
  const res = await fetch(API, {
    method: "POST",
    headers: { Authorization: `Bearer ${key()}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: MODEL, messages, max_tokens: 300, temperature: 1.0, top_p: 0.95, top_k: 40,
      chat_template_kwargs: { enable_thinking: false } }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`model HTTP ${res.status}`);
  return (await res.json()).choices?.[0]?.message?.content ?? "";
}

const PAGE_CHARS = 6000;    // enough of the page to know what's on it; keeps the prompt short
const WANT = 8;
const MAX_LEN = 70;

const SYSTEM = `You suggest ideas for a web page that anonymous visitors keep changing, one suggestion at a time.
Given the current page and the latest change, write ${WANT} different suggestions a curious visitor might type next.
- Each one short (3 to 10 words), lowercase, casual, like a person typing into a box: "make the moon wink at me".
- Most should build on what's on the page now or play off the latest change; one or two can be a wild new idea.
- All different from each other and from the recent suggestions listed. Nothing hateful, sexual or about real people.
- Reply with exactly ${WANT} lines, one suggestion per line, nothing else (no numbers, quotes or bullets).`;

// Ideas served so far (and recent suggestion texts), so none ever comes back.
const seen = new Set();
const norm = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

// page: current HTML. last: the latest suggestion text (or null). recent: recent suggestion texts.
// Returns up to WANT new ideas, or [] on any problem (the box keeps its previous ones).
export async function makeIdeas(page, last, recent = []) {
  for (const r of recent) seen.add(norm(r));
  const user = `Current page:\n${String(page).slice(0, PAGE_CHARS)}\n\n` +
    (last ? `Latest change, just made: "${String(last).slice(0, 200)}"\n\n` : "") +
    (recent.length ? `Recent suggestions (don't repeat these):\n${recent.slice(0, 20).map((r) => `- ${String(r).slice(0, 120)}`).join("\n")}\n\n` : "") +
    `Write ${WANT} new suggestions.`;
  let text;
  try {
    text = await ask([{ role: "system", content: SYSTEM }, { role: "user", content: user }]);
  } catch {
    return [];
  }
  const ideas = [];
  for (let line of text.replace(/<think>[\s\S]*?<\/think>/gi, "").split("\n")) {
    line = line.replace(/[\p{Cc}‪-‮⁦-⁩]/gu, "").replace(/^[\s\-*•\d.)]+/, "").replace(/^["'“]+|["'”]+$/g, "").trim();
    if (line.length < 6 || line.length > MAX_LEN || /[<>{}]/.test(line) || sensitiveInput(`<input ${line}>`)) continue;
    const k = norm(line);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    ideas.push(line);
  }
  return ideas.slice(0, WANT);
}
