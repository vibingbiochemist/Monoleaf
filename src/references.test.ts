import { beforeEach, describe, expect, it, vi } from "vitest";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import {
  currentReferences,
  describeSources,
  forgetLoadedReferences,
  referencesLabel,
  resetReferencesForTests,
  syncReferences,
  type References,
} from "./references";

const found = {
  entries: [
    { key: "doe", format: "bib" as const, authors: [], year: null, title: "" },
  ],
  warnings: [],
  sources: [{ name: "refs.bib", entries: 1 }],
};
const withBib = "---\ntitle: T\nbibliography: refs.bib\n---\n\nbody\n";
const calls = (command: string) =>
  invokeMock.mock.calls.filter((call) => call[0] === command);

describe("syncReferences", () => {
  beforeEach(() => {
    resetReferencesForTests();
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(found);
  });

  it("never asks the backend for a document without reference keys", async () => {
    const none = { entries: [], warnings: [], sources: [] };
    expect(await syncReferences(null, "# No header\n")).toEqual(none);
    expect(await syncReferences("/d/a.md", "---\ntitle: T\n---\n")).toEqual(
      none,
    );
    expect(calls("load_references")).toHaveLength(0);
  });

  it("loads once per document and header, and again when either changes", async () => {
    expect(await syncReferences("/d/a.md", withBib)).toEqual(found);
    expect(invokeMock).toHaveBeenCalledWith("load_references", {
      documentPath: "/d/a.md",
      frontMatter: "title: T\nbibliography: refs.bib",
    });
    await syncReferences("/d/a.md", withBib.replace("body", "typed"));
    expect(calls("load_references")).toHaveLength(1);
    await syncReferences("/d/a.md", withBib.replace("refs", "other"));
    await syncReferences("/d/b.md", withBib.replace("refs", "other"));
    expect(calls("load_references")).toHaveLength(3);
  });

  it("has the backend watch the files of every header it sees, even one without files", async () => {
    await syncReferences("/d/a.md", withBib);
    await syncReferences("/d/a.md", "---\ntitle: T\n---\n");
    expect(calls("watch_references").map((call) => call[1])).toEqual([
      {
        documentPath: "/d/a.md",
        frontMatter: "title: T\nbibliography: refs.bib",
      },
      { documentPath: "/d/a.md", frontMatter: "title: T" },
    ]);
  });

  it("loads the same header again after a reference file changed", async () => {
    await syncReferences("/d/a.md", withBib);
    forgetLoadedReferences();
    await syncReferences("/d/a.md", withBib);
    expect(calls("load_references")).toHaveLength(2);
  });

  it("drops a result that a newer header overtook", async () => {
    let finishFirst: (refs: References) => void = () => {};
    invokeMock.mockReturnValueOnce(
      new Promise<References>((resolve) => (finishFirst = resolve)),
    );
    const first = syncReferences("/d/a.md", withBib);
    expect(
      await syncReferences("/d/a.md", withBib.replace("refs", "other")),
    ).toEqual(found);
    finishFirst({ ...found, warnings: ["stale"] });
    await first;
    expect(currentReferences()).toEqual(found);
  });

  it("turns a failed call into a warning", async () => {
    // The watch call comes first and must not eat the one rejection.
    invokeMock.mockImplementation((command: string) =>
      command === "load_references"
        ? Promise.reject(new Error("no backend"))
        : Promise.resolve(undefined),
    );
    expect(await syncReferences("/d/a.md", withBib)).toEqual({
      entries: [],
      warnings: ["references: Error: no backend"],
      sources: [],
    });
  });
});

describe("the panel text", () => {
  const loaded: References = {
    entries: [
      { key: "a", format: "bib" as const, authors: [], year: null, title: "" },
    ],
    warnings: [
      "header: entry 2 skipped, it has no id",
      "missing.bib: not found",
      "refs.bib: line 16: entry odd skipped, wrong number of digits",
    ],
    sources: [
      { name: "header", entries: 1 },
      { name: "refs.bib", entries: 3 },
      { name: "missing.bib", entries: 0 },
    ],
  };

  it("labels the status bar with the counts, or not at all", () => {
    expect(referencesLabel({ entries: [], warnings: [], sources: [] })).toBe(
      "",
    );
    expect(referencesLabel({ ...loaded, warnings: [] })).toBe("1 reference");
    expect(referencesLabel(loaded)).toBe("1 reference, 3 warnings");
  });

  it("lists every source with its count and its own warnings", () => {
    expect(describeSources(loaded)).toEqual([
      {
        name: "header",
        summary: "1 entry",
        warnings: ["entry 2 skipped, it has no id"],
      },
      {
        name: "refs.bib",
        summary: "3 entries",
        warnings: ["line 16: entry odd skipped, wrong number of digits"],
      },
      { name: "missing.bib", summary: "not read", warnings: ["not found"] },
    ]);
  });

  it("gives a warning without a source a line of its own", () => {
    const broken: References = {
      entries: [],
      warnings: ["header: bad YAML at line 2"],
      sources: [],
    };
    expect(describeSources(broken)).toEqual([
      { name: "header", summary: "", warnings: ["bad YAML at line 2"] },
    ]);
  });
});
