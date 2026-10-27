import { describe, expect, it } from "vitest";
import { editorMaxWidthCss, parseEditorWidth } from "./editorwidth";

describe("parseEditorWidth", () => {
  it("keeps a known choice", () => {
    expect(parseEditorWidth("wide")).toBe("wide");
    expect(parseEditorWidth("full")).toBe("full");
  });

  it("falls back to standard for missing or unknown values", () => {
    expect(parseEditorWidth(null)).toBe("standard");
    expect(parseEditorWidth("")).toBe("standard");
    expect(parseEditorWidth("huge")).toBe("standard");
    expect(parseEditorWidth("toString")).toBe("standard");
  });
});

describe("editorMaxWidthCss", () => {
  it("scales the cap with zoom", () => {
    expect(editorMaxWidthCss("standard", 100)).toBe("1000px");
    expect(editorMaxWidthCss("wide", 150)).toBe("2100px");
  });

  it("does not cap full window", () => {
    expect(editorMaxWidthCss("full", 200)).toBe("100%");
  });
});
