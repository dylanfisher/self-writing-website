// Placeholder ideas for the suggestion box: a few short, fresh suggestions written by the local model after each
// new version, based on the page as it is now and the last change. Untrusted model text: the page only ever puts
// it in the textarea's placeholder attribute.
// The same call writes the reactions for the react button (a few words or emoji anyone here can send to everyone):
// reading the page is most of the call, so a second section costs well under a second. Also untrusted: shown
// with textContent only, in the shell and inside the sandboxed page.

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
    body: JSON.stringify({ model: MODEL, messages, max_tokens: 420, temperature: 1.0, top_p: 0.95, top_k: 40,
      chat_template_kwargs: { enable_thinking: false } }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`model HTTP ${res.status}`);
  return (await res.json()).choices?.[0]?.message?.content ?? "";
}

const PAGE_CHARS = 6000;    // enough of the page to know what's on it; keeps the prompt short
const WANT = 8;
const MAX_LEN = 70;
const REACT_WANT = 5;       // plus the fixed greeting the server puts first
const REACT_MAX = 24;       // characters (UTF-16 units: emoji count double)

const SYSTEM = `You suggest ideas for a web page that anonymous visitors keep changing, one suggestion at a time.
Given the current page and the latest change, write ${WANT} different suggestions a curious visitor might type next.
- Each one short (3 to 10 words), lowercase, casual, like a person typing into a box: "make the moon wink at me".
- Most should build on what's on the page now or play off the latest change; one or two can be a wild new idea.
- All different from each other and from the recent suggestions listed. Nothing hateful, sexual or about real people.
Then write ${REACT_WANT} quick reactions: what people here might send to everyone else in the room as they watch the
page change, by tapping a button (it floats up over the page for all to see).
- Each one tiny: an emoji or two, a few words, or both, at most ${REACT_MAX} characters: "🌙 so pretty", "lol what", "😱😱😱".
- About what's on the page right now and the latest change (never about your suggestions above: those haven't
  happened), and the room: how many people are here. A mix: delighted, funny, shocked, teasing, cheering. Different from the previous reactions listed, and from each other.
- Never "hi" or "hello" (there's always a greeting already). Nothing mean, hateful, sexual or about real people.
Reply in exactly this form, nothing else (no numbers, quotes or bullets):
IDEAS
<${WANT} lines, one suggestion each>
REACTIONS
<${REACT_WANT} lines, one reaction each>`;

// Ideas served so far (and recent suggestion texts), so none ever comes back.
const seen = new Set();
const norm = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

// Untrusted model text on one line: control and direction-override characters out, list marks and quotes off.
const bare = (line) => line.replace(/[\p{Cc}\u202a-\u202e\u2066-\u2069]/gu, "").trim();
const unquote = (line) => line.replace(/^["'“]+|["'”]+$/g, "").trim();
// An idea loses any leading digits and marks; a reaction only a list mark ("1. ", "- "), so "10/10" survives.
const cleanIdea = (line) => unquote(bare(line).replace(/^[\s\-*•\d.)]+/, ""));
const cleanReaction = (line) => unquote(bare(line).replace(/^(\d{1,2}[.)]|[-*•])\s+/u, ""));
const unsafe = (line) => /[<>{}]|https?:|www\.|\.(com|net|org|io)\b/i.test(line) || sensitiveInput(`<input ${line}>`);

// page: current HTML. last: the latest suggestion text (or null). recent: recent suggestion texts.
// room: { viewers, reactions (the current ones), sent ([[text, times sent]] lately, most first) }.
// Returns { ideas, reactions }: up to WANT new ideas and up to REACT_WANT reactions; [] for either on any problem
// (the box and the button keep their previous ones).
export async function makeIdeas(page, last, recent = [], room = {}) {
  for (const r of recent) seen.add(norm(r));
  const prev = room.reactions ?? [], sent = room.sent ?? [];
  const user = `Current page:\n${String(page).slice(0, PAGE_CHARS)}\n\n` +
    (last ? `Latest change, just made: "${String(last).slice(0, 200)}"\n\n` : "") +
    (recent.length ? `Recent suggestions (don't repeat these):\n${recent.slice(0, 20).map((r) => `- ${String(r).slice(0, 120)}`).join("\n")}\n\n` : "") +
    `People here now: ${Math.max(1, room.viewers ?? 1)}.\n` +
    (prev.length ? `Previous reactions (write new ones): ${prev.map((r) => JSON.stringify(r)).join(", ")}\n` : "") +
    (sent.length ? `Reactions people sent lately: ${sent.slice(0, 8).map(([t, n]) => `${JSON.stringify(t)} ×${n}`).join(", ")}\n` : "") +
    `\nWrite ${WANT} new suggestions, then ${REACT_WANT} reactions.`;
  let text;
  try {
    text = await ask([{ role: "system", content: SYSTEM }, { role: "user", content: user }]);
  } catch {
    return { ideas: [], reactions: [] };
  }
  text = text.replace(/<think>[\s\S]*?<\/think>/gi, "");
  // Lines before REACTIONS are ideas (a reply without the headings is all ideas).
  const m = /^\s*\**\s*REACTIONS\b.*$/im.exec(text);
  const ideaText = m ? text.slice(0, m.index) : text, reactText = m ? text.slice(m.index + m[0].length) : "";
  const ideas = [];
  for (let line of ideaText.split("\n")) {
    line = cleanIdea(line);
    if (/^\**\s*IDEAS\b/i.test(line)) continue;
    if (line.length < 6 || line.length > MAX_LEN || unsafe(line)) continue;
    const k = norm(line);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    ideas.push(line);
  }
  const reactions = [], had = new Set(["hi", "hello", "hey"]);
  for (let line of reactText.split("\n")) {
    line = cleanReaction(line).replace(/\s+/g, " ");
    if (!line || line.length > REACT_MAX || unsafe(line)) continue;
    const k = norm(line) || line;   // emoji-only lines norm to ""
    if (had.has(k)) continue;
    had.add(k);
    reactions.push(line);
  }
  return { ideas: ideas.slice(0, WANT), reactions: reactions.slice(0, REACT_WANT) };
}
