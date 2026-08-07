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
 * answer, not a formality. The same is true of a decision the user made, held in
 * storage, that has to survive a restart and then be read back correctly — both
 * ways of getting that wrong are silent, and storage is taken as an argument,
 * following `recovery.ts`, so the round trip can be tested against a fake rather
 * than a browser. The decision of *when* to check is different again: it is
 * arithmetic on two numbers, it has edge cases that only appear on somebody
 * else's machine (a laptop closed for a week, a clock corrected backwards by
 * NTP), and getting it wrong fails silently in both directions — too eager means
 * unrequested network traffic, too slow means the feature quietly does nothing.
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

/**
 * Which version the user has decided not to install.
 *
 * ## One version, not a set
 *
 * The stored value is overwritten by whatever is skipped next and consulted only
 * against the exact version on offer, so skipping is never permanent: a newer
 * release always gets through. That is the property that makes this safe to
 * offer at all. A set of skipped versions would accumulate, and a user who
 * skipped a few in a row would have no way to tell that they had, or to undo it.
 */

const SKIPPED_KEY = "monoleaf.update-skipped";

/** The subset of `Storage` this module uses; a plain object satisfies it. */
export type SkipStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/**
 * Whether this exact version has been skipped.
 *
 * Deliberately an equality test and not a comparison. Version *ordering* would
 * need a semver parser and would answer a different question — "is this newer
 * than what I declined" — which sounds equivalent and is not: a release pulled
 * and republished, or a downgrade offered deliberately, would be suppressed by
 * an ordering rule and is correctly offered by this one.
 */
export function isVersionSkipped(
  version: string,
  storage: SkipStorage = localStorage,
): boolean {
  return storage.getItem(SKIPPED_KEY) === version;
}

/**
 * Record that the user does not want this version.
 *
 * Failure is swallowed for the same reason `writeDraft` swallows it: storage
 * being full is a reason for the offer to come back later, not for the click to
 * raise an error at somebody mid-sentence.
 */
export function skipVersion(
  version: string,
  storage: SkipStorage = localStorage,
): void {
  try {
    storage.setItem(SKIPPED_KEY, version);
  } catch {
    /* the offer returns at the next check — see above */
  }
}

/**
 * Forget the skip.
 *
 * Called whenever an offer is actually put on screen, so the stored decision can
 * never contradict what the user is looking at. Without this, a version skipped
 * and then re-offered by an explicit "Check for updates" would sit in the bar
 * while storage still said it had been declined, and the next automatic check
 * would hide it again with no way to tell why.
 */
export function clearSkippedVersion(storage: SkipStorage = localStorage): void {
  storage.removeItem(SKIPPED_KEY);
}

/**
 * How long between automatic checks.
 *
 * A day, because the thing being detected changes on the order of weeks and the
 * cost of being a few hours late is nil. This is the number to argue about; the
 * mechanism below does not care what it is.
 */
export const RECHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * How often the interval is *examined* — which is not how often it fires.
 *
 * The check is due-by-wall-clock, not due-by-timer, and these are two different
 * things on a laptop. A `setInterval` of 24h does not fire 24h after it was set:
 * it fires after 24h of the machine being awake, so a machine suspended nightly
 * drifts later every day and one closed for a week does not fire at all until a
 * week of uptime has accumulated. Comparing timestamps on a short tick sidesteps
 * that entirely — a resumed machine notices on the first tick after waking.
 *
 * Half an hour is small enough that the wait after a resume is not noticeable
 * and large enough that the tick itself is free: it compares two numbers and,
 * almost always, returns.
 */
export const RECHECK_POLL_MS = 30 * 60 * 1000;

/**
 * Whether enough time has passed since the last check.
 *
 * `lastCheckedAt` is a `Date.now()` stamp, or `null` if no check has happened in
 * this session yet — which reads as "due", so a window that has somehow never
 * checked does not wait a day to start.
 *
 * A clock that has moved *backwards* also reads as due. This is the case worth
 * being deliberate about: NTP correcting a badly-set clock, or a user fixing
 * their timezone, can leave `lastCheckedAt` in the future, and a naive
 * `now - last >= interval` would then be false for as long as the skew lasts —
 * silently disabling checks for what could be hours or years, with nothing to
 * indicate why. Treating it as due costs one extra request in a rare case; the
 * alternative costs the feature.
 */
export function dueForRecheck(
  now: number,
  lastCheckedAt: number | null,
  interval: number = RECHECK_INTERVAL_MS,
): boolean {
  if (lastCheckedAt === null) return true;
  if (now < lastCheckedAt) return true;
  return now - lastCheckedAt >= interval;
}
