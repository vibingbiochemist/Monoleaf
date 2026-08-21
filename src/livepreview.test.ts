import { describe, expect, it } from "vitest";
import { ensureSyntaxTree } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { buildLivePreviewDecorations, paragraphGuard } from "./livepreview";
import { markdownForMode } from "./portability";

interface Entry {
  from: number;
  to: number;
  kind: string;
  checked?: boolean;
}

/** Build a parsed state with the cursor at `cursor` and list the planned
 * decorations. */
function decos(doc: string, cursor: number): Entry[] {
  const state = EditorState.create({
    doc,
    selection: { anchor: cursor },
    extensions: markdownForMode("enhanced"),
  });
  const tree = ensureSyntaxTree(state, doc.length, 5000);
  if (tree === null) throw new Error("parse did not finish");
  const set = buildLivePreviewDecorations(state, 0, doc.length, tree);
  const out: Entry[] = [];
  const it = set.decorations.iter();
  while (it.value !== null) {
    const spec = it.value.spec as {
      widget?: { checked?: boolean };
      class?: string;
    };
    const entry: Entry = {
      from: it.from,
      to: it.to,
      kind: spec.widget ? "widget" : (spec.class ?? "hide"),
    };
    if (spec.widget && "checked" in spec.widget) {
      entry.kind = "checkbox";
      entry.checked = spec.widget.checked;
    }
    out.push(entry);
    it.next();
  }
  return out;
}

const hides = (doc: string, cursor: number) =>
  decos(doc, cursor).filter((d) => d.kind === "hide");

describe("no raw-syntax bleeds", () => {
  it("hides the backslash of an escape, keeps the char", () => {
    // "\*not bold\*" — the two backslashes hide, the asterisks show.
    const doc = "a \\* b";
    expect(hides(doc, 0)).toEqual([{ from: 2, to: 3, kind: "hide" }]);
  });

  it("keeps a local image as alt text (syntax hidden)", () => {
    const doc = "see ![a figure](img.png) here";
    const all = decos(doc, 0);
    const h = all.filter((d) => d.kind === "hide");
    // "![" hidden and "](img.png)" hidden; "a figure" stays visible.
    expect(h).toContainEqual({ from: 4, to: 6, kind: "hide" });
    expect(h).toContainEqual({ from: 14, to: 24, kind: "hide" });
    expect(all.filter((d) => d.kind === "widget")).toEqual([]);
  });

  it("renders an https image as a widget", () => {
    const doc = "![logo](https://x.com/l.png)";
    const all = decos(doc, doc.length);
    expect(all.filter((d) => d.kind === "widget")).toEqual([
      { from: 0, to: doc.length, kind: "widget" },
    ]);
  });

  it("hides a setext underline and sizes the heading", () => {
    const doc = "Title\n=====\n\nbody";
    const all = decos(doc, doc.length);
    expect(all.some((d) => d.kind === "hide" && d.from === 6)).toBe(true);
    expect(all.some((d) => d.kind.includes("cm-live-h1"))).toBe(true);
  });
});

