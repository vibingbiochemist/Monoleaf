import {
  defaultKeymap,
  history,
  historyKeymap,
  indentLess,
  insertTab,
} from "@codemirror/commands";
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
    // defaultKeymap has no Tab binding at all (CodeMirror leaves it free for
    // browser focus navigation by default), which is why Tab was landing on
    // the toolbar instead of the document. insertTab puts a tab character at
    // the cursor, or indents every selected line when there's a selection —
    // the same split codemirror.net's own examples use, and it matches what a
    // Word-like editor's users expect from the key. This doesn't trap
    // keyboard focus: CodeMirror's core view already treats Escape as "let
    // the next Tab through to the browser" independent of this keymap.
    { key: "Tab", run: insertTab, shift: indentLess },
  ]),
];

/** The technical trimmings for the raw markdown ("source") view. */
export const rawViewExtensions: Extension = [
  lineNumbers(),
  highlightActiveLineGutter(),
  foldGutter(),
  highlightActiveLine(),
];
