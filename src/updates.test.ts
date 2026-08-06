import { describe, expect, it } from "vitest";
import {
  clearSkippedVersion,
  isVersionSkipped,
  skipVersion,
  type SkipStorage,
} from "./updates";

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
