import { describe, expect, it } from "vitest";
import { escapeDashes } from "./htmlcomment";

describe("escapeDashes", () => {
  // The invariant is about *runs*: replacing pairs left to right must not leave
  // an adjacent pair behind at any run length, including odd ones where a lone
  // dash is carried over. This is the property three separate copies of the
  // function used to assert only by being identical to each other.
  it("leaves no '--' at any dash-run length", () => {
    for (const n of [2, 3, 4, 5]) {
      const run = "-".repeat(n);
      const out = escapeDashes(JSON.stringify({ v: run }));
      expect(out, `run of ${n}`).not.toContain("--");
      // And it is still parseable JSON that yields the original value: inside a
      // JSON string - is a legal escape for "-", so nothing is lost.
      expect(JSON.parse(out), `run of ${n}`).toEqual({ v: run });
    }
  });

  it("leaves text without a dash pair untouched", () => {
    const json = JSON.stringify({ v: "a-b", n: 1 });
    expect(escapeDashes(json)).toBe(json);
  });

  it("survives embedding in an HTML comment", () => {
    // The reason the function exists: a value must not be able to terminate the
    // comment that carries it.
    const hostile = JSON.stringify({ v: "--> <script>alert(1)</script> <!--" });
    const block = `<!--ml:meta ${escapeDashes(hostile)}-->`;
    // Exactly one comment terminator: the one we wrote.
    expect(block.match(/--&gt;|-->/g)).toHaveLength(1);
    expect(block.endsWith("-->")).toBe(true);
  });
});