describe("silent WYSIWYG: markers hidden regardless of the cursor", () => {
  it("hides bold markers with the cursor elsewhere", () => {
    const doc = "**bold** rest";
    expect(hides(doc, doc.length)).toEqual([
      { from: 0, to: 2, kind: "hide" },
      { from: 6, to: 8, kind: "hide" },
    ]);
  });

  it("hides bold markers even with the cursor inside", () => {
    expect(hides("**bold** rest", 4)).toEqual([
      { from: 0, to: 2, kind: "hide" },
      { from: 6, to: 8, kind: "hide" },
    ]);
  });

  it("headings get a spacing line class with their level", () => {
    const doc = "# One\n\n### Three\n";
    const classes = decos(doc, doc.length)
      .filter((d) => d.kind.includes("cm-live-heading"))
      .map((d) => d.kind);
    expect(classes).toEqual([
      "cm-live-heading cm-live-h1",
      "cm-live-heading cm-live-h3",
    ]);
  });

  it("hides inline-code backticks", () => {
    expect(hides("`x` y", 1)).toEqual([
      { from: 0, to: 1, kind: "hide" },
      { from: 2, to: 3, kind: "hide" },
    ]);
  });

  it("hides link brackets and URL, keeps the text styled as a link", () => {
    const doc = "[t](https://e.com) z";
    const all = decos(doc, 1);
    expect(all.filter((d) => d.kind === "hide")).toHaveLength(5);
    expect(all.filter((d) => d.kind === "cm-live-link")).toEqual([
      { from: 0, to: 18, kind: "cm-live-link" },
    ]);
  });

  it("links carry their URL for Ctrl+click open-in-browser", () => {
    const doc = "[t](https://e.com) z";
    const state = EditorState.create({
      doc,
      selection: { anchor: doc.length },
      extensions: markdownForMode("enhanced"),
    });
    const tree = ensureSyntaxTree(state, doc.length, 5000)!;
    const set = buildLivePreviewDecorations(state, 0, doc.length, tree);
    let url: string | null = null;
    const it2 = set.decorations.iter();
    while (it2.value !== null) {
      const attrs = (it2.value.spec as { attributes?: Record<string, string> })
        .attributes;
      if (attrs?.["data-url"] !== undefined) url = attrs["data-url"];
      it2.next();
    }
    expect(url).toBe("https://e.com");
  });

  it("hides the quote mark and adds the quote line class", () => {
    const doc = "> quoted\n\nother";
    const all = decos(doc, 3);
    expect(all.filter((d) => d.kind === "hide")).toEqual([
      { from: 0, to: 2, kind: "hide" },
    ]);
    expect(all.filter((d) => d.kind === "cm-live-quote")).toEqual([
      { from: 0, to: 0, kind: "cm-live-quote" },
    ]);
  });

  it("atomics mirror the hidden marker ranges", () => {
    const doc = "**bold** rest";
    const state = EditorState.create({
      doc,
      selection: { anchor: doc.length },
      extensions: markdownForMode("enhanced"),
    });
    const tree = ensureSyntaxTree(state, doc.length, 5000)!;
    const { atomics } = buildLivePreviewDecorations(state, 0, doc.length, tree);
    const ranges: [number, number][] = [];
    const it = atomics.iter();
    while (it.value !== null) {
      ranges.push([it.from, it.to]);
      it.next();
    }
    expect(ranges).toEqual([
      [0, 2],
      [6, 8],
    ]);
  });
});

