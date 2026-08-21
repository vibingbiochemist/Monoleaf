import MarkdownIt, { type StateCore } from "markdown-it";
import taskLists from "markdown-it-task-lists";
import sub from "markdown-it-sub";
import sup from "markdown-it-sup";
import footnotePlugin from "markdown-it-footnote";
import katexPluginImport from "@vscode/markdown-it-katex";
import hljs from "highlight.js/lib/core";
import javascript from "highlight.js/lib/languages/javascript";
import typescript from "highlight.js/lib/languages/typescript";
import python from "highlight.js/lib/languages/python";
import json from "highlight.js/lib/languages/json";
import bash from "highlight.js/lib/languages/bash";
import xml from "highlight.js/lib/languages/xml";
import css from "highlight.js/lib/languages/css";
import rust from "highlight.js/lib/languages/rust";
import sql from "highlight.js/lib/languages/sql";
import markdownLang from "highlight.js/lib/languages/markdown";
import { EditorState, TransactionSpec } from "@codemirror/state";
import { PortabilityMode } from "./portability";
import { ADMONITIONS, admonitionKind } from "./admonitions";
import { isRemoteUrl, remoteImagesAllowed } from "./remoteimages";
import { escapeDashes } from "./htmlcomment";

// Vite's dependency pre-bundler has, at least once, mis-handled this
// package's CJS default export — handing back the whole
// `{ __esModule, default }` exports object instead of unwrapping to the
// plugin function itself, so `md.use(katexPlugin, ...)` threw "plugin.apply
// is not a function" in the dev server (never in Vitest, which doesn't go
// through that bundling path). Normalizing here is robust to the bundler's
// interop rather than depending on it.
const katexPlugin: typeof katexPluginImport =
  typeof katexPluginImport === "function"
    ? katexPluginImport
    : (katexPluginImport as unknown as { default: typeof katexPluginImport })
        .default;

// Curated language set for fenced-code highlighting in the PDF (core + these
// keeps the bundle lean). registerLanguage also registers each language's
// aliases (js, ts, py, sh, html, md, …).
for (const [name, lang] of [
  ["javascript", javascript],
  ["typescript", typescript],
  ["python", python],
  ["json", json],
  ["bash", bash],
  ["xml", xml],
  ["css", css],
  ["rust", rust],
  ["sql", sql],
  ["markdown", markdownLang],
] as const) {
  hljs.registerLanguage(name, lang);
}

// highlight.js token class -> inline color. INLINE styles (not a stylesheet)
// because Paged.js strips stylesheet rules off cloned content but preserves
// inline styles — the same reason table borders are inlined below. Palette
// matches the live editor.
const HLJS_COLOR: Record<string, string> = {
  keyword: "#b0519f",
  built_in: "#b0519f",
  name: "#b0519f",
  tag: "#b0519f",
  "selector-tag": "#b0519f",
  literal: "#c17d2b",
  number: "#c17d2b",
  bullet: "#c17d2b",
  string: "#2f8a52",
  regexp: "#2f8a52",
  symbol: "#2f8a52",
  title: "#3f7fc1",
  section: "#3f7fc1",
  attr: "#3f7fc1",
  attribute: "#3f7fc1",
  property: "#3f7fc1",
  variable: "#3f7fc1",
  type: "#c1962b",
  "selector-class": "#c1962b",
  comment: "#7d8794",
  quote: "#7d8794",
  meta: "#7d8794",
};

function styleForClasses(classAttr: string): string {
  for (const cls of classAttr.split(/\s+/)) {
    const key = cls.replace(/^hljs-/, "");
    const color = HLJS_COLOR[key];
    if (color) {
      const italic = key === "comment" || key === "quote";
      return `color:${color}${italic ? ";font-style:italic" : ""}`;
    }
  }
  return "";
}

// markdown-it highlight hook: return highlighted token HTML with inline styles
// for known languages; an empty string makes markdown-it fall back to escaped
// plain text (so unknown/no language still renders correctly).
function highlightCode(code: string, lang: string): string {
  if (lang && hljs.getLanguage(lang)) {
    try {
      const html = hljs.highlight(code, {
        language: lang,
        ignoreIllegals: true,
      }).value;
      return html.replace(/class="([^"]*)"/g, (m, cls) => {
        const style = styleForClasses(cls);
        return style ? `style="${style}"` : m;
      });
    } catch {
      /* fall through to plain */
    }
  }
  return "";
}

