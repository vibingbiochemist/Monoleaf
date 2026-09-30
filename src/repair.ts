import { syntaxTree } from "@codemirror/language";
import type { SyntaxNode } from "@lezer/common";
import {
  ChangeSpec,
  EditorSelection,
  EditorState,
  Line,
  Prec,
  Transaction,
  TransactionSpec,
} from "@codemirror/state";

/**
 * Markup repair for the silent WYSIWYG live view.
 *
 * Syntax markers are hidden only while the parser recognises their construct,
 * so any edit that leaves a construct invalid — even for a moment — makes its
 * raw markdown reappear: a "\" after joining a hard-break line, "**" after
 * Backspace ate a closing marker, "****" after the last bold letter went.
 * Hidden markers are also atomic, which means the cursor positions on either
 * side of one render at the same pixel, so the user cannot tell whether they
 * are about to type inside or outside the construct.
 *
 * This module is the one place that knows about both problems. A transaction
 * filter (a) normalises cursor placement so the ambiguous positions are never
 * reachable, and (b) rewrites the ordinary edits (Backspace, Delete, typing,
 * selection deletes) so the markdown that results is what the visible text
 * suggests. The Enter commands in commands.ts use the same construct lookup.
 */

// ---------------------------------------------------------------------------
// Construct lookup

/** An inline wrapper: the content is [open.to, close.from). */
export interface InlineConstruct {
  name: string;
  open: { from: number; to: number };
  close: { from: number; to: number };
}

const INLINE_MARKS: Record<string, string> = {
  Emphasis: "EmphasisMark",
  StrongEmphasis: "EmphasisMark",
  Strikethrough: "StrikethroughMark",
  Subscript: "SubscriptMark",
  Superscript: "SuperscriptMark",
  InlineCode: "CodeMark",
};

// Underline / highlight are inline HTML (see toggleHtmlWrap in commands.ts).
const HTML_PAIRS = [
  { open: "<u>", close: "</u>" },
  { open: "<mark>", close: "</mark>" },
];
const HTML_TAG_RE = /<\/?(u|mark)>/g;

function constructOf(node: SyntaxNode): InlineConstruct | null {
  const markName = INLINE_MARKS[node.name];
  if (markName === undefined) return null;
  const marks = node.getChildren(markName);
  if (marks.length < 2) return null;
  const first = marks[0];
  const last = marks[marks.length - 1];
  return {
    name: node.name,
    open: { from: first.from, to: first.to },
    close: { from: last.from, to: last.to },
  };
}

/** The block (paragraph-ish) node containing `pos`, or the line as fallback. */
function blockRange(
  state: EditorState,
  pos: number,
): { from: number; to: number } {
  for (
    let n: SyntaxNode | null = syntaxTree(state).resolveInner(pos, -1);
    n !== null;
    n = n.parent
  ) {
    if (
      /^(Paragraph|ATXHeading[1-6]|SetextHeading[12]|TableCell)$/.test(n.name)
    ) {
      return { from: n.from, to: n.to };
    }
  }
  const line = state.doc.lineAt(pos);
  return { from: line.from, to: line.to };
}

/** <u>…</u> / <mark>…</mark> pairs enclosing `pos` (content-wise). */
function htmlConstructsAt(state: EditorState, pos: number): InlineConstruct[] {
  const block = blockRange(state, pos);
  const text = state.doc.sliceString(block.from, block.to);
  if (!text.includes("<")) return [];
  const out: InlineConstruct[] = [];
  for (const pair of HTML_PAIRS) {
    const opens: { from: number; to: number }[] = [];
    HTML_TAG_RE.lastIndex = 0;
    for (
      let m = HTML_TAG_RE.exec(text);
      m !== null;
      m = HTML_TAG_RE.exec(text)
    ) {
      const from = block.from + m.index;
      const to = from + m[0].length;
      if (m[0] === pair.open) {
        opens.push({ from, to });
      } else if (m[0] === pair.close) {
        const open = opens.pop();
        if (open !== undefined && open.to <= pos && pos <= from) {
          out.push({ name: pair.open, open, close: { from, to } });
        }
      }
    }
  }
  return out;
}

/**
 * Inline constructs whose content (including its edges) contains `pos`,
 * outermost first. A cursor sitting right after a closing marker or right
 * before an opening one is OUTSIDE and not reported.
 */
