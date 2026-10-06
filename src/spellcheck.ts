import { syntaxTree } from "@codemirror/language";
import {
  EditorState,
  Extension,
  Facet,
  RangeSetBuilder,
  StateEffect,
} from "@codemirror/state";
import {
  Decoration,
  DecorationSet,
  EditorView,
  ViewPlugin,
  ViewUpdate,
} from "@codemirror/view";
import { invoke } from "@tauri-apps/api/core";
import { findMath } from "./math";

/**
 * Spelling underlines drawn by the editor itself, from the native Windows
 * spell checker (the `spell_check` command; the right-click suggestions come
 * from the same engine through `spell_suggest`).
 *
 * Why not the webview's own underline: WebView2 only checks words as they are
 * typed. Text that arrives any other way (an opened file, a reload, text that
 * was there when spellcheck was switched back on) is never checked, so an
 * opened document with typos showed no underline at all while right-click
 * still offered corrections. Found testing the 1.3.0 release build.
 *
 * Windows only: elsewhere there is no native checker behind `spell_check`,
 * and the webview's behaviour is left alone (see main.ts).
 */

/** Whether table cells, which are their own editable elements outside the
 * CodeMirror text, use the webview's spellcheck. They inherit `spellcheck`
 * from the editor content otherwise, which is "false" whenever these
 * underlines replace the webview's. */
export const cellSpellcheck = Facet.define<boolean, boolean>({
  combine: (values) => values.some((v) => v),
});

export interface WordRange {
  from: number;
  to: number;
  word: string;
}

// Constructs whose text is not prose: code, addresses, markup, pictures.
const SKIP_NODES = new Set([
  "InlineCode",
  "FencedCode",
  "CodeBlock",
  "URL",
  "Autolink",
  "HTMLTag",
  "Emoji",
  "Image",
]);

// Syntax the parser does not mark (or marks too broadly): any HTML comment,
// which also covers comment anchors and bodies, page breaks and ml:meta (not
// the CommentBlock node, which swallows the commented text on the same line);
// raw tags inside an HTML block; entities; footnote references and
// definitions; callout markers.
const SKIP_PATTERNS = [
  /<!--[\s\S]*?-->/g,
  /<\/?[A-Za-z][^>\n]*>/g,
  /&#?\w+;/g,
  /\[\^[^\]\n]+\]/g,
  /\[![A-Za-z]+\]/g,
];

const FRONTMATTER_RE = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/;

