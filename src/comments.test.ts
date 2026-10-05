import { describe, expect, it } from "vitest";
import { EditorSelection, EditorState } from "@codemirror/state";
import { history, undo } from "@codemirror/commands";
import {
  addReplySpec,
  buildCommentDecorations,
  createCommentSpec,
  deleteResolvedSpec,
  deleteThreadSpec,
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

describe("deleting threads", () => {
  function body(id: string, resolved = false, texts = ["note"]): string {
    const thread = texts.map((text) => ({ author: "M", ts: "t", text }));
    return `<!--c:${id} ${JSON.stringify({ resolved, thread })}-->`;
  }

  function del(doc: string, id: string): string {
    const s = createDocumentState(doc);
    return serializeDocument(s.update(deleteThreadSpec(s, id)!).state);
  }

  function delResolved(doc: string): string {
    const s = createDocumentState(doc);
    return serializeDocument(s.update(deleteResolvedSpec(s)!).state);
  }

  it("removes an open thread's anchors and body, keeping the text", () => {
    expect(del(DOC, "a1")).toBe("The affinity was sub-nanomolar in assay 2.\n");
  });

  it("removes a resolved thread", () => {
    const doc = DOC.replace('"resolved":false', '"resolved":true');
    expect(del(doc, "a1")).toBe("The affinity was sub-nanomolar in assay 2.\n");
  });

  it("removes a thread with replies", () => {
    const s = state(DOC);
    const replied = s.update(
      addReplySpec(s, "a1", { author: "R", ts: "t2", text: "agreed" })!,
    ).state;
    const after = replied.update(deleteThreadSpec(replied, "a1")!).state;
    expect(after.doc.toString()).toBe(
      "The affinity was sub-nanomolar in assay 2.\n",
    );
    expect(parseComments(after.doc.toString())).toEqual([]);
  });

  it("undoes creating a comment exactly", () => {
    for (const original of [
      "hello brave world\n",
      "# Title\n\nhello brave world\n\nlast paragraph\n",
    ]) {
      const from = original.indexOf("brave");
      const s = state(original, from, from + 5);
      const created = s.update(createCommentSpec(s, "M", "x", "t")!).state;
      const [t] = parseComments(created.doc.toString());
      const after = created.update(deleteThreadSpec(created, t.id)!).state;
      expect(after.doc.toString()).toBe(original);
    }
  });

  it("removes an orphaned body (anchors already gone)", () => {
    expect(del(`Text here.\n\n${body("z1")}\n`, "z1")).toBe("Text here.\n");
  });

  it("removes orphaned anchors (no body)", () => {
    expect(del("a <!--c:z9s-->b<!--c:z9e--> c\n", "z9")).toBe("a b c\n");
  });

  it("removes a lone anchor token whose partner was deleted", () => {
    const doc = `a <!--c:z9s-->b c\n\n${body("z9")}\n`;
    expect(parseComments(doc)[0].anchor).toBeNull();
    expect(del(doc, "z9")).toBe("a b c\n");
  });

  it("removes duplicated (copy-pasted) anchors of the thread", () => {
    const doc = "x <!--c:a1s-->y<!--c:a1e--> and x <!--c:a1s-->y<!--c:a1e-->\n";
    expect(del(doc, "a1")).toBe("x y and x y\n");
  });

  it("removes only the target among several threads", () => {
    const doc =
      "One <!--c:a1s-->alpha<!--c:a1e--> and <!--c:b2s-->beta<!--c:b2e-->.\n" +
      `\n${body("a1")}\n\n${body("b2")}\n`;
    expect(del(doc, "a1")).toBe(
      "One alpha and <!--c:b2s-->beta<!--c:b2e-->.\n" + `\n${body("b2")}\n`,
    );
    expect(del(doc, "b2")).toBe(
      "One <!--c:a1s-->alpha<!--c:a1e--> and beta.\n" + `\n${body("a1")}\n`,
    );
  });

  it("collapses the blank separator of a body between two paragraphs", () => {
    expect(del(`first\n\n${body("a1")}\n\nsecond\n`, "a1")).toBe(
      "first\n\nsecond\n",
    );
  });

  it("removes a body at the start of the document with its separator", () => {
    expect(del(`${body("a1")}\n\nText.\n`, "a1")).toBe("Text.\n");
    expect(del(`${body("a1")}\n`, "a1")).toBe("");
  });

  it("removes a body on the last line without a final newline", () => {
    expect(del(`Text.\n\n${body("a1")}`, "a1")).toBe("Text.");
    expect(del(`Text.\n${body("a1")}`, "a1")).toBe("Text.");
    expect(del(body("a1"), "a1")).toBe("");
  });

  it("leaves surrounding lines alone when the body sits inside a paragraph", () => {
    expect(del(`line one\n${body("a1")}\nline two\n`, "a1")).toBe(
      "line one\nline two\n",
    );
  });

  it("cuts out exactly the body when it shares its line with text", () => {
    expect(del(`Note ${body("a1")} more\n`, "a1")).toBe("Note  more\n");
  });

  it("is byte-identical outside the removed syntax", () => {
    // Trailing spaces, tabs, a hard break, several blank lines and no final
    // newline: none of it may be touched.
    const original =
      "# Title  \n\n\n\tindented code\nsome *text*   \nwith a hard break\\n" +
      "end of para\n\n\n\n- item\n- item two\t\n\nlast";
    const at = (needle: string) => original.indexOf(needle);
    const a = at("some *text*");
    const b = at("hard break");
    const doc =
      original.slice(0, a) +
      "<!--c:k1s-->" +
      original.slice(a, b) +
      "<!--c:k1e-->" +
      original.slice(b, at("end of para")) +
      body("k1") +
      original.slice(at("end of para"));
    expect(del(doc, "k1")).toBe(original);
  });

  it("respects CRLF documents", () => {
    const doc =
      "Para <!--c:a1s-->one<!--c:a1e-->.\r\n\r\n" +
      `${body("a1")}\r\n\r\nPara two.\r\n\r\n${body("b2", true)}\r\n`;
    expect(del(doc, "a1")).toBe(
      `Para one.\r\n\r\nPara two.\r\n\r\n${body("b2", true)}\r\n`,
    );
    expect(delResolved(doc)).toBe(
      `Para <!--c:a1s-->one<!--c:a1e-->.\r\n\r\n${body("a1")}\r\n\r\nPara two.\r\n`,
    );
  });

  it("deleteResolvedSpec removes every resolved thread, keeps open ones", () => {
    const doc =
      "<!--c:a1s-->A<!--c:a1e--> <!--c:b2s-->B<!--c:b2e--> " +
      "<!--c:c3s-->C<!--c:c3e-->\n\n" +
      `${body("a1", true)}\n\n${body("b2")}\n\n${body("c3", true, ["x", "y"])}\n`;
    const after = delResolved(doc);
    expect(after).toBe(`A <!--c:b2s-->B<!--c:b2e--> C\n\n${body("b2")}\n`);
    expect(parseComments(after).map((t) => t.id)).toEqual(["b2"]);
  });

  it("deleteResolvedSpec handles resolved bodies on adjacent lines", () => {
    const doc = `Text.\n\n${body("a1", true)}\n${body("b2", true)}\n`;
    expect(delResolved(doc)).toBe("Text.\n");
  });

  it("returns null when there is nothing to delete", () => {
    expect(deleteThreadSpec(state(DOC), "zz")).toBeNull();
    expect(deleteResolvedSpec(state(DOC))).toBeNull();
  });

  it("is a single undoable transaction", () => {
    let s = EditorState.create({ doc: DOC, extensions: history() });
    s = s.update(deleteThreadSpec(s, "a1")!).state;
    expect(s.doc.toString()).not.toBe(DOC);
    expect(
      undo({
        state: s,
        dispatch: (tr) => {
          s = tr.state;
        },
      }),
    ).toBe(true);
    expect(s.doc.toString()).toBe(DOC);
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
