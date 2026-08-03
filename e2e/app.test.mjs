/**
 * End-to-end tests against the built Monoleaf binary.
 *
 * Run with `npm run test:e2e`. Deliberately *not* part of `npm test`: these
 * launch a real window, take seconds each, need a release build, and are
 * Windows-only. See ./harness.mjs for why they assert on window titles and why
 * each run gets a throwaway WebView2 profile.
 */

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { basename } from "node:path";
import {
  assertNoInstanceRunning,
  CAN_RUN_E2E,
  SKIP_REASON,
  binaryPath,
  killAll,
  launch,
  runningPids,
  normalizeTitle,
  tempDocument,
} from "./harness.mjs";

// Skipped rather than failed off Windows: see CAN_RUN_E2E in ./harness.mjs. A
// contributor on Linux should get a green run with a stated reason, not an error
// about a missing .exe they cannot produce.
describe(
  "the built application",
  { skip: CAN_RUN_E2E ? false : SKIP_REASON },
  () => {
    before(async () => {
      binaryPath(); // fail early, with build instructions, if it is missing
      await assertNoInstanceRunning();
    });

    after(async () => {
      await killAll();
    });

    it("launches and runs its own frontend", async () => {
      // The strongest cheap signal that the app really works. `refreshTitle()`
      // sets the title via Tauri's setTitle, so this title can only appear if the
      // embedded frontend loaded and executed. A binary that fell back to the dev
      // URL keeps the builder's plain "Monoleaf" title and shows a connection
      // error — which is precisely the regression that shipped once.
      const app = await launch();
      try {
        const titles = await app.waitForDocumentTitles(
          (t) => t.length > 0,
          "a document window titled by our own JavaScript",
        );
        assert.ok(
          titles.some((t) => normalizeTitle(t) === "Untitled - Monoleaf"),
          `expected an "Untitled — Monoleaf" window, got ${JSON.stringify(titles)}`,
        );
      } finally {
        await app.stop();
      }
    });

    it("opens a file given on the command line", async () => {
      // Covers the file-association path: the backend captures the launch
      // argument before any window exists and the frontend drains it on startup.
      const doc = await tempDocument("launch-arg.md", "# Launched\n\nBody.\n");
      const app = await launch({ args: [doc] });
      try {
        const titles = await app.waitForDocumentTitles(
          (t) => t.some((x) => x.startsWith(basename(doc))),
          `a window titled after ${basename(doc)}`,
        );
        assert.ok(
          titles.map(normalizeTitle).includes(`${basename(doc)} - Monoleaf`),
          `expected the launched file's window, got ${JSON.stringify(titles)}`,
        );
      } finally {
        await app.stop();
      }
    });

    it("gives a second launch its own window in the same process", async () => {
      // The path that broke silently: a second launch is forwarded by the
      // single-instance plugin, which spawns a window and queues a payload the new
      // window drains on startup. If that hand-off fails the window opens blank —
      // it still exists, so only its *title* reveals the difference.
      const doc = await tempDocument("second-instance.md", "# Second\n");
      const app = await launch();
      try {
        await app.waitForDocumentTitles(
          (t) => t.map(normalizeTitle).includes("Untitled - Monoleaf"),
          "the first window",
        );

        const { spawn } = await import("node:child_process");
        spawn(binaryPath(), [doc], {
          stdio: "ignore",
          detached: false,
        }).unref();

        const titles = await app.waitForDocumentTitles(
          (t) => t.some((x) => x.startsWith(basename(doc))),
          `a second window titled after ${basename(doc)}`,
        );

        const normalized = titles.map(normalizeTitle);
        assert.ok(
          normalized.includes(`${basename(doc)} - Monoleaf`),
          `the spawned window did not load its file (blank window?), got ${JSON.stringify(titles)}`,
        );
        assert.ok(
          normalized.includes("Untitled - Monoleaf"),
          `the original window should still be open, got ${JSON.stringify(titles)}`,
        );

        // Single instance: the forwarded launch must not leave a second process.
        const pids = await runningPids();
        assert.equal(
          pids.length,
          1,
          `expected one process, found ${pids.length}: ${pids.join(", ")}`,
        );
      } finally {
        await app.stop();
      }
    });
  },
);
