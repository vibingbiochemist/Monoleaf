// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { EditorState, Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { ensureSyntaxTree } from "@codemirror/language";
import { markdownForMode } from "./portability";
import { pageBreaksField, setPageBreaks } from "./pagination";
import { tableExtensions } from "./tablewidget";

// The reported document: <br> in the header, &nbsp; indentation in a sub-row.
const DOC = `| | Sample A<br>(n=12) |
|---|:---:|
| **Group one** | |
| &nbsp;&nbsp;Item one | 5 (4%) |
`;

function mount(doc: string, extraExtensions: Extension[] = []): EditorView {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const state = EditorState.create({
    doc,
    extensions: [
      markdownForMode("enhanced"),
      tableExtensions(),
      ...extraExtensions,
    ],
  });
  ensureSyntaxTree(state, doc.length, 5000);
  const view = new EditorView({ state, parent });
  // The field builds from the syntax tree; nudge it so the full parse is seen.
  view.dispatch({ changes: { from: 0, insert: "" } });
  return view;
}

function cells(view: EditorView): HTMLElement[] {
  return Array.from(view.dom.querySelectorAll<HTMLElement>("[data-row]"));
}

function cellWithRaw(view: EditorView, raw: string): HTMLElement {
  const found = cells(view).find((c) => c.dataset.raw === raw);
  if (found === undefined) {
    throw new Error(
      `no cell with raw ${JSON.stringify(raw)}; got ${JSON.stringify(
        cells(view).map((c) => c.dataset.raw),
      )}`,
    );
  }
  return found;
}

describe("table widget renders in-cell HTML and entities", () => {
  it("renders <br> as a real line break, keeping the source in data-raw", () => {
    const view = mount(DOC);
    const cell = cellWithRaw(view, "Sample A<br>(n=12)");
    expect(cell.querySelector("br")).not.toBeNull();
    expect(cell.textContent).toBe("Sample A(n=12)");
    view.destroy();
  });

  it("renders &nbsp; indentation instead of the literal entity", () => {
    const view = mount(DOC);
    const cell = cellWithRaw(view, "&nbsp;&nbsp;Item one");
    expect(cell.textContent).toBe("  Item one");
    expect(cell.textContent).not.toContain("&nbsp;");
    view.destroy();
  });

  it("leaves plain and markdown-only cells exactly as before", () => {
    const view = mount(DOC);
    const plain = cellWithRaw(view, "5 (4%)");
    expect(plain.textContent).toBe("5 (4%)");
    expect(plain.childElementCount).toBe(0);
    const bold = cellWithRaw(view, "**Group one**");
    expect(bold.textContent).toBe("**Group one**");
    expect(bold.childElementCount).toBe(0);
    view.destroy();
  });
});

