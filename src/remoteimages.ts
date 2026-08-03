/**
 * Whether a document may fetch remote content, and what counts as remote.
 *
 * ## Why this is a setting, and why it defaults to off
 *
 * A document is untrusted input. Opening one renders it into the live DOM
 * immediately — pagination measures page breaks on load, not on print — so any
 * remote reference it carries is fetched the moment the file is opened, with no
 * click and no prompt. That makes `![](https://tracker.example/abc123.png)` a
 * tracking pixel: whoever wrote the document learns the reader's IP address, the
 * time they opened it, and, from a unique URL, exactly which document. Mail
 * clients block remote images by default for precisely this reason.
 *
 * Off by default is the safe direction: the cost is an image that shows as its
 * alt text until the reader opts in, and the benefit is that opening a file
 * someone sent you is silent.
 *
 * ## What has to be blocked
 *
 * Not just `<img src>`. Anything the renderer can emit that causes the engine to
 * issue a request has to be covered, so this module is the single place that
 * decides, and [`blockRemoteContent`] enumerates the attributes:
 *
 * - `src` and `srcset` on `img` and `source` (a `<picture>` can fetch through
 *   either)
 * - `url(...)` inside a `style` attribute — inline styles survive sanitizing on
 *   purpose, because PDF table borders need them, so `style="background:
 *   url(https://…)"` would otherwise be an open channel
 * - `href` / `xlink:href` on SVG `<image>`
 *
 * The document's own CSP already blocks plain `http:` and every scheme other
 * than `https:`/`data:`, so `data:` URIs stay allowed here: they carry their
 * bytes inline and reach no network.
 */

const STORAGE_KEY = "monoleaf.remote-images";

/** Default off. Only an explicit "true" turns it on. */
let allowed = false;

/** True when documents may fetch remote content. */
export function remoteImagesAllowed(): boolean {
  return allowed;
}

export function setRemoteImagesAllowed(value: boolean): void {
  allowed = value;
}

/** Read the stored preference. Absent or malformed means off. */
export function loadRemoteImagePreference(
  storage: Pick<Storage, "getItem"> = localStorage,
): boolean {
  allowed = storage.getItem(STORAGE_KEY) === "true";
  return allowed;
}

export function storeRemoteImagePreference(
  value: boolean,
  storage: Pick<Storage, "setItem"> = localStorage,
): void {
  storage.setItem(STORAGE_KEY, String(value));
}

/**
 * True for a URL whose loading would leave this machine.
 *
 * `https:` and protocol-relative `//host/…` are remote. `data:` is inline, and a
 * relative or app-local path is served by the webview itself, so neither is.
 * Plain `http:` counts as remote even though the CSP already refuses it — this
 * predicate answers "would this reach the network", not "would it succeed".
 */
export function isRemoteUrl(url: string): boolean {
  const u = url.trim();
  return /^https?:\/\//i.test(u) || u.startsWith("//");
}

/** Remove `url(...)` references to remote content from a `style` value. */
export function stripRemoteUrls(style: string): string {
  return style.replace(
    /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi,
    (whole, _quote: string, url: string) => (isRemoteUrl(url) ? "none" : whole),
  );
}

/**
 * Strip every attribute on `el` that would fetch remote content.
 *
 * Returns true when something was blocked, so a caller can mark the element for
 * the placeholder styling. The original URL is kept in `data-blocked-src` so the
 * live view can show what it would have loaded.
 */
export function blockRemoteContent(el: Element): boolean {
  let blocked = false;
  const tag = el.tagName?.toLowerCase();

  if (tag === "img" || tag === "source" || tag === "image") {
    for (const attr of ["src", "srcset", "href", "xlink:href"]) {
      const value = el.getAttribute(attr);
      if (value !== null && isRemoteUrl(value)) {
        el.removeAttribute(attr);
        if (!el.hasAttribute("data-blocked-src")) {
          el.setAttribute("data-blocked-src", value);
        }
        blocked = true;
      }
    }
  }

  const style = el.getAttribute("style");
  if (style !== null) {
    const cleaned = stripRemoteUrls(style);
    if (cleaned !== style) {
      el.setAttribute("style", cleaned);
      blocked = true;
    }
  }

  if (blocked) el.setAttribute("data-remote-blocked", "");
  return blocked;
}
