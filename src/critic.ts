import {
  EditorState,
  Extension,
  Facet,
  Range,
  StateCommand,
  Transaction,
  TransactionSpec,
} from "@codemirror/state";
import {
  Decoration,
  DecorationSet,
  EditorView,
  ViewPlugin,
  ViewUpdate,
} from "@codemirror/view";

/**
 * Tracked changes via CriticMarkup (brief Stage 4): insertions {++x++},
 * deletions {--x--}, substitutions {~~old~>new~~}, plus highlight {==x==}
 * and critic comments {>>x<<}. Plain text in the file, git-diffable, fully
 * unambiguous to an AI reading the raw markdown. A dumb viewer shows the
 * literal syntax; that is an accepted trade-off per the brief.
 *
 * Suggesting mode is a transaction filter: typed input becomes {++…++}
 * (coalescing while you type), deletions keep the text wrapped in {--…--}
 * (merging adjacent runs), and type-over becomes a substitution. Accept and
 * reject rewrite the underlying text.
 */

export type CriticKind =
  "insertion" | "deletion" | "substitution" | "highlight" | "comment";

export interface CriticSegment {
  role: "ins" | "del" | "hl" | "comment";
  from: number;
  to: number;
}

export interface CriticRegion {
  kind: CriticKind;
  from: number;
  to: number;
  segments: CriticSegment[];
}

const CRITIC_RE =
  /\{\+\+([\s\S]*?)\+\+\}|\{--([\s\S]*?)--\}|\{~~([\s\S]*?)~>([\s\S]*?)~~\}|\{==([\s\S]*?)==\}|\{>>([\s\S]*?)<<\}/g;

export function parseCritic(text: string): CriticRegion[] {
  const out: CriticRegion[] = [];
  for (const m of text.matchAll(CRITIC_RE)) {
    const from = m.index;
    const to = from + m[0].length;
    if (m[1] !== undefined) {
      out.push({
        kind: "insertion",
        from,
        to,
        segments: [{ role: "ins", from: from + 3, to: to - 3 }],
      });
    } else if (m[2] !== undefined) {
      out.push({
        kind: "deletion",
        from,
        to,
        segments: [{ role: "del", from: from + 3, to: to - 3 }],
      });
    } else if (m[3] !== undefined) {
      const oldFrom = from + 3;
      const oldTo = oldFrom + m[3].length;
      out.push({
        kind: "substitution",
        from,
        to,
        segments: [
          { role: "del", from: oldFrom, to: oldTo },
          { role: "ins", from: oldTo + 2, to: to - 3 },
        ],
      });
    } else if (m[5] !== undefined) {
      out.push({
        kind: "highlight",
        from,
        to,
        segments: [{ role: "hl", from: from + 3, to: to - 3 }],
      });
    } else {
      out.push({
        kind: "comment",
        from,
        to,
        segments: [{ role: "comment", from: from + 3, to: to - 3 }],
      });
    }
  }
  return out;
}

const ACTIONABLE: CriticKind[] = ["insertion", "deletion", "substitution"];

export function regionAt(
  regions: CriticRegion[],
  pos: number,
): CriticRegion | null {
  return (
    regions.find(
      (r) => ACTIONABLE.includes(r.kind) && r.from <= pos && pos <= r.to,
    ) ?? null
  );
}

// ---------------------------------------------------------------------------
// Accept / reject

function oldText(state: EditorState, r: CriticRegion): string {
  const seg = r.segments.find((s) => s.role === "del")!;
  return state.sliceDoc(seg.from, seg.to);
}

export function acceptSpec(
  _state: EditorState,
  r: CriticRegion,
): TransactionSpec {
  const changes =
    r.kind === "deletion" || r.kind === "comment"
      ? [{ from: r.from, to: r.to }]
      : r.kind === "substitution"
        ? [
            { from: r.from, to: r.segments[1].from }, // "{~~old~>"
            { from: r.to - 3, to: r.to },
          ]
        : [
            { from: r.from, to: r.from + 3 },
            { from: r.to - 3, to: r.to },
          ];
  return { changes, userEvent: "input.critic" };
}

export function rejectSpec(
  _state: EditorState,
  r: CriticRegion,
): TransactionSpec {
  const changes =
    r.kind === "insertion" || r.kind === "comment"
      ? [{ from: r.from, to: r.to }]
      : r.kind === "substitution"
        ? [
            { from: r.from, to: r.from + 3 },
            { from: r.segments[0].to, to: r.to }, // "~>new~~}"
          ]
        : [
            { from: r.from, to: r.from + 3 },
            { from: r.to - 3, to: r.to },
          ];
  return { changes, userEvent: "input.critic" };
}

