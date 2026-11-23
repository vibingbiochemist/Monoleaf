import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import {
  buildPrintCss,
  contentExpression,
  cssLengthToPx,
  DEFAULT_PAGE_CONFIG,
  marginToPx,
  parsePageConfig,
  renderDocumentHtml,
  renderDocumentHtmlAsync,
  renderStandaloneHtml,
  setPageConfigSpec,
  wrapStandaloneHtml,
  tolerantRenderer,
} from "./export";
import { createDocumentState, serializeDocument } from "./document";
import { cellDisplayHtml } from "./tablecell";
import { setRemoteImagesAllowed } from "./remoteimages";
import { DEFAULT_FONT_ID, fontStack, MONO_STACK } from "./fonts";

const VARS = { title: "Report", author: "Martin", date: "2026-07-18" };

describe("page config block", () => {
  it("falls back to defaults when absent or malformed", () => {
    expect(parsePageConfig("# doc")).toEqual(DEFAULT_PAGE_CONFIG);
    expect(parsePageConfig("<!--ml:page {broken-->")).toEqual(
      DEFAULT_PAGE_CONFIG,
    );
  });

  it("round-trips through set + parse", () => {
    const cfg = {
      size: "Letter" as const,
      margin: "25mm 15mm",
      font: "lora",
      header: "{title}",
      footer: "Page {page} of {pages}",
      justify: true,
    };
    const state = EditorState.create({ doc: "# doc\n" });
    const after = state.update(setPageConfigSpec(state, cfg)).state;
    expect(parsePageConfig(after.doc.toString())).toEqual(cfg);
  });

  it("appends after a blank line, replaces in place on the second write", () => {
    const state = EditorState.create({ doc: "# doc\n" });
    const first = state.update(
      setPageConfigSpec(state, DEFAULT_PAGE_CONFIG),
    ).state;
    expect(first.doc.toString()).toMatch(/^# doc\n\n<!--ml:page \{.*\}-->\n$/);
    const second = first.update(
      setPageConfigSpec(first, { ...DEFAULT_PAGE_CONFIG, size: "Letter" }),
    ).state;
    expect(second.doc.toString().match(/<!--ml:page/g)).toHaveLength(1);
    expect(parsePageConfig(second.doc.toString()).size).toBe("Letter");
  });

  it("rejects a margin that is not plain CSS lengths", () => {
    const withMargin = (margin: string) =>
      parsePageConfig(`<!--ml:page {"margin":${JSON.stringify(margin)}}-->`)
        .margin;
    // The injection vector: close @page and open top-level rules of your own.
    expect(
      withMargin(
        "15mm } #print-root p { color: transparent } body { background-image: url(https://tracker.test/beacon.png) } @page { margin: 15mm",
      ),
    ).toBe(DEFAULT_PAGE_CONFIG.margin);
    expect(withMargin("20mm } body { color: red")).toBe(
      DEFAULT_PAGE_CONFIG.margin,
    );
    expect(withMargin("url(https://tracker.test/beacon.png)")).toBe(
      DEFAULT_PAGE_CONFIG.margin,
    );
    expect(withMargin("20em")).toBe(DEFAULT_PAGE_CONFIG.margin);
    expect(withMargin("")).toBe(DEFAULT_PAGE_CONFIG.margin);
  });

  it("accepts one to four plain CSS lengths", () => {
    for (const margin of [
      "20mm",
      "25mm 18mm",
      "1in 0.75in 1in 0.75in",
      // Unitless zero is legal CSS and the natural way to ask for no margin.
      "0",
      "0 0",
      "0 20mm 0 20mm",
    ]) {
      expect(
        parsePageConfig(`<!--ml:page {"margin":${JSON.stringify(margin)}}-->`)
          .margin,
      ).toBe(margin);
    }
  });

  it("rejects units the editor cannot measure", () => {
    // Every accepted unit must round-trip through cssLengthToPx, or the editor's
    // page layout and the printed @page rule silently disagree. `pc` was
    // accepted by the grammar and measured as 0.
    for (const margin of ["10pc", "2em", "5%", "10rem"]) {
      expect(
        parsePageConfig(`<!--ml:page {"margin":${JSON.stringify(margin)}}-->`)
          .margin,
        margin,
      ).toBe(DEFAULT_PAGE_CONFIG.margin);
    }
  });

  it("measures every unit the grammar accepts", () => {
    // The guard for the class of bug above: a non-zero length must never
    // measure as zero.
    for (const unit of ["mm", "cm", "in", "pt", "px"]) {
      const margin = `10${unit}`;
      expect(
        parsePageConfig(`<!--ml:page {"margin":${JSON.stringify(margin)}}-->`)
          .margin,
        margin,
      ).toBe(margin);
      expect(cssLengthToPx(margin), margin).toBeGreaterThan(0);
      expect(marginToPx(margin).top, margin).toBeGreaterThan(0);
    }
  });

  it("uses CRLF for the appended block in CRLF documents", () => {
    const state = createDocumentState("# doc\r\n");
    const after = state.update(
      setPageConfigSpec(state, DEFAULT_PAGE_CONFIG),
    ).state;
    expect(serializeDocument(after)).toMatch(
      /^# doc\r\n\r\n<!--ml:page \{.*\}-->\r\n$/,
    );
  });
});

describe("length conversion (editor/PDF WYSIWYG alignment)", () => {
  it("converts CSS units to px at 96dpi", () => {
    expect(cssLengthToPx("20mm")).toBeCloseTo(75.59, 1);
    expect(cssLengthToPx("1in")).toBe(96);
    expect(cssLengthToPx("11pt")).toBeCloseTo(14.67, 1);
    expect(cssLengthToPx("2.54cm")).toBeCloseTo(96, 1);
    expect(cssLengthToPx("40px")).toBe(40);
  });

  it("expands margin shorthand like CSS", () => {
    expect(marginToPx("20mm")).toEqual({
      top: cssLengthToPx("20mm"),
      right: cssLengthToPx("20mm"),
      bottom: cssLengthToPx("20mm"),
      left: cssLengthToPx("20mm"),
    });
    const two = marginToPx("25mm 18mm");
    expect(two.top).toBeCloseTo(two.bottom, 5);
    expect(two.left).toBeCloseTo(two.right, 5);
    expect(two.top).not.toBeCloseTo(two.left, 1);
  });
});

describe("contentExpression", () => {
  it("returns null for an empty template", () => {
    expect(contentExpression("", VARS)).toBeNull();
    expect(contentExpression("  ", VARS)).toBeNull();
  });

  it("returns null when a variable-only template resolves to empty", () => {
    // "{title}" with an empty title must give null (no margin box), not "",
    // which would emit invalid `content: ;` and crash Paged.js.
    expect(contentExpression("{title}", { title: "", date: "" })).toBeNull();
  });

  it("compiles page counters", () => {
    expect(contentExpression("{page} / {pages}", VARS)).toBe(
      'counter(page) " / " counter(pages)',
    );
  });

  it("mixes text, counters, and variables", () => {
    expect(contentExpression("{title} — Seite {page}", VARS)).toBe(
      '"Report — Seite " counter(page)',
    );
  });

  it("escapes quotes in literal text", () => {
    expect(contentExpression('say "hi" {page}', VARS)).toBe(
      '"say \\"hi\\" " counter(page)',
    );
  });

  it("resolves the {author} metadata placeholder", () => {
    expect(contentExpression("{author} · {date}", VARS)).toBe(
      '"Martin · 2026-07-18"',
    );
  });
});

describe("renderDocumentHtml", () => {
  it("strips comment anchors, bodies, and the page config block", () => {
    const doc =
      'a <!--c:q1s-->b<!--c:q1e--> c\n\n<!--c:q1 {"resolved":false,"thread":[]}-->\n<!--ml:page {"size":"A4"}-->\n';
    const html = renderDocumentHtml(doc, "strict");
    expect(html).not.toContain("<!--c:");
    expect(html).not.toContain("ml:page");
    expect(html).toContain("a b c");
  });

  // A header that names references: without one a citation is text.
  const REFS = "---\nbibliography: r.bib\n---\n\n";

  it("renders citations through the backend and places the list at #refs", async () => {
    const doc =
      REFS + "Text [@a, p. 3] and @b.\n\n::: {#refs}\n:::\n\nAfter.\n";
    const asked: string[][] = [];
    const html = await renderDocumentHtmlAsync(
      doc,
      "strict",
      false,
      () => Promise.resolve(new Map()),
      (citations) => {
        asked.push(citations.map((c) => c.items.map((i) => i.key).join("+")));
        return Promise.resolve({
          citations: ["(Doe 2020, 3)", null],
          bibliography: [
            { key: "a", label: null, html: "Doe. 2020. <i>A</i>." },
          ],
          hangingIndent: true,
          title: "References",
          warnings: [],
        });
      },
    );
    expect(asked).toEqual([["a", "b"]]);
    expect(html).toContain(
      '<span class="citation">(Doe 2020, 3)</span> and @b.',
    );
    expect(html).not.toContain(":::");
    // An explicit block never gets the header's title, as in pandoc.
    expect(html).not.toContain("References");
    const list = html.indexOf(
      '<div id="refs" class="references csl-bib-body hanging-indent" role="list">',
    );
    expect(list).toBeGreaterThan(html.indexOf("Text"));
    expect(list).toBeLessThan(html.indexOf("After."));
    expect(html).toContain(
      '<div id="ref-a" class="csl-entry" role="listitem">Doe. 2020. <i>A</i>.</div>',
    );
  });

  it("leaves an @ after a letter of any script as text", async () => {
    const asked: string[] = [];
    await renderDocumentHtmlAsync(
      REFS + "ü@doe2020 and jane@doe.org\n",
      "strict",
      false,
      () => Promise.resolve(new Map()),
      (citations) => {
        asked.push(...citations.flatMap((c) => c.items.map((i) => i.key)));
        return Promise.resolve({
          citations: [],
          bibliography: [],
          hangingIndent: false,
          title: null,
          warnings: [],
        });
      },
    );
    expect(asked).toEqual([]);
  });

  describe("the refs blocks, as pandoc fills them", () => {
    const stub = () =>
      Promise.resolve({
        citations: ["(Doe 2020)"],
        bibliography: [{ key: "a", label: null, html: "Doe. 2020." }],
        hangingIndent: false,
        title: "Works & Notes",
        warnings: [],
      });
    const render = (doc: string) =>
      renderDocumentHtmlAsync(
        REFS + doc,
        "enhanced",
        false,
        () => Promise.resolve(new Map()),
        stub,
      );
    const entry = '<div id="ref-a" class="csl-entry" role="listitem">';

    it("fills every block with the whole list", async () => {
      const html = await render(
        "One [@a].\n\n::: {#refs}\n:::\n\nTwo.\n\n::: {#refs}\n\n:::\n",
      );
      expect(html.split(entry).length - 1).toBe(2);
      expect(html).not.toContain(":::");
      expect(html.indexOf(entry)).toBeLessThan(html.indexOf("Two."));
    });

    it("keeps what a block holds and puts the list after it", async () => {
      const html = await render(
        "See [@a].\n\n::: {#refs .small}\n# Works cited\n:::\n\nAfter.\n",
      );
      expect(html).toContain(
        '<div id="refs" class="small references csl-bib-body" role="list">\n<h1>Works cited</h1>',
      );
      expect(html.indexOf("Works cited")).toBeLessThan(html.indexOf(entry));
      expect(html.indexOf(entry)).toBeLessThan(html.indexOf("After."));
      const inline = await render("See [@a].\n\n::: {#refs}\nSources:\n:::\n");
      expect(inline).toContain("<p>Sources:</p>\n" + entry);
    });

    it("puts the title over the list only when there is no block", async () => {
      const html = await render("See [@a].\n");
      // pandoc 3.13 escapes the title: Works &amp; Notes.
      expect(html).toContain(
        '<h1 id="bibliography" class="unnumbered references-title">Works &amp; Notes</h1>\n<div id="refs"',
      );
    });

    it("keeps text right after the closing fence as a paragraph", async () => {
      const html = await render("See [@a].\n\n::: {#refs}\n:::\nAfter.\n");
      // As pandoc 3.13 reads it: the block closes, After. follows the list.
      expect(html).toContain("<p>After.</p>");
      expect(html.indexOf(entry)).toBeLessThan(html.indexOf("After."));
    });

    it("leaves a block in code, an unclosed one and a block without citations", async () => {
      const code = await render("See [@a].\n\n```\n::: {#refs}\n:::\n```\n");
      expect(code).toContain("::: {#refs}");
      expect(code).toContain('<h1 id="bibliography"');
      const unclosed = await render("See [@a].\n\n::: {#refs}\n\nText.\n");
      expect(unclosed).toContain("::: {#refs}");
      const none = await render("No citations.\n\n::: {#refs}\n:::\n");
      expect(none).toContain('<div id="refs"></div>');
      expect(none).not.toContain(":::");
    });
  });

  describe("refsegment: a block lists its chapter's works", () => {
    const entry = (key: string) => ({ key, label: null, html: `${key}.` });
    const render = (doc: string) =>
      renderDocumentHtmlAsync(
        doc,
        "enhanced",
        false,
        () => Promise.resolve(new Map()),
        (citations) =>
          Promise.resolve({
            citations: citations.map(() => "(x)"),
            bibliography: ["a", "b", "c"].map(entry),
            hangingIndent: false,
            title: null,
            warnings: [],
          }),
      );
    // The entries of each refs block, in document order.
    const lists = (html: string) =>
      html
        .split('<div id="refs"')
        .slice(1)
        .map((block) =>
          [...block.split("</div>\n</div>")[0].matchAll(/id="ref-(\w+)"/g)]
            .map((m) => m[1])
            .join(","),
        );
    const doc = (header: string) =>
      `---\nbibliography: r.bib\n${header}---\n\nOne [@a].\n\n::: {#refs}\n:::\n\n` +
      `Two [@b] and a note.[^1]\n\n::: {#refs}\n:::\n\nAppendix [@a].\n\n` +
      `::: {#refs}\n:::\n\n[^1]: The note cites [@c].\n`;

    it("lists each chapter, a footnote at its mark, all at the last block", async () => {
      const html = await render(doc("refsegment: true\n"));
      expect(lists(html)).toEqual(["a", "b,c", "a,b,c"]);
    });

    it("lists every work at every block without the flag", async () => {
      const html = await render(doc("csl: apa\n"));
      expect(lists(html)).toEqual(["a,b,c", "a,b,c", "a,b,c"]);
    });

    it("lists every work in a block inside a footnote, which ends no segment", async () => {
      const html = await render(
        "---\nbibliography: r.bib\nrefsegment: true\n---\n\nOne [@a].\n\n" +
          "::: {#refs}\n:::\n\nTwo [@b].\n\n::: {#refs}\n:::\n\nEnd.[^1]\n\n" +
          "[^1]: Note [@c].\n\n    ::: {#refs}\n    :::\n",
      );
      // pandoc 3.13 fills a block inside a footnote with the whole list.
      expect(lists(html)).toEqual(["a", "a,b,c", "a,b,c"]);
    });
  });

  it("sends a footnote's citations at its mark, as pandoc numbers them", async () => {
    const sent: string[] = [];
    const html = await renderDocumentHtmlAsync(
      REFS + "A [@a].[^1] B [@b].\n\n[^1]: Note [@c].\n",
      "enhanced",
      false,
      () => Promise.resolve(new Map()),
      (citations) => {
        sent.push(...citations.map((c) => c.items[0].key));
        return Promise.resolve({
          citations: citations.map((_, n) => `[${n + 1}]`),
          bibliography: [],
          hangingIndent: false,
          title: null,
          warnings: [],
        });
      },
    );
    expect(sent).toEqual(["a", "c", "b"]);
    // Each answer lands at its own citation: b is the third work.
    expect(html).toContain('B <span class="citation">[3]</span>.');
    expect(html).toContain('Note <span class="citation">[2]</span>.');
  });

  it("counts a footnote marked twice at its first mark", async () => {
    const sent: string[] = [];
    const html = await renderDocumentHtmlAsync(
      REFS + "A [@a].[^1] B [@b]. C.[^1]\n\n[^1]: Note [@c].\n",
      "enhanced",
      false,
      () => Promise.resolve(new Map()),
      (citations) => {
        sent.push(...citations.map((c) => c.items[0].key));
        return Promise.resolve({
          citations: citations.map((_, n) => `[${n + 1}]`),
          bibliography: [],
          hangingIndent: false,
          title: null,
          warnings: [],
        });
      },
    );
    // pandoc 3.13 in ieee: B [3], and both copies of the note cite [2].
    expect(sent).toEqual(["a", "c", "b"]);
    expect(html).toContain('B <span class="citation">[3]</span>.');
    expect(html).toContain('Note <span class="citation">[2]</span>.');
  });

  it("leaves out a citation in a footnote the text never marks", async () => {
    const sent: string[] = [];
    const render = (doc: string) =>
      renderDocumentHtmlAsync(
        REFS + doc,
        "enhanced",
        false,
        () => Promise.resolve(new Map()),
        (citations) => {
          sent.push(...citations.map((c) => c.items[0].key));
          return Promise.resolve({
            citations: citations.map(() => "[1]"),
            bibliography: [],
            hangingIndent: false,
            title: null,
            warnings: [],
          });
        },
      );
    // pandoc 3.13 drops an unused footnote and reads a mark inside a
    // footnote as text: in ieee it numbers and lists a and b only.
    await render(
      "A [@a].[^1] B [@b].\n\n[^1]: Outer.[^2]\n\n[^2]: Inner [@c].\n\n" +
        "[^9]: Unused [@d].\n",
    );
    expect(sent).toEqual(["a", "b"]);
    sent.length = 0;
    await render("No mark.\n\n[^9]: Unused [@d].\n");
    expect(sent).toEqual([]);
  });

  it("escapes the key in an entry's id", async () => {
    const html = await renderDocumentHtmlAsync(
      REFS + "See [@a&b].\n",
      "enhanced",
      false,
      () => Promise.resolve(new Map()),
      () =>
        Promise.resolve({
          citations: ["(Doe 2020)"],
          bibliography: [{ key: "a&b", label: null, html: "Doe. 2020." }],
          hangingIndent: false,
          title: null,
          warnings: [],
        }),
    );
    // As pandoc 3.13 writes it.
    expect(html).toContain('<div id="ref-a&amp;b" class="csl-entry"');
  });

  it("makes a citation a footnote in a note style, as pandoc does", async () => {
    const html = await renderDocumentHtmlAsync(
      REFS +
        "One[^a] and [@doe].\n\nAs @roe says.\n\nAgain [-@doe, p. 4] x.\n\n" +
        "Note two.[^b]\n\n[^a]: First own note.\n[^b]: Own note citing [@roe].\n",
      "enhanced",
      false,
      () => Promise.resolve(new Map()),
      (citations) => {
        // What the backend gives in chicago-notes: the sentence part and
        // the note, or the text in parentheses inside a footnote.
        const parts = citations.map((c): [string, string | null] => {
          const key = c.items[0].key;
          if (c.inNote) return ["(Roe, Other Book)", null];
          if (c.inText) return ["Jim Roe", "Other Book (Pub, 2019)."];
          if (c.items[0].suppressAuthor) return ["", "\u201cA Study,\u201d 4."];
          return ["", key === "doe" ? "Doe, \u201cA Study.\u201d" : null];
        });
        return Promise.resolve({
          citations: parts.map(([text]) => text),
          notes: parts.map(([, note]) => note),
          bibliography: [],
          hangingIndent: false,
          title: null,
          warnings: [],
        });
      },
    );
    // The text outside the tags, as a reader sees it.
    const text = (h: string) => {
      let out = "";
      let inTag = false;
      for (const c of h) {
        if (c === "<") {
          inTag = true;
        } else if (c === ">") {
          inTag = false;
        } else if (!inTag) {
          out += c;
        }
      }
      return out.replace(/\u21a9\ufe0e/g, "").trim();
    };
    const body = html.slice(0, html.indexOf('<section class="footnotes">'));
    // pandoc 3.13: One[1] and.[2] / As Jim Roe[3] says. / Again[4] x. / Note two.[5]
    expect(text(body).split(/\n+/)).toEqual([
      "One[1] and.[2]",
      "As Jim Roe[3] says.",
      "Again[4] x.",
      "Note two.[5]",
    ]);
    const notes = [...html.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/g)].map((m) =>
      text(m[1]),
    );
    expect(notes).toEqual([
      "First own note.",
      "Doe, \u201cA Study.\u201d",
      "Other Book (Pub, 2019).",
      "\u201cA Study,\u201d 4.",
      "Own note citing (Roe, Other Book).",
    ]);
  });

  it("flags a citation inside a footnote unless it opens the footnote", async () => {
    const sent: string[] = [];
    await renderDocumentHtmlAsync(
      REFS +
        "A [@a].[^1][^2][^3]\n\n[^1]: [@b] then *[@c]*.\n\n[^2]: See [@d].\n\n" +
        "[^3]: First [@e].\n\n    [@f] opens the second paragraph.\n",
      "enhanced",
      false,
      () => Promise.resolve(new Map()),
      (citations) => {
        sent.push(...citations.map((c) => c.items[0].key + (c.inNote ?? "")));
        return Promise.reject(new Error("not rendered"));
      },
    ).catch(() => undefined);
    // pandoc 3.13 in chicago-notes: only b is the note itself; c, d, e and
    // f, though it opens the second paragraph, are in parentheses.
    expect(sent).toEqual(["a", "b", "ctrue", "dtrue", "etrue", "ftrue"]);
  });

  it("puts the list before the footnotes when the document has no #refs block", async () => {
    const doc = REFS + "See [@a][^1].\n\n[^1]: Note\n";
    const html = await renderDocumentHtmlAsync(
      doc,
      "strict",
      false,
      () => Promise.resolve(new Map()),
      () =>
        Promise.resolve({
          citations: ["[1]"],
          bibliography: [{ key: "a", label: "[1]", html: "J. Doe, 2020." }],
          hangingIndent: false,
          title: null,
          warnings: [],
        }),
    );
    expect(html).not.toContain("references-title");
    expect(html).toContain(
      '<div class="csl-left-margin">[1]</div><div class="csl-right-inline">J. Doe, 2020.</div>',
    );
    expect(html.indexOf('id="refs"')).toBeLessThan(
      html.indexOf('class="footnotes'),
    );
  });

  it("does not ask the backend for a document without citations", async () => {
    let calls = 0;
    await renderDocumentHtmlAsync(
      "Mail jane@doe.org.\n",
      "strict",
      false,
      () => Promise.resolve(new Map()),
      () => {
        calls++;
        return Promise.reject(new Error("not expected"));
      },
    );
    expect(calls).toBe(0);
  });

  it("prints a citation as written until the backend renders it", () => {
    const doc =
      "---\nbibliography: r.bib\n---\n\nSee [@doe2020, p. 3] and @roe, or mail jane@doe.org.\n";
    const html = renderDocumentHtml(doc, "strict");
    expect(html).toContain(
      "See [@doe2020, p. 3] and @roe, or mail jane@doe.org.",
    );
  });

  it("goes on with the citations as written when the backend refuses", async () => {
    const refused = tolerantRenderer(() =>
      Promise.reject(new Error('unknown citation style "foo"')),
    );
    const html = await renderDocumentHtmlAsync(
      REFS + "See [@a, p. 3 & 4].\n\n::: {#refs}\n:::\n",
      "enhanced",
      false,
      () => Promise.resolve(new Map()),
      refused,
    );
    expect(html).toContain("See [@a, p. 3 &amp; 4].");
    expect(html).not.toContain('class="citation"');
    expect(html).not.toContain("csl-entry");
    const result = await refused([
      { from: 0, to: 4, items: [], inText: false },
    ]);
    expect(result.warnings).toEqual(['Error: unknown citation style "foo"']);
    expect(result.citations).toEqual([null]);
  });

  it("leaves @handles and their links alone when the header names no references", async () => {
    const doc =
      "Follow [@alice](https://example.org/alice) and ping @bob [on Slack](https://slack.example/x).\n";
    const html = renderDocumentHtml(doc, "enhanced");
    expect(html).toContain('<a href="https://example.org/alice">@alice</a>');
    expect(html).toContain('<a href="https://slack.example/x">on Slack</a>');
    expect(html).not.toContain("citation");
    let calls = 0;
    await renderDocumentHtmlAsync(
      doc,
      "enhanced",
      false,
      () => Promise.resolve(new Map()),
      () => {
        calls++;
        return Promise.reject(new Error("not expected"));
      },
    );
    expect(calls).toBe(0);
  });

  it("strips the ml:meta comment block from the body", () => {
    const doc =
      '<!--ml:meta {"title":"Report","author":"Martin"}-->\n\n# Body\n';
    const html = renderDocumentHtml(doc, "strict");
    expect(html).not.toContain("ml:meta");
    expect(html).not.toContain("Martin");
    expect(html).toContain("Body");
  });

  it("blanks a leading YAML front-matter block", () => {
    const doc = "---\ntitle: Report\nauthor: Martin\n---\n\n# Body\n";
    const html = renderDocumentHtml(doc, "strict");
    expect(html).not.toContain("Martin");
    expect(html).not.toContain("title:");
    expect(html).toContain("Body");
  });

  it("renders a [!NOTE] blockquote as a styled callout with inner markdown", () => {
    const html = renderDocumentHtml(
      "> [!WARNING]\n> Be **careful** here.\n",
      "strict",
    );
    // Blockquote became a callout div (inline-styled for Paged.js), not a <blockquote>.
    expect(html).not.toContain("<blockquote");
    expect(html).toContain("border-left:4px solid #9a6700");
    // Title line with icon + label, no raw marker left in the body.
    expect(html).toContain("Warning");
    expect(html).not.toContain("[!WARNING]");
    // Inner markdown still parsed.
    expect(html).toContain("<strong>careful</strong>");
  });

  it("leaves an ordinary blockquote as a blockquote", () => {
    const html = renderDocumentHtml("> just a quote\n", "strict");
    expect(html).toContain("<blockquote");
    expect(html).not.toContain("border-left:4px solid");
  });

  it("renders GFM tables, strikethrough, and task lists", () => {
    const doc = "| a |\n|---|\n| 1 |\n\n~~gone~~\n\n- [x] done\n";
    const html = renderDocumentHtml(doc, "strict");
    expect(html).toContain("<table");
    expect(html).toContain("<s>gone</s>");
    expect(html).toContain('type="checkbox"');
    expect(html).toContain("checked");
  });

  it("carries GFM column alignment and inline borders into the table HTML", () => {
    const doc = "| a | b |\n| :--- | ---: |\n| 1 | 2 |\n";
    const html = renderDocumentHtml(doc, "strict");
    expect(html).toContain("text-align:left");
    expect(html).toContain("text-align:right");
    // Inline borders survive Paged.js (stylesheet borders get stripped).
    expect(html).toContain("border-collapse:collapse");
    expect(html).toMatch(/<td[^>]*border:0\.75pt/);
    expect(html).toMatch(/<th[^>]*background:#f3f3f1/);
  });

  it("print CSS makes tables fit the page and repeat headers", () => {
    const css = buildPrintCss(DEFAULT_PAGE_CONFIG, VARS);
    expect(css).toContain("table-header-group");
    expect(css).toContain("break-inside: avoid");
    expect(css).toContain("width: 100%");
  });

  it("print and standalone CSS lay out the reference list as pandoc does", () => {
    const css = buildPrintCss(DEFAULT_PAGE_CONFIG, VARS);
    expect(css).toContain(
      ".hanging-indent .csl-entry { padding-left: 2em; text-indent: -2em; }",
    );
    expect(css).toContain(".csl-left-margin { float: left;");
    const html = renderStandaloneHtml("# x\n", "strict", "T");
    expect(html).toContain(
      ".hanging-indent .csl-entry { padding-left: 2em; text-indent: -2em; }",
    );
  });

  it("renders sub/sup in enhanced mode only", () => {
    const doc = "H~2~O and 5^th^\n";
    expect(renderDocumentHtml(doc, "enhanced")).toContain("<sub>2</sub>");
    expect(renderDocumentHtml(doc, "enhanced")).toContain("<sup>th</sup>");
    expect(renderDocumentHtml(doc, "strict")).not.toContain("<sub>");
  });

  // GFM from other tools puts inline HTML and entities inside table cells.
  // The export has always handled these; these lock that in so it cannot drift
  // away from the live-view rendering in tablecell.ts.
  it("renders inline HTML and entities inside table cells", () => {
    const doc =
      "| | Sample A<br>(n=12) |\n" +
      "|---|:---:|\n" +
      "| &nbsp;&nbsp;Item one | <sub>x</sub><mark>m</mark> |\n";
    const html = renderDocumentHtml(doc, "enhanced");
    expect(html).toContain("Sample A<br>(n=12)");
    expect(html).toContain("<sub>x</sub><mark>m</mark>");
    // &nbsp; is decoded to the character, so the literal entity is gone.
    expect(html).toContain("  Item one");
    expect(html).not.toContain("&nbsp;&nbsp;Item one");
  });

  it("agrees with the live-view cell renderer on in-cell markup", () => {
    for (const raw of [
      "Sample A<br>(n=12)",
      "&nbsp;&nbsp;Item one",
      "A &amp; B &mdash; c",
      "<sub>x</sub><sup>2</sup> <u>u</u> <mark>m</mark>",
      "&#160;&#8202;deg &deg;C",
    ]) {
      const html = renderDocumentHtml(`| h |\n|---|\n| ${raw} |\n`, "enhanced");
      const cell = /<td[^>]*>([\s\S]*?)<\/td>/.exec(html)?.[1] ?? "";
      expect(cell).toBe(cellDisplayHtml(raw));
    }
  });

  it("syntax-highlights fenced code for a known language", () => {
    const doc = "```python\ndef f():\n    return 1\n```\n";
    const html = renderDocumentHtml(doc, "strict");
    expect(html).toContain('class="language-python"');
    // Tokens carry inline color (not a class) so they survive Paged.js.
    expect(html).toContain("color:#b0519f"); // keyword: def / return
    expect(html).not.toContain('class="hljs-');
  });

  it("renders footnote references and a footnotes section", () => {
    const html = renderDocumentHtml("text[^1]\n\n[^1]: the note\n", "strict");
    expect(html).toContain("footnote-ref");
    expect(html).toContain('class="footnotes');
  });

  it("renders LaTeX math as MathML (no CSS/font dependency)", () => {
    const html = renderDocumentHtml("energy $E=mc^2$ here\n", "strict");
    expect(html).toContain("<math");
    expect(html).toContain("</math>");
  });

  it("leaves an unknown/absent language as escaped plain code", () => {
    const doc = "```\nplain <tag> here\n```\n";
    const html = renderDocumentHtml(doc, "strict");
    expect(html).not.toContain("hljs-");
    expect(html).toContain("plain &lt;tag&gt; here");
  });

  it("renders a local image as alt text, an https image as <img> once enabled", () => {
    // A local reference is alt text unless the caller hands in its bytes (next
    // test): the .md holds a path, never bytes, and the renderer reads no files.
    const local = renderDocumentHtml("see ![a figure](x.png) here\n", "strict");
    expect(local).not.toContain("<img");
    expect(local).toContain("a figure");

    const remote = "![logo](https://x.com/l.png)\n";
    try {
      // Remote images are opt-in (see ./remoteimages). Blocked, the reference
      // degrades to the same alt text a local one produces — so rendering a
      // document issues no request until the reader asks for one.
      setRemoteImagesAllowed(false);
      const blocked = renderDocumentHtml(remote, "strict");
      expect(blocked).not.toContain("<img");
      expect(blocked).toContain("logo");

      setRemoteImagesAllowed(true);
      const url = renderDocumentHtml(remote, "strict");
      expect(url).toContain("<img");
      expect(url).toContain('src="https://x.com/l.png"');
    } finally {
      // Module-level state: leaving it on would silently change later tests.
      setRemoteImagesAllowed(false);
    }
  });

  it("renders an inline data: image as <img>, with no loader and remote images off", () => {
    // The bytes are in the .md, so there is nothing to load: the image must not
    // degrade to alt text the way an unloaded local reference does.
    const html = renderDocumentHtml(
      "![fig](data:image/png;base64,iVBORw0KGgo=)\n",
      "strict",
    );
    expect(html).toContain(
      '<img src="data:image/png;base64,iVBORw0KGgo=" alt="fig"',
    );
    // The image rule trusts markdown-it's validateLink to keep scriptable
    // data: types (SVG, HTML) from ever becoming an image token.
    const svg = renderDocumentHtml(
      "![x](data:image/svg+xml;base64,PHN2Zz4=)\n",
      "strict",
    );
    expect(svg).not.toContain("<img");
  });

  it("embeds a local image the caller has loaded, in markdown and raw HTML alike", () => {
    const images = new Map([
      ["x.png", "data:image/png;base64,AAAA"],
      ["figures/plot (1).png", "data:image/png;base64,BBBB"],
    ]);
    const doc = [
      "see ![a figure](x.png) here",
      "",
      '<img src="figures/plot (1).png" width="300">',
      "",
      'inline <img src="x.png" alt="x"> too, and ![missing](nope.png)',
      "",
    ].join("\n");
    const html = renderDocumentHtml(doc, "strict", false, images);
    expect(html).toContain(
      '<img src="data:image/png;base64,AAAA" alt="a figure"',
    );
    expect(html).toContain(
      '<img src="data:image/png;base64,BBBB" width="300">',
    );
    expect(html).toContain('<img src="data:image/png;base64,AAAA" alt="x">');
    // Not in the map: alt text, exactly as before.
    expect(html).not.toContain("nope.png");
    expect(html).toContain("missing");
  });

  it("async render: asks the loader once for every local reference as written, then embeds what comes back", async () => {
    const doc = [
      "![a](x.png) ![b](./figures/plot.png) ![a again](x.png) ![u](Bild_ö.png)",
      "![remote](https://x.com/l.png) ![inline](data:image/png;base64,AAAA)",
      '<img src="C:\\pics\\abs.png"> <img src="//cdn.test/p.png">',
      "",
      "<div><img src='quoted.png' alt='q'></div>",
      "",
      '<img src="Martin\'s plot.png" width="300">',
      "",
    ].join("\n");
    const asked: string[][] = [];
    const html = await renderDocumentHtmlAsync(
      doc,
      "strict",
      false,
      (sources) => {
        asked.push([...sources]);
        return Promise.resolve(
          new Map([
            ["x.png", "data:image/png;base64,XXXX"],
            ["quoted.png", "data:image/png;base64,QQQQ"],
            ["Martin's plot.png", "data:image/png;base64,PPPP"],
            // markdown-it reports the destination percent-encoded; the loader
            // (resolveLocalImagePath) decodes it, the key stays as reported.
            ["Bild_%C3%B6.png", "data:image/png;base64,UUUU"],
          ]),
        );
      },
    );
    expect(asked).toHaveLength(1);
    expect([...asked[0]].sort()).toEqual(
      [
        "./figures/plot.png",
        "Bild_%C3%B6.png",
        "C:\\pics\\abs.png",
        "Martin's plot.png",
        "quoted.png",
        "x.png",
      ].sort(),
    );
    expect(html).toContain('<img src="data:image/png;base64,XXXX" alt="a"');
    expect(html).toContain('<img src="data:image/png;base64,UUUU" alt="u"');
    expect(html).toContain("<img src='data:image/png;base64,QQQQ' alt='q'>");
    expect(html).toContain(
      '<img src="data:image/png;base64,PPPP" width="300">',
    );
    // Asked for but not returned: alt text, as before.
    expect(html).not.toContain("figures/plot.png");
    expect(html).toContain('alt="a"> b <img');
  });

  it("collects image sources from a run of unclosed <img in linear time", async () => {
    // `[^>]*?` before src rescanned to the end of the block from every
    // unclosed `<img`: 20,000 of them took 1.2 s on every pagination.
    const doc =
      // A `<` inside an earlier attribute value must not hide the src.
      `<div><img alt="a<b" src="y.png">\n${"<img ".repeat(50_000)}\n\n`;
    const asked: string[][] = [];
    const start = performance.now();
    await renderDocumentHtmlAsync(doc, "strict", false, (sources) => {
      asked.push([...sources]);
      return Promise.resolve(new Map());
    });
    expect(performance.now() - start).toBeLessThan(1000);
    expect(asked).toEqual([["y.png"]]);
  });

  it("strips a long line of unclosed comment blocks in linear time", () => {
    // A plain `.*?` rescanned the rest of the line from every unclosed
    // opener: 20,000 `<!--c:a {` took 1.6 s per render.
    const doc =
      'Text<!--c:a1 {"resolved":false,"thread":[]}-->\n\n' +
      "<!--c:a {<!--ml:page {<!--ml:meta {".repeat(20_000);
    const start = performance.now();
    const html = renderDocumentHtml(doc, "strict");
    expect(performance.now() - start).toBeLessThan(1000);
    expect(html.startsWith("<p>Text</p>")).toBe(true);
  });

  it("async render: does not call the loader for a document without local images", async () => {
    let calls = 0;
    const html = await renderDocumentHtmlAsync(
      "# Title\n\n![remote](https://x.com/l.png) and a [^1] note\n\n[^1]: Foot\n",
      "strict",
      false,
      () => {
        calls++;
        return Promise.resolve(new Map());
      },
    );
    expect(calls).toBe(0);
    // The parse/render split must keep plugin state (footnotes live on env).
    expect(html).toContain("footnote");
    expect(html).toContain("Foot");
  });

  it("keeps the image's written reference on the element only for page measurement", () => {
    const images = new Map([
      ["x.png", "data:image/png;base64,AAAA"],
      ['C:\\pics\\a "b".png', "data:image/png;base64,BBBB"],
    ]);
    const doc =
      '![a](x.png)\n\n<img src=\'C:\\pics\\a "b".png\' width="300">\n';
    // sourceLines = true is the editor's page measurement: the reference is
    // needed to map a page break that lands on the image back to its line.
    const measured = renderDocumentHtml(doc, "strict", true, images);
    expect(measured).toContain(
      '<img src="data:image/png;base64,AAAA" alt="a" data-ml-src="x.png">',
    );
    expect(measured).toContain(
      '<img src=\'data:image/png;base64,BBBB\' data-ml-src="C:\\pics\\a &quot;b&quot;.png" width="300">',
    );
    // An export (sourceLines = false) must not carry a local path: a shared
    // .html would otherwise name the author's user folder.
    const exported = renderDocumentHtml(doc, "strict", false, images);
    expect(exported).not.toContain("data-ml-src");
    expect(exported).toContain(
      '<img src="data:image/png;base64,AAAA" alt="a">',
    );
  });

  it("keeps CriticMarkup as literal text (dumb-viewer parity)", () => {
    const html = renderDocumentHtml("a {++new++} b\n", "strict");
    expect(html).toContain("{++new++}");
  });
});

describe("buildPrintCss", () => {
  it("emits the page box and margin boxes", () => {
    const css = buildPrintCss(
      {
        size: "Letter",
        margin: "18mm",
        font: "source-serif-4",
        header: "{title}",
        footer: "{page}",
        justify: false,
      },
      VARS,
    );
    expect(css).toContain("size: Letter;");
    expect(css).toContain("margin: 18mm;");
    expect(css).toContain('@top-center { content: "Report";');
    expect(css).toContain("@bottom-center { content: counter(page);");
  });

  it("omits empty margin boxes", () => {
    const css = buildPrintCss(
      {
        size: "A4",
        margin: "20mm",
        font: "source-serif-4",
        header: "",
        footer: "",
        justify: false,
      },
      VARS,
    );
    expect(css).not.toContain("@top-center");
    expect(css).not.toContain("@bottom-center");
  });

  it("caps images to the page body height, from Paged.js's own geometry", () => {
    // An image cannot be fragmented; without this a tall photo is clipped at
    // the page edge in the PDF and undercounted in the editor's page count.
    const css = buildPrintCss(DEFAULT_PAGE_CONFIG, VARS, ".ml-measure");
    const rule = /\.ml-measure img \{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(rule).toContain(
      "max-height: calc(var(--pagedjs-height) - var(--pagedjs-margin-top) - var(--pagedjs-margin-bottom)",
    );
    expect(rule).toContain("max-width: 100%");
    expect(rule).toContain("object-fit: contain");
    expect(rule).toContain("break-inside: avoid");
  });

  it("justify config emits justified paragraphs", () => {
    const on = buildPrintCss(
      {
        size: "A4",
        margin: "20mm",
        font: "source-serif-4",
        header: "",
        footer: "",
        justify: true,
      },
      VARS,
    );
    expect(on).toContain("p { text-align: justify; }");
    const off = buildPrintCss(
      {
        size: "A4",
        margin: "20mm",
        font: "source-serif-4",
        header: "",
        footer: "",
        justify: false,
      },
      VARS,
    );
    expect(off).not.toContain("p { text-align: justify; }");
  });

  it("align attribute blocks pass through with safety CSS", () => {
    const html = renderDocumentHtml(
      '<div align="center">\n\ncentered text\n\n</div>\n',
      "strict",
    );
    expect(html).toContain('<div align="center">');
    expect(html).toContain("<p>centered text</p>");
    const css = buildPrintCss(DEFAULT_PAGE_CONFIG, VARS);
    expect(css).toContain('[align="center"] { text-align: center; }');
  });

  it("a hostile page-setup margin reaches the stylesheet as nothing", () => {
    // Opening this document is enough: schedulePagination builds the same CSS
    // ~300ms later, with no user interaction and no Export.
    const doc =
      '<!--ml:page {"size":"A4","margin":"15mm } #print-root p { color: transparent } ' +
      'body { background-image: url(https://tracker.test/beacon.png) } @page { margin: 15mm",' +
      '"header":"","footer":"","justify":false}-->';
    const css = buildPrintCss(parsePageConfig(doc), VARS);
    expect(css).not.toContain("url(");
    expect(css).not.toContain("tracker.test");
    expect(css).not.toContain("color: transparent");
    // Well formed: the @page block holds no braces beyond its own.
    const block = /@page \{[^{}]*\}/.exec(css);
    expect(block).not.toBeNull();
    expect(block![0]).toContain("size: A4;");
    expect(block![0]).toContain(`margin: ${DEFAULT_PAGE_CONFIG.margin};`);
  });

  it("the page-break rule is unscoped so Paged.js's break scan matches it", () => {
    const css = buildPrintCss(DEFAULT_PAGE_CONFIG, VARS, ".ml-print");
    // Must be a bare .ml-pagebreak selector — Paged.js queries the source
    // content (not yet under .ml-print) when stamping forced breaks.
    expect(css).toContain(".ml-pagebreak { display: block");
    expect(css).not.toContain(".ml-print .ml-pagebreak");
    expect(css).toContain("break-after: page");
  });

  it("scopes with a class, not an ID Paged.js would rewrite and orphan", () => {
    // Sheet.parse() (Paged.js) rewrites every ID selector into
    // `[data-id="…"]`, a value only ever stamped on cloned content nodes —
    // never on the render-target element. An ID-scoped root would silently
    // match nothing in the paginated output. Guard the default stays a class.
    const css = buildPrintCss(DEFAULT_PAGE_CONFIG, VARS);
    expect(css).toContain(".ml-print {");
    expect(css).not.toContain("#print-root");
  });

  it("uses the document's chosen font and the bundled mono stack", () => {
    const css = buildPrintCss({ ...DEFAULT_PAGE_CONFIG, font: "lora" }, VARS);
    expect(css).toContain('font-family: "Lora Variable", Georgia');
    expect(css).toContain(MONO_STACK);
  });

  it("a font id outside the bundled allowlist falls back to the default rather than reaching the stylesheet", () => {
    const doc =
      '<!--ml:page {"font":"body { background-image: url(x) } p { color: transparent"}-->';
    const cfg = parsePageConfig(doc);
    expect(cfg.font).toBe(DEFAULT_FONT_ID);
    const css = buildPrintCss(cfg, VARS);
    expect(css).not.toContain("url(");
    expect(css).not.toContain("color: transparent");
    expect(css).toContain(fontStack(DEFAULT_FONT_ID));
  });
});

describe("the exported HTML shell carries its own CSP", () => {
  // The exported file is opened in a full browser, which applies none of the
  // app's restrictions — so a sanitizer gap in the app becomes an unbacked gap
  // in every file the user shares. The meta CSP is that backstop.
  const cspOf = (html: string): string => {
    const m =
      /<meta http-equiv="Content-Security-Policy" content="([^"]*)">/.exec(
        html,
      );
    return m === null ? "" : m[1];
  };

  it("defaults to the safer policy when the caller says nothing", () => {
    const csp = cspOf(wrapStandaloneHtml("<p>x</p>", "Doc"));
    expect(csp).not.toBe("");
    expect(csp).toContain("img-src data:");
    expect(csp).not.toContain("https:");
    // Nothing in a standalone export should ever execute.
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'none'");
  });

  it("mirrors the remote-images setting when it is on", () => {
    const csp = cspOf(wrapStandaloneHtml("<p>x</p>", "Doc", true));
    expect(csp).toContain("img-src data: https:");
    expect(csp).toContain("script-src 'none'");
  });

  it("keeps inline styles working — the export depends on them", () => {
    // Table borders, callout boxes and code colours are all inline styles.
    const csp = cspOf(wrapStandaloneHtml("<p>x</p>", "Doc"));
    expect(csp).toContain("style-src 'unsafe-inline'");
  });

  it("declares the policy before any content it governs", () => {
    const html = wrapStandaloneHtml(
      '<img src="data:image/gif;base64,AA">',
      "D",
    );
    const at = html.indexOf("Content-Security-Policy");
    expect(at).toBeGreaterThan(-1); // else the comparison below is vacuous
    expect(at).toBeLessThan(html.indexOf("<body>"));
  });

  it("renderStandaloneHtml passes the setting through", () => {
    expect(cspOf(renderStandaloneHtml("# x\n", "strict", "T"))).toContain(
      "img-src data:",
    );
    expect(cspOf(renderStandaloneHtml("# x\n", "strict", "T", true))).toContain(
      "img-src data: https:",
    );
  });
});

