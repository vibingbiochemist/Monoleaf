import { escapeDashes } from "./htmlcomment";

/**
 * Document metadata (title / author / date / subject / keywords). Stored in
 * the single .md, round-trip-safe, in one of two formats:
 *   - "comment"     — an invisible <!--ml:meta {json}--> block (default; like
 *                     the page-config block, hidden on GitHub and to readers).
 *   - "frontmatter" — a leading `---\n…\n---` YAML block (the ecosystem
 *                     standard, read by pandoc/Obsidian/etc.).
 * Parsing accepts either; the format only controls what gets written.
 */
export interface DocMeta {
  title: string;
  author: string;
  date: string;
  subject: string;
  keywords: string;
}

export type MetaFormat = "comment" | "frontmatter";

export const EMPTY_META: DocMeta = {
  title: "",
  author: "",
  date: "",
  subject: "",
  keywords: "",
};

const FIELDS: (keyof DocMeta)[] = [
  "title",
  "author",
  "date",
  "subject",
  "keywords",
];

// Line breaks are matched as LF, CRLF or a lone CR alike: the text is the file
// in its own line endings (see applyMeta), and a classic-Mac CR file is as
// entitled to its metadata as a Windows one.
const META_COMMENT_RE = /<!--ml:meta (\{[\s\S]*?\})-->(?:\r\n?|\n)?/;
// Front matter is only front matter at the very top of the file.
const FRONTMATTER_RE =
  /^(---(?:\r\n?|\n))([\s\S]*?)((?:\r\n?|\n)---(?:\r\n?|\n)?)/;
// One front-matter line as the reader takes it: `key: value` at column 0. The
// writer uses the same pattern, so both agree on which line sets a field.
const KEY_VALUE_RE = /^([A-Za-z_]+)\s*:\s*(.*)$/;
// A line that carries on the value of the key above: indented, or a list item.
const VALUE_LINE_RE = /^[ \t-]/;
// One item of a plain list, `- Jane`. An item that is a `key: value` pair of
// its own (`- name: Jane`) is a nested entry and does not match.
const LIST_ITEM_RE = /^\s*-\s+(?![A-Za-z_][\w-]*\s*:(?:\s|$))(.+)$/;

export function isEmptyMeta(meta: DocMeta): boolean {
  return FIELDS.every((f) => meta[f].trim() === "");
}

function pickStrings(data: Record<string, unknown>): DocMeta {
  const meta = { ...EMPTY_META };
  for (const f of FIELDS) {
    if (typeof data[f] === "string") meta[f] = data[f] as string;
  }
  return meta;
}

function unquote(value: string): string {
  return value.trim().replace(/^"(.*)"$|^'(.*)'$/, "$1$2");
}

// A deliberately small "YAML" reader: flat `key: value` scalar lines, which is
// all this metadata ever is. Avoids pulling in a YAML dependency.
//
// pandoc also takes a field as a list (`author:` over `- Jane`, `- John`) or
// as a block. One line of text cannot hold that, so such a field is reported
// in `locked` and never rewritten. A plain list still reads as "Jane, John",
// so that there is something to show; any other block reads as empty.
function parseYamlish(block: string): {
  meta: DocMeta;
  locked: (keyof DocMeta)[];
} {
  const data: Record<string, string> = {};
  const below = new Map<string, string[]>();
  let valueLines: string[] | null = null;
  for (const line of block.split(/\r\n?|\n/)) {
    const m = KEY_VALUE_RE.exec(line);
    if (m !== null) {
      valueLines = [];
      below.set(m[1].toLowerCase(), valueLines);
      data[m[1].toLowerCase()] = unquote(m[2]);
    } else if (valueLines !== null && VALUE_LINE_RE.test(line)) {
      valueLines.push(line);
    } else {
      valueLines = null;
    }
  }
  const locked = FIELDS.filter((f) => (below.get(f) ?? []).length > 0);
  for (const f of locked) {
    const lines = below.get(f) ?? [];
    // A line that is no plain item adds nothing, so fewer items than lines
    // means the value is more than a plain list.
    const items = lines.flatMap((l) => LIST_ITEM_RE.exec(l)?.slice(1) ?? []);
    const plain = data[f] === "" && items.length === lines.length;
    data[f] = plain ? items.map(unquote).join(", ") : "";
  }
  return { meta: pickStrings(data), locked };
}

/** The document's metadata, the format it is stored in, and the fields the
 * header holds as a list or block (see parseYamlish): those are for showing,
 * not for editing as one line of text. */
export function parseMeta(text: string): {
  meta: DocMeta;
  format: MetaFormat;
  locked: (keyof DocMeta)[];
} {
  let header = parseYamlish("");
  const fm = text.startsWith("---") ? FRONTMATTER_RE.exec(text) : null;
  if (fm !== null) {
    const [, , content] = fm;
    header = parseYamlish(content);
  }
  // A header that sets none of the fields as a line of text belongs to other
  // tools; the values are then in the comment below it, if there is one.
  const inHeader = FIELDS.some(
    (f) => header.meta[f] !== "" && !header.locked.includes(f),
  );
  const c = inHeader ? null : META_COMMENT_RE.exec(text);
  if (c !== null) {
    try {
      const meta = pickStrings(JSON.parse(c[1]) as Record<string, unknown>);
      for (const f of header.locked) meta[f] = header.meta[f];
      return { meta, format: "comment", locked: header.locked };
    } catch {
      /* malformed — treat as no metadata */
    }
  }
  return { ...header, format: fm !== null ? "frontmatter" : "comment" };
}

