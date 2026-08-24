import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";

/**
 * Paste-with-formatting: convert the clipboard's HTML flavor (Word, Outlook,
 * websites, Excel) into Monoleaf's markdown dialect. Nothing foreign enters
 * the file — the output is exactly what a user could have typed:
 * CommonMark+GFM, plus our house conventions (<u>/<mark> inline HTML,
 * ~sub~/^sup^, backslash hard breaks, <div align> blocks).
 * Images are dropped to their alt text: the single-.md principle excludes
 * image files by decision.
 */

function service(): TurndownService {
  const td = new TurndownService({
    headingStyle: "atx",
    bulletListMarker: "-",
    codeBlockStyle: "fenced",
    emDelimiter: "*",
    strongDelimiter: "**",
    br: "\\",
  });
  td.use(gfm);

  // Our house inline-HTML constructs survive as-is.
  td.keep(["u", "mark"]);

  // Word's <style>/<xml> scaffolding, dropped node-and-contents. Done here
  // (on turndown's own parsed tree) rather than by regex on the raw string:
  // a regex removing "<style ...>...</style>" as one literal span can be
  // defeated by an attacker splitting the delimiter across the boundary —
  // e.g. "<sty<style>x</style>le>PAYLOAD" removes the inner block and
  // concatenates the leftovers back into "<style>PAYLOAD", reconstituting
  // the very tag the regex was meant to strip. A real parser can't be fooled
  // this way: it tokenizes tags by position, not by string content.
  td.remove(["style", "xml"] as (keyof HTMLElementTagNameMap)[]);

  // Word's <o:p> paragraph markers: unwrap (keep the text, drop the tag) —
  // same reconstitution hazard as <style> above, so handled structurally
  // here rather than via `<\/?o:p[^>]*>` regex stripping.
  td.addRule("msoParagraphMarker", {
    filter: ["o:p"] as unknown as (keyof HTMLElementTagNameMap)[],
    replacement: (content) => content,
  });

  // GFM strikethrough must be double-tilde: a single tilde is subscript in
  // our enhanced dialect.
  td.addRule("strikethrough", {
    filter: ["del", "s", "strike"] as (keyof HTMLElementTagNameMap)[],
    replacement: (content) => `~~${content}~~`,
  });

  // Tight "- item" markers instead of turndown's "-   item" padding.
  td.addRule("listItem", {
    filter: "li",
    replacement: (content, node, options) => {
      const body = content
        .replace(/^\n+/, "")
        .replace(/\n+$/, "\n")
        .replace(/\n/gm, "\n  ");
      let prefix = `${options.bulletListMarker} `;
      const parent = node.parentNode as HTMLElement;
      if (parent.nodeName === "OL") {
        const start = parent.getAttribute("start");
        const index = Array.prototype.indexOf.call(parent.children, node);
        prefix = `${start !== null ? Number(start) + index : index + 1}. `;
      }
      return (
        prefix +
        body +
        (node.nextSibling !== null && !/\n$/.test(body) ? "\n" : "")
      );
    },
  });

  // Tables → GFM. turndown-plugin-gfm only converts a table whose first row is
  // a proper heading row (<th> / <thead>); Word emits header cells as bold
  // <td>s with no <thead>, so the plugin `keep`s the whole table as raw HTML.
  // This rule (added last, so it takes precedence) converts ANY table, using
  // the first row as the header — exactly how GFM tables are shaped, and what
  // tsvToMarkdownTable does for Excel. Inline cell formatting is preserved by
  // running the cell's own HTML back through turndown.
  td.addRule("gfmTableAnyHeader", {
    filter: "table",
    replacement: (_content, node) => {
      const table = node as HTMLElement;
      const rows = Array.from(table.querySelectorAll("tr"))
        .map((tr) =>
          Array.from(tr.children).filter(
            (c) => c.nodeName === "TD" || c.nodeName === "TH",
          ),
        )
        .filter((cells) => cells.length > 0);
      if (rows.length === 0) return "";
      const cols = Math.max(...rows.map((r) => r.length));

      const cellText = (cell: Element): string =>
        td
          .turndown(cell.innerHTML)
          .replace(/\s*\n\s*/g, " ")
          .replace(/\|/g, "\\|")
          .trim();
      const cellAlign = (cell: Element): string => {
        const style = (cell.getAttribute("style") ?? "").toLowerCase();
        const attr = (cell.getAttribute("align") ?? "").toLowerCase();
        const v = /text-align:\s*(left|center|right)/.exec(style)?.[1] ?? attr;
        return v === "center"
          ? ":---:"
          : v === "right"
            ? "---:"
            : v === "left"
              ? ":---"
              : "---";
      };
      const pad = <T>(arr: T[], fill: T): T[] =>
        arr.length >= cols
          ? arr.slice(0, cols)
          : [...arr, ...Array<T>(cols - arr.length).fill(fill)];
      const line = (cells: string[]) => `| ${cells.join(" | ")} |`;

      const [header, ...body] = rows;
      const out = [
        line(pad(header.map(cellText), "")),
        line(pad(header.map(cellAlign), "---")),
        ...body.map((r) => line(pad(r.map(cellText), ""))),
      ];
      return `\n\n${out.join("\n")}\n\n`;
    },
  });

  td.addRule("subscript", {
    filter: "sub",
    replacement: (content) => `~${content}~`,
  });
  td.addRule("superscript", {
    filter: "sup",
    replacement: (content) => `^${content}^`,
  });

  // No images, by project decision: keep the alt text only.
  td.addRule("dropImages", {
    filter: "img",
    replacement: (_content, node) =>
      (node as HTMLElement).getAttribute("alt") ?? "",
  });

  // Word/HTML paragraph alignment -> our <div align> blocks. Checked before
  // msoFakeList below (turndown's Rules.add() unshifts, so the rule added
  // *last* wins) — this filter only matches non-list paragraphs anyway, since
  // msoListInfo's own class/style check excludes it, but the ordering keeps
  // that explicit rather than relying on the exclusion alone.
  td.addRule("alignment", {
    filter: (node) => {
      if (!/^(P|DIV|H[1-6])$/.test(node.nodeName)) return false;
      if (msoListInfo(node as Element) !== null) return false;
      return alignmentOf(node as HTMLElement) !== null;
    },
    replacement: (content, node) => {
      const align = alignmentOf(node as HTMLElement)!;
      const inner = content.trim();
      if (inner === "") return "";
      return `\n\n<div align="${align}">\n\n${inner}\n\n</div>\n\n`;
    },
  });

  // Word's fake lists: a flat run of <p class=MsoListParagraph> (or the <div>
  // form), each carrying its list id/level in style="mso-list:l1 level1 ..."
  // and a throwaway marker glyph in a <span style="mso-list:Ignore"> child —
  // there is no real <ul>/<ol>/<li> anywhere. This rule regroups consecutive
  // siblings that share a list id+level into one logical list, numbering
  // ordered items by position in the run (Word's own marker text is only used
  // to tell ordered from unordered) and dropping the marker span entirely.
  // Added last (see the ordering note on "alignment" above) so a justified or
  // centered list item — Word applies paragraph alignment independently of
  // list membership — still converts to a real list item instead of being
  // caught by the alignment rule and wrapped in a <div align> block.
  td.addRule("msoFakeList", {
    filter: (node) => msoListInfo(node as Element) !== null,
    replacement: (_content, node) => {
      const el = node as HTMLElement;
      const info = msoListInfo(el)!;

      const clone = el.cloneNode(true) as HTMLElement;
      const marker = Array.from(clone.querySelectorAll("span")).find((s) =>
        /mso-list:\s*ignore/i.test(s.getAttribute("style") ?? ""),
      );
      const markerText = marker?.textContent?.trim() ?? "";
      marker?.remove();

      const text = td.turndown(clone.innerHTML).trim();
      if (text === "") return "";

      const indent = "  ".repeat(info.level - 1);
      const ordinal = msoListOrdinal(el, info);
      const prefix = isOrderedMsoMarker(markerText)
        ? `${ordinal}. `
        : `${td.options.bulletListMarker} `;

      const isFirst = !msoListSibling(el, info, "previous");
      const isLast = !msoListSibling(el, info, "next");
      return (
        (isFirst ? "\n\n" : "") +
        indent +
        prefix +
        text.replace(/\n/g, `\n${indent}  `) +
        "\n" +
        (isLast ? "\n" : "")
      );
    },
  });

  return td;
}

