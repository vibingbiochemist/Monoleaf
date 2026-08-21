/**
 * Registers the bundled document fonts' @font-face declarations. Imported
 * once, for its side effects only, from main.ts — before the first
 * pagination pass, since Paged.js awaits every FontFace already registered
 * on `document.fonts` before it measures (chunker.js's loadFonts). A face
 * that registers later than the first measurement risks caching page breaks
 * against fallback metrics.
 *
 * Kept separate from ./fonts so the font registry/logic stays import-free
 * and trivially unit-testable — this module only has side effects.
 *
 * The five @fontsource-variable packages ship one wght.css (and
 * wght-italic.css) per family covering seven Unicode-range subsets each
 * (latin, latin-ext, cyrillic, cyrillic-ext, greek, vietnamese, math/
 * symbols in some) — there is no subset-specific entry point for variable
 * builds, unlike the static ones. Importing the full file means Paged.js's
 * unconditional loadFonts() decodes all seven subsets once, even for a
 * plain-English document; that's a one-time cost at first pagination (each
 * FontFace is skipped on every subsequent pass once `status === "loaded"`),
 * not a per-keystroke one. The alternative — Hand-transcribing just the
 * latin/latin-ext @font-face blocks — trades that one-time cost for the
 * risk of a silent typo in a 500-character unicode-range value, which is
 * far worse: a wrong range fails softly (wrong glyphs, no error) and is easy
 * to miss in review. Not worth it for a cost paid once per app session.
 *
 * IBM Plex Mono (static, not variable) DOES ship per-subset, per-weight
 * files, so it costs nothing to be precise: only latin + latin-ext, at the
 * one weight (400) code blocks and the raw view actually use.
 */

import "@fontsource-variable/source-serif-4/wght.css";
import "@fontsource-variable/source-serif-4/wght-italic.css";
import "@fontsource-variable/lora/wght.css";
import "@fontsource-variable/lora/wght-italic.css";
import "@fontsource-variable/source-sans-3/wght.css";
import "@fontsource-variable/source-sans-3/wght-italic.css";
import "@fontsource-variable/atkinson-hyperlegible-next/wght.css";
import "@fontsource-variable/atkinson-hyperlegible-next/wght-italic.css";
// Lexend ships no wght-italic.css — the browser synthesises oblique from
// this upright face (see DocumentFont.hasItalic in ./fonts).
import "@fontsource-variable/lexend/wght.css";

import "@fontsource/ibm-plex-mono/latin-400.css";
import "@fontsource/ibm-plex-mono/latin-ext-400.css";
import "@fontsource/ibm-plex-mono/latin-400-italic.css";
import "@fontsource/ibm-plex-mono/latin-ext-400-italic.css";
