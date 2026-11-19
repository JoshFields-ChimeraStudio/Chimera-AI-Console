/**
 * ADO stores Description, Acceptance Criteria, Technical Notes and comments as
 * HTML. The console never renders that HTML: the plugin converts it to Markdown
 * here, and the UI renders only the Markdown (doc/plans/2026-11-17-backlog-view.md,
 * "Safety of ADO content"). The same Markdown goes into task descriptions agents read.
 *
 * Guarantees, independent of the UI's own Markdown sanitising (tests check them by
 * parsing the output with a CommonMark + GFM parser):
 * - no raw HTML: no element is ever kept as HTML (tables are converted by our own
 *   rule, never kept), every "<" in text is escaped, and a final pass escapes any
 *   "<" left outside code;
 * - no images: images become links, and a "!" that would turn a following link into
 *   an image is escaped;
 * - links only to http(s) and mailto; any other link becomes plain text;
 * - script, style and other active or embedded elements are dropped with their content;
 *   attributes (event handlers included) never reach the output.
 * The result is then parsed with the same parser the UI uses (micromark, CommonMark + GFM).
 * If anything unsafe is still found, every "<" and "!" is escaped, code included; if even
 * that is not enough, all punctuation is escaped and the text shows as plain text.
 */
import TurndownService from "turndown";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfm } from "micromark-extension-gfm";
import { gfmFromMarkdown } from "mdast-util-gfm";

const DROPPED_ELEMENTS = [
  "script", "style", "noscript", "template", "iframe", "frame", "frameset", "object", "embed",
  "applet", "form", "input", "button", "select", "textarea", "svg", "math", "link", "meta", "base", "head", "title",
] as const;

const SAFE_URL = /^(https?:\/\/|mailto:)/i;

export function safeUrl(raw: string | null | undefined): string | null {
  const url = (raw ?? "").trim();
  // Browsers drop control characters from URLs, so refuse them rather than reason about it.
  if (!url || /[\u0000-\u001f\u007f]/.test(url)) return null;
  return SAFE_URL.test(url) ? url : null;
}

/** Characters that would break out of a Markdown link target. */
function linkTarget(url: string): string {
  return url.replace(/[()<> ]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** Put a backslash before every unescaped occurrence of `pattern` (an even run of backslashes before it). */
function escapeUnescaped(text: string, pattern: RegExp): string {
  return text.replace(new RegExp(`(\\\\*)(${pattern.source})`, "g"), (_m, slashes: string, hit: string) =>
    slashes.length % 2 === 0 ? `${slashes}\\${hit}` : `${slashes}${hit}`,
  );
}

/**
 * The last line of defence: outside fenced and inline code, escape every unescaped
 * "<" (no raw HTML or autolinks) and every "!" before "[" (no images).
 */
export function sanitizeMarkdown(markdown: string): string {
  const plain = (text: string) => escapeUnescaped(escapeUnescaped(text, /</), /!(?=\[)/);
  let out = "";
  const fence = /^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?\n {0,3}\1[`~]*[ \t]*$/gm;
  let last = 0;
  for (const m of markdown.matchAll(fence)) {
    out += sanitizeInline(markdown.slice(last, m.index), plain) + m[0];
    last = m.index! + m[0].length;
  }
  return out + sanitizeInline(markdown.slice(last), plain);
}

/** Applies `plain` to the text outside inline code spans (backtick runs not preceded by an escape). */
function sanitizeInline(text: string, plain: (s: string) => string): string {
  let out = "";
  let i = 0;
  let start = 0;
  while (i < text.length) {
    if (text[i] === "\\") {
      i += 2;
      continue;
    }
    if (text[i] !== "`") {
      i++;
      continue;
    }
    let run = 0;
    while (text[i + run] === "`") run++;
    const ticks = "`".repeat(run);
    // The closing run must have exactly the same length.
    let close = -1;
    for (let j = i + run; j < text.length; ) {
      const k = text.indexOf(ticks, j);
      if (k < 0) break;
      let len = 0;
      while (text[k + len] === "`") len++;
      if (len === run) {
        close = k;
        break;
      }
      j = k + len;
    }
    if (close < 0) {
      i += run;
      continue;
    }
    out += plain(text.slice(start, i)) + text.slice(i, close + run);
    i = start = close + run;
  }
  return out + plain(text.slice(start));
}

function createService(): TurndownService {
  const service = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
    emDelimiter: "*",
    hr: "---",
    // A backslash hard break survives the trailing-whitespace cleanup below.
    br: "\\",
  });
  // Nothing is ever kept as HTML: unknown elements fall back to their content.
  service.remove(DROPPED_ELEMENTS as unknown as TurndownService.Filter);
  const escape = service.escape.bind(service);
  service.escape = (text: string) => escape(text).replace(/</g, "\\<");

  service.addRule("safeLink", {
    filter: (node) => node.nodeName === "A",
    replacement: (content, node) => {
      const href = safeUrl((node as HTMLElement).getAttribute("href"));
      if (!href) return content;
      // Block content (a code block, a list) cannot sit inside link text: put the link after it.
      if (content.includes("\n")) return `${content}\n\n[${service.escape(href)}](${linkTarget(href)})\n\n`;
      const text = content.trim() || service.escape(href);
      return `[${text}](${linkTarget(href)})`;
    },
  });

  service.addRule("imageAsLink", {
    filter: "img",
    replacement: (_content, node) => {
      const el = node as HTMLElement;
      const src = safeUrl(el.getAttribute("src"));
      const alt = service.escape((el.getAttribute("alt") ?? "").replace(/\s+/g, " ").trim()) || "image";
      return src ? `[${alt}](${linkTarget(src)})` : "";
    },
  });

  service.addRule("strikethrough", {
    filter: ["del", "s", "strike" as never],
    replacement: (content) => (content.trim() ? `~~${content}~~` : content),
  });

  // Every table becomes a GFM table; the first row is the header (ADO's editor makes
  // tables without a header row). Cells are converted on their own and kept on one line.
  service.addRule("table", {
    filter: "table",
    replacement: (_content, node) => {
      const rows: Element[][] = [];
      const collect = (parent: Element) => {
        for (const child of Array.from(parent.children)) {
          if (child.nodeName === "TR") rows.push(Array.from(child.children).filter((c) => c.nodeName === "TD" || c.nodeName === "TH"));
          else if (["THEAD", "TBODY", "TFOOT"].includes(child.nodeName)) collect(child);
        }
      };
      collect(node as Element);
      if (rows.length === 0) return "";
      const width = Math.max(1, ...rows.map((r) => r.length));
      const cell = (el: Element | undefined) =>
        el ? escapeUnescaped(service.turndown(el.innerHTML).replace(/\\\n/g, " ").replace(/\s*\n+\s*/g, " ").trim(), /\|/) : "";
      const line = (cells: Array<Element | undefined>) =>
        `| ${Array.from({ length: width }, (_, i) => cell(cells[i]) || " ").join(" | ")} |`;
      const [header, ...body] = rows;
      return `\n\n${[line(header!), `| ${Array(width).fill("---").join(" | ")} |`, ...body.map(line)].join("\n")}\n\n`;
    },
  });
  return service;
}

