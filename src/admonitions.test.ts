import { describe, expect, it } from "vitest";
import { ADMONITION_KINDS, admonitionKind } from "./admonitions";

describe("admonitionKind", () => {
  it("recognises each kind, case-insensitively", () => {
    expect(admonitionKind("[!NOTE]")).toBe("note");
    expect(admonitionKind("[!tip]")).toBe("tip");
    expect(admonitionKind("[!Important]")).toBe("important");
    expect(admonitionKind("[!WARNING]")).toBe("warning");
    expect(admonitionKind("[!caution]")).toBe("caution");
  });

  it("accepts a line that still carries its blockquote prefix", () => {
    expect(admonitionKind("> [!NOTE]")).toBe("note");
    expect(admonitionKind(">[!WARNING]")).toBe("warning");
  });

  it("requires the marker to sit alone on the line", () => {
    expect(admonitionKind("[!NOTE] with trailing text")).toBeNull();
    expect(admonitionKind("text then [!NOTE]")).toBeNull();
  });

  it("rejects unknown types and plain quotes", () => {
    expect(admonitionKind("[!INFO]")).toBeNull();
    expect(admonitionKind("> just a quote")).toBeNull();
    expect(admonitionKind("")).toBeNull();
  });

  it("exposes all five kinds in order", () => {
    expect(ADMONITION_KINDS).toEqual([
      "note",
      "tip",
      "important",
      "warning",
      "caution",
    ]);
  });
});
