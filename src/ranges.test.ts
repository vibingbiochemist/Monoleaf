import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { trimRange } from "./ranges";

// A real comment anchor: <!--c: + a 4-character id + s|e + --> = 14 chars.
// comments.ts draws ids from an alphabet excluding "s" and "e", so an id can
// never make a start token read as an end token.
const START = "<!--c:a1x9s-->";
const END = "<!--c:a1x9e-->";

/** Trim the whole document and return the text that survived. */
function trimmed(doc: string): string {
  const state = EditorState.create({ doc });
  const { from, to } = trimRange(state, 0, doc.length);
  return doc.slice(from, to);
}

/** Trim an explicit span and return the text that survived. */
function trimmedSpan(doc: string, from: number, to: number): string {
  const state = EditorState.create({ doc });
  const r = trimRange(state, from, to);
  return doc.slice(r.from, r.to);
}

describe("trimRange", () => {
  it("leaves a range that already sits on text alone", () => {
    expect(trimmed("word")).toBe("word");
    expect(trimmed("two words")).toBe("two words");
  });

  // Why this matters: a double-click selection usually includes the following
  // space, and GFM forbids whitespace just inside emphasis or strikethrough
  // delimiters — so `**word **` would emit markers that never parse.
  it("trims surrounding whitespace so wrapping delimiters land on text", () => {
    expect(trimmed(" word ")).toBe("word");
    expect(trimmed("\tword\n")).toBe("word");
    expect(trimmed("   spaced   out   ")).toBe("spaced   out");
  });

  it("steps over a leading start anchor and a trailing end anchor", () => {
    expect(trimmed(`${START}word${END}`)).toBe("word");
    expect(trimmed(`${START}word`)).toBe("word");
    expect(trimmed(`word${END}`)).toBe("word");
  });

  it("steps over whitespace and anchors in any order", () => {
    expect(trimmed(` ${START} word ${END} `)).toBe("word");
    expect(trimmed(`${START} word${END}`)).toBe("word");
    expect(trimmed(` ${START}word ${END}`)).toBe("word");
  });

  it("steps over stacked anchors from overlapping threads", () => {
    // Two threads opening on the same word. The loop advances one token per
    // iteration with a fresh window, so the 40-character lookahead does not
    // cap how many can stack.
    const second = "<!--c:b2y7s-->";
    expect(trimmed(`${START}${second}word${END}`)).toBe("word");
    expect(trimmed(`${START}${second}<!--c:c3z8s-->word`)).toBe("word");
  });

  it("collapses a range with nothing but whitespace and anchors", () => {
    // Callers filter these out (commands.ts drops segments where from >= to),
    // so collapsing is the contract rather than an error.
    for (const doc of ["   ", `${START}${END}`, ` ${START} ${END} `]) {
      const state = EditorState.create({ doc });
      const r = trimRange(state, 0, doc.length);
      expect(r.from, doc).toBe(r.to);
    }
  });

  it("returns an empty range unchanged", () => {
    const state = EditorState.create({ doc: "word" });
    expect(trimRange(state, 2, 2)).toEqual({ from: 2, to: 2 });
    expect(trimRange(state, 0, 0)).toEqual({ from: 0, to: 0 });
  });

  it("does not trim an anchor it cannot see the whole of", () => {
    // The span ends mid-token, so there is no complete anchor to step over and
    // the range must be left where it is rather than guessing.
    const doc = `word${END}`;
    const cut = doc.length - 4; // inside the trailing "-->"
    expect(trimmedSpan(doc, 0, cut)).toBe(`word${END}`.slice(0, cut));
  });

  it("only ever shrinks the range, and never inverts it", () => {
    const docs = [
      "word",
      " word ",
      `${START}word${END}`,
      "   ",
      `${START} ${END}`,
      "a",
    ];
    for (const doc of docs) {
      const state = EditorState.create({ doc });
      const r = trimRange(state, 0, doc.length);
      expect(r.from, doc).toBeGreaterThanOrEqual(0);
      expect(r.to, doc).toBeLessThanOrEqual(doc.length);
      expect(r.from, doc).toBeLessThanOrEqual(r.to);
    }
  });

  it("leaves text that merely resembles an anchor", () => {
    // Not a comment anchor: the id has the wrong shape, so it is ordinary text
    // and must not be eaten.
    expect(trimmed("<!--c:TOOLONGs-->word")).toBe("<!--c:TOOLONGs-->word");
    expect(trimmed("<!--nope-->word")).toBe("<!--nope-->word");
    expect(trimmed("<!--c:a1x9s-->")).toBe("");
  });

  it("trims a span inside a larger document, not just the whole doc", () => {
    const doc = `lead ${START} middle ${END} trail`;
    const from = doc.indexOf(START);
    const to = doc.indexOf(" trail");
    expect(trimmedSpan(doc, from, to)).toBe("middle");
  });

  it("post-condition: the surviving range starts and ends on real text", () => {
    for (const doc of [
      ` ${START} word ${END} `,
      "  hello  ",
      `${START}${START}x`,
    ]) {
      const survived = trimmed(doc);
      if (survived === "") continue;
      expect(survived[0], doc).not.toMatch(/\s/);
      expect(survived[survived.length - 1], doc).not.toMatch(/\s/);
      expect(survived.startsWith("<!--c:"), doc).toBe(false);
      expect(survived.endsWith("-->"), doc).toBe(false);
    }
  });
});
