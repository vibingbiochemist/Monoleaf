import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The document corpus the round-trip and export-snapshot suites run over:
 * samples/ plus src/__fixtures__/roundtrip/, which is the place for real
 * documents written with earlier versions of Monoleaf.
 *
 * Fixtures are committed with `-text` (see .gitattributes), so a CRLF file
 * stays CRLF on every checkout and CI exercises Windows line endings even on
 * Linux. samples/ follows core.autocrlf, so its bytes differ by platform; both
 * suites compare against whatever is on disk, which is what the app would read.
 */

const ROOT = join(__dirname, "..");
const SOURCES = [
  { prefix: "samples", dir: join(ROOT, "samples") },
  { prefix: "fixtures", dir: join(ROOT, "src", "__fixtures__", "roundtrip") },
];

export interface CorpusFile {
  /** "samples/x.md" or "fixtures/x.md": unique, stable across platforms. */
  name: string;
  bytes: Buffer;
}

export function loadCorpus(): CorpusFile[] {
  const files: CorpusFile[] = [];
  for (const { prefix, dir } of SOURCES) {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue; // an absent fixtures folder is not an error
    }
    for (const entry of entries.sort()) {
      if (!/\.(md|markdown)$/i.test(entry)) continue;
      files.push({
        name: `${prefix}/${entry}`,
        bytes: readFileSync(join(dir, entry)),
      });
    }
  }
  return files;
}