function allSpec(
  state: EditorState,
  op: (state: EditorState, r: CriticRegion) => TransactionSpec,
): TransactionSpec | null {
  const regions = parseCritic(state.doc.toString()).filter((r) =>
    ACTIONABLE.includes(r.kind),
  );
  if (regions.length === 0) return null;
  return {
    changes: regions.flatMap(
      (r) => op(state, r).changes as { from: number; to?: number }[],
    ),
    userEvent: "input.critic",
  };
}

function atCursor(
  op: (state: EditorState, r: CriticRegion) => TransactionSpec,
): StateCommand {
  return ({ state, dispatch }) => {
    const regions = parseCritic(state.doc.toString());
    const r = regionAt(regions, state.selection.main.head);
    if (r === null) return false;
    // Apply, then land the cursor on the next remaining change (wrapping),
    // so a review can be worked through with repeated ✓ / ✗.
    const spec = op(state, r);
    const preview = state.update(spec);
    const mapped = preview.changes.mapPos(r.from);
    const remaining = parseCritic(preview.state.doc.toString()).filter((x) =>
      ACTIONABLE.includes(x.kind),
    );
    const target =
      remaining.find((x) => x.from >= mapped) ?? remaining[0] ?? null;
    const pos = target === null ? mapped : target.from;
    dispatch(
      state.update({
        ...spec,
        selection: { anchor: pos },
        effects: EditorView.scrollIntoView(pos, { y: "center" }),
      }),
    );
    return true;
  };
}

/** Jump to the next tracked change after the cursor, wrapping around. */
export const nextChange: StateCommand = ({ state, dispatch }) => {
  const regions = parseCritic(state.doc.toString()).filter((r) =>
    ACTIONABLE.includes(r.kind),
  );
  if (regions.length === 0) return false;
  const head = state.selection.main.head;
  const target = regions.find((r) => r.from > head) ?? regions[0];
  dispatch(
    state.update({
      selection: { anchor: target.from },
      effects: EditorView.scrollIntoView(target.from, { y: "center" }),
    }),
  );
  return true;
};

export const acceptAtCursor = atCursor(acceptSpec);
export const rejectAtCursor = atCursor(rejectSpec);

export const acceptAllChanges: StateCommand = ({ state, dispatch }) => {
  const spec = allSpec(state, acceptSpec);
  if (spec === null) return false;
  dispatch(state.update(spec));
  return true;
};

export const rejectAllChanges: StateCommand = ({ state, dispatch }) => {
  const spec = allSpec(state, rejectSpec);
  if (spec === null) return false;
  dispatch(state.update(spec));
  return true;
};

// ---------------------------------------------------------------------------
// Suggesting mode: the transaction filter

const TOKEN_RE = /^(\{\+\+|\+\+\}|\{--|--\}|\{~~|~~\}|~>)$/;

interface Plan {
  changes: { from: number; to?: number; insert?: string }[];
  cursor: number;
}

function insideSegment(
  regions: CriticRegion[],
  from: number,
  to: number,
  roles: CriticSegment["role"][],
): CriticSegment | null {
  for (const r of regions) {
    for (const s of r.segments) {
      if (roles.includes(s.role) && s.from <= from && to <= s.to) return s;
    }
  }
  return null;
}

function regionCovering(
  regions: CriticRegion[],
  from: number,
  to: number,
): CriticRegion | null {
  return regions.find((r) => r.from <= from && to <= r.to) ?? null;
}

function overlapsRegion(
  regions: CriticRegion[],
  from: number,
  to: number,
): boolean {
  return regions.some((r) => r.from < to && from < r.to);
}

function subNewSegment(r: CriticRegion): CriticSegment {
  return r.segments[r.segments.length - 1];
}

