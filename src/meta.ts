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

const META_COMMENT_RE = /<!--ml:meta (\{[\s\S]*?\})-->\r?\n?/;
// Front matter is only front matter at the very top of the file.
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

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
  for (const line of block.split(/\r?\n/)) {
    const m = /^([A-Za-z_]+)\s*:\s*(.*)$/.exec(line);
    if (m === null) continue;
    data[m[1].toLowerCase()] = m[2].trim().replace(/^"(.*)"$|^'(.*)'$/, "$1$2");
  }
  return pickStrings(data);
}

export function parseMeta(text: string): { meta: DocMeta; format: MetaFormat } {
  if (text.startsWith("---")) {
    const fm = FRONTMATTER_RE.exec(text);
    if (fm !== null)
      return { meta: parseYamlish(fm[1]), format: "frontmatter" };
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
  return t.replace(/^(\r?\n)+/, "");
}

function yamlScalar(value: string): string {
  return /[:#"']/.test(value) || /^\s|\s$/.test(value)
    ? JSON.stringify(value)
    : value;
}

/** The metadata block in the chosen format, or "" when every field is blank. */
export function metaBlock(meta: DocMeta, format: MetaFormat): string {
  if (isEmptyMeta(meta)) return "";
  const present = FIELDS.filter((f) => meta[f].trim() !== "");
  if (format === "frontmatter") {
    const lines = present.map((f) => `${f}: ${yamlScalar(meta[f].trim())}`);
    return `---\n${lines.join("\n")}\n---`;
  }
  const obj: Record<string, string> = {};
  for (const f of present) obj[f] = meta[f].trim();
  return `<!--ml:meta ${escapeDashes(JSON.stringify(obj))}-->`;
}

/** Return the document text with its metadata block replaced/inserted at top. */
export function applyMeta(
  text: string,
  meta: DocMeta,
  format: MetaFormat,
): string {
  const body = stripMeta(text);
  const block = metaBlock(meta, format);
  if (block === "") return body;
  return body === "" ? `${block}\n` : `${block}\n\n${body}`;
}
