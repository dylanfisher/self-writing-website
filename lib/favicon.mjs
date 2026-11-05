// The site's favicon, redrawn by the local model in quiet spells to match what the page is now (an easter egg; see
// drawFavicon in server.mjs). The model writes a small SVG; it's untrusted, so it's never served: renderIcon (in
// check.mjs) draws it to a PNG in the checking browser, with scripts off and no network, and only that PNG is.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { API, MODEL } from "./model.mjs";

let apiKey;
const key = () => (apiKey ??= process.env.MODEL_API_KEY ?? readFileSync(join(homedir(), ".omlx", "api-key"), "utf8").trim());

const PAGE_CHARS = 9000;   // enough of the page to see its colors and what's on it
const SVG_CAP = 8000;      // characters of SVG we accept

const SYSTEM = `You draw the favicon (the tiny icon in the browser tab) for a web page that visitors keep changing.
Given the page as it is now, draw one icon that captures it: its main thing, character or mood, in its colors.
- Reply with ONLY one SVG element and nothing else: <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">…</svg>
- It is shown at 16 to 32 pixels: one bold, simple shape or two, thick strokes, strong contrast, no fine detail.
  No text or letters unless the page is about a single letter or symbol.
- Fill most of the 32×32 square. A background shape (like a rounded square or a circle) helps it stand out.
- Only plain shapes: rect, circle, ellipse, path, polygon, polyline, line, g, and linearGradient/radialGradient in
  defs. No script, no images, no links, no filters, no external anything.`;

// Scripts gone, whitespace squeezed: the look (CSS, markup, text) is what matters here.
const pageForPrompt = (html) => String(html).replace(/<script\b[\s\S]*?<\/script>/gi, "<script>…</script>")
  .replace(/\s+/g, " ").slice(0, PAGE_CHARS);

// html: the current page. context: { era, lore: [text], recent: [suggestion text] }. Returns { svg } or { error }.
export async function drawIcon(html, { era, lore = [], recent = [], signal } = {}) {
  const user = `Current page:\n${pageForPrompt(html)}\n\n` +
    (era ? `The page's current era is called "${String(era).slice(0, 60)}".\n` : "") +
    (lore.length ? `What the page remembers about its world:\n${lore.slice(0, 12).map((l) => `- ${String(l).slice(0, 160)}`).join("\n")}\n` : "") +
    (recent.length ? `Latest changes visitors asked for, newest first:\n${recent.slice(0, 5).map((r) => `- ${String(r).slice(0, 160)}`).join("\n")}\n` : "") +
    `\nDraw the favicon.`;
  let text;
  try {
    const res = await fetch(API, {
      method: "POST",
      headers: { Authorization: `Bearer ${key()}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: MODEL, messages: [{ role: "system", content: SYSTEM }, { role: "user", content: user }],
        max_tokens: 2500, temperature: 0.8, top_p: 0.95, top_k: 40, chat_template_kwargs: { enable_thinking: false } }),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(120_000)]) : AbortSignal.timeout(120_000),
    });
    if (!res.ok) return { error: `model HTTP ${res.status}` };
    text = (await res.json()).choices?.[0]?.message?.content ?? "";
  } catch (err) {
    return { error: err.name === "AbortError" ? "stopped" : err.message };
  }
  const svg = /<svg\b[\s\S]*?<\/svg>/i.exec(text.replace(/<think>[\s\S]*?<\/think>/gi, ""))?.[0];
  if (!svg) return { error: "no <svg> in the reply" };
  if (svg.length > SVG_CAP) return { error: `SVG too long (${svg.length} characters)` };
  return { svg };
}
