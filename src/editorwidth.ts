/**
 * How wide live view's text column runs when Page layout is off (#129). With
 * page layout on, the column is the fixed paper-width sheet; off, it widens to
 * the window up to this cap, so tables get room without prose lines running
 * the full width of a large monitor. Display only: nothing reaches the file.
 */

export type EditorWidth = "standard" | "wide" | "full";

/** In menu order; px is at 100% zoom, null = no cap. */
export const EDITOR_WIDTHS: Record<
  EditorWidth,
  { label: string; px: number | null }
> = {
  standard: { label: "Standard", px: 1000 },
  wide: { label: "Wide", px: 1400 },
  full: { label: "Full window", px: null },
};

/** The stored choice, falling back to Standard for anything unknown. */
export function parseEditorWidth(stored: string | null): EditorWidth {
  return (Object.keys(EDITOR_WIDTHS) as (string | null)[]).includes(stored)
    ? (stored as EditorWidth)
    : "standard";
}

/** The CSS max width of the text column for a choice at a zoom percentage. */
export function editorMaxWidthCss(id: EditorWidth, zoom: number): string {
  const { px } = EDITOR_WIDTHS[id];
  return px === null ? "100%" : `${Math.round((px * zoom) / 100)}px`;
}
