import { describe, expect, it } from "vitest";
import {
  htmlHasRichFormatting,
  htmlToMarkdown,
  looksLikeMarkdown,
  tsvToMarkdownTable,
} from "./paste";
import { parseTableText } from "./table";

describe("looksLikeMarkdown (paste raw markdown verbatim)", () => {
  it("recognises markdown source markers", () => {
    expect(looksLikeMarkdown("#### Focus")).toBe(true);
    expect(looksLikeMarkdown("Intro\n\n- item one\n- item two")).toBe(true);
    expect(looksLikeMarkdown("1. first\n2. second")).toBe(true);
    expect(looksLikeMarkdown("> a quote")).toBe(true);
    expect(looksLikeMarkdown("some **bold** text")).toBe(true);
    expect(looksLikeMarkdown("see [tracerDB](https://tracerdb.org)")).toBe(
      true,
    );
    expect(looksLikeMarkdown("```\ncode\n```")).toBe(true);
    expect(looksLikeMarkdown("use the `grep` tool")).toBe(true);
  });

  it("does not misfire on ordinary prose", () => {
    expect(looksLikeMarkdown("Just a normal sentence.")).toBe(false);
    expect(
      looksLikeMarkdown("Two lines of prose.\nNo markdown syntax here."),
    ).toBe(false);
    // Rich content copied from Word: plain-text flavor is stripped prose.
    expect(
      looksLikeMarkdown("Focus\nCellular target engagement\nBackground"),
    ).toBe(false);
  });

  it("matches a heading even when it is not the first line", () => {
    expect(looksLikeMarkdown("Some intro text\n#### Background\nmore")).toBe(
      true,
    );
  });
});

describe("htmlHasRichFormatting (markdown-source vs rich paste)", () => {
  it("treats markdown source wrapped in bare div/br as NOT rich", () => {
    // What a browser puts on the clipboard when you copy markdown source text.
    const wrapped =
      '<meta charset="utf-8"><div>#### Focus</div><div><br></div>' +
      "<div>- item one</div><div>**PhD** — Chemical Biology</div>";
    expect(htmlHasRichFormatting(wrapped)).toBe(false);
  });

  it("treats a plain paragraph of prose as NOT rich", () => {
    expect(htmlHasRichFormatting("<p>Just some plain prose here.</p>")).toBe(
      false,
    );
  });

  it("recognises headings, lists, bold, links, and tables as rich", () => {
    expect(htmlHasRichFormatting("<h4>Focus</h4>")).toBe(true);
    expect(htmlHasRichFormatting("<ul><li>a</li></ul>")).toBe(true);
    expect(htmlHasRichFormatting("<p><strong>bold</strong></p>")).toBe(true);
    expect(htmlHasRichFormatting('<a href="x">link</a>')).toBe(true);
    expect(htmlHasRichFormatting("<table><tr><td>a</td></tr></table>")).toBe(
      true,
    );
  });

  it("does not escape markdown source that is pasted as plain text", () => {
    // Guard against the regression: wrapper-only HTML must be left to the plain
    // paste, because turndown would escape it into non-rendering `\#### Focus`.
    const wrapped = "<div>#### Focus</div><div>- item</div>";
    expect(htmlHasRichFormatting(wrapped)).toBe(false);
    // If it HAD been converted, this is the broken output we are avoiding:
    expect(htmlToMarkdown(wrapped)).toContain("\\#");
  });
});

describe("tsvToMarkdownTable (Excel / Sheets paste)", () => {
  it("converts a tab-separated grid to a GFM table, first row header", () => {
    const tsv = "Parameter\t60°C\t58.6°C\nTop\t39.58\t40.22\nEC50\t0.54\t0.22";
    const md = tsvToMarkdownTable(tsv)!;
    expect(md).toBe(
      "| Parameter | 60°C | 58.6°C |\n| --- | --- | --- |\n| Top | 39.58 | 40.22 |\n| EC50 | 0.54 | 0.22 |",
    );
    // It must be a table our own parser accepts.
    expect(parseTableText(md)!.header).toEqual(["Parameter", "60°C", "58.6°C"]);
  });

  it("escapes pipes inside cells", () => {
    expect(tsvToMarkdownTable("a\tb\nx|y\tz")).toContain("x\\|y");
  });

  it("handles CRLF and a trailing newline", () => {
    const md = tsvToMarkdownTable("a\tb\r\n1\t2\r\n")!;
    expect(md).toContain("| 1 | 2 |");
  });

  it("returns null for non-tabular text (no tabs)", () => {
    expect(tsvToMarkdownTable("just a sentence\nsecond line")).toBeNull();
  });

  it("returns null for a single cell / single line", () => {
    expect(tsvToMarkdownTable("only one line\twith tab")).toBeNull();
    expect(tsvToMarkdownTable("noheader")).toBeNull();
  });
});

