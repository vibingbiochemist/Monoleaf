/**
 * Live footnote rendering for the writing view. A reference [^1] shows as a
 * small superscript badge; a definition line [^1]: … shows its marker as the
 * same badge so the notes read like numbered items. The raw source returns
 * when the cursor is on that line (edit in place), and footnotes inside code
 * are left alone. Ctrl+click a reference jumps to its definition and vice
 * versa (wired in main.ts via the #fn:/#fnref: data-url scheme). [^1] is plain
 * text in the .md and renders on GitHub too.
 */
import { syntaxTree } from "@codemirror/language";
import { EditorState, Extension, RangeSetBuilder } from "@codemirror/state";
import {
  Decoration,
  DecorationSet,
  EditorView,
  ViewPlugin,
  ViewUpdate,
  WidgetType,
} from "@codemirror/view";

interface FootnoteMatch {
  from: number;
  to: number;
  label: string;
  kind: "ref" | "def";
}

class FootnoteWidget extends WidgetType {
  constructor(
    readonly label: string,
    readonly kind: "ref" | "def",
  ) {
    super();
  }

  eq(other: FootnoteWidget) {
    return other.label === this.label && other.kind === this.kind;
  }

  toDOM() {
    const sup = document.createElement("sup");
    sup.className =
      this.kind === "ref"
        ? "cm-footnote cm-footnote-ref"
        : "cm-footnote cm-footnote-def";
    sup.textContent = this.label;
    sup.setAttribute(
      "data-url",
      this.kind === "ref" ? `#fn:${this.label}` : `#fnref:${this.label}`,
    );
    sup.title =
      this.kind === "ref"
        ? `Footnote ${this.label}: Ctrl+click to jump to the note`
        : `Note ${this.label}: Ctrl+click to jump back to the reference`;
    return sup;
  }

  ignoreEvent() {
    return false;
  }
}

const CODE_NODE = /Code|Comment|HTML/;

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

function cursorOnLine(state: EditorState, from: number, to: number): boolean {
  const lineStart = state.doc.lineAt(from).from;
  const lineEnd = state.doc.lineAt(to).to;
  return state.selection.ranges.some(
    (r) => r.head >= lineStart && r.head <= lineEnd,
  );
}

const DEF_RE = /^(\s*)\[\^([^\]\s]+)\]:[ \t]?/;
const REF_RE = /\[\^([^\]\s]+)\]/g;

// Scan one line, classifying the definition marker (if any) and references.
function findInLine(lineText: string, lineFrom: number): FootnoteMatch[] {
  const matches: FootnoteMatch[] = [];
  let defEnd = -1;
  const def = DEF_RE.exec(lineText);
  if (def) {
    const start = lineFrom + def[1].length;
    const end = lineFrom + def[0].length;
    matches.push({ from: start, to: end, label: def[2], kind: "def" });
    defEnd = def[0].length;
  }
  REF_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = REF_RE.exec(lineText)) !== null) {
    if (m.index < defEnd) continue; // part of the definition marker
    matches.push({
      from: lineFrom + m.index,
      to: lineFrom + m.index + m[0].length,
      label: m[1],
      kind: "ref",
    });
  }
  return matches;
}

function buildFootnoteDecorations(view: EditorView): {
  decorations: DecorationSet;
  atomics: DecorationSet;
} {
  const decorations = new RangeSetBuilder<Decoration>();
  const atomics = new RangeSetBuilder<Decoration>();
  const state = view.state;
  for (const { from, to } of view.visibleRanges) {
    let pos = from;
    while (pos <= to) {
      const line = state.doc.lineAt(pos);
      for (const match of findInLine(line.text, line.from)) {
        if (insideCode(state, match.from)) continue;
        if (cursorOnLine(state, match.from, match.to)) continue;
        const deco = Decoration.replace({
          widget: new FootnoteWidget(match.label, match.kind),
        });
        decorations.add(match.from, match.to, deco);
        atomics.add(match.from, match.to, deco);
      }
      if (line.to >= to) break;
      pos = line.to + 1;
    }
  }
  return { decorations: decorations.finish(), atomics: atomics.finish() };
}

const footnotePlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    atomics: DecorationSet;

    constructor(view: EditorView) {
      const built = buildFootnoteDecorations(view);
      this.decorations = built.decorations;
      this.atomics = built.atomics;
    }

    update(update: ViewUpdate) {
      if (update.docChanged || update.viewportChanged || update.selectionSet) {
        const built = buildFootnoteDecorations(update.view);
        this.decorations = built.decorations;
        this.atomics = built.atomics;
      }
    }
  },
  {
    decorations: (plugin) => plugin.decorations,
  },
);

/** Position of a footnote definition line ([^label]:), or null. */
export function footnoteDefPos(
  state: EditorState,
  label: string,
): number | null {
  for (let i = 1; i <= state.doc.lines; i++) {
    const line = state.doc.line(i);
    const m = DEF_RE.exec(line.text);
    if (m && m[2] === label) return line.from + m[1].length;
  }
  return null;
}

/** Position of the first reference [^label] (not the definition), or null. */
export function footnoteRefPos(
  state: EditorState,
  label: string,
): number | null {
  const needle = `[^${label}]`;
  for (let i = 1; i <= state.doc.lines; i++) {
    const line = state.doc.line(i);
    if (DEF_RE.test(line.text) && DEF_RE.exec(line.text)![2] === label) {
      continue; // skip the definition line
    }
    const idx = line.text.indexOf(needle);
    if (idx >= 0) return line.from + idx;
  }
  return null;
}

export { findInLine };

export function footnoteExtensions(): Extension {
  return [
    footnotePlugin,
    EditorView.atomicRanges.of(
      (view) => view.plugin(footnotePlugin)?.atomics ?? Decoration.none,
    ),
  ];
}
