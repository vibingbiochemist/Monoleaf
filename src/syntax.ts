import { syntaxTree } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";
import type { SyntaxNode } from "@lezer/common";

/** True when the innermost syntax node at `pos`, or any ancestor of it, has a
 * name matching `re`. `side` picks the node starting (1) or ending (-1) at
 * `pos` when two touch there, as in Tree.resolveInner. */
export function ancestorMatches(
  state: EditorState,
  pos: number,
  re: RegExp,
  side: -1 | 1 = 1,
): boolean {
  for (
    let n: SyntaxNode | null = syntaxTree(state).resolveInner(pos, side);
    n !== null;
    n = n.parent
  ) {
    if (re.test(n.name)) return true;
  }
  return false;
}
