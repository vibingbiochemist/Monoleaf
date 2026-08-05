import { syntaxTree } from "@codemirror/language";
import type { SyntaxNode } from "@lezer/common";
import {
  EditorSelection,
  EditorState,
  StateCommand,
  TransactionSpec,
} from "@codemirror/state";
import { trimRange } from "./ranges";
import { hideCommentSyntax } from "./comments";
import type { AdmonitionKind } from "./admonitions";

/**
 * Formatting commands for silent WYSIWYG editing: they rewrite the raw
 * markdown so the user never has to type (or see) the syntax markers. All
 * are plain StateCommands operating on the main selection; they work
 * identically in live and raw view.
 */

/**
 * The main selection with leading/trailing whitespace excluded. Word
 * selections (double-click) often include the following space, and GFM
 * forbids whitespace just inside emphasis/strikethrough delimiters —
 * wrapping an untrimmed selection would emit markers that never parse.
 */
function trimmedMain(state: EditorState): { from: number; to: number } {
  const { from, to } = state.selection.main;
  return trimRange(state, from, to);
}

/**
 * Split [from, to] on blank lines into trimmed, non-empty segments. Inline
 * constructs (emphasis, strikethrough, links) cannot cross a paragraph
 * boundary, so wrapping must emit one marker pair per segment.
 */
function paragraphSegments(
  state: EditorState,
  from: number,
  to: number,
): { from: number; to: number }[] {
  if (from === to) return [{ from, to }];
  const text = state.doc.sliceString(from, to);
  const segments: { from: number; to: number }[] = [];
  const blank = /\n[ \t]*\n+/g;
  let start = 0;
  for (let m = blank.exec(text); m !== null; m = blank.exec(text)) {
    segments.push({ from: start, to: m.index });
    start = m.index + m[0].length;
  }
  segments.push({ from: start, to: text.length });
  return segments
    .map((s) => trimRange(state, from + s.from, from + s.to))
    .filter((s) => s.from < s.to);
}

/** Find the closest ancestor named `name` that spans [from, to]. */
function enclosing(
  state: EditorState,
  name: string,
  from: number,
  to: number,
): SyntaxNode | null {
  for (const side of [1, -1] as const) {
    for (
      let n: SyntaxNode | null = syntaxTree(state).resolveInner(from, side);
      n !== null;
      n = n.parent
    ) {
      if (n.name === name && n.from <= from && n.to >= to) return n;
    }
  }
  return null;
}

/** Toggle an inline wrapper construct like **bold** or `code`. */
function toggleInline(
  nodeName: string,
  markName: string,
  marker: string,
): StateCommand {
  return ({ state, dispatch }) => {
    const empty = state.selection.main.empty;
    const range = trimmedMain(state);
    const node = enclosing(state, nodeName, range.from, range.to);

    if (node !== null) {
      // Unwrap: delete the opening and closing marker tokens.
      const marks = node.getChildren(markName);
      if (marks.length < 2) return false;
      const first = marks[0];
      const last = marks[marks.length - 1];
      dispatch(
        state.update({
          changes: [
            { from: first.from, to: first.to },
            { from: last.from, to: last.to },
          ],
          userEvent: "delete.format",
        }),
      );
      return true;
    }

    // Wrap: one marker pair per paragraph segment; with an empty selection,
    // insert a single pair and put the cursor between them.
    const segments = paragraphSegments(state, range.from, range.to);
    if (segments.length === 0) return false;
    const single = segments.length === 1 ? segments[0] : null;
    dispatch(
      state.update({
        changes: segments.flatMap((seg) => [
          { from: seg.from, insert: marker },
          { from: seg.to, insert: marker },
        ]),
        selection:
          single === null
            ? undefined
            : empty
              ? EditorSelection.cursor(single.from + marker.length)
              : EditorSelection.range(
                  single.from + marker.length,
                  single.to + marker.length,
                ),
        userEvent: "input.format",
      }),
    );
    return true;
  };
}

/**
 * Underline and highlight have no markdown syntax; the convention (Typora
 * does the same) is inline HTML — CommonMark-legal, renders in the PDF and
 * HTML-enabled viewers, plain text to an LLM. Tags are hidden and styled in
 * the live view like any other marker.
 */
