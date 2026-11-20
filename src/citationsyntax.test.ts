import { describe, expect, it } from "vitest";
import {
  namesReferences,
  citationAt,
  type CitedItem,
  findCitations,
  refsOpen,
  REFS_CLOSE_RE,
  refsClasses,
  refsegmentOn,
  suppressBibliographyOn,
  segmentLists,
} from "./citationsyntax";

const item = (key: string, rest: Partial<CitedItem> = {}): CitedItem => ({
  key,
  prefix: "",
  suffix: "",
  suppressAuthor: false,
  ...rest,
});

describe("namesReferences", () => {
  it("is true for a bibliography file or an inline list at column 0", () => {
    expect(namesReferences("title: T\nbibliography: refs.bib\n")).toBe(true);
    expect(namesReferences("references:\n- id: a\n")).toBe(true);
    expect(namesReferences("title: T\n  bibliography: x\n")).toBe(false);
    expect(namesReferences("")).toBe(false);
  });

  it("is true with a space before the colon and with CRLF line endings", () => {
    expect(namesReferences("bibliography : refs.bib\n")).toBe(true);
    expect(namesReferences("title: T\r\nbibliography: refs.bib\r\n")).toBe(
      true,
    );
  });

  it("is false for a longer key such as bibliographyx or reference-section-title", () => {
    expect(namesReferences("reference-section-title: Sources\n")).toBe(false);
    expect(namesReferences("bibliographyx: refs.bib\n")).toBe(false);
  });

  it("is true for a key without a value", () => {
    expect(namesReferences("bibliography:\n")).toBe(true);
  });
});

describe("citationAt", () => {
  it("finds no key after an escaped @", () => {
    expect(citationAt("Ping \\@bob now", 8)).toBeNull();
    expect(citationAt("Ping @bob now", 8)).not.toBeNull();
  });

  it("reads a key in any script", () => {
    expect(citationAt("@пункт3", 3)).toEqual({ from: 0, to: 7, key: "пункт3" });
  });

  it("reads a braced key with braces inside it, the span including the braces", () => {
    const key = { from: 4, to: 12, key: "a{b}c" };
    expect(citationAt("see @{a{b}c}", 6)).toEqual(key);
  });

  it("reads no braced key without its closing brace", () => {
    expect(citationAt("@{doe", 5)).toBeNull();
  });

  it("reads the plain key when the cursor is outside a braced key", () => {
    expect(citationAt("@{a} @b", 7)).toEqual({ from: 5, to: 7, key: "b" });
  });

  it("finds no braced key after a backslash or a letter", () => {
    expect(citationAt("\\@{a}", 3)).toBeNull();
    expect(citationAt("x@{a}", 3)).toBeNull();
  });

  it("gives an empty key right after a fresh @", () => {
    expect(citationAt("a @", 3)).toEqual({ from: 2, to: 3, key: "" });
    expect(citationAt("@ ", 1)).toEqual({ from: 0, to: 1, key: "" });
  });

  it("finds no key that begins with punctuation", () => {
    expect(citationAt("@.", 1)).toBeNull();
    expect(citationAt("@.x", 3)).toBeNull();
  });

  it("drops punctuation after the key only right of the cursor", () => {
    expect(citationAt("see @ab.", 6)).toEqual({ from: 4, to: 7, key: "ab" });
    expect(citationAt("@ab.", 4)).toEqual({ from: 0, to: 4, key: "ab." });
  });

  it("finds no key in an e-mail address", () => {
    expect(citationAt("jane@doe.org", 8)).toBeNull();
  });

  it("reads a key that begins or ends with _", () => {
    expect(citationAt("@_a", 3)).toEqual({ from: 0, to: 3, key: "_a" });
    expect(citationAt("see @a_ x", 5)).toEqual({ from: 4, to: 7, key: "a_" });
  });

  it("reads a braced key with the cursor right after its closing brace", () => {
    expect(citationAt("@{a}", 4)).toEqual({ from: 0, to: 4, key: "a" });
  });
});

