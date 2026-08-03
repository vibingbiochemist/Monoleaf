import { describe, expect, it } from "vitest";
import { applyMeta, metaBlock, parseMeta, stripMeta, EMPTY_META } from "./meta";

describe("parseMeta", () => {
  it("reads an ml:meta comment block", () => {
    const { meta, format } = parseMeta(
      '<!--ml:meta {"title":"Assay","author":"Martin"}-->\n\nbody\n',
    );
    expect(format).toBe("comment");
    expect(meta.title).toBe("Assay");
    expect(meta.author).toBe("Martin");
  });

  it("reads YAML front matter", () => {
    const { meta, format } = parseMeta(
      '---\ntitle: Assay Report\nauthor: "Martin"\ndate: 2026-07-20\n---\n\nbody\n',
    );
    expect(format).toBe("frontmatter");
    expect(meta.title).toBe("Assay Report");
    expect(meta.author).toBe("Martin");
    expect(meta.date).toBe("2026-07-20");
  });

  it("returns empty metadata (comment default) when there is none", () => {
    const { meta, format } = parseMeta("# Just a doc\n");
    expect(meta).toEqual(EMPTY_META);
    expect(format).toBe("comment");
  });
});

describe("stripMeta", () => {
  it("removes an ml:meta comment and leading blank lines", () => {
    expect(stripMeta('<!--ml:meta {"title":"X"}-->\n\n# Body\n')).toBe(
      "# Body\n",
    );
  });
  it("removes front matter", () => {
    expect(stripMeta("---\ntitle: X\n---\n\n# Body\n")).toBe("# Body\n");
  });
});

describe("metaBlock", () => {
  it("is empty when all fields are blank", () => {
    expect(metaBlock(EMPTY_META, "comment")).toBe("");
    expect(metaBlock(EMPTY_META, "frontmatter")).toBe("");
  });
  it("emits front matter lines for the set fields", () => {
    const block = metaBlock(
      { ...EMPTY_META, title: "X", author: "M" },
      "frontmatter",
    );
    expect(block).toBe("---\ntitle: X\nauthor: M\n---");
  });
});

describe("applyMeta round-trip", () => {
  it("switches format while preserving the values and body", () => {
    const start =
      '<!--ml:meta {"title":"Report","author":"Martin"}-->\n\n# Hello\n';
    const { meta } = parseMeta(start);
    const asFront = applyMeta(start, meta, "frontmatter");
    expect(asFront).toBe(
      "---\ntitle: Report\nauthor: Martin\n---\n\n# Hello\n",
    );
    // ...and back again yields the original comment form.
    const parsed = parseMeta(asFront);
    expect(applyMeta(asFront, parsed.meta, "comment")).toBe(start);
  });

  it("clearing all fields removes the block entirely", () => {
    const start = "---\ntitle: X\n---\n\n# Body\n";
    expect(applyMeta(start, EMPTY_META, "comment")).toBe("# Body\n");
  });
});
