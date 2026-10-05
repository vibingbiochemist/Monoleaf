import {
  ChangeSet,
  EditorState,
  Facet,
  Range,
  Text,
  TransactionSpec,
} from "@codemirror/state";
import {
  Decoration,
  DecorationSet,
  EditorView,
  ViewPlugin,
  ViewUpdate,
} from "@codemirror/view";
import { trimRange } from "./ranges";
import { escapeDashes } from "./htmlcomment";

/**
 * Single-file review comments (brief Stage 3). A comment anchors to a text
 * range with inline HTML-comment delimiters that wrap the range:
 *
 *   ... the affinity <!--c:a1s--> was sub-nanomolar <!--c:a1e--> ...
 *
 * Because the delimiters are part of the text stream they travel with the
 * text as it is edited — no character offsets, no sidecar files. Thread
 * bodies live in one HTML-comment block per thread, keyed to the anchor id:
 *
 *   <!--c:a1 {"resolved":false,"thread":[{"author":"…","ts":"…","text":"…"}]}-->
 *
 * Every markdown renderer of note strips HTML comments, so dumb viewers show
 * plain text; an LLM reading the raw file sees everything.
 */

export interface CommentEntry {
  author: string;
  ts: string; // ISO timestamp
  text: string;
}

export interface CommentThread {
  id: string;
  resolved: boolean;
  thread: CommentEntry[];
  /** Delimiter token ranges; null when the anchors were deleted. */
  anchor: {
    startFrom: number;
    startTo: number;
    endFrom: number;
    endTo: number;
  } | null;
  /** Range of the body block token; null when the body is missing. */
  body: { from: number; to: number } | null;
}

const ANCHOR_RE = /<!--c:([a-z0-9]+)([se])-->/g;
const BODY_RE = /<!--c:([a-z0-9]+) (\{.*?\})-->/g;

function serializeBody(id: string, resolved: boolean, thread: CommentEntry[]) {
  return `<!--c:${id} ${escapeDashes(JSON.stringify({ resolved, thread }))}-->`;
}

export function parseComments(text: string): CommentThread[] {
  const byId = new Map<string, CommentThread>();
  const get = (id: string): CommentThread => {
    let t = byId.get(id);
    if (t === undefined) {
      t = { id, resolved: false, thread: [], anchor: null, body: null };
      byId.set(id, t);
    }
    return t;
  };

  const starts = new Map<string, { from: number; to: number }>();
  const ends = new Map<string, { from: number; to: number }>();
  for (const m of text.matchAll(ANCHOR_RE)) {
    const target = m[2] === "s" ? starts : ends;
    if (!target.has(m[1])) {
      target.set(m[1], { from: m.index, to: m.index + m[0].length });
    }
  }
  for (const [id, start] of starts) {
    const end = ends.get(id);
    if (end !== undefined && end.from >= start.to) {
      get(id).anchor = {
        startFrom: start.from,
        startTo: start.to,
        endFrom: end.from,
        endTo: end.to,
      };
    }
  }

  for (const m of text.matchAll(BODY_RE)) {
    const t = get(m[1]);
    if (t.body !== null) continue;
    try {
      const data = JSON.parse(m[2]) as {
        resolved?: boolean;
        thread?: CommentEntry[];
      };
      t.resolved = data.resolved === true;
      t.thread = Array.isArray(data.thread) ? data.thread : [];
      t.body = { from: m.index, to: m.index + m[0].length };
    } catch {
      // Malformed body: keep the thread (anchors may still exist) bodyless.
    }
  }

  return [...byId.values()].sort(
    (a, b) =>
      (a.anchor?.startFrom ?? Number.MAX_SAFE_INTEGER) -
      (b.anchor?.startFrom ?? Number.MAX_SAFE_INTEGER),
  );
}

// "s" and "e" are excluded so an id can never make a start token parse as a
// different thread's end token (or vice versa).
const ID_ALPHABET = "abcdfghjkmnpqrtuvwxyz0123456789";

export function generateId(existing: Set<string>): string {
  for (;;) {
    let id = "";
    for (let i = 0; i < 4; i++) {
      id += ID_ALPHABET[Math.floor(Math.random() * ID_ALPHABET.length)];
    }
    if (!existing.has(id)) return id;
  }
}

