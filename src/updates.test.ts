import { describe, expect, it } from "vitest";
import { releaseNotesText } from "./updates";

describe("releaseNotesText", () => {
  it("keeps a real body, so there is something to show", () => {
    expect(releaseNotesText("- Fixed a crash\n- Faster export")).toBe(
      "- Fixed a crash\n- Faster export",
    );
  });

  it("treats every way of publishing without notes as no notes", () => {
    // The three shapes that all mean the same thing. The last is what a GitHub
    // release form returns when the body field is opened and left alone, and it
    // is the one that would otherwise slip through a plain `if (notes)`.
    expect(releaseNotesText(null)).toBeNull();
    expect(releaseNotesText("")).toBeNull();
    expect(releaseNotesText("  \n\t\r\n ")).toBeNull();
  });

  it("normalises CRLF, which is what GitHub serves for web-edited bodies", () => {
    // Displayed with white-space: pre-wrap, where a surviving CR is a rendered
    // character rather than a line break.
    expect(releaseNotesText("one\r\ntwo\rthree")).toBe("one\ntwo\nthree");
  });

  it("trims surrounding blank lines without touching the body's own shape", () => {
    expect(releaseNotesText("\n\n# Heading\n\nbody\n\n")).toBe(
      "# Heading\n\nbody",
    );
  });
});