function toggleHtmlWrap(open: string, close: string): StateCommand {
  return ({ state, dispatch }) => {
    const empty = state.selection.main.empty;
    const range = trimmedMain(state);
    const text = state.sliceDoc(range.from, range.to);
    // Selection includes the tags (atomic hidden tags snap selections out).
    if (
      text.startsWith(open) &&
      text.endsWith(close) &&
      text.length >= open.length + close.length
    ) {
      dispatch(
        state.update({
          changes: [
            { from: range.from, to: range.from + open.length },
            { from: range.to - close.length, to: range.to },
          ],
          userEvent: "delete.format",
        }),
      );
      return true;
    }
    // Selection is exactly the wrapped content.
    const before = state.sliceDoc(
      Math.max(0, range.from - open.length),
      range.from,
    );
    const after = state.sliceDoc(
      range.to,
      Math.min(state.doc.length, range.to + close.length),
    );
    if (before === open && after === close) {
      dispatch(
        state.update({
          changes: [
            { from: range.from - open.length, to: range.from },
            { from: range.to, to: range.to + close.length },
          ],
          userEvent: "delete.format",
        }),
      );
      return true;
    }
    // Wrap, one pair per paragraph segment (inline HTML cannot cross a
    // blank line meaningfully).
    const segments = paragraphSegments(state, range.from, range.to);
    if (segments.length === 0) return false;
    const single = segments.length === 1 ? segments[0] : null;
    dispatch(
      state.update({
        changes: segments.flatMap((seg) => [
          { from: seg.from, insert: open },
          { from: seg.to, insert: close },
        ]),
        selection:
          single === null
            ? undefined
            : empty
              ? EditorSelection.cursor(single.from + open.length)
              : EditorSelection.range(
                  single.from + open.length,
                  single.to + open.length,
                ),
        userEvent: "input.format",
      }),
    );
    return true;
  };
}

export const toggleUnderline = toggleHtmlWrap("<u>", "</u>");
export const toggleHighlight = toggleHtmlWrap("<mark>", "</mark>");

export const toggleBold = toggleInline("StrongEmphasis", "EmphasisMark", "**");
export const toggleItalic = toggleInline("Emphasis", "EmphasisMark", "*");
export const toggleStrikethrough = toggleInline(
  "Strikethrough",
  "StrikethroughMark",
  "~~",
);
export const toggleInlineCode = toggleInline("InlineCode", "CodeMark", "`");
// Subscript ~x~ and superscript ^x^ (enhanced-mode constructs; the buttons
// insert the syntax regardless of mode, so in strict mode it shows as literal
// text and is flagged as non-portable — same as typing it by hand).
export const toggleSubscript = toggleInline("Subscript", "SubscriptMark", "~");
export const toggleSuperscript = toggleInline(
  "Superscript",
  "SuperscriptMark",
  "^",
);

// Insert an inline equation: wrap the selection in $…$, or drop an empty $|$
// with the cursor between the delimiters. Display math ($$…$$) is a keystroke
// away by typing a second $; the button targets the common inline case.
export const insertMath: StateCommand = ({ state, dispatch }) => {
  const range = state.selection.main;
  if (range.empty) {
    dispatch(
      state.update({
        changes: { from: range.from, insert: "$$" },
        selection: EditorSelection.cursor(range.from + 1),
        userEvent: "input.math",
      }),
    );
  } else {
    dispatch(
      state.update({
        changes: [
          { from: range.from, insert: "$" },
          { from: range.to, insert: "$" },
        ],
        selection: EditorSelection.range(range.from + 1, range.to + 1),
        userEvent: "input.math",
      }),
    );
  }
  return true;
};

/**
 * Portable markdown image reference: ![alt](url). Renders in the editor, the
 * PDF, and on GitHub; the pixels stay at the URL, never inside the .md.
 */
export function imageMarkup(url: string, alt: string): string {
  return `![${alt}](${url})`;
}

/**
 * Insert a GitHub-style admonition (`> [!NOTE]` … blockquote) around the
 * covered lines, or an empty template when there is nothing to wrap. Blank
 * lines are added around it so it parses as its own block.
 */
