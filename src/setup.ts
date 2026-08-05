import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import {
  bracketMatching,
  defaultHighlightStyle,
  foldGutter,
  foldKeymap,
  indentOnInput,
  syntaxHighlighting,
} from "@codemirror/language";
import {
  highlightSelectionMatches,
  search,
  searchKeymap,
} from "@codemirror/search";
import {
  drawSelection,
  dropCursor,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
} from "@codemirror/view";
import { Extension } from "@codemirror/state";

/**
 * Like CodeMirror's basicSetup, minus the programmer-editor behaviors that
 * are wrong for a Word-like document editor:
 * - NO allowMultipleSelections / rectangularSelection / crosshairCursor —
 *   Ctrl+click must never spawn extra cursors (and Ctrl+click is reserved
 *   for opening links in the browser).
 * - NO autocompletion or auto-closing brackets — typing "(" should type "(".
 * - NO lint plumbing.
 * - NO gutters or active-line highlight here: those belong to the raw
 *   ("source") view only — see rawViewExtensions. Live view is a clean
 *   document canvas.
 */
export const editorSetup: Extension = [
  highlightSpecialChars(),
  history(),
  drawSelection(),
  dropCursor(),
  indentOnInput(),
  syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
  bracketMatching(),
  highlightSelectionMatches(),
  // Find & replace panel docked at the top, styled in styles.css.
  search({ top: true }),
  keymap.of([
    ...defaultKeymap,
    ...searchKeymap,
    ...historyKeymap,
    ...foldKeymap,
  ]),
];

/** The technical trimmings for the raw markdown ("source") view. */
export const rawViewExtensions: Extension = [
  lineNumbers(),
  highlightActiveLineGutter(),
  foldGutter(),
  highlightActiveLine(),
];