/**
 * PDF export (brief Stage 5). Page geometry travels with the document in an
 * in-file HTML-comment config block (never YAML frontmatter, which GitHub
 * renders as a visible table):
 *
 *   <!--ml:page {"size":"A4","margin":"20mm","header":"","footer":"{page} / {pages}"}-->
 *
 * Pipeline: markdown -> HTML (markdown-it) -> CSS Paged Media (@page rules,
 * running headers/footers, counter(page)/counter(pages)) -> Paged.js
 * fragments into pages in the webview -> the user prints to PDF. One output
 * file, no scratch files.
 *
 * The PDF shows what a dumb viewer shows: HTML comments (our comment anchors
 * and bodies, and this config block) are stripped; CriticMarkup renders as
 * literal syntax, which is the brief's accepted trade-off.
 */

export interface PageConfig {
  size: "A4" | "Letter";
  margin: string;
  header: string;
  footer: string;
  /** Justify body text document-wide (Blocksatz). */
  justify: boolean;
}

export const DEFAULT_PAGE_CONFIG: PageConfig = {
  size: "A4",
  margin: "20mm",
  header: "",
  footer: "{page} / {pages}",
  justify: false,
};

const PAGE_RE = /<!--ml:page (\{.*?\})-->/;

/**
 * One to four CSS lengths and nothing else. Anything unexpected falls back to
 * the default rather than reaching the stylesheet.
 *
 * `margin` is interpolated straight into the `@page` block by buildPrintCss, so
 * an unvalidated value could close that block and append top-level rules of its
 * own — loading a remote background image (a request the "Load remote images"
 * setting never sees), or hiding text so the exported PDF differs from what the
 * editor showed. That needs no Export and no user interaction: opening a file
 * schedules pagination, which builds the same stylesheet ~300ms later.
 *
 * Bare `0` is allowed because it is legal CSS and the obvious way to ask for no
 * margin. The unit list is exactly what [`cssLengthToPx`] can measure, and must
 * stay that way: `pc` used to be accepted here and measured as zero, so the
 * editor's page layout and the printed `@page` rule disagreed about the same
 * document.
 */
export const MARGIN_RE =
  /^(?:(?:0|\d+(?:\.\d+)?(?:mm|cm|in|pt|px))\s+){0,3}(?:0|\d+(?:\.\d+)?(?:mm|cm|in|pt|px))$/;

// The editor page mirrors these print values so what you see matches the PDF
// (both render in the same WebView2/Chromium engine). 11pt body, 1.5 leading.
export const PRINT_FONT_PX = (11 * 96) / 72; // 11pt at CSS 96dpi ≈ 14.67px
export const PRINT_LINE_HEIGHT = 1.5;

/** Convert a CSS length (mm/cm/in/pt/px, or unitless px) to px at 96dpi. */
export function cssLengthToPx(value: string): number {
  const m = /^(-?[\d.]+)(mm|cm|in|pt|px)?$/.exec(value.trim());
  if (m === null) return 0;
  const n = parseFloat(m[1]);
  switch (m[2]) {
    case "mm":
      return (n * 96) / 25.4;
    case "cm":
      return (n * 96) / 2.54;
    case "in":
      return n * 96;
    case "pt":
      return (n * 96) / 72;
    default:
      return n;
  }
}

/** Parse a CSS margin shorthand into top/right/bottom/left px. */
export function marginToPx(margin: string): {
  top: number;
  right: number;
  bottom: number;
  left: number;
} {
  const p = margin.trim().split(/\s+/).map(cssLengthToPx);
  const v = p.length > 0 && p.every((n) => !Number.isNaN(n)) ? p : [75.6];
  if (v.length === 1)
    return { top: v[0], right: v[0], bottom: v[0], left: v[0] };
  if (v.length === 2)
    return { top: v[0], right: v[1], bottom: v[0], left: v[1] };
  if (v.length === 3)
    return { top: v[0], right: v[1], bottom: v[2], left: v[1] };
  return { top: v[0], right: v[1], bottom: v[2], left: v[3] };
}

