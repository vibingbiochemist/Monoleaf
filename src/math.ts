/**
 * Live math rendering for the writing view. LaTeX between $…$ (inline) and
 * $$…$$ (display) is drawn with KaTeX; the raw source reappears whenever the
 * cursor sits on that line, so it can be edited in place (the same reveal
 * behaviour the rest of the live preview uses). Math inside code spans/blocks
 * is left alone. The $…$ syntax is plain text in the .md and renders on GitHub
 * too, so nothing about portability changes.
 */
import { syntaxTree } from "@codemirror/language";
import { Extension, RangeSetBuilder } from "@codemirror/state";
import { EditorState } from "@codemirror/state";
import {
  Decoration,
  DecorationSet,
  EditorView,
  ViewPlugin,
  ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import katex from "katex";
import "katex/dist/katex.min.css";

interface MathMatch {
  from: number;
  to: number;
  tex: string;
  display: boolean;
}

class MathWidget extends WidgetType {
  constructor(
    readonly tex: string,
    readonly display: boolean,
  ) {
    super();
  }

  eq(other: MathWidget) {
    return other.tex === this.tex && other.display === this.display;
  }

  toDOM() {
    const host = document.createElement("span");
    host.className = this.display ? "cm-math cm-math-display" : "cm-math";
    try {
      katex.render(this.tex, host, {
        displayMode: this.display,
        throwOnError: false,
        output: "htmlAndMathml",
      });
    } catch {
      const marker = this.display ? "$$" : "$";
      host.textContent = `${marker}${this.tex}${marker}`;
    }
    return host;
  }

  // Let clicks through so the cursor can be placed next to the widget.
  ignoreEvent() {
    return false;
  }
}

// Shown next to the raw source WHILE a formula is being edited, so you get a
// live rendered preview instead of editing LaTeX blind.
class MathPreviewWidget extends WidgetType {
  constructor(
    readonly tex: string,
    readonly display: boolean,
  ) {
    super();
  }

  eq(other: MathPreviewWidget) {
    return other.tex === this.tex && other.display === this.display;
  }

  toDOM() {
    const host = document.createElement("span");
    host.className = this.display
      ? "cm-math-preview cm-math-preview-display"
      : "cm-math-preview";
    host.setAttribute("contenteditable", "false");
    try {
      katex.render(this.tex, host, {
        displayMode: this.display,
        throwOnError: false,
        output: "htmlAndMathml",
      });
    } catch {
      host.textContent = this.tex;
    }
    return host;
  }

  ignoreEvent() {
    return true;
  }
}

// The node names whose interior must never be treated as math.
const CODE_NODE = /Code|Comment|HTML|URL|Link|Autolink/;

function insideCode(state: EditorState, pos: number): boolean {
  for (
    let node: ReturnType<typeof syntaxTree>["topNode"] | null = syntaxTree(
      state,
    ).resolveInner(pos, 1);
    node;
    node = node.parent
  ) {
    if (CODE_NODE.test(node.name)) return true;
  }
  return false;
}

// Reveal (show raw) when the cursor is on any line the math occupies, or when
// a non-empty selection overlaps it.
function cursorTouches(state: EditorState, from: number, to: number): boolean {
  const lineStart = state.doc.lineAt(from).from;
  const lineEnd = state.doc.lineAt(to).to;
  return state.selection.ranges.some((r) =>
    r.empty
      ? r.head >= lineStart && r.head <= lineEnd
      : r.from <= to && r.to >= from,
  );
}

const DISPLAY_RE = /\$\$([\s\S]+?)\$\$/g;
// Inline: opening $ not followed by whitespace, closing $ not preceded by
// whitespace; body may contain escaped \$; keeps "$5 and $10" out.
const INLINE_RE = /\$(?!\s)((?:\\.|[^\\$])+?)(?<!\s)\$/g;

export function findMath(text: string, offset: number): MathMatch[] {
  const matches: MathMatch[] = [];
  const taken: Array<[number, number]> = [];
  let m: RegExpExecArray | null;
  DISPLAY_RE.lastIndex = 0;
  while ((m = DISPLAY_RE.exec(text)) !== null) {
    const from = offset + m.index;
    const to = from + m[0].length;
    matches.push({ from, to, tex: m[1].trim(), display: true });
    taken.push([m.index, m.index + m[0].length]);
  }
  INLINE_RE.lastIndex = 0;
  while ((m = INLINE_RE.exec(text)) !== null) {
    const start = m.index;
    const end = m.index + m[0].length;
    if (taken.some(([a, b]) => start < b && end > a)) continue; // inside display
    matches.push({
      from: offset + start,
      to: offset + end,
      tex: m[1].trim(),
      display: false,
    });
  }
  return matches.sort((a, b) => a.from - b.from);
}

function buildMathDecorations(view: EditorView): {
  decorations: DecorationSet;
  atomics: DecorationSet;
} {
  const decorations = new RangeSetBuilder<Decoration>();
  const atomics = new RangeSetBuilder<Decoration>();
  const state = view.state;
  for (const { from, to } of view.visibleRanges) {
    const text = state.doc.sliceString(from, to);
    for (const match of findMath(text, from)) {
      if (insideCode(state, match.from)) continue;
      if (!match.tex) continue;
      if (cursorTouches(state, match.from, match.to)) {
        // Being edited: keep the raw source visible, append a live preview.
        decorations.add(
          match.to,
          match.to,
          Decoration.widget({
            widget: new MathPreviewWidget(match.tex, match.display),
            side: 1,
          }),
        );
        continue;
      }
      const deco = Decoration.replace({
        widget: new MathWidget(match.tex, match.display),
      });
      decorations.add(match.from, match.to, deco);
      atomics.add(match.from, match.to, deco);
    }
  }
  return { decorations: decorations.finish(), atomics: atomics.finish() };
}

const mathPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    atomics: DecorationSet;

    constructor(view: EditorView) {
      const built = buildMathDecorations(view);
      this.decorations = built.decorations;
      this.atomics = built.atomics;
    }

    update(update: ViewUpdate) {
      if (update.docChanged || update.viewportChanged || update.selectionSet) {
        const built = buildMathDecorations(update.view);
        this.decorations = built.decorations;
        this.atomics = built.atomics;
      }
    }
  },
  {
    decorations: (plugin) => plugin.decorations,
  },
);

export function mathExtensions(): Extension {
  return [
    mathPlugin,
    EditorView.atomicRanges.of(
      (view) => view.plugin(mathPlugin)?.atomics ?? Decoration.none,
    ),
  ];
}
