import { EditorState } from "@codemirror/state";

// Comment anchor tokens (see comments.ts). Formatting must never place
// markdown delimiters directly against these: they are invisible in live
// view, and a delimiter touching "<!--" is not flanking per GFM, so the
// construct would silently fail to parse.
const ANCHOR_FWD = /^<!--c:[a-z0-9]+[se]-->/;
const ANCHOR_BWD = /<!--c:[a-z0-9]+[se]-->$/;
const LOOKBEHIND = 40;

/**
 * Shrink [from, to] past leading/trailing whitespace AND comment anchor
 * tokens, so wrapping delimiters land against actual text.
 */
export function trimRange(
  state: EditorState,
  from: number,
  to: number,
): { from: number; to: number } {
  for (;;) {
    if (from < to && /\s/.test(state.doc.sliceString(from, from + 1))) {
      from++;
      continue;
    }
    const fwd = ANCHOR_FWD.exec(
      state.doc.sliceString(from, Math.min(to, from + LOOKBEHIND)),
    );
    if (fwd !== null) {
      from += fwd[0].length;
      continue;
    }
    break;
  }
  for (;;) {
    if (to > from && /\s/.test(state.doc.sliceString(to - 1, to))) {
      to--;
      continue;
    }
    const bwd = ANCHOR_BWD.exec(
      state.doc.sliceString(Math.max(from, to - LOOKBEHIND), to),
    );
    if (bwd !== null) {
      to -= bwd[0].length;
      continue;
    }
    break;
  }
  return { from, to };
}
