import { describe, expect, it } from "vitest";
import { ensureSyntaxTree } from "@codemirror/language";
import { EditorSelection, EditorState } from "@codemirror/state";
import { markupRepair } from "./repair";
import { hideCommentSyntax } from "./comments";
import {
  hardBreakEnter,
  paragraphEnter,
  toggleBold,
  toggleItalic,
} from "./commands";
import { markdownForMode } from "./portability";

const BS = "\\"; // one backslash
const NL = "\n";

function mk(doc: string, anchor: number, head = anchor): EditorState {
  const state = EditorState.create({
    doc,
    selection: EditorSelection.single(anchor, head),
    extensions: [
      markdownForMode("enhanced"),
      hideCommentSyntax.of(true),
      markupRepair,
    ],
  });
  if (ensureSyntaxTree(state, doc.length, 5000) === null) {
    throw new Error("parse did not finish");
  }
  return state;
}

/** Apply a raw user edit (what CodeMirror's Backspace/Delete/typing would
 * dispatch) and return the repaired result. */
function edit(
  doc: string,
  from: number,
  to: number,
  insert: string,
  userEvent: string,
  cursor = from,
) {
  const state = mk(doc, cursor);
  const after = state.update({
    changes: { from, to, insert },
    selection: EditorSelection.cursor(from + insert.length),
    userEvent,
  }).state;
  return { doc: after.doc.toString(), cursor: after.selection.main.head };
}

const backspace = (doc: string, from: number, to: number) =>
  edit(doc, from, to, "", "delete.backward", to);
const del = (doc: string, from: number, to: number) =>
  edit(doc, from, to, "", "delete.forward", from);

/** A pure cursor move from `fromPos` to `toPos`, as the arrow/End/Home keys
 * or a click would produce; returns where the cursor actually lands. */
function move(
  doc: string,
  fromPos: number,
  toPos: number,
  userEvent = "select",
): number {
  const state = mk(doc, fromPos);
  return state.update({
    selection: EditorSelection.cursor(toPos),
    userEvent,
  }).state.selection.main.head;
}

function run(
  cmd: typeof paragraphEnter,
  doc: string,
  anchor: number,
  head = anchor,
) {
  const state = mk(doc, anchor, head);
  let after: EditorState | null = null;
  const ok = cmd({
    state,
    dispatch: (tr) => {
      after = tr.state;
    },
  });
  const s = after as EditorState | null;
  return {
    ok,
    doc: s === null ? doc : s.doc.toString(),
    cursor: s === null ? anchor : s.selection.main.head,
  };
}

const HB = "text" + BS + NL; // a hard-break line: "text\" + newline

describe("hard break (\\ + newline) behaves as one unit", () => {
  it("End / click at the line end lands before the hidden backslash", () => {
    expect(move(HB + "more", 0, 5)).toBe(4);
  });

  it("ArrowRight from before the backslash steps onto the next line", () => {
    expect(move(HB + "more", 4, 5)).toBe(6);
  });

  it("ArrowLeft from the next line lands before the backslash", () => {
    expect(move(HB + "more", 6, 5)).toBe(4);
  });

  it("End pressed again, or a click at the line end, stays before it", () => {
    // Same transaction as ArrowRight above, told apart by the user event.
    expect(move(HB + "more", 4, 5, "select.boundary")).toBe(4);
    expect(move(HB + "more", 4, 5, "select.pointer")).toBe(4);
  });

  it("does not touch the cursor after an escaped backslash", () => {
    // "a\\" + newline: the second backslash is an escape, not a break.
    const doc = "a" + BS + BS + NL + "b";
    expect(move(doc, 0, 3)).toBe(3);
  });

  it("Delete at the line end removes backslash and newline", () => {
    // Delete in front of the atomic "\" — CodeMirror targets the marker.
    expect(del(HB + "more", 4, 5)).toEqual({ doc: "textmore", cursor: 4 });
  });

  it("a deletion starting at the newline takes the backslash too", () => {
    // Ctrl+Backspace at the start of the continuation line.
    expect(backspace(HB + "more", 5, 6)).toEqual({
      doc: "textmore",
      cursor: 4,
    });
  });

  it("a selection from the line end into the next line takes the backslash", () => {
    expect(backspace(HB + "more", 5, 8)).toEqual({ doc: "textre", cursor: 4 });
  });

  it("typing over such a selection also drops the backslash", () => {
    expect(edit(HB + "more", 5, 8, "X", "input.type")).toEqual({
      doc: "textXre",
      cursor: 5,
    });
  });

  it("Enter on the empty continuation line removes the dangling backslash", () => {
    // Shift+Enter, then Enter: no "\" left to print at the paragraph end.
    expect(run(paragraphEnter, HB, 6)).toEqual({
      ok: true,
      doc: "text" + NL + NL,
      cursor: 6,
    });
  });

  it("Ctrl+B over a Shift+End selection wraps before the backslash", () => {
    expect(run(toggleBold, HB + "more", 0, 5).doc).toBe(
      "**text**" + BS + NL + "more",
    );
  });
});

