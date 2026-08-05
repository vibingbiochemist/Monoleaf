import { describe, expect, it } from "vitest";
import { EditorSelection, EditorState } from "@codemirror/state";
import {
  acceptAllChanges,
  acceptAtCursor,
  buildCriticDecorations,
  hideCriticSyntax,
  parseCritic,
  rejectAllChanges,
  rejectAtCursor,
  trackingExtension,
} from "./critic";
import { createDocumentState, serializeDocument } from "./document";

function tracked(doc: string, anchor: number, head = anchor): EditorState {
  return EditorState.create({
    doc,
    selection: EditorSelection.single(anchor, head),
    extensions: trackingExtension(),
  });
}

function apply(
  state: EditorState,
  changes: { from: number; to?: number; insert?: string },
  userEvent: string,
) {
  const tr = state.update({ changes, userEvent });
  return {
    doc: tr.state.doc.toString(),
    cursor: tr.state.selection.main.head,
    state: tr.state,
  };
}

describe("parseCritic", () => {
  it("parses all five notations", () => {
    const doc =
      "a {++ins++} b {--del--} c {~~old~>new~~} d {==mark==} e {>>note<<}";
    expect(parseCritic(doc).map((r) => r.kind)).toEqual([
      "insertion",
      "deletion",
      "substitution",
      "highlight",
      "comment",
    ]);
  });

  it("substitution segments point at old and new", () => {
    const doc = "x {~~old~>new~~} y";
    const [r] = parseCritic(doc);
    expect(doc.slice(r.segments[0].from, r.segments[0].to)).toBe("old");
    expect(doc.slice(r.segments[1].from, r.segments[1].to)).toBe("new");
  });
});

describe("suggesting mode: typing", () => {
  it("wraps typed text as an insertion, cursor inside", () => {
    const r = apply(tracked("ab", 1), { from: 1, insert: "X" }, "input.type");
    expect(r.doc).toBe("a{++X++}b");
    expect(r.cursor).toBe(5); // before "++}"
  });

  it("continues typing inside the insertion without new markup", () => {
    const s = tracked("a{++X++}b", 5);
    const r = apply(s, { from: 5, insert: "Y" }, "input.type");
    expect(r.doc).toBe("a{++XY++}b");
  });

  it("typing right after an insertion extends it", () => {
    const s = tracked("a{++X++}b", 8);
    const r = apply(s, { from: 8, insert: "Y" }, "input.type");
    expect(r.doc).toBe("a{++XY++}b");
  });

  it("typing inside deleted text relocates after the deletion", () => {
    const s = tracked("a{--gone--}b", 6);
    const r = apply(s, { from: 6, insert: "X" }, "input.type");
    expect(r.doc).toBe("a{--gone--}{++X++}b");
  });
});

describe("suggesting mode: deleting", () => {
  it("keeps deleted text wrapped in {--…--}", () => {
    const r = apply(tracked("abc", 2), { from: 1, to: 2 }, "delete.backward");
    expect(r.doc).toBe("a{--b--}c");
    expect(r.cursor).toBe(1);
  });

  it("merges a backspace run into one deletion", () => {
    const s = tracked("ab{--c--}d", 2);
    const r = apply(s, { from: 1, to: 2 }, "delete.backward");
    expect(r.doc).toBe("a{--bc--}d");
  });

  it("stepping backspace over already-deleted text moves the cursor only", () => {
    const s = tracked("a{--b--}c", 1);
    const r = apply(s, { from: 1, to: 8 }, "delete.backward");
    expect(r.doc).toBe("a{--b--}c");
    expect(r.cursor).toBe(1);
  });

  it("retracts the last character of an own insertion (atomic ++} delete)", () => {
    const s = tracked("a{++XY++}b", 6);
    const r = apply(s, { from: 6, to: 9 }, "delete.backward");
    expect(r.doc).toBe("a{++X++}b");
    expect(r.cursor).toBe(5);
  });

  it("removes an insertion entirely when its last character is retracted", () => {
    const s = tracked("a{++X++}b", 5);
    const r1 = apply(s, { from: 4, to: 5 }, "delete.backward");
    expect(r1.doc).toBe("a{++++}b");
    const r2 = apply(r1.state, { from: 4, to: 7 }, "delete.backward");
    expect(r2.doc).toBe("ab");
  });

  it("deleting a selection of plain text wraps it", () => {
    const r = apply(
      tracked("hello world", 0, 5),
      { from: 0, to: 5 },
      "delete.selection",
    );
    expect(r.doc).toBe("{--hello--} world");
  });
});