export function parsePageConfig(text: string): PageConfig {
  const m = PAGE_RE.exec(text);
  if (m === null) return { ...DEFAULT_PAGE_CONFIG };
  try {
    const data = JSON.parse(m[1]) as Partial<PageConfig>;
    return {
      size: data.size === "Letter" ? "Letter" : "A4",
      margin:
        typeof data.margin === "string" && MARGIN_RE.test(data.margin)
          ? data.margin
          : DEFAULT_PAGE_CONFIG.margin,
      header:
        typeof data.header === "string"
          ? data.header
          : DEFAULT_PAGE_CONFIG.header,
      footer:
        typeof data.footer === "string"
          ? data.footer
          : DEFAULT_PAGE_CONFIG.footer,
      justify: data.justify === true,
    };
  } catch {
    return { ...DEFAULT_PAGE_CONFIG };
  }
}

function pageConfigBlock(cfg: PageConfig): string {
  return `<!--ml:page ${escapeDashes(JSON.stringify(cfg))}-->`;
}

/** Write the config block in place, or append it at the end of the file. */
export function setPageConfigSpec(
  state: EditorState,
  cfg: PageConfig,
): TransactionSpec {
  const text = state.doc.toString();
  const block = pageConfigBlock(cfg);
  const m = PAGE_RE.exec(text);
  if (m !== null) {
    return {
      changes: { from: m.index, to: m.index + m[0].length, insert: block },
      userEvent: "input.pageconfig",
    };
  }
  const nl = state.lineBreak;
  const end = state.doc.length;
  // Line breaks are 1 position each; expand the last two with nl so the
  // endsWith checks hold for CRLF documents too.
  const tail = state.doc.sliceString(Math.max(0, end - 2), end, nl);
  const spacer = tail.endsWith(nl + nl) ? "" : tail.endsWith(nl) ? nl : nl + nl;
  return {
    changes: { from: end, insert: `${spacer}${block}${nl}` },
    userEvent: "input.pageconfig",
  };
}

// ---------------------------------------------------------------------------
// Markdown -> HTML

const STRIP_RES = [
  /<!--c:[a-z0-9]+[se]-->/g, // comment anchors
  /<!--c:[a-z0-9]+ \{.*?\}-->/g, // comment bodies
  /<!--ml:page \{.*?\}-->/g, // page config
  /<!--ml:toc-end-->/g, // TOC boundary markers (list itself stays)
  /<!--ml:toc-->/g,
  /<!--ml:meta \{.*?\}-->/g, // document metadata (comment form)
];

/**
 * Turn `> [!NOTE]` blockquotes into styled callout <div>s. Inline styles only:
 * Paged.js strips stylesheet rules off the cloned print content, so anything
 * that must survive fragmentation has to live on the element (same lesson as
 * the table borders and code highlighting).
 */
