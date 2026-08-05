import { describe, expect, it } from "vitest";
import {
  collectRecoveryDrafts,
  discardDraft,
  draftName,
  recoveryKey,
  writeDraft,
  type DraftStorage,
} from "./recovery";

/** A stand-in for localStorage with index-ordered keys, as the real one has. */
function fakeStorage(
  entries: [string, string][] = [],
): DraftStorage & { entries: () => string[] } {
  const map = new Map(entries);
  return {
    get length() {
      return map.size;
    },
    key: (i: number) => [...map.keys()][i] ?? null,
    getItem: (k: string) => (map.has(k) ? (map.get(k) as string) : null),
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    entries: () => [...map.keys()],
  };
}

const KEY = recoveryKey("win-1");

describe("recoveryKey", () => {
  it("gives each window its own key so two documents cannot clobber each other", () => {
    expect(recoveryKey("main")).not.toBe(recoveryKey("win-1"));
    expect(recoveryKey("win-1")).toContain("win-1");
    // Every key shares the prefix the startup scan looks for.
    expect(recoveryKey("main").startsWith("monoleaf.recovery.")).toBe(true);
  });
});

describe("the snapshot round trip", () => {
  // The property that actually matters. Writing and reading lived ~60 lines
  // apart in main.ts and nothing checked they agreed; if they ever disagree,
  // unsaved work stops coming back and nothing says so.
  it("reads back exactly what was written", () => {
    const storage = fakeStorage();
    writeDraft(KEY, "C:/work/notes.md", "# Unsaved\n\nbody\n", storage);
    expect(collectRecoveryDrafts(storage)).toEqual([
      { key: KEY, path: "C:/work/notes.md", content: "# Unsaved\n\nbody\n" },
    ]);
  });

  it("round-trips a document that has no file yet", () => {
    const storage = fakeStorage();
    writeDraft(KEY, null, "typed but never saved", storage);
    const [draft] = collectRecoveryDrafts(storage);
    expect(draft.path).toBeNull();
    expect(draft.content).toBe("typed but never saved");
  });

  it("round-trips content that would break a naive format", () => {
    const storage = fakeStorage();
    const awkward = 'quotes " backslash \\ newline\n tab\t emoji 🌿 }{';
    writeDraft(KEY, "C:/a b/c.md", awkward, storage);
    expect(collectRecoveryDrafts(storage)[0].content).toBe(awkward);
  });

  it("collects one draft per window", () => {
    const storage = fakeStorage();
    writeDraft(recoveryKey("main"), null, "one", storage);
    writeDraft(recoveryKey("win-1"), "a.md", "two", storage);
    writeDraft(recoveryKey("win-2"), "b.md", "three", storage);
    expect(
      collectRecoveryDrafts(storage)
        .map((d) => d.content)
        .sort(),
    ).toEqual(["one", "three", "two"]);
  });
});

