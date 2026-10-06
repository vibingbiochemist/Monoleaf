/**
 * Locating an image reference in a line of markdown.
 *
 * Two features rewrite the image under the pointer: the drag-resize handle
 * (commitImageWidth, livepreview.ts) and the right-click image menu (imageAt
 * / rewriteImage, main.ts). They used to carry two copies of the same regex
 * and the copies drifted: when imageMarkup (commands.ts) started wrapping a
 * destination containing a space or parenthesis in `<...>`, only one copy
 * learned to read that form, and the menu truncated `![pic](<x\pic (1).png>)`
 * at the `)` inside the name (#70). One parser here, used by both.
 */

export interface ImageReference {
  /** Offsets of the whole construct within the line text. */
  from: number;
  to: number;
  src: string;
  alt: string;
  /** Explicit `width` of an `<img>` tag, "" when absent or for `![..](..)`. */
  width: string;
}

/**
 * Matches `![alt](dest)` and `<img ...>`. The destination may be
 * `<...>`-wrapped (imageMarkup, commands.ts, for a path containing a space or
 * parenthesis) — that wrapped form can itself contain a literal ")", so the
 * bare `[^)]*` alternative alone would stop matching partway through it.
 */
const IMAGE_RE = /!\[[^\]]*\]\((?:<[^>]*>|[^)]*)\)|<img\b[^>]*>/gi;

/**
 * The image reference in `line` that spans `offset` (inclusive at both
 * ends, so a pointer resting on the closing `)` still counts), or null.
 */
export function imageReferenceAt(
  line: string,
  offset: number,
): ImageReference | null {
  for (const m of line.matchAll(IMAGE_RE)) {
    const from = m.index ?? 0;
    const to = from + m[0].length;
    if (offset < from || offset > to) continue;
    return { from, to, ...parseImageReference(m[0]) };
  }
  return null;
}

/** src / alt / width of one complete `![..](..)` or `<img ..>` construct. */
function parseImageReference(
  text: string,
): Pick<ImageReference, "src" | "alt" | "width"> {
  if (text.startsWith("![")) {
    const close = text.indexOf("](");
    const dest = text.slice(close + 2, text.length - 1);
    // <...>-wrapped: everything up to the matching >, same as the parser's
    // URL node gives the live preview. Bare: stop at the first space, which
    // is how a trailing "title" gets dropped (unsupported here).
    const src = dest.startsWith("<")
      ? dest.slice(1, dest.indexOf(">"))
      : dest.split(/\s+/)[0];
    return { src, alt: text.slice(2, close), width: "" };
  }
  return {
    src:
      /\bsrc\s*=\s*"([^"]*)"/.exec(text)?.[1] ??
      /\bsrc\s*=\s*'([^']*)'/.exec(text)?.[1] ??
      "",
    alt: /\balt\s*=\s*"([^"]*)"/.exec(text)?.[1] ?? "",
    width: /\bwidth\s*=\s*"?([\d%]+)/.exec(text)?.[1] ?? "",
  };
}