export function insertAdmonition(kind: AdmonitionKind): StateCommand {
  return ({ state, dispatch }) => {
    const sel = state.selection.main;
    const nl = state.lineBreak;
    const startLine = state.doc.lineAt(sel.from);
    const endLine = state.doc.lineAt(sel.to);
    const marker = `[!${kind.toUpperCase()}]`;
    const selected = state.doc.sliceString(startLine.from, endLine.to);
    const isEmpty = selected.trim() === "";
    const body = isEmpty
      ? "> "
      : selected
          .split(/\r?\n/)
          .map((l) => (l === "" ? ">" : `> ${l}`))
          .join(nl);
    const block = `> ${marker}${nl}${body}`;

    const needBefore =
      startLine.from > 0 && state.doc.lineAt(startLine.from - 1).length > 0;
    const needAfter =
      endLine.to < state.doc.length &&
      state.doc.lineAt(endLine.to + 1).length > 0;
    const insert = `${needBefore ? nl : ""}${block}${needAfter ? nl : ""}`;
    const cursor =
      startLine.from +
      (needBefore ? nl.length : 0) +
      `> ${marker}${nl}> `.length;

    dispatch(
      state.update({
        changes: { from: startLine.from, to: endLine.to, insert },
        selection: isEmpty ? EditorSelection.cursor(cursor) : undefined,
        userEvent: "input.admonition",
        scrollIntoView: true,
      }),
    );
    return true;
  };
}

// ---------------------------------------------------------------------------
// Change case (Word-style). Pure text transforms on the selection — no
// markdown markers involved (punctuation like ** is unaffected by case), so
// this stays faithful to the raw source. With no selection it acts on the word
// under the cursor, like Word.

export type CaseMode = "upper" | "lower" | "title" | "sentence";

// A "word" for title-casing: a letter followed by letters, combining marks, or
// apostrophes. Unicode-aware so accented and non-Latin scientific text works.
const CASE_WORD_RE = /\p{L}[\p{L}\p{M}'’]*/gu;

export function transformCase(text: string, mode: CaseMode): string {
  switch (mode) {
    case "upper":
      return text.toUpperCase();
    case "lower":
      return text.toLowerCase();
    case "title":
      return text.replace(
        CASE_WORD_RE,
        (w) => w[0].toUpperCase() + w.slice(1).toLowerCase(),
      );
    case "sentence":
      return text
        .toLowerCase()
        .replace(
          /(^|[.!?]\s+)(\p{L})/gu,
          (_m, lead, c) => lead + c.toUpperCase(),
        );
  }
}

export function changeCase(mode: CaseMode): StateCommand {
  return ({ state, dispatch }) => {
    let range: { from: number; to: number } = state.selection.main;
    if (range.from === range.to) {
      const word = state.wordAt(state.selection.main.head);
      if (word === null) return false; // nothing to transform
      range = word;
    }
    const text = state.sliceDoc(range.from, range.to);
    const next = transformCase(text, mode);
    if (next === text) return false;
    dispatch(
      state.update({
        changes: { from: range.from, to: range.to, insert: next },
        selection: EditorSelection.range(range.from, range.from + next.length),
        userEvent: "input.case",
      }),
    );
    return true;
  };
}

// ---------------------------------------------------------------------------
// Clear inline formatting from a selection. The emphasis/code/etc. markers are
// found via the syntax tree (nesting-safe — e.g. ***both*** or a link with bold
// text), so only genuine markers are removed, never literal punctuation. Links
// and images collapse to their text/alt; our <u>/<mark> HTML constructs go too.

const INLINE_MARKS = new Set([
  "EmphasisMark", // * _ (italic) and ** __ (bold)
  "StrikethroughMark", // ~~
  "CodeMark", // ` (inline code)
  "SubscriptMark", // ~
  "SuperscriptMark", // ^
]);

// The formatted spans whose markers we clear. If the selection touches any part
// of one, its WHOLE range is cleared — otherwise a marker straddling the
// selection edge would leave an orphaned "*" behind.
const INLINE_SPANS = new Set([
  "Emphasis",
  "StrongEmphasis",
  "Strikethrough",
  "InlineCode",
  "Subscript",
  "Superscript",
  "Link",
  "Image",
]);

export const clearFormatting: StateCommand = ({ state, dispatch }) => {
  const sel = state.selection.main;
  if (sel.empty) return false; // nothing selected

  // Expand to cover every inline-formatting span the selection touches, so a
  // marker is never cut in half (which would leave a stray * or ]).
  let from = sel.from;
  let to = sel.to;
  const tree = syntaxTree(state);
  tree.iterate({
    from: sel.from,
    to: sel.to,
    enter: (node) => {
      if (INLINE_SPANS.has(node.name)) {
        from = Math.min(from, node.from);
        to = Math.max(to, node.to);
      }
    },
  });

  // Collect the marker ranges within the (expanded) window, in document order.
  const marks: [number, number][] = [];
  tree.iterate({
    from,
    to,
    enter: (node) => {
      if (INLINE_MARKS.has(node.name)) marks.push([node.from, node.to]);
    },
  });
  marks.sort((a, b) => a[0] - b[0]);

  // Rebuild the selection text without those markers.
  let stripped = "";
  let cursor = from;
  for (const [mFrom, mTo] of marks) {
    if (mFrom > cursor) stripped += state.sliceDoc(cursor, mFrom);
    cursor = Math.max(cursor, mTo);
  }
  stripped += state.sliceDoc(cursor, to);

  // Links/images → text/alt, and drop our inline-HTML formatting tags.
  const cleaned = stripped
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<\/?(?:u|mark)>/gi, "");

  const original = state.sliceDoc(from, to);
  if (cleaned === original) return false;
  dispatch(
    state.update({
      changes: { from, to, insert: cleaned },
      selection: EditorSelection.range(from, from + cleaned.length),
      userEvent: "delete.format",
    }),
  );
  return true;
};

