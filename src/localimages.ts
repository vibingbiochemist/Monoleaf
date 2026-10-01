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

/**
 * Rewrite an absolute path as relative to the open document's directory, or
 * return it unchanged if it isn't under that directory (a different drive,
 * a sibling folder, or no open document at all).
 *
 * Deliberately does not escape upward with `../..` to reach a common
 * ancestor outside the document's own directory tree: the payoff (a shorter
 * reference) is small, and "must be inside the document's folder or its
 * subfolders" is a simple, unsurprising rule for what a picked/dropped image
 * turns into, instead of a reference that silently depends on exactly how
 * far apart two folders happen to sit.
 */
export function relativizeUnderDocument(
  absolutePath: string,
  documentPath: string | null,
): string | null {
  if (documentPath === null) return null;

  const dir = documentPath.split(/[\\/]/);
  dir.pop(); // drop the document's own file name
  const target = absolutePath.split(/[\\/]/);

  for (let i = 0; i < dir.length; i++) {
    if (dir[i] !== target[i]) return null; // not under the document's directory
  }
  const rest = target.slice(dir.length);
  if (rest.length === 0) return null; // the path IS the document's directory
  return rest.join("/"); // "/" regardless of platform: markdown convention,
  // and the document may later be opened on a different OS.
}

/** Extensions `read_image_as_data_url` (src-tauri/src/lib.rs, `image_mime_type`)
 * accepts. Duplicated here rather than queried from Rust: it's a short,
 * closed, rarely-changing list, and both the file-picker filter and the
 * drag-and-drop filter need it synchronously, before any invoke. */
export const IMAGE_EXTENSIONS = [
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "svg",
  "bmp",
  "avif",
];

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
// width, and (since this module's cache/resolution state is not part of the
// widget's own fields) three captured-at-construction values, `remoteBlocked`,
// `resolvedLocalPath`, and `loadFailureCount`. An unrelated edit changes none
// of those for this image, so eq() says "same," the old DOM is kept, and
// toDOM() (therefore loadLocalImage) never reruns.
//
// A reconfigure that changed getCurrentDocumentPath() or
// remoteImagesAllowed() changes `resolvedLocalPath`/`remoteBlocked` for a
// widget whose reference depends on it. But resolving to the SAME path twice
// is not the only way the outcome can change: a widget built right after a
// failed load, and one built on the next reconfigure with nothing else
// different, resolve to the identical path — that retry needs
// `loadFailureCount` specifically, or eq() would see three matching fields
// and one unchanged one, call the two widgets equal, and keep showing the
// stale failure placeholder even after the file starts loading successfully.
const cache = new Map<string, Promise<string>>();

// Resolved absolute path -> number of loads that have failed for it so far.
// eq() (ImageWidget, livepreview.ts) cannot tell "the resolved path changed"
// apart from "the same path just started working" by comparing
// resolvedLocalPath alone — that field is identical before and after a
// retry, since the document didn't move, only the file's existence did.
// This counter is the thing that DOES differ: a widget captures it at
// construction (see ImageWidget's `loadFailureCount` field), so a widget
// built right after a failure and one built after the next reconfigure -
// even at the very same resolved path - compare unequal via eq() until a
// load actually succeeds, at which point the count stops changing and
// eq() goes back to treating that path as stable across ordinary edits.
//
// Uncapped and unthrottled by design, with a known consequence: a
// permanently-broken reference (typo, moved file) retries on every single
// reconfigure for as long as the count keeps incrementing, and with
// autosave on and active typing that's saveFile firing every ~1.5s idle
// gap — a continuous retry every ~1.5 seconds for the rest of the editing
// session, not an occasional check. Each retry is cheap (one IPC round
// trip, a fast ENOENT), and the alternative — capping retries — would
// bring back the exact problem this file exists to avoid: a file that
// shows up later never loading without closing and reopening the
// document. Accepted trade-off, not an oversight.
const failureCount = new Map<string, number>();

/** How many times a load for `resolvedPath` has failed so far (0 if never
 * attempted or never failed). Read at ImageWidget construction time. */
export function loadFailureCount(resolvedPath: string): number {
  return failureCount.get(resolvedPath) ?? 0;
}

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
    pending.catch(() => {
      cache.delete(resolvedPath);
      failureCount.set(resolvedPath, loadFailureCount(resolvedPath) + 1);
    });
  }
  return pending;
}

// ---------------------------------------------------------------------------
// "Wherever the image is": find-by-name fallback

/** The last path segment, or "" for a path ending in a separator. */
function baseName(path: string): string {
  return path.split(/[\\/]/).pop() ?? "";
}

/** The open document's folder, in the document path's own separator style,
 * kept absolute: `C:\note.md` → `C:\` (a bare `C:` would mean "the current
 * directory on C:" to the OS) and `/note.md` → `/`. */