describe("renderStandaloneHtml (self-contained HTML export)", () => {
  it("wraps the rendered body in a full HTML document with the title", () => {
    const html = renderStandaloneHtml("# Hello\n\ntext", "strict", "My Report");
    expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
    expect(html).toContain("<title>My Report</title>");
    expect(html).toContain("<h1>Hello</h1>");
    expect(html).toContain("</html>");
  });

  it("is self-contained: inline <style>, no external css/js/font", () => {
    const html = renderStandaloneHtml("text", "strict", "t");
    expect(html).toContain("<style>");
    expect(html).not.toContain("<link");
    expect(html).not.toContain("<script");
    expect(html).not.toMatch(/@import|href="https?:/);
  });

  it("carries inline-styled features (callouts, code) into the file", () => {
    const html = renderStandaloneHtml(
      "> [!NOTE]\n> hi\n\n```python\nx=1\n```\n",
      "strict",
      "t",
    );
    expect(html).toContain("border-left:4px solid #0969da"); // callout inline style
    expect(html).toContain("color:#"); // highlighted code inline colour
  });

  it("escapes the title", () => {
    const html = renderStandaloneHtml("x", "strict", "a <b> & c");
    expect(html).toContain("<title>a &lt;b&gt; &amp; c</title>");
  });

  it("requests the chosen document font by name even with nothing embedded", () => {
    const html = renderStandaloneHtml("x", "strict", "t", false, "lora");
    expect(html).toContain(fontStack("lora"));
  });

  it("embeds a validated font face as a base64 data URI, never a network URL", () => {
    const html = renderStandaloneHtml("x", "strict", "t", false, "lora", [
      {
        family: "Lora Variable",
        italic: false,
        weight: "400 700",
        base64: "AAA=",
      },
    ]);
    expect(html).toContain('@font-face {\n  font-family: "Lora Variable";');
    expect(html).toContain("font-weight: 400 700;");
    expect(html).toContain("src: url(data:font/woff2;base64,AAA=)");
    expect(html).not.toMatch(/url\(https?:/);
  });

  it("drops an embedded face with a family, weight or payload outside the known allowlist", () => {
    const html = renderStandaloneHtml("x", "strict", "t", false, "lora", [
      {
        family: 'Evil"; } body { background: url(x) } .x {',
        italic: false,
        weight: "400 700",
        base64: "AAA=",
      },
      {
        family: "Lora Variable",
        italic: false,
        weight: "400 700",
        base64: "not base64!",
      },
      {
        family: "Lora Variable",
        italic: false,
        weight: "400; } .x { color: red",
        base64: "AAA=",
      },
    ]);
    expect(html).not.toContain("Evil");
    expect(html).not.toContain("not base64!");
    expect(html).not.toContain("color: red");
    expect(html).not.toContain("@font-face");
  });
});
