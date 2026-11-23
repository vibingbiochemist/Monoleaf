// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { renderDocumentHtmlAsync } from "./export";
import { sanitizeDocumentHtml } from "./sanitize";

describe("a reference with hostile markup", () => {
  it("is inert in the sanitised page", async () => {
    // The backend escapes what it renders; this is the net under it, the
    // same sanitiser every export goes through.
    const hostile = () =>
      Promise.resolve({
        citations: ['<img src=x onerror="alert(1)">'],
        bibliography: [
          {
            key: "a",
            label: null,
            html: '<a href="javascript:alert(1)">A</a>',
          },
        ],
        hangingIndent: false,
        title: null,
        warnings: [],
      });
    const html = sanitizeDocumentHtml(
      await renderDocumentHtmlAsync(
        "---\nbibliography: r.bib\n---\n\nSee [@a].\n\n::: {#refs}\n:::\n",
        "enhanced",
        false,
        () => Promise.resolve(new Map()),
        hostile,
      ),
    );
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("onerror");
    expect(html).toContain(">A</a>");
  });
});