describe("suggesting mode: substitutions", () => {
  it("type-over becomes a substitution, cursor in the new half", () => {
    const r = apply(
      tracked("the old dose", 4, 7),
      { from: 4, to: 7, insert: "new" },
      "input.type",
    );
    expect(r.doc).toBe("the {~~old~>new~~} dose");
    expect(r.cursor).toBe(15); // before "~~}"
  });

  it("keeps typing inside the substitution's new half", () => {
    const s = tracked("the {~~old~>new~~} dose", 15);
    const r = apply(s, { from: 15, insert: "er" }, "input.type");
    expect(r.doc).toBe("the {~~old~>newer~~} dose");
  });
});

describe("suggesting mode passes other events through", () => {
  it("formatting commands are not tracked", () => {
    const r = apply(
      tracked("ab", 1),
      { from: 1, insert: "**" },
      "input.format",
    );
    expect(r.doc).toBe("a**b");
  });
});

describe("CRLF documents", () => {
  it("wraps a deleted CRLF selection with the separator intact", () => {
    const base = createDocumentState("one\r\ntwo\r\n", [trackingExtension()]);
    const withSel = base.update({
      selection: EditorSelection.single(0, 7),
    }).state;
    const tr = withSel.update({
      changes: { from: 0, to: 7 },
      userEvent: "delete.selection",
    });
    // Positions count line breaks as 1 unit, so [0,7] covers "one\r\ntwo".
    expect(serializeDocument(tr.state)).toBe("{--one\r\ntwo--}\r\n");
  });
});

describe("accept and reject", () => {
  function run(cmd: typeof acceptAtCursor, doc: string, pos: number) {
    const state = EditorState.create({
      doc,
      selection: EditorSelection.single(pos),
    });
    let out = doc;
    cmd({
      state,
      dispatch: (tr) => {
        out = tr.state.doc.toString();
      },
    });
    return out;
  }

  it("accepts an insertion (keeps text, drops markup)", () => {
    expect(run(acceptAtCursor, "a{++X++}b", 5)).toBe("aXb");
  });

  it("rejects an insertion (removes it)", () => {
    expect(run(rejectAtCursor, "a{++X++}b", 5)).toBe("ab");
  });

  it("accepts a deletion (text goes away)", () => {
    expect(run(acceptAtCursor, "a{--X--}b", 5)).toBe("ab");
  });

  it("rejects a deletion (text stays)", () => {
    expect(run(rejectAtCursor, "a{--X--}b", 5)).toBe("aXb");
  });

  it("accepts a substitution (new text wins)", () => {
    expect(run(acceptAtCursor, "a {~~old~>new~~} b", 5)).toBe("a new b");
  });

  it("rejects a substitution (old text stays)", () => {
    expect(run(rejectAtCursor, "a {~~old~>new~~} b", 5)).toBe("a old b");
  });

  it("accepting jumps the cursor to the next change (wrapping)", () => {
    const doc = "a{++X++}b {--Y--}c";
    const state = EditorState.create({
      doc,
      selection: EditorSelection.single(4),
    });
    let out: EditorState | null = null;
    acceptAtCursor({
      state,
      dispatch: (tr) => {
        out = tr.state;
      },
    });
    const after = out as unknown as EditorState;
    expect(after.doc.toString()).toBe("aXb {--Y--}c");
    // Cursor lands on the remaining deletion region.
    expect(after.selection.main.head).toBe("aXb ".length);
  });

  it("accept all / reject all sweep every actionable region", () => {
    const doc = "a{++X++} {--Y--} {~~o~>n~~} {==keep==}";
    expect(run(acceptAllChanges, doc, 0)).toBe("aX  n {==keep==}");
    expect(run(rejectAllChanges, doc, 0)).toBe("a Y o {==keep==}");
  });
});

describe("decorations", () => {
  function entries(doc: string, hideSyntax: boolean) {
    const state = EditorState.create({
      doc,
      extensions: hideSyntax ? hideCriticSyntax.of(true) : [],
    });
    const { decorations } = buildCriticDecorations(state);
    const out: { from: number; to: number; kind: string }[] = [];
    const it = decorations.iter();
    while (it.value !== null) {
      out.push({
        from: it.from,
        to: it.to,
        kind: (it.value.spec as { class?: string }).class ?? "hide",
      });
      it.next();
    }
    return out;
  }

  it("hides tokens and styles content in live view", () => {
    const all = entries("a{++X++}b", true);
    expect(all).toEqual([
      { from: 1, to: 4, kind: "hide" },
      { from: 4, to: 5, kind: "cm-critic-ins" },
      { from: 5, to: 8, kind: "hide" },
    ]);
  });

  it("marks tokens dimly in raw view", () => {
    const all = entries("a{--X--}b", false);
    expect(all.map((d) => d.kind)).toEqual([
      "cm-critic-token",
      "cm-critic-del",
      "cm-critic-token",
    ]);
  });

  it("substitution renders old as deletion and new as insertion", () => {
    const kinds = entries("{~~o~>n~~}", true).map((d) => d.kind);
    expect(kinds).toEqual([
      "hide",
      "cm-critic-del",
      "hide",
      "cm-critic-ins",
      "hide",
    ]);
  });
});
