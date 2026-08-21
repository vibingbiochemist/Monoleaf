import { describe, expect, it } from "vitest";
import { ensureSyntaxTree } from "@codemirror/language";
import { EditorSelection, EditorState, StateCommand } from "@codemirror/state";
import {
  applyLink,
  changeCase,
  transformCase,
  clearFormatting,
  toggleQuote,
  deleteHardBreakBackward,
  hardBreakEnter,
  imageMarkup,
  insertAdmonition,
  insertMath,
  insertPageBreak,
  linkAt,
  paragraphEnter,
  setAlignment,
  setHeading,
  toggleBold,
  toggleBulletList,
  toggleHighlight,
  toggleOrderedList,
  toggleInlineCode,
  toggleItalic,
  toggleStrikethrough,
  toggleSubscript,
  toggleSuperscript,
  toggleTaskList,
  toggleUnderline,
} from "./commands";
import { markdownForMode } from "./portability";
import { hideCommentSyntax } from "./comments";
import { ensureSyntaxTree as ensure2 } from "@codemirror/language";
import { createDocumentState, serializeDocument } from "./document";

function mkState(doc: string, anchor: number, head = anchor): EditorState {
  const state = EditorState.create({
    doc,
    selection: EditorSelection.single(anchor, head),
    extensions: markdownForMode("enhanced"),
  });
  if (ensureSyntaxTree(state, doc.length, 5000) === null) {
    throw new Error("parse did not finish");
  }
  return state;
}

function run(cmd: StateCommand, doc: string, anchor: number, head = anchor) {
  const state = mkState(doc, anchor, head);
  let after: EditorState | null = null;
  const ok = cmd({
    state,
    dispatch: (tr) => {
      after = tr.state;
    },
  });
  return {
    ok,
    doc: after === null ? doc : (after as EditorState).doc.toString(),
    state: after,
  };
}