describe("findCitations", () => {
  it("reads a bracketed citation with its span", () => {
    expect(findCitations("As shown [@doe2020].")).toEqual([
      { from: 9, to: 19, items: [item("doe2020")], inText: false },
    ]);
  });

  it("splits a group into prefix, key and suffix", () => {
    const [found] = findCitations(
      "[see @doe2020, pp. 3-5, emphasis added; also -@roe, chap. 2; @x]",
    );
    expect(found.items).toEqual([
      item("doe2020", { prefix: "see", suffix: "pp. 3-5, emphasis added" }),
      item("roe", { prefix: "also", suffix: "chap. 2", suppressAuthor: true }),
      item("x"),
    ]);
  });

  it("drops the comma after the key and keeps the rest as the suffix", () => {
    const [found] = findCitations("[@doe2020, 12; @roe and others]");
    expect(found.items).toEqual([
      item("doe2020", { suffix: "12" }),
      item("roe", { suffix: "and others" }),
    ]);
  });

  it("trims the spaces around the suffix", () => {
    expect(findCitations("[@a, p. 3 ]")[0].items).toEqual([
      item("a", { suffix: "p. 3" }),
    ]);
  });

  it("keeps a locator without the comma as the suffix", () => {
    // pandoc renders [@a p. 3] as page 3, the same as [@a, p. 3]
    const [found] = findCitations("[@a p. 3; see @b chap. 2 for this]");
    expect(found.items).toEqual([
      item("a", { suffix: "p. 3" }),
      item("b", { prefix: "see", suffix: "chap. 2 for this" }),
    ]);
  });

  it("ends a bracket at the ] that balances it, as pandoc does", () => {
    const text = "[@a, p. [3]] and [see @b [sic]; @c, [x; y]].";
    expect(findCitations(text).map((c) => c.items)).toEqual([
      [item("a", { suffix: "p. [3]" })],
      [
        item("b", { prefix: "see", suffix: "[sic]" }),
        item("c", { suffix: "[x; y]" }),
      ],
    ]);
  });

  it("ends a bracket at the ] that balances it, nested twice", () => {
    expect(findCitations("[@a, p. [[3]]]")).toEqual([
      {
        from: 0,
        to: 14,
        items: [item("a", { suffix: "p. [[3]]" })],
        inText: false,
      },
    ]);
  });

  it("reads 200 KB of nested or unclosed brackets in linear time", () => {
    for (const doc of [
      "[".repeat(100_000) + "]".repeat(100_000),
      "[a ".repeat(70_000),
      "[x] ".repeat(50_000),
    ]) {
      const start = performance.now();
      const citations = findCitations(`${doc}[@a]`);
      expect(performance.now() - start).toBeLessThan(500);
      expect(citations[citations.length - 1]?.items).toEqual([item("a")]);
    }
  });

  it("reads a braced key with brackets in it, as pandoc does", () => {
    expect(findCitations("[@{a[b]}]")).toEqual([
      { from: 0, to: 9, items: [item("a[b]")], inText: false },
    ]);
  });

  it("gives a key inside a nested bracket to that bracket", () => {
    expect(findCitations("[see [x @a]]")).toEqual([
      { from: 5, to: 11, items: [item("a", { prefix: "x" })], inText: false },
    ]);
  });

  it("leaves the author out only with a - right before the @", () => {
    expect(findCitations("[-@a] and [see -@a]").map((c) => c.items)).toEqual([
      [item("a", { suppressAuthor: true })],
      [item("a", { prefix: "see", suppressAuthor: true })],
    ]);
    expect(findCitations("Smith [-@a]")).toEqual([
      {
        from: 6,
        to: 11,
        items: [item("a", { suppressAuthor: true })],
        inText: false,
      },
    ]);
    expect(findCitations("[- @a]")[0].items).toEqual([
      item("a", { prefix: "-" }),
    ]);
  });

  it("reads an @ without a key as text", () => {
    expect(findCitations("[@ @a]")[0].items).toEqual([
      item("a", { prefix: "@" }),
    ]);
    expect(findCitations("[@] and [@ ]")).toEqual([]);
  });

  it("keeps a line break inside the suffix", () => {
    expect(findCitations("[see\n@a, p.\n3]")).toEqual([
      {
        from: 0,
        to: 14,
        items: [item("a", { prefix: "see", suffix: "p.\n3" })],
        inText: false,
      },
    ]);
  });

  it("reads the keys of a bracket that is no citation list as in-text", () => {
    // pandoc 3.13 reads such a bracket as text with author-in-text citations
    const at = (from: number, to: number, key: string) => ({
      from,
      to,
      items: [item(key)],
      inText: true,
    });
    expect(findCitations("[@a; foo]")).toEqual([at(1, 3, "a")]);
    expect(findCitations("[foo; @a]")).toEqual([at(6, 8, "a")]);
    expect(findCitations("[@a; @b; foo]")).toEqual([
      at(1, 3, "a"),
      at(5, 7, "b"),
    ]);
    expect(findCitations("[@a, p. 3; see also]")).toEqual([at(1, 3, "a")]);
  });

  it("reads the key of an unbalanced bracket as in-text", () => {
    expect(findCitations("[@a, p. [3]")).toEqual([
      { from: 1, to: 3, items: [item("a")], inText: true },
    ]);
  });

  it("reads the keys in link text as in-text, as pandoc does", () => {
    const at = (from: number, to: number, key: string) => ({
      from,
      to,
      items: [item(key)],
      inText: true,
    });
    expect(findCitations("[@tw](https://x)")).toEqual([at(1, 4, "tw")]);
    expect(findCitations("[@a][]")).toEqual([at(1, 3, "a")]);
    expect(findCitations("[@a][@b]")).toEqual([
      at(1, 3, "a"),
      { from: 4, to: 8, items: [item("b")], inText: false },
    ]);
    expect(findCitations("@a [x](https://y)")).toEqual([at(0, 2, "a")]);
  });

  it("reads a citation before a footnote mark, as pandoc does", () => {
    expect(findCitations("[@a, p. 3][^1]")).toEqual([
      {
        from: 0,
        to: 10,
        items: [item("a", { suffix: "p. 3" })],
        inText: false,
      },
    ]);
  });

  it("reads the in-text form, with or without a bracket after it", () => {
    expect(findCitations("@doe2020 [p. 3] says, and @roe agrees.")).toEqual([
      {
        from: 0,
        to: 15,
        items: [item("doe2020", { suffix: "p. 3" })],
        inText: true,
      },
      { from: 26, to: 30, items: [item("roe")], inText: true },
    ]);
  });

  it("reads the in-text form beside punctuation and a bracket without a space", () => {
    const at = (from: number, to: number, key: string, suffix = "") => ({
      from,
      to,
      items: [item(key, { suffix })],
      inText: true,
    });
    expect(findCitations("@a[p. 3]")).toEqual([at(0, 8, "a", "p. 3")]);
    expect(findCitations("as (@a) says")).toEqual([at(4, 6, "a")]);
    expect(findCitations("costs @3 each")).toEqual([at(6, 8, "3")]);
    expect(findCitations("see @doe:2020, and @a.b.")).toEqual([
      at(4, 13, "doe:2020"),
      at(19, 23, "a.b"),
    ]);
  });

  it("reads the in-text locator after any space, also across a line", () => {
    expect(findCitations("@a  [p. 3]")).toEqual([
      { from: 0, to: 10, items: [item("a", { suffix: "p. 3" })], inText: true },
    ]);
    expect(findCitations("@a\n[p. 3]")).toEqual([
      { from: 0, to: 9, items: [item("a", { suffix: "p. 3" })], inText: true },
    ]);
  });

  it("reads no in-text locator across a blank line", () => {
    expect(findCitations("@a\r\n[p. 3]")).toEqual([
      { from: 0, to: 10, items: [item("a", { suffix: "p. 3" })], inText: true },
    ]);
    expect(findCitations("See @a\n\n[p. 3] here")).toEqual([
      { from: 4, to: 6, items: [item("a")], inText: true },
    ]);
    expect(findCitations("See @a\r\n\r\n[p. 3] here")).toEqual([
      { from: 4, to: 6, items: [item("a")], inText: true },
    ]);
  });

  it("reads a bracket of keys after an in-text key as its own citation", () => {
    expect(findCitations("@a [@b]")).toEqual([
      { from: 0, to: 2, items: [item("a")], inText: true },
      { from: 3, to: 7, items: [item("b")], inText: false },
    ]);
  });

  it("reads keys in any script, as pandoc does", () => {
    const text = "Siehe [@пункт3; @Müller2020] und @ürün_1.";
    expect(findCitations(text).map((c) => c.items.map((i) => i.key))).toEqual([
      ["пункт3", "Müller2020"],
      ["ürün_1"],
    ]);
  });

  it("reads a key after an underscore but none after a letter, as pandoc does", () => {
    expect(findCitations("x_@a and a_b@c")).toEqual([
      { from: 2, to: 4, items: [item("a")], inText: true },
    ]);
  });

  it("reads a braced key without the braces, which the span includes", () => {
    expect(findCitations("[@{пункт3}, p. 3] and @{x.y}.")).toEqual([
      {
        from: 0,
        to: 17,
        items: [item("пункт3", { suffix: "p. 3" })],
        inText: false,
      },
      { from: 22, to: 28, items: [item("x.y")], inText: true },
    ]);
  });

  it("reads no braced key unclosed, across a space or escaped", () => {
    expect(findCitations("[@{doe, p. 3] @{a b} \\@{c} a@{d}")).toEqual([]);
  });

  it("reads no citation at an escaped @", () => {
    expect(findCitations("Ping \\@bob [on Slack](x) and [@a].")).toEqual([
      { from: 29, to: 33, items: [item("a")], inText: false },
    ]);
  });

  it("reads a citation at an @ after an escaped backslash", () => {
    expect(findCitations("\\\\@a \\\\\\@b")).toEqual([
      { from: 2, to: 4, items: [item("a")], inText: true },
    ]);
  });

  it("reads an escaped [ as text and a [ after an escaped backslash as a bracket", () => {
    expect(findCitations("\\[@a] and \\\\[@b]")).toEqual([
      { from: 2, to: 4, items: [item("a")], inText: true },
      { from: 12, to: 16, items: [item("b")], inText: false },
    ]);
  });

  it("leaves e-mail addresses, plain brackets and empty keys alone", () => {
    expect(
      findCitations("write to jane@doe.org [not a citation] or @ me"),
    ).toEqual([]);
  });

  it("skips a bracket without a key, such as a footnote mark", () => {
    expect(findCitations("text[^1] and [^1]: see @a.")).toEqual([
      { from: 23, to: 25, items: [item("a")], inText: true },
    ]);
  });
});