// A word: letters (with combining marks), optionally joined by apostrophes
// ("don't", "l'eau"). Hyphens split, as in every desktop spell checker.
const WORD_RE = /[\p{L}\p{M}]+(?:['’][\p{L}\p{M}]+)*/gu;
// Glued to digits, underscores or path separators it is an identifier, a
// file name or a measurement, not a word.
const GLUE_RE = /[\p{N}_\\/@]/u;

/** The words in [from, to) worth checking, in document order. */
export function extractWords(
  state: EditorState,
  from: number,
  to: number,
): WordRange[] {
  const text = state.sliceDoc(from, to);
  const skip: [number, number][] = [];
  syntaxTree(state).iterate({
    from,
    to,
    enter: (node) => {
      if (SKIP_NODES.has(node.name)) {
        skip.push([node.from, node.to]);
        return false;
      }
    },
  });
  for (const re of SKIP_PATTERNS) {
    for (const m of text.matchAll(re)) {
      skip.push([from + m.index, from + m.index + m[0].length]);
    }
  }
  for (const m of findMath(text, from)) skip.push([m.from, m.to]);
  if (from === 0) {
    const fm = FRONTMATTER_RE.exec(text);
    if (fm !== null) skip.push([0, fm[0].length]);
  }

  const words: WordRange[] = [];
  for (const m of text.matchAll(WORD_RE)) {
    const word = m[0];
    if (word.length < 2) continue;
    const start = m.index;
    const end = start + word.length;
    if (GLUE_RE.test(text[start - 1] ?? "") || GLUE_RE.test(text[end] ?? "")) {
      continue;
    }
    const wFrom = from + start;
    const wTo = from + end;
    if (skip.some(([a, b]) => wFrom < b && wTo > a)) continue;
    words.push({ from: wFrom, to: wTo, word });
  }
  return words;
}

/** Results arrived (or a word was added to the dictionary): redraw. */
const spellingChanged = StateEffect.define<null>();

// Per window, by exact spelling (the checker is case-sensitive: "monday" is
// wrong where "Monday" is not). true = misspelled.
const known = new Map<string, boolean>();
const inFlight = new Set<string>();
let checkerFailed = false;

/** Forget a word's verdict and re-check what is on screen, e.g. after it was
 * added to the user dictionary. */
export function recheckWord(view: EditorView, word: string): void {
  known.delete(word);
  view.dispatch({ effects: spellingChanged.of(null) });
}

const misspelledMark = Decoration.mark({ class: "cm-misspelled" });

// How long typing must pause before new words are sent off.
const CHECK_DELAY_MS = 250;
// Requests are split so one call never comes near the backend's limit.
const BATCH_SIZE = 1000;

const spellPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet = Decoration.none;
    // The end of the word being typed, which is not judged until the user
    // moves on (Chromium does the same): half a word is always "misspelled".
    typingAt: number | null = null;
    timer: number | undefined;
    queued = new Set<string>();
    destroyed = false;
    view: EditorView;

    constructor(view: EditorView) {
      this.view = view;
      this.decorations = this.build();
    }

    update(update: ViewUpdate) {
      if (update.docChanged) {
        const typed = update.transactions.some((tr) =>
          tr.isUserEvent("input.type"),
        );
        this.typingAt = typed ? update.state.selection.main.head : null;
      } else if (update.selectionSet) {
        this.typingAt = null;
      }
      if (
        update.docChanged ||
        update.viewportChanged ||
        update.selectionSet ||
        update.transactions.some((tr) =>
          tr.effects.some((e) => e.is(spellingChanged)),
        )
      ) {
        this.decorations = this.build();
      }
    }

    build(): DecorationSet {
      const builder = new RangeSetBuilder<Decoration>();
      const state = this.view.state;
      for (const { from, to } of this.view.visibleRanges) {
        for (const w of extractWords(state, from, to)) {
          const verdict = known.get(w.word);
          if (verdict === undefined) {
            if (!inFlight.has(w.word)) this.queued.add(w.word);
            continue;
          }
          if (!verdict) continue;
          if (this.typingAt !== null && this.typingAt === w.to) continue;
          builder.add(w.from, w.to, misspelledMark);
        }
      }
      if (this.queued.size > 0) this.schedule();
      return builder.finish();
    }

    schedule() {
      if (checkerFailed) return;
      window.clearTimeout(this.timer);
      this.timer = window.setTimeout(() => void this.check(), CHECK_DELAY_MS);
    }

    async check() {
      const words = [...this.queued].filter(
        (w) => !known.has(w) && !inFlight.has(w),
      );
      this.queued.clear();
      if (words.length === 0) return;
      for (const w of words) inFlight.add(w);
      try {
        for (let i = 0; i < words.length; i += BATCH_SIZE) {
          const batch = words.slice(i, i + BATCH_SIZE);
          const verdicts = await invoke<boolean[]>("spell_check", {
            words: batch,
          });
          batch.forEach((w, j) => known.set(w, verdicts[j] === true));
        }
      } catch (err) {
        // No checker (unsupported locale, COM failure): nothing is
        // underlined, said once, and not retried on every keystroke.
        checkerFailed = true;
        console.error("[monoleaf] spell check unavailable:", err);
      } finally {
        for (const w of words) inFlight.delete(w);
      }
      if (!this.destroyed) {
        this.view.dispatch({ effects: spellingChanged.of(null) });
      }
    }

    destroy() {
      this.destroyed = true;
      window.clearTimeout(this.timer);
    }
  },
  { decorations: (v) => v.decorations },
);

/** The editor's own spelling underlines (Windows; see the module comment). */
export function spellUnderlines(): Extension {
  return spellPlugin;
}

/** Test hook: forget every verdict and the failure latch. */
export function resetSpellCacheForTests(): void {
  known.clear();
  inFlight.clear();
  checkerFailed = false;
}