/** Wrap the main selection in anchors and append the thread body block. */
export function createCommentSpec(
  state: EditorState,
  author: string,
  text: string,
  ts: string,
): TransactionSpec | null {
  const range = trimRange(
    state,
    state.selection.main.from,
    state.selection.main.to,
  );
  if (range.from === range.to) return null;

  const existing = new Set(
    parseComments(state.doc.toString()).map((t) => t.id),
  );
  const id = generateId(existing);
  const nl = state.lineBreak;
  const end = state.doc.length;
  // Line breaks are 1 position each regardless of separator width, so the
  // last two breaks are the last two positions; expand them with nl so the
  // endsWith checks work for CRLF documents too.
  const tail = state.doc.sliceString(Math.max(0, end - 2), end, nl);
  const spacer = tail.endsWith(nl + nl) ? "" : tail.endsWith(nl) ? nl : nl + nl;

  return {
    changes: [
      { from: range.from, insert: `<!--c:${id}s-->` },
      { from: range.to, insert: `<!--c:${id}e-->` },
      {
        from: end,
        insert: `${spacer}${serializeBody(id, false, [{ author, ts, text }])}${nl}`,
      },
    ],
    userEvent: "input.comment",
  };
}

function rewriteBody(
  state: EditorState,
  id: string,
  update: (t: CommentThread) => { resolved: boolean; thread: CommentEntry[] },
): TransactionSpec | null {
  const thread = parseComments(state.doc.toString()).find((t) => t.id === id);
  if (thread === undefined || thread.body === null) return null;
  const next = update(thread);
  return {
    changes: {
      from: thread.body.from,
      to: thread.body.to,
      insert: serializeBody(id, next.resolved, next.thread),
    },
    userEvent: "input.comment",
  };
}

export function addReplySpec(
  state: EditorState,
  id: string,
  entry: CommentEntry,
): TransactionSpec | null {
  return rewriteBody(state, id, (t) => ({
    resolved: t.resolved,
    thread: [...t.thread, entry],
  }));
}

export function setResolvedSpec(
  state: EditorState,
  id: string,
  resolved: boolean,
): TransactionSpec | null {
  return rewriteBody(state, id, (t) => ({ resolved, thread: t.thread }));
}

// ---------------------------------------------------------------------------
// Deleting threads. Removes the comment syntax only: both anchor delimiters
// and the body block go, the commented text between the anchors stays.

const isBlank = (line: { text: string }) => line.text.trim() === "";

/**
 * Range to remove for a body block at [from, to). A body sharing its line with
 * other text is cut out exactly, nothing more. A body alone on its line takes
 * the line and one line break with it, so no empty line is left where it
 * stood. And because createCommentSpec sets the block off as its own
 * paragraph (a blank line before it), removing just the line would still
 * leave that separator behind: a doubled blank line between two paragraphs,
 * or a trailing blank line at the end of the file, growing by one per deleted
 * thread. So when the body was the only thing between two blank stretches
 * (or between a blank line and an edge of the document), one neighbouring
 * blank line goes too, which restores the document to how it looked before
 * the comment was added.
 */
function bodyRemoval(
  doc: Text,
  from: number,
  to: number,
): { from: number; to: number } {
  const line = doc.lineAt(from);
  if (line.text.trim() !== doc.sliceString(from, to)) return { from, to };

  const prev = line.number > 1 ? doc.line(line.number - 1) : null;
  const next = line.number < doc.lines ? doc.line(line.number + 1) : null;
  // Line breaks are a single position in the editor whatever the document's
  // separator, so "+ 1" / "- 1" step over one break for CRLF files as well.
  if (next !== null) {
    // The line plus its own trailing break. "next" may be the empty last line
    // after the file's final newline, which counts as blank: the body was the
    // last block, and its separator would otherwise become a trailing blank.
    if (prev !== null && isBlank(prev) && isBlank(next)) {
      return { from: prev.from, to: line.to + 1 };
    }
    // First line of the document, followed by a blank separator: take that
    // too, unless it is merely the empty last line (then the file just ends).
    if (prev === null && isBlank(next) && next.number < doc.lines) {
      return { from: line.from, to: next.to + 1 };
    }
    return { from: line.from, to: line.to + 1 };
  }
  // Last line with no final newline: take the break before it instead.
  if (prev === null) return { from: line.from, to: line.to };
  if (isBlank(prev)) {
    return { from: prev.number > 1 ? prev.from - 1 : prev.from, to: line.to };
  }
  return { from: line.from - 1, to: line.to };
}