describe("block-metadata exceptions still reveal on the cursor line", () => {
  it("hides the heading '# ' marker when the cursor is on another line", () => {
    const doc = "# Head\n\ntext";
    // cursor in the body paragraph, away from the heading line
    expect(hides(doc, doc.length)).toEqual([{ from: 0, to: 2, kind: "hide" }]);
  });

  it("reveals the heading marker while the cursor is on the heading line", () => {
    const doc = "# Head\n\ntext";
    // cursor inside "Head" — the marker must stay visible so the level shows
    expect(hides(doc, 3)).toEqual([]);
  });

  it("reveals a multi-hash marker (### shows the level) on its line", () => {
    expect(hides("### Deep", 4)).toEqual([]);
  });

  it("still sizes the heading line while the marker is revealed", () => {
    const all = decos("## Title", 0);
    expect(all.some((d) => d.kind === "cm-live-heading cm-live-h2")).toBe(true);
  });

  it("a range selection across the heading keeps it rendered (marker hidden)", () => {
    const doc = "# Head\n\ntext";
    const state = EditorState.create({
      doc,
      selection: { anchor: 0, head: doc.length },
      extensions: markdownForMode("enhanced"),
    });
    const tree = ensureSyntaxTree(state, doc.length, 5000)!;
    const set = buildLivePreviewDecorations(state, 0, doc.length, tree);
    const hidden: { from: number; to: number }[] = [];
    const it = set.decorations.iter();
    while (it.value !== null) {
      const spec = it.value.spec as { class?: string };
      if (spec.class === undefined) hidden.push({ from: it.from, to: it.to });
      it.next();
    }
    expect(hidden).toContainEqual({ from: 0, to: 2 });
  });

  it("hides fence lines and marks all code block lines", () => {
    const doc = "```js\ncode()\n```\nafter";
    const all = decos(doc, doc.length);
    expect(all.filter((d) => d.kind === "hide")).toEqual([
      { from: 0, to: 5, kind: "hide" },
      { from: 13, to: 16, kind: "hide" },
    ]);
    expect(all.filter((d) => d.kind === "cm-live-codeblock")).toHaveLength(3);
  });

  it("reveals the fence line under the cursor but not the other one", () => {
    const doc = "```js\ncode()\n```\nafter";
    expect(hides(doc, 2)).toEqual([{ from: 13, to: 16, kind: "hide" }]);
  });

  it("a range selection sweeping the fences keeps them rendered", () => {
    const doc = "```js\ncode()\n```\nafter";
    const state = EditorState.create({
      doc,
      selection: { anchor: 0, head: doc.length },
      extensions: markdownForMode("enhanced"),
    });
    const tree = ensureSyntaxTree(state, doc.length, 5000)!;
    const set = buildLivePreviewDecorations(state, 0, doc.length, tree);
    const out: { from: number; to: number }[] = [];
    const it2 = set.decorations.iter();
    while (it2.value !== null) {
      const spec = it2.value.spec as { widget?: unknown; class?: string };
      if (spec.widget === undefined && spec.class === undefined) {
        out.push({ from: it2.from, to: it2.to });
      }
      it2.next();
    }
    // Both fence lines stay hidden (rendered) despite the full-doc selection.
    expect(out).toEqual([
      { from: 0, to: 5 },
      { from: 13, to: 16 },
    ]);
  });

  it("renders --- as a rule widget when the cursor is elsewhere", () => {
    const doc = "a\n\n---\n\nb";
    expect(decos(doc, 0).filter((d) => d.kind === "widget")).toEqual([
      { from: 3, to: 6, kind: "widget" },
    ]);
  });

  it("shows the raw --- when the cursor is on its line", () => {
    const doc = "a\n\n---\n\nb";
    expect(decos(doc, 4).filter((d) => d.kind === "widget")).toEqual([]);
  });

  it("always renders the page-break directive as a divider (cursor elsewhere)", () => {
    const doc = "a\n\n<!--ml:pagebreak-->\n\nb";
    expect(decos(doc, 0).filter((d) => d.kind === "widget")).toEqual([
      { from: 3, to: 22, kind: "widget" },
    ]);
  });

  it("still renders the divider (not raw) with the cursor on its line", () => {
    const doc = "a\n\n<!--ml:pagebreak-->\n\nb";
    expect(decos(doc, 5).filter((d) => d.kind === "widget")).toEqual([
      { from: 3, to: 22, kind: "widget" },
    ]);
  });
});

describe("paragraph guard: typing on a blank separator line", () => {
  function type(doc: string, pos: number, text: string) {
    const state = EditorState.create({
      doc,
      selection: { anchor: pos },
      extensions: paragraphGuard,
    });
    const tr = state.update({
      changes: { from: pos, insert: text },
      userEvent: "input.type",
    });
    return {
      doc: tr.state.doc.toString(),
      cursor: tr.state.selection.main.head,
    };
  }

  it("keeps the typed text as its own paragraph between two paragraphs", () => {
    const r = type("one\n\ntwo", 4, "X");
    expect(r.doc).toBe("one\n\nX\n\ntwo");
    expect(r.cursor).toBe(6);
  });

  it("pads only above when at the end of the document", () => {
    expect(type("one\n", 4, "X").doc).toBe("one\n\nX");
  });

  it("leaves typing inside a paragraph untouched", () => {
    expect(type("one two", 3, "X").doc).toBe("oneX two");
  });

  it("leaves isolated blank regions untouched", () => {
    expect(type("\n\n\n", 1, "X").doc).toBe("\nX\n\n");
  });

  it("stands down after a Shift+Enter hard break (backslash)", () => {
    expect(type("one\\\n", 5, "X").doc).toBe("one\\\nX");
  });

  it("stands down after a two-space hard break", () => {
    expect(type("one  \n", 6, "X").doc).toBe("one  \nX");
  });
});

