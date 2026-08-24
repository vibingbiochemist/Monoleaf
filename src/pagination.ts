import { EditorState, StateEffect, StateField } from "@codemirror/state";
import {
  Decoration,
  DecorationSet,
  EditorView,
  WidgetType,
} from "@codemirror/view";
import { splitRowWithPositions } from "./table";
import { cellDisplayTextWithMap } from "./tablecell";

/**
 * Accurate in-editor page awareness. A background job (main.ts) runs the
 * exact PDF pipeline — markdown-it with data-srcline attributes, the real
 * print CSS, Paged.js — in a hidden container, reads where the real page
 * breaks fall, and maps them back to editor positions via source lines.
 *
 * Nothing here ever touches the document text: breaks are decorations only,
 * recomputed after edits. The .md stays clean for dumb viewers and LLMs.
 */

export interface PageBreak {
  /** Editor position of the first block that starts on the new page. */
  pos: number;
  /** The page number that begins here (2, 3, …). */
  page: number;
}

class PageBreakWidget extends WidgetType {
  constructor(readonly page: number) {
    super();
  }
  eq(other: PageBreakWidget) {
    return other.page === this.page;
  }
  toDOM() {
    // Word-style page separation: the finishing page's bottom margin with
    // its page number, a canvas-colored gap, then the next page's top edge.
    const el = document.createElement("div");
    el.className = "cm-page-gap";

    const bottom = document.createElement("div");
    bottom.className = "cm-page-gap-bottom";
    const num = document.createElement("span");
    num.className = "cm-page-num";
    num.textContent = String(this.page - 1);
    bottom.appendChild(num);

    const space = document.createElement("div");
    space.className = "cm-page-gap-space";

    const top = document.createElement("div");
    top.className = "cm-page-gap-top";

    el.append(bottom, space, top);
    return el;
  }
  ignoreEvent() {
    return true;
  }
}

export const setPageBreaks = StateEffect.define<PageBreak[]>({
  map: (breaks, mapping) =>
    breaks.map((b) => ({ ...b, pos: mapping.mapPos(b.pos) })),
});

export function buildPageBreakDecorations(breaks: PageBreak[]): DecorationSet {
  return Decoration.set(
    breaks.map((b) =>
      Decoration.widget({
        widget: new PageBreakWidget(b.page),
        block: true,
        side: -1,
      }).range(b.pos),
    ),
    true,
  );
}

export const pageBreaksField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(setPageBreaks)) deco = buildPageBreakDecorations(e.value);
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

/** The current page breaks as plain {pos, page} data, for consumers (like
 * tablewidget.ts) that need the positions without depending on
 * PageBreakWidget or decoration internals. [] when pagination is off (the
 * field doesn't exist outside livePreviewExtensions). */
export function pageBreakPositions(state: EditorState): PageBreak[] {
  const deco = state.field(pageBreaksField, false);
  if (deco === undefined) return [];
  const result: PageBreak[] = [];
  const it = deco.iter();
  while (it.value !== null) {
    const widget = (it.value.spec as { widget?: { page: number } }).widget;
    if (widget !== undefined) result.push({ pos: it.from, page: widget.page });
    it.next();
  }
  return result;
}

/** The stale, clone-inherited data-srcline of a continuation-only page — the
 * block it's continuing, identified by that block's own start line — or
 * null if the page isn't a pure continuation (no data-srcline at all). */
function continuationStartLine(page: Element): number | null {
  const marker = page.querySelector("[data-srcline]");
  if (marker === null) return null;
  const line = Number(marker.getAttribute("data-srcline"));
  return Number.isFinite(line) ? line : null;
}

export interface BreakToken {
  node: Node;
  offset: number;
}

/** Map a Paged.js break token to an exact editor position, when the
 * straddling block is confirmed plain text (no inline formatting) — null
 * otherwise, so the caller falls back to the proportional approximation
 * below. The token's node lives in Paged.js's untouched SOURCE tree (the
 * same one runPagination() built, carrying data-srcline/-end), never the
 * cloned/rendered output, so walking up to the nearest [data-srcline]
 * ancestor and using the DOM Range API gives the exact rendered text
 * between the block's start and the break — as long as that text is a
 * straight character-for-character match against a whitespace-normalized
 * copy of the source (CommonMark renders a soft line break as one space),
 * which rules out anything reshaped by inline markup (bold, links, code,
 * entities) before trusting the mapped-back offset. */
