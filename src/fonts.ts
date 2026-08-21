/**
 * The document font registry: a fixed, bundled set of OFL-1.1 fonts a
 * document can choose for its body text and code blocks (see the `font` key
 * in ./export's PageConfig). Bundling rather than offering system fonts
 * keeps a document's rendering and pagination reproducible across machines —
 * the whole point of a single portable .md, same as the paper size and
 * margins it already travels with.
 *
 * This module is deliberately free of CSS/asset imports and DOM access, so
 * it stays trivially unit-testable. The actual @font-face declarations are
 * loaded once, as a side effect, by ./fontfaces — imported from main.ts.
 *
 * `family` is the exact CSS family name each package's stylesheet declares.
 * @fontsource-variable packages suffix it with " Variable"; the static
 * @fontsource/ibm-plex-mono package does not.
 */

export interface DocumentFont {
  id: string;
  label: string;
  family: string;
  /** Whether a genuine italic face is bundled (see ./fontfaces). If false,
   * the browser synthesises an oblique from the upright face — that keeps
   * upright advance widths, so it does not affect editor/PDF pagination
   * parity, only how slanted letterforms look. */
  hasItalic: boolean;
  /** The variable font's declared weight axis (e.g. "200 900"), exactly as
   * the vendor's wght.css states it — see ./fontEmbeds, which needs it to
   * declare a matching `font-weight` on the embedded HTML-export @font-face.
   * Without it, the browser only registers the face for weight 400 and
   * faux-bolds any heading/`<strong>` text instead of using the embedded
   * variable font's real bold instance. */
  weightRange: string;
}

// index.html's #page-font <select> options must be kept in sync with the
// ids/labels below — same as #page-size's hardcoded A4/Letter options
// already mirror PageConfig's size union.
export const DOCUMENT_FONTS: readonly DocumentFont[] = [
  {
    id: "source-serif-4",
    label: "Source Serif 4",
    family: "Source Serif 4 Variable",
    hasItalic: true,
    weightRange: "200 900",
  },
  {
    id: "lora",
    label: "Lora",
    family: "Lora Variable",
    hasItalic: true,
    weightRange: "400 700",
  },
  {
    id: "source-sans-3",
    label: "Source Sans 3",
    family: "Source Sans 3 Variable",
    hasItalic: true,
    weightRange: "200 900",
  },
  {
    id: "atkinson-hyperlegible-next",
    label: "Atkinson Hyperlegible Next",
    family: "Atkinson Hyperlegible Next Variable",
    hasItalic: true,
    weightRange: "200 800",
  },
  {
    id: "lexend",
    label: "Lexend",
    family: "Lexend Variable",
    hasItalic: false,
    weightRange: "100 900",
  },
] as const;

export const DEFAULT_FONT_ID = "source-serif-4";

const BY_ID = new Map(DOCUMENT_FONTS.map((f) => [f.id, f]));

// Fallback tails group by serif/sans, matching each font's own design so a
// glyph outside the bundled latin/latin-ext subsets degrades gracefully
// instead of jarringly swapping style. Every caller uses fontStack(id)
// verbatim — editor CSSOM, print CSS, and HTML export all draw from this one
// string, so a glyph that misses the bundled subsets falls back the same way
// everywhere instead of disagreeing between the editor and the PDF.
const FALLBACK: Record<string, string> = {
  "source-serif-4": 'Georgia, "Times New Roman", serif',
  lora: 'Georgia, "Times New Roman", serif',
  "source-sans-3": '"Segoe UI", Arial, sans-serif',
  "atkinson-hyperlegible-next": '"Segoe UI", Arial, sans-serif',
  lexend: '"Segoe UI", Arial, sans-serif',
};

/** True if `v` names a bundled document font. Use this to validate any
 * value that reaches a stylesheet — see the `font` key in PageConfig. */
export function isFontId(v: unknown): v is string {
  return typeof v === "string" && BY_ID.has(v);
}

/** The bare CSS family name for a document font id, no fallback tail —
 * e.g. for `document.fonts.load()`, which wants a single family. Always
 * total: an unknown id resolves to the default font. */
export function fontFamily(id: string): string {
  return (BY_ID.get(id) ?? BY_ID.get(DEFAULT_FONT_ID)!).family;
}

/** The full CSS font-family value for a document font id, fallback tail
 * included. Always total: an unknown id resolves to the default font,
 * mirroring how parsePageConfig treats a malformed `font` value. */
export function fontStack(id: string): string {
  const font = BY_ID.get(id) ?? BY_ID.get(DEFAULT_FONT_ID)!;
  return `"${font.family}", ${FALLBACK[font.id]}`;
}

/** Bundled code/raw-view font, replacing the Windows-only Consolas/Cascadia
 * stack. IBM Plex Mono first, with the old stack retained as fallback in
 * case the bundled face ever fails to register. */
export const MONO_FAMILY = "IBM Plex Mono";
export const MONO_STACK = `"${MONO_FAMILY}", Consolas, "Cascadia Mono", monospace`;

/** Every CSS family name this module ever declares — the bundled body fonts
 * plus mono. Used to validate untrusted font-face data (e.g. HTML export
 * embedding) before it reaches a stylesheet: a value that isn't one of
 * these is dropped rather than trusted. */
export const KNOWN_FAMILIES: ReadonlySet<string> = new Set([
  ...DOCUMENT_FONTS.map((f) => f.family),
  MONO_FAMILY,
]);
