import { describe, expect, it } from "vitest";
import { EditorSelection, EditorState } from "@codemirror/state";
import {
  collectHeadings,
  headingSlug,
  insertTableOfContents,
  TOC_END,
  TOC_START,
} from "./commands";

function docOf(text: string, cursor = 0): EditorState {
  return EditorState.create({
    doc: text,
    selection: EditorSelection.single(cursor),
  });
}

function run(state: EditorState): string {
  let out = state.doc.toString();
  insertTableOfContents({
    state,
    dispatch: (tr) => {
      out = tr.state.doc.toString();
    },
  });
  return out;
}

describe("headingSlug", () => {
  it("matches GitHub's slug rules", () => {
    expect(headingSlug("Results & Discussion")).toBe("results--discussion");
    expect(headingSlug("The 5th Element")).toBe("the-5th-element");
    expect(headingSlug("  Spaced  Out  ")).toBe("spaced--out");
  });
});

describe("collectHeadings", () => {
  it("finds ATX headings with levels and de-duplicated slugs", () => {
    const h = collectHeadings(docOf("# A\n\n## B\n\n## B\n"));
    expect(h.map((x) => [x.level, x.slug])).toEqual([
      [1, "a"],
      [2, "b"],
      [2, "b-1"],
    ]);
  });

  it("skips headings inside fenced code", () => {
    const h = collectHeadings(docOf("# Real\n\n```\n# Not a heading\n```\n"));
    expect(h.map((x) => x.title)).toEqual(["Real"]);
  });
});

describe("insertTableOfContents", () => {
  it("inserts a nested list of anchor links", () => {
    const out = run(docOf("# Title\n\n## Section\n\n### Sub\n", 0));
    expect(out).toContain(TOC_START);
    expect(out).toContain(TOC_END);
    expect(out).toContain("- [Title](#title)");
    expect(out).toContain("  - [Section](#section)");
    expect(out).toContain("    - [Sub](#sub)");
  });

  it("refreshes an existing TOC in place rather than duplicating", () => {
    const first = run(docOf("# One\n\n## Two\n", 0));
    // Add a heading, then regenerate.
    const withThird = first + "\n## Three\n";
    const second = run(docOf(withThird, 0));
    expect(second.match(new RegExp(TOC_START, "g"))).toHaveLength(1);
    expect(second).toContain("- [Three](#three)");
  });
});