function installAdmonitions(md: InstanceType<typeof MarkdownIt>): void {
  md.core.ruler.after("block", "ml_admonitions", (state: StateCore) => {
    const tokens = state.tokens;
    const TokenCtor = tokens.length > 0 ? tokens[0].constructor : null;
    if (TokenCtor === null) return;
    for (let i = 0; i < tokens.length - 2; i++) {
      if (tokens[i].type !== "blockquote_open") continue;
      const para = tokens[i + 1];
      const inline = tokens[i + 2];
      if (para.type !== "paragraph_open" || inline.type !== "inline") continue;
      const kind = admonitionKind(inline.content.split("\n", 1)[0] ?? "");
      if (kind === null) continue;
      const style = ADMONITIONS[kind];

      // Blockquote → callout <div>.
      tokens[i].tag = "div";
      tokens[i].attrSet(
        "style",
        `border-left:4px solid ${style.color};background:${style.tint};` +
          "padding:6pt 12pt;margin:9pt 0;border-radius:0 3px 3px 0;",
      );
      // Matching close, nesting-aware.
      let depth = 1;
      let j = i + 1;
      for (; j < tokens.length; j++) {
        if (tokens[j].type === "blockquote_open") depth++;
        else if (tokens[j].type === "blockquote_close" && --depth === 0) break;
      }
      if (j < tokens.length) tokens[j].tag = "div";

      // Drop the "[!TYPE]" marker line from the body's inline content.
      const kids = inline.children;
      if (kids !== null && kids.length > 0 && kids[0].type === "text") {
        const hasBreak = kids.length > 1 && kids[1].type === "softbreak";
        kids.splice(0, hasBreak ? 2 : 1);
      }
      inline.content = inline.content.replace(/^[^\n]*\n?/, "");

      // Title line as its own inline-styled div, inserted before the body.
      type Tok = (typeof tokens)[number];
      const Ctor = TokenCtor as new (t: string, g: string, n: number) => Tok;
      const title = new Ctor("html_block", "", 0);
      title.content =
        `<div style="color:${style.color};font-weight:600;margin-bottom:3pt;">` +
        `${style.icon} ${style.label}</div>\n`;
      tokens.splice(i + 1, 0, title);
    }
  });
}

export function renderDocumentHtml(
  markdown: string,
  mode: PortabilityMode,
  sourceLines = false,
): string {
  // Stripping replaces token text only, never newlines, so line indices in
  // the stripped text still match the original document — which is what
  // makes data-srcline usable for mapping page breaks back to the editor.
  let text = markdown;
  // Blank a leading YAML front-matter block (metadata) so it doesn't render
  // in the body. Keep the newlines so line numbers still line up for the
  // data-srcline pagination mapping.
  text = text.replace(/^---\r?\n[\s\S]*?\r?\n---/, (m) =>
    m.replace(/[^\n]/g, ""),
  );
  // Explicit page break directive (Ctrl+Enter): invisible to dumb viewers
  // as an HTML comment, a forced break in print. The zero-width space keeps
  // the element non-empty — Paged.js can crash (null nextSibling) when
  // fragmenting around empty forced-break elements.
  text = text.replace(
    /<!--ml:pagebreak-->/g,
    '<div class="ml-pagebreak">&#8203;</div>',
  );
  for (const re of STRIP_RES) text = text.replace(re, "");
  // The "default" preset already includes the GFM pieces we parse in the
  // editor: tables and strikethrough.
  const md = new MarkdownIt({ html: true, highlight: highlightCode });
  md.use(taskLists);
  if (mode === "enhanced") {
    md.use(sub);
    md.use(sup);
  }
  // Math: $…$ / $$…$$ as MathML, which the print webview renders natively.
  // MathML avoids KaTeX's CSS + web fonts, which Paged.js would strip anyway.
  //
  // This plugin bundles its own KaTeX (^0.16.4) while the live preview uses the
  // top-level one, so two copies used to ship: two versions to patch when an
  // advisory lands, and a standing risk of the editor and the PDF disagreeing
  // about a formula. package.json pins both to one version via an `overrides`
  // entry ("katex": "$katex" — npm requires the reference form when the package
  // is also a direct dependency). Verified safe by diffing MathML output for
  // inline/display/matrix/cases/accents/error formulas across both versions:
  // byte-identical. Re-check that diff before bumping KaTeX.
  md.use(katexPlugin, { output: "mathml", throwOnError: false });
  md.use(footnotePlugin); // [^1] references + a footnotes section at the end
  installAdmonitions(md); // > [!NOTE] blockquotes → styled callout boxes

  // Table borders/shading as INLINE styles on the elements — Paged.js's own
  // table styles (injected for fragmentation) strip stylesheet borders even
  // with !important, but cannot override inline styles. Column alignment
  // (markdown-it's own inline text-align) is preserved by appending.
  const cellBorder =
    "border:0.75pt solid #b0b0b0;padding:4pt 7pt;vertical-align:top;";
  md.renderer.rules.table_open = (tokens, idx, opts, _env, self) => {
    tokens[idx].attrSet(
      "style",
      "border-collapse:collapse;width:100%;margin:8pt 0;font-size:10pt;",
    );
    return self.renderToken(tokens, idx, opts);
  };
  // https images render; other references (local files, etc.) become their
  // alt text — the .md holds only the reference, never image bytes.
  //
  // A remote image also becomes alt text when the reader has not enabled remote
  // content (the default; see ./remoteimages). Degrading to the same alt text a
  // local reference already produces keeps exported output clean — no "blocked"
  // notice leaks into a shared PDF — and keeps this path from issuing a request.
  const defaultImage =
    md.renderer.rules.image ??
    ((tokens, idx, opts, _env, self) => self.renderToken(tokens, idx, opts));
  md.renderer.rules.image = (tokens, idx, opts, env, self) => {
    const src = String(tokens[idx].attrGet("src") ?? "");
    if (isRemoteUrl(src) && !remoteImagesAllowed()) {
      return tokens[idx].content ?? "";
    }
    if (/^https?:\/\//i.test(src)) {
      return defaultImage(tokens, idx, opts, env, self);
    }
    return tokens[idx].content ?? "";
  };
  md.renderer.rules.th_open = (tokens, idx, opts, _env, self) => {
    const cur = tokens[idx].attrGet("style");
    tokens[idx].attrSet(
      "style",
      (cur ? cur + ";" : "") +
        cellBorder +
        "background:#f3f3f1;font-weight:600;",
    );
    return self.renderToken(tokens, idx, opts);
  };
  md.renderer.rules.td_open = (tokens, idx, opts, _env, self) => {
    const cur = tokens[idx].attrGet("style");
    tokens[idx].attrSet("style", (cur ? cur + ";" : "") + cellBorder);
    return self.renderToken(tokens, idx, opts);
  };
  if (sourceLines) {
    md.core.ruler.push("sourceline", (state) => {
      for (const token of state.tokens) {
        if (token.map !== null && token.block) {
          token.attrSet("data-srcline", String(token.map[0]));
        }
      }
    });
  }
  return md.render(text);
}

