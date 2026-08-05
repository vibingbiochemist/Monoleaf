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
  renderStandaloneHtml,
  setPageConfigSpec,
  wrapStandaloneHtml,
} from "./export";
import { createDocumentState, serializeDocument } from "./document";
import { cellDisplayHtml } from "./tablecell";
import { setRemoteImagesAllowed } from "./remoteimages";

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
    // A local reference is always alt text: the .md holds a path, never bytes.
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
      { size: "A4", margin: "20mm", header: "", footer: "", justify: false },
      VARS,
    );
    expect(css).not.toContain("@top-center");
    expect(css).not.toContain("@bottom-center");
  });

  it("justify config emits justified paragraphs", () => {
    const on = buildPrintCss(
      { size: "A4", margin: "20mm", header: "", footer: "", justify: true },
      VARS,
    );
    expect(on).toContain("p { text-align: justify; }");
    const off = buildPrintCss(
      { size: "A4", margin: "20mm", header: "", footer: "", justify: false },
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
    const css = buildPrintCss(DEFAULT_PAGE_CONFIG, VARS, "#print-root");
    // Must be a bare .ml-pagebreak selector — Paged.js queries the source
    // content (not yet under #print-root) when stamping forced breaks.
    expect(css).toContain(".ml-pagebreak { display: block");
    expect(css).not.toContain("#print-root .ml-pagebreak");
    expect(css).toContain("break-after: page");
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
});
