import { describe, expect, it } from "vitest";
import { CompletionContext } from "@codemirror/autocomplete";
import { EditorState } from "@codemirror/state";
import { citationCompletions } from "./citations";

const references = () => ({
  entries: [
    {
      key: "doe2020",
      format: "bib" as const,
      authors: ["Doe, Jane"],
      year: 2020,
      title: "A study",
    },
    {
      key: "era5",
      format: "bib" as const,
      authors: ["Copernicus Climate Change Service"],
      year: null,
      title: "ERA5-Land",
    },
  ],
  warnings: [],
  sources: [],
});

// The completions for `text` with the cursor at its end.
const complete = (text: string) => {
  const context = new CompletionContext(
    EditorState.create({ doc: text }),
    text.length,
    false,
  );
  return citationCompletions(context, references);
};

describe("citationCompletions", () => {
  it("offers every reference right after @, with author and year as detail", () => {
    const result = complete("See [@");
    expect(result?.options.map((o) => o.label)).toEqual(["doe2020", "era5"]);
    expect(result?.options[0].detail).toBe("Doe, Jane, 2020");
    expect(result?.options[1].detail).toBe("Copernicus Climate Change Service");
    expect(result).toMatchObject({ from: 6, to: 6, filter: false });
  });

  it("matches the typed part against key, author and title, ignoring case", () => {
    expect(complete("See @DOE")?.options.map((o) => o.label)).toEqual([
      "doe2020",
    ]);
    expect(complete("See @copern")?.options.map((o) => o.label)).toEqual([
      "era5",
    ]);
    expect(complete("See @land")?.options.map((o) => o.label)).toEqual([
      "era5",
    ]);
    expect(complete("See @nothing")).toBeNull();
  });

  it("replaces the whole key, not only the part before the cursor", () => {
    const text = "See @do, p. 3";
    const context = new CompletionContext(
      EditorState.create({ doc: text }),
      7,
      false,
    );
    expect(citationCompletions(context, references)).toMatchObject({
      from: 5,
      to: 7,
    });
  });

  it("stays quiet outside a citation", () => {
    expect(complete("See me@example.org")).toBeNull();
    expect(complete("Nothing here")).toBeNull();
  });
});
