import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { citationHoverAt, describeReference } from "./citations";

const references = () => ({
  entries: [
    {
      key: "doe2020",
      format: "bib" as const,
      authors: ["Doe, Jane", "Roe, Richard"],
      year: 2020,
      title: "A study",
    },
    { key: "bare", format: "bib" as const, authors: [], year: null, title: "" },
  ],
  warnings: [],
  sources: [],
});

describe("citationHoverAt", () => {
  const text = "See [@doe2020, p. 3] and @nothere. Mail me@example.org.";
  const hover = (pos: number) =>
    citationHoverAt(EditorState.create({ doc: text }), pos, references);

  it("shows the entry over its key, with the range of the citation", () => {
    expect(hover(text.indexOf("doe") + 2)).toEqual({
      from: text.indexOf("@doe"),
      to: text.indexOf(", p. 3"),
      text: "Doe, Jane; Roe, Richard (2020)\nA study",
    });
  });

  it("says so for a key the references do not have", () => {
    expect(hover(text.indexOf("nothere"))?.text).toBe("nothere: not found");
  });

  it("shows nothing outside a citation, in an e-mail address, or on a bare @", () => {
    expect(hover(text.indexOf("See"))).toBeNull();
    expect(hover(text.indexOf("example"))).toBeNull();
    expect(
      citationHoverAt(EditorState.create({ doc: "See @" }), 5, references),
    ).toBeNull();
  });
});

describe("describeReference", () => {
  it("names the gaps instead of leaving them blank", () => {
    expect(describeReference(references().entries[1])).toBe(
      "No author\nNo title",
    );
  });
});
