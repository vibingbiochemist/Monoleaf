// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import {
  BreakToken,
  buildPageBreakDecorations,
  extractPageBreaks,
  pageAt,
  pageBreakPositions,
  pageBreaksField,
  resolveExactBreakPos,
  setPageBreaks,
} from "./pagination";
import { renderDocumentHtml } from "./export";

describe("page break decorations", () => {
  it("builds one block widget per break", () => {
    const set = buildPageBreakDecorations([
      { pos: 10, page: 2 },
      { pos: 40, page: 3 },
    ]);
    const out: number[] = [];
    const it2 = set.iter();
    while (it2.value !== null) {
      out.push(it2.from);
      it2.next();
    }
    expect(out).toEqual([10, 40]);
  });

  it("breaks move with document edits (effect mapping through changes)", () => {
    const state = EditorState.create({
      doc: "aaaa\nbbbb\ncccc\n",
      extensions: pageBreaksField,
    });
    const withBreaks = state.update({
      effects: setPageBreaks.of([{ pos: 10, page: 2 }]),
    }).state;
    // Insert 5 chars before the break: the marker must shift by 5.
    const edited = withBreaks.update({
      changes: { from: 0, insert: "01234" },
    }).state;
    const set = edited.field(pageBreaksField);
    const it2 = set.iter();
    expect(it2.value).not.toBeNull();
    expect(it2.from).toBe(15);
  });
});

describe("pageBreakPositions", () => {
  it("is empty when the field isn't present (pagination off)", () => {
    const state = EditorState.create({ doc: "hello\n" });
    expect(pageBreakPositions(state)).toEqual([]);
  });

  it("returns the dispatched breaks as plain {pos, page} data", () => {
    const state = EditorState.create({
      doc: "aaaa\nbbbb\ncccc\n",
      extensions: pageBreaksField,
    });
    const withBreaks = state.update({
      effects: setPageBreaks.of([
        { pos: 5, page: 2 },
        { pos: 10, page: 3 },
      ]),
    }).state;
    expect(pageBreakPositions(withBreaks)).toEqual([
      { pos: 5, page: 2 },
      { pos: 10, page: 3 },
    ]);
  });
});

describe("pageAt", () => {
  const breaks = [
    { pos: 100, page: 2 },
    { pos: 250, page: 3 },
  ];
  it("maps cursor positions to their page", () => {
    expect(pageAt(breaks, 0)).toBe(1);
    expect(pageAt(breaks, 99)).toBe(1);
    expect(pageAt(breaks, 100)).toBe(2);
    expect(pageAt(breaks, 249)).toBe(2);
    expect(pageAt(breaks, 900)).toBe(3);
  });
  it("is page 1 with no breaks", () => {
    expect(pageAt([], 500)).toBe(1);
  });
});

describe("source-line attributes for break mapping", () => {
  it("blocks carry data-srcline with their 0-based source line", () => {
    const html = renderDocumentHtml(
      "first\n\n## head\n\nlast\n",
      "strict",
      true,
    );
    expect(html).toContain('data-srcline="0"');
    expect(html).toContain('<h2 data-srcline="2"');
    expect(html).toContain('data-srcline="4"');
  });

  it("also carries data-srcline-end (exclusive), for extractPageBreaks's straddling-block fallback", () => {
    // "first\nsecond" is one paragraph spanning source lines 0-1; its map
    // end is 2 (the blank line). "third" starts at line 3, ends at 4 (EOF).
    const html = renderDocumentHtml("first\nsecond\n\nthird\n", "strict", true);
    expect(html).toContain('<p data-srcline="0" data-srcline-end="2">');
    expect(html).toContain('<p data-srcline="3" data-srcline-end="4">');
  });

  it("is off by default (export output unchanged)", () => {
    expect(renderDocumentHtml("hello\n", "strict")).not.toContain(
      "data-srcline",
    );
  });
});

