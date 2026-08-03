import DOMPurify from "dompurify";
import { blockRemoteContent, remoteImagesAllowed } from "./remoteimages";

// The document is rendered with markdown-it's `html: true`, so a file we open
// can carry arbitrary raw HTML. Every place that assigns rendered document
// markup into the live DOM (pagination measurement, print preview) or writes it
// to a shareable file (self-contained HTML export) MUST run it through here
// first — otherwise merely opening a hostile `.md` could execute script (e.g.
// `<img src=x onerror=...>` firing during Paged.js layout).
//
// DOMPurify's defaults already remove <script>, event-handler attributes
// (on*), and javascript:/data: script URLs. We additionally forbid embedding
// tags and keep the constructs the renderer legitimately emits: MathML (KaTeX
// output), the `data-srcline` attributes the pagination mapper reads, inline
// table styles/classes, and `align` for centered/right blocks.
//
// This module is only ever imported in a DOM context (the webview, or a
// happy-dom test); in a bare Node context DOMPurify has no `sanitize` to call.
// Remote content is stripped in a hook rather than by a config option, because
// the decision depends on the URL's scheme (https fetches, data: does not) and
// on which attribute carries it — see blockRemoteContent. The hook is registered
// once and reads the current setting per element, so toggling the preference
// needs no re-registration.
let hookInstalled = false;

function installRemoteContentHook(): void {
  if (hookInstalled || typeof DOMPurify.addHook !== "function") return;
  hookInstalled = true;
  DOMPurify.addHook("afterSanitizeAttributes", (node) => {
    // Runs for every node, including text nodes, which have no tagName.
    const el = node as Element;
    if (typeof el.getAttribute !== "function" || remoteImagesAllowed()) return;
    blockRemoteContent(el);
  });
}

export function sanitizeDocumentHtml(html: string): string {
  installRemoteContentHook();
  return DOMPurify.sanitize(html, {
    ADD_ATTR: ["align", "target"],
    FORBID_TAGS: ["form", "iframe", "object", "embed", "base"],
    // data-srcline (pagination mapping) must survive.
    ALLOW_DATA_ATTR: true,
  });
}