// ---------------------------------------------------------------------------
// Self-contained HTML export

// Screen typography for the exported file. Everything else that must render —
// table borders, code colours, callout boxes — already carries inline styles
// from renderDocumentHtml, and math is native MathML, so the file needs no
// external stylesheet, fonts, or scripts: it opens and prints anywhere.
const STANDALONE_CSS = `:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body {
  font-family: -apple-system, "Segoe UI", system-ui, sans-serif;
  max-width: 46rem; margin: 2.5rem auto; padding: 0 1.25rem;
  line-height: 1.65; font-size: 16px; color: #1f2328; background: #ffffff;
}
h1, h2, h3, h4, h5, h6 { line-height: 1.25; margin: 1.5em 0 0.5em; font-weight: 600; }
h1 { font-size: 2em; border-bottom: 1px solid #eaecef; padding-bottom: 0.3em; }
h2 { font-size: 1.5em; border-bottom: 1px solid #eaecef; padding-bottom: 0.3em; }
h3 { font-size: 1.25em; }
p { margin: 0.8em 0; }
a { color: #0969da; text-decoration: none; }
a:hover { text-decoration: underline; }
code { font-family: Consolas, "Cascadia Mono", monospace; background: #eff1f3; padding: 0.15em 0.35em; border-radius: 4px; font-size: 0.9em; }
pre { background: #f6f8fa; padding: 12px 14px; border-radius: 6px; overflow: auto; }
pre code { background: none; padding: 0; font-size: 0.88em; }
blockquote { margin: 1em 0; padding: 0 1em; border-left: 3px solid #d0d7de; color: #57606a; }
table { border-collapse: collapse; margin: 1em 0; }
img { max-width: 100%; height: auto; }
hr { border: none; border-top: 1px solid #d8dee4; margin: 1.5em 0; }
ul, ol { padding-left: 1.6em; }
@media (prefers-color-scheme: dark) {
  body { color: #e6edf3; background: #0d1117; }
  h1, h2 { border-bottom-color: #21262d; }
  code { background: #21262d; }
  pre { background: #161b22; }
  blockquote { color: #9198a1; border-left-color: #30363d; }
  a { color: #4493f8; }
}`;

