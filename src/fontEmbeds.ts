/**
 * Builds embeddable @font-face payloads for the self-contained HTML export
 * (wrapStandaloneHtml in ./export). The in-app editor and PDF/print pipeline
 * load fonts from the app's own bundle (see ./fontfaces) — an exported
 * .html has neither the app origin nor its CSP, so the chosen font's bytes
 * must travel inside the file itself as base64 data URIs.
 *
 * Scope, to keep exported files a reasonable size:
 *  - Only the latin + latin-ext Unicode subsets are embedded, the same
 *    subsets ./fontfaces registers for IBM Plex Mono. A document using
 *    Greek, Cyrillic or Vietnamese text falls back to a system font in
 *    exports specifically — an accepted, documented limit.
 *  - The upright body face is always embedded; the italic face only if the
 *    rendered HTML actually contains italic/emphasis text.
 *  - IBM Plex Mono is embedded only if the rendered HTML contains code, and
 *    only its upright face — code italics are vanishingly rare, and the
 *    browser synthesises an oblique if one appears.
 */

import {
  DOCUMENT_FONTS,
  DEFAULT_FONT_ID,
  isFontId,
  MONO_FAMILY,
  type DocumentFont,
} from "./fonts";
import type { EmbeddedFontFace } from "./export";

// IBM Plex Mono is embedded only at the single static weight ./fontfaces
// registers (latin-400 / latin-ext-400) — see the module doc above.
const MONO_WEIGHT = "400";

import sourceSerif4Latin from "@fontsource-variable/source-serif-4/files/source-serif-4-latin-wght-normal.woff2?url";
import sourceSerif4LatinExt from "@fontsource-variable/source-serif-4/files/source-serif-4-latin-ext-wght-normal.woff2?url";
import sourceSerif4LatinItalic from "@fontsource-variable/source-serif-4/files/source-serif-4-latin-wght-italic.woff2?url";
import sourceSerif4LatinExtItalic from "@fontsource-variable/source-serif-4/files/source-serif-4-latin-ext-wght-italic.woff2?url";

import loraLatin from "@fontsource-variable/lora/files/lora-latin-wght-normal.woff2?url";
import loraLatinExt from "@fontsource-variable/lora/files/lora-latin-ext-wght-normal.woff2?url";
import loraLatinItalic from "@fontsource-variable/lora/files/lora-latin-wght-italic.woff2?url";
import loraLatinExtItalic from "@fontsource-variable/lora/files/lora-latin-ext-wght-italic.woff2?url";

import sourceSans3Latin from "@fontsource-variable/source-sans-3/files/source-sans-3-latin-wght-normal.woff2?url";
import sourceSans3LatinExt from "@fontsource-variable/source-sans-3/files/source-sans-3-latin-ext-wght-normal.woff2?url";
import sourceSans3LatinItalic from "@fontsource-variable/source-sans-3/files/source-sans-3-latin-wght-italic.woff2?url";
import sourceSans3LatinExtItalic from "@fontsource-variable/source-sans-3/files/source-sans-3-latin-ext-wght-italic.woff2?url";

import atkinsonLatin from "@fontsource-variable/atkinson-hyperlegible-next/files/atkinson-hyperlegible-next-latin-wght-normal.woff2?url";
import atkinsonLatinExt from "@fontsource-variable/atkinson-hyperlegible-next/files/atkinson-hyperlegible-next-latin-ext-wght-normal.woff2?url";
import atkinsonLatinItalic from "@fontsource-variable/atkinson-hyperlegible-next/files/atkinson-hyperlegible-next-latin-wght-italic.woff2?url";
import atkinsonLatinExtItalic from "@fontsource-variable/atkinson-hyperlegible-next/files/atkinson-hyperlegible-next-latin-ext-wght-italic.woff2?url";

import lexendLatin from "@fontsource-variable/lexend/files/lexend-latin-wght-normal.woff2?url";
import lexendLatinExt from "@fontsource-variable/lexend/files/lexend-latin-ext-wght-normal.woff2?url";

import monoLatin from "@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-400-normal.woff2?url";
import monoLatinExt from "@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-ext-400-normal.woff2?url";

