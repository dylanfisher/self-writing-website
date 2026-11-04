// Fast checks on a candidate page, run before the (slower) headless browser. Milliseconds, no model, no browser.
// Unlike the browser, which stops each script at its first error, these report every problem at once.
//
// lint(html) → { problems: [{ key, msg, fatal }], missing: [msg] }
//   problems: things to send back to the model. `key` identifies the problem without line numbers, so a caller
//             can tell which problems an edit introduced (compare against lint(previousPage)). `fatal` problems
//             (JavaScript syntax errors) break the page for sure; the rest are very likely mistakes.
//   missing:  scripts looking up ids that aren't on the page. Only a hint: guarded code (`if (el)`) is fine,
//             so these are passed along with a real browser error, never used to reject a page on their own.

import vm from "node:vm";

const lineAt = (html, index) => html.slice(0, index).split("\n").length;
const snippet = (html, line) => html.split("\n")[line - 1]?.trim().slice(0, 160) ?? "";
const JS_TYPES = /^(|text\/javascript|application\/javascript|module)$/i;

function scripts(html) {
  const out = [];
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    const type = /\btype\s*=\s*["']?([^"'\s>]+)/i.exec(m[1])?.[1] ?? "";
    if (!JS_TYPES.test(type)) continue;
    const start = m.index + m[0].indexOf(">") + 1;
    out.push({ code: m[2], line: lineAt(html, start), module: /^module$/i.test(type) });
  }
  return out;
}

// The page with script contents blanked out (newlines kept, so line numbers still match). Scripts often build
// HTML in strings, which shouldn't count as the page's own tags or handlers.
const withoutScripts = (html) => html.replace(/(<script\b[^>]*>)([\s\S]*?)(<\/script\s*>)/gi,
  (_, open, body, close) => open + body.replace(/[^\n]/g, "") + close);

// Inline handlers like onclick="setEmoji('😀')".
function handlers(html) {
  const out = [];
  html = withoutScripts(html);
  for (const m of html.matchAll(/<[a-z][\w-]*\b[^>]*?\s(on[a-z]+)\s*=\s*("([^"]*)"|'([^']*)')/gi)) {
    out.push({ name: m[1], code: (m[3] ?? m[4]).replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&"),
      line: lineAt(html, m.index) });
  }
  return out;
}

function syntax(html) {
  const problems = [];
  for (const s of scripts(html)) {
    if (s.module) continue;   // node:vm can't compile modules without a flag; the browser check covers them
    try {
      new vm.Script(s.code, { filename: "page", lineOffset: s.line - 1 });
    } catch (err) {
      if (!(err instanceof SyntaxError)) continue;
      const line = Number(/page:(\d+)/.exec(err.stack ?? "")?.[1]) || s.line;
      problems.push({ key: `syntax:${err.message}:${snippet(html, line)}`, fatal: true,
        msg: `JavaScript syntax error: ${err.message} (line ${line}: ${snippet(html, line)})` });
    }
  }
  for (const h of handlers(html)) {
    try { new vm.Script(`(function (event) {\n${h.code}\n})`); } catch (err) {
      if (err instanceof SyntaxError) {
        problems.push({ key: `handler:${err.message}:${h.code.slice(0, 80)}`, fatal: true,
          msg: `JavaScript syntax error in ${h.name}="${h.code.slice(0, 80)}": ${err.message} (line ${h.line})` });
      }
    }
  }
  return problems;
}

// An unclosed { in a <style> silently drops every rule after it; the browser reports nothing.
function css(html) {
  const problems = [];
  for (const m of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi)) {
    const code = m[1].replace(/\/\*[\s\S]*?\*\//g, "").replace(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/g, '""');
    let depth = 0, bad = false;
    for (const c of code) {
      if (c === "{") depth++;
      else if (c === "}" && --depth < 0) { bad = true; break; }
    }
    if (depth !== 0 || bad) {
      const line = lineAt(html, m.index);
      const what = bad ? "has a } without a matching {" : `has ${depth} unclosed {`;
      problems.push({ key: `css:${what}:${snippet(html, line)}`, fatal: false,
        msg: `The <style> starting at line ${line} ${what}, so the rules after it are ignored` });
    }
  }
  return problems;
}

