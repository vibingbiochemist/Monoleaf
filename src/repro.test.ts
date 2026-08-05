import { describe, expect, it } from "vitest";
import { ensureSyntaxTree } from "@codemirror/language";
import { EditorSelection, EditorState } from "@codemirror/state";
import { buildLivePreviewDecorations, paragraphGuard } from "./livepreview";
import { markdownForMode } from "./portability";
import { toggleBold, toggleUnderline } from "./commands";

const KITCHEN_SINK = `# Title

Some **bold** text with a [link](https://e.com).

<div align="center">

centered paragraph

</div>

<!--ml:pagebreak-->

- [ ] task
- item

\`\`\`js
code();
\`\`\`

> quote

H~2~O and <u>under</u> and <mark>hot</mark>

<!--ml:page {"size":"A4","margin":"20mm","header":"","footer":"{page}","justify":true}-->
`;

describe("repro: full pipeline on a kitchen-sink document", () => {
  it("decoration build does not throw at any cursor position", () => {
    for (const pos of [0, 10, 50, 100, KITCHEN_SINK.length]) {
      const state = EditorState.create({
        doc: KITCHEN_SINK,
        selection: { anchor: Math.min(pos, KITCHEN_SINK.length) },
        extensions: markdownForMode("enhanced"),
      });
      const tree = ensureSyntaxTree(state, KITCHEN_SINK.length, 5000)!;
      expect(() =>
        buildLivePreviewDecorations(state, 0, KITCHEN_SINK.length, tree),
      ).not.toThrow();
    }
  });

  it("toggleBold works on a selection with paragraphGuard active", () => {
    const state = EditorState.create({
      doc: KITCHEN_SINK,
      selection: EditorSelection.single(2, 7), // "Title"
      extensions: [markdownForMode("enhanced"), paragraphGuard],
    });
    ensureSyntaxTree(state, KITCHEN_SINK.length, 5000);
    let out = "";
    const ok = toggleBold({
      state,
      dispatch: (tr) => {
        out = tr.state.doc.toString();
      },
    });
    expect(ok).toBe(true);
    expect(out).toContain("# **Title**");
  });

  it("toggleUnderline works on a plain selection", () => {
    const state = EditorState.create({
      doc: "hello world",
      selection: EditorSelection.single(0, 5),
      extensions: [markdownForMode("enhanced"), paragraphGuard],
    });
    ensureSyntaxTree(state, 11, 5000);
    let out = "";
    const ok = toggleUnderline({
      state,
      dispatch: (tr) => {
        out = tr.state.doc.toString();
      },
    });
    expect(ok).toBe(true);
    expect(out).toBe("<u>hello</u> world");
  });
});