interface MsoListInfo {
  id: string;
  level: number;
}

// Word glues a continuation suffix directly onto the class name with no
// separator — MsoListParagraphCxSpFirst/Middle/Last, no word boundary in
// between — for consecutive list paragraphs it treats as "connected" (to
// suppress extra spacing between them). It's a paragraph-spacing optimization
// unrelated to list structure: the mso-list style and marker span underneath
// are identical to the plain MsoListParagraph form.
const MSO_LIST_PARAGRAPH_CLASS =
  /\bMsoListParagraph(?:CxSpFirst|CxSpMiddle|CxSpLast)?\b/i;

/** Reads style="mso-list:l1 level2 lfo3" off a Word fake-list paragraph. */
function msoListInfo(el: Element): MsoListInfo | null {
  if (!/^(P|DIV)$/.test(el.nodeName)) return null;
  if (!MSO_LIST_PARAGRAPH_CLASS.test(el.getAttribute("class") ?? "")) {
    return null;
  }
  const style = el.getAttribute("style") ?? "";
  const m = /mso-list:\s*(\S+)\s+level(\d+)/i.exec(style);
  return m === null ? null : { id: m[1], level: Number(m[2]) };
}

// KNOWN LIMITATION: requiring the exact same level means a nested sub-list
// item breaks its parent level's run — e.g. "1. / (sub-item) / 2." sees the
// top-level "2." as starting a brand-new list (previousElementSibling is the
// level-2 item, not level-1), resetting its ordinal to "1" instead of
// continuing the sequence. Fixing this properly means walking past — not just
// rejecting — deeper-level siblings when computing adjacency/ordinal for a
// shallower level. Flat single-level Word lists (by far the common case) are
// unaffected; nested/outline lists may renumber incorrectly.

