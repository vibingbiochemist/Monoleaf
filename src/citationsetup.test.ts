import { describe, expect, it } from "vitest";
import {
  DEFAULT_SETUP,
  EXAMPLE_BIB,
  EXAMPLE_FILE,
  EXAMPLE_KEYS,
  EXAMPLE_REFERENCES,
  headerEntries,
  setupFromHeader,
  templateKeys,
  templateText,
} from "./citationsetup";
import { setHeaderLines } from "./meta";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CITATION_FIXTURES_DIR } from "./corpus.testutil";

describe("the references dialog", () => {
  it("writes the keys it shows, both flags always, and removes the ones left empty", () => {
    const entries = headerEntries(
      {
        ...DEFAULT_SETUP,
        style: "ieee",
        lang: "de-DE",
        bibliography: "a.bib, b.json",
        sectionTitle: "Quellen",
        refsegment: true,
      },
      true,
    );
    expect(entries).toEqual({
      csl: "ieee",
      lang: "de-DE",
      bibliography: ["- a.bib", "- b.json"],
      "reference-section-title": "Quellen",
      "suppress-bibliography": "false",
      refsegment: "true",
    });
    expect(headerEntries(DEFAULT_SETUP, true)).toEqual({
      csl: "chicago-author-date",
      lang: null,
      bibliography: null,
      "reference-section-title": null,
      "suppress-bibliography": "false",
      refsegment: "false",
    });
  });

  it("reads its values back from a header, lists included", () => {
    const header = setHeaderLines(
      "",
      headerEntries(
        {
          ...DEFAULT_SETUP,
          style: "apa",
          bibliography: "a.bib, b.json",
          sectionTitle: "Sources: all",
          suppressBibliography: true,
          inlineReferences: true,
        },
        true,
      ),
    );
    const { setup, hasReferences } = setupFromHeader(header);
    expect(setup).toEqual({
      ...DEFAULT_SETUP,
      style: "apa",
      bibliography: "a.bib, b.json",
      sectionTitle: "Sources: all",
      suppressBibliography: true,
    });
    expect(hasReferences).toBe(true);
    expect(setupFromHeader("title: T\n").setup).toEqual(DEFAULT_SETUP);
  });

  it("reads back what it writes, whatever the values hold", () => {
    const odd = {
      ...DEFAULT_SETUP,
      bibliography: "C:\\refs\\a.bib, my refs #2.bib",
      sectionTitle: 'Works "cited"',
    };
    const once = setHeaderLines("", headerEntries(odd, true));
    expect(setupFromHeader(once).setup).toEqual(odd);
    const again = headerEntries(setupFromHeader(once).setup, true);
    expect(setHeaderLines(once, again)).toBe(once);
    for (const title of ["*Works cited*", "[Sources]", "- Sources"]) {
      const header = setHeaderLines(
        "",
        headerEntries({ ...DEFAULT_SETUP, sectionTitle: title }, true),
      );
      expect(header).toContain(
        `reference-section-title: ${JSON.stringify(title)}`,
      );
      expect(setupFromHeader(header).setup.sectionTitle).toBe(title);
    }
    const flow = setupFromHeader("bibliography: [a.bib, 'b c.bib']\n").setup;
    expect(flow.bibliography).toBe("a.bib, b c.bib");
  });

  it("puts the example file beside a saved document and the works inline otherwise", () => {
    const saved = headerEntries(
      { ...DEFAULT_SETUP, bibliography: "own.bib", template: true },
      true,
    );
    expect(saved.bibliography).toEqual(["- own.bib", `- ${EXAMPLE_FILE}`]);
    expect(saved.references).toBeUndefined();
    const unsaved = headerEntries({ ...DEFAULT_SETUP, template: true }, false);
    expect(unsaved.bibliography).toBeNull();
    expect(unsaved.references).toBe(EXAMPLE_REFERENCES);
  });

  it("cites only the example works, in every form the parser reads", () => {
    expect(templateKeys().sort()).toEqual([...EXAMPLE_KEYS].sort());
    for (const key of EXAMPLE_KEYS) {
      expect(EXAMPLE_BIB).toContain(`{${key},`);
      expect(EXAMPLE_REFERENCES).toContain(`- id: ${key}`);
    }
    const text = templateText("\n");
    for (const form of [
      "[@doe2020]",
      "[@smith2019, p. 3]",
      "[see @kim2018, chap. 2, for the method]",
      "[@doe2020; @smith2019]",
      "as @lee2021 shows",
      "@smith2019 [p. 7]",
      "Kim [-@kim2018]",
      "[^how]: A citation in a footnote",
      "::: {#refs}",
    ]) {
      expect(text).toContain(form);
    }
    expect(templateText("\r\n")).not.toContain("\n\n");
  });

  it("is what the fixture document and its example file hold", () => {
    // The chain renders template.md with example.bib beside it; both are
    // what the dialog writes. MONOLEAF_UPDATE_FIXTURES=1 rewrites them.
    const expected = {
      "template.md":
        setHeaderLines(
          "",
          headerEntries({ ...DEFAULT_SETUP, template: true }, true),
        ) +
        "\n" +
        templateText("\n"),
      [EXAMPLE_FILE]: EXAMPLE_BIB,
    };
    for (const [name, text] of Object.entries(expected)) {
      const file = join(CITATION_FIXTURES_DIR, name);
      if (process.env.MONOLEAF_UPDATE_FIXTURES || !existsSync(file))
        writeFileSync(file, text);
      expect(readFileSync(file, "utf8")).toBe(text);
    }
  });
});