let service: TurndownService | null = null;

/** ADO HTML to safe Markdown; null for empty input or output. */
export function htmlToMarkdown(html: unknown): string | null {
  if (typeof html !== "string" || !html.trim()) return null;
  service ??= createService();
  return finish(service.turndown(html));
}

/** Plain text (for example a Markdown comment ADO did not render) as safe Markdown that shows the text as is. */
export function textToMarkdown(text: unknown): string | null {
  if (typeof text !== "string" || !text.trim()) return null;
  service ??= createService();
  return finish(
    text
      .replace(/\r\n?/g, "\n")
      .split("\n")
      .map((l) => service!.escape(l))
      .join("\\\n"),
  );
}

/** What the UI's parser would find unsafe: raw HTML, an image, a reference, or a link to anything but http(s)/mailto. */
export function findUnsafeMarkdown(markdown: string): string | null {
  const tree = fromMarkdown(markdown, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });
  const walk = (node: { type: string; url?: string; children?: unknown[] }): string | null => {
    if (["html", "image", "imageReference", "definition", "linkReference"].includes(node.type)) return node.type;
    if (node.type === "link" && !SAFE_URL.test(node.url ?? "")) return "unsafe link";
    for (const child of (node.children ?? []) as Array<typeof node>) {
      const found = walk(child);
      if (found) return found;
    }
    return null;
  };
  return walk(tree as never);
}

function finish(markdown: string): string | null {
  const out = ensureSafeMarkdown(
    markdown
      .replace(/ /g, " ")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim(),
  );
  return out || null;
}

/** Any Markdown made safe: the escaping pass, then the parser check with its two fallbacks. */
export function ensureSafeMarkdown(markdown: string): string {
  let out = sanitizeMarkdown(markdown);
  if (findUnsafeMarkdown(out)) out = escapeUnescaped(escapeUnescaped(out, /</), /!/);
  // Last resort: every punctuation character escaped, so nothing is syntax any more.
  if (findUnsafeMarkdown(out)) out = out.replace(/\\(?=[!-/:-@[-`{-~])/g, "").replace(/[!-/:-@[-`{-~]/g, (ch) => `\\${ch}`);
  return out;
}