export function resolveExactBreakPos(
  token: BreakToken,
  state: EditorState,
): number | null {
  const startEl =
    token.node.nodeType === Node.ELEMENT_NODE
      ? (token.node as Element)
      : token.node.parentElement;
  const blockEl = startEl?.closest("[data-srcline]");
  if (blockEl == null) return null;

  const startLine = Number(blockEl.getAttribute("data-srcline"));
  const endLine = Number(blockEl.getAttribute("data-srcline-end"));
  if (!Number.isFinite(startLine) || !Number.isFinite(endLine)) return null;

  const blockFrom = state.doc.line(
    Math.min(startLine + 1, state.doc.lines),
  ).from;
  const blockTo = state.doc.line(Math.min(endLine, state.doc.lines)).to;

  if (blockEl.tagName === "TR") {
    return resolveTableCellBreakPos(token, state, blockEl, blockFrom, blockTo);
  }

  const sourceText = state.doc.sliceString(blockFrom, blockTo);

  // Collapse whitespace runs to a single space, the same way CommonMark
  // renders a soft line break, recording each output character's original
  // source index so a match can be mapped back exactly.
  let normalized = "";
  const toOriginal: number[] = [];
  for (let i = 0; i < sourceText.length;) {
    if (/\s/.test(sourceText[i])) {
      toOriginal.push(i);
      normalized += " ";
      while (i < sourceText.length && /\s/.test(sourceText[i])) i++;
    } else {
      toOriginal.push(i);
      normalized += sourceText[i];
      i++;
    }
  }
  if (normalized !== blockEl.textContent) return null; // formatted — bail

  const range = document.createRange();
  range.setStart(blockEl, 0);
  if (token.node.nodeType === Node.TEXT_NODE) {
    const len = token.node.textContent?.length ?? 0;
    range.setEnd(token.node, Math.min(token.offset, len));
  } else {
    range.setEnd(token.node, 0);
  }
  const renderedOffset = range.toString().length;
  if (renderedOffset > normalized.length) return null;

  const originalIndex =
    renderedOffset < normalized.length
      ? toOriginal[renderedOffset]
      : sourceText.length;
  return blockFrom + originalIndex;
}

/**
 * resolveExactBreakPos's table-row path. A <tr>'s own textContent can't be
 * used the way a paragraph's can: markdown-it's HTML output puts a literal
 * newline between sibling <td>s, which a browser parses as real text nodes
 * between them — no per-cell concatenation without separators can ever
 * reproduce that, so matching at the row level would always fail. Instead,
 * find the <td>/<th> ancestor of the break token's node and match just that
 * ONE cell's rendered text against its own raw source span — a single cell
 * has no injected newlines inside it, and precision degrades per cell
 * rather than per row (a plain cell can resolve exactly even if a sibling
 * cell in the same row has rich markdown formatting).
 */
function resolveTableCellBreakPos(
  token: BreakToken,
  state: EditorState,
  rowEl: Element,
  rowFrom: number,
  rowTo: number,
): number | null {
  const startEl =
    token.node.nodeType === Node.ELEMENT_NODE
      ? (token.node as Element)
      : token.node.parentElement;
  const cellEl = startEl?.closest("td, th");
  // No cell ancestor (the break landed on inter-cell whitespace) or it
  // belongs to some OTHER row entirely: nothing to anchor to here.
  if (cellEl == null || !rowEl.contains(cellEl)) return null;

  const cells = Array.from((rowEl as HTMLTableRowElement).cells ?? []);
  const colIndex = cells.indexOf(cellEl as HTMLTableCellElement);
  if (colIndex === -1) return null;

  const rowText = state.doc.sliceString(rowFrom, rowTo);
  const span = splitRowWithPositions(rowText)[colIndex];
  // An escaped "\|" would need reconciling two different index spaces
  // (source vs. unescaped model text) for one rare case — bail instead.
  if (span === undefined || span.raw.includes("\\|")) return null;

  const { text: expected, toOriginal } = cellDisplayTextWithMap(span.raw);
  if (expected !== cellEl.textContent) return null; // formatted — bail

  const range = document.createRange();
  range.setStart(cellEl, 0);
  if (token.node.nodeType === Node.TEXT_NODE) {
    const len = token.node.textContent?.length ?? 0;
    range.setEnd(token.node, Math.min(token.offset, len));
  } else {
    range.setEnd(token.node, 0);
  }
  const renderedOffset = range.toString().length;
  // Exactly at a cell boundary isn't a mid-cell split — the row-level
  // fallback owns boundary cases uniformly (extractPageBreaks' existing
  // strict-inequality convention for "inside" a table's range).
  if (renderedOffset <= 0 || renderedOffset >= expected.length) return null;

  return rowFrom + span.start + toOriginal[renderedOffset];
}

