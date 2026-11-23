/**
 * The references the open document names in its header, as the Rust side
 * reads them (src-tauri/src/references.rs): the list that `@` completion and
 * the hover show. Loaded once per document and header; typing in the body
 * never touches it, and a document without references never asks the backend.
 */

import { invoke } from "@tauri-apps/api/core";
import { namesReferences } from "./citationsyntax";
import { frontMatter } from "./meta";

/** COUPLED: `ReferenceSummary`, `Source` and `LoadedSummaries` in src-tauri/src/references.rs. */
export interface ReferenceSummary {
  key: string;
  authors: string[];
  year: number | null;
  title: string;
  format: ReferenceFormat;
}

/** What a reference was read from: a `.bib` file, or CSL data (a JSON or
 * YAML file, the header's `references:` list). */
export type ReferenceFormat = "bib" | "csl";

/** Where entries came from: `references:` for the inline list, else the
 * path as written in the header; zero entries where the source failed. */
export interface Source {
  name: string;
  entries: number;
}

export interface References {
  entries: ReferenceSummary[];
  warnings: string[];
  sources: Source[];
}

type Loader = (path: string | null, header: string) => Promise<References>;

const NONE: References = { entries: [], warnings: [], sources: [] };
// The header keys that name references, at column 0 as pandoc reads them.
let current = NONE;
let loadedPath: string | null = null;
let loadedHeader: string | null = null;

export function currentReferences(): References {
  return current;
}

const fromBackend: Loader = (documentPath, frontMatter) =>
  invoke<References>("load_references", { documentPath, frontMatter });

/** Have the backend watch the files this header names, for `path`. */
type Watcher = (path: string | null, header: string) => Promise<void>;

const watchBackend: Watcher = (documentPath, frontMatter) =>
  invoke("watch_references", { documentPath, frontMatter });

/**
 * Bring the list in line with the document at `path` and its `text`. Only a
 * changed path or header loads again, and only a header that names references
 * asks the backend. A failed call becomes a warning, so the editor goes on
 * with an empty list. Returns the list that is current afterwards.
 */
export async function syncReferences(
  path: string | null,
  text: string,
  load: Loader = fromBackend,
  watch: Watcher = watchBackend,
): Promise<References> {
  const header = frontMatter(text);
  if (path === loadedPath && header === loadedHeader) return current;
  loadedPath = path;
  loadedHeader = header;
  // Always, so that a header that stopped naming files ends their watches. A
  // watch that cannot be set only means a change goes unnoticed.
  void watch(path, header).catch(() => {});
  if (!namesReferences(header)) {
    current = NONE;
    return current;
  }
  const loaded = await load(path, header).catch((e: unknown) => ({
    entries: [],
    warnings: [`references: ${String(e)}`],
    sources: [],
  }));
  // A newer header or document overtook this load; its result is stale.
  if (path !== loadedPath || header !== loadedHeader) return current;
  current = loaded;
  return current;
}

/** A reference file changed on disk: the next sync loads again, same header. */
export function forgetLoadedReferences(): void {
  loadedHeader = null;
}

function count(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** The status-bar entry: "" for a document without references, else the
 * counts, "4 references, 1 warning". */
export function referencesLabel(refs: References): string {
  if (refs.sources.length === 0 && refs.warnings.length === 0) return "";
  const parts = [count(refs.entries.length, "reference", "references")];
  if (refs.warnings.length > 0)
    parts.push(count(refs.warnings.length, "warning", "warnings"));
  return parts.join(", ");
}

/** One source of the panel's list with the warnings that name it. */
export interface SourceLine {
  name: string;
  summary: string;
  warnings: string[];
}

/** The panel's lines: every source in header order, then any source only a
 * warning names (the header when its YAML did not parse). A warning loses the
 * name it starts with, since its line carries that. */
export function describeSources(refs: References): SourceLine[] {
  const lines: SourceLine[] = refs.sources.map((source) => ({
    name: source.name,
    summary: count(source.entries, "entry", "entries"),
    warnings: [],
  }));
  for (const warning of refs.warnings) {
    const name = warning.slice(0, warning.indexOf(": "));
    let line = lines.find((l) => l.name === name);
    if (line === undefined) {
      line = { name: name || "other", summary: "", warnings: [] };
      lines.push(line);
    }
    line.warnings.push(warning.slice(name.length + 2));
  }
  for (const line of lines) {
    if (line.summary === "0 entries" && line.warnings.length > 0)
      line.summary = "not read";
  }
  return lines;
}

export function resetReferencesForTests(): void {
  current = NONE;
  loadedPath = null;
  loadedHeader = null;
}
