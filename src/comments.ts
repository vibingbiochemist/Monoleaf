import { EditorState, Facet, Range, TransactionSpec } from "@codemirror/state";
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