describe("inline toggles", () => {
  it("bold wraps the selection", () => {
    expect(run(toggleBold, "hello world", 0, 5).doc).toBe("**hello** world");
  });

  it("bold unwraps when the cursor is inside existing bold", () => {
    expect(run(toggleBold, "**hello** world", 4).doc).toBe("hello world");
  });

  it("bold with an empty selection inserts a pair, cursor between", () => {
    const r = run(toggleBold, "x ", 2);
    expect(r.doc).toBe("x ****");
    expect((r.state as unknown as EditorState).selection.main.head).toBe(4);
  });

  it("italic inside bold nests instead of unwrapping the bold", () => {
    expect(run(toggleItalic, "**hello** x", 2, 7).doc).toBe("***hello*** x");
  });

  it("italic unwraps only the emphasis", () => {
    expect(run(toggleItalic, "*it* x", 2).doc).toBe("it x");
  });

  it("strikethrough wraps", () => {
    expect(run(toggleStrikethrough, "abc", 0, 3).doc).toBe("~~abc~~");
  });

  it("inline code unwraps", () => {
    expect(run(toggleInlineCode, "`x` y", 1).doc).toBe("x y");
  });

  it("subscript wraps the selection in ~", () => {
    expect(run(toggleSubscript, "H2O", 1, 2).doc).toBe("H~2~O");
  });

  it("subscript unwraps when the cursor is inside", () => {
    expect(run(toggleSubscript, "H~2~O", 2).doc).toBe("H2O");
  });

  it("superscript wraps the selection in ^", () => {
    expect(run(toggleSuperscript, "x2", 1, 2).doc).toBe("x^2^");
  });

  it("superscript unwraps when the cursor is inside", () => {
    expect(run(toggleSuperscript, "E=mc^2^", 5).doc).toBe("E=mc2");
  });

  // A second click with no typing in between lands the cursor exactly
  // between two marker pairs the first click already inserted ("**|**").
  // CommonMark never parses that as a real StrongEmphasis/Emphasis/etc.
  // node (delimiters need non-empty content), so naively falling through to
  // the wrap branch would stack another pair instead of removing the empty
  // one — turning one stray click into a permanent "****" artifact.
  describe("toggling twice on empty content removes the pair instead of stacking", () => {
    it("bold", () => {
      const once = run(toggleBold, "x ", 2);
      expect(once.doc).toBe("x ****");
      const twice = run(toggleBold, once.doc, 4);
      expect(twice.doc).toBe("x ");
    });

    it("italic", () => {
      const once = run(toggleItalic, "x ", 2);
      expect(once.doc).toBe("x **");
      const twice = run(toggleItalic, once.doc, 3);
      expect(twice.doc).toBe("x ");
    });

    it("strikethrough", () => {
      const once = run(toggleStrikethrough, "x ", 2);
      expect(once.doc).toBe("x ~~~~");
      const twice = run(toggleStrikethrough, once.doc, 4);
      expect(twice.doc).toBe("x ");
    });

    it("inline code", () => {
      const once = run(toggleInlineCode, "x ", 2);
      expect(once.doc).toBe("x ``");
      const twice = run(toggleInlineCode, once.doc, 3);
      expect(twice.doc).toBe("x ");
    });

    it("subscript", () => {
      const once = run(toggleSubscript, "x ", 2);
      expect(once.doc).toBe("x ~~");
      const twice = run(toggleSubscript, once.doc, 3);
      expect(twice.doc).toBe("x ");
    });

    it("superscript", () => {
      const once = run(toggleSuperscript, "x ", 2);
      expect(once.doc).toBe("x ^^");
      const twice = run(toggleSuperscript, once.doc, 3);
      expect(twice.doc).toBe("x ");
    });
  });

  it("does not corrupt an empty strikethrough when subscript is toggled inside it (shared marker character)", () => {
    // "~~~~" is an empty strikethrough, not two empty subscripts — since
    // "~" is a run-prefix of "~~", the empty-pair fix must not mistake the
    // inner two characters for a standalone empty subscript pair and delete
    // half of the strikethrough's real markers.
    const r = run(toggleSubscript, "~~~~", 2);
    expect(r.doc).toContain("~~~~");
  });

  it("insert equation wraps a selection in $…$", () => {
    expect(run(insertMath, "abc", 0, 3).doc).toBe("$abc$");
  });

  it("insert equation on an empty selection inserts $$, cursor between", () => {
    const r = run(insertMath, "x ", 2);
    expect(r.doc).toBe("x $$");
    expect((r.state as unknown as EditorState).selection.main.head).toBe(3);
  });

  it("imageMarkup builds a portable ![alt](url) reference", () => {
    expect(imageMarkup("https://x/y.png", "diagram")).toBe(
      "![diagram](https://x/y.png)",
    );
    expect(imageMarkup("https://x/y.png", "")).toBe("![](https://x/y.png)");
  });
});

describe("underline and highlight (inline HTML)", () => {
  it("underline wraps the selection in <u> tags", () => {
    expect(run(toggleUnderline, "hello world", 0, 5).doc).toBe(
      "<u>hello</u> world",
    );
  });

  it("underline unwraps when the selection includes the tags", () => {
    expect(run(toggleUnderline, "<u>hello</u> world", 0, 12).doc).toBe(
      "hello world",
    );
  });

  it("underline unwraps when the selection is exactly the content", () => {
    expect(run(toggleUnderline, "<u>hello</u> world", 3, 8).doc).toBe(
      "hello world",
    );
  });

  it("highlight wraps in <mark> tags, trimming selection whitespace", () => {
    expect(run(toggleHighlight, "hello world", 0, 6).doc).toBe(
      "<mark>hello</mark> world",
    );
  });
});

describe("paragraph alignment", () => {
  const WRAPPED = '<div align="center">\n\npara one\n\n</div>\n\nnext';

  it("wraps the paragraph in an align block", () => {
    expect(run(setAlignment("center"), "para one\n\nnext", 4).doc).toBe(
      WRAPPED,
    );
  });

  it("left removes the wrapper", () => {
    expect(run(setAlignment("left"), WRAPPED, 24).doc).toBe("para one\n\nnext");
  });

  it("toggling the same alignment off removes the wrapper", () => {
    expect(run(setAlignment("center"), WRAPPED, 24).doc).toBe(
      "para one\n\nnext",
    );
  });

  it("switching alignment rewrites the open tag in place", () => {
    expect(run(setAlignment("right"), WRAPPED, 24).doc).toBe(
      '<div align="right">\n\npara one\n\n</div>\n\nnext',
    );
  });

  it("left on unwrapped text is a no-op", () => {
    expect(run(setAlignment("left"), "plain", 2).ok).toBe(false);
  });
});

