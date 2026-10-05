/**
 * Deciding what to do when the open document changes on disk behind Monoleaf's
 * back (another editor, a sync client, an MCP server adding comments).
 *
 * Rust only reports that the file was touched (see src-tauri/src/filewatch.rs).
 * Everything here works from *contents*, never from timing: Monoleaf's own
 * saves trigger the same events as anyone else's, and they are recognised
 * because the text on disk is exactly the text this window last wrote. A
 * timing window ("ignore events for 500 ms after saving") would be wrong in
 * both directions, swallowing a real edit that lands just after a save and
 * letting a slow disk's late event through as a false alarm.
 */

/** What the window should do about a change event. */
export type ExternalChangeAction =
  /** Disk still holds what this window last loaded or saved: its own save, or
   * a tool that rewrote the file without changing it. */
  | "ignore"
  /** Disk already holds exactly what the editor shows, so there is nothing to
   * load; record it as the new baseline and treat the document as saved. */
  | "adopt"
  /** A genuine external edit and nothing unsaved here: load it silently. */
  | "reload"
  /** A genuine external edit, and reloading would discard unsaved work. */
  | "prompt";

export interface ExternalChange {
  /** The file's text as just read from disk. */
  diskText: string;
  /** The text this window last read from or wrote to this file, or null when
   * it has never been in step with it (a recovered draft). */
  lastKnownText: string | null;
  /** The document as it would be saved right now. */
  editorText: string;
  /** The window's unsaved flag. Only consulted when there is no baseline. */
  dirty: boolean;
}

export function decideExternalChange(
  change: ExternalChange,
): ExternalChangeAction {
  const { diskText, lastKnownText, editorText, dirty } = change;
  // Checked before the baseline, because it is the stronger statement: whatever
  // happened on disk, the file and the editor agree, so nothing can be lost by
  // either reloading or not.
  if (diskText === editorText) return "adopt";
  if (diskText === lastKnownText) return "ignore";
  // "Would reloading lose anything?" is answered from contents where possible,
  // not from the dirty flag. The flag can be set with nothing to lose (the
  // file was deleted and the document marked unsaved so it can be written
  // back; or the user typed and then undid it), and in all of those cases the
  // editor still holds exactly the last known disk text, so a reload is safe
  // and asking would only be noise. Without a baseline there is nothing to
  // compare against, so the flag is all there is.
  const unsaved = lastKnownText === null ? dirty : editorText !== lastKnownText;
  return unsaved ? "prompt" : "reload";
}

/**
 * Keep a selection inside a document of `length` characters.
 *
 * A reload replaces the whole document, so there is nothing to map the old
 * cursor through. Keeping the same offset is the best cheap guess: an external
 * tool usually edits a small region (a comment added, a suggestion accepted),
 * which leaves the cursor at or very near where it was everywhere before that
 * region. Only an offset past the new end needs correcting.
 */
export function clampSelection(
  anchor: number,
  head: number,
  length: number,
): { anchor: number; head: number } {
  const clamp = (n: number) => Math.max(0, Math.min(n, length));
  return { anchor: clamp(anchor), head: clamp(head) };
}

/**
 * Run `task` for every trigger, but never two at once and never more than one
 * queued: a trigger that arrives while a run is in progress schedules exactly
 * one more run after it.
 *
 * This is what stops prompts stacking. A tool that saves three times in a
 * second produces three events; the first run may be sitting in a "Reload or
 * keep?" dialog, and the other two must not open dialogs of their own. They
 * collapse into one follow-up run, which then sees whatever is on disk by the
 * time the user has answered — so an answer is never given about a version of
 * the file that has since been replaced.
 */
export function coalesce(task: () => Promise<void>): () => Promise<void> {
  let running: Promise<void> | null = null;
  let again = false;
  const loop = async () => {
    try {
      do {
        again = false;
        await task();
      } while (again);
    } finally {
      running = null;
    }
  };
  return () => {
    if (running) {
      again = true;
      return running;
    }
    running = loop();
    return running;
  };
}