describe("alignment block rendering", () => {
  const doc = '<div align="center">\n\nmid\n\n</div>';

  it("hides the tag lines and aligns the enclosed lines", () => {
    const all = decos(doc, 24); // cursor on "mid" -> tags still hidden
    expect(all.filter((d) => d.kind === "hide")).toEqual([
      { from: 0, to: 20, kind: "hide" },
      { from: 27, to: 33, kind: "hide" },
    ]);
    expect(all.filter((d) => d.kind === "cm-align-center")).toHaveLength(3);
  });

  it("keeps the tag lines hidden even with the cursor on them", () => {
    // The <div align> tags never reveal (no raw-markdown bleed); alignment
    // is changed via the toolbar, not by editing the tags.
    const all = decos(doc, 2); // cursor on the <div> line
    expect(all.filter((d) => d.kind === "hide")).toEqual([
      { from: 0, to: 20, kind: "hide" },
      { from: 27, to: 33, kind: "hide" },
    ]);
  });
});

describe("underline and highlight rendering", () => {
  it("hides <u> tags and styles the content", () => {
    const doc = "a <u>under</u> b";
    const all = decos(doc, 0);
    expect(all.filter((d) => d.kind === "hide")).toEqual([
      { from: 2, to: 5, kind: "hide" },
      { from: 10, to: 14, kind: "hide" },
    ]);
    expect(all.filter((d) => d.kind === "cm-live-underline")).toEqual([
      { from: 5, to: 10, kind: "cm-live-underline" },
    ]);
  });

  it("hides <mark> tags and styles the content", () => {
    const doc = "a <mark>hot</mark> b";
    const all = decos(doc, 0);
    expect(all.filter((d) => d.kind === "cm-live-highlight")).toEqual([
      { from: 8, to: 11, kind: "cm-live-highlight" },
    ]);
  });
});

describe("pending hard break", () => {
  it("hides the trailing backslash while the cursor waits on the next line", () => {
    const doc = "one\\\n";
    expect(hides(doc, 5)).toContainEqual({ from: 3, to: 4, kind: "hide" });
  });

  it("shows the dangling backslash when the cursor is elsewhere", () => {
    const doc = "one\\\n\nfar away";
    expect(hides(doc, 10)).not.toContainEqual({
      from: 3,
      to: 4,
      kind: "hide",
    });
  });
});

describe("list rendering", () => {
  it("replaces '- [ ] ' with an unchecked checkbox", () => {
    const doc = "- [ ] todo\nx";
    expect(decos(doc, doc.length).filter((d) => d.kind === "checkbox")).toEqual(
      [{ from: 0, to: 6, kind: "checkbox", checked: false }],
    );
  });

  it("replaces '- [x] ' with a checked checkbox", () => {
    const doc = "- [x] done\nx";
    expect(decos(doc, doc.length).filter((d) => d.kind === "checkbox")).toEqual(
      [{ from: 0, to: 6, kind: "checkbox", checked: true }],
    );
  });

  it("replaces the dash bullet and its space with a bullet widget", () => {
    const doc = "- item\nx";
    expect(decos(doc, doc.length).filter((d) => d.kind === "widget")).toEqual([
      { from: 0, to: 2, kind: "widget" },
    ]);
  });

  it("keeps the bullet widget even when the cursor is on the item's line", () => {
    const doc = "- item\nx";
    expect(decos(doc, 3).filter((d) => d.kind === "widget")).toEqual([
      { from: 0, to: 2, kind: "widget" },
    ]);
  });

  it("ordered task items keep the number and get a checkbox", () => {
    const doc = "1. [ ] num\nx";
    expect(decos(doc, doc.length).filter((d) => d.kind === "checkbox")).toEqual(
      [{ from: 3, to: 7, kind: "checkbox", checked: false }],
    );
  });
});

