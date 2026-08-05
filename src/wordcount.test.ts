import { describe, expect, it } from "vitest";
import { countWords } from "./wordcount";

describe("countWords", () => {
  it("counts plain words", () => {
    expect(countWords("one two three")).toBe(3);
    expect(countWords("  spaced   out \n words ")).toBe(3);
  });

  it("is zero for empty or symbol-only text", () => {
    expect(countWords("")).toBe(0);
    expect(countWords("--- ## ***")).toBe(0);
  });

  it("counts markdown-formatted words once", () => {
    expect(countWords("**bold** and *italic* text")).toBe(4);
    expect(countWords("# Heading here")).toBe(2);
  });

  it("treats hyphenated and apostrophe words as one", () => {
    expect(countWords("sub-nanomolar can't well-known")).toBe(3);
  });

  it("ignores comment anchors, bodies, and directives", () => {
    const doc =
      'a <!--c:q1s-->real word<!--c:q1e--> here\n\n<!--c:q1 {"resolved":false,"thread":[]}-->\n<!--ml:pagebreak-->\n';
    // "a", "real", "word", "here" = 4
    expect(countWords(doc)).toBe(4);
  });

  it("drops CriticMarkup deletions but keeps insertions", () => {
    expect(countWords("keep {--gone words--} {++added text++} end")).toBe(4);
  });

  it("counts numbers and units", () => {
    expect(countWords("dose 20 mg twice")).toBe(4);
  });
});
