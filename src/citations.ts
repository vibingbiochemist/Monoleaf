/**
 * Citations in the text, pandoc style: `@key` on its own or inside brackets
 * (`[@doe2020, p. 3]`, `[see @doe2020; -@roe]`). The editor needs to know
 * whether a position sits in a citation key, for `@` completion and for the
 * hover; nothing is rendered here.
 */

import {
  autocompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
} from "@codemirror/autocomplete";
import type { EditorState, Extension } from "@codemirror/state";
import { hoverTooltip } from "@codemirror/view";
import { citationAt } from "./citationsyntax";
import {
  currentReferences,
  type References,
  type ReferenceSummary,
} from "./references";

export { citationAt, type Citation } from "./citationsyntax";

/**
 * The completions for the citation at the cursor: every reference whose key,
 * author or title contains what was typed after the `@`. The list is filtered
 * here rather than by the editor, which only matches the key.
 */
export function citationCompletions(
  context: CompletionContext,
  references: () => References = currentReferences,
): CompletionResult | null {
  const line = context.state.doc.lineAt(context.pos);
  const citation = citationAt(line.text, context.pos - line.from);
  if (citation === null) return null;
  const typed = line.text.slice(citation.from + 1, context.pos - line.from);
  const needle = typed.toLowerCase();
  const options: Completion[] = [];
  for (const entry of references().entries) {
    const haystack = [entry.key, ...entry.authors, entry.title].join(" ");
    if (!haystack.toLowerCase().includes(needle)) continue;
    const who = entry.authors[0] ?? "";
    const when = entry.year === null ? "" : String(entry.year);
    options.push({
      label: entry.key,
      detail: [who, when].filter((part) => part !== "").join(", "),
      info: entry.title,
      type: "text",
    });
  }
  if (options.length === 0) return null;
  return {
    from: line.from + citation.from + 1,
    to: line.from + citation.to,
    options,
    filter: false,
  };
}

/** `@` opens the citation list, with no icons: every entry is a reference. */
export function citationCompletion(): Extension {
  return autocompletion({ override: [citationCompletions], icons: false });
}

/** The entry as the hover shows it: who and when on one line, the title below. */
export function describeReference(entry: ReferenceSummary): string {
  const who = entry.authors.length > 0 ? entry.authors.join("; ") : "No author";
  const when = entry.year === null ? "" : ` (${entry.year})`;
  return `${who}${when}\n${entry.title || "No title"}`;
}

/** What the hover at `pos` shows and the range it belongs to, or null. */
export function citationHoverAt(
  state: EditorState,
  pos: number,
  references: () => References = currentReferences,
): { from: number; to: number; text: string } | null {
  const line = state.doc.lineAt(pos);
  const citation = citationAt(line.text, pos - line.from);
  if (citation === null || citation.key === "") return null;
  const entry = references().entries.find((e) => e.key === citation.key);
  return {
    from: line.from + citation.from,
    to: line.from + citation.to,
    text: entry ? describeReference(entry) : `${citation.key}: not found`,
  };
}

/** Hovering a citation key shows its entry; the text goes in as text only. */
export function citationHover(): Extension {
  return hoverTooltip((view, pos) => {
    const hover = citationHoverAt(view.state, pos);
    if (hover === null) return null;
    return {
      pos: hover.from,
      end: hover.to,
      above: true,
      create() {
        const dom = document.createElement("div");
        dom.className = "cm-citation-hover";
        dom.textContent = hover.text;
        return { dom };
      },
    };
  });
}
