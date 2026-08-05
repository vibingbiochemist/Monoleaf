import { EditorState, StateEffect, StateField } from "@codemirror/state";
import {
  Decoration,
  DecorationSet,
  EditorView,
  WidgetType,
} from "@codemirror/view";

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

/**
 * Read the real break positions out of Paged.js output. Pages after the
 * first look for their first block that carries a source line; blocks split
 * across a break (data-split-from) are skipped so the marker sits at the
 * first block fully on the new page.
 */
export function extractPageBreaks(
  container: Element,
  state: EditorState,
): { breaks: PageBreak[]; pages: number } {
  const pages = Array.from(container.querySelectorAll(".pagedjs_page"));
  const breaks: PageBreak[] = [];
  const seen = new Set<number>();
  pages.forEach((page, index) => {
    if (index === 0) return;
    const el =
      page.querySelector("[data-srcline]:not([data-split-from])") ??
      page.querySelector("[data-srcline]");
    if (el === null) return;
    const line = Number(el.getAttribute("data-srcline"));
    if (!Number.isFinite(line)) return;
    const docLine = state.doc.line(Math.min(line + 1, state.doc.lines));
    if (seen.has(docLine.from)) return;
    seen.add(docLine.from);
    breaks.push({ pos: docLine.from, page: index + 1 });
  });
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
