/**
 * The references dialog's side of the citation features: what the dialog
 * shows for a header, the header lines it writes back, and the example a
 * writer can start from. Pure text work; main.ts wires the dialog.
 */

import { yamlScalar, type HeaderValue } from "./meta";
import { findCitations } from "./citationsyntax";

/** What the dialog shows and takes. */
export interface CitationSetup {
  /** A bundled style's name, `csl:`. */
  style: string;
  /** A locale code, `lang:`; "" leaves the style's own. */
  lang: string;
  /** Files beside the document, comma-separated, `bibliography:`. */
  bibliography: string;
  /** Add the example works as an inline `references:` list. */
  inlineReferences: boolean;
  /** `reference-section-title:`; "" writes none. */
  sectionTitle: string;
  suppressBibliography: boolean;
  refsegment: boolean;
  /** Insert the how-to text, and the example file beside a saved document. */
  template: boolean;
}

/** pandoc's default style, the dialog's too. */
export const DEFAULT_STYLE = "chicago-author-date";

/** The example file the how-to cites; written beside the document. */
export const EXAMPLE_FILE = "example.bib";

export const DEFAULT_SETUP: CitationSetup = {
  style: DEFAULT_STYLE,
  lang: "",
  bibliography: "",
  inlineReferences: false,
  sectionTitle: "",
  suppressBibliography: false,
  refsegment: false,
  template: false,
};

/** The four works the how-to cites: an article, a book, a thesis, a web
 * page, written as a .bib file. */
export const EXAMPLE_BIB = `@article{doe2020,
  author  = {Doe, Jane and Roe, Richard},
  title   = {How to Cite in a Markdown Document},
  journal = {Journal of Examples},
  year    = {2020},
  volume  = {3},
  number  = {2},
  pages   = {1--9},
  doi     = {10.1000/example.2020.3},
}
@book{smith2019,
  author    = {Smith, John},
  title     = {The Reference List},
  publisher = {Example Press},
  address   = {Berlin},
  year      = {2019},
}
@phdthesis{kim2018,
  author = {Kim, Min-jun},
  title  = {Citation Styles Compared},
  school = {Example University},
  year   = {2018},
}
@online{lee2021,
  author       = {Lee, Ana},
  title        = {Citing a Web Page},
  organization = {{Example Site}},
  year         = {2021},
  url          = {https://example.org/citing},
}
`;

/** The same four works as the lines of an inline `references:` list. */
export const EXAMPLE_REFERENCES: readonly string[] = [
  "- id: doe2020",
  "  type: article-journal",
  "  title: How to cite in a Markdown document",
  "  author:",
  "  - family: Doe",
  "    given: Jane",
  "  - family: Roe",
  "    given: Richard",
  "  container-title: Journal of Examples",
  "  volume: 3",
  "  issue: 2",
  "  page: 1-9",
  "  issued: 2020",
  "  DOI: 10.1000/example.2020.3",
  "- id: smith2019",
  "  type: book",
  "  title: The reference list",
  "  author:",
  "  - family: Smith",
  "    given: John",
  "  publisher: Example Press",
  "  publisher-place: Berlin",
  "  issued: 2019",
  "- id: kim2018",
  "  type: thesis",
  "  title: Citation styles compared",
  "  genre: PhD thesis",
  "  author:",
  "  - family: Kim",
  "    given: Min-jun",
  "  publisher: Example University",
  "  issued: 2018",
  "- id: lee2021",
  "  type: webpage",
  "  title: Citing a web page",
  "  author:",
  "  - family: Lee",
  "    given: Ana",
  "  publisher: Example Site",
  "  issued: 2021",
  "  URL: https://example.org/citing",
];

/** The keys the example works have, in file order. */
export const EXAMPLE_KEYS = ["doe2020", "smith2019", "kim2018", "lee2021"];

/**
 * The how-to: every form the parser reads, each shown in the sentence that
 * explains it, a footnote that cites, and the block where the list goes.
 * `nl` is the document's line break.
 */
export function templateText(nl: string): string {
  return [
    "# How to cite",
    "",
    "The references button wrote this text and the file `example.bib` beside " +
      "this document; the header above names the citation style and that file. " +
      "Delete the text once you have seen what it shows.",
    "",
    "A key in brackets cites a work, and the style decides how it prints " +
      "[@doe2020]. A page number follows the key after a comma [@smith2019, " +
      "p. 3], and the other locators work the same way, such as a chapter " +
      "[@smith2019, chap. 2] or a figure [@doe2020, fig. 1]. Words before the " +
      "key are a prefix and words after the locator a suffix, both printed " +
      "with the citation [see @kim2018, chap. 2, for the method]. Several " +
      "works cite together when semicolons separate them [@doe2020; " +
      "@smith2019].",
    "",
    "A key written without brackets makes the author part of the sentence, " +
      "as @lee2021 shows, and a bracket right after it holds the locator, as " +
      "@smith2019 [p. 7] shows. A minus sign before the key leaves the author " +
      "out when the sentence names them already: Kim [-@kim2018] compared the " +
      "styles. A footnote can cite as well.[^how]",
    "",
    "[^how]: A citation in a footnote is numbered where the footnote's mark " +
      "stands [@doe2020].",
    "",
    "In the live view a citation shows as the style prints it; put the cursor " +
      "on its line to see and edit the source. Type `@` to pick a key from the " +
      "list of references, and rest the pointer on a key to see its entry. The " +
      "reference list stands where the refs block below is; without a block it " +
      "goes to the end of the document, under the heading the header's " +
      "`reference-section-title` gives it.",
    "",
    "## References",
    "",
    "::: {#refs}",
    ":::",
    "",
  ].join(nl);
}