// ---------------------------------------------------------------------------
// Blockquote toggle: add "> " to the selected lines, or strip it when every
// non-blank line already carries it (Word-style toggle). Blank lines inside the
// range are quoted too, so a multi-paragraph quote stays one block.

const QUOTE_RE = /^(\s*)> ?/;

export const toggleQuote: StateCommand = ({ state, dispatch }) => {
  const sel = state.selection.main;
  const firstNo = state.doc.lineAt(sel.from).number;
  const lastNo = state.doc.lineAt(sel.to).number;
  const lines = [];
  for (let n = firstNo; n <= lastNo; n++) lines.push(state.doc.line(n));

  const nonBlank = lines.filter((l) => l.text.trim() !== "");
  const allQuoted =
    nonBlank.length > 0 && nonBlank.every((l) => QUOTE_RE.test(l.text));

  const changes: { from: number; to?: number; insert: string }[] = [];
  for (const l of lines) {
    const m = QUOTE_RE.exec(l.text);
    if (allQuoted) {
      if (m !== null)
        changes.push({ from: l.from, to: l.from + m[0].length, insert: "" });
    } else if (m === null) {
      changes.push({ from: l.from, insert: "> " });
    }
  }
  if (changes.length === 0) return false;
  dispatch(
    state.update({
      changes,
      userEvent: allQuoted ? "delete.quote" : "input.quote",
      scrollIntoView: true,
    }),
  );
  return true;
};

// Up to 3 leading spaces is still a heading per CommonMark.
// ---------------------------------------------------------------------------
// Paragraph alignment via <div align="…"> blocks. The legacy align attribute
// is the one styling mechanism GitHub's sanitizer keeps, so center/right
// genuinely render there ("justify" falls back to left on GitHub but works
// in the PDF and any browser view).

export type Alignment = "left" | "center" | "right" | "justify";

const ALIGN_OPEN_RE = /^<div align="(left|center|right|justify)">\s*$/;
const DIV_CLOSE_RE = /^<\/div>\s*$/;

export interface AlignWrapper {
  align: Alignment;
  openLine: number;
  closeLine: number;
}

/** Find the align wrapper enclosing the given line range, if any. */
export function findAlignWrapper(
  state: EditorState,
  lineFrom: number,
  lineTo: number,
): AlignWrapper | null {
  const doc = state.doc;
  let open: { align: Alignment; line: number } | null = null;
  for (let n = lineFrom; n >= 1; n--) {
    const text = doc.line(n).text;
    const m = ALIGN_OPEN_RE.exec(text);
    if (m !== null) {
      open = { align: m[1] as Alignment, line: n };
      break;
    }
    if (n < lineFrom && DIV_CLOSE_RE.test(text)) return null;
  }
  if (open === null) return null;
  for (let n = Math.max(lineTo, open.line + 1); n <= doc.lines; n++) {
    const text = doc.line(n).text;
    if (DIV_CLOSE_RE.test(text)) {
      return { align: open.align, openLine: open.line, closeLine: n };
    }
    if (n > lineTo && ALIGN_OPEN_RE.test(text)) return null;
  }
  return null;
}