describe("Backspace / Delete against inline markers", () => {
  it("Backspace after bold deletes the last bold letter, not the marker", () => {
    expect(backspace("**bold** tail", 6, 8)).toEqual({
      doc: "**bol** tail",
      cursor: 5,
    });
  });

  it("Backspace on a single-letter bold removes the whole construct", () => {
    expect(backspace("**b** x", 3, 5)).toEqual({ doc: " x", cursor: 0 });
  });

  it("deleting the last character inside bold removes the empty pair", () => {
    expect(backspace("**b**", 2, 3)).toEqual({ doc: "", cursor: 0 });
    expect(backspace("a *i* b", 3, 4)).toEqual({ doc: "a  b", cursor: 2 });
  });

  it("Delete before bold deletes the first bold letter", () => {
    expect(del("**bold**", 0, 2)).toEqual({ doc: "**old**", cursor: 2 });
  });

  it("Backspace at the bold content start deletes the char before the run", () => {
    expect(backspace("a **bold**", 2, 4)).toEqual({
      doc: "a**bold**",
      cursor: 1,
    });
  });

  it("Backspace at the bold content start of a line unwraps", () => {
    expect(backspace("**bold**", 0, 2)).toEqual({ doc: "bold", cursor: 0 });
  });

  it("Delete at the bold content end deletes the char after the run", () => {
    expect(del("**bold** x", 6, 8)).toEqual({ doc: "**bold**x", cursor: 6 });
  });

  it("nested runs: the outer marker never loses a character", () => {
    // "***x***" is bold inside italic; CodeMirror targets the inner "**".
    expect(backspace("***x***", 1, 3)).toEqual({ doc: "*x*", cursor: 1 });
    expect(backspace("a ***x***", 3, 5)).toEqual({
      doc: "a***x***",
      cursor: 1,
    });
    expect(del("***x***", 4, 6)).toEqual({ doc: "*x*", cursor: 1 });
    expect(del("***x*** b", 4, 6)).toEqual({ doc: "***x***b", cursor: 4 });
  });

  it("works for strikethrough, inline code and underline tags too", () => {
    expect(backspace("~~gone~~", 6, 8).doc).toBe("~~gon~~");
    expect(backspace("`code`", 5, 6).doc).toBe("`cod`");
    expect(backspace("<u>under</u>", 8, 12).doc).toBe("<u>unde</u>");
    expect(backspace("<u>u</u>", 3, 4).doc).toBe("");
  });

  it("Backspace at the start of a heading un-heads it instead of joining", () => {
    expect(backspace("para" + NL + "# Head", 4, 5)).toEqual({
      doc: "para" + NL + "Head",
      cursor: 5,
    });
  });

  it("leaves an ordinary line join alone", () => {
    expect(backspace("para" + NL + "more", 4, 5)).toEqual({
      doc: "paramore",
      cursor: 4,
    });
  });

  it("leaves undo / programmatic edits alone", () => {
    expect(edit("**bold**", 6, 8, "", "undo").doc).toBe("**bold");
  });
});

