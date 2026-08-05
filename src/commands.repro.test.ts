import { describe, expect, it } from "vitest";
import { ensureSyntaxTree } from "@codemirror/language";
import { EditorSelection, EditorState, StateCommand } from "@codemirror/state";
import { toggleBold, toggleItalic, toggleStrikethrough } from "./commands";
import { markdownForMode } from "./portability";

function run(cmd: StateCommand, doc: string, anchor: number, head = anchor) {
  const state = EditorState.create({
    doc,
    selection: EditorSelection.single(anchor, head),
    extensions: markdownForMode("enhanced"),
  });
  ensureSyntaxTree(state, doc.length, 5000);
  let after: EditorState | null = null;
  cmd({
    state,
    dispatch: (tr) => {
      after = tr.state;
    },
  });
  return after === null ? doc : (after as EditorState).doc.toString();
}

describe("repro: selection includes trailing space (double-click select)", () => {
  it("bold wrap must not produce '**word **'", () => {
    expect(run(toggleBold, "hello world", 0, 6)).toBe("**hello** world");
  });
  it("italic wrap must not produce '*word *'", () => {
    expect(run(toggleItalic, "hello world", 0, 6)).toBe("*hello* world");
  });
  it("strikethrough wrap must not produce '~~word ~~'", () => {
    expect(run(toggleStrikethrough, "hello world", 0, 6)).toBe(
      "~~hello~~ world",
    );
  });
  it("unbold with trailing space in selection", () => {
    expect(run(toggleBold, "**hello** world", 0, 10)).toBe("hello world");
  });
});

describe("repro: unwrap with various selection shapes", () => {
  it("selection exactly the visible text", () => {
    expect(run(toggleBold, "**hello** world", 2, 7)).toBe("hello world");
  });
  it("selection covering the whole construct incl. markers", () => {
    expect(run(toggleBold, "**hello** world", 0, 9)).toBe("hello world");
  });
});
