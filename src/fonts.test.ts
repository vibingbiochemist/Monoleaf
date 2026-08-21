import { describe, expect, it } from "vitest";
import {
  DEFAULT_FONT_ID,
  DOCUMENT_FONTS,
  fontFamily,
  fontStack,
  isFontId,
  KNOWN_FAMILIES,
  MONO_FAMILY,
  MONO_STACK,
} from "./fonts";

describe("isFontId", () => {
  it("accepts every bundled font id", () => {
    for (const font of DOCUMENT_FONTS) {
      expect(isFontId(font.id)).toBe(true);
    }
  });

  it("rejects anything not in the bundled set", () => {
    // Values a hostile or malformed ml:page block could plausibly carry —
    // this is the allowlist that keeps an arbitrary string from reaching
    // buildPrintCss's stylesheet (see parsePageConfig in ./export).
    for (const bad of [
      "",
      "Arial",
      "source-serif-4 ",
      "__proto__",
      "constructor",
      undefined,
      null,
      42,
      {},
      ["source-serif-4"],
    ]) {
      expect(isFontId(bad)).toBe(false);
    }
  });
});

describe("fontStack / fontFamily", () => {
  it("is total: an unknown id resolves to the default font, never throws", () => {
    expect(() => fontStack("does-not-exist")).not.toThrow();
    expect(fontStack("does-not-exist")).toBe(fontStack(DEFAULT_FONT_ID));
    expect(fontFamily("does-not-exist")).toBe(fontFamily(DEFAULT_FONT_ID));
  });

  it("quotes the family and appends a fallback tail", () => {
    for (const font of DOCUMENT_FONTS) {
      const stack = fontStack(font.id);
      expect(stack.startsWith(`"${font.family}", `)).toBe(true);
      expect(stack).toContain(fontFamily(font.id));
    }
  });

  it("fontFamily returns exactly the name fontStack quotes first", () => {
    for (const font of DOCUMENT_FONTS) {
      expect(fontStack(font.id).startsWith(`"${fontFamily(font.id)}"`)).toBe(
        true,
      );
    }
  });
});

describe("MONO_STACK / KNOWN_FAMILIES", () => {
  it("declares the bundled mono family first, old stack retained as fallback", () => {
    expect(MONO_STACK.startsWith(`"${MONO_FAMILY}"`)).toBe(true);
    expect(MONO_STACK).toContain("Cascadia Mono");
  });

  it("covers every document font family plus mono, and nothing else", () => {
    expect(KNOWN_FAMILIES.size).toBe(DOCUMENT_FONTS.length + 1);
    for (const font of DOCUMENT_FONTS) {
      expect(KNOWN_FAMILIES.has(font.family)).toBe(true);
    }
    expect(KNOWN_FAMILIES.has(MONO_FAMILY)).toBe(true);
    expect(KNOWN_FAMILIES.has("Arial")).toBe(false);
  });
});

describe("DOCUMENT_FONTS registry", () => {
  it("has a unique id and family for every entry", () => {
    const ids = DOCUMENT_FONTS.map((f) => f.id);
    const families = DOCUMENT_FONTS.map((f) => f.family);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(families).size).toBe(families.length);
  });

  it("DEFAULT_FONT_ID names a real, bundled entry", () => {
    expect(isFontId(DEFAULT_FONT_ID)).toBe(true);
  });

  // Table-driven so a future font addition/removal is forced to update this
  // list deliberately, rather than silently drifting from what ./fontfaces
  // and ./fontEmbeds actually import — this is the one thing that would
  // catch "Lexend has no italic" (or a newly-added font gaining/losing one)
  // regressing unnoticed.
  it.each([
    ["source-serif-4", true],
    ["lora", true],
    ["source-sans-3", true],
    ["atkinson-hyperlegible-next", true],
    ["lexend", false],
  ])("%s.hasItalic === %s", (id, expected) => {
    const font = DOCUMENT_FONTS.find((f) => f.id === id);
    expect(font).toBeDefined();
    expect(font!.hasItalic).toBe(expected);
  });
});