function documentDir(documentPath: string): string {
  const sep =
    documentPath.includes("\\") && !documentPath.includes("/") ? "\\" : "/";
  const parts = documentPath.split(/[\\/]/);
  parts.pop();
  const dir = parts.join(sep);
  if (dir === "") return sep;
  if (/^[a-zA-Z]:$/.test(dir)) return dir + sep;
  return dir;
}

// (document folder, file name) -> in-flight/completed search. A rejection is
// evicted for the same reason loadLocalImage's is. A successful but EMPTY
// result is cached, and that is deliberate: it is the ordinary outcome for a
// genuinely missing file, and re-walking the folder tree on every reconfigure
// (autosave: every ~1.5 s while typing) is exactly the cost the caps in Rust
// exist to avoid. The direct load still retries each time (see
// `failureCount`), so a file that appears at its referenced path is picked
// up at once; one that appears somewhere else is found after the document is
// reopened or the reference is edited.
const searchCache = new Map<string, Promise<string[]>>();

/**
 * Files named `name` under the open document's folder (and its subfolders,
 * to a depth the Rust side caps), shallowest level only — see
 * `find_image_by_name` in src-tauri/src/lib.rs for the exact rules.
 */
export function findLocalImageByName(
  documentPath: string,
  name: string,
): Promise<string[]> {
  const dir = documentDir(documentPath);
  const key = `${dir}\0${name}`;
  let pending = searchCache.get(key);
  if (pending === undefined) {
    pending = invoke<string[]>("find_image_by_name", { dir, name });
    searchCache.set(key, pending);
    pending.catch(() => searchCache.delete(key));
  }
  return pending;
}

/** Where a local image's bytes came from. `foundAt` is set only when the
 * reference's own path failed and the file was found elsewhere under the
 * document's folder — the signal the editor uses to say so. */
export interface LocalImage {
  dataUrl: string;
  foundAt: string | null;
}

/** Several files under the document's folder share the referenced name. The
 * editor shows the candidates rather than picking one. */
export class AmbiguousImageError extends Error {
  constructor(
    readonly name: string,
    readonly candidates: readonly string[],
  ) {
    super(`Several files are named ${name}:\n${candidates.join("\n")}`);
  }
}

/**
 * Load a resolved local image, falling back to a search by file name under
 * the open document's folder when the path itself does not load.
 *
 * The fallback is what makes `![](plot.png)` show the picture when the file
 * actually lives in `figures/`, the way Obsidian finds attachments. It never
 * rewrites the reference, and it reports `foundAt` so the editor can say
 * where the bytes came from: a path that only works because Monoleaf went
 * looking will not work in the reader's own PDF pipeline, and a picture that
 * quietly appears anyway would hide exactly that.
 *
 * A search that itself fails (the name has no image extension, the folder is
 * unreadable) is treated as "nothing found": the error worth reporting is the
 * original load failure, not the fallback's.
 */
export async function loadLocalImageWithFallback(
  resolvedPath: string,
  documentPath: string | null,
): Promise<LocalImage> {
  try {
    return { dataUrl: await loadLocalImage(resolvedPath), foundAt: null };
  } catch (err) {
    const name = baseName(resolvedPath);
    // No search without a folder to search, and none for a name Rust would
    // refuse anyway (`![](report.pdf)`): that saves the round trip and keeps
    // the error the user sees about the reference, not about the search.
    const ext = name.split(".").pop()?.toLowerCase() ?? "";
    if (documentPath === null || !IMAGE_EXTENSIONS.includes(ext)) throw err;
    const found = await findLocalImageByName(documentPath, name).catch(
      () => [] as string[],
    );
    if (found.length === 0) throw err;
    if (found.length > 1) throw new AmbiguousImageError(name, found);
    return { dataUrl: await loadLocalImage(found[0]), foundAt: found[0] };
  }
}

/**
 * Data URLs for the local image references of a document, keyed by the
 * reference exactly as written, for export and print (renderDocumentHtml's
 * `localImages`, export.ts). A reference that cannot be resolved (no open
 * document) or loaded (missing, not an image, ambiguous) is simply absent, and
 * the exporter renders it as alt text, as every local reference used to be.
 */
export async function loadLocalImagesForExport(
  sources: readonly string[],
  documentPath: string | null,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  await Promise.all(
    sources.map(async (src) => {
      const resolved = resolveLocalImagePath(src, documentPath);
      if (resolved === null) return;
      try {
        const { dataUrl } = await loadLocalImageWithFallback(
          resolved,
          documentPath,
        );
        out.set(src, dataUrl);
      } catch {
        // Alt text in the export, exactly as before local rendering existed.
      }
    }),
  );
  return out;
}
