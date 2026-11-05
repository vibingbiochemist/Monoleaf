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
// Front matter is only front matter at the very top of the file. Three groups:
// the opening fence line, the block between the fences, the closing fence.
const FRONTMATTER_RE =
  /^(---(?:\r\n?|\n))([\s\S]*?)((?:\r\n?|\n)---(?:\r\n?|\n)?)/;
// One front-matter line as the reader takes it: `key: value` at column 0. The
// writer uses the same pattern, so both agree on which line sets a field.
const KEY_VALUE_RE = /^([A-Za-z_]+)\s*:\s*(.*)$/;

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

// A deliberately small "YAML" reader: flat `key: value` scalar lines, which is
// all this metadata ever is. Avoids pulling in a YAML dependency.
function parseYamlish(block: string): DocMeta {
  const data: Record<string, string> = {};
  for (const line of block.split(/\r\n?|\n/)) {
    const m = KEY_VALUE_RE.exec(line);
    if (m === null) continue;
    data[m[1].toLowerCase()] = m[2].trim().replace(/^"(.*)"$|^'(.*)'$/, "$1$2");
  }
  return pickStrings(data);
}

export function parseMeta(text: string): { meta: DocMeta; format: MetaFormat } {
  if (text.startsWith("---")) {
    const fm = FRONTMATTER_RE.exec(text);
    if (fm !== null) {
      const [, , content] = fm;
      return { meta: parseYamlish(content), format: "frontmatter" };
    }
  }
  const c = META_COMMENT_RE.exec(text);
  if (c !== null) {
    try {
      return {
        meta: pickStrings(JSON.parse(c[1]) as Record<string, unknown>),
        format: "comment",
      };
    } catch {
      /* malformed — treat as no metadata */
    }
  }
  return { meta: { ...EMPTY_META }, format: "comment" };
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
 * by line rather than rebuilt. A header also carries keys Monoleaf does not
 * know (pandoc's `bibliography`, `csl`, `lang`, a nested `references:` list),
 * and those lines have to survive a save byte for byte. A field whose value
 * did not change keeps its line as well. Returns "" when no line with content
 * is left.
 */
function mergeFrontmatter(block: string, meta: DocMeta, nl: string): string {
  const current = parseYamlish(block);
  const changed = FIELDS.filter((f) => meta[f].trim() !== current[f]);
  // Changed fields that still have to be written; emptied ones are only removed.
  const pending = new Set(changed.filter((f) => meta[f].trim() !== ""));
  const lines: { text: string; eol: string }[] = [];
  // True while passing the indented or list lines under a replaced field: they
  // are the old value and go with it.
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
    if (inReplaced && /^[ \t-]/.test(text)) continue;
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
  if (format === "frontmatter" && fm !== null) {
    const [whole, open, content, close] = fm;
    const merged = mergeFrontmatter(content, meta, nl);
    if (merged === "") return stripMeta(text);
    return open + merged + close + text.slice(whole.length);
  }
  const body = stripMeta(text);
  const block = metaBlock(meta, format, nl);
  if (block === "") return body;
  return body === "" ? `${block}${nl}` : `${block}${nl}${nl}${body}`;
}