describe("heading levels", () => {
  it("adds a heading prefix to a plain line", () => {
    expect(run(setHeading(2), "hello", 2).doc).toBe("## hello");
  });

  it("changes an existing heading's level", () => {
    expect(run(setHeading(3), "# hello", 4).doc).toBe("### hello");
  });

  it("level 0 removes the heading", () => {
    expect(run(setHeading(0), "### hello", 4).doc).toBe("hello");
  });

  it("applies to every line the selection touches", () => {
    expect(run(setHeading(2), "one\ntwo\nthree", 1, 9).doc).toBe(
      "## one\n## two\n## three",
    );
  });
});

describe("list toggles", () => {
  it("bullet-lists the selected lines", () => {
    expect(run(toggleBulletList, "one\ntwo", 0, 7).doc).toBe("- one\n- two");
  });

  it("numbers the selected lines from 1", () => {
    expect(run(toggleOrderedList, "one\ntwo\nthree", 0, 13).doc).toBe(
      "1. one\n2. two\n3. three",
    );
  });

  it("toggles a bullet list back off", () => {
    expect(run(toggleBulletList, "- one\n- two", 0, 11).doc).toBe("one\ntwo");
  });

  it("switches bullets to numbers", () => {
    expect(run(toggleOrderedList, "- one\n- two", 0, 11).doc).toBe(
      "1. one\n2. two",
    );
  });

  it("makes a checklist (task list) of the selected lines", () => {
    expect(run(toggleTaskList, "one\ntwo", 0, 7).doc).toBe(
      "- [ ] one\n- [ ] two",
    );
  });

  it("toggles a checklist back off cleanly (no stray [ ])", () => {
    expect(run(toggleTaskList, "- [ ] one\n- [x] two", 0, 19).doc).toBe(
      "one\ntwo",
    );
  });

  it("switches bullets to a checklist", () => {
    expect(run(toggleTaskList, "- one\n- two", 0, 11).doc).toBe(
      "- [ ] one\n- [ ] two",
    );
  });

  it("skips blank lines when numbering", () => {
    expect(run(toggleOrderedList, "one\n\ntwo", 0, 8).doc).toBe(
      "1. one\n\n2. two",
    );
  });

  it("applies to an empty line with a collapsed cursor (pre-format)", () => {
    const r = run(toggleBulletList, "", 0);
    expect(r.doc).toBe("- ");
    expect((r.state as unknown as EditorState).selection.main.head).toBe(2);
  });
});

describe("pre-format then type (collapsed cursor)", () => {
  it("setHeading applies to an empty line, cursor after the prefix", () => {
    const r = run(setHeading(2), "", 0);
    expect(r.doc).toBe("## ");
    // Cursor must land after "## " so the typed text is the heading.
    expect((r.state as unknown as EditorState).selection.main.head).toBe(3);
  });

  it("setHeading skips blank lines in a multi-line selection", () => {
    expect(run(setHeading(1), "a\n\nb", 0, 4).doc).toBe("# a\n\n# b");
  });

  it("bold on an empty selection inserts a pair to type into", () => {
    const r = run(toggleBold, "", 0);
    expect(r.doc).toBe("****");
    expect((r.state as unknown as EditorState).selection.main.head).toBe(2);
  });
});

