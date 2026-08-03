import { describe, expect, it } from "vitest";
import { ensureSyntaxTree } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import {
  findNonPortableRanges,
  markdownForMode,
  portabilityExtensions,
  PortabilityMode,
} from "./portability";
import { createDocumentState, serializeDocument } from "./document";

function parsedState(doc: string, mode: PortabilityMode): EditorState {
  const state = EditorState.create({
    doc,
    extensions: markdownForMode(mode),
  });
  const tree = ensureSyntaxTree(state, doc.length, 5000);
  if (tree === null) throw new Error("parse did not finish");
  return state;
}

function ranges(doc: string, mode: PortabilityMode) {
  const state = parsedState(doc, mode);
  const tree = ensureSyntaxTree(state, doc.length, 5000)!;
  return findNonPortableRanges(tree).map((r) => ({
    type: r.type,
    text: state.sliceDoc(r.from, r.to),
  }));
}

const SAMPLE =
  "H~2~O to the 5^th^ power :smile:\n\n" +
  "| a | b |\n|---|---|\n| 1 | 2 |\n\n" +
  "- [x] done\n- [ ] open\n\n" +
  "~~gone~~ and www.example.com\n";

describe("strict mode (portable baseline)", () => {
  it("does not parse beyond-baseline constructs, so nothing is flagged", () => {
    expect(ranges(SAMPLE, "strict")).toEqual([]);
  });

  it("still parses GFM (table rows get Table nodes)", () => {
    const state = parsedState(SAMPLE, "strict");
    const tree = ensureSyntaxTree(state, SAMPLE.length, 5000)!;
    let sawTable = false;
    tree.iterate({
      enter: (n) => {
        if (n.name === "Table") sawTable = true;
      },
    });
    expect(sawTable).toBe(true);
  });
});

describe("enhanced mode flags beyond-baseline constructs", () => {
  it("flags subscript, superscript, and emoji with exact ranges", () => {
    expect(ranges(SAMPLE, "enhanced")).toEqual([
      { type: "Subscript", text: "~2~" },
      { type: "Superscript", text: "^th^" },
      { type: "Emoji", text: ":smile:" },
    ]);
  });

  it("does not flag GFM constructs (tables, task lists, strikethrough, autolinks)", () => {
    const gfmOnly =
      "| a |\n|---|\n\n- [x] t\n\n~~strike~~ https://example.com\n";
    expect(ranges(gfmOnly, "enhanced")).toEqual([]);
  });
});

describe("round trip is unaffected by mode extensions", () => {
  const fixtures = [
    "H~2~O :smile:\r\nCRLF file^2^\r\n",
    "no trailing newline ~x~",
    "\uFEFFbom :tada: mixed\nlf\r\ncrlf",
  ];
  for (const mode of ["strict", "enhanced"] as const) {
    for (const content of fixtures) {
      it(`${mode}: ${JSON.stringify(content).slice(0, 40)}`, () => {
        // showFlags on, so the flagger extension is exercised too.
        const state = createDocumentState(content, [
          portabilityExtensions(mode, true),
        ]);
        expect(serializeDocument(state)).toBe(content);
      });
    }
  }
});
