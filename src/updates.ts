/**
 * When an automatic update check is due.
 *
 * ## Why this is its own module
 *
 * The updater's moving parts live in `main.ts` because they are inseparable from
 * the DOM and from `invoke` — there is nothing to test in a button that calls a
 * Tauri command. The decision of *when* to check is different: it is arithmetic
 * on two numbers, it has edge cases that only appear on somebody else's machine
 * (a laptop closed for a week, a clock corrected backwards by NTP), and getting
 * it wrong fails silently in both directions — too eager means unrequested
 * network traffic, too slow means the feature quietly does nothing.
 */

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
