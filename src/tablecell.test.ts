import { describe, expect, it } from "vitest";
import {
  cellDisplayHtml,
  cellDisplayText,
  cellHasRichContent,
  decodeEntities,
} from "./tablecell";

describe("inline HTML in table cells", () => {
  it("renders <br> — the reported header case", () => {
    expect(cellDisplayHtml("Sample A<br>(n=12)")).toBe("Sample A<br>(n=12)");
  });

  it("accepts the self-closing and stray-closing <br> spellings", () => {
    for (const form of ["a<br/>b", "a<br />b", "a<BR>b", "a</br>b"]) {
      expect(cellDisplayHtml(form)).toBe("a<br>b");
    }
  });

  it("renders the sub/sup/u/mark subset", () => {
    expect(cellDisplayHtml("<sub>x</sub><sup>2</sup>")).toBe(
      "<sub>x</sub><sup>2</sup>",
    );
    expect(cellDisplayHtml("<u>u</u> <mark>m</mark>")).toBe(
      "<u>u</u> <mark>m</mark>",
    );
  });

  it("drops attributes from allowed tags", () => {
    expect(cellDisplayHtml('<mark class="x" onclick="evil()">m</mark>')).toBe(
      "<mark>m</mark>",
    );
  });

  it("leaves markdown syntax literal, as before", () => {
    expect(cellHasRichContent("**Group one**")).toBe(false);
    expect(cellDisplayHtml("**Group one**")).toBe("**Group one**");
  });

  it("treats plain cells as needing no rendering", () => {
    expect(cellHasRichContent("5 (4%)")).toBe(false);
    expect(cellHasRichContent("Item one")).toBe(false);
  });
});

describe("HTML entities in table cells", () => {
  it("renders &nbsp; indentation — the reported sub-row case", () => {
    expect(cellDisplayHtml("&nbsp;&nbsp;Item one")).toBe("  Item one");
    expect(cellHasRichContent("&nbsp;&nbsp;Item one")).toBe(true);
  });

  it("decodes named entities", () => {
    expect(decodeEntities("A &amp; B &mdash; C")).toBe("A & B — C");
    expect(decodeEntities("&le;5 &plusmn;2 &deg;C &micro;M")).toBe(
      "≤5 ±2 °C µM",
    );
  });

  it("decodes numeric entities, decimal and hex", () => {
    expect(decodeEntities("&#160;&#8202;")).toBe("  ");
    expect(decodeEntities("&#x41;&#X42;")).toBe("AB");
  });

  it("is case-sensitive, as HTML requires", () => {
    expect(decodeEntities("&Omega; &omega;")).toBe("Ω ω");
  });

  it("leaves unknown and malformed entities literal", () => {
    expect(decodeEntities("&notarealentity; &amp x &#; &#999999999;")).toBe(
      "&notarealentity; &amp x &#; &#999999999;",
    );
  });

  it("rejects surrogate code points instead of emitting lone surrogates", () => {
    expect(decodeEntities("&#55296;")).toBe("&#55296;");
  });

  it("decodes only once, so &amp;nbsp; shows the literal &nbsp;", () => {
    expect(decodeEntities("&amp;nbsp;")).toBe("&nbsp;");
    expect(cellDisplayHtml("&amp;nbsp;")).toBe("&amp;nbsp;");
  });

  it("re-escapes decoded markup characters", () => {
    // &lt;b&gt; must stay visible text, never become a live tag.
    expect(cellDisplayHtml("&lt;b&gt;bold&lt;/b&gt;")).toBe(
      "&lt;b&gt;bold&lt;/b&gt;",
    );
  });
});

describe("cell rendering is safe by construction", () => {
  it("escapes tags outside the allow-list rather than emitting them", () => {
    expect(cellDisplayHtml("<script>alert(1)</script>")).toBe(
      "&lt;script&gt;alert(1)&lt;/script&gt;",
    );
    expect(cellDisplayHtml('<img src=x onerror="alert(1)">')).toBe(
      '&lt;img src=x onerror="alert(1)"&gt;',
    );
  });

  it("emits no anchor for a javascript: link — it stays inert text", () => {
    const out = cellDisplayHtml('<a href="javascript:alert(1)">x</a>');
    // The URL may still be VISIBLE (it is escaped text), but no <a> element
    // exists to click, so there is nothing to navigate.
    expect(out).toBe('&lt;a href="javascript:alert(1)"&gt;x&lt;/a&gt;');
    expect(out).not.toMatch(/<a[\s>]/i);
  });

  it("keeps bare comparison operators as text", () => {
    expect(cellDisplayHtml("a < b > c")).toBe("a &lt; b &gt; c");
  });
});

describe("cellDisplayText mirrors what a rendered cell reads back as", () => {
  it("drops tags and resolves entities", () => {
    expect(cellDisplayText("Sample A<br>(n=12)")).toBe("Sample A(n=12)");
    expect(cellDisplayText("&nbsp;&nbsp;Item one")).toBe("  Item one");
  });

  it("is identity for plain cells", () => {
    expect(cellDisplayText("5 (4%)")).toBe("5 (4%)");
  });
});
