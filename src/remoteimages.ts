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
 * Not just `<img src>`, and not just the tags the renderer emits — the document
 * carries arbitrary raw HTML, so anything the *engine* will fetch has to be
 * covered. This module is the single place that decides, and
 * [`blockRemoteContent`] enumerates the attributes:
 *
 * - `src`, `srcset`, `poster` and `background` on any element. Not one of these
 *   is restricted to the tag it belongs on: `<input type="image" src>` and
 *   `<video poster>` are both fetched under `img-src`, and `background` is a
 *   legacy attribute on `table`/`td` that still loads.
 * - `href` / `xlink:href`, but only on `image`, `feImage` and `use` — the SVG
 *   elements that fetch one. `<a href>` must keep its link.
 * - the whole `style` attribute when it references anything remote. Inline
 *   styles survive sanitizing on purpose, because PDF table borders need them,
 *   so this is an open channel; see [`styleReferencesRemote`] for why it is not
 *   rewritten in place.
 *
 * A denylist over an open channel is the weak part of this design — the CSP
 * permits `img-src https:`, so every miss is a live request. The rules above are
 * therefore written to over-match, and [`blockRemoteContent`] runs on every
 * element the sanitizer produces rather than on a list of interesting ones.
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

/** A value is remote only if a URL *starts* with a scheme or `//`. */
const REMOTE_URL_START = /^(?:https?:|\/\/)/i;

/**
 * The URLs an attribute value can resolve to.
 *
 * `srcset` is a comma-separated candidate list, so a remote URL can hide behind
 * a local one — `srcset="local.png 1x, https://tracker/x 2x"` — and testing the
 * value as a single URL would miss it. But a `data:` URI contains commas of its
 * own, so splitting on them blindly cuts `data:image/png;base64,//8A` into a
 * token that starts with `//` and looks protocol-relative. Hence: split on
 * whitespace first (no URL contains any), then treat a `data:` token as one
 * whole URL and only comma-split the rest.
 */
function urlCandidates(value: string): string[] {
  const urls: string[] = [];
  for (const token of value.split(/\s+/)) {
    if (token === "") continue;
    if (/^data:/i.test(token)) {
      // The payload owns every comma but the one separating candidates.
      urls.push(token.replace(/,$/, ""));
    } else {
      urls.push(...token.split(","));
    }
  }
  return urls;
}

/**
 * True when any candidate in an attribute value is remote. Condemning the whole
 * attribute if *any* candidate is remote is deliberately blunt: it also covers
 * the single-URL attributes, and over-matching costs an image while
 * under-matching costs the reader's IP address.
 */
function referencesRemote(value: string): boolean {
  return urlCandidates(value).some((url) => REMOTE_URL_START.test(url));
}

/**
 * Resolve CSS escape sequences: `\` + 1-6 hex digits + optional single
 * whitespace, or `\` + any other character.
 *
 * The CSS parser resolves these before it resolves a URL, so `url(https\3a
 * //tracker/x)` and `url(\68 ttps://tracker/x)` both issue a request while
 * matching no pattern written against the raw bytes.
 */
export function decodeCssEscapes(s: string): string {
  return s.replace(
    /\\(?:([0-9a-fA-F]{1,6})[ \t\n\r\f]?|(.))/g,
    (_m, hex: string | undefined, lit: string | undefined) =>
      hex === undefined
        ? (lit ?? "")
        : String.fromCodePoint(parseInt(hex, 16) || 0xfffd),
  );
}

// A scheme or protocol-relative marker only counts at the start of a value or
// immediately after (, ', ", or whitespace. Comma is deliberately NOT a
// boundary: a data: URI's base64 payload starts right after the comma in
// ";base64," and can legitimately begin with "//". Every CSS construct that
// names a URL puts one of these characters first — url( , a quoted <string> in
// image-set — so requiring the boundary costs no coverage.
const REMOTE_IN_CSS = /(?:^|[\s('"])(?:https?:|\/\/)/i;

/**
 * True when a `style` attribute value references anything remote.
 *
 * Decide-and-drop, not rewrite: the caller removes the whole attribute. This is
 * a deliberate retreat from parsing CSS. A regex over `url(...)` tokens misses
 * every construct that names a URL without one (`image-set('https://…' 1x)`),
 * and anything short of a real parser can be walked past with escapes. Matching
 * the decoded value loosely and throwing the attribute away has an
 * understandable failure mode: a false positive costs a table border, a false
 * negative costs the reader's IP address.
 *
 * The CSSOM would look cleaner — assign to `element.style`, walk the
 * declarations — but happy-dom/jsdom and WebView2 support different property
 * sets, so a green test would say nothing about the shipped app. This is
 * engine-independent on purpose.
 *
 * "Loosely" still needs a token boundary. Matching `//` anywhere in the value
 * condemned `url(data:image/png;base64,…////…)`, because the base64 alphabet
 * includes `/` and three 0xFF source bytes encode to `////` — so ordinary PNG
 * and JPEG data was stripped, and only with the setting OFF.
 */
export function styleReferencesRemote(style: string): boolean {
  return REMOTE_IN_CSS.test(decodeCssEscapes(style));
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

  // Swept on ANY element, not just the tags that are supposed to carry them.
  // The sanitizer's tag allowlist is not what keeps these out of the document —
  // `<input type="image" src>` and `<video poster>` both fetch under img-src,
  // and `background` is a legacy attribute on table/td that still loads.
  const attrs = ["src", "srcset", "poster", "background"];
  // href stays gated to the tags that fetch it. Stripping remote href from <a>
  // would break every link in the document, which is not the goal.
  if (tag === "image" || tag === "feimage" || tag === "use") {
    attrs.push("href", "xlink:href");
  }
  for (const attr of attrs) {
    const value = el.getAttribute(attr);
    if (value !== null && referencesRemote(value)) {
      el.removeAttribute(attr);
      if (!el.hasAttribute("data-blocked-src")) {
        el.setAttribute("data-blocked-src", value);
      }
      blocked = true;
    }
  }

  // The whole attribute goes, rather than individual url() tokens — see
  // styleReferencesRemote for why this does not try to rewrite CSS.
  const style = el.getAttribute("style");
  if (style !== null && styleReferencesRemote(style)) {
    el.removeAttribute("style");
    blocked = true;
  }

  if (blocked) el.setAttribute("data-remote-blocked", "");
  return blocked;
}
