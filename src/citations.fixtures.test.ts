// @vitest-environment jsdom
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ParsedCitation } from "./citationsyntax";
import { CITATION_FIXTURES_DIR, loadCorpus } from "./corpus.testutil";
import { renderDocumentHtmlAsync, type RenderedCitations } from "./export";
import { sanitizeDocumentHtml } from "./sanitize";

/**
 * The citation chain, one document at a time, across the two languages:
 *
 *   name.md  --(this suite)-->  name.citations.json  --(cargo test)-->  name.rendered.json  --(this suite)-->  the HTML snapshot
 *
 * The first test pins what the export sends to the backend for the document,
 * exactly as the parser finds it. A Rust test (fixture_documents_render_as_
 * committed in src-tauri/src/citations.rs) renders that file with the
 * document's header and pins the result as name.rendered.json; it rewrites
 * the file with MONOLEAF_UPDATE_FIXTURES=1. The second test here feeds that
 * result to the export and pins the final HTML. Each side checks its own link
 * and the committed JSON files are the hand-over, readable in a review. A
 * change in the parser, in hayagriva or in the export shows as a diff in the
 * file of that link. Accept intended changes with `npx vitest run -u` and the
 * variable above, and commit the files alongside the code.
 */

const NOT_RENDERED: RenderedCitations = {
  citations: [],
  bibliography: [],
  hangingIndent: false,
  title: null,
  warnings: [],
};
const loadImages = async () => new Map<string, string>();

describe("citation fixtures", () => {
  for (const file of loadCorpus()) {
    if (!file.name.startsWith("citations/")) continue;
    const name = file.name.slice("citations/".length).replace(/\.md$/, "");
    const markdown = file.bytes.toString("utf8");

    it(`${file.name}: what the export sends to the backend`, async () => {
      let sent: readonly ParsedCitation[] = [];
      await renderDocumentHtmlAsync(
        markdown,
        "enhanced",
        false,
        loadImages,
        (citations) => {
          sent = citations;
          return Promise.resolve(NOT_RENDERED);
        },
      );
      // One citation per line keeps a document's file as short as its list.
      const lines = sent.map((citation) => JSON.stringify(citation));
      await expect(`[\n${lines.join(",\n")}\n]\n`).toMatchFileSnapshot(
        `__fixtures__/citations/${name}.citations.json`,
      );
    });

    it(`${file.name}: the export with what the backend rendered`, async () => {
      const path = join(CITATION_FIXTURES_DIR, `${name}.rendered.json`);
      if (!existsSync(path)) {
        throw new Error(
          `${path} is missing: MONOLEAF_UPDATE_FIXTURES=1 cargo test in src-tauri writes it`,
        );
      }
      const rendered = JSON.parse(
        readFileSync(path, "utf8"),
      ) as RenderedCitations;
      const html = sanitizeDocumentHtml(
        await renderDocumentHtmlAsync(
          markdown,
          "enhanced",
          false,
          loadImages,
          () => Promise.resolve(rendered),
        ),
      );
      await expect(html).toMatchFileSnapshot(
        `__snapshots__/export/${file.name}.enhanced.rendered.html`,
      );
    });
  }
});
