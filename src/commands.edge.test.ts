import { describe, expect, it } from "vitest";
import { ensureSyntaxTree } from "@codemirror/language";
import { EditorSelection, EditorState, StateCommand } from "@codemirror/state";
import { applyLink, setHeading, toggleBold, toggleItalic } from "./commands";
import { markdownForMode } from "./portability";

function mkState(doc: string, anchor: number, head = anchor): EditorState {
  const state = EditorState.create({
    doc,
    selection: EditorSelection.single(anchor, head),
    extensions: markdownForMode("enhanced"),
  });
  ensureSyntaxTree(state, doc.length, 5000);
  return state;
}

function run(cmd: StateCommand, doc: string, anchor: number, head = anchor) {
  const state = mkState(doc, anchor, head);
  let after: EditorState | null = null;
  cmd({
    state,
    dispatch: (tr) => {
      after = tr.state;
    },
  });
  return after === null ? doc : (after as EditorState).doc.toString();
}

describe("selection shapes that must still produce valid GFM", () => {
  it("leading whitespace in the selection is excluded", () => {
    expect(run(toggleBold, "hello world", 5, 11)).toBe("hello **world**");
  });

  it("word adjacent to punctuation", () => {
    expect(run(toggleBold, "word.", 0, 4)).toBe("**word**.");
  });

  it("intraword ranges wrap with asterisks (valid per CommonMark)", () => {
    expect(run(toggleBold, "hello", 1, 3)).toBe("h**el**lo");
  });

  it("cursor inside the opening marker still unwraps", () => {
    expect(run(toggleBold, "**hello** w", 1)).toBe("hello w");
  });

  it("selection spanning a blank line wraps each paragraph separately", () => {
    expect(run(toggleBold, "one\n\ntwo", 0, 8)).toBe("**one**\n\n**two**");
  });

  it("multi-paragraph italic likewise", () => {
    expect(run(toggleItalic, "one two\n\nthree", 4, 14)).toBe(
      "one *two*\n\n*three*",
    );
  });
});

describe("setHeading edge cases", () => {
  it("recognizes an indented heading (up to 3 leading spaces is valid md)", () => {
    expect(run(setHeading(2), "  # x", 4)).toBe("## x");
  });
});

describe("formatting next to comment anchors (Martin's italic bug)", () => {
  const ANCHORED = "a <!--c:q1s-->word<!--c:q1e--> b";

  it("selection snapped outside the anchors wraps inside them", () => {
    const from = ANCHORED.indexOf("<!--c:q1s-->");
    const to = ANCHORED.indexOf(" b");
    expect(run(toggleItalic, ANCHORED, from, to)).toBe(
      "a <!--c:q1s-->*word*<!--c:q1e--> b",
    );
  });

  it("bold likewise", () => {
    const from = ANCHORED.indexOf("<!--c:q1s-->");
    const to = ANCHORED.indexOf(" b");
    expect(run(toggleBold, ANCHORED, from, to)).toBe(
      "a <!--c:q1s-->**word**<!--c:q1e--> b",
    );
  });

  it("unwrapping works with the same anchor-spanning selection", () => {
    const doc = "a <!--c:q1s-->*word*<!--c:q1e--> b";
    const from = doc.indexOf("<!--c:q1s-->");
    const to = doc.indexOf(" b");
    expect(run(toggleItalic, doc, from, to)).toBe(ANCHORED);
  });
});

describe("applyLink around formatted text", () => {
  it("keeps inline formatting inside the link text", () => {
    const state = mkState("**a** b", 0, 5);
    const after = state.update(applyLink(state, "u"));
    expect(after.state.doc.toString()).toBe("[**a**](u) b");
  });
});