interface FontUrls {
  latin: string;
  latinExt: string;
  latinItalic?: string;
  latinExtItalic?: string;
}

// URLs only — family names are looked up from DOCUMENT_FONTS so there is
// one place that can drift, not two.
const BODY_URLS: Record<string, FontUrls> = {
  "source-serif-4": {
    latin: sourceSerif4Latin,
    latinExt: sourceSerif4LatinExt,
    latinItalic: sourceSerif4LatinItalic,
    latinExtItalic: sourceSerif4LatinExtItalic,
  },
  lora: {
    latin: loraLatin,
    latinExt: loraLatinExt,
    latinItalic: loraLatinItalic,
    latinExtItalic: loraLatinExtItalic,
  },
  "source-sans-3": {
    latin: sourceSans3Latin,
    latinExt: sourceSans3LatinExt,
    latinItalic: sourceSans3LatinItalic,
    latinExtItalic: sourceSans3LatinExtItalic,
  },
  "atkinson-hyperlegible-next": {
    latin: atkinsonLatin,
    latinExt: atkinsonLatinExt,
    latinItalic: atkinsonLatinItalic,
    latinExtItalic: atkinsonLatinExtItalic,
  },
  // No italic entries — Lexend ships no italic face (see fonts.ts).
  lexend: {
    latin: lexendLatin,
    latinExt: lexendLatinExt,
  },
};

function fontOf(id: string): DocumentFont {
  return DOCUMENT_FONTS.find((f) => f.id === id)!;
}

/** Fetch a same-origin, bundled asset and base64-encode it. Chunked to avoid
 * the stack overflow String.fromCharCode(...bytes) hits on font-sized
 * buffers — tens of KB is enough to blow past V8's argument-spread limit. */
async function toBase64(url: string): Promise<string> {
  const res = await fetch(url);
  // fetch() only rejects on a network-level failure; a 404 (e.g. a
  // build/packaging mismatch between the asset path and what actually
  // shipped) still resolves successfully with an error-page body. Treating
  // that as valid font bytes would embed a corrupt @font-face payload
  // instead of tripping the caller's fail-soft skip.
  if (!res.ok) throw new Error(`fetch ${url} failed: ${res.status}`);
  const buf = await res.arrayBuffer();
  const bytes = new Uint8Array(buf);
  const CHUNK = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

async function face(
  url: string | undefined,
  family: string,
  weight: string,
  italic: boolean,
): Promise<EmbeddedFontFace | null> {
  if (url === undefined) return null;
  try {
    return { family, italic, weight, base64: await toBase64(url) };
  } catch (err) {
    // Fail soft: the export still succeeds, just without this one face
    // embedded — the reader gets fontStack's system-font fallback instead
    // of an aborted export.
    console.error("[monoleaf] font embed failed:", family, err);
    return null;
  }
}

/**
 * Embeddable font faces for a self-contained HTML export. `hasItalic` and
 * `hasCode` should reflect the rendered document (see exportHtml in
 * main.ts) — embedding is skipped for faces the document never uses.
 */
export async function embedFontsForExport(
  fontId: string,
  opts: { hasItalic: boolean; hasCode: boolean },
): Promise<EmbeddedFontFace[]> {
  const id = isFontId(fontId) ? fontId : DEFAULT_FONT_ID;
  const urls = BODY_URLS[id];
  const font: DocumentFont = fontOf(id);
  const wanted: Promise<EmbeddedFontFace | null>[] = [
    face(urls.latin, font.family, font.weightRange, false),
    face(urls.latinExt, font.family, font.weightRange, false),
  ];
  if (opts.hasItalic) {
    wanted.push(
      face(urls.latinItalic, font.family, font.weightRange, true),
      face(urls.latinExtItalic, font.family, font.weightRange, true),
    );
  }
  if (opts.hasCode) {
    wanted.push(
      face(monoLatin, MONO_FAMILY, MONO_WEIGHT, false),
      face(monoLatinExt, MONO_FAMILY, MONO_WEIGHT, false),
    );
  }
  const faces = await Promise.all(wanted);
  return faces.filter((f): f is EmbeddedFontFace => f !== null);
}
