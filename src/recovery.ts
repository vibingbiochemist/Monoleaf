/**
 * Crash-recovery snapshots of unsaved work.
 *
 * When a document has unsaved changes and autosave is off (or it has no file
 * yet), the editor keeps a debounced snapshot in `localStorage`. A snapshot left
 * behind at launch means the last session ended without saving — a crash, or a
 * forced close — and the user is offered it back.
 *
 * ## Why this is its own module
 *
 * The snapshot has a *format*, and both halves of it have to agree: whatever
 * writes it and whatever reads it back. Those two lived about sixty lines apart
 * in a 2700-line file, with the key prefix declared 1500 lines above both, and
 * nothing checked that a snapshot could actually be read back. That round trip
 * is the property that matters — if it breaks, the failure is silent and the
 * cost is somebody's unsaved work.
 *
 * Everything here takes its storage as an argument, so the round trip can be
 * tested against a fake rather than a browser.
 *
 * ## One key per window
 *
 * Each window keeps its own snapshot, so two open documents cannot clobber each
 * other. At a fresh launch the main window is the only live one, which means
 * *every* key under the prefix is an orphan from the previous session — that is
 * what makes collecting them all the right thing to do at startup.
 */

const PREFIX = "monoleaf.recovery.";

/** The subset of `Storage` this module uses; a plain object satisfies it. */
export type DraftStorage = Pick<
  Storage,
  "length" | "key" | "getItem" | "setItem" | "removeItem"
>;

export interface RecoveryDraft {
  /** The storage key it came from, so the caller can consume it afterwards. */
  key: string;
  /** The file it belongs to, or null for a document never saved. */
  path: string | null;
  content: string;
}

/** This window's snapshot key. */
export function recoveryKey(windowLabel: string): string {
  return `${PREFIX}${windowLabel}`;
}

/**
 * Write a snapshot, or do nothing if storage refuses it.
 *
 * A failure here must not propagate: exceeding the quota is a reason to skip one
 * snapshot, not to interrupt the user's typing.
 */
export function writeDraft(
  key: string,
  path: string | null,
  content: string,
  storage: DraftStorage = localStorage,
): boolean {
  try {
    storage.setItem(key, JSON.stringify({ path, content }));
    return true;
  } catch {
    return false;
  }
}

/** Forget a snapshot — it has been recovered, discarded, or saved to disk. */
export function discardDraft(
  key: string,
  storage: DraftStorage = localStorage,
): void {
  storage.removeItem(key);
}

/**
 * Every snapshot in storage, one per window from a previous session.
 *
 * Also *repairs*: an entry that cannot be parsed, or that carries no content, is
 * removed rather than left to be offered again at every launch. Keys outside the
 * prefix are never touched — this runs over the whole of `localStorage`, which
 * also holds the user's preferences.
 */
export function collectRecoveryDrafts(
  storage: DraftStorage = localStorage,
): RecoveryDraft[] {
  const drafts: RecoveryDraft[] = [];
  const stale: string[] = [];
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (key === null || !key.startsWith(PREFIX)) continue;
    const raw = storage.getItem(key);
    if (raw === null) continue;
    let draft: RecoveryDraft | null = null;
    try {
      const parsed = JSON.parse(raw) as { path?: unknown; content?: unknown };
      if (typeof parsed.content === "string") {
        draft = {
          key,
          path: typeof parsed.path === "string" ? parsed.path : null,
          content: parsed.content,
        };
      }
    } catch {
      draft = null;
    }
    if (draft === null) stale.push(key);
    else drafts.push(draft);
  }
  // Removed after the scan, not during: mutating storage while iterating it by
  // index shifts the remaining keys and would skip entries.
  for (const key of stale) storage.removeItem(key);
  return drafts;
}

/** How a draft is described to the user when offering to recover it. */
export function draftName(path: string | null): string {
  if (!path) return "an untitled document";
  return path.split(/[\\/]/).pop() ?? path;
}