describe("editing a rendered cell round-trips the source", () => {
  it("reveals raw markdown on focus and re-renders on blur, unchanged", () => {
    const view = mount(DOC);
    const before = view.state.doc.toString();
    const cell = cellWithRaw(view, "Sample A<br>(n=12)");

    cell.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    expect(cell.textContent).toBe("Sample A<br>(n=12)");
    expect(cell.querySelector("br")).toBeNull();

    cell.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    // The critical guarantee: focus + blur must not rewrite the document.
    expect(view.state.doc.toString()).toBe(before);
    expect(cell.querySelector("br")).not.toBeNull();
    view.destroy();
  });

  it("does not flatten &nbsp; into literal spaces on focus and blur", () => {
    const view = mount(DOC);
    const before = view.state.doc.toString();
    const cell = cellWithRaw(view, "&nbsp;&nbsp;Item one");

    cell.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    expect(cell.textContent).toBe("&nbsp;&nbsp;Item one");

    cell.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    expect(view.state.doc.toString()).toBe(before);
    expect(view.state.doc.toString()).toContain("&nbsp;&nbsp;Item one");
    view.destroy();
  });

  it("commits a real edit as typed markdown", () => {
    const view = mount(DOC);
    const cell = cellWithRaw(view, "&nbsp;&nbsp;Item one");
    cell.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    cell.textContent = "&nbsp;&nbsp;Item two";
    cell.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    expect(view.state.doc.toString()).toContain("&nbsp;&nbsp;Item two");
    expect(view.state.doc.toString()).not.toContain("Item one");
    view.destroy();
  });

  // Found by running the real app: a focusout with no matching focusin reads
  // the RENDERED text (where <br> has collapsed) and used to commit that over
  // the source, silently destroying it. Real browsers fire such blurs on
  // teardown, on duplicate/bubbled focus events, and on rebuilt nodes.
  it("ignores a focusout that no focusin opened", () => {
    const view = mount(DOC);
    const before = view.state.doc.toString();
    const cell = cellWithRaw(view, "Sample A<br>(n=12)");
    cell.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    expect(view.state.doc.toString()).toBe(before);
    expect(view.state.doc.toString()).toContain("Sample A<br>(n=12)");
    expect(cell.dataset.raw).toBe("Sample A<br>(n=12)");
    view.destroy();
  });

  it("ignores a second focusout after a completed edit session", () => {
    const view = mount(DOC);
    const before = view.state.doc.toString();
    const cell = cellWithRaw(view, "Sample A<br>(n=12)");
    cell.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    cell.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    // The cell is rendered again here; a stray repeat must not commit.
    cell.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    expect(view.state.doc.toString()).toBe(before);
    expect(view.state.doc.toString()).toContain("Sample A<br>(n=12)");
    view.destroy();
  });

  it("survives repeated focus cycles without eroding the source", () => {
    const view = mount(DOC);
    const before = view.state.doc.toString();
    for (let i = 0; i < 5; i++) {
      const cell = cellWithRaw(view, "Sample A<br>(n=12)");
      cell.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
      cell.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
      cell.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    }
    expect(view.state.doc.toString()).toBe(before);
    view.destroy();
  });

  it("reverts an in-progress edit on Escape", () => {
    const view = mount(DOC);
    const before = view.state.doc.toString();
    const cell = cellWithRaw(view, "&nbsp;&nbsp;Item one");
    cell.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    cell.textContent = "typed junk";
    cell.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    expect(cell.textContent).toBe("&nbsp;&nbsp;Item one");
    cell.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    expect(view.state.doc.toString()).toBe(before);
    view.destroy();
  });
});

// The regression guard that matters most: a table with no inline HTML and no
// entities must behave exactly as it did before in-cell rendering existed.
// cellHasRichContent() gates the new path, so these cells take the old
// textContent branch — nothing rendered, nothing rewritten.
describe("plain tables are unaffected", () => {
  const PLAIN = `| Name | Kd | Notes |
| :--- | ---: | --- |
| ab1 | 0.4 | strong binder |
| ab2 | 12 | has \\| pipe |
`;

  it("renders every cell as plain text with no child elements", () => {
    const view = mount(PLAIN);
    const all = cells(view);
    expect(all.length).toBe(9); // 3 header + 2 rows x 3
    for (const c of all) {
      expect(c.childElementCount).toBe(0);
      expect(c.textContent).toBe(c.dataset.raw);
    }
    view.destroy();
  });

  it("survives a focus/blur cycle on every cell without touching the file", () => {
    const view = mount(PLAIN);
    const before = view.state.doc.toString();
    for (const c of cells(view)) {
      c.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
      c.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    }
    expect(view.state.doc.toString()).toBe(before);
    view.destroy();
  });

  it("keeps the escaped pipe intact through a focus/blur cycle", () => {
    const view = mount(PLAIN);
    // splitRow() unescapes \| into | for the model (table.ts), and
    // escapeCell() re-escapes on write — so the cell shows the bare pipe and
    // the file keeps the backslash. Both must survive a focus/blur cycle.
    const cell = cellWithRaw(view, "has | pipe");
    cell.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    expect(cell.textContent).toBe("has | pipe");
    cell.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    expect(view.state.doc.toString()).toContain("has \\| pipe");
    view.destroy();
  });

  it("still commits an ordinary edit", () => {
    const view = mount(PLAIN);
    const cell = cellWithRaw(view, "0.4");
    cell.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    cell.textContent = "0.9";
    cell.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    expect(view.state.doc.toString()).toContain("| 0.9 |");
    view.destroy();
  });
});