export function setAlignment(align: Alignment): StateCommand {
  return ({ state, dispatch }) => {
    const sel = state.selection.main;
    let lineFrom = state.doc.lineAt(sel.from).number;
    let lineTo = state.doc.lineAt(sel.to).number;
    const nl = state.lineBreak;
    const wrapper = findAlignWrapper(state, lineFrom, lineTo);

    if (wrapper !== null) {
      const openLine = state.doc.line(wrapper.openLine);
      if (align !== "left" && align !== wrapper.align) {
        // Rewrite the wrapper in place.
        dispatch(
          state.update({
            changes: {
              from: openLine.from,
              to: openLine.to,
              insert: `<div align="${align}">`,
            },
            userEvent: "input.format",
          }),
        );
        return true;
      }
      // Remove the wrapper (back to default left / toggling the same align
      // off). Each tag line goes together with its blank spacer line.
      const closeLine = state.doc.line(wrapper.closeLine);
      const blankAfterOpen =
        wrapper.openLine < state.doc.lines &&
        state.doc.line(wrapper.openLine + 1).length === 0;
      const openTo = blankAfterOpen
        ? state.doc.line(wrapper.openLine + 1).to + 1
        : openLine.to + 1;
      const blankBeforeClose =
        wrapper.closeLine > 1 &&
        state.doc.line(wrapper.closeLine - 1).length === 0;
      const closeFrom =
        (blankBeforeClose
          ? state.doc.line(wrapper.closeLine - 1).from
          : closeLine.from) - 1;
      dispatch(
        state.update({
          changes: [
            { from: openLine.from, to: Math.min(openTo, state.doc.length) },
            { from: Math.max(closeFrom, 0), to: closeLine.to },
          ],
          userEvent: "delete.format",
        }),
      );
      return true;
    }

    if (align === "left") return false; // left is the default
    // Expand to whole paragraphs (blank-line bounded), like Word.
    while (lineFrom > 1 && state.doc.line(lineFrom - 1).length > 0) lineFrom--;
    while (lineTo < state.doc.lines && state.doc.line(lineTo + 1).length > 0) {
      lineTo++;
    }
    const start = state.doc.line(lineFrom).from;
    const end = state.doc.line(lineTo).to;
    if (start === end) return false; // nothing to align on a blank line
    dispatch(
      state.update({
        changes: [
          { from: start, insert: `<div align="${align}">${nl}${nl}` },
          { from: end, insert: `${nl}${nl}</div>` },
        ],
        userEvent: "input.format",
      }),
    );
    return true;
  };
}

const BULLET_RE = /^(\s*)[-*+] +/;
const ORDERED_RE = /^(\s*)\d+\. +/;
// A task item is a bullet whose content starts with a [ ] / [x] checkbox.
const TASK_RE = /^(\s*)[-*+] +\[[ xX]\] +/;

/**
 * Toggle bullet or numbered list on the selected lines (Word-style). If
 * every non-empty line is already that kind, the markers are stripped;
 * otherwise the marker is applied (numbered lists renumber from 1). Switches
 * cleanly between the two kinds.
 */