const TRUISH = /^(t|true|yes)$/i;

/**
 * The dialog's values for a header: the keys the features read, each as the
 * header has it. `hasReferences` says whether an inline list is there, which
 * the dialog then leaves alone.
 */
export function setupFromHeader(header: string): {
  setup: CitationSetup;
  hasReferences: boolean;
} {
  const lines = header.split(/\r\n?|\n/);
  const scalar = (key: string): string => {
    const re = new RegExp(`^${key}\\s*:\\s*(.*)$`);
    for (const line of lines) {
      const m = re.exec(line);
      if (m !== null) return unquoteYaml(m[1].trim());
    }
    return "";
  };
  const list = (key: string): string[] => {
    const at = lines.findIndex((l) => new RegExp(`^${key}\\s*:\\s*$`).test(l));
    if (at === -1) return [];
    const items: string[] = [];
    for (let i = at + 1; i < lines.length; i++) {
      const m = /^\s*-\s+(.*)$/.exec(lines[i]);
      if (m === null) break;
      items.push(unquoteYaml(m[1].trim()));
    }
    return items;
  };
  const one = scalar("bibliography");
  // A flow list, `[a.bib, b.bib]`, holds its files in the one line.
  const flow = /^\[(.*)\]$/.exec(one);
  const files =
    flow !== null
      ? flow[1].split(",").map((f) => unquoteYaml(f.trim()))
      : one !== ""
        ? [one]
        : list("bibliography");
  return {
    setup: {
      style: scalar("csl") || DEFAULT_STYLE,
      lang: scalar("lang"),
      bibliography: files.join(", "),
      inlineReferences: false,
      sectionTitle: scalar("reference-section-title"),
      suppressBibliography: TRUISH.test(scalar("suppress-bibliography")),
      refsegment: TRUISH.test(scalar("refsegment")),
      template: false,
    },
    hasReferences: lines.some((l) => /^references\s*:/.test(l)),
  };
}

/** A YAML scalar's text: a double-quoted one with its escapes read, as
 * yamlScalar writes them, a single-quoted one with '' as one quote. */
function unquoteYaml(value: string): string {
  if (/^".*"$/.test(value)) {
    try {
      return JSON.parse(value) as string;
    } catch {
      return value.slice(1, -1);
    }
  }
  if (/^'.*'$/.test(value)) return value.slice(1, -1).replace(/''/g, "'");
  return value;
}

/**
 * The header lines for the dialog's values: a key the dialog leaves empty
 * is removed, so that the header says only what the dialog shows; the two
 * flags are always written, true or false. The
 * `references:` key is added only when asked for and never removed here.
 * With the template and a folder to write into, the example file joins the
 * bibliography; without a folder the example works go inline instead.
 */
export function headerEntries(
  setup: CitationSetup,
  hasFolder: boolean,
): Record<string, HeaderValue> {
  const files = setup.bibliography
    .split(",")
    .map((f) => f.trim())
    .filter((f) => f !== "");
  let inline = setup.inlineReferences;
  if (setup.template) {
    if (hasFolder) {
      if (!files.includes(EXAMPLE_FILE)) files.push(EXAMPLE_FILE);
    } else {
      inline = true;
    }
  }
  const entries: Record<string, HeaderValue> = {
    csl: setup.style || DEFAULT_STYLE,
    lang: setup.lang || null,
    bibliography:
      files.length === 0
        ? null
        : files.length === 1
          ? files[0]
          : files.map((f) => `- ${yamlScalar(f)}`),
    "reference-section-title": setup.sectionTitle || null,
    "suppress-bibliography": String(setup.suppressBibliography),
    refsegment: String(setup.refsegment),
  };
  if (inline) entries.references = EXAMPLE_REFERENCES;
  return entries;
}

/** The keys the template cites, for the test that pins them to the works. */
export function templateKeys(): string[] {
  const keys = findCitations(templateText("\n")).flatMap((c) =>
    c.items.map((item) => item.key),
  );
  return [...new Set(keys)];
}