export function inlineConstructsAt(
  state: EditorState,
  pos: number,
): InlineConstruct[] {
  const out: InlineConstruct[] = [];
  const seen = new Set<number>();
  for (const side of [-1, 1] as const) {
    for (
      let n: SyntaxNode | null = syntaxTree(state).resolveInner(pos, side);
      n !== null;
      n = n.parent
    ) {
      const c = constructOf(n);
      if (c === null || seen.has(c.open.from)) continue;
      if (c.open.to <= pos && pos <= c.close.from) {
        seen.add(c.open.from);
        out.push(c);
      }
    }
  }
  out.push(...htmlConstructsAt(state, pos));
  return out.sort((a, b) => a.open.from - b.open.from);
}

/** The construct whose opening or closing marker is exactly [from, to). */
function constructWithMark(
  state: EditorState,
  from: number,
  to: number,
): { construct: InlineConstruct; side: "open" | "close" } | null {
  for (const c of inlineConstructsAt(state, to)) {
    if (c.open.from === from && c.open.to === to)
      return { construct: c, side: "open" };
  }
  for (const c of inlineConstructsAt(state, from)) {
    if (c.close.from === from && c.close.to === to) {
      return { construct: c, side: "close" };
    }
  }
  return null;
}

/**
 * From `pos` at a content start, hop outward over every opening marker that
 * ends exactly there ("***|x***" → 0): the position before the outermost
 * abutting construct.
 */
function outerOpenEdge(state: EditorState, pos: number): number {
  for (let guard = 0; guard < 8; guard++) {
    const c = inlineConstructsAt(state, pos).find((k) => k.open.to === pos);
    if (c === undefined) break;
    pos = c.open.from;
  }
  return pos;
}

/** Mirror of outerOpenEdge for closers: "***x|***" → 7. */
function outerCloseEdge(state: EditorState, pos: number): number {
  for (let guard = 0; guard < 8; guard++) {
    const c = inlineConstructsAt(state, pos).find((k) => k.close.from === pos);
    if (c === undefined) break;
    pos = c.close.to;
  }
  return pos;
}

/**
 * Where a cursor at `pos` sits if moved just OUTSIDE the constructs whose
 * marker it touches: after all closers ending there, else before all openers
 * starting there, else `pos` itself. Used for edits that may not sit right
 * inside a delimiter (a space, a hard break).
 */
export function outsideConstructEdge(state: EditorState, pos: number): number {
  const after = outerCloseEdge(state, pos);
  return after !== pos ? after : outerOpenEdge(state, pos);
}

// ---------------------------------------------------------------------------
// Hard breaks and leading block markers

/**
 * Does `line` end with a Shift+Enter hard break ("\" + newline)? True for a
 * parsed HardBreak, and for the freshly typed case where the continuation
 * line is still empty (the parser only sees a HardBreak once it has content).
 * Never true for an escaped backslash or a backslash inside code.
 */
export function hardBreakLineEnd(state: EditorState, line: Line): boolean {
  if (!line.text.endsWith("\\") || line.number >= state.doc.lines) return false;
  const n = syntaxTree(state).resolveInner(line.to - 1, 1);
  if (n.name === "HardBreak") return true;
  if (/Escape|Code|Comment|HTML|Math|Table/.test(n.name)) return false;
  return state.doc.line(line.number + 1).length === 0;
}

/**
 * End of the hidden leading block markers on `line` — the bullet (and task
 * checkbox) or quote marks the live view replaces, each with its following
 * space — or `line.from` when the line has none. Ordered-list numbers stay
 * visible and are not counted.
 */
export function leadingHiddenEnd(state: EditorState, line: Line): number {
  const tree = syntaxTree(state);
  let pos = line.from;
  for (let guard = 0; guard < 8; guard++) {
    const n = tree.resolveInner(pos, 1);
    if (n.from !== pos) break;
    let end: number;
    if (n.name === "QuoteMark") {
      end = n.to;
    } else if (
      n.name === "ListMark" &&
      /^[-*+]$/.test(state.doc.sliceString(n.from, n.to))
    ) {
      end = n.to;
      const task = n.nextSibling;
      if (task?.name === "Task") {
        const marker = task.getChild("TaskMarker");
        if (marker !== null) end = marker.to;
      }
    } else {
      break;
    }
    if (state.doc.sliceString(end, end + 1) === " ") end++;
    if (end <= pos) break;
    pos = end;
  }
  return pos;
}

// ---------------------------------------------------------------------------
// Cursor normalisation