export function toggleList(kind: "bullet" | "ordered" | "task"): StateCommand {
  return ({ state, dispatch }) => {
    const range = state.selection.main;
    const first = state.doc.lineAt(range.from).number;
    const last = state.doc.lineAt(range.to).number;
    const re =
      kind === "bullet" ? BULLET_RE : kind === "ordered" ? ORDERED_RE : TASK_RE;

    const lines = [];
    for (let n = first; n <= last; n++) lines.push(state.doc.line(n));
    // Normally list only non-empty lines, but with a collapsed cursor on a
    // blank line, apply to it so the user can pick the list then type.
    const collapsed = range.from === range.to;
    const content = lines.filter(
      (l) => l.text.trim() !== "" || (collapsed && lines.length === 1),
    );
    if (content.length === 0) return false;
    const allAlready = content.every((l) => re.test(l.text));

    const changes: { from: number; to: number; insert?: string }[] = [];
    let index = 1;
    // Pre-format flow: cursor on an empty line, apply a marker, then type.
    // The insert sits at the cursor, so the cursor must be moved past it.
    const emptyPreformat =
      collapsed &&
      !allAlready &&
      content.length === 1 &&
      content[0].length === 0;
    let anchor: number | undefined;
    for (const line of content) {
      // Detect the fullest existing marker (task includes the bullet), so a
      // switch replaces it cleanly rather than leaving a stray "[ ]".
      const existing =
        TASK_RE.exec(line.text) ??
        BULLET_RE.exec(line.text) ??
        ORDERED_RE.exec(line.text);
      const markerEnd = line.from + (existing ? existing[0].length : 0);
      if (allAlready) {
        changes.push({ from: line.from, to: markerEnd });
      } else {
        const marker =
          kind === "bullet"
            ? "- "
            : kind === "ordered"
              ? `${index++}. `
              : "- [ ] ";
        changes.push({ from: line.from, to: markerEnd, insert: marker });
        if (emptyPreformat) anchor = line.from + marker.length;
      }
    }
    dispatch(
      state.update({
        changes,
        selection: anchor === undefined ? undefined : { anchor },
        userEvent: "input.format",
      }),
    );
    return true;
  };
}

export const toggleBulletList = toggleList("bullet");
export const toggleOrderedList = toggleList("ordered");
export const toggleTaskList = toggleList("task");

const HEADING_PREFIX = /^ {0,3}#{1,6} +/;

/** Set the ATX heading level (1–6) of every selected line; 0 clears it. */
export function setHeading(level: number): StateCommand {
  return ({ state, dispatch }) => {
    const range = state.selection.main;
    const prefix = level > 0 ? "#".repeat(level) + " " : "";
    const changes: { from: number; to?: number; insert?: string }[] = [];
    // Pre-format flow: heading picked on an empty line, then typed into. The
    // prefix inserts at the cursor, so move the cursor past it.
    const cursorLine = state.doc.lineAt(range.from);
    const emptyPreformat =
      range.empty && cursorLine.length === 0 && prefix !== "";
    let anchor: number | undefined;
    let pos = range.from;
    for (;;) {
      const line = state.doc.lineAt(pos);
      const existing = HEADING_PREFIX.exec(line.text);
      if (existing !== null) {
        changes.push({
          from: line.from,
          to: line.from + existing[0].length,
          insert: prefix,
        });
        // Apply to an empty line only when it is the cursor's own line, so
        // "pick Heading, then type" works without prefixing blank lines in
        // a multi-line selection.
      } else if (prefix !== "" && (line.length > 0 || range.empty)) {
        changes.push({ from: line.from, insert: prefix });
        if (emptyPreformat && line.from === cursorLine.from) {
          anchor = line.from + prefix.length;
        }
      }
      if (line.to >= range.to) break;
      pos = line.to + 1;
    }
    if (changes.length === 0) return false;
    dispatch(
      state.update({
        changes,
        selection: anchor === undefined ? undefined : { anchor },
        userEvent: "input.format",
      }),
    );
    return true;
  };
}

const BLOCK_CONTEXT = /^(ListItem|Blockquote|FencedCode|CodeBlock|Table)$/;

function inBlockContext(state: EditorState, pos: number): boolean {
  for (
    let n: SyntaxNode | null = syntaxTree(state).resolveInner(pos, -1);
    n !== null;
    n = n.parent
  ) {
    if (BLOCK_CONTEXT.test(n.name)) return true;
  }
  return false;
}

/**
 * Word-like Enter in the live view: a new PARAGRAPH, which in markdown is a
 * blank line (a single newline is only a soft break that renders as a
 * space). Inside lists, quotes, code blocks and tables it falls through to
 * the markdown keymap's smart continuation. Raw view keeps plain newlines.
 */