/** The text between the fences of a leading front matter, or "" without one. */
export function frontMatter(text: string): string {
  const fm = text.startsWith("---") ? FRONTMATTER_RE.exec(text) : null;
  if (fm === null) return "";
  const [, , content] = fm;
  return content;
}

/** Remove any metadata block (front matter or ml:meta comment) from the text. */
export function stripMeta(text: string): string {
  let t = text;
  if (t.startsWith("---") && FRONTMATTER_RE.test(t)) {
    t = t.replace(FRONTMATTER_RE, "");
  } else {
    t = t.replace(META_COMMENT_RE, "");
  }
  return t.replace(/^(?:\r\n?|\n)+/, "");
}

function yamlScalar(value: string): string {
  return /[:#"']/.test(value) || /^\s|\s$/.test(value)
    ? JSON.stringify(value)
    : value;
}

/** The metadata block in the chosen format, or "" when every field is blank.
 * `nl` is the document's line break (state.lineBreak), so a block written into
 * a CRLF or CR file uses that file's endings rather than adding LF ones. */
export function metaBlock(
  meta: DocMeta,
  format: MetaFormat,
  nl = "\n",
): string {
  if (isEmptyMeta(meta)) return "";
  const present = FIELDS.filter((f) => meta[f].trim() !== "");
  if (format === "frontmatter") {
    const lines = present.map((f) => fieldLine(f, meta));
    return `---${nl}${lines.join(nl)}${nl}---`;
  }
  const obj: Record<string, string> = {};
  for (const f of present) obj[f] = meta[f].trim();
  return `<!--ml:meta ${escapeDashes(JSON.stringify(obj))}-->`;
}

function fieldLine(field: keyof DocMeta, meta: DocMeta): string {
  return `${field}: ${yamlScalar(meta[field].trim())}`;
}

/** The metadata field a front-matter line sets, or null for any other line. */
function fieldOfLine(line: string): keyof DocMeta | null {
  const key = KEY_VALUE_RE.exec(line)?.[1].toLowerCase();
  return FIELDS.find((f) => f === key) ?? null;
}

/**
 * The front-matter block with the metadata fields set to `meta`, edited line
 * by line rather than rebuilt: a header also carries keys Monoleaf does not
 * know (pandoc's `csl`, a nested `references:` list), and those lines have to
 * survive a save byte for byte. Returns "" when no line with content is left.
 */
function mergeFrontmatter(block: string, meta: DocMeta, nl: string): string {
  const { meta: current, locked } = parseYamlish(block);
  const changed = FIELDS.filter(
    (f) => !locked.includes(f) && meta[f].trim() !== current[f],
  );
  // Changed fields still to be written; emptied ones are only removed.
  const pending = new Set(changed.filter((f) => meta[f].trim() !== ""));
  const lines: { text: string; eol: string }[] = [];
  // True while passing the old value lines under a replaced field.
  let inReplaced = false;
  // Split with the line breaks captured, so every line keeps its own.
  const parts = block.split(/(\r\n?|\n)/);
  for (let i = 0; i < parts.length; i += 2) {
    const text = parts[i];
    const eol = parts[i + 1] ?? nl;
    const field = fieldOfLine(text);
    if (field !== null && changed.includes(field)) {
      inReplaced = true;
      if (pending.delete(field))
        lines.push({ text: fieldLine(field, meta), eol });
      continue;
    }
    if (inReplaced && VALUE_LINE_RE.test(text)) continue;
    inReplaced = false;
    lines.push({ text, eol });
  }
  for (const f of FIELDS)
    if (pending.has(f)) lines.push({ text: fieldLine(f, meta), eol: nl });
  if (lines.every((l) => l.text.trim() === "")) return "";
  // The closing fence brings the last line's break with it.
  const last = lines.length - 1;
  return lines.map((l, i) => (i < last ? l.text + l.eol : l.text)).join("");
}

/** Return the document text with its metadata block replaced/inserted at top.
 * `text` is the serialized document and `nl` its line break, see metaBlock. */
export function applyMeta(
  text: string,
  meta: DocMeta,
  format: MetaFormat,
  nl = "\n",
): string {
  const fm = text.startsWith("---") ? FRONTMATTER_RE.exec(text) : null;
  let body = stripMeta(text);
  let block = metaBlock(meta, format, nl);
  if (fm !== null) {
    // The header stays for the keys Monoleaf does not know and for fields held
    // as a list or block; only one-line fields move between it and the comment.
    const [whole, open, content, close] = fm;
    const rest = text.slice(whole.length);
    const asHeader = format === "frontmatter";
    const merged = mergeFrontmatter(content, asHeader ? meta : EMPTY_META, nl);
    if (asHeader && merged !== "" && !META_COMMENT_RE.test(rest))
      return open + merged + close + rest;
    const forComment = { ...meta };
    for (const f of parseYamlish(content).locked) forComment[f] = "";
    const header = merged === "" ? "" : open + merged + close.trimEnd();
    const comment = asHeader ? "" : metaBlock(forComment, "comment", nl);
    block = [header, comment].filter((part) => part !== "").join(nl + nl);
    body = rest.replace(META_COMMENT_RE, "").replace(/^(?:\r\n?|\n)+/, "");
  }
  if (block === "") return body;
  return body === "" ? `${block}${nl}` : `${block}${nl}${nl}${body}`;
}
