/**
 * Pandoc's citation syntax, read from plain text: `[@a]`, `[@a; @b]`,
 * `[see @a, p. 3; also -@b]` and in-text `@a` or `@a [p. 3]`. Pure text
 * functions, shared by the editor and the export; nothing is rendered here.
 */

/** A citation key around a position: `from` is the `@`, `to` the key's end. */
export interface Citation {
  from: number;
  to: number;
  key: string;
}

/** A header line that names references: a `bibliography:` file or an inline
 * `references:` list, at column 0 as pandoc reads them. */
const NAMES_REFERENCES = /^(?:bibliography|references)\s*:/m;

/** Whether the document asks for citations at all. Without references in
 * the header, `@name` and `[@name]` are plain text, as they were before. */
export function namesReferences(header: string): boolean {
  return NAMES_REFERENCES.test(header);
}

// A pandoc key starts with a letter, digit or `_`, in any script, and goes on
// with those and internal punctuation; punctuation at the very end belongs to
// the sentence.
const KEY_START = /[\p{L}\p{N}_]/u;
const KEY_CHAR = /[\p{L}\p{N}_:.#$%&\-+?<>~/]/u;

// A letter or digit before an `@` makes it part of a word; an `_` does not,
// so pandoc cites `a` in `x_@a`.
export const WORD_CHAR = /[\p{L}\p{N}]/u;

/** Whether an odd run of backslashes escapes the character at `at`: `\[` is
 * text, `\\[` a backslash and a bracket. */
function escaped(text: string, at: number): boolean {
  let odd = false;
  for (let i = at - 1; i >= 0 && text[i] === "\\"; i--) {
    odd = !odd;
  }
  return odd;
}

/** Whether the `@` at `at` opens a key: one that follows a letter or digit is
 * part of an e-mail address; an escaped one, `\@`, is text, as in pandoc and
 * as Markdown reads it, while `\\@a` is a backslash and a key. */
function opensKey(text: string, at: number): boolean {
  return at === 0 || !(WORD_CHAR.test(text[at - 1]) || escaped(text, at));
}

/** The `}` that balances the `{` at `open`, or -1: pandoc reads no braced
 * key across a space or without its closing brace. */
function closingBrace(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length && !/\s/.test(text[i]); i++) {
    if (text[i] === "{") {
      depth++;
    } else if (text[i] === "}" && --depth === 0) {
      return i;
    }
  }
  return -1;
}

/**
 * The citation whose key spans `pos`, or null. The key may be empty when the
 * cursor sits right after a fresh `@`, which is what completion waits for.
 * A braced key, `@{key}`, holds any characters but spaces; `from` and `to`
 * include the braces, `key` does not.
 * Outside braces, a letter stored as two UTF-16 code units, such as `𝒜`,
 * counts as no letter and ends the key; pandoc keeps it in the key.
 */
export function citationAt(text: string, pos: number): Citation | null {
  const brace = text.lastIndexOf("@{", pos - 1) + 1;
  const close = brace === 0 ? -1 : closingBrace(text, brace);
  if (close !== -1 && brace <= pos && pos <= close + 1) {
    if (!opensKey(text, brace - 1)) {
      return null;
    }
    return {
      from: brace - 1,
      to: close + 1,
      key: text.slice(brace + 1, close),
    };
  }
  let start = pos;
  while (start > 0 && KEY_CHAR.test(text[start - 1])) start--;
  const at = start - 1;
  if (text[at] !== "@") return null;
  if (!opensKey(text, at)) {
    return null;
  }
  if (start < text.length && !KEY_START.test(text[start]) && start < pos)
    return null;
  let end = pos;
  while (end < text.length && KEY_CHAR.test(text[end])) end++;
  while (end > pos && !KEY_START.test(text[end - 1])) end--;
  if (end === start && start < text.length && KEY_CHAR.test(text[start]))
    return null;
  return { from: at, to: end, key: text.slice(start, end) };
}

/** One cited work inside a citation, with what the citation says about it.
 * The backend reads a locator, "p. 3", off the start of the suffix: the
 * terms it knows come from the citation locale, not from here. */
export interface CitedItem {
  key: string;
  /** Text before the key: "see" in `[see @a]`. */
  prefix: string;
  /** Text after the key, without the comma: "p. 3, emphasis added". */
  suffix: string;
  /** `-@a`: the author is left out, "(2020)" in author-date styles. */
  suppressAuthor: boolean;
}

/** A whole citation in the text, brackets included in `from` and `to`. */
export interface ParsedCitation {
  from: number;
  to: number;
  items: CitedItem[];
  /** The `@a` form outside brackets: "Doe (2020)" rather than "(Doe 2020)". */
  inText: boolean;
  /** Inside a footnote, not at its start: a note style prints it in
   * parentheses. The export and the live view set it, not the parser. */
  inNote?: boolean;
}