function planInsert(
  state: EditorState,
  regions: CriticRegion[],
  pos: number,
  ins: string,
): Plan {
  // Inside our own suggested text: type plainly.
  if (insideSegment(regions, pos, pos, ["ins"]) !== null) {
    return { changes: [{ from: pos, insert: ins }], cursor: pos + ins.length };
  }
  // Inside a deletion or the old half of a substitution: relocate after the
  // region (for a substitution, into its new half).
  const covering = regionCovering(regions, pos, pos);
  if (covering !== null) {
    if (covering.kind === "substitution") {
      const seg = subNewSegment(covering);
      return {
        changes: [{ from: seg.to, insert: ins }],
        cursor: seg.to + ins.length,
      };
    }
    if (covering.kind === "deletion") pos = covering.to;
  }
  const before = state.sliceDoc(Math.max(0, pos - 3), pos);
  const after = state.sliceDoc(pos, Math.min(state.doc.length, pos + 3));
  if (before === "++}") {
    // Extend the preceding insertion.
    return {
      changes: [{ from: pos - 3, to: pos, insert: `${ins}++}` }],
      cursor: pos - 3 + ins.length,
    };
  }
  if (after === "{++") {
    // Prepend to the following insertion.
    return {
      changes: [{ from: pos, to: pos + 3, insert: `{++${ins}` }],
      cursor: pos + 3 + ins.length,
    };
  }
  return {
    changes: [{ from: pos, insert: `{++${ins}++}` }],
    cursor: pos + 3 + ins.length,
  };
}

function planTokenDelete(
  state: EditorState,
  regions: CriticRegion[],
  from: number,
  to: number,
  backward: boolean,
): Plan | null {
  const r = regionCovering(regions, from, to);
  if (r === null) return null;
  const token = state.sliceDoc(from, to);

  if (token === "++}" || (token === "~~}" && r.kind === "substitution")) {
    // Backspace at the end of suggested text: retract its last character.
    const seg = r.kind === "substitution" ? subNewSegment(r) : r.segments[0];
    if (seg.to > seg.from) {
      return {
        changes: [{ from: seg.to - 1, to: seg.to }],
        cursor: seg.to - 1,
      };
    }
    // Suggestion emptied: drop it (a substitution reverts to its old text).
    if (r.kind === "substitution") {
      const old = oldText(state, r);
      return {
        changes: [{ from: r.from, to: r.to, insert: old }],
        cursor: r.from + old.length,
      };
    }
    return { changes: [{ from: r.from, to: r.to }], cursor: r.from };
  }
  if (token === "--}") {
    // Deleted text stays; the cursor just steps over the region.
    return { changes: [], cursor: r.from };
  }
  if (token === "~>") {
    return { changes: [], cursor: r.from };
  }
  // Opening tokens: the intent is to delete what precedes the region.
  if (backward && r.from > 0) {
    return planDelete(
      state,
      regions,
      r.from - 1,
      r.from,
      state.sliceDoc(r.from - 1, r.from),
      true,
    );
  }
  return { changes: [], cursor: backward ? r.from : r.to };
}

function planDelete(
  state: EditorState,
  regions: CriticRegion[],
  from: number,
  to: number,
  deleted: string,
  backward: boolean,
): Plan | null {
  if (TOKEN_RE.test(deleted)) {
    const plan = planTokenDelete(state, regions, from, to, backward);
    if (plan !== null) return plan;
  }
  // Retracting our own suggestion: delete for real.
  if (insideSegment(regions, from, to, ["ins"]) !== null) {
    return { changes: [{ from, to }], cursor: from };
  }
  // Already-deleted text: step over it.
  const covering = regionCovering(regions, from, to);
  if (covering !== null && covering.kind === "deletion") {
    return { changes: [], cursor: backward ? covering.from : covering.to };
  }
  // Anything else that touches critic syntax: bail out to a direct edit.
  if (overlapsRegion(regions, from, to)) return null;

  const prefix = state.sliceDoc(Math.max(0, from - 3), from) === "--}";
  const suffix =
    state.sliceDoc(to, Math.min(state.doc.length, to + 3)) === "{--";
  const cFrom = from - (prefix ? 3 : 0);
  const cTo = to + (suffix ? 3 : 0);
  const insert = (prefix ? "" : "{--") + deleted + (suffix ? "" : "--}");
  return {
    changes: [{ from: cFrom, to: cTo, insert }],
    cursor: backward ? (prefix ? cFrom : from) : cFrom + insert.length,
  };
}

function planReplace(
  _state: EditorState,
  regions: CriticRegion[],
  from: number,
  to: number,
  deleted: string,
  ins: string,
): Plan | null {
  if (insideSegment(regions, from, to, ["ins"]) !== null) {
    return { changes: [{ from, to, insert: ins }], cursor: from + ins.length };
  }
  if (overlapsRegion(regions, from, to)) return null;
  return {
    changes: [{ from, to, insert: `{~~${deleted}~>${ins}~~}` }],
    cursor: from + 3 + deleted.length + 2 + ins.length,
  };
}

const TRACKED_INPUT = ["input.type", "input.paste", "input.drop"];

