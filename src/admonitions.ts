/**
 * Admonitions (callouts) — GitHub's blockquote syntax:
 *
 *   > [!NOTE]
 *   > Body text, with **markdown** inside.
 *
 * A first line of `[!TYPE]` promotes an ordinary blockquote to a coloured
 * callout. This is deliberately GitHub-compatible: on any viewer that does not
 * understand it, the block still shows as a plain quote with a visible
 * "[!NOTE]" line — graceful degradation, no lock-in, single source of truth.
 */

export type AdmonitionKind =
  "note" | "tip" | "important" | "warning" | "caution";

export interface AdmonitionStyle {
  label: string;
  /** Leading glyph (emoji renders in both the editor and print webviews —
   * both are Chromium). */
  icon: string;
  /** Accent colour: left border + title text. */
  color: string;
  /** Faint background tint (light mode / print). */
  tint: string;
  /** Background tint for the dark editor theme. */
  tintDark: string;
}

export const ADMONITIONS: Record<AdmonitionKind, AdmonitionStyle> = {
  note: {
    label: "Note",
    icon: "ℹ️",
    color: "#0969da",
    tint: "#f1f7ff",
    tintDark: "rgba(9, 105, 218, 0.16)",
  },
  tip: {
    label: "Tip",
    icon: "💡",
    color: "#1a7f37",
    tint: "#eefbf2",
    tintDark: "rgba(26, 127, 55, 0.16)",
  },
  important: {
    label: "Important",
    icon: "❗",
    color: "#8250df",
    tint: "#f7f2ff",
    tintDark: "rgba(130, 80, 223, 0.18)",
  },
  warning: {
    label: "Warning",
    icon: "⚠️",
    color: "#9a6700",
    tint: "#fff9e8",
    tintDark: "rgba(154, 103, 0, 0.18)",
  },
  caution: {
    label: "Caution",
    icon: "🛑",
    color: "#cf222e",
    tint: "#fff2f0",
    tintDark: "rgba(207, 34, 46, 0.16)",
  },
};

/** The five kinds in menu / display order. */
export const ADMONITION_KINDS = Object.keys(ADMONITIONS) as AdmonitionKind[];

// The marker must sit alone on the blockquote's first line (GitHub's rule).
const MARKER_RE = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*$/i;

/**
 * The admonition kind declared by a `[!TYPE]` marker line, or null. Accepts a
 * raw line that may still carry its `>` blockquote prefix.
 */
export function admonitionKind(line: string): AdmonitionKind | null {
  const bare = line.replace(/^\s*>+\s?/, "").trim();
  const m = MARKER_RE.exec(bare);
  return m === null ? null : (m[1].toLowerCase() as AdmonitionKind);
}
