/**
 * Fitting explicitly sized images to the page body.
 *
 * An image cannot be fragmented across pages, so both the editor's page card
 * (.cm-live-image, styles.css + applyPageVars in main.ts) and the print sheet
 * (buildPrintCss, export.ts) cap image height to the page body. For an image
 * with no explicit size that is the whole story: CSS shrinks the width along
 * with the height. For an image the user has sized (`<img width="600">` from
 * a drag-resize, or "Fit width"), CSS keeps the box at that width while
 * max-height shrinks the picture inside it, leaving it letterboxed in a wide
 * invisible box. Only script can shrink the width in step, once the
 * picture's own dimensions are known — this module is that script, shared so
 * the editor and the PDF agree.
 */

/**
 * The width an image with an explicit `requested` width should get under a
 * page-body cap of `capHeight` px: the requested width while the picture
 * fits, else the width at which its height is exactly the cap. Dimensions
 * that are not known yet (0) leave the request unchanged.
 */
export function fittedImageWidth(
  requested: number,
  naturalWidth: number,
  naturalHeight: number,
  capHeight: number,
): number {
  if (!(naturalWidth > 0) || !(naturalHeight > 0) || !(capHeight > 0)) {
    return requested;
  }
  const height = (requested * naturalHeight) / naturalWidth;
  return height > capHeight
    ? Math.floor((capHeight * naturalWidth) / naturalHeight)
    : requested;
}

/** The explicit width an `<img>` asks for, in px, from its `width` attribute
 * or inline style — a number, "Npx" or "N%" of `contentWidth`. NaN if none. */
export function requestedImageWidth(
  value: string,
  contentWidth: number,
): number {
  const v = value.trim();
  if (/^\d+(\.\d+)?(px)?$/.test(v)) return parseFloat(v);
  if (/^\d+(\.\d+)?%$/.test(v)) return (parseFloat(v) / 100) * contentWidth;
  return NaN;
}

/**
 * Shrink every explicitly sized `<img>` under `root` so none is taller than
 * `capHeight` px (see fittedImageWidth), waiting for each to decode first.
 * Used on the DOM handed to Paged.js for the PDF and for the editor's page
 * measurement; by then every local image is a data: URL, so decoding is
 * immediate. An image that fails to decode is left alone.
 */
export async function fitImagesToPage(
  root: ParentNode,
  capHeight: number,
  contentWidth: number,
): Promise<void> {
  const imgs = Array.from(root.querySelectorAll<HTMLImageElement>("img"));
  await Promise.all(
    imgs.map(async (img) => {
      const attr = img.getAttribute("width") ?? img.style.width;
      if (attr === "") return; // no explicit size: CSS fits it on its own
      if (!(img.complete && img.naturalWidth > 0)) {
        try {
          await img.decode();
        } catch {
          return;
        }
      }
      const requested = requestedImageWidth(attr, contentWidth);
      if (!Number.isFinite(requested)) return;
      const fitted = fittedImageWidth(
        requested,
        img.naturalWidth,
        img.naturalHeight,
        capHeight,
      );
      if (fitted !== requested) {
        img.style.width = `${fitted}px`;
        img.removeAttribute("width");
      }
    }),
  );
}