describe("extractPageBreaks", () => {
  // "first\nsecond\n\nthird\n": paragraph A spans lines 0-1 (map end 2, the
  // blank line); paragraph B is "third" at line 3 (map end 4).
  const docText = "first\nsecond\n\nthird\n";

  it("anchors a lone straddling continuation to the block's MIDPOINT, not its stale START", () => {
    const state = EditorState.create({ doc: docText });
    const container = document.createElement("div");
    container.innerHTML = `
      <div class="pagedjs_page">
        <p data-srcline="0" data-srcline-end="2">first second</p>
      </div>
      <div class="pagedjs_page">
        <p data-srcline="0" data-srcline-end="2" data-split-from="x">continuation</p>
      </div>
      <div class="pagedjs_page">
        <p data-srcline="3" data-srcline-end="4">third</p>
      </div>
    `;
    const { breaks, pages } = extractPageBreaks(container, state);
    expect(pages).toBe(3);
    expect(breaks).toHaveLength(2);

    // Page 2's break must NOT be paragraph A's start — that position is on
    // page 1, which is exactly the bug (the divider would sit above content
    // that's still on the previous page).
    const startOfA = state.doc.line(1).from;
    expect(breaks[0].pos).not.toBe(startOfA);
    // A run of exactly one continuation page divides the block into two
    // halves (1/(1+1)) — its midpoint, the least-wrong guess with nothing
    // else to go on.
    const blockFrom = state.doc.line(1).from;
    const blockTo = state.doc.line(2).to;
    expect(breaks[0].pos).toBe(
      blockFrom + Math.round((blockTo - blockFrom) / 2),
    );
    expect(breaks[0].page).toBe(2);

    // Page 3 is fresh (no data-split-from) — anchors normally, at the
    // block's start, same as before this fix.
    expect(breaks[1].pos).toBe(state.doc.line(4).from);
    expect(breaks[1].page).toBe(3);
  });

  it("spreads a run of several continuation pages across the block's span, not onto one collapsed position", () => {
    // A paragraph still being continued on page 4 too — page 2, 3 and 4 are
    // all continuations of the SAME block. Each gets a distinct fraction of
    // the way through it (1/4, 2/4, 3/4) instead of collapsing onto one
    // position (the bug the end-only anchor had for anything longer than a
    // two-page straddle — exactly the shape a long, single-paragraph, never
    // hard-wrapped block of prose takes in this editor).
    const state = EditorState.create({ doc: docText });
    const container = document.createElement("div");
    container.innerHTML = `
      <div class="pagedjs_page">
        <p data-srcline="0" data-srcline-end="2">first</p>
      </div>
      <div class="pagedjs_page">
        <p data-srcline="0" data-srcline-end="2" data-split-from="x">cont 1</p>
      </div>
      <div class="pagedjs_page">
        <p data-srcline="0" data-srcline-end="2" data-split-from="x">cont 2</p>
      </div>
      <div class="pagedjs_page">
        <p data-srcline="0" data-srcline-end="2" data-split-from="x">cont 3</p>
      </div>
    `;
    const { breaks, pages } = extractPageBreaks(container, state);
    expect(pages).toBe(4);
    const blockFrom = state.doc.line(1).from;
    const span = state.doc.line(2).to - blockFrom;
    expect(breaks).toEqual([
      { pos: blockFrom + Math.round(span * (1 / 4)), page: 2 },
      { pos: blockFrom + Math.round(span * (2 / 4)), page: 3 },
      { pos: blockFrom + Math.round(span * (3 / 4)), page: 4 },
    ]);
    // Strictly increasing — Decoration.set (buildPageBreakDecorations)
    // requires its input already sorted.
    expect(breaks[0].pos).toBeLessThan(breaks[1].pos);
    expect(breaks[1].pos).toBeLessThan(breaks[2].pos);
  });

  it("degrades to dropping (not crashing or misordering) a break when rounding collides", () => {
    // A one-character block ("x") is too short to give 3 continuation pages
    // distinct integer positions — two of the three fractions round to the
    // same offset. Must still not throw, double-count, or go out of order.
    const state = EditorState.create({ doc: "x\n\nthird\n" });
    const container = document.createElement("div");
    container.innerHTML = `
      <div class="pagedjs_page">
        <p data-srcline="0" data-srcline-end="1">x</p>
      </div>
      <div class="pagedjs_page">
        <p data-srcline="0" data-srcline-end="1" data-split-from="x">cont 1</p>
      </div>
      <div class="pagedjs_page">
        <p data-srcline="0" data-srcline-end="1" data-split-from="x">cont 2</p>
      </div>
      <div class="pagedjs_page">
        <p data-srcline="0" data-srcline-end="1" data-split-from="x">cont 3</p>
      </div>
    `;
    const { breaks, pages } = extractPageBreaks(container, state);
    expect(pages).toBe(4);
    // One of the three candidate positions collides and is dropped, but the
    // survivors stay strictly increasing.
    expect(breaks.length).toBeLessThan(3);
    for (let i = 1; i < breaks.length; i++) {
      expect(breaks[i].pos).toBeGreaterThan(breaks[i - 1].pos);
    }
  });

  it("returns no breaks for a single page", () => {
    const state = EditorState.create({ doc: docText });
    const container = document.createElement("div");
    container.innerHTML = `<div class="pagedjs_page"><p data-srcline="0">first</p></div>`;
    expect(extractPageBreaks(container, state)).toEqual({
      breaks: [],
      pages: 1,
    });
  });

  it("prefers an exact break token over the proportional guess", () => {
    // Same straddling shape as the midpoint test above, but this time a
    // real break token is supplied for page 0 (the page it ends), pointing
    // exactly 6 characters into "first second" — right after "first ".
    const state = EditorState.create({ doc: "first second\n\nthird\n" });
    const container = document.createElement("div");
    container.innerHTML = `
      <div class="pagedjs_page">
        <p data-srcline="0" data-srcline-end="1">first </p>
      </div>
      <div class="pagedjs_page">
        <p data-srcline="0" data-srcline-end="1" data-split-from="x">second</p>
      </div>
    `;
    // The break token's node lives in Paged.js's untouched SOURCE tree — a
    // full, unsplit copy of the paragraph — never the rendered/truncated
    // page content above.
    const sourceP = document.createElement("p");
    sourceP.setAttribute("data-srcline", "0");
    sourceP.setAttribute("data-srcline-end", "1");
    sourceP.textContent = "first second";
    const textNode = sourceP.firstChild!;
    const exactBreaks = new Map<number, BreakToken | undefined>([
      [0, { node: textNode, offset: 6 }],
    ]);
    const { breaks } = extractPageBreaks(container, state, exactBreaks);
    expect(breaks).toEqual([{ pos: 6, page: 2 }]);
  });

  it("falls back to the proportional guess when the exact token is unresolvable", () => {
    // exactBreaks is supplied but maps to undefined for this page (Paged.js
    // gives no token past the last page) — must not throw, must fall
    // through to the existing continuation logic unchanged.
    const state = EditorState.create({ doc: docText });
    const container = document.createElement("div");
    container.innerHTML = `
      <div class="pagedjs_page">
        <p data-srcline="0" data-srcline-end="2">first second</p>
      </div>
      <div class="pagedjs_page">
        <p data-srcline="0" data-srcline-end="2" data-split-from="x">continuation</p>
      </div>
    `;
    const exactBreaks = new Map<number, BreakToken | undefined>([
      [0, undefined],
    ]);
    const { breaks } = extractPageBreaks(container, state, exactBreaks);
    const blockFrom = state.doc.line(1).from;
    const blockTo = state.doc.line(2).to;
    expect(breaks).toEqual([
      { pos: blockFrom + Math.round((blockTo - blockFrom) / 2), page: 2 },
    ]);
  });
});