function trackTransaction(tr: Transaction): TransactionSpec | Transaction {
  if (!tr.docChanged) return tr;
  const ue = tr.annotation(Transaction.userEvent);
  if (ue === undefined || ue.includes("compose")) return tr;
  const isInput = TRACKED_INPUT.includes(ue);
  const isDelete =
    ue.startsWith("delete") &&
    !ue.includes(".format") &&
    !ue.includes(".critic") &&
    !ue.includes(".tracked");
  if (!isInput && !isDelete) return tr;

  const state = tr.startState;
  const regions = parseCritic(state.doc.toString());
  const backward = ue.startsWith("delete.backward");

  const changes: { from: number; to?: number; insert?: string }[] = [];
  let cursor = -1;
  let delta = 0;
  let failed = false;

  tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    if (failed) return;
    const ins = inserted.sliceString(0, inserted.length, state.lineBreak);
    const deleted = state.sliceDoc(fromA, toA);
    const plan =
      fromA === toA
        ? planInsert(state, regions, fromA, ins)
        : ins === ""
          ? planDelete(state, regions, fromA, toA, deleted, backward)
          : planReplace(state, regions, fromA, toA, deleted, ins);
    if (plan === null) {
      failed = true;
      return;
    }
    changes.push(...plan.changes);
    cursor = plan.cursor + delta;
    for (const c of plan.changes) {
      delta += (c.insert?.length ?? 0) - ((c.to ?? c.from) - c.from);
    }
  });

  if (failed) return tr;
  return {
    changes,
    selection: { anchor: cursor },
    effects: EditorView.scrollIntoView(cursor),
    userEvent: `${ue}.tracked`,
    scrollIntoView: true,
  };
}

/** The suggesting-mode extension; put it in a compartment to toggle. */
export function trackingExtension(): Extension {
  return EditorState.transactionFilter.of(trackTransaction);
}

// ---------------------------------------------------------------------------
// Decorations

export const hideCriticSyntax = Facet.define<boolean, boolean>({
  combine: (values) => values.some((v) => v),
});

const hide = Decoration.replace({});
const tokenMark = Decoration.mark({ class: "cm-critic-token" });
const roleMark: Record<CriticSegment["role"], Decoration> = {
  ins: Decoration.mark({ class: "cm-critic-ins" }),
  del: Decoration.mark({ class: "cm-critic-del" }),
  hl: Decoration.mark({ class: "cm-critic-hl" }),
  comment: Decoration.mark({ class: "cm-critic-comment" }),
};

function tokenRanges(r: CriticRegion): { from: number; to: number }[] {
  const tokens = [
    { from: r.from, to: r.from + 3 },
    { from: r.to - 3, to: r.to },
  ];
  if (r.kind === "substitution") {
    const oldSeg = r.segments[0];
    tokens.push({ from: oldSeg.to, to: oldSeg.to + 2 }); // "~>"
  }
  return tokens.sort((a, b) => a.from - b.from);
}

export function buildCriticDecorations(state: EditorState): {
  decorations: DecorationSet;
  atomics: DecorationSet;
} {
  const regions = parseCritic(state.doc.toString());
  const hideSyntax = state.facet(hideCriticSyntax);
  const ranges: Range<Decoration>[] = [];
  const atomics: Range<Decoration>[] = [];

  for (const r of regions) {
    for (const t of tokenRanges(r)) {
      if (hideSyntax) {
        ranges.push(hide.range(t.from, t.to));
        atomics.push(hide.range(t.from, t.to));
      } else {
        ranges.push(tokenMark.range(t.from, t.to));
      }
    }
    for (const s of r.segments) {
      if (s.from < s.to) ranges.push(roleMark[s.role].range(s.from, s.to));
    }
  }

  return {
    decorations: Decoration.set(ranges, true),
    atomics: Decoration.set(atomics, true),
  };
}

const criticPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    atomics: DecorationSet;

    constructor(view: EditorView) {
      ({ decorations: this.decorations, atomics: this.atomics } =
        buildCriticDecorations(view.state));
    }

    update(update: ViewUpdate) {
      if (
        update.docChanged ||
        update.state.facet(hideCriticSyntax) !==
          update.startState.facet(hideCriticSyntax)
      ) {
        ({ decorations: this.decorations, atomics: this.atomics } =
          buildCriticDecorations(update.state));
      }
    }
  },
  { decorations: (plugin) => plugin.decorations },
);

export function criticExtension(): Extension {
  return [
    criticPlugin,
    EditorView.atomicRanges.of(
      (view) => view.plugin(criticPlugin)?.atomics ?? Decoration.none,
    ),
  ];
}