describe("admonitions", () => {
  it("styles every line of a [!NOTE] callout and hides the marker", () => {
    const doc = "> [!NOTE]\n> body text\n\nafter";
    // Cursor on the last paragraph, away from the callout.
    const all = decos(doc, doc.length);
    const admLines = all.filter((d) => d.kind.includes("cm-live-adm"));
    // Both quote lines get the note callout class.
    expect(admLines.length).toBeGreaterThanOrEqual(2);
    expect(all.some((d) => d.kind === "cm-live-adm cm-live-adm-note")).toBe(
      true,
    );
    // The "[!NOTE]" marker is replaced by a title widget.
    expect(all.some((d) => d.kind === "widget")).toBe(true);
  });

  it("does not treat a plain blockquote as a callout", () => {
    const doc = "> ordinary quote\n\nafter";
    const all = decos(doc, doc.length);
    expect(all.some((d) => d.kind.includes("cm-live-adm"))).toBe(false);
    expect(all.some((d) => d.kind === "cm-live-quote")).toBe(true);
  });

  it("reveals the raw marker while the cursor is on its line", () => {
    const doc = "> [!TIP]\n> body\n\nafter";
    // Cursor on the marker line → no replacement widget there.
    const all = decos(doc, 4);
    expect(all.some((d) => d.kind === "widget")).toBe(false);
    // Still styled as a callout, though.
    expect(all.some((d) => d.kind.includes("cm-live-adm"))).toBe(true);
  });
});

describe("document metadata", () => {
  it("hides the ml:meta comment when the cursor is elsewhere", () => {
    const doc = '<!--ml:meta {"title":"X"}-->\n\n# Body\n';
    // Cursor on the body, not on the comment line.
    expect(hides(doc, doc.length - 1)).toContainEqual({
      from: 0,
      to: 28,
      kind: "hide",
    });
  });

  it("reveals the ml:meta comment while the cursor is on its line", () => {
    const doc = '<!--ml:meta {"title":"X"}-->\n\n# Body\n';
    // The comment's own range (0..28) is not hidden while being edited.
    expect(hides(doc, 5).some((d) => d.from === 0)).toBe(false);
  });

  it("styles leading YAML front-matter lines instead of hiding them", () => {
    const doc = "---\ntitle: X\n---\n\n# Body\n";
    const fm = decos(doc, doc.length - 1).filter(
      (d) => d.kind === "cm-live-frontmatter",
    );
    // Three lines: opening ---, the title line, closing --- (line-start decos).
    expect(fm.map((d) => d.from)).toEqual([0, 4, 13]);
    // And the `---` fences are NOT turned into horizontal-rule widgets.
    expect(
      decos(doc, doc.length - 1).filter((d) => d.kind === "widget"),
    ).toEqual([]);
  });
});

describe("page config", () => {
  const PAGE_COMMENT = '<!--ml:page {"font":"lora"}-->';

  it("hides the ml:page comment when the cursor is elsewhere", () => {
    const doc = `${PAGE_COMMENT}\n\n# Body\n`;
    // Cursor on the body, not on the comment line.
    expect(hides(doc, doc.length - 1)).toContainEqual({
      from: 0,
      to: PAGE_COMMENT.length,
      kind: "hide",
    });
  });

  it("reveals the ml:page comment while the cursor is on its line", () => {
    const doc = `${PAGE_COMMENT}\n\n# Body\n`;
    // The comment's own range is not hidden while being edited.
    expect(hides(doc, 5).some((d) => d.from === 0)).toBe(false);
  });
});
