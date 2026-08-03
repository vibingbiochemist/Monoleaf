// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { ensureSyntaxTree } from "@codemirror/language";
import { markdownForMode } from "./portability";
import { tableExtensions } from "./tablewidget";

// The reported document: <br> in the header, &nbsp; indentation in a sub-row.
const DOC = `| | Sample A<br>(n=12) |
|---|:---:|
| **Group one** | |
| &nbsp;&nbsp;Item one | 5 (4%) |
`;

function mount(doc: string): EditorView {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const state = EditorState.create({
    doc,
    extensions: [markdownForMode("enhanced"), tableExtensions()],
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