/** The adjacent sibling in the same direction, if it belongs to the same list. */
function msoListSibling(
  el: Element,
  info: MsoListInfo,
  direction: "previous" | "next",
): Element | null {
  const sib =
    direction === "previous"
      ? el.previousElementSibling
      : el.nextElementSibling;
  const sibInfo = sib === null ? null : msoListInfo(sib);
  return sibInfo !== null &&
    sibInfo.id === info.id &&
    sibInfo.level === info.level
    ? sib
    : null;
}

/** 1-based position of `el` within its run of same-list-id-and-level siblings. */
function msoListOrdinal(el: Element, info: MsoListInfo): number {
  let ordinal = 1;
  let sib = msoListSibling(el, info, "previous");
  while (sib !== null) {
    ordinal++;
    sib = msoListSibling(sib, info, "previous");
  }
  return ordinal;
}

// Word's marker glyph tells ordered from unordered: "1.", "a)", "iv." are
// ordered; a bare symbol (•, o, §, -, ▪ …) with no alphanumeric is a bullet.
function isOrderedMsoMarker(marker: string): boolean {
  return /^[0-9]+[.)]$|^[a-zA-Z][.)]$|^[ivxlcdm]+[.)]$/i.test(marker);
}

function alignmentOf(el: HTMLElement): string | null {
  const style = el.getAttribute("style") ?? "";
  const m = /text-align:\s*(center|right|justify)/i.exec(style);
  if (m !== null) return m[1].toLowerCase();
  const attr = el.getAttribute("align")?.toLowerCase();
  return attr === "center" || attr === "right" || attr === "justify"
    ? attr
    : null;
}

/**
 * Strip Word's clipboard scaffolding before conversion. <style>/<xml>/<o:p>
 * are handled structurally in service()'s turndown rules instead of here —
 * see the comment there for why regex can't safely remove those.
 */
function cleanWordHtml(html: string): string {
  return (
    html
      // Downlevel-hidden conditional comments (<!--[if ...]>...<![endif]-->):
      // this data (Word's XML/VML payloads) is never meant to render, so the
      // whole block is removed.
      .replace(/<!--\[if [\s\S]*?<!\[endif\]-->/gi, "")
      // Downlevel-revealed conditional comments (<![if ...]>...<![endif]>, no
      // <!--/--> wrapper): unlike the hidden form, this content DOES render —
      // it's how Word marks its fake-list bullet/number spans — so only the
      // marker tags themselves are stripped, never what's between them.
      .replace(/<!\[(?:if\b[^\]]*|endif)\]>/gi, "")
  );
}

export function htmlToMarkdown(html: string): string {
  const markdown = service().turndown(cleanWordHtml(html));
  // Collapse the blank-line pileups Word's nesting produces.
  return markdown.replace(/\n{3,}/g, "\n\n").trim();
}

// Tags that carry genuine formatting, as opposed to the bare structural
// containers (div/span/p/br/meta) a browser wraps plain text in. `<a>` only
// counts when it actually links somewhere.
const RICH_TAG =
  /<(h[1-6]|ul|ol|li|table|tr|td|th|thead|tbody|strong|b|em|i|u|s|strike|del|mark|sub|sup|code|pre|blockquote|img|hr)(\s|\/?>)/i;