export const paragraphEnter: StateCommand = ({ state, dispatch }) => {
  if (!state.facet(hideCommentSyntax)) return false; // raw view
  const range = state.selection.main;
  if (inBlockContext(state, range.from)) return false;
  const nl = state.lineBreak;
  dispatch(
    state.update({
      changes: { from: range.from, to: range.to, insert: nl + nl },
      selection: EditorSelection.cursor(range.from + 2),
      userEvent: "input.type",
      scrollIntoView: true,
    }),
  );
  return true;
};

/**
 * Word-like Shift+Enter: a hard line break inside the paragraph, written as
 * CommonMark's backslash break so it renders as a real line break in every
 * viewer. Inside code blocks it is just a newline.
 */
export const hardBreakEnter: StateCommand = ({ state, dispatch }) => {
  if (!state.facet(hideCommentSyntax)) return false; // raw view
  const range = state.selection.main;
  const nl = state.lineBreak;
  // A heading is single-line in markdown, but Word keeps the style on a
  // Shift+Enter — so continue on a new line with the SAME heading prefix
  // (a second heading line of the same level), no stray "\".
  const headingPrefix = /^ {0,3}#{1,6} /.exec(
    state.doc.lineAt(range.from).text,
  );
  if (headingPrefix !== null) {
    const insert = nl + headingPrefix[0];
    dispatch(
      state.update({
        changes: { from: range.from, to: range.to, insert },
        selection: EditorSelection.cursor(range.from + insert.length),
        userEvent: "input.type",
        scrollIntoView: true,
      }),
    );
    return true;
  }
  const insert = inBlockContext(state, range.from) ? nl : `\\${nl}`;
  dispatch(
    state.update({
      changes: { from: range.from, to: range.to, insert },
      selection: EditorSelection.cursor(
        range.from + insert.length - nl.length + 1,
      ),
      userEvent: "input.type",
      scrollIntoView: true,
    }),
  );
  return true;
};

/**
 * Backspace at the start of a line whose previous line ends with a hard-break
 * "\" removes the backslash AND the newline together, so undoing a Shift+Enter
 * never leaves a dangling, suddenly-visible "\". Falls through (returns false)
 * otherwise so normal backspace is unaffected.
 */
export const deleteHardBreakBackward: StateCommand = ({ state, dispatch }) => {
  if (!state.facet(hideCommentSyntax)) return false; // live view only
  const range = state.selection.main;
  if (!range.empty) return false;
  const line = state.doc.lineAt(range.head);
  if (range.head !== line.from || line.number === 1) return false;
  const prev = state.doc.line(line.number - 1);
  if (!prev.text.endsWith("\\")) return false;
  dispatch(
    state.update({
      changes: { from: prev.to - 1, to: line.from }, // the "\" and the newline
      selection: EditorSelection.cursor(prev.to - 1),
      userEvent: "delete.backward",
    }),
  );
  return true;
};

// ---------------------------------------------------------------------------
// Table of contents

export const TOC_START = "<!--ml:toc-->";
export const TOC_END = "<!--ml:toc-end-->";

/** GitHub-style heading anchor slug. */
export function headingSlug(text: string): string {
  // Matches GitHub's slugger: lowercase, drop punctuation, then turn EACH
  // whitespace char into a hyphen (consecutive spaces are not collapsed).
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .trim()
    .replace(/\s/g, "-");
}

export interface HeadingInfo {
  line: number;
  level: number;
  title: string;
  slug: string;
}

/** All ATX headings in document order, with de-duplicated GitHub slugs.
 * Headings inside fenced code and the TOC block itself are skipped. */