/** Range to remove for the first remaining syntax token of thread `id`. */
function nextRemoval(
  doc: Text,
  id: string,
): { from: number; to: number } | null {
  const text = doc.toString();
  // Every token carrying the id, not just the pair parseComments picked: a
  // copy-paste can duplicate anchors, and a lone start or end token (its
  // partner deleted) leaves the thread with anchor === null. Deleting the
  // thread should leave none of them behind.
  for (const m of text.matchAll(ANCHOR_RE)) {
    if (m[1] === id) return { from: m.index, to: m.index + m[0].length };
  }
  for (const m of text.matchAll(BODY_RE)) {
    if (m[1] === id) {
      return bodyRemoval(doc, m.index, m.index + m[0].length);
    }
  }
  return null;
}

/**
 * Remove every token of the given threads as one change set. Tokens are
 * removed one at a time against the document as it stands after the previous
 * removal, then composed: the blank-line rules in bodyRemoval look at the
 * neighbouring lines, and two bodies on adjacent lines would otherwise each
 * see the other as non-blank (leaving their shared separator behind) or claim
 * overlapping ranges, which a single change set cannot hold.
 */
function removeThreads(
  state: EditorState,
  ids: string[],
): TransactionSpec | null {
  let doc = state.doc;
  let changes = ChangeSet.empty(doc.length);
  for (const id of ids) {
    for (;;) {
      const range = nextRemoval(doc, id);
      if (range === null) break;
      const step = ChangeSet.of(range, doc.length);
      changes = changes.compose(step);
      doc = step.apply(doc);
    }
  }
  if (changes.empty) return null;
  // One ordinary transaction, so a single Ctrl+Z restores everything it
  // removed. "input.comment" rather than a "delete.*" event: the history
  // merges adjacent "delete" events into one undo step, which could fold the
  // removal into a backspace typed just before it.
  return { changes, userEvent: "input.comment" };
}

/** Permanently remove a thread: its anchors and its body block. */
export function deleteThreadSpec(
  state: EditorState,
  id: string,
): TransactionSpec | null {
  return removeThreads(state, [id]);
}

/** Remove every resolved thread in one transaction. */
export function deleteResolvedSpec(state: EditorState): TransactionSpec | null {
  const ids = parseComments(state.doc.toString())
    .filter((t) => t.resolved)
    .map((t) => t.id);
  return removeThreads(state, ids);
}

// ---------------------------------------------------------------------------
// Editor decorations: range highlight always; anchor/body tokens hidden when
// the live preview provides hideCommentSyntax (raw view shows everything).

export const hideCommentSyntax = Facet.define<boolean, boolean>({
  combine: (values) => values.some((v) => v),
});

const highlight = Decoration.mark({ class: "cm-comment-range" });
const hide = Decoration.replace({});

export function buildCommentDecorations(state: EditorState): {
  decorations: DecorationSet;
  atomics: DecorationSet;
} {
  const threads = parseComments(state.doc.toString());
  const hideSyntax = state.facet(hideCommentSyntax);
  const ranges: Range<Decoration>[] = [];
  const atomics: Range<Decoration>[] = [];

  for (const t of threads) {
    if (t.anchor !== null) {
      if (!t.resolved && t.anchor.startTo < t.anchor.endFrom) {
        ranges.push(highlight.range(t.anchor.startTo, t.anchor.endFrom));
      }
      if (hideSyntax) {
        ranges.push(hide.range(t.anchor.startFrom, t.anchor.startTo));
        ranges.push(hide.range(t.anchor.endFrom, t.anchor.endTo));
        atomics.push(hide.range(t.anchor.startFrom, t.anchor.startTo));
        atomics.push(hide.range(t.anchor.endFrom, t.anchor.endTo));
      }
    }
    if (t.body !== null && hideSyntax) {
      ranges.push(hide.range(t.body.from, t.body.to));
      atomics.push(hide.range(t.body.from, t.body.to));
    }
  }

  return {
    decorations: Decoration.set(ranges, true),
    atomics: Decoration.set(atomics, true),
  };
}

const commentsPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    atomics: DecorationSet;

    constructor(view: EditorView) {
      ({ decorations: this.decorations, atomics: this.atomics } =
        buildCommentDecorations(view.state));
    }

    update(update: ViewUpdate) {
      if (
        update.docChanged ||
        update.state.facet(hideCommentSyntax) !==
          update.startState.facet(hideCommentSyntax)
      ) {
        ({ decorations: this.decorations, atomics: this.atomics } =
          buildCommentDecorations(update.state));
      }
    }
  },
  { decorations: (plugin) => plugin.decorations },
);

export function commentsExtension() {
  return [
    commentsPlugin,
    EditorView.atomicRanges.of(
      (view) => view.plugin(commentsPlugin)?.atomics ?? Decoration.none,
    ),
  ];
}