// A table replaces its whole source range with one opaque widget (see
// buildDecorations), so a page-break landing inside it can't render via the
// normal standalone .cm-page-gap mechanism — extractPageBreaks computes a
// perfectly good position, but CodeMirror has nowhere to paint it. The
// table widget must render its own internal divider instead.
describe("page breaks landing inside a table", () => {
  const ROWS = `| h1 | h2 |
| --- | --- |
| r0c1 | r0c2 |
| r1c1 | r1c2 |
| r2c1 | r2c2 |
`;

  it("renders an internal divider row at the break's row", () => {
    const view = mount(ROWS, [pageBreaksField]);
    // Line 4 (1-based) is "| r1c1 | r1c2 |" — the second data row.
    const pos = view.state.doc.line(4).from;
    view.dispatch({ effects: setPageBreaks.of([{ pos, page: 2 }]) });

    const dividers = view.dom.querySelectorAll("tr.ml-table-pagebreak");
    expect(dividers.length).toBe(1);
    expect(dividers[0].querySelector(".cm-page-num")?.textContent).toBe("1");
    // It sits directly before the row it announces.
    const nextRow = dividers[0].nextElementSibling;
    expect(nextRow?.textContent).toContain("r1c1");
    view.destroy();
  });

  it("adds no internal divider for a break at or before the table's start", () => {
    const view = mount(ROWS, [pageBreaksField]);
    view.dispatch({
      effects: setPageBreaks.of([{ pos: 0, page: 2 }]),
    });
    expect(view.dom.querySelectorAll("tr.ml-table-pagebreak").length).toBe(0);
    view.destroy();
  });

  it("moves the divider when the breaks are recomputed (exercises eq())", () => {
    const view = mount(ROWS, [pageBreaksField]);
    const firstDataRow = view.state.doc.line(3).from; // "| r0c1 | r0c2 |"
    view.dispatch({
      effects: setPageBreaks.of([{ pos: firstDataRow, page: 2 }]),
    });
    let dividers = view.dom.querySelectorAll("tr.ml-table-pagebreak");
    expect(dividers[0].nextElementSibling?.textContent).toContain("r0c1");

    const thirdDataRow = view.state.doc.line(5).from; // "| r2c1 | r2c2 |"
    view.dispatch({
      effects: setPageBreaks.of([{ pos: thirdDataRow, page: 2 }]),
    });
    dividers = view.dom.querySelectorAll("tr.ml-table-pagebreak");
    expect(dividers.length).toBe(1);
    expect(dividers[0].nextElementSibling?.textContent).toContain("r2c1");
    view.destroy();
  });

  it("existing tables with no pagination field render exactly as before", () => {
    const view = mount(ROWS);
    expect(view.dom.querySelectorAll("tr.ml-table-pagebreak").length).toBe(0);
    view.destroy();
  });
});

