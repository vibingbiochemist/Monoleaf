import { describe, expect, it } from "vitest";
import { RECHECK_INTERVAL_MS, dueForRecheck } from "./updates";

const HOUR = 60 * 60 * 1000;
/** An arbitrary fixed "now", so nothing here depends on the wall clock. */
const NOW = 1_700_000_000_000;

describe("dueForRecheck", () => {
  it("is not due before the interval has elapsed", () => {
    expect(dueForRecheck(NOW, NOW - 23 * HOUR)).toBe(false);
  });

  it("is due once the interval has elapsed", () => {
    expect(dueForRecheck(NOW, NOW - 25 * HOUR)).toBe(true);
  });

  it("is due exactly on the boundary", () => {
    // Stated so the >= is a decision rather than an accident: a check due at
    // exactly 24h should happen at 24h, not 24h plus one poll.
    expect(dueForRecheck(NOW, NOW - RECHECK_INTERVAL_MS)).toBe(true);
  });

  it("is due when nothing has been checked yet", () => {
    // A window that has somehow never checked should not wait a day to start.
    expect(dueForRecheck(NOW, null)).toBe(true);
  });

  it("is due when the clock has moved backwards", () => {
    // The case this function exists to get right. NTP correcting a badly-set
    // clock, or a timezone fix, can leave the last-checked stamp in the future.
    // A naive `now - last >= interval` is false for as long as the skew lasts,
    // silently disabling checks with nothing to say why.
    expect(dueForRecheck(NOW, NOW + 100 * HOUR)).toBe(true);
  });

  it("survives a long suspend, because it compares clocks and not uptime", () => {
    // A machine closed for a week wakes with a stamp a week old and checks on
    // the first tick. A setInterval(24h) would still be counting awake time.
    expect(dueForRecheck(NOW, NOW - 7 * 24 * HOUR)).toBe(true);
  });

  it("takes the interval as an argument, so the policy is not baked in", () => {
    expect(dueForRecheck(NOW, NOW - 2 * HOUR, HOUR)).toBe(true);
    expect(dueForRecheck(NOW, NOW - 2 * HOUR, 3 * HOUR)).toBe(false);
  });
});
