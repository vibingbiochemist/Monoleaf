import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import {
  buildPageBreakDecorations,
  pageAt,
  pageBreaksField,
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
    expect(html).toContain('<p data-srcline="0">');
    expect(html).toContain('<h2 data-srcline="2">');
    expect(html).toContain('<p data-srcline="4">');
  });

  it("is off by default (export output unchanged)", () => {
    expect(renderDocumentHtml("hello\n", "strict")).not.toContain(
      "data-srcline",
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
