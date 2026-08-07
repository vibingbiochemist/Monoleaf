import { describe, expect, it } from "vitest";
import {
  clearSkippedVersion,
  isVersionSkipped,
  RECHECK_INTERVAL_MS,
  releaseNotesText,
  dueForRecheck,
  skipVersion,
  type SkipStorage,
} from "./updates";

describe("releaseNotesText", () => {
  it("keeps a real body, so there is something to show", () => {
    expect(releaseNotesText("- Fixed a crash\n- Faster export")).toBe(
      "- Fixed a crash\n- Faster export",
    );
  });

  it("treats every way of publishing without notes as no notes", () => {
    // The three shapes that all mean the same thing. The last is what a GitHub
    // release form returns when the body field is opened and left alone, and it
    // is the one that would otherwise slip through a plain `if (notes)`.
    expect(releaseNotesText(null)).toBeNull();
    expect(releaseNotesText("")).toBeNull();
    expect(releaseNotesText("  \n\t\r\n ")).toBeNull();
  });

  it("normalises CRLF, which is what GitHub serves for web-edited bodies", () => {
    // Displayed with white-space: pre-wrap, where a surviving CR is a rendered
    // character rather than a line break.
    expect(releaseNotesText("one\r\ntwo\rthree")).toBe("one\ntwo\nthree");
  });

  it("trims surrounding blank lines without touching the body's own shape", () => {
    expect(releaseNotesText("\n\n# Heading\n\nbody\n\n")).toBe(
      "# Heading\n\nbody",
    );
  });
});

/** A stand-in for localStorage; only the three methods the module uses. */
function fakeStorage(
  entries: [string, string][] = [],
): SkipStorage & { size: () => number } {
  const map = new Map(entries);
  return {
    getItem: (k: string) => (map.has(k) ? (map.get(k) as string) : null),
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    size: () => map.size,
  };
}

describe("the skip round trip", () => {
  // The property that matters: a decision made in one session has to be read
  // back in the next one. If the write and the read ever disagree the failure is
  // silent, and it is silent in whichever direction hurts.
  it("reads back exactly the version that was skipped", () => {
    const storage = fakeStorage();
    skipVersion("1.0.1", storage);
    expect(isVersionSkipped("1.0.1", storage)).toBe(true);
  });

  it("offers nothing back when nothing was skipped", () => {
    expect(isVersionSkipped("1.0.1", fakeStorage())).toBe(false);
  });
});

describe("isVersionSkipped", () => {
  it("lets a newer version through, so skipping is never permanent", () => {
    // The whole safety argument for the feature: the stored value is consulted
    // against the exact version on offer, so the next release is unaffected.
    const storage = fakeStorage();
    skipVersion("1.0.1", storage);
    expect(isVersionSkipped("1.0.2", storage)).toBe(false);
  });

  it("lets an older version through too", () => {
    // Not an oversight. An equality test answers "did you decline this?", which
    // is the question asked. An ordering test would answer "is this newer than
    // what you declined?" and would wrongly suppress a deliberate downgrade or a
    // release that was pulled and republished.
    const storage = fakeStorage();
    skipVersion("1.0.2", storage);
    expect(isVersionSkipped("1.0.1", storage)).toBe(false);
  });
});

describe("skipVersion", () => {
  it("keeps one version, so skips cannot accumulate unseen", () => {
    const storage = fakeStorage();
    skipVersion("1.0.1", storage);
    skipVersion("1.0.2", storage);
    expect(isVersionSkipped("1.0.1", storage)).toBe(false);
    expect(isVersionSkipped("1.0.2", storage)).toBe(true);
    expect(storage.size()).toBe(1);
  });

  it("does not throw when storage refuses the write", () => {
    // Over quota. The offer coming back at the next check is the right failure;
    // an exception raised at somebody mid-sentence is not.
    const full: SkipStorage = {
      getItem: () => null,
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
      removeItem: () => {},
    };
    expect(() => skipVersion("1.0.1", full)).not.toThrow();
  });
});

describe("clearSkippedVersion", () => {
  it("makes a skipped version offerable again", () => {
    // What keeps storage from contradicting the screen: an explicit check can
    // re-offer a skipped version, and once it is in the bar it must not still be
    // recorded as declined.
    const storage = fakeStorage();
    skipVersion("1.0.1", storage);
    clearSkippedVersion(storage);
    expect(isVersionSkipped("1.0.1", storage)).toBe(false);
  });

  it("is harmless when nothing was skipped", () => {
    expect(() => clearSkippedVersion(fakeStorage())).not.toThrow();
  });
});

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