describe("resolveExactBreakPos", () => {
  it("resolves a plain-text block to the exact rendered offset", () => {
    const state = EditorState.create({ doc: "first second\n\nthird\n" });
    const p = document.createElement("p");
    p.setAttribute("data-srcline", "0");
    p.setAttribute("data-srcline-end", "1");
    p.textContent = "first second";
    const textNode = p.firstChild!;
    // Right after "first " (6 characters in).
    expect(resolveExactBreakPos({ node: textNode, offset: 6 }, state)).toBe(6);
  });

  it("maps a soft-wrapped (two physical source lines) block back to its original, non-normalized offset", () => {
    const state = EditorState.create({ doc: "first\nsecond\n\nthird\n" });
    const p = document.createElement("p");
    p.setAttribute("data-srcline", "0");
    p.setAttribute("data-srcline-end", "2");
    // Rendered text: the soft break becomes a single space, same as the
    // real browser/Paged.js output for this paragraph.
    p.textContent = "first second";
    const textNode = p.firstChild!;
    // Rendered offset 7 = "first s" (up through the "s" of "second").
    // Source position 7 is the same offset since the newline collapses to
    // exactly one character, same as the space it replaces.
    expect(resolveExactBreakPos({ node: textNode, offset: 7 }, state)).toBe(7);
  });

  it("returns null for a block reshaped by inline formatting", () => {
    const state = EditorState.create({ doc: "**first** second\n\nthird\n" });
    const p = document.createElement("p");
    p.setAttribute("data-srcline", "0");
    p.setAttribute("data-srcline-end", "1");
    const strong = document.createElement("strong");
    strong.textContent = "first";
    p.append(strong, " second");
    const textNode = p.lastChild!; // " second"
    expect(resolveExactBreakPos({ node: textNode, offset: 3 }, state)).toBe(
      null,
    );
  });

  it("handles an element-type break token (offset ignored, anchors to the block's start)", () => {
    const state = EditorState.create({ doc: "first second\n\nthird\n" });
    const p = document.createElement("p");
    p.setAttribute("data-srcline", "0");
    p.setAttribute("data-srcline-end", "1");
    p.textContent = "first second";
    expect(resolveExactBreakPos({ node: p, offset: 999 }, state)).toBe(0);
  });

  it("returns null when the token's node has no [data-srcline] ancestor", () => {
    const state = EditorState.create({ doc: "first second\n" });
    const detached = document.createTextNode("orphan");
    expect(resolveExactBreakPos({ node: detached, offset: 2 }, state)).toBe(
      null,
    );
  });
});