describe("refsClasses", () => {
  it("opens the refs block at three or more colons, spaces and CRLF allowed", () => {
    expect(refsOpen("::: {#refs}")).toBe(true);
    expect(refsOpen(":::: { #refs }")).toBe(true);
    expect(refsOpen(":::{#refs}")).toBe(true);
    expect(refsOpen("::: {#refs}   ")).toBe(true);
    expect(refsOpen("::: {#refs}\r")).toBe(true);
  });

  it("opens the refs block with the id anywhere and colons after the braces", () => {
    expect(refsOpen("::: {.x #refs}")).toBe(true);
    expect(refsOpen("::: {.a#refs}")).toBe(true);
    expect(refsOpen("::: {#a #refs}")).toBe(true);
    expect(refsOpen('::: {#refs key="a}b"}')).toBe(true);
    expect(refsOpen("::: {#refs} :::")).toBe(true);
    expect(refsOpen("::: {#refs}:::")).toBe(true);
  });

  it("opens no refs block for another id, a class, two colons or an indent", () => {
    expect(refsOpen("::: {#refsx}")).toBe(false);
    expect(refsOpen("::: {#refs.a}")).toBe(false);
    expect(refsOpen("::: {#refs #a}")).toBe(false);
    expect(refsOpen('::: {key="a #refs"}')).toBe(false);
    expect(refsOpen("::: refs")).toBe(false);
    expect(refsOpen(":: {#refs}")).toBe(false);
    expect(refsOpen("   ::: {#refs}")).toBe(false);
  });

  it("opens no refs block for anything pandoc reads as text", () => {
    expect(refsOpen("::: {#refs foo}")).toBe(false);
    expect(refsOpen("::: {#refs .a$b}")).toBe(false);
    expect(refsOpen("::: {#refs _x=1}")).toBe(false);
    expect(refsOpen("::: {#refs}x")).toBe(false);
    expect(refsOpen("::: {#refs}{.a}")).toBe(false);
    expect(refsOpen("::: {#refs} : :")).toBe(false);
    expect(refsOpen("::: {#refs} ::: x")).toBe(false);
  });

  it("closes at three or more colons alone on the line", () => {
    expect(REFS_CLOSE_RE.test(":::")).toBe(true);
    expect(REFS_CLOSE_RE.test("::::")).toBe(true);
    expect(REFS_CLOSE_RE.test(":::   ")).toBe(true);
    expect(REFS_CLOSE_RE.test(":::\r")).toBe(true);
    expect(REFS_CLOSE_RE.test("::")).toBe(false);
    expect(REFS_CLOSE_RE.test("::: x")).toBe(false);
    expect(REFS_CLOSE_RE.test("   :::")).toBe(false);
  });

  it("reads the classes of the refs fence only", () => {
    expect(refsClasses("::: {#refs .small .two-col}")).toEqual([
      "small",
      "two-col",
    ]);
    expect(refsClasses("::: {.a #refs}")).toEqual(["a"]);
    expect(refsClasses("::: {#refs}")).toEqual([]);
    expect(refsClasses("::: {.small}")).toEqual([]);
    expect(refsClasses("Some text")).toEqual([]);
  });

  it("reads class names with any letter or digit and _ : . -", () => {
    expect(refsClasses("::: {#refs .größe .x²}")).toEqual(["größe", "x²"]);
    expect(refsClasses("::: {#refs .a_b .a:b .a.b .a-}")).toEqual([
      "a_b",
      "a:b",
      "a.b",
      "a-",
    ]);
  });

  it("reads - as the class unnumbered and no class inside a value", () => {
    expect(refsClasses("::: {#refs -}")).toEqual(["unnumbered"]);
    expect(refsClasses('::: {#refs key="a .b"}')).toEqual([]);
    expect(refsClasses("::: {#refs key='a .b'}")).toEqual([]);
    expect(refsClasses('::: {#refs key="a\\" .b"}')).toEqual([]);
    expect(refsClasses("::: {#refs key=a .b}")).toEqual(["b"]);
  });
});