/** What follows a key, without the comma that pandoc allows after it. */
function suffixOf(rest: string): string {
  return rest.replace(/^\s*,?\s*/, "").trim();
}

/** One `;`-separated part of a bracket as a cited work, or null without a key.
 * `ats` are the part's `@` outside nested brackets, where a key may start. */
function parseItem(part: string, ats: readonly number[]): CitedItem | null {
  for (const at of ats) {
    const found = citationAt(part, at + 1);
    if (found === null || found.key === "") continue;
    const before = part.slice(0, found.from);
    const suppressAuthor = before.endsWith("-");
    const prefix = (suppressAuthor ? before.slice(0, -1) : before).trim();
    const suffix = suffixOf(part.slice(found.to));
    return { key: found.key, prefix, suffix, suppressAuthor };
  }
  return null;
}

/** For each `[` in `text`, the position of the `]` that balances it, or -1.
 * One pass with a stack, so a long or deeply nested line stays linear. */
function bracketPartners(text: string): Int32Array {
  const partner = new Int32Array(text.length).fill(-1);
  const open: number[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "[") {
      open.push(i);
    } else if (text[i] === "]") {
      const from = open.pop();
      if (from !== undefined) {
        partner[from] = i;
      }
    }
  }
  return partner;
}

/** The cited works of the bracket from `open` to `close`, or null when one
 * `;`-part has no key. A `;` or a key inside a nested bracket belongs to the
 * text, as in pandoc, so the walk skips each nested bracket whole. */
function bracketItems(
  text: string,
  open: number,
  close: number,
  partner: Int32Array,
): CitedItem[] | null {
  const items: CitedItem[] = [];
  let start = open + 1;
  let ats: number[] = [];
  for (let i = open + 1; i <= close; i++) {
    if (i === close || text[i] === ";") {
      const item =
        ats.length === 0 ? null : parseItem(text.slice(start, i), ats);
      if (item === null) {
        return null;
      }
      items.push(item);
      start = i + 1;
      ats = [];
    } else if (text[i] === "[" && partner[i] !== -1) {
      i = partner[i];
    } else if (text[i] === "@") {
      ats.push(i - start);
    }
  }
  return items;
}

/** Whether a link's target or label starts at `at`: the bracket before it,
 * as in `[@a](url)` or `[@a][]`, is link text. A footnote mark, `[@a][^1]`,
 * is no label. */
function opensLink(text: string, at: number): boolean {
  return text[at] === "(" || (text[at] === "[" && text[at + 1] !== "^");
}

/**
 * Every citation in `text`, in order. A bracket is a citation when each of
 * its `;`-separated parts has a key; otherwise its keys count as in-text
 * citations, as pandoc reads them. The same holds for an escaped `\[` and
 * for link text, a bracket right before `(` or `[` but not before a
 * footnote mark `[^`. The bracket ends at the `]` that balances it, so
 * `[@a, p. [3]]` is one citation. Code spans are the caller's business.
 * Outside braces, a letter stored as two UTF-16 code units, such as `𝒜`,
 * ends the key, as in `citationAt`: `[@a𝒜b]` cites `a` with the suffix `𝒜b`,
 * and `@𝒜b` is no citation; pandoc reads the key `a𝒜b` and `𝒜b`.
 * Pandoc reads these otherwise: `@a [@b]` gives two citations, pandoc one;
 * a key in a suffix, `[@a and @b]`, stays suffix text; an in-text locator
 * ends at its first `]`, so `@a [p. [3]]` gives the suffix `p. [3`; `x.@a`
 * cites `a`, where pandoc reads no citation.
 */
