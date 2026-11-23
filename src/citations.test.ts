import { describe, expect, it } from "vitest";
import { citationAt } from "./citations";

describe("citationAt", () => {
  const text =
    "As shown by [@doe2020, p. 3; see -@roe:2019]. Mail me@example.org.";
  const at = (needle: string, offset = 0) => text.indexOf(needle) + offset;

  it("finds the key around a position inside it, at its start and at its end", () => {
    const doe = { from: at("@doe"), to: at("@doe") + 8, key: "doe2020" };
    expect(citationAt(text, at("@doe", 1))).toEqual(doe);
    expect(citationAt(text, at("@doe", 4))).toEqual(doe);
    expect(citationAt(text, at("@doe", 8))).toEqual(doe);
  });

  it("keeps internal punctuation and drops a trailing one", () => {
    expect(citationAt(text, at("@roe", 2))?.key).toBe("roe:2019");
    expect(citationAt("See @doe.", 6)?.key).toBe("doe");
  });

  it("gives an empty key right after a fresh @, for completion", () => {
    expect(citationAt("See @", 5)).toEqual({ from: 4, to: 5, key: "" });
  });

  it("is null outside a citation and in an e-mail address", () => {
    expect(citationAt(text, at("shown"))).toBeNull();
    expect(citationAt(text, at("@example", 3))).toBeNull();
    expect(citationAt(text, at("@doe"))).toBeNull();
  });
});