describe("refsegmentOn", () => {
  it("is true for t, true or yes in any case, quoted or not", () => {
    expect(refsegmentOn("csl: apa\nrefsegment: true\n")).toBe(true);
    expect(refsegmentOn("refsegment: TRUE\n")).toBe(true);
    expect(refsegmentOn("refsegment: t\n")).toBe(true);
    expect(refsegmentOn('refsegment: "Yes"')).toBe(true);
    expect(refsegmentOn("refsegment: 'yes'\n")).toBe(true);
  });

  it("is false for false, on, y, 1 and an empty value, as pandoc reads them", () => {
    expect(refsegmentOn("refsegment: false\n")).toBe(false);
    expect(refsegmentOn("refsegment: on\n")).toBe(false);
    expect(refsegmentOn("refsegment: y\n")).toBe(false);
    expect(refsegmentOn("refsegment: 1\n")).toBe(false);
    expect(refsegmentOn("refsegment:\n")).toBe(false);
  });

  it("is false when the key is missing or indented", () => {
    expect(refsegmentOn("csl: apa\n")).toBe(false);
    expect(refsegmentOn("  refsegment: true\n")).toBe(false);
  });

  it("is true with CRLF line endings", () => {
    expect(refsegmentOn("a: 1\r\nrefsegment: true\r\n")).toBe(true);
  });

  it("ignores a comment after the value", () => {
    expect(refsegmentOn("refsegment: true # c\n")).toBe(true);
    expect(refsegmentOn('refsegment: "yes" # c\n')).toBe(true);
    expect(refsegmentOn("refsegment: false # true\n")).toBe(false);
  });
});

