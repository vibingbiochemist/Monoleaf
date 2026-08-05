import { describe, expect, it } from "vitest";
import { findMath } from "./math";

describe("findMath", () => {
  it("finds inline math", () => {
    const m = findMath("a $x^2$ b", 0);
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({ tex: "x^2", display: false, from: 2, to: 7 });
  });

  it("finds display math", () => {
    const m = findMath("$$a+b$$", 0);
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({ tex: "a+b", display: true });
  });

  it("does not split display delimiters into two inline spans", () => {
    const m = findMath("$$z$$", 0);
    expect(m).toHaveLength(1);
    expect(m[0].display).toBe(true);
  });

  it("leaves currency alone (space before the closing $)", () => {
    expect(findMath("costs $5 and $10 total", 0)).toHaveLength(0);
  });

  it("keeps escaped dollars inside the body", () => {
    const m = findMath("$a \\$ b$", 0);
    expect(m).toHaveLength(1);
    expect(m[0].tex).toBe("a \\$ b");
  });

  it("applies the document offset to positions", () => {
    const m = findMath("$x$", 100);
    expect(m[0].from).toBe(100);
    expect(m[0].to).toBe(103);
  });
});
