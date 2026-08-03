import { describe, expect, it } from "vitest";
import { EditorSelection, EditorState } from "@codemirror/state";
import {
  addReplySpec,
  buildCommentDecorations,
  createCommentSpec,
  hideCommentSyntax,
  parseComments,
  setResolvedSpec,
} from "./comments";
import { createDocumentState, serializeDocument } from "./document";

const BODY =
  '<!--c:a1 {"resolved":false,"thread":[{"author":"Martin","ts":"2026-07-18T12:00:00Z","text":"check this"}]}-->';
const DOC = `The affinity <!--c:a1s-->was sub-nanomolar<!--c:a1e--> in assay 2.\n\n${BODY}\n`;

function state(doc: string, anchor = 0, head = anchor): EditorState {
  return EditorState.create({
    doc,
    selection: EditorSelection.single(anchor, head),
  });
}

describe("parseComments", () => {
  it("finds anchors and body of a thread", () => {
    const [t] = parseComments(DOC);
    expect(t.id).toBe("a1");
    expect(t.resolved).toBe(false);
    expect(t.thread).toEqual([
      { author: "Martin", ts: "2026-07-18T12:00:00Z", text: "check this" },
    ]);
    expect(t.anchor).not.toBeNull();
    expect(DOC.slice(t.anchor!.startFrom, t.anchor!.startTo)).toBe(
      "<!--c:a1s-->",
    );
    expect(DOC.slice(t.anchor!.endFrom, t.anchor!.endTo)).toBe("<!--c:a1e-->");
    expect(DOC.slice(t.body!.from, t.body!.to)).toBe(BODY);
  });

  it("tolerates a missing body and a malformed body", () => {
    const doc = "a <!--c:z9s-->b<!--c:z9e--> c\n<!--c:q1 {broken-->\n";
    const threads = parseComments(doc);
    const z9 = threads.find((t) => t.id === "z9")!;
    expect(z9.anchor).not.toBeNull();
    expect(z9.body).toBeNull();
  });
});

describe("createCommentSpec", () => {
  it("wraps the selection and appends a body block", () => {
    const s = state("hello brave world", 6, 11);
    const spec = createCommentSpec(
      s,
      "Martin",
      "why brave?",
      "2026-07-18T12:00:00Z",
    );
    const after = s.update(spec!).state.doc.toString();
    expect(after).toMatch(
      /^hello <!--c:([a-z0-9]+)s-->brave<!--c:\1e--> world\n\n<!--c:\1 \{.*\}-->\n$/,
    );
    const [t] = parseComments(after);
    expect(t.thread[0]).toEqual({
      author: "Martin",
      ts: "2026-07-18T12:00:00Z",
      text: "why brave?",
    });
  });

  it("returns null without a selection", () => {
    expect(createCommentSpec(state("abc", 1), "M", "x", "t")).toBeNull();
  });

  it("respects CRLF line endings for the appended block", () => {
    const s = createDocumentState("one two\r\n");
    const withSel = s.update({
      selection: EditorSelection.single(0, 3),
    }).state;
    const after = withSel.update(
      createCommentSpec(withSel, "M", "x", "t")!,
    ).state;
    expect(serializeDocument(after)).toMatch(
      /^<!--c:([a-z0-9]+)s-->one<!--c:\1e--> two\r\n\r\n<!--c:\1 .*-->\r\n$/,
    );
  });

  it("survives comment text containing -- and --> via dash escaping", () => {
    const s = state("hello world", 0, 5);
    const spec = createCommentSpec(s, "M", "see A --> B -- twice", "t");
    const after = s.update(spec!).state.doc.toString();
    // The body block must still be a single well-formed HTML comment.
    const threads = parseComments(after);
    expect(threads[0].thread[0].text).toBe("see A --> B -- twice");
    // No stray "-->" terminates the block early: the anchors plus one body
    // comment are the only comment closers in the file.
    expect(after.match(/-->/g)).toHaveLength(3);
  });
});

describe("replies and resolution", () => {
  it("addReplySpec appends to the thread", () => {
    const s = state(DOC);
    const after = s.update(
      addReplySpec(s, "a1", { author: "R", ts: "t2", text: "agreed" })!,
    ).state;
    const [t] = parseComments(after.doc.toString());
    expect(t.thread).toHaveLength(2);
    expect(t.thread[1].text).toBe("agreed");
  });

  it("setResolvedSpec toggles and preserves the thread", () => {
    const s = state(DOC);
    const resolved = s.update(setResolvedSpec(s, "a1", true)!).state;
    const [t] = parseComments(resolved.doc.toString());
    expect(t.resolved).toBe(true);
    expect(t.thread).toHaveLength(1);
  });
});

describe("decorations", () => {
  function entries(doc: string, hide: boolean) {
    const s = EditorState.create({
      doc,
      extensions: hide ? hideCommentSyntax.of(true) : [],
    });
    const { decorations } = buildCommentDecorations(s);
    const out: { from: number; to: number; kind: string }[] = [];
    const it = decorations.iter();
    while (it.value !== null) {
      const spec = it.value.spec as { class?: string };
      out.push({ from: it.from, to: it.to, kind: spec.class ?? "hide" });
      it.next();
    }
    return out;
  }

  it("highlights the anchored range; raw view keeps tokens visible", () => {
    const all = entries(DOC, false);
    expect(all).toEqual([{ from: 25, to: 42, kind: "cm-comment-range" }]);
  });

  it("hides anchors and body when live preview requests it", () => {
    const all = entries(DOC, true);
    expect(all.filter((d) => d.kind === "hide")).toHaveLength(3);
    expect(all.filter((d) => d.kind === "cm-comment-range")).toHaveLength(1);
  });

  it("resolved threads get no highlight", () => {
    const resolvedDoc = DOC.replace('"resolved":false', '"resolved":true');
    expect(
      entries(resolvedDoc, false).filter((d) => d.kind === "cm-comment-range"),
    ).toEqual([]);
  });
});
