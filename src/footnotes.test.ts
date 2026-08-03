import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { findInLine, footnoteDefPos, footnoteRefPos } from "./footnotes";

describe("footnote scanner", () => {
  it("classifies a reference", () => {
    const m = findInLine("see [^1] here", 0);
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({ label: "1", kind: "ref", from: 4, to: 8 });
  });

  it("classifies a definition marker and skips its inner ref", () => {
    const m = findInLine("[^1]: the note", 0);
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({ label: "1", kind: "def", from: 0 });
  });

  it("offsets by the line start", () => {
    const m = findInLine("x [^ab]", 100);
    expect(m[0]).toMatchObject({ label: "ab", kind: "ref", from: 102 });
  });
});

describe("footnote position lookup", () => {
  const doc = "body [^a] more\n\n[^a]: the note\n";
  const state = EditorState.create({ doc });

  it("finds the definition line", () => {
    expect(footnoteDefPos(state, "a")).toBe(doc.indexOf("[^a]:"));
  });

  it("finds the first reference (not the definition)", () => {
    expect(footnoteRefPos(state, "a")).toBe(doc.indexOf("[^a]"));
  });

  it("returns null for an unknown label", () => {
    expect(footnoteDefPos(state, "zzz")).toBeNull();
  });
});