// Opening vs closing tags, outside scripts (which may build HTML in strings).
function tags(html) {
  const problems = [];
  const outside = withoutScripts(html).replace(/<!--[\s\S]*?-->/g, "");
  for (const tag of ["script", "style", "div", "section", "svg", "canvas", "button", "ul", "ol"]) {
    const open = (outside.match(new RegExp(`<${tag}\\b`, "gi")) ?? []).length;
    const close = (outside.match(new RegExp(`</${tag}\\s*>`, "gi")) ?? []).length;
    // Only missing closing tags: browsers ignore a stray </div>, but an unclosed <style> or <div> swallows the
    // rest of the page.
    if (open > close) {
      problems.push({ key: `tags:${tag}:${open - close}`, fatal: false,
        msg: `${open} <${tag}> tags but only ${close} </${tag}>: a closing tag is missing` });
    }
  }
  return problems;
}

// Sound data written out by the model is a placeholder: it can't produce real audio as base64, so it writes a WAV
// header with no samples (#286: 44 bytes, silent). Anything under ~0.1 s of the plainest audio can't be a sound.
const TINY_AUDIO = 1000;
function audio(html) {
  const problems = [];
  for (const m of html.matchAll(/data:audio\/[\w.+-]+;base64,([A-Za-z0-9+/=]*)/gi)) {
    const bytes = Math.floor(m[1].replace(/=+$/, "").length * 3 / 4);
    if (bytes >= TINY_AUDIO) continue;
    problems.push({ key: `audio:${m[1].slice(0, 40)}`, fatal: false,
      msg: `The audio data at line ${lineAt(html, m.index)} is only ${bytes} bytes, too short to hold any sound, so it ` +
        `plays silence. Make sounds with Web Audio (an AudioContext with an oscillator) instead` });
  }
  return problems;
}