describe("typing whitespace at a marker edge", () => {
  it("a space typed just inside the closing ** lands after it", () => {
    expect(edit("**bold**", 6, 6, " ", "input.type")).toEqual({
      doc: "**bold** ",
      cursor: 9,
    });
  });

  it("a space typed just inside the opening ** lands before it", () => {
    expect(edit("a **bold**", 4, 4, " ", "input.type")).toEqual({
      doc: "a  **bold**",
      cursor: 3,
    });
  });

  it("hops over nested closers", () => {
    // "**a *b|***": italic and bold both close here.
    expect(edit("**a *b***", 6, 6, " ", "input.type").doc).toBe("**a *b*** ");
  });

  it("a letter typed there stays inside (it extends the run)", () => {
    expect(edit("**bold**", 6, 6, "x", "input.type").doc).toBe("**boldx**");
  });
});

describe("cursor at hidden leading block markers", () => {
  it("Home / click at a bullet line start lands after the hidden bullet", () => {
    expect(move("- item", 3, 0)).toBe(2);
  });

  it("ArrowLeft from after the bullet moves to the previous line", () => {
    expect(move("up" + NL + "- item", 5, 3)).toBe(2);
  });

  it("Home pressed again after the bullet stays on the line", () => {
    expect(move("up" + NL + "- item", 5, 3, "select.boundary")).toBe(5);
    expect(move("up" + NL + "- item", 5, 3, "select.pointer")).toBe(5);
  });

  it("task items: after the checkbox", () => {
    expect(move("- [x] done", 8, 0)).toBe(6);
  });

  it("quote marks and nested bullets", () => {
    expect(move("> - q", 5, 0)).toBe(4);
  });

  it("ordered list numbers stay visible, so no snapping", () => {
    expect(move("1. one", 4, 0)).toBe(0);
  });
});

describe("Enter inside inline constructs", () => {
  it("splits bold into two bold paragraphs", () => {
    expect(run(paragraphEnter, "**bold**", 4)).toEqual({
      ok: true,
      doc: "**bo**" + NL + NL + "**ld**",
      cursor: 10,
    });
  });

  it("drops the whitespace at the split so no marker touches a space", () => {
    expect(run(paragraphEnter, "**two words**", 5).doc).toBe(
      "**two**" + NL + NL + "**words**",
    );
    expect(run(paragraphEnter, "**two words**", 6).doc).toBe(
      "**two**" + NL + NL + "**words**",
    );
  });

  it("nested: italic inside bold", () => {
    expect(run(paragraphEnter, "**a *bc* d**", 6).doc).toBe(
      "**a *b***" + NL + NL + "***c* d**",
    );
  });

  it("at the content end the whole break goes after the run", () => {
    expect(run(paragraphEnter, "**bold**", 6)).toEqual({
      ok: true,
      doc: "**bold**" + NL + NL,
      cursor: 10,
    });
  });

  it("at the content start the run moves to the new paragraph", () => {
    expect(run(paragraphEnter, "**bold**", 2)).toEqual({
      ok: true,
      doc: NL + NL + "**bold**",
      cursor: 4,
    });
  });

  it("inner run at its start, outer run mid-way", () => {
    // "**a *|b* c**" -> the italic opener moves down with its text.
    expect(run(paragraphEnter, "**a *b* c**", 5).doc).toBe(
      "**a**" + NL + NL + "***b* c**",
    );
  });

  it("inline code, strikethrough and underline tags split alike", () => {
    expect(run(paragraphEnter, "`ab`", 2).doc).toBe("`a`" + NL + NL + "`b`");
    expect(run(paragraphEnter, "~~ab~~", 3).doc).toBe(
      "~~a~~" + NL + NL + "~~b~~",
    );
    expect(run(paragraphEnter, "<u>ab</u>", 4).doc).toBe(
      "<u>a</u>" + NL + NL + "<u>b</u>",
    );
  });

  it("plain text keeps the old exact behaviour", () => {
    expect(run(paragraphEnter, "one two", 3).doc).toBe(
      "one" + NL + NL + " two",
    );
  });

  it("Shift+Enter at the content end breaks after the run", () => {
    expect(run(hardBreakEnter, "**bold**", 6).doc).toBe("**bold**" + BS + NL);
  });

  it("Shift+Enter mid-run stays inside (emphasis may span lines)", () => {
    expect(run(hardBreakEnter, "**bold**", 4).doc).toBe(
      "**bo" + BS + NL + "ld**",
    );
  });

  it("italic toggle still unwraps from inside", () => {
    expect(run(toggleItalic, "*it*", 2).doc).toBe("it");
  });
});
