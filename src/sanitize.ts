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
// FORBID_TAGS is also surface reduction, not only XSS defense. media tags
// (video/audio/track) are not constructs renderDocumentHtml can produce, so
// allowing them bought nothing and cost a remote-content channel: `<video
// poster="https://…">` fetches under img-src and is not an image tag, so it
// slipped past a sweep that enumerated img/source/image. Anything the renderer
// cannot emit should not be reachable from a document. <input> is the exception
// and must stay allowed — markdown-it-task-lists renders `- [x]` as
// `<input type="checkbox" disabled>`, and this is the export/print pipeline, so
// forbidding it would silently delete every checkbox from the PDF and the
// self-contained HTML export. Its remote channel (`type="image"` + `src`) is
// closed by blockRemoteContent, which sweeps `src` on every element.
//
// This module is only ever imported in a DOM context (the webview, or a
// happy-dom test); in a bare Node context DOMPurify has no `sanitize` to call.
// Remote content is stripped in a hook rather than by a config option, because
// the decision depends on the URL's scheme (https fetches, data: does not) and
// on which attribute carries it — see blockRemoteContent. The hook is registered
// once and reads the current setting per element, so toggling the preference
// needs no re-registration.
let hookInstalled = false;

function installHooks(): void {
  if (hookInstalled || typeof DOMPurify.addHook !== "function") return;
  hookInstalled = true;
  DOMPurify.addHook("afterSanitizeAttributes", (node) => {
    // Runs for every node, including text nodes, which have no tagName.
    const el = node as Element;
    if (typeof el.getAttribute !== "function") return;
    if (!remoteImagesAllowed()) blockRemoteContent(el);
    // `target` is allowed (ADD_ATTR) but nothing pairs it with `rel`. Inside the
    // app that is harmless — clicks are intercepted and routed to the system
    // browser via openExternal, and the window never navigates. In the exported
    // HTML, opened in a real browser, it is reverse tabnabbing: the opened page
    // keeps a live window.opener handle and can navigate the document that
    // spawned it. Both hooks share one registration, per the note above.
    if (el.hasAttribute("target")) {
      el.setAttribute("rel", "noopener noreferrer");
    }
  });
}

export function sanitizeDocumentHtml(html: string): string {
  installHooks();
  return DOMPurify.sanitize(html, {
    ADD_ATTR: ["align", "target"],
    FORBID_TAGS: [
      "form",
      "iframe",
      "object",
      "embed",
      "base",
      "video",
      "audio",
      "track",
    ],
    // data-srcline (pagination mapping) must survive.
    ALLOW_DATA_ATTR: true,
  });
}
