// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { loadCorpus } from "./corpus.testutil";
import { renderDocumentHtmlAsync } from "./export";
import { sanitizeDocumentHtml } from "./sanitize";

/**
 * Snapshots of the HTML every print, PDF and HTML export starts from, for each
 * document in the corpus (see corpus.testutil.ts) in both portability modes.
 *
 * Unlike the round trip, a difference here is not automatically a bug: a
 * rendering fix is supposed to change the output. What it must never do is
 * change it unnoticed. When this suite fails, read the diff: if the change is
 * the one intended, accept it with `npx vitest run -u` and commit the updated
 * snapshot alongside the code, so the PR shows reviewers exactly what moved.
 *
 * Same pipeline as renderDocumentHtmlWithImages in main.ts. Every local image
 * resolves to one fixed 1x1 PNG, so embedding is exercised without the disk
 * and the snapshots stay small and identical on every machine.
 *
 * Pagination is deliberately not covered: page breaks depend on real layout,
 * which jsdom does not do, so they belong to the e2e harness.
 */

const PIXEL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

const loadImages = async (sources: readonly string[]) =>
  new Map(sources.map((s) => [s, PIXEL]));

describe("export HTML matches its snapshot", () => {
  for (const file of loadCorpus()) {
    // A citation document exports alike in both modes, so its strict
    // snapshot would only repeat the enhanced one.
    const modes = file.name.startsWith("citations/")
      ? (["enhanced"] as const)
      : (["enhanced", "strict"] as const);
    for (const mode of modes) {
      it(`${file.name} (${mode})`, async () => {
        const markdown = file.bytes.toString("utf8");
        const html = sanitizeDocumentHtml(
          await renderDocumentHtmlAsync(markdown, mode, false, loadImages),
        );
        await expect(html).toMatchFileSnapshot(
          `__snapshots__/export/${file.name}.${mode}.html`,
        );
      });
    }
  }
});
