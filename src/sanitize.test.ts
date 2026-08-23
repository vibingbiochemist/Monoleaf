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

  it("removes media tags the renderer never emits", () => {
    // Surface reduction: none of these are constructs renderDocumentHtml can
    // produce, so allowing them only widens the area a remote-content bug can
    // hide in (<video poster> was one).
    for (const [tag, html] of [
      [
        "video",
        '<video poster="https://evil.example/p.png" src="x.mp4"></video>',
      ],
      ["audio", '<audio src="x.mp3"></audio>'],
      ["track", '<video><track src="x.vtt"></video>'],
    ]) {
      expect(sanitizeDocumentHtml(html), tag).not.toMatch(
        new RegExp(`<${tag}`, "i"),
      );
    }
  });

  it("keeps task-list checkboxes (markdown-it-task-lists emits <input>)", () => {
    // renderDocumentHtml -> sanitizeDocumentHtml is the real export/print
    // pipeline, so forbidding <input> outright would silently delete every
    // checkbox from the PDF and the self-contained HTML export.
    const out = sanitizeDocumentHtml(
      '<ul class="contains-task-list"><li class="task-list-item">' +
        '<input class="task-list-item-checkbox" disabled type="checkbox" checked>done</li></ul>',
    );
    expect(out).toContain('type="checkbox"');
  });

  it("pairs every target with rel=noopener noreferrer", () => {
    // Harmless in the app, where clicks are intercepted and routed through
    // openExternal — but the exported HTML opens in a real browser, where
    // target without rel is reverse tabnabbing: the opened page gets a live
    // window.opener handle back to the document.
    for (const html of [
      '<a href="https://example.com" target="_blank">x</a>',
      '<a href="https://example.com" target="_self">x</a>',
      '<area href="https://example.com" target="_blank">',
    ]) {
      const out = sanitizeDocumentHtml(html);
      expect(out, html).toMatch(/rel="noopener noreferrer"/);
    }
  });

  it("leaves rel alone on links with no target", () => {
    const out = sanitizeDocumentHtml('<a href="https://example.com">x</a>');
    expect(out).not.toMatch(/rel=/);
  });

  it("preserves data-srcline (pagination break mapping)", () => {
    expect(sanitizeDocumentHtml('<p data-srcline="7">x</p>')).toContain(
      'data-srcline="7"',
    );
  });

  it("preserves data-srcline-end (extractPageBreaks's straddling-block fallback)", () => {
    expect(
      sanitizeDocumentHtml('<p data-srcline="7" data-srcline-end="9">x</p>'),
    ).toContain('data-srcline-end="9"');
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
