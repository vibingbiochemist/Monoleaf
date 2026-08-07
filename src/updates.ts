/**
 * Pure helpers for the update offer.
 *
 * ## Why this is its own module
 *
 * The updater's moving parts live in `main.ts` because they are inseparable from
 * the DOM and from `invoke` — there is nothing to test in a button that calls a
 * Tauri command. What *is* testable is the handful of decisions made about
 * values that arrive from a remote host, and those are the ones worth pinning:
 * the release body comes from whatever text somebody typed into a GitHub release
 * form, so "what counts as no notes at all" is a real question with a wrong
 * answer, not a formality.
 */

/**
 * The release body as it should be displayed, or `null` when there is nothing to
 * show.
 *
 * Three shapes all mean "this release was published without notes" and all have
 * to collapse to the same `null`: the field absent (`null` from Rust's
 * `Option<String>`), the empty string, and a body of nothing but whitespace —
 * which is what a GitHub release form returns when someone opens the body field
 * and leaves it. Rendering an empty "What's new" disclosure for any of them
 * offers the user a control that reveals nothing.
 *
 * Newlines are normalised because the body is displayed with `white-space:
 * pre-wrap`, where a stray CR is a rendered character rather than a line break.
 * GitHub serves CRLF for anything edited through the web form.
 */
export function releaseNotesText(notes: string | null): string | null {
  if (notes === null) return null;
  const normalised = notes.replace(/\r\n?/g, "\n").trim();
  return normalised === "" ? null : normalised;
}