// SITE is read-only (the shim freezes it). In a sloppy-mode script, SITE.share = wrapper does nothing and says
// nothing (#342: wrapped share/unshare to play sounds, which never played). The shim throws too; this names them all.
const SITE_WRITE = /\bSITE(?:\.[A-Za-z_$][\w$]*|\[[^\]\n]+\])+\s*(?:\*\*|<<|>>>?|&&|\|\||\?\?|[-+*/%&|^])?=(?![=>])|Object\.(?:assign|defineProperty|defineProperties)\(\s*(?:window\.)?SITE\b/g;
function siteWrites(html) {
  if (/\b(?:let|const|var)\s+SITE\b/.test(html)) return [];   // the page's own SITE
  const problems = [], seen = new Set();
  for (const { code, line } of scripts(html)) {
    for (const m of code.matchAll(SITE_WRITE)) {
      const what = m[0].replace(/\s+/g, " ");
      if (seen.has(what)) continue;
      seen.add(what);
      const at = line + code.slice(0, m.index).split("\n").length - 1;
      problems.push({ key: `site-write:${what}`, fatal: false,
        msg: `Line ${at} (${snippet(html, at)}) changes SITE, which is read-only: it throws, and nothing changes. ` +
          `Don't assign to SITE or wrap its functions: do the work where it happens (in the click handler, or in the ` +
          `SITE.shared(ch, onAdd, onRemove) callbacks for everyone's items)` });
    }
  }
  return problems;
}

// Animation names in the page's CSS (<style> blocks and style attributes) with no @keyframes anywhere, so they
// never play and nothing says why (#286 deleted the visitors' @keyframes along with other edits). Names set by
// scripts are checked in the browser (RECORD_ANIMATIONS in check.mjs).
const ANIM_WORDS = new Set(["none", "infinite", "normal", "reverse", "alternate", "alternate-reverse", "forwards",
  "backwards", "both", "running", "paused", "linear", "ease", "ease-in", "ease-out", "ease-in-out", "step-start",
  "step-end", "initial", "inherit", "unset", "revert", "revert-layer", "auto"]);
function animations(html) {
  const have = new Set([...html.matchAll(/@(?:-webkit-)?keyframes\s+["']?([\w-]+)/gi)].map((m) => m[1]));
  const outside = withoutScripts(html);
  const css = [...outside.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi)].map((m) => m[1]).join("\n")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/@(?:-webkit-)?keyframes\s+[\w-]+\s*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/gi, "");
  const attrs = [...outside.matchAll(/\sstyle\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)].map((m) => m[1] ?? m[2]).join(";");
  const wanted = new Set();
  for (const m of `${css};${attrs}`.matchAll(/(?:^|[;{\s])animation(-name)?\s*:\s*([^;}]+)/gi)) {
    if (/var\(|\$\{/.test(m[2])) continue;
    for (const part of m[2].replace(/\([^)]*\)/g, "()").split(",")) {
      const name = part.trim().split(/\s+/).find((t) => /^-?[A-Za-z_][\w-]*$/.test(t) && !ANIM_WORDS.has(t.toLowerCase()));
      if (name) wanted.add(name);
    }
  }
  return [...wanted].filter((n) => !have.has(n)).slice(0, 5).map((n) => ({ key: `anim:${n}`, fatal: false,
    msg: `The CSS uses animation "${n}" but there is no @keyframes ${n}, so it never plays: add the @keyframes or use an existing one` }));
}

// A script that writes fixed words into an element hides whatever the HTML says there, so editing the page's text
// does nothing (#367-#371: a rule "update the author's message on every edit" became a SITE.on("change") listener
// setting one fixed line, and the model's replies went into string literals nobody saw). Two cases:
// - inside a SITE.on(...) listener: the same words after every update, forever;
// - at load (top level, an IIFE or a DOMContentLoaded/load listener), over an element whose HTML text differs:
//   the script undoes an edit to that text. Same text is left alone until an edit makes them differ.
// Assignments in click handlers, timers and named functions are interaction, not this, and are skipped.
const TEXT_SET = /(?:\b([A-Za-z_$][\w$]*)|document\.getElementById\(\s*["']([\w-]+)["']\s*\)|document\.querySelector\(\s*["']#([\w-]+)["']\s*\))\s*\.\s*(textContent|innerText|innerHTML)\s*=\s*(?:"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'|`((?:[^`\\$]|\\.|\$(?!\{))*)`)\s*(?=[;\n})]|$)/g;
// Code with comments removed and string, template and regex contents blanked (same length), for counting braces.
function mask(code) {
  let out = "", i = 0;
  while (i < code.length) {
    const c = code[i], n = code[i + 1];
    if (c === "/" && n === "/") { const e = code.indexOf("\n", i); const end = e < 0 ? code.length : e; out += " ".repeat(end - i); i = end; continue; }
    if (c === "/" && n === "*") { const e = code.indexOf("*/", i + 2); const end = e < 0 ? code.length : e + 2; out += code.slice(i, end).replace(/[^\n]/g, " "); i = end; continue; }
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < code.length && code[j] !== c && !(c !== "`" && code[j] === "\n")) j += code[j] === "\\" ? 2 : 1;
      out += c + code.slice(i + 1, j).replace(/[^\n]/g, " ") + (code[j] ?? ""); i = j + 1; continue;
    }
    out += c; i++;
  }
  return out;
}
// What each unclosed { before `at` belongs to, innermost first: "site" (a SITE.on listener), "load" (an IIFE or a
// DOMContentLoaded/load listener), "block" (if, for, try…), or "other" (any other function).
function enclosing(masked, at) {
  const opens = [];
  for (let i = 0; i < at; i++) {
    if (masked[i] === "{") opens.push(i);
    else if (masked[i] === "}") opens.pop();
  }
  return opens.reverse().map((i) => ({ at: i, kind: kindOf(masked, i) }));
}
function kindOf(masked, i) {
  const before = masked.slice(Math.max(0, i - 200), i);
  const fn = /(?:=>\s*|function\s*[\w$]*\s*\([^()]*\)\s*)$/.exec(before);
  if (!fn) return "block";
  const head = before.slice(0, fn.index);
  if (/SITE\s*\.\s*on\s*\(\s*["'`][^,]*,\s*(?:async\s*)?(?:\([^()]*\)|[\w$]+)?\s*$/.test(head) && /=>/.test(fn[0])) return "site";
  if (/SITE\s*\.\s*on\s*\(\s*["'`][^,]*,\s*(?:async\s*)?$/.test(head)) return "site";
  if (/addEventListener\s*\(\s*["'`](?:DOMContentLoaded|load)\s*["'`]\s*,\s*(?:async\s*)?(?:\([^()]*\)|[\w$]+)?\s*$/.test(head)) return "load";
  if (/(?:^|[;\s(!])\(\s*(?:async\s*)?(?:\([^()]*\)\s*)?$/.test(head) && (/^\s*function\s*\(/.test(fn[0]) || /=>/.test(fn[0]))) return "load";
  return "other";
}
const htmlText = (s) => s.replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
const jsText = (s) => s.replace(/\\(["'`\\])/g, "$1").replace(/\\n/g, " ").replace(/\s+/g, " ").trim();
function fixedText(html) {
  const outside = withoutScripts(html);
  // An element's own text in the HTML: from its opening tag to the next tag (enough for a box of plain words).
  const textOf = (id) => {
    const m = new RegExp(`<([a-z][\\w-]*)\\b[^>]*\\sid\\s*=\\s*["']?${id.replace(/[-$]/g, "\\$&")}["'\\s>][^>]*>([^<]*)`, "i").exec(outside);
    return m ? htmlText(m[2]) : null;
  };
  const problems = [], seen = new Set();
  for (const { code, line } of scripts(html)) {
    const masked = mask(code);
    for (const m of code.matchAll(TEXT_SET)) {
      let id = m[2] ?? m[3];
      if (!id) {
        const v = m[1].replace(/\$/g, "\\$");
        id = new RegExp(`\\b(?:const|let|var)\\s+${v}\\s*=\\s*document\\.(?:getElementById\\(\\s*["']([\\w-]+)["']|querySelector\\(\\s*["']#([\\w-]+)["'])`).exec(code)?.slice(1).find(Boolean);
      }
      if (!id) continue;
      const value = jsText(m[5] ?? m[6] ?? m[7] ?? "");
      if (!value) continue;   // clearing a box isn't writing words into it
      const chain = enclosing(masked, m.index);
      const kinds = chain.map((c) => c.kind).filter((k) => k !== "block");
      const at = line + code.slice(0, m.index).split("\n").length - 1;
      let why;
      if (kinds[0] === "site") {
        // Words chosen by what SITE says (if (s.writing) … else …) are a status display, not fixed text: skip when
        // the code between the listener and this line tests SITE or the listener's argument.
        const start = chain.find((c) => c.kind === "site").at;
        const head = masked.slice(Math.max(0, start - 200), start);
        const call = head.slice(head.lastIndexOf("SITE"));
        const name = /,\s*(?:async\s*)?(?:\(\s*([\w$]+)|([\w$]+)\s*=>|function\s*[\w$]*\s*\(\s*([\w$]+))/.exec(call)?.slice(1).find(Boolean);
        const between = masked.slice(start, m.index);
        const tests = [...between.matchAll(/\b(?:if|while|switch)\s*\(([^)]*)\)|([^;{}]*)\?[^;{}]*:\s*$/g)].map((t) => t[1] ?? t[2]);
        const uses = new RegExp(`\\bSITE\\b${name ? `|\\b${name.replace(/\$/g, "\\$")}\\b` : ""}`);
        if (tests.some((t) => uses.test(t))) continue;
        why = `sets #${id} to the same fixed words ("${value.slice(0, 60)}") every time SITE changes, so it never says anything new`;
      } else if (kinds.every((k) => k === "load")) {
        const own = textOf(id);
        // Same words, or a placeholder the script fills in ("Loading system prompt...", v236): nothing hidden.
        if (own === null || own === value || !own || /^loading\b|(?:\.\.\.|…)$/i.test(own)) continue;
        why = `replaces the text of #${id} in the HTML ("${own.slice(0, 60)}") with fixed words ("${value.slice(0, 60)}") when the page loads, so editing that text changes nothing`;
      } else continue;
      const key = `fixed-text:${kinds[0] === "site" ? "site" : "load"}:${id}:${value.slice(0, 60)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      problems.push({ key, fatal: false,
        msg: `Line ${at} (${snippet(html, at)}) ${why}. Words shown to visitors belong in the HTML: delete that ` +
          `assignment (and a listener that only does that), and write the words inside the #${id} element itself` });
    }
  }
  return problems;
}

function ids(html) {
  const found = new Map();
  for (const m of html.matchAll(/\sid\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>"']+))/gi)) {
    const id = m[1] ?? m[2] ?? m[3];
    found.set(id, (found.get(id) ?? 0) + 1);
  }
  return found;
}

function duplicates(html) {
  const bodyHtml = withoutScripts(html);
  return [...ids(bodyHtml)].filter(([, n]) => n > 1).map(([id, n]) => ({ key: `dup:${id}`, fatal: false,
    msg: `id="${id}" is used ${n} times; ids must be unique (scripts only ever find the first one)` }));
}

// Ids that scripts look up but no element has (and no script creates).
function missing(html) {
  const code = [...scripts(html), ...handlers(html)].map((s) => s.code).join("\n");
  const have = ids(html);
  for (const m of code.matchAll(/\.id\s*=\s*["'`]([\w-]+)["'`]|setAttribute\(\s*["']id["']\s*,\s*["'`]([\w-]+)/g)) {
    have.set(m[1] ?? m[2], 1);
  }
  const wanted = new Set();
  for (const m of code.matchAll(/getElementById\(\s*["'`]([^"'`$]+)["'`]\s*\)/g)) wanted.add(m[1]);
  for (const m of code.matchAll(/querySelector(?:All)?\(\s*["'`]#([\w-]+)/g)) wanted.add(m[1]);
  return [...wanted].filter((id) => !have.has(id))
    .map((id) => `#${id}`);
}

export function lint(html) {
  return {
    problems: [...syntax(html), ...css(html), ...tags(html), ...duplicates(html), ...audio(html), ...animations(html), ...siteWrites(html), ...fixedText(html)],
    missing: missing(html),
  };
}