export function collectHeadings(state: EditorState): HeadingInfo[] {
  const out: HeadingInfo[] = [];
  const counts = new Map<string, number>();
  let inFence = false;
  let inToc = false;
  for (let n = 1; n <= state.doc.lines; n++) {
    const text = state.doc.line(n).text;
    const trimmed = text.trim();
    if (trimmed === TOC_START) {
      inToc = true;
      continue;
    }
    if (trimmed === TOC_END) {
      inToc = false;
      continue;
    }
    if (inToc) continue;
    if (/^\s*(```|~~~)/.test(text)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = /^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(text);
    if (m === null) continue;
    const title = m[2].trim();
    const base = headingSlug(title);
    const c = counts.get(base) ?? 0;
    counts.set(base, c + 1);
    out.push({
      line: n,
      level: m[1].length,
      title,
      slug: c === 0 ? base : `${base}-${c}`,
    });
  }
  return out;
}

function buildTocList(state: EditorState): string {
  const headings = collectHeadings(state);
  if (headings.length === 0) return "*No headings yet.*";
  const min = Math.min(...headings.map((h) => h.level));
  const nl = state.lineBreak;
  return headings
    .map((h) => `${"  ".repeat(h.level - min)}- [${h.title}](#${h.slug})`)
    .join(nl);
}

/**
 * Insert a table of contents at the cursor, or refresh the existing one in
 * place. The TOC is a plain markdown list of links (portable, GitHub-style
 * anchors); invisible HTML-comment markers bound it so a re-run updates it.
 */
export const insertTableOfContents: StateCommand = ({ state, dispatch }) => {
  const nl = state.lineBreak;
  const block = `${TOC_START}${nl}${buildTocList(state)}${nl}${TOC_END}`;

  let startLine = -1;
  let endLine = -1;
  for (let n = 1; n <= state.doc.lines; n++) {
    const t = state.doc.line(n).text.trim();
    if (t === TOC_START) startLine = n;
    else if (t === TOC_END && startLine > 0) {
      endLine = n;
      break;
    }
  }

  if (startLine > 0 && endLine > 0) {
    dispatch(
      state.update({
        changes: {
          from: state.doc.line(startLine).from,
          to: state.doc.line(endLine).to,
          insert: block,
        },
        userEvent: "input.toc",
      }),
    );
    return true;
  }

  const range = state.selection.main;
  const atStart = range.from === state.doc.lineAt(range.from).from;
  const insert = `${atStart ? "" : nl}${block}${nl}${nl}`;
  dispatch(
    state.update({
      changes: { from: range.from, to: range.to, insert },
      selection: EditorSelection.cursor(range.from + insert.length),
      userEvent: "input.toc",
    }),
  );
  return true;
};

/**
 * Word's Ctrl+Enter: insert an explicit page break. The directive is an
 * HTML comment — invisible in any dumb viewer — that the PDF pipeline turns
 * into a forced page break.
 */
export const insertPageBreak: StateCommand = ({ state, dispatch }) => {
  const range = state.selection.main;
  const nl = state.lineBreak;
  const line = state.doc.lineAt(range.from);
  const atLineStart = range.from === line.from;
  // A blank line AFTER the directive is required: without it, markdown folds
  // the following content into the directive's raw HTML block, so there is
  // no separate block for the forced break to push to a new page (breaks
  // both the PDF break and the editor page gap).
  const insert = (atLineStart ? "" : nl) + "<!--ml:pagebreak-->" + nl + nl;
  dispatch(
    state.update({
      changes: { from: range.from, to: range.to, insert },
      selection: EditorSelection.cursor(range.from + insert.length),
      userEvent: "input.pagebreak",
    }),
  );
  return true;
};

/** The URL of the inline link enclosing the main selection, if any. */
export function linkAt(
  state: EditorState,
): { urlFrom: number; urlTo: number } | null {
  const range = trimmedMain(state);
  const link = enclosing(state, "Link", range.from, range.to);
  const url = link?.getChild("URL");
  return url ? { urlFrom: url.from, urlTo: url.to } : null;
}

/**
 * Apply a link URL: rewrite the URL of the enclosing link, or wrap the
 * selection as [text](url). An empty selection inserts [link](url) with the
 * placeholder text selected for immediate overtyping.
 */
export function applyLink(state: EditorState, url: string): TransactionSpec {
  const existing = linkAt(state);
  if (existing !== null) {
    return {
      changes: { from: existing.urlFrom, to: existing.urlTo, insert: url },
      userEvent: "input.format",
    };
  }
  const range = trimmedMain(state);
  if (range.from === range.to) {
    const placeholder = "link";
    return {
      changes: { from: range.from, insert: `[${placeholder}](${url})` },
      selection: EditorSelection.range(
        range.from + 1,
        range.from + 1 + placeholder.length,
      ),
      userEvent: "input.format",
    };
  }
  return {
    changes: [
      { from: range.from, insert: "[" },
      { from: range.to, insert: `](${url})` },
    ],
    selection: EditorSelection.cursor(
      range.to + url.length + 4, // past "[" + "](" + url + ")"
    ),
    userEvent: "input.format",
  };
}
