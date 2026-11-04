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
    problems: [...syntax(html), ...css(html), ...tags(html), ...duplicates(html)],
    missing: missing(html),
  };
}