const RICH_LINK = /<a\s[^>]*\bhref\s*=/i;

/**
 * Whether the clipboard's HTML flavor carries real formatting, or is just plain
 * text wrapped in structural containers.
 *
 * When you copy markdown SOURCE (from a "raw" view, a code box, a text editor),
 * the clipboard's text/html is your text wrapped in <div>/<br> with a <meta>
 * tag — no formatting. Running that through turndown escapes every markdown
 * character (`#### Focus` → `\#### Focus`), so the paste would never render.
 * In that case we should paste the plain-text flavor, which already IS markdown.
 * Only genuinely rich HTML (Word, Outlook, rendered web pages) is converted.
 *
 * A tag scan (rather than DOM parsing) keeps this identical across the WebView
 * and the test environment, and is all the decision needs.
 */
export function htmlHasRichFormatting(html: string): boolean {
  return RICH_TAG.test(html) || RICH_LINK.test(html);
}

/**
 * Whether plain-text clipboard content already appears to BE markdown source —
 * headings, list markers, bold, links, blockquotes, fenced or inline code.
 *
 * This is the primary paste decision: when the text is already markdown we paste
 * it verbatim, because routing the clipboard's HTML flavor through turndown
 * would escape the syntax (`#### Focus` → `\#### Focus`) or wrap it in a code
 * fence, and it would never render. It sidesteps the HTML wrapper entirely, so
 * it works no matter how the source app wrapped the text (<div>, <pre>, a
 * layout <table>, syntax-highlight <span>s…).
 *
 * Rich content copied from Word or a rendered web page carries none of these
 * markers in its plain-text flavor (that flavor is the stripped visible text),
 * so it still gets converted. And text with no markdown characters is unaffected
 * by turndown's escaping anyway, so this only ever needs to catch the cases
 * where escaping would do harm.
 *
 * Word is one exception: its plain-text flavor renders list items as
 * "•\titem" / "1.\titem" — a literal tab after the marker, which happens to
 * satisfy CommonMark's list-marker grammar too. A human typing markdown by
 * hand uses a space there, never a tab, so the list checks require one to
 * avoid mistaking a Word list dump for markdown source and skipping its (very
 * real) HTML conversion.
 */
export function looksLikeMarkdown(text: string): boolean {
  return (
    /^ {0,3}#{1,6}\s/m.test(text) || // ATX heading
    /^ {0,3}>[ \t]/m.test(text) || // blockquote
    /^ {0,3}[-*+] \S/m.test(text) || // bullet list
    /^ {0,3}\d+[.)] \S/m.test(text) || // ordered list
    /^ {0,3}(?:```|~~~)/m.test(text) || // fenced code
    /\*\*[^\s*][^*]*\*\*|__[^\s_][^_]*__/.test(text) || // bold
    /\[[^\]\n]+\]\([^)\s]+\)/.test(text) || // link
    /`[^`\n]+`/.test(text) // inline code
  );
}

/**
 * Tabular clipboard text (Excel, Sheets, any TSV) → a GFM table. Returns
 * null when the text is not a consistent tab-separated grid, so ordinary
 * multi-line pastes are left alone. The first row becomes the header.
 * Excel's plain-text flavor is clean TSV — far more reliable than its HTML.
 */
export function tsvToMarkdownTable(text: string): string | null {
  const lines = text.replace(/\r\n?/g, "\n").replace(/\n+$/, "").split("\n");
  if (lines.length < 2) return null;
  if (!lines.every((l) => l.includes("\t"))) return null;
  const rows = lines.map((l) => l.split("\t"));
  const cols = rows[0].length;
  if (cols < 2) return null;
  // Allow ragged rows but require the grid to be broadly consistent.
  if (!rows.every((r) => Math.abs(r.length - cols) <= 1)) return null;

  const esc = (c: string) => c.replace(/\|/g, "\\|").trim();
  const pad = (r: string[]) =>
    r.length >= cols
      ? r.slice(0, cols)
      : [...r, ...Array(cols - r.length).fill("")];
  const row = (r: string[]) => `| ${pad(r).map(esc).join(" | ")} |`;
  return [
    row(rows[0]),
    `| ${Array(cols).fill("---").join(" | ")} |`,
    ...rows.slice(1).map(row),
  ].join("\n");
}