describe("Word-like Enter in live view", () => {
  function runLive(cmd: StateCommand, doc: string, pos: number) {
    const state = EditorState.create({
      doc,
      selection: EditorSelection.single(pos),
      extensions: [markdownForMode("enhanced"), hideCommentSyntax.of(true)],
    });
    ensure2(state, doc.length, 5000);
    let after: EditorState | null = null;
    const ok = cmd({
      state,
      dispatch: (tr) => {
        after = tr.state;
      },
    });
    return {
      ok,
      doc: after === null ? doc : (after as EditorState).doc.toString(),
    };
  }

  it("Enter makes a new paragraph (blank line)", () => {
    expect(runLive(paragraphEnter, "one two", 3).doc).toBe("one\n\n two");
  });

  it("Enter falls through inside a list (marker continuation)", () => {
    expect(runLive(paragraphEnter, "- item", 6).ok).toBe(false);
  });

  it("Enter falls through in raw view (no live facet)", () => {
    const state = EditorState.create({
      doc: "one",
      selection: EditorSelection.single(3),
      extensions: markdownForMode("enhanced"),
    });
    expect(paragraphEnter({ state, dispatch: () => {} })).toBe(false);
  });

  it("Shift+Enter writes a backslash hard break", () => {
    expect(runLive(hardBreakEnter, "one two", 3).doc).toBe("one\\\n two");
  });

  it("Shift+Enter in a heading keeps the heading style on the next line", () => {
    // # Title  ->  # Title\n#   (same level, no stray "\")
    expect(runLive(hardBreakEnter, "# Title", 7).doc).toBe("# Title\n# ");
  });

  it("Shift+Enter keeps a heading-3 prefix", () => {
    expect(runLive(hardBreakEnter, "### Sub", 7).doc).toBe("### Sub\n### ");
  });

  it("Backspace at a hard-break continuation removes the backslash too", () => {
    // "abc\\\n" with cursor at line-2 start -> backspace -> "abc"
    expect(runLive(deleteHardBreakBackward, "abc\\\n", 5).doc).toBe("abc");
  });

  it("Backspace command is a no-op when the previous line has no hard break", () => {
    expect(runLive(deleteHardBreakBackward, "abc\ndef", 4).ok).toBe(false);
  });

  it("paragraph break respects CRLF documents", () => {
    const base = createDocumentState("one two\r\n");
    const withSel = base.update({
      selection: EditorSelection.single(3),
    }).state;
    const live = EditorState.create({
      doc: withSel.doc,
      selection: EditorSelection.single(3),
      extensions: [
        markdownForMode("enhanced"),
        hideCommentSyntax.of(true),
        EditorState.lineSeparator.of("\r\n"),
      ],
    });
    let after: EditorState | null = null;
    paragraphEnter({
      state: live,
      dispatch: (tr) => {
        after = tr.state;
      },
    });
    expect(serializeDocument(after as unknown as EditorState)).toBe(
      "one\r\n\r\n two\r\n",
    );
  });
});

describe("insertPageBreak", () => {
  it("inserts the directive isolated by a trailing blank line", () => {
    const r = run(insertPageBreak, "one two", 3);
    expect(r.doc).toBe("one\n<!--ml:pagebreak-->\n\n two");
  });

  it("omits the leading newline at line start, keeps the trailing blank", () => {
    const r = run(insertPageBreak, "one\ntwo", 4);
    expect(r.doc).toBe("one\n<!--ml:pagebreak-->\n\ntwo");
  });
});

describe("links", () => {
  it("linkAt finds the URL range of the enclosing link", () => {
    expect(linkAt(mkState("[t](http://a) z", 1))).toEqual({
      urlFrom: 4,
      urlTo: 12,
    });
  });

  it("linkAt returns null outside links", () => {
    expect(linkAt(mkState("[t](http://a) z", 14))).toBeNull();
  });

  it("applyLink rewrites an existing link's URL", () => {
    const state = mkState("[t](http://a) z", 1);
    const after = state.update(applyLink(state, "https://b.example"));
    expect(after.state.doc.toString()).toBe("[t](https://b.example) z");
  });

  it("applyLink wraps a selection", () => {
    const state = mkState("hello", 0, 5);
    const after = state.update(applyLink(state, "http://x"));
    expect(after.state.doc.toString()).toBe("[hello](http://x)");
    expect(after.state.selection.main.head).toBe(17);
  });

  it("applyLink with an empty selection inserts a placeholder, selected", () => {
    const state = mkState("a ", 2);
    const after = state.update(applyLink(state, "http://x"));
    expect(after.state.doc.toString()).toBe("a [link](http://x)");
    expect(after.state.selection.main.from).toBe(3);
    expect(after.state.selection.main.to).toBe(7);
  });
});

describe("insertAdmonition", () => {
  it("wraps a selection as a typed callout", () => {
    // "line one" selected on its own line.
    const r = run(insertAdmonition("warning"), "line one", 0, 8);
    expect(r.doc).toBe("> [!WARNING]\n> line one");
  });

  it("inserts an empty template with the cursor on the body line", () => {
    const r = run(insertAdmonition("note"), "", 0);
    expect(r.doc).toBe("> [!NOTE]\n> ");
    expect((r.state as unknown as EditorState).selection.main.head).toBe(
      "> [!NOTE]\n> ".length,
    );
  });

  it("adds a blank line before when the previous line has content", () => {
    // Cursor on the empty second line, a paragraph above it.
    const doc = "para\n";
    const r = run(insertAdmonition("tip"), doc, 5);
    expect(r.doc).toBe("para\n\n> [!TIP]\n> ");
  });
});