// A single cell taller than a page (many forced <br> line breaks) — the
// real case that surfaced this: a row-level divider has no row boundary to
// anchor to mid-cell, so the divider has to render INSIDE the cell itself.
describe("page breaks landing inside a single tall cell", () => {
  const TALL = `| short | tall |
| --- | --- |
| a | Line 1<br>Line 2<br>Line 3 |
`;

  function tallCellDataRowLine(view: EditorView) {
    return view.state.doc.line(3); // "| a | Line 1<br>Line 2<br>Line 3 |"
  }

  it("renders exactly one inline divider at the right split point", () => {
    const view = mount(TALL, [pageBreaksField]);
    const line = tallCellDataRowLine(view);
    // Right after "Line 1<br>Line 2" — i.e. between the second and third
    // forced line, inside the tall cell's own raw text.
    const pos = line.from + line.text.indexOf("Line 2<br>") + "Line 2".length;
    view.dispatch({ effects: setPageBreaks.of([{ pos, page: 3 }]) });

    const dividers = view.dom.querySelectorAll(".ml-table-pagebreak-inline");
    expect(dividers.length).toBe(1);
    expect(dividers[0].querySelector(".cm-page-num")?.textContent).toBe("2");
    // No row-level divider was ALSO added for this break.
    expect(view.dom.querySelectorAll("tr.ml-table-pagebreak").length).toBe(0);

    const cell = dividers[0].closest("[data-row]") as HTMLElement;
    expect(cell.dataset.row).toBe("0");
    expect(cell.dataset.col).toBe("1");
    // Splits the cell's own rendered content around the divider.
    expect(cell.textContent).toContain("Line 1");
    expect(cell.textContent).toContain("Line 2");
    expect(cell.textContent).toContain("Line 3");
    view.destroy();
  });

  it("survives a focus+blur cycle on the split cell with no edit", () => {
    const view = mount(TALL, [pageBreaksField]);
    const line = tallCellDataRowLine(view);
    const pos = line.from + line.text.indexOf("Line 2<br>") + "Line 2".length;
    view.dispatch({ effects: setPageBreaks.of([{ pos, page: 3 }]) });

    const cell = view.dom.querySelector<HTMLElement>(
      '[data-row="0"][data-col="1"]',
    )!;
    cell.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    cell.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));

    expect(cell.querySelectorAll(".ml-table-pagebreak-inline").length).toBe(1);
    // The document itself was never touched.
    expect(view.state.doc.toString()).toContain("Line 1<br>Line 2<br>Line 3");
    view.destroy();
  });

  it("shows the raw source (no divider) while the split cell is being edited", () => {
    const view = mount(TALL, [pageBreaksField]);
    const line = tallCellDataRowLine(view);
    const pos = line.from + line.text.indexOf("Line 2<br>") + "Line 2".length;
    view.dispatch({ effects: setPageBreaks.of([{ pos, page: 3 }]) });

    const cell = view.dom.querySelector<HTMLElement>(
      '[data-row="0"][data-col="1"]',
    )!;
    cell.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    expect(cell.querySelector(".ml-table-pagebreak-inline")).toBeNull();
    // Exact equality (not just "contains") proves the divider's own label
    // is never part of what an edit session reads as the cell's value.
    expect(cell.textContent).toBe("Line 1<br>Line 2<br>Line 3");
    view.destroy();
  });

  it("still commits an edit to the split cell correctly", () => {
    const view = mount(TALL, [pageBreaksField]);
    const line = tallCellDataRowLine(view);
    const pos = line.from + line.text.indexOf("Line 2<br>") + "Line 2".length;
    view.dispatch({ effects: setPageBreaks.of([{ pos, page: 3 }]) });

    const cell = view.dom.querySelector<HTMLElement>(
      '[data-row="0"][data-col="1"]',
    )!;
    cell.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    cell.textContent = "Line 1<br>Line 2<br>Line 3<br>Line 4";
    cell.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));

    // Exact equality on the committed line (not just "contains") proves no
    // divider label text leaked into the saved markdown.
    expect(view.state.doc.line(3).text).toBe(
      "| a | Line 1<br>Line 2<br>Line 3<br>Line 4 |",
    );
    view.destroy();
  });

  it("falls back to a row-level divider when the column can't be pinned down (escaped pipe)", () => {
    const ESCAPED = `| short | tall |
| --- | --- |
| a | x\\|y<br>Line 2<br>Line 3 |
`;
    const view = mount(ESCAPED, [pageBreaksField]);
    const line = view.state.doc.line(3);
    const pos = line.from + line.text.indexOf("Line 2<br>") + "Line 2".length;
    view.dispatch({ effects: setPageBreaks.of([{ pos, page: 3 }]) });

    expect(view.dom.querySelectorAll(".ml-table-pagebreak-inline").length).toBe(
      0,
    );
    expect(view.dom.querySelectorAll("tr.ml-table-pagebreak").length).toBe(1);
    view.destroy();
  });
});
