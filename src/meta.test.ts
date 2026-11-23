import { describe, expect, it } from "vitest";
import {
  applyMeta,
  frontMatter,
  metaBlock,
  parseMeta,
  stripMeta,
  EMPTY_META,
  setHeaderLines,
} from "./meta";
import { createDocumentState, serializeDocument } from "./document";

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

describe("frontMatter", () => {
  it("is the text between the fences, or empty without a header", () => {
    expect(frontMatter("---\ntitle: X\ncsl: apa\n---\n\nbody\n")).toBe(
      "title: X\ncsl: apa",
    );
    expect(frontMatter("# Body\n")).toBe("");
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

describe("applyMeta keeps front-matter keys it does not know", () => {
  // A pandoc header: keys Monoleaf has no field for, and a nested list with a
  // `title:` of its own that is not the document's.
  const header = (nl: string) =>
    [
      "title: My paper",
      "csl: apa",
      "references:",
      "- id: ERA5",
      "  title: ERA5-Land hourly data",
      "  author:",
      "  - literal: Copernicus",
      "lang: en-GB",
    ].join(nl);
  const doc = (nl: string, block = header(nl)) =>
    `---${nl}${block}${nl}---${nl}${nl}As shown by [@ERA5].${nl}`;
  const paper = { ...EMPTY_META, title: "My paper" };

  for (const [name, nl] of [
    ["LF", "\n"],
    ["CRLF", "\r\n"],
    ["CR", "\r"],
  ] as const) {
    it(`${name}: saving unchanged values leaves the file byte-identical`, () => {
      expect(applyMeta(doc(nl), paper, "frontmatter", nl)).toBe(doc(nl));
    });

    it(`${name}: a new title changes only the title line`, () => {
      const renamed = { ...paper, title: "Our paper" };
      expect(applyMeta(doc(nl), renamed, "frontmatter", nl)).toBe(
        doc(nl).replace("title: My paper", "title: Our paper"),
      );
    });

    it(`${name}: a new field goes below the existing lines`, () => {
      const signed = { ...paper, author: "Martin" };
      expect(applyMeta(doc(nl), signed, "frontmatter", nl)).toBe(
        doc(nl, `${header(nl)}${nl}author: Martin`),
      );
    });

    it(`${name}: clearing a field removes only its line`, () => {
      expect(applyMeta(doc(nl), EMPTY_META, "frontmatter", nl)).toBe(
        doc(nl).replace(`title: My paper${nl}`, ""),
      );
    });
  }

  it("keeps the order of the fields already in the header", () => {
    const start = "---\nauthor: Martin\ntitle: Old\n---\n\n# Body\n";
    const meta = { ...EMPTY_META, author: "Martin", title: "New" };
    expect(applyMeta(start, meta, "frontmatter")).toBe(
      "---\nauthor: Martin\ntitle: New\n---\n\n# Body\n",
    );
  });

  it("removes a header that is left without any line", () => {
    const start = "---\ntitle: X\n---\n\n# Body\n";
    expect(applyMeta(start, EMPTY_META, "frontmatter")).toBe("# Body\n");
  });
});

describe("a field the header holds as a list or block", () => {
  const doc = (author: string) =>
    `---\ntitle: T\nauthor:\n${author}\nlang: en\n---\n\nbody\n`;

  it("reads a plain list as one line of text and reports it locked", () => {
    const { meta, locked } = parseMeta(doc('- Jane\n  - "John Doe"'));
    expect(meta.author).toBe("Jane, John Doe");
    expect(locked).toEqual(["author"]);
    expect(meta.title).toBe("T");
  });

  it("reads nested entries as empty, still locked", () => {
    const { meta, locked } = parseMeta(doc("- name: Jane\n  affiliation: X"));
    expect(meta.author).toBe("");
    expect(locked).toEqual(["author"]);
  });

  it("reports no locked field for one-line values", () => {
    expect(parseMeta("---\ntitle: T\nauthor: Jane\n---\n").locked).toEqual([]);
  });

  it("is never rewritten, whatever value is passed for it", () => {
    const start = doc("- Jane\n- John");
    const meta = { ...EMPTY_META, title: "New", author: "Somebody else" };
    expect(applyMeta(start, meta, "frontmatter")).toBe(
      start.replace("title: T", "title: New"),
    );
  });
});

describe("the ml:meta comment below a header of other tools", () => {
  const header = "---\ncsl: apa\n---\n\n";
  const mixed = `${header}<!--ml:meta {"title":"Real"}-->\n\nbody\n`;
  const real = { ...EMPTY_META, title: "Real" };

  it("is read", () => {
    const { meta, format } = parseMeta(mixed);
    expect(meta.title).toBe("Real");
    expect(format).toBe("comment");
  });

  it("is replaced on save, not written a second time", () => {
    expect(applyMeta(mixed, real, "comment")).toBe(mixed);
    expect(applyMeta(mixed, { ...real, title: "New" }, "comment")).toBe(
      mixed.replace("Real", "New"),
    );
  });

  it("takes the fields out of the header and leaves the other keys", () => {
    const start = "---\ntitle: Real\ncsl: apa\n---\n\nbody\n";
    expect(applyMeta(start, real, "comment")).toBe(mixed);
  });

  it("gives the fields back to the header", () => {
    expect(applyMeta(mixed, real, "frontmatter")).toBe(
      "---\ncsl: apa\ntitle: Real\n---\n\nbody\n",
    );
  });

  it("leaves a list in the header and reads it back from there", () => {
    const start = "---\ntitle: Real\nauthor:\n- Jane\n- John\n---\n\nbody\n";
    const meta = { ...real, author: "Jane, John" };
    const saved = applyMeta(start, meta, "comment");
    expect(saved).toBe(
      '---\nauthor:\n- Jane\n- John\n---\n\n<!--ml:meta {"title":"Real"}-->\n\nbody\n',
    );
    expect(parseMeta(saved)).toEqual({
      meta,
      format: "comment",
      locked: ["author"],
    });
  });
});

describe("applyMeta keeps the file's line endings", () => {
  const meta = { ...EMPTY_META, title: "T", author: "A" };

  // Through an editor state, as the Document Properties dialog does it: the
  // result replaces the whole document and has to stay one line per line.
  const applyInEditor = (doc: string, format: "comment" | "frontmatter") => {
    const state = createDocumentState(doc);
    const current = serializeDocument(state);
    const updated = applyMeta(current, meta, format, state.lineBreak);
    return state.update({
      changes: { from: 0, to: state.doc.length, insert: updated },
    }).state;
  };

  for (const [name, nl] of [
    ["CRLF", "\r\n"],
    ["CR", "\r"],
  ] as const) {
    it(`${name}: front matter is written with ${name} and stays separate lines`, () => {
      const after = applyInEditor(`# Body${nl}text${nl}`, "frontmatter");
      expect(serializeDocument(after)).toBe(
        `---${nl}title: T${nl}author: A${nl}---${nl}${nl}# Body${nl}text${nl}`,
      );
      expect(after.doc.lines).toBe(8);
    });

    it(`${name}: replacing existing metadata leaves no stray blank lines`, () => {
      const start = `---${nl}title: Old${nl}---${nl}${nl}# Body${nl}`;
      expect(parseMeta(start).meta.title).toBe("Old");
      const once = serializeDocument(applyInEditor(start, "comment"));
      expect(once).toBe(
        `<!--ml:meta {"title":"T","author":"A"}-->${nl}${nl}# Body${nl}`,
      );
      expect(serializeDocument(applyInEditor(once, "comment"))).toBe(once);
    });
  }
});

describe("setHeaderLines", () => {
  const header =
    "---\ntitle: T\ncsl: apa\nreferences:\n- id: a\n  title: A\nlang: en-GB\n---\n\nBody\n";

  it("replaces a key in place, value lines included, and keeps the rest", () => {
    const out = setHeaderLines(header, {
      csl: "ieee",
      references: ["- id: b", "  title: B"],
    });
    expect(out).toBe(
      "---\ntitle: T\ncsl: ieee\nreferences:\n- id: b\n  title: B\nlang: en-GB\n---\n\nBody\n",
    );
  });

  it("removes a key with its lines, adds new keys below, quotes what needs it", () => {
    const out = setHeaderLines(header, {
      references: null,
      "reference-section-title": "Sources: all",
      "suppress-bibliography": "true",
    });
    expect(out).toBe(
      '---\ntitle: T\ncsl: apa\nlang: en-GB\nreference-section-title: "Sources: all"\nsuppress-bibliography: true\n---\n\nBody\n',
    );
  });

  it("gives a document without a header one, above an ml:meta comment", () => {
    const doc = '<!--ml:meta {"title":"T"}-->\n\nBody\n';
    const out = setHeaderLines(doc, { bibliography: "refs.bib" });
    expect(out).toBe("---\nbibliography: refs.bib\n---\n\n" + doc);
    expect(parseMeta(out).meta.title).toBe("T");
    expect(setHeaderLines("", { csl: "apa" })).toBe("---\ncsl: apa\n---\n");
    expect(setHeaderLines("Body\n", {})).toBe("Body\n");
  });

  it("keeps CRLF line breaks and removes a header left empty", () => {
    const crlf = "---\r\ncsl: apa\r\n---\r\n\r\nBody\r\n";
    expect(setHeaderLines(crlf, { lang: "de-DE" }, "\r\n")).toBe(
      "---\r\ncsl: apa\r\nlang: de-DE\r\n---\r\n\r\nBody\r\n",
    );
    expect(setHeaderLines(crlf, { csl: null }, "\r\n")).toBe("Body\r\n");
  });
});
