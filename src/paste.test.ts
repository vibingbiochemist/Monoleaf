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

  it("does not mistake Word's tab-separated plain-text list markers for markdown", () => {
    // Word's plain-text clipboard flavor writes list items as "•\titem" /
    // "1.\titem" — a literal tab, which a human typing markdown never uses.
    // Misfiring here means the (genuinely rich) HTML flavor never gets
    // converted at all.
    expect(looksLikeMarkdown("1.\t1915: General relativity")).toBe(false);
    expect(looksLikeMarkdown("•\tThe photoelectric effect")).toBe(false);
    // A real space still counts.
    expect(looksLikeMarkdown("1. General relativity")).toBe(true);
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

  it("doesn't leak <style>/<xml> content reconstituted by splitting the tag across removed text", () => {
    // A regex that removes "<style ...>...</style>" as one literal span in a
    // single pass can be defeated: split the delimiter so the leftover
    // prefix/suffix concatenate into a NEW, well-formed tag around
    // attacker-chosen text that a later `</style>` (never part of the
    // removed match) legitimately closes.
    //   "<sty" + "<style>x</style>" + "le>PAYLOAD</style>"
    // The middle block is the only match in a single global pass, so it
    // alone gets removed, leaving "<sty" + "le>PAYLOAD</style>" =
    // "<style>PAYLOAD</style>" — a clean element whose text content
    // (PAYLOAD) then survives verbatim into the output. Handling
    // style/xml removal on turndown's parsed tree (see service()) instead
    // of via regex closes this: the tag is dropped by its real, parsed
    // identity, not reconstructed from adjacent decoy fragments.
    expect(
      htmlToMarkdown("<p><sty<style>x</style>le>PAYLOAD</style></p>"),
    ).not.toBe("PAYLOAD");
    expect(htmlToMarkdown("<p><x<xml>x</xml>ml>PAYLOAD</xml></p>")).not.toBe(
      "PAYLOAD",
    );
  });

  it("collapses blank-line pileups", () => {
    const md = htmlToMarkdown("<div><div><p>a</p></div></div><p>b</p>");
    expect(md).toBe("a\n\nb");
  });

  // Captured verbatim from a real Word 15 clipboard paste (via the
  // monoleaf-paste-debug.html dump), trimmed of the ~700 lines of unrelated
  // <w:LsdException> style-registry noise. Keeps both conditional-comment
  // forms Word emits: the downlevel-hidden <!--[if gte mso 9]>...<![endif]-->
  // wrapping the XML payload, and the downlevel-revealed <![if
  // !supportLists]>...<![endif]> (no <!--/--> wrapper) wrapping each fake
  // list item's throwaway marker span.
  const WORD_PASTE_HTML = `<html xmlns:o="urn:schemas-microsoft-com:office:office"
xmlns:w="urn:schemas-microsoft-com:office:word"
xmlns="http://www.w3.org/TR/REC-html40">
<head>
<meta http-equiv=Content-Type content="text/html; charset=utf-8">
<meta name=ProgId content=Word.Document>
<!--[if gte mso 9]><xml>
 <w:WordDocument>
  <w:View>Normal</w:View>
  <w:Zoom>0</w:Zoom>
 </w:WordDocument>
</xml><![endif]-->
<style>
<!--
 p.MsoNormal, li.MsoNormal, div.MsoNormal
	{margin:0in;
	font-size:10.0pt;
	font-family:"Times New Roman",serif;}
p.MsoListParagraph, li.MsoListParagraph, div.MsoListParagraph
	{margin:0in;
	font-size:10.0pt;
	font-family:"Times New Roman",serif;}
-->
</style>
</head>
<body lang=EN-US style='tab-interval:.5in;word-wrap:break-word'>
<!--StartFragment-->

<h1>Albert Einstein<o:p></o:p></h1>

<p class=MsoNormal>Albert Einstein (1879–1955) was a <b>German-born theoretical
physicist</b> widely regarded as one of the most influential scientists of the
twentieth century. He is best known for developing the <i>theory of relativity</i>,
one of the two pillars of modern physics alongside quantum mechanics.<o:p></o:p></p>

<h2>The Annus Mirabilis papers<o:p></o:p></h2>

<p class=MsoNormal>In 1905, often called his &quot;miracle year,&quot; Einstein
published four papers that transformed physics:<o:p></o:p></p>

<p class=MsoListParagraph style='margin-left:.5in;text-indent:-.25in;
mso-list:l1 level1 lfo1'><![if !supportLists]><span style='mso-list:Ignore'>•<span
style='font:7.0pt "Times New Roman"'>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;
</span></span><![endif]>The photoelectric effect, explaining light as discrete
quanta of energy<o:p></o:p></p>

<p class=MsoListParagraph style='margin-left:.5in;text-indent:-.25in;
mso-list:l1 level1 lfo1'><![if !supportLists]><span style='mso-list:Ignore'>•<span
style='font:7.0pt "Times New Roman"'>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;
</span></span><![endif]>Brownian motion, providing strong evidence for the
existence of atoms<o:p></o:p></p>

<p class=MsoListParagraph style='margin-left:.5in;text-indent:-.25in;
mso-list:l1 level1 lfo1'><![if !supportLists]><span style='mso-list:Ignore'>•<span
style='font:7.0pt "Times New Roman"'>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;
</span></span><![endif]>Special relativity, redefining space and time for
objects in relative motion<o:p></o:p></p>

<p class=MsoListParagraph style='margin-left:.5in;text-indent:-.25in;
mso-list:l1 level1 lfo1'><![if !supportLists]><span style='mso-list:Ignore'>•<span
style='font:7.0pt "Times New Roman"'>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;
</span></span><![endif]>Mass–energy equivalence, expressed in the equation E =
mc²<o:p></o:p></p>

<h2>Later career<o:p></o:p></h2>

<p class=MsoNormal>Key milestones after 1905 include:<o:p></o:p></p>

<p class=MsoListParagraph style='margin-left:.5in;text-indent:-.25in;
mso-list:l0 level1 lfo2'><![if !supportLists]><span style='mso-list:Ignore'>1.<span
style='font:7.0pt "Times New Roman"'>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; </span></span><![endif]>1915:
Publication of the general theory of relativity<o:p></o:p></p>

<p class=MsoListParagraph style='margin-left:.5in;text-indent:-.25in;
mso-list:l0 level1 lfo2'><![if !supportLists]><span style='mso-list:Ignore'>2.<span
style='font:7.0pt "Times New Roman"'>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; </span></span><![endif]>1919:
Solar eclipse observations by Eddington confirm light bending predicted by
general relativity<o:p></o:p></p>

<p class=MsoListParagraph style='margin-left:.5in;text-indent:-.25in;
mso-list:l0 level1 lfo2'><![if !supportLists]><span style='mso-list:Ignore'>3.<span
style='font:7.0pt "Times New Roman"'>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; </span></span><![endif]>1921:
Awarded the Nobel Prize in Physics for the photoelectric effect<o:p></o:p></p>

<p class=MsoListParagraph style='margin-left:.5in;text-indent:-.25in;
mso-list:l0 level1 lfo2'><![if !supportLists]><span style='mso-list:Ignore'>4.<span
style='font:7.0pt "Times New Roman"'>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; </span></span><![endif]>1933:
Emigrates to the United States, joining the Institute for Advanced Study in
Princeton<o:p></o:p></p>

<h2>Further reading<o:p></o:p></h2>

<p class=MsoNormal>Nobel Prize biography: <a
href="https://www.nobelprize.org/prizes/physics/1921/einstein/biographical/">nobelprize.org/prizes/physics/1921/einstein</a><o:p></o:p></p>

<h2>Key dates at a glance<o:p></o:p></h2>

<table class=MsoNormalTable border=1 cellspacing=0 cellpadding=0 width=632
 style='width:474.0pt;border-collapse:collapse;border:none'>
 <tr style='mso-yfti-irow:0;mso-yfti-firstrow:yes'>
  <td width=160 valign=top style='width:120.0pt;border:solid windowtext 1.0pt;
  background:#D9E2F3'>
  <p class=MsoNormal><b><span style='color:black'>Year</span></b><o:p></o:p></p>
  </td>
  <td width=472 valign=top style='width:354.0pt;border:solid windowtext 1.0pt;
  background:#D9E2F3'>
  <p class=MsoNormal><b><span style='color:black'>Event</span></b><o:p></o:p></p>
  </td>
 </tr>
 <tr style='mso-yfti-irow:1'>
  <td width=160 valign=top style='border:solid windowtext 1.0pt'>
  <p class=MsoNormal>1879<o:p></o:p></p>
  </td>
  <td width=472 valign=top style='border:solid windowtext 1.0pt'>
  <p class=MsoNormal>Born in Ulm, Germany<o:p></o:p></p>
  </td>
 </tr>
</table>

<p class=MsoNormal><o:p>&nbsp;</o:p></p>

<!--EndFragment-->
</body>

</html>`;

  describe("Word fake lists (MsoListParagraph)", () => {
    const md = htmlToMarkdown(WORD_PASTE_HTML);

    it("converts the bullet list to a real GFM unordered list", () => {
      expect(md).toContain(
        "- The photoelectric effect, explaining light as discrete quanta of energy\n" +
          "- Brownian motion, providing strong evidence for the existence of atoms\n" +
          "- Special relativity, redefining space and time for objects in relative motion\n" +
          "- Mass–energy equivalence, expressed in the equation E = mc²",
      );
    });

    it("converts the numbered list to a real GFM ordered list", () => {
      expect(md).toContain(
        "1. 1915: Publication of the general theory of relativity\n" +
          "2. 1919: Solar eclipse observations by Eddington confirm light bending predicted by general relativity\n" +
          "3. 1921: Awarded the Nobel Prize in Physics for the photoelectric effect\n" +
          "4. 1933: Emigrates to the United States, joining the Institute for Advanced Study in Princeton",
      );
    });

    it("leaves no MsoListParagraph/marker debris behind", () => {
      expect(md).not.toContain("MsoListParagraph");
      expect(md).not.toContain("mso-list");
      expect(md).not.toContain("supportLists");
    });

    it("still converts headings, bold/italic, the link, and the table unchanged", () => {
      expect(md).toContain("# Albert Einstein");
      expect(md).toContain("## The Annus Mirabilis papers");
      expect(md).toContain("**German-born theoretical physicist**");
      expect(md).toContain("*theory of relativity*");
      expect(md).toContain(
        "[nobelprize.org/prizes/physics/1921/einstein](https://www.nobelprize.org/prizes/physics/1921/einstein/biographical/)",
      );
      expect(md).toContain("| **Year** | **Event** |");
      expect(md).toContain("| --- | --- |");
      expect(md).toContain("| 1879 | Born in Ulm, Germany |");
    });

    it("converts a list item that also carries paragraph alignment", () => {
      // Word applies alignment independently of list membership; a justified
      // or centered list item must still become a real list item, not get
      // caught by the alignment rule and wrapped in a <div align> block.
      const justified = `
        <p class=MsoListParagraph style='text-align:justify;margin-left:.5in;text-indent:-.25in;mso-list:l1 level1 lfo1'><![if !supportLists]><span style='mso-list:Ignore'>&#8226;<span style='font:7.0pt "Times New Roman"'>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;</span></span><![endif]>First item<o:p></o:p></p>
        <p class=MsoListParagraph style='text-align:justify;margin-left:.5in;text-indent:-.25in;mso-list:l1 level1 lfo1'><![if !supportLists]><span style='mso-list:Ignore'>&#8226;<span style='font:7.0pt "Times New Roman"'>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;</span></span><![endif]>Second item<o:p></o:p></p>`;
      expect(htmlToMarkdown(justified)).toBe("- First item\n- Second item");
      // A genuinely non-list justified paragraph is unaffected.
      expect(
        htmlToMarkdown('<p style="text-align:justify">Just a paragraph.</p>'),
      ).toBe('<div align="justify">\n\nJust a paragraph.\n\n</div>');
    });

    it("converts Word's CxSpFirst/CxSpMiddle/CxSpLast continuation classes", () => {
      // Word glues these directly onto the class name (no separator) for
      // consecutive list paragraphs it treats as "connected" — a paragraph-
      // spacing optimization unrelated to list structure.
      const cxsp = `
        <p class=MsoListParagraphCxSpFirst style='margin-left:.5in;text-indent:-.25in;mso-list:l1 level1 lfo1'><![if !supportLists]><span style='mso-list:Ignore'>&#8226;<span style='font:7.0pt "Times New Roman"'>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;</span></span><![endif]>First item<o:p></o:p></p>
        <p class=MsoListParagraphCxSpMiddle style='margin-left:.5in;text-indent:-.25in;mso-list:l1 level1 lfo1'><![if !supportLists]><span style='mso-list:Ignore'>&#8226;<span style='font:7.0pt "Times New Roman"'>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;</span></span><![endif]>Second item<o:p></o:p></p>
        <p class=MsoListParagraphCxSpLast style='margin-left:.5in;text-indent:-.25in;mso-list:l1 level1 lfo1'><![if !supportLists]><span style='mso-list:Ignore'>&#8226;<span style='font:7.0pt "Times New Roman"'>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;</span></span><![endif]>Third item<o:p></o:p></p>`;
      expect(htmlToMarkdown(cxsp)).toBe(
        "- First item\n- Second item\n- Third item",
      );
    });

    it("KNOWN LIMITATION: a nested sub-item resets the parent level's ordinal", () => {
      // Documented at msoListSibling: adjacency requires an exact level
      // match, so a level-2 item between two level-1 items breaks the
      // level-1 run — the second "1." should read "2.". Pinned here so a
      // future fix (or regression) shows up as an intentional test change,
      // not a silent behavior drift.
      const nested = `
        <p class=MsoListParagraph style='margin-left:.5in;text-indent:-.25in;mso-list:l0 level1 lfo1'><![if !supportLists]><span style='mso-list:Ignore'>1.<span style='font:7.0pt "Times New Roman"'>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;</span></span><![endif]>Top item one<o:p></o:p></p>
        <p class=MsoListParagraph style='margin-left:1in;text-indent:-.25in;mso-list:l0 level2 lfo1'><![if !supportLists]><span style='mso-list:Ignore'>a.<span style='font:7.0pt "Times New Roman"'>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;</span></span><![endif]>Sub item<o:p></o:p></p>
        <p class=MsoListParagraph style='margin-left:.5in;text-indent:-.25in;mso-list:l0 level1 lfo1'><![if !supportLists]><span style='mso-list:Ignore'>2.<span style='font:7.0pt "Times New Roman"'>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;</span></span><![endif]>Top item two<o:p></o:p></p>`;
      expect(htmlToMarkdown(nested)).toBe(
        "1. Top item one\n\n  1. Sub item\n\n1. Top item two",
      );
    });
  });
});