export function findCitations(text: string): ParsedCitation[] {
  const citations: ParsedCitation[] = [];
  const partner = bracketPartners(text);
  let pos = 0;
  while (pos < text.length) {
    if (text[pos] === "[" && !escaped(text, pos)) {
      const close = partner[pos];
      if (close !== -1 && !opensLink(text, close + 1)) {
        const items = bracketItems(text, pos, close, partner);
        if (items !== null) {
          citations.push({ from: pos, to: close + 1, items, inText: false });
          pos = close + 1;
          continue;
        }
      }
    } else if (text[pos] === "@") {
      const found = citationAt(text, pos + 1);
      if (found !== null && found.key !== "") {
        // the in-text form may carry its locator in a bracket that is no
        // link text: `@a [p. 3]`, also after one line break, never across a
        // blank line, which ends the paragraph
        const bracket = /^[ \t]*(?:\r?\n[ \t]*)?\[([^\]@]*)\](?![([])/.exec(
          text.slice(found.to),
        );
        const suffix = suffixOf(bracket?.[1] ?? "");
        const to = found.to + (bracket?.[0].length ?? 0);
        const item = {
          key: found.key,
          prefix: "",
          suffix,
          suppressAuthor: false,
        };
        citations.push({ from: found.from, to, items: [item], inText: true });
        pos = to;
        continue;
      }
    }
    pos++;
  }
  return citations;
}

/** The opening fence of a fenced div: three or more colons, attributes in
 * braces as group 1, colons allowed after the braces. */
const DIV_OPEN_RE = /^:{3,}\s*\{(.*)\}\s*:*\s*$/;

/** One attribute as pandoc reads it: `#id` (group 1), `.class` (group 2),
 * `-` for the class unnumbered (group 3), or `key=value` with the value
 * quoted or not. Names hold any letter or digit and `_`, `:`, `.` or `-`. */
const ATTRIBUTE_RE =
  /\s*(?:#([\p{L}\p{N}_:.-]+)|\.([\p{L}\p{N}_:.-]+)|(-)|\p{L}[\p{L}\p{N}_:.-]*=(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s}]*))/uy;

/** The id and classes an opening fence gives its div; null for a line pandoc
 * reads as text, such as one with anything else in the braces. Of two ids
 * the last one counts, as in pandoc. */
function divAttributes(line: string): { id: string; classes: string[] } | null {
  const text = DIV_OPEN_RE.exec(line)?.[1].trim();
  if (text === undefined) {
    return null;
  }
  let id = "";
  const classes: string[] = [];
  ATTRIBUTE_RE.lastIndex = 0;
  while (ATTRIBUTE_RE.lastIndex < text.length) {
    const m = ATTRIBUTE_RE.exec(text);
    if (m === null) {
      return null;
    }
    if (m[1] !== undefined) {
      id = m[1];
    } else if (m[2] !== undefined) {
      classes.push(m[2]);
    } else if (m[3] !== undefined) {
      classes.push("unnumbered");
    }
  }
  return { id, classes };
}

/** Whether the line opens the block pandoc fills with the reference list:
 * `::: {#refs}`, the id among other attributes in any order. */
export function refsOpen(line: string): boolean {
  return divAttributes(line)?.id === "refs";
}

/** A closing fence: three or more colons alone on the line. */
export const REFS_CLOSE_RE = /^:{3,}\s*$/;

/** The classes an opening refs fence gives its block, `.small` as "small";
 * none for any other line. */
export function refsClasses(line: string): string[] {
  const attributes = divAttributes(line);
  return attributes?.id === "refs" ? attributes.classes : [];
}

/** Whether the header sets `key` to true: the boolean, or "t", "true" or
 * "yes" in any case, quoted or not, as pandoc reads a flag; a missing key is
 * false. `key` is a literal header key.
 */
function flagOn(header: string, key: string): boolean {
  const re = new RegExp(`^${key}:[ \\t]*(.*?)[ \\t]*$`, "m");
  const value = re.exec(header)?.[1] ?? "";
  const text = value
    .replace(/[ \t]+#.*$/, "")
    .replace(/^(["'])(.*)\1$/, "$2")
    .toLowerCase();
  return ["t", "true", "yes"].includes(text);
}

/** Whether the header sets `refsegment`, biblatex's name for lists per
 * segment. Pandoc itself does not know the key and ignores it. */
export function refsegmentOn(header: string): boolean {
  return flagOn(header, "refsegment");
}

/** Whether the header sets `suppress-bibliography`: no reference list. */
export function suppressBibliographyOn(header: string): boolean {
  return flagOn(header, "suppress-bibliography");
}

/** A refs block or a citation, in document order; a footnote's citations
 * stand where its mark stands. */
export type SegmentEvent =
  { kind: "block" } | { kind: "cite"; keys: readonly string[] };

/**
 * What each refs block lists: null for every work, else the keys it holds.
 * Without `refsegment` every block lists every work, as in pandoc. With it,
 * a block lists the works cited since the previous block, or since the
 * start; it lists every work when nothing is cited before it in that span or
 * nothing after it at all, and the last block always lists every work.
 */
export function segmentLists(
  events: readonly SegmentEvent[],
  refsegment: boolean,
): (ReadonlySet<string> | null)[] {
  const blocks = events.flatMap((e, i) => (e.kind === "block" ? [i] : []));
  if (!refsegment) return blocks.map(() => null);
  return blocks.map((at, n) => {
    if (n === blocks.length - 1) return null;
    const start = n === 0 ? 0 : blocks[n - 1] + 1;
    const keysOf = (span: readonly SegmentEvent[]) =>
      span.flatMap((e) => (e.kind === "cite" ? e.keys : []));
    const above = keysOf(events.slice(start, at));
    const below = keysOf(events.slice(at + 1));
    return above.length === 0 || below.length === 0 ? null : new Set(above);
  });
}
