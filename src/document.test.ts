import { describe, expect, it } from "vitest";
import { createDocumentState, serializeDocument } from "./document";

/**
 * The hard requirement from the brief: opening a .md and saving it with no
 * edits must produce a byte-for-byte identical file. The Rust layer is a raw
 * byte passthrough (covered by its own test), so the only place bytes could
 * be rewritten is the load -> EditorState -> serialize path exercised here.
 */

const fixtures: Record<string, string> = {
  "LF with trailing newline": "# Title\n\nBody text.\n",
  "LF without trailing newline": "# Title\n\nBody text.",
  "CRLF (Windows)": "# Title\r\n\r\nBody text.\r\n",
  "CRLF without trailing newline": "# Title\r\n\r\nBody text.",
  "lone CR (classic Mac)": "# Title\r\rBody text.\r",
  "mixed CRLF and LF": "# Title\r\nunix line\nanother\r\nend\n",
  "mixed LF and lone CR": "# Title\nold mac\rend\n",
  "UTF-8 BOM preserved": "\uFEFF# Title\r\nBody\r\n",
  "empty file": "",
  "single newline only": "\n",
  "trailing spaces (markdown hard breaks) and tabs":
    "line with break  \nnext\tline\n\n  indented\n",
  "unicode content": "# Ünïcodé 🌿\r\n中文段落\r\nemoji 👩‍🔬 zwj\r\n",
  "markdown syntax variety":
    "---\ntitle: x\n---\n\n# H1\n\n- [ ] task\n- [x] done\n\n```js\ncode();\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |\n<!-- comment -->\n",
};

const encode = (s: string) => new TextEncoder().encode(s);

describe("lossless round trip (load -> no edits -> save)", () => {
  for (const [name, content] of Object.entries(fixtures)) {
    it(name, () => {
      const state = createDocumentState(content);
      const out = serializeDocument(state);
      expect(out).toBe(content);
      // Compare actual UTF-8 bytes as written to disk, not just JS strings.
      expect(encode(out)).toEqual(encode(content));
    });
  }
});

describe("edits stay consistent with the file's separator", () => {
  it("state.lineBreak reflects a CRLF document", () => {
    const state = createDocumentState("a\r\nb\r\n");
    expect(state.lineBreak).toBe("\r\n");
  });

  it("inserting a line break in a CRLF document emits CRLF", () => {
    const state = createDocumentState("a\r\nb");
    const tr = state.update({
      changes: { from: state.doc.length, insert: state.lineBreak },
    });
    expect(serializeDocument(tr.state)).toBe("a\r\nb\r\n");
  });

  it("state.lineBreak defaults to LF for LF documents", () => {
    const state = createDocumentState("a\nb\n");
    expect(state.lineBreak).toBe("\n");
  });
});