describe("htmlToMarkdown (paste with formatting)", () => {
  it("converts basic inline formatting", () => {
    expect(htmlToMarkdown("<p><b>bold</b> and <i>italic</i></p>")).toBe(
      "**bold** and *italic*",
    );
  });

  it("converts headings and lists", () => {
    const md = htmlToMarkdown(
      "<h2>Head</h2><ul><li>one</li><li>two</li></ul><ol><li>first</li></ol>",
    );
    expect(md).toContain("## Head");
    expect(md).toContain("- one");
    expect(md).toContain("1. first");
  });

  it("converts links and strikethrough", () => {
    const md = htmlToMarkdown(
      '<p><a href="https://e.com">go</a> <del>gone</del></p>',
    );
    expect(md).toContain("[go](https://e.com)");
    expect(md).toContain("~~gone~~");
  });

  it("converts tables via GFM", () => {
    const md = htmlToMarkdown(
      "<table><tr><th>a</th><th>b</th></tr><tr><td>1</td><td>2</td></tr></table>",
    );
    expect(md).toContain("| a | b |");
    expect(md).toContain("| --- | --- |");
    expect(md).toContain("| 1 | 2 |");
  });

  it("converts a Word table (bold <td> header, no <thead>) to GFM", () => {
    // Word's clipboard shape: no <th>/<thead>; header cells are <td> with a
    // MsoNormal paragraph and a bold span. The gfm plugin alone keeps this as
    // raw HTML — our rule must turn it into a proper GFM table.
    const word = `<table class="MsoNormalTable" border="1">
      <tbody>
        <tr><td><p class="MsoNormal"><b><span>Column A</span></b></p></td>
            <td><p class="MsoNormal"><b><span>Column B</span></b></p></td></tr>
        <tr><td><p class="MsoNormal">Row 1, A</p></td>
            <td><p class="MsoNormal">Row 1, B</p></td></tr>
        <tr><td><p class="MsoNormal">Row 2, A</p></td>
            <td><p class="MsoNormal">Row 2, B</p></td></tr>
      </tbody>
    </table>`;
    const md = htmlToMarkdown(word);
    expect(md).not.toContain("<table");
    expect(md).not.toContain("MsoNormal");
    expect(md).toContain("| **Column A** | **Column B** |");
    expect(md).toContain("| --- | --- |");
    expect(md).toContain("| Row 1, A | Row 1, B |");
    expect(md).toContain("| Row 2, A | Row 2, B |");
    // The result must be a table our own parser round-trips.
    expect(parseTableText(md.trim())!.header).toEqual([
      "**Column A**",
      "**Column B**",
    ]);
  });

  it("carries cell alignment into the GFM separator row", () => {
    const md = htmlToMarkdown(
      '<table><tr><td style="text-align:center">a</td>' +
        '<td style="text-align:right">b</td></tr>' +
        "<tr><td>1</td><td>2</td></tr></table>",
    );
    expect(md).toContain("| :---: | ---: |");
  });

  it("keeps underline and highlight as house inline HTML", () => {
    const md = htmlToMarkdown("<p><u>under</u> and <mark>hot</mark></p>");
    expect(md).toContain("<u>under</u>");
    expect(md).toContain("<mark>hot</mark>");
  });

  it("converts sub/sup to enhanced markdown syntax", () => {
    expect(htmlToMarkdown("<p>H<sub>2</sub>O to the 5<sup>th</sup></p>")).toBe(
      "H~2~O to the 5^th^",
    );
  });

  it("turns <br> into a backslash hard break", () => {
    expect(htmlToMarkdown("<p>line one<br>line two</p>")).toBe(
      "line one\\\nline two",
    );
  });

  it("drops images to their alt text (single-file principle)", () => {
    expect(
      htmlToMarkdown('<p>see <img src="x.png" alt="figure 1"> here</p>'),
    ).toBe("see figure 1 here");
  });

  it("maps aligned paragraphs to div align blocks", () => {
    const md = htmlToMarkdown('<p style="text-align:center">middle</p>');
    expect(md).toBe('<div align="center">\n\nmiddle\n\n</div>');
  });

  it("strips Word clipboard scaffolding", () => {
    const wordHtml = `
      <html><head><style>p.MsoNormal{margin:0}</style></head><body>
      <!--[if gte mso 9]><xml><w:WordDocument></w:WordDocument></xml><![endif]-->
      <p class="MsoNormal">Hello <b>Word</b><o:p></o:p></p>
      </body></html>`;
    expect(htmlToMarkdown(wordHtml)).toBe("Hello **Word**");
  });

  it("collapses blank-line pileups", () => {
    const md = htmlToMarkdown("<div><div><p>a</p></div></div><p>b</p>");
    expect(md).toBe("a\n\nb");
  });
});