/**
 * Where a cursor placed at `head` should really go. Two positions render at
 * the same pixel: line end vs. before a hard-break "\", and line start vs.
 * after a hidden bullet/quote mark. Keep the cursor on the side where typing
 * does what the picture suggests. `snap` is set for moves that name a place
 * (Home/End, a click): those always land on the typing side. Otherwise
 * `prevHead` distinguishes an arrow-key step that landed on the other side
 * (keep moving in that direction) from a vertical move (snap back) — the
 * transaction alone cannot tell End from ArrowRight, so the Home/End
 * commands in commands.ts mark themselves with a "select.boundary" event.
 */
function normaliseCursor(
  state: EditorState,
  prevHead: number,
  head: number,
  snap: boolean,
): number {
  const line = state.doc.lineAt(head);
  if (head === line.to && hardBreakLineEnd(state, line)) {
    return !snap && prevHead === line.to - 1 ? line.to + 1 : line.to - 1;
  }
  if (head === line.from) {
    const end = leadingHiddenEnd(state, line);
    if (end > line.from) {
      if (snap || prevHead !== end || line.number === 1) return end;
      const prev = state.doc.line(line.number - 1);
      return hardBreakLineEnd(state, prev) ? prev.to - 1 : prev.to;
    }
  }
  return head;
}

function normaliseSelection(
  tr: Transaction,
  userEvent: string,
): TransactionSpec | null {
  const sel = tr.newSelection;
  const prevHead = tr.startState.selection.main.head;
  const snap =
    userEvent === "select.pointer" || userEvent === "select.boundary";
  let changed = false;
  const ranges = sel.ranges.map((r) => {
    if (!r.empty) return r;
    const head = normaliseCursor(tr.state, prevHead, r.head, snap);
    if (head === r.head) return r;
    changed = true;
    return EditorSelection.cursor(head, undefined, undefined, r.goalColumn);
  });
  if (!changed) return null;
  return { selection: EditorSelection.create(ranges, sel.mainIndex) };
}

// ---------------------------------------------------------------------------
// Edit rewriting

interface Edit {
  from: number;
  to: number;
  insert: string;
  /** Cursor after the edit, in start-state positions; -1 = end of the
   * inserted text. */
  cursor: number;
  extra: ChangeSpec[];
}

const isWhitespace = (s: string) => s.length > 0 && /^[ \t]+$/.test(s);

