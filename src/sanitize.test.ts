// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { sanitizeDocumentHtml } from "./sanitize";

describe("sanitizeDocumentHtml", () => {
  it("strips event-handler attributes (the opened-file XSS vector)", () => {
    const out = sanitizeDocumentHtml(
      '<p>hi<img src="x" onerror="alert(1)"></p>',
    );
    expect(out).not.toMatch(/onerror/i);
    expect(out).toContain("<img");
  });

  it("removes <script> elements", () => {
    const out = sanitizeDocumentHtml("<p>ok</p><script>alert(1)</script>");
    expect(out).not.toMatch(/<script/i);
    expect(out).toContain("<p>ok</p>");
  });

  it("drops javascript: URLs on links", () => {
    const out = sanitizeDocumentHtml('<a href="javascript:alert(1)">x</a>');
    expect(out).not.toMatch(/javascript:/i);
  });

  it("removes iframes and other embedding tags", () => {
    expect(
      sanitizeDocumentHtml('<iframe src="https://evil.example"></iframe>'),
    ).not.toMatch(/<iframe/i);
    expect(sanitizeDocumentHtml("<object data='x'></object>")).not.toMatch(
      /<object/i,
    );
  });

  it("preserves data-srcline (pagination break mapping)", () => {
    expect(sanitizeDocumentHtml('<p data-srcline="7">x</p>')).toContain(
      'data-srcline="7"',
    );
  });

  it("preserves MathML emitted by KaTeX", () => {
    const out = sanitizeDocumentHtml(
      "<math><mrow><mi>C</mi><mn>2</mn></mrow></math>",
    );
    expect(out.toLowerCase()).toContain("<math");
    expect(out.toLowerCase()).toContain("<mi");
  });

  it("preserves alignment and inline table styles (PDF table borders)", () => {
    expect(sanitizeDocumentHtml('<div align="center">x</div>')).toContain(
      "center",
    );
    const table = sanitizeDocumentHtml(
      '<table><tbody><tr><td style="border:0.75pt solid #b0b0b0;padding:4pt 7pt">cell</td></tr></tbody></table>',
    );
    expect(table).toContain("border");
    expect(table).toContain("<td");
  });
});
