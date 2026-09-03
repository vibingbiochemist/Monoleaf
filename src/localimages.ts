/**
 * Resolving and loading local (on-disk) image references in the live preview.
 *
 * A local reference in a `.md` — `![alt](diagram.png)` or `<img src="../x.png">`
 * — names a file next to the document, not a URL the webview can fetch itself:
 * there is no asset-protocol scope and no fs plugin, so the only way to get the
 * bytes is the `read_image_as_data_url` Tauri command, which returns a
 * `data:` URL the browser can decode like any other image source.
 *
 * This module owns two small, independent things:
 * - resolving a markdown-relative reference against the open document's path
 *   (`resolveLocalImagePath`), and
 * - fetching and caching the resulting data URL (`loadLocalImage`).
 *
 * The current document's path is pushed in from `main.ts` whenever it changes
 * (open, save-as, …) rather than imported directly, the same shape
 * `remoteimages.ts` uses for the remote-images toggle — it keeps this module
 * free of any dependency on `main.ts`, which itself imports the live-preview
 * extension that (transitively) reads from here.
 */

import { invoke } from "@tauri-apps/api/core";

let currentDocumentPath: string | null = null;

export function setCurrentDocumentPath(path: string | null): void {
  currentDocumentPath = path;
}

export function getCurrentDocumentPath(): string | null {
  return currentDocumentPath;
}

/** True for a POSIX absolute path (`/x`), a Windows drive path (`C:\x`), a
 * Windows root-relative path (`\x`), or a UNC/protocol-relative path
 * (`\\host\share`, `//host/share`) — anything that names a file without
 * reference to the open document's location. */
function isAbsoluteLocalPath(path: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(path) || /^[\\/]/.test(path);
}

/**
 * Resolve a markdown image reference to an absolute path, or `null` if it
 * cannot be resolved (a relative reference with no open document to be
 * relative *to*).
 *
 * An already-absolute reference is returned as-is — including a UNC path,
 * which `read_image_as_data_url` will itself refuse unless the user has
 * opted into network paths, the same guard `read_file` applies.
 */
export function resolveLocalImagePath(
  url: string,
  documentPath: string | null,
): string | null {
  if (isAbsoluteLocalPath(url)) return url;
  if (documentPath === null) return null;

  const sep =
    documentPath.includes("\\") && !documentPath.includes("/") ? "\\" : "/";
  const dir = documentPath.split(/[\\/]/);
  dir.pop(); // drop the document's own file name

  for (const segment of url.split(/[\\/]/)) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") dir.pop();
    else dir.push(segment);
  }
  return dir.join(sep);
}

// Resolved absolute path -> in-flight/completed fetch. Keyed by resolved path
// rather than the raw markdown reference so two different relative references
// that land on the same file share one invoke. It also matters across a
// liveCompartment.reconfigure() (main.ts: saveFile, toggleLiveView,
// toggleRemoteImages): livePreviewPlugin.update() (livepreview.ts) treats
// `tr.reconfigured` as a rebuild trigger, so `build()` reruns and constructs
// a fresh ImageWidget for this file — without this cache, that fresh widget
// would re-invoke even though the file was already loaded moments ago.
//
// An ordinary edit elsewhere in the document does NOT hit this path, even
// though `build()` reruns for that too (docChanged): CodeMirror compares the
// freshly-built ImageWidget against the existing one via eq() — url, alt,
// width, and (since this file's cache/resolution state is not part of the
// widget's own fields) two captured-at-construction values, `remoteBlocked`
// and `resolvedLocalPath`. An unrelated edit changes none of those for this
// image, so eq() says "same," the old DOM is kept, and toDOM() (therefore
// loadLocalImage) never reruns. A reconfigure that actually changed
// getCurrentDocumentPath() or remoteImagesAllowed() DOES change one of those
// captured values for a widget whose reference depends on it, which is
// exactly what makes eq() report a difference and forces the redraw this
// cache is then in place for.
const cache = new Map<string, Promise<string>>();

/**
 * Load (and cache) the data: URL for an already-resolved absolute path.
 *
 * A rejection is NOT cached: unlike a successful load (this module does no
 * file-watching, so a *changed* file stays stale until the next reconfigure
 * that changes what this widget resolves to — see the comment on `cache`
 * above), a failed one commonly means the file does not exist *yet* — a
 * reference typed before the target is saved or copied into place. Caching
 * that failure would mean the image never loads for the rest of the session
 * even after the file appears, until the document is closed and reopened.
 * Evicting on failure costs an extra invoke per reconfigure for a reference
 * that stays permanently broken, which is cheap next to what it buys.
 */
export function loadLocalImage(resolvedPath: string): Promise<string> {
  let pending = cache.get(resolvedPath);
  if (pending === undefined) {
    pending = invoke<string>("read_image_as_data_url", { path: resolvedPath });
    cache.set(resolvedPath, pending);
    pending.catch(() => cache.delete(resolvedPath));
  }
  return pending;
}