/**
 * A single, self-contained HTML document: the rendered markdown plus inline
 * screen styles, no external resources. `title` fills the <title> element.
 */
export function renderStandaloneHtml(
  markdown: string,
  mode: PortabilityMode,
  title: string,
  allowRemoteImages = false,
): string {
  return wrapStandaloneHtml(
    renderDocumentHtml(markdown, mode),
    title,
    allowRemoteImages,
  );
}

/**
 * The exported file's own Content-Security-Policy.
 *
 * Everything else in this module assumes the app's CSP and sanitizer are doing
 * their jobs. An exported .html has neither: it opens in a full browser with no
 * restrictions, so any sanitizer gap becomes a live gap in every file the user
 * shares, with nothing behind it. This is that backstop.
 *
 * `style-src 'unsafe-inline'` is unavoidable and not a weakening — the whole
 * export strategy is inline styles (table borders, callout boxes, code colours)
 * so the file needs no external stylesheet. `script-src 'none'` is the directive
 * that matters, and nothing the renderer emits is a script.
 *
 * `img-src` mirrors the reader's own "Load remote images" setting at the moment
 * of export: off means the exported file cannot phone home either, which is the
 * same promise the app makes about the document it was made from.
 */
function standaloneCsp(allowRemoteImages: boolean): string {
  const img = allowRemoteImages ? "data: https:" : "data:";
  return [
    "default-src 'none'",
    "script-src 'none'",
    `img-src ${img}`,
    "style-src 'unsafe-inline'",
    "font-src data:",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
}

/**
 * Wrap an already-rendered (and, in the app, already-sanitized) body fragment
 * in the self-contained HTML document shell. Kept separate from
 * renderStandaloneHtml so the caller can sanitize the body before it is inlined
 * into a shareable file.
 */
export function wrapStandaloneHtml(
  body: string,
  title: string,
  allowRemoteImages = false,
): string {
  const safeTitle = title.replace(
    /[&<>]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c] ?? c,
  );
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${standaloneCsp(allowRemoteImages)}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${safeTitle}</title>
<style>
${STANDALONE_CSS}
</style>
</head>
<body>
${body}
</body>
</html>
`;
}

// ---------------------------------------------------------------------------
// CSS Paged Media

/**
 * Compile a header/footer template into a CSS content expression:
 * "Seite {page} / {pages}" -> "Seite " counter(page) " / " counter(pages).
 * {title} and {date} are substituted as text beforehand. Returns null when
 * the template is empty OR resolves to nothing (e.g. "{title}" with an empty
 * title) — the caller then omits the margin box entirely. Returning "" here
 * would emit `content: ;`, which is invalid CSS and crashes Paged.js's CSS
 * parser.
 */
export function contentExpression(
  template: string,
  vars: { title: string; author?: string; date: string },
): string | null {
  if (template.trim() === "") return null;
  const withVars = template
    .replace(/\{title\}/g, vars.title)
    .replace(/\{author\}/g, vars.author ?? "")
    .replace(/\{date\}/g, vars.date);
  const parts: string[] = [];
  let last = 0;
  for (const m of withVars.matchAll(/\{(page|pages)\}/g)) {
    if (m.index > last)
      parts.push(JSON.stringify(withVars.slice(last, m.index)));
    parts.push(`counter(${m[1]})`);
    last = m.index + m[0].length;
  }
  if (last < withVars.length) parts.push(JSON.stringify(withVars.slice(last)));
  return parts.length === 0 ? null : parts.join(" ");
}

export function buildPrintCss(
  cfg: PageConfig,
  vars: { title: string; author?: string; date: string },
  // A class, not an ID: Paged.js's Sheet.parse() rewrites every ID selector
  // into `[data-id="…"]` (replaceIds), and data-id is only ever stamped onto
  // *content* nodes it clones into the paginated output, never onto the
  // render-target element itself. An ID-scoped root here would compile to a
  // selector nothing in the paginated DOM ever matches, silently dropping
  // every rule below (menu, headings, code font, justify — everything except
  // the unscoped .ml-pagebreak and the @page block, which at-rules skip).
  // Class selectors pass through untouched.
  root = ".ml-print",
): string {
  const header = contentExpression(cfg.header, vars);
  const footer = contentExpression(cfg.footer, vars);
  // Pagination note: Paged.js fragments based on layout-engine text
  // measurements. Windows WebView2 is Chromium; macOS WKWebView is close,
  // Linux WebKitGTK diverges most. Page breaks may shift across platforms —
  // Windows is the supported target for now (brief Stage 5 caveat).
  return `
@page {
  size: ${cfg.size};
  margin: ${cfg.margin};
  ${header === null ? "" : `@top-center { content: ${header}; font-size: 9pt; color: #555555; }`}
  ${footer === null ? "" : `@bottom-center { content: ${footer}; font-size: 9pt; color: #555555; }`}
}

${root} {
  font-family: "Segoe UI", system-ui, sans-serif;
  font-size: 11pt;
  line-height: 1.5;
  color: #111111;
  /* Print backgrounds/borders (table header shading etc.) instead of the
     browser stripping them to save ink. */
  print-color-adjust: exact;
  -webkit-print-color-adjust: exact;
}
${root} h1 { font-size: 20pt; margin: 0 0 10pt; }
${root} h2 { font-size: 16pt; margin: 14pt 0 8pt; }
${root} h3 { font-size: 13pt; margin: 12pt 0 6pt; }
${root} h4, ${root} h5, ${root} h6 { font-size: 11pt; margin: 10pt 0 5pt; }
${root} h1, ${root} h2, ${root} h3 { break-after: avoid; }
${root} p { margin: 0 0 8pt; }
${root} blockquote {
  margin: 8pt 0;
  padding-left: 10pt;
  border-left: 2pt solid #bbbbbb;
  color: #444444;
}
${root} pre, ${root} code {
  font-family: Consolas, "Cascadia Mono", monospace;
  font-size: 9.5pt;
}
${root} pre {
  background: #f4f4f4;
  padding: 6pt 8pt;
  white-space: pre-wrap;
  break-inside: avoid;
}
/* Code-token colors are applied as inline styles (see highlightCode) so they
   survive Paged.js, the same way table borders are inlined. */
${root} .katex-block { text-align: center; margin: 8pt 0; }
${root} math { font-size: 1.05em; }
/* Borders use !important because Paged.js injects its own table styles for
   fragmentation that otherwise strip them (symptom: text but no borders). */
${root} table {
  border-collapse: collapse !important;
  margin: 8pt 0;
  width: 100%;
  table-layout: auto;
  font-size: 10pt;
}
${root} thead { display: table-header-group; } /* repeat header across pages */
${root} tr { break-inside: avoid; }
${root} table th,
${root} table td {
  border: 0.75pt solid #b0b0b0 !important;
  padding: 4pt 7pt;
  text-align: left; /* default; GFM column alignment sets inline style */
  vertical-align: top;
  overflow-wrap: break-word;
}
${root} table th {
  background: #f3f3f1 !important;
  font-weight: 600;
}
${root} img { max-width: 100%; }
${root} hr { border: none; border-top: 1pt solid #bbbbbb; margin: 10pt 0; }
${root} ul.contains-task-list { list-style: none; padding-left: 1.2em; }
${root} a { color: #1a4f8a; text-decoration: none; }
${root} sup.footnote-ref { font-size: 0.72em; }
${root} .footnotes { font-size: 9pt; margin-top: 14pt; padding-top: 6pt; border-top: 0.75pt solid #cccccc; }
${root} .footnotes ol { padding-left: 1.4em; margin: 4pt 0; }
${root} .footnotes li { margin: 2pt 0; }
${root} mark { background: #fbe3a0; color: inherit; border-radius: 2px; } /* warm amber highlighter, matches the editor */
.ml-pagebreak { display: block; height: 0; break-after: page; }
${cfg.justify ? `${root} p { text-align: justify; }` : ""}
${root} [align="center"] { text-align: center; }
${root} [align="right"] { text-align: right; }
${root} [align="justify"] { text-align: justify; }
${root} [align="left"] { text-align: left; }
`;
}
