import { describe, expect, it } from "vitest";
import { clampSelection, coalesce, decideExternalChange } from "./filewatch";

describe("decideExternalChange", () => {
  it("ignores Monoleaf's own save", () => {
    // Saved "v2", then the user kept typing before the event arrived.
    expect(
      decideExternalChange({
        diskText: "v2",
        lastKnownText: "v2",
        editorText: "v2 and more",
        dirty: true,
      }),
    ).toBe("ignore");
  });

  it("ignores a rewrite that left the bytes alone", () => {
    expect(
      decideExternalChange({
        diskText: "same",
        lastKnownText: "same",
        editorText: "same plus edit",
        dirty: true,
      }),
    ).toBe("ignore");
  });

  it("reloads a genuine external edit when nothing is unsaved", () => {
    expect(
      decideExternalChange({
        diskText: "v1 {>>comment<<}",
        lastKnownText: "v1",
        editorText: "v1",
        dirty: false,
      }),
    ).toBe("reload");
  });

  it("asks before discarding unsaved edits", () => {
    expect(
      decideExternalChange({
        diskText: "v1 {>>comment<<}",
        lastKnownText: "v1",
        editorText: "v1 typed",
        dirty: true,
      }),
    ).toBe("prompt");
  });

  it("adopts a disk version that already matches the editor", () => {
    // Another tool saved exactly what is on screen: nothing to load, nothing to
    // lose, and the document is no longer unsaved.
    expect(
      decideExternalChange({
        diskText: "v1 typed",
        lastKnownText: "v1",
        editorText: "v1 typed",
        dirty: true,
      }),
    ).toBe("adopt");
  });

  it("reloads when only the dirty flag is set and nothing would be lost", () => {
    // The file was deleted (which marks the document unsaved) and then came
    // back with new text; the editor still holds the old disk version.
    expect(
      decideExternalChange({
        diskText: "v2",
        lastKnownText: "v1",
        editorText: "v1",
        dirty: true,
      }),
    ).toBe("reload");
  });

  it("asks when the text differs even if the flag says clean", () => {
    expect(
      decideExternalChange({
        diskText: "v2",
        lastKnownText: "v1",
        editorText: "v1 typed",
        dirty: false,
      }),
    ).toBe("prompt");
  });

  it("adopts a deleted file that came back unchanged", () => {
    // Removal marked the document dirty; the file reappearing with the same
    // text (a git checkout, a sync client) makes it clean again.
    expect(
      decideExternalChange({
        diskText: "v1",
        lastKnownText: "v1",
        editorText: "v1",
        dirty: true,
      }),
    ).toBe("adopt");
  });

  it("treats a recovered draft with no baseline as unsaved work", () => {
    expect(
      decideExternalChange({
        diskText: "on disk",
        lastKnownText: null,
        editorText: "recovered draft",
        dirty: true,
      }),
    ).toBe("prompt");
  });

  it("compares line endings exactly", () => {
    // A tool that only converted CRLF to LF still changed the file, and a
    // lossless editor must not pretend otherwise.
    expect(
      decideExternalChange({
        diskText: "a\nb\n",
        lastKnownText: "a\r\nb\r\n",
        editorText: "a\r\nb\r\n",
        dirty: false,
      }),
    ).toBe("reload");
  });
});

describe("clampSelection", () => {
  it("keeps a selection that still fits", () => {
    expect(clampSelection(3, 7, 10)).toEqual({ anchor: 3, head: 7 });
  });

  it("pulls a selection past the new end back to it", () => {
    expect(clampSelection(8, 20, 5)).toEqual({ anchor: 5, head: 5 });
    expect(clampSelection(2, 20, 5)).toEqual({ anchor: 2, head: 5 });
  });

  it("handles an emptied document", () => {
    expect(clampSelection(4, 4, 0)).toEqual({ anchor: 0, head: 0 });
  });
});

describe("coalesce", () => {
  /** A promise plus the function that settles it. */
  function gate() {
    let open!: () => void;
    const promise = new Promise<void>((resolve) => (open = resolve));
    return { promise, open };
  }

  it("never runs two at once and folds a burst into one follow-up", async () => {
    let runs = 0;
    let concurrent = 0;
    let maxConcurrent = 0;
    const gates = [gate(), gate()];
    const run = coalesce(async () => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      const g = gates[runs++];
      await g.promise;
      concurrent--;
    });

    const first = run();
    // Three more events while the first is still waiting (on a dialog, say).
    void run();
    void run();
    void run();
    expect(runs).toBe(1);

    gates[0].open();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(runs).toBe(2);
    gates[1].open();
    await first;

    expect(runs).toBe(2);
    expect(maxConcurrent).toBe(1);
  });

  it("starts afresh once idle", async () => {
    let runs = 0;
    const run = coalesce(async () => {
      runs++;
    });
    await run();
    await run();
    expect(runs).toBe(2);
  });
});