/**
 * Read the real break positions out of Paged.js output. Pages after the
 * first look for their first block that carries a source line — anchoring
 * there is exact, since that block genuinely starts fresh on this page.
 *
 * When every candidate on a page is instead a continuation of a block that
 * started earlier (data-split-from), there's no exact position to anchor
 * to: Paged.js clones the original element's data-srcline onto the
 * continuation without updating it (so it points at the block's START, on
 * the *previous* page), and the real cut point — mid-word, wherever the
 * page happened to run out of room — never reaches the DOM at all; Paged.js
 * only writes the already-sliced text. Given a run of N consecutive
 * continuation pages for the SAME block (data-srcline unchanged across
 * them), this spreads their markers evenly across that block's own
 * character span — 1/(N+1), 2/(N+1), … through it — rather than collapsing
 * them all onto one position (the bug this replaced) or all onto the
 * block's end (which is exact only when N is 1, and wrong for a paragraph
 * spanning many pages, exactly the kind of long, single-block prose this
 * editor naturally produces since it never hard-wraps as you type). With
 * nothing else to go on, even spacing is the least-wrong assumption; each
 * marker is still guaranteed on-or-after its page's actual content and
 * distinct from every other page's.
 */
export function extractPageBreaks(
  container: Element,
  state: EditorState,
  exactBreaks?: ReadonlyMap<number, BreakToken | undefined>,
): { breaks: PageBreak[]; pages: number } {
  const pages = Array.from(container.querySelectorAll(".pagedjs_page"));
  const breaks: PageBreak[] = [];
  const seen = new Set<number>();

  const addBreak = (pos: number, page: number) => {
    if (seen.has(pos)) return;
    seen.add(pos);
    breaks.push({ pos, page });
  };

  let i = 1; // page index 0 never gets a break — it's the document's start.
  while (i < pages.length) {
    // A break token is keyed by the PAGE IT ENDS (i - 1) — the exact point
    // where page i begins. Preferred over the fresh/continuation heuristics
    // below whenever the straddling block is confirmed plain text.
    const exact = exactBreaks?.get(i - 1);
    const exactPos = exact ? resolveExactBreakPos(exact, state) : null;
    if (exactPos !== null) {
      addBreak(exactPos, i + 1);
      i++;
      continue;
    }

    const fresh = pages[i].querySelector(
      "[data-srcline]:not([data-split-from])",
    );
    if (fresh !== null) {
      const line = Number(fresh.getAttribute("data-srcline"));
      if (Number.isFinite(line)) {
        addBreak(
          state.doc.line(Math.min(line + 1, state.doc.lines)).from,
          i + 1,
        );
      }
      i++;
      continue;
    }

    // A run of one or more consecutive pages, all continuing the SAME
    // block (matching start line) with nothing fresh on them.
    const startLine = continuationStartLine(pages[i]);
    const endEl = pages[i].querySelector("[data-srcline-end]");
    const endLine = endEl
      ? Number(endEl.getAttribute("data-srcline-end"))
      : NaN;
    if (startLine === null || !Number.isFinite(endLine)) {
      i++;
      continue;
    }
    let runEnd = i;
    while (
      runEnd + 1 < pages.length &&
      pages[runEnd + 1].querySelector(
        "[data-srcline]:not([data-split-from])",
      ) === null &&
      continuationStartLine(pages[runEnd + 1]) === startLine
    ) {
      runEnd++;
    }

    const runLength = runEnd - i + 1;
    const blockFrom = state.doc.line(
      Math.min(startLine + 1, state.doc.lines),
    ).from;
    const blockTo = state.doc.line(Math.min(endLine, state.doc.lines)).to;
    const span = Math.max(0, blockTo - blockFrom);
    for (let j = 0; j < runLength; j++) {
      const fraction = (j + 1) / (runLength + 1);
      addBreak(blockFrom + Math.round(span * fraction), i + j + 1);
    }
    i = runEnd + 1;
  }
  return { breaks, pages: pages.length };
}

/** Current page for a cursor position, given the known breaks. */
export function pageAt(breaks: PageBreak[], pos: number): number {
  let page = 1;
  for (const b of breaks) {
    if (b.pos <= pos) page = b.page;
    else break;
  }
  return page;
}