describe("collectRecoveryDrafts repairs storage", () => {
  it("drops and removes an entry it cannot parse", () => {
    const storage = fakeStorage([[KEY, "{ not json"]]);
    expect(collectRecoveryDrafts(storage)).toEqual([]);
    // Removed, so it is not offered again at every future launch.
    expect(storage.entries()).toEqual([]);
  });

  it("drops an entry with no usable content", () => {
    const storage = fakeStorage([
      [recoveryKey("a"), JSON.stringify({ path: "x.md" })],
      [recoveryKey("b"), JSON.stringify({ path: "x.md", content: 42 })],
    ]);
    expect(collectRecoveryDrafts(storage)).toEqual([]);
    expect(storage.entries()).toEqual([]);
  });

  it("coerces a non-string path to null rather than dropping the content", () => {
    // The content is the irreplaceable part; a bad path is recoverable by
    // treating the draft as untitled.
    const storage = fakeStorage([
      [KEY, JSON.stringify({ path: 17, content: "worth keeping" })],
    ]);
    expect(collectRecoveryDrafts(storage)).toEqual([
      { key: KEY, path: null, content: "worth keeping" },
    ]);
  });

  // The regression this module was extracted to fix. The original removed keys
  // *during* an index-based scan of localStorage: deleting the entry at index i
  // shifts the next one down into i, the loop then advances past it, and a
  // perfectly good draft is silently never offered. Reproduced before the
  // rewrite — the original returned [] for exactly this input.
  it("still finds a valid draft that follows a malformed one", () => {
    const storage = fakeStorage([
      [recoveryKey("win-1"), "{ this is not json"],
      [
        recoveryKey("win-2"),
        JSON.stringify({ path: "C:/work/important.md", content: "# unsaved" }),
      ],
    ]);
    const drafts = collectRecoveryDrafts(storage);
    expect(drafts).toHaveLength(1);
    expect(drafts[0].content).toBe("# unsaved");
    // and the malformed one was still cleaned up
    expect(storage.entries()).toEqual([recoveryKey("win-2")]);
  });

  it("survives a run of malformed entries between valid ones", () => {
    const storage = fakeStorage([
      [recoveryKey("a"), JSON.stringify({ path: null, content: "first" })],
      [recoveryKey("b"), "broken"],
      [recoveryKey("c"), "also broken"],
      [recoveryKey("d"), JSON.stringify({ path: null, content: "last" })],
    ]);
    expect(collectRecoveryDrafts(storage).map((d) => d.content)).toEqual([
      "first",
      "last",
    ]);
  });

  it("never touches keys outside the recovery prefix", () => {
    // This scans the whole of localStorage, which also holds preferences.
    const storage = fakeStorage([
      ["monoleaf.autosave", "true"],
      ["monoleaf.remote-images", "false"],
      ["monoleaf.last-file", "C:/x.md"],
      [KEY, "{ malformed, will be removed"],
      ["unrelated.thing", "keep me"],
    ]);
    collectRecoveryDrafts(storage);
    expect(storage.entries()).toEqual([
      "monoleaf.autosave",
      "monoleaf.remote-images",
      "monoleaf.last-file",
      "unrelated.thing",
    ]);
  });

  it("returns nothing for empty storage", () => {
    expect(collectRecoveryDrafts(fakeStorage())).toEqual([]);
  });
});

describe("writeDraft", () => {
  it("reports failure instead of throwing when storage refuses", () => {
    // Over quota is a reason to skip one snapshot, not to interrupt typing.
    const full: DraftStorage = {
      length: 0,
      key: () => null,
      getItem: () => null,
      setItem: () => {
        throw new DOMException("QuotaExceededError");
      },
      removeItem: () => {},
    };
    expect(() => writeDraft(KEY, null, "x", full)).not.toThrow();
    expect(writeDraft(KEY, null, "x", full)).toBe(false);
  });

  it("reports success on a working storage", () => {
    expect(writeDraft(KEY, null, "x", fakeStorage())).toBe(true);
  });
});

describe("discardDraft", () => {
  it("forgets one window's snapshot and leaves the others", () => {
    const storage = fakeStorage();
    writeDraft(recoveryKey("main"), null, "keep", storage);
    writeDraft(recoveryKey("win-1"), null, "drop", storage);
    discardDraft(recoveryKey("win-1"), storage);
    expect(collectRecoveryDrafts(storage).map((d) => d.content)).toEqual([
      "keep",
    ]);
  });
});

describe("draftName", () => {
  it("names the file, whichever separator the path uses", () => {
    expect(draftName("C:/work/notes.md")).toBe("notes.md");
    expect(draftName("C:\\work\\notes.md")).toBe("notes.md");
    expect(draftName("notes.md")).toBe("notes.md");
  });

  it("describes a document that was never saved", () => {
    expect(draftName(null)).toBe("an untitled document");
    expect(draftName("")).toBe("an untitled document");
  });
});