describe("suppressBibliographyOn", () => {
  it("is true when its key is true among other keys", () => {
    expect(
      suppressBibliographyOn("csl: apa\nsuppress-bibliography: true\n"),
    ).toBe(true);
  });

  it("is false when its key is false", () => {
    expect(suppressBibliographyOn("suppress-bibliography: false\n")).toBe(
      false,
    );
  });

  it("is false when its key is missing", () => {
    expect(suppressBibliographyOn("csl: apa\n")).toBe(false);
  });

  it("reads suppress-bibliography and not refsegment", () => {
    expect(
      suppressBibliographyOn(
        "refsegment: true\nsuppress-bibliography: false\n",
      ),
    ).toBe(false);
    expect(
      suppressBibliographyOn(
        "refsegment: false\nsuppress-bibliography: true\n",
      ),
    ).toBe(true);
  });
});

describe("segmentLists", () => {
  const cite = (...keys: string[]) => ({ kind: "cite" as const, keys });
  const block = { kind: "block" as const };
  const keys = (list: ReadonlySet<string> | null) =>
    list === null ? "all" : [...list].join(",");

  it("lists every work at every block without the flag", () => {
    const events = [cite("a"), block, cite("b"), block];
    expect(segmentLists(events, false).map(keys)).toEqual(["all", "all"]);
  });

  it("lists each chapter's works and every work at the last block", () => {
    const events = [cite("a"), block, cite("b", "a"), block, cite("c"), block];
    expect(segmentLists(events, true).map(keys)).toEqual(["a", "b,a", "all"]);
  });

  it("lists every work where nothing is cited before or after a block", () => {
    const top = [block, cite("a"), block, cite("b"), block];
    expect(segmentLists(top, true).map(keys)).toEqual(["all", "a", "all"]);
    const tail = [cite("a"), block, block];
    expect(segmentLists(tail, true).map(keys)).toEqual(["all", "all"]);
  });

  it("gives the appendix after the last block to the last block's full list", () => {
    const events = [cite("a"), block, cite("b"), block, cite("c")];
    expect(segmentLists(events, true).map(keys)).toEqual(["a", "all"]);
  });

  it("returns no lists for a document without a block", () => {
    expect(segmentLists([cite("a")], true)).toEqual([]);
  });

  it("lists every work at a single block", () => {
    const events = [cite("a"), block];
    expect(segmentLists(events, true).map(keys)).toEqual(["all"]);
  });

  it("lists a work once per chapter, in order of first citation", () => {
    const events = [cite("b", "a"), cite("a"), block, cite("c"), block];
    expect(segmentLists(events, true).map(keys)).toEqual(["b,a", "all"]);
  });

  it("keeps the works before a block when the next chapter is empty", () => {
    const events = [cite("a"), block, block, cite("c"), block];
    expect(segmentLists(events, true).map(keys)).toEqual(["a", "all", "all"]);
  });

  it("lists a work in every chapter that cites it", () => {
    const events = [cite("a"), block, cite("a"), block, cite("z"), block];
    expect(segmentLists(events, true).map(keys)).toEqual(["a", "a", "all"]);
  });
});