describe("transformCase", () => {
  it("uppercases and lowercases", () => {
    expect(transformCase("Hello World", "upper")).toBe("HELLO WORLD");
    expect(transformCase("Hello World", "lower")).toBe("hello world");
  });

  it("title-cases each word", () => {
    expect(transformCase("hello brave world", "title")).toBe(
      "Hello Brave World",
    );
    expect(transformCase("EC50 of ASSAY", "title")).toBe("Ec50 Of Assay");
  });

  it("sentence-cases across punctuation", () => {
    expect(transformCase("hello world. bye now! ok?", "sentence")).toBe(
      "Hello world. Bye now! Ok?",
    );
  });

  it("leaves markdown markers untouched (they are punctuation)", () => {
    expect(transformCase("**bold** text", "upper")).toBe("**BOLD** TEXT");
  });
});

describe("changeCase command", () => {
  it("transforms the selection and keeps it selected", () => {
    const r = run(changeCase("upper"), "hello world", 0, 11);
    expect(r.doc).toBe("HELLO WORLD");
    const sel = (r.state as unknown as EditorState).selection.main;
    expect([sel.from, sel.to]).toEqual([0, 11]);
  });

  it("acts on the word under the cursor when nothing is selected", () => {
    // Cursor inside "world"; no selection.
    expect(run(changeCase("upper"), "hello world", 8).doc).toBe("hello WORLD");
  });

  it("is a no-op on empty/blank space with no word", () => {
    expect(run(changeCase("upper"), "   ", 1).ok).toBe(false);
  });
});

describe("clearFormatting", () => {
  it("strips bold, italic, strikethrough, and inline code", () => {
    expect(run(clearFormatting, "**a** *b* ~~c~~ `d`", 0, 19).doc).toBe(
      "a b c d",
    );
  });

  it("handles nested emphasis (***both***)", () => {
    expect(run(clearFormatting, "x ***both*** y", 0, 14).doc).toBe("x both y");
  });

  it("collapses a link to its text and an image to its alt", () => {
    expect(run(clearFormatting, "see [text](http://x) here", 0, 25).doc).toBe(
      "see text here",
    );
    expect(run(clearFormatting, "![alt](http://x/i.png)", 0, 22).doc).toBe(
      "alt",
    );
  });

  it("removes underline and highlight HTML", () => {
    expect(run(clearFormatting, "<u>a</u> and <mark>b</mark>", 0, 27).doc).toBe(
      "a and b",
    );
  });

  it("leaves already-plain text and empty selections alone", () => {
    expect(run(clearFormatting, "plain text", 0, 10).ok).toBe(false);
    expect(run(clearFormatting, "**bold**", 4).ok).toBe(false); // empty selection
  });

  it("clears the whole run when the selection cuts a marker (no stray *)", () => {
    // Selection starts after the opening ** and runs to the end.
    expect(run(clearFormatting, "**bold** x", 2, 10).doc).toBe("bold x");
  });

  it("clears the run when the selection sits inside the formatting", () => {
    // Cursor-sized selection inside the bold word clears the whole word.
    expect(run(clearFormatting, "**bold** x", 4, 6).doc).toBe("bold x");
  });
});

describe("toggleQuote", () => {
  it("adds a quote marker to a single line", () => {
    expect(run(toggleQuote, "hello", 0).doc).toBe("> hello");
  });

  it("quotes every selected line, blanks included", () => {
    expect(run(toggleQuote, "one\n\ntwo", 0, 8).doc).toBe("> one\n> \n> two");
  });

  it("removes the marker when every non-blank line is quoted", () => {
    expect(run(toggleQuote, "> one\n> two", 0, 11).doc).toBe("one\ntwo");
  });

  it("adds the marker only to lines that lack it", () => {
    expect(run(toggleQuote, "> one\ntwo", 0, 9).doc).toBe("> one\n> two");
  });
});