function rewriteEdit(state: EditorState, ue: string, e: Edit): boolean {
  let changed = false;
  const doc = state.doc;
  const deleting = e.to > e.from;
  const isDelete = ue.startsWith("delete");

  if (deleting) {
    // Joining a hard-break line with the next: the deletion starts exactly at
    // the newline and would leave the "\" behind, glued to the next line.
    // Covers Delete at line end, Ctrl+Backspace, and selection deletes.
    const endLine = doc.lineAt(e.from);
    if (
      e.from === endLine.to &&
      e.from > endLine.from &&
      hardBreakLineEnd(state, endLine)
    ) {
      e.from -= 1;
      if (e.insert === "") e.cursor = e.from;
      changed = true;
    }

    // Deleting just the "\" of a hard break (Delete in front of the atomic
    // marker): take the newline with it, so the lines join as intended.
    if (isDelete && e.insert === "") {
      const line = doc.lineAt(e.from);
      if (
        e.from === line.to - 1 &&
        e.to === line.to &&
        hardBreakLineEnd(state, line)
      ) {
        e.to = line.to + 1;
        e.cursor = e.from;
        changed = true;
      }
    }

    // Backspace/Delete on a hidden marker: the atomic range made the whole
    // "**" the deletion target. Word semantics instead: delete the content
    // character next to the marker (dropping the construct once it is empty);
    // at the outer edge, delete the plain character beyond the marker.
    if (isDelete && e.insert === "") {
      const hit = constructWithMark(state, e.from, e.to);
      if (hit !== null) {
        const { construct: c, side } = hit;
        const contentLen = c.close.from - c.open.to;
        const backward = ue.startsWith("delete.backward");
        const line = doc.lineAt(e.from);
        const unwrap = () => {
          e.from = c.open.from;
          e.to = c.open.to;
          e.extra = [{ from: c.close.from, to: c.close.to }];
          e.cursor = c.open.from;
        };
        if ((side === "close" && backward) || (side === "open" && !backward)) {
          // Deleting into the content from its end / start.
          if (contentLen <= 1) {
            e.from = c.open.from;
            e.to = c.close.to;
            e.cursor = c.open.from;
          } else if (side === "close") {
            e.from = c.close.from - 1;
            e.to = c.close.from;
            e.cursor = e.from;
          } else {
            e.from = c.open.to;
            e.to = c.open.to + 1;
            e.cursor = e.from;
          }
        } else if (side === "open") {
          // Backspace at the content start: the character before the
          // construct — before ALL the constructs whose openers abut here
          // ("***|x***"), or one of the outer markers would lose a character.
          const edge = outerOpenEdge(state, c.open.from);
          if (edge === line.from) unwrap();
          else {
            e.from = edge - 1;
            e.to = edge;
            e.cursor = e.from;
          }
        } else {
          // Delete at the content end: the character after the construct(s).
          const edge = outerCloseEdge(state, c.close.to);
          if (edge === line.to) unwrap();
          else {
            e.from = edge;
            e.to = edge + 1;
            e.cursor = c.close.from;
          }
        }
        changed = true;
      }
    }

    // Deleting all of a construct's content leaves an empty marker pair
    // ("****"), which never parses. Remove the whole construct instead.
    if (e.insert === "") {
      for (const c of inlineConstructsAt(state, e.from)) {
        if (c.open.to === e.from && c.close.from === e.to) {
          e.from = c.open.from;
          e.to = c.close.to;
          e.cursor = c.open.from;
          changed = true;
          break;
        }
      }
    }

    // Backspace at the start of a heading line: un-head it (Word removes the
    // paragraph style first) instead of joining "para# Heading".
    if (isDelete && e.insert === "" && ue.startsWith("delete.backward")) {
      const line = doc.lineAt(e.to);
      if (
        e.to === line.from &&
        e.to - e.from === 1 &&
        doc.lineAt(e.from).to === e.from
      ) {
        const n = syntaxTree(state).resolveInner(line.from, 1);
        if (
          n.name === "HeaderMark" &&
          n.from === line.from &&
          /^ATXHeading[1-6]$/.test(n.parent?.name ?? "")
        ) {
          let end = n.to;
          if (doc.sliceString(end, end + 1) === " ") end++;
          e.from = n.from;
          e.to = end;
          e.cursor = n.from;
          changed = true;
        }
      }
    }
  } else if (ue === "input.type" && isWhitespace(e.insert)) {
    // A space typed right inside a marker ("**bold |**", "**| bold**") breaks
    // the construct (GFM forbids whitespace just inside delimiters) — and the
    // position is indistinguishable from just outside it. Type it outside.
    const pos = outsideConstructEdge(state, e.from);
    if (pos !== e.from) {
      e.from = e.to = pos;
      e.cursor = -1;
      changed = true;
    }
  }
  return changed;
}

function repairTransaction(
  tr: Transaction,
): TransactionSpec | readonly TransactionSpec[] {
  const ue = tr.annotation(Transaction.userEvent) ?? "";
  if (!tr.docChanged) {
    if (tr.selection === undefined) return tr;
    const fixed = normaliseSelection(tr, ue);
    return fixed === null ? tr : [tr, fixed];
  }
  if (
    ue === "" ||
    ue.includes("compose") ||
    ue.includes(".critic") ||
    ue.includes(".tracked") ||
    tr.effects.length > 0
  ) {
    return tr;
  }
  // Only the ordinary single-change user edits are rewritten.
  let count = 0;
  let edit: Edit | null = null;
  const state = tr.startState;
  tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    count++;
    const insert = inserted.sliceString(0, inserted.length, state.lineBreak);
    edit = {
      from: fromA,
      to: toA,
      insert,
      cursor: insert === "" ? fromA : -1,
      extra: [],
    };
  });
  if (count !== 1 || edit === null) return tr;
  const e = edit as Edit;
  if (!rewriteEdit(state, ue, e)) return tr;
  const changes = state.changes([
    { from: e.from, to: e.to, insert: e.insert },
    ...e.extra,
  ]);
  const cursor =
    e.cursor === -1 ? changes.mapPos(e.to, 1) : changes.mapPos(e.cursor, -1);
  return {
    changes,
    selection: EditorSelection.cursor(cursor),
    userEvent: ue,
    scrollIntoView: tr.scrollIntoView,
  };
}

/**
 * The repair layer, live view only. CodeMirror runs transaction filters from
 * the LOWEST precedence up, so `Prec.lowest` makes this the first filter to
 * see the user's edit — before track changes (critic.ts) wraps it into a
 * suggestion, which must happen on the repaired edit.
 */
export const markupRepair = Prec.lowest(
  EditorState.transactionFilter.of(repairTransaction),
);