describe("resolveExactBreakPos: table rows", () => {
  // "Line 1<br>Line 2<br>Line 3" split across 3 text nodes by 2 real <br>
  // elements — the shape a browser gives a rendered table cell with forced
  // line breaks, matching the real repro that surfaced this (a cell with
  // many <br>-separated lines, taller than a single printed page).
  const ROW = "| short | Line 1<br>Line 2<br>Line 3 |\n";

  function buildRow() {
    const state = EditorState.create({ doc: ROW });
    const tr = document.createElement("tr");
    tr.setAttribute("data-srcline", "0");
    tr.setAttribute("data-srcline-end", "1");
    const td0 = document.createElement("td");
    td0.textContent = "short";
    const td1 = document.createElement("td");
    td1.append(
      document.createTextNode("Line 1"),
      document.createElement("br"),
      document.createTextNode("Line 2"),
      document.createElement("br"),
      document.createTextNode("Line 3"),
    );
    tr.append(td0, td1);
    return { state, tr, td1 };
  }

  it("resolves a break inside a <br>-separated cell to the exact source character", () => {
    const { state, td1 } = buildRow();
    // The middle text node, 3 chars in: "Lin|e 2" — right after "Lin".
    const middleTextNode = td1.childNodes[2];
    const pos = resolveExactBreakPos(
      { node: middleTextNode, offset: 3 },
      state,
    );
    expect(pos).not.toBeNull();
    // Must land exactly between the "n" and the "e" of the SECOND "Line 2",
    // not the first "Line 1" or third "Line 3".
    expect(state.doc.sliceString(pos! - 3, pos!)).toBe("Lin");
    expect(state.doc.sliceString(pos!, pos! + 3)).toBe("e 2");
  });

  it("returns null for a break on inter-cell whitespace (no cell ancestor)", () => {
    const { state, tr } = buildRow();
    // A text node that's a direct child of <tr>, not inside any <td> — the
    // inter-cell whitespace markdown-it's HTML string produces once parsed.
    const whitespaceNode = document.createTextNode("\n");
    tr.insertBefore(whitespaceNode, tr.firstChild);
    expect(
      resolveExactBreakPos({ node: whitespaceNode, offset: 0 }, state),
    ).toBe(null);
  });

  it("returns null exactly at a cell boundary (start or end)", () => {
    const { state, td1 } = buildRow();
    const firstTextNode = td1.childNodes[0];
    // Offset 0 of the cell's first text node = the cell's very start.
    expect(
      resolveExactBreakPos({ node: firstTextNode, offset: 0 }, state),
    ).toBe(null);
    const lastTextNode = td1.childNodes[4];
    // End of the cell's last text node = the cell's very end.
    expect(
      resolveExactBreakPos(
        { node: lastTextNode, offset: (lastTextNode.textContent ?? "").length },
        state,
      ),
    ).toBe(null);
  });

  it("returns null for a break inside a cell containing an escaped pipe (that same cell, not just any cell in the row)", () => {
    const state = EditorState.create({ doc: "| short | a\\|b<br>Line 2 |\n" });
    const tr = document.createElement("tr");
    tr.setAttribute("data-srcline", "0");
    tr.setAttribute("data-srcline-end", "1");
    const td0 = document.createElement("td");
    td0.textContent = "short";
    const td1 = document.createElement("td");
    const textNode = document.createTextNode("Line 2");
    td1.append(
      document.createTextNode("a|b"),
      document.createElement("br"),
      textNode,
    );
    tr.append(td0, td1);
    expect(resolveExactBreakPos({ node: textNode, offset: 2 }, state)).toBe(
      null,
    );
  });

  it("still resolves exactly when a DIFFERENT cell in the same row has an escaped pipe or rich formatting", () => {
    const state = EditorState.create({
      doc: "| a\\|b | Line 1<br>Line 2 |\n",
    });
    const tr = document.createElement("tr");
    tr.setAttribute("data-srcline", "0");
    tr.setAttribute("data-srcline-end", "1");
    const td0 = document.createElement("td");
    td0.textContent = "a|b";
    const td1 = document.createElement("td");
    const textNode = document.createTextNode("Line 2");
    td1.append(
      document.createTextNode("Line 1"),
      document.createElement("br"),
      textNode,
    );
    tr.append(td0, td1);
    expect(
      resolveExactBreakPos({ node: textNode, offset: 2 }, state),
    ).not.toBeNull();
  });

  it("returns null for a break inside a cell reshaped by real markdown formatting", () => {
    const state = EditorState.create({ doc: "| plain | **bo**ld |\n" });
    const tr = document.createElement("tr");
    tr.setAttribute("data-srcline", "0");
    tr.setAttribute("data-srcline-end", "1");
    const td0 = document.createElement("td");
    td0.textContent = "plain";
    const td1 = document.createElement("td");
    const strong = document.createElement("strong");
    strong.textContent = "bo";
    const textNode = document.createTextNode("ld");
    td1.append(strong, textNode);
    tr.append(td0, td1);
    expect(resolveExactBreakPos({ node: textNode, offset: 1 }, state)).toBe(
      null,
    );
  });
});

describe("explicit page break directive", () => {
  it("becomes a forced-break div, and following content stays a block", () => {
    const html = renderDocumentHtml(
      "a\n\n<!--ml:pagebreak-->\n\nb\n",
      "strict",
    );
    expect(html).toContain('<div class="ml-pagebreak">');
    expect(html).not.toContain("ml:pagebreak-->");
    // Content after the break must be its own paragraph, not folded into the
    // directive's raw HTML block (the bug that killed the PDF break).
    expect(html).toContain("<p>b</p>");
  });
});
