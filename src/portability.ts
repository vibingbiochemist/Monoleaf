import { markdown } from "@codemirror/lang-markdown";
import { GFM, Subscript, Superscript, Emoji } from "@lezer/markdown";
import { languages } from "@codemirror/language-data";
import { syntaxTree } from "@codemirror/language";
import {
  Decoration,
  DecorationSet,
  EditorView,
  ViewPlugin,
  ViewUpdate,
} from "@codemirror/view";
import { Extension, RangeSetBuilder } from "@codemirror/state";
import type { Tree } from "@lezer/common";

export type PortabilityMode = "strict" | "enhanced";

/**
 * Syntax node types produced only by parser extensions beyond the portable
 * CommonMark+GFM baseline. A dumb viewer renders these as literal text.
 * Grows as more enhanced constructs (footnotes, math, admonitions) gain
 * parser extensions in later stages.
 */
export const NON_PORTABLE_NODES: ReadonlyMap<string, string> = new Map([
  ["Superscript", "Superscript (^…^)"],
  ["Subscript", "Subscript (~…~)"],
  ["Emoji", "Emoji shortcode (:…:)"],
]);

/**
 * The parser configuration per mode. Strict is the portable baseline
 * (CommonMark + GFM: tables, task lists, strikethrough, autolinks) on the
 * default commonmark base; enhanced adds the richer constructs, which the
 * flagger then marks as non-portable.
 */
export function markdownForMode(mode: PortabilityMode) {
  return markdown({
    codeLanguages: languages,
    extensions:
      mode === "enhanced" ? [GFM, Subscript, Superscript, Emoji] : [GFM],
  });
}

export interface NonPortableRange {
  from: number;
  to: number;
  type: string;
  label: string;
}

/** Collect beyond-baseline construct ranges from a parsed syntax tree. */
export function findNonPortableRanges(
  tree: Tree,
  from = 0,
  to = tree.length,
): NonPortableRange[] {
  const found: NonPortableRange[] = [];
  tree.iterate({
    from,
    to,
    enter: (node) => {
      const label = NON_PORTABLE_NODES.get(node.name);
      if (label !== undefined) {
        found.push({ from: node.from, to: node.to, type: node.name, label });
      }
    },
  });
  return found;
}

function flagDecoration(label: string): Decoration {
  return Decoration.mark({
    class: "cm-nonportable",
    attributes: {
      title: `${label} is outside the portable CommonMark+GFM baseline; a plain markdown viewer shows it as literal text.`,
    },
  });
}

const nonPortableFlagger = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = this.build(view);
    }

    update(update: ViewUpdate) {
      if (
        update.docChanged ||
        update.viewportChanged ||
        syntaxTree(update.state) !== syntaxTree(update.startState)
      ) {
        this.decorations = this.build(update.view);
      }
    }

    build(view: EditorView): DecorationSet {
      const builder = new RangeSetBuilder<Decoration>();
      const tree = syntaxTree(view.state);
      for (const { from, to } of view.visibleRanges) {
        for (const range of findNonPortableRanges(tree, from, to)) {
          builder.add(range.from, range.to, flagDecoration(range.label));
        }
      }
      return builder.finish();
    }
  },
  { decorations: (plugin) => plugin.decorations },
);

/**
 * Everything mode-dependent, meant to live inside a Compartment so toggling
 * reconfigures in place (same document, same cursor). Flagging is only
 * possible in enhanced mode (in strict mode the constructs are not parsed at
 * all, so the document is literal text everywhere, exactly what a dumb
 * viewer sees) and additionally gated behind showFlags, an app setting that
 * defaults to off.
 */
export function portabilityExtensions(
  mode: PortabilityMode,
  showFlags = false,
): Extension {
  return [
    markdownForMode(mode),
    mode === "enhanced" && showFlags ? nonPortableFlagger : [],
  ];
}
