// Moves every <script> in a page to just before </body>, in their original order. A script runs as soon as the
// browser reaches it, so one placed above the elements it looks up gets null and crashes (the model often adds a
// script right after the element it edits). At the end of <body>, every element exists when scripts run.
//
// Scripts inside <svg> stay put (they belong to the SVG). Text that only looks like a script is skipped the way
// the browser skips it: inside comments and inside <style>, <textarea>, <title>, <template>, <xmp>. A page this
// can't read cleanly (an unclosed <script> or comment) is returned unchanged. Running it twice changes nothing.

// Where the body ends: the last </body>, else the last </html>, else the end of the page. (Many pages have no
// </body>; the browser ends the body at the end of the file then, so scripts go there.)
function bodyEndOf(html) {
  const last = (re) => { let at = -1; for (const m of html.matchAll(re)) at = m.index; return at; };
  const b = last(/<\/body\s*>/gi);
  if (b >= 0) return b;
  const h = last(/<\/html\s*>/gi);
  return h >= 0 ? h : html.length;
}

const OPEN = /<!--|<(script|style|textarea|title|template|xmp|svg)\b/gi;

export function scriptsLast(html) {
  const scripts = [];   // [start, end] of each <script>…</script> to move
  OPEN.lastIndex = 0;
  for (let m; (m = OPEN.exec(html)); ) {
    const tag = m[1]?.toLowerCase();
    if (!tag) {   // comment
      const end = html.indexOf("-->", m.index + 4);
      if (end < 0) return html;
      OPEN.lastIndex = end + 3;
      continue;
    }
    const close = new RegExp(`</${tag}\\s*>`, "gi");
    close.lastIndex = OPEN.lastIndex;
    const c = close.exec(html);
    if (!c) return html;   // unclosed: leave the page alone
    if (tag === "script") scripts.push([m.index, close.lastIndex]);
    OPEN.lastIndex = close.lastIndex;
  }
  if (!scripts.length) return html;
  const bodyEnd = bodyEndOf(html);
  // A script after </body> (the browser moves those back into <body> anyway) stays where it is.
  const moving = scripts.filter(([, e]) => e <= bodyEnd);
  if (!moving.length) return html;
  // Already last: nothing but whitespace between the scripts and </body>.
  let tail = bodyEnd;
  for (let i = moving.length - 1; i >= 0 && /^\s*$/.test(html.slice(moving[i][1], tail)); i--) tail = moving[i][0];
  if (tail === moving[0][0]) return html;

  // Cut each script along with the indentation before it and the line break after it, when it sits on lines of its
  // own, so no blank lines are left behind.
  let out = "", from = 0;
  const blocks = [];
  for (let [s, e] of moving) {
    const lineStart = html.lastIndexOf("\n", s - 1) + 1;
    const ownLine = /^[ \t]*$/.test(html.slice(lineStart, s));
    const after = /^[ \t]*\r?\n/.exec(html.slice(e));
    if (ownLine && after) { s = lineStart; e += after[0].length; }
    blocks.push(html.slice(s, e).replace(/^[ \t]+/, "").replace(/\s+$/, ""));
    out += html.slice(from, s);
    from = e;
  }
  const rest = html.slice(from);
  const at = bodyEndOf(rest);
  const before = rest.slice(0, at).replace(/\s*$/, "\n");
  return out + before + blocks.join("\n") + "\n" + rest.slice(at);
}
