/**
 * Harness for driving the real Monoleaf binary.
 *
 * ## Why these tests exist
 *
 * The unit suites cover logic; nothing covered the app as a program. Every
 * integration failure this project has actually had was invisible to them:
 *
 * - a release binary that loaded `localhost:1420` instead of its embedded
 *   frontend, so the window showed a connection error
 * - a Paged.js error banner that appeared only in the production bundle,
 *   because a filename filter matched the dev module and not the built one
 * - a spawned window that never drained its startup payload, so opening a file
 *   into a new window left it blank
 *
 * All three are observable from outside the process, which is why this harness
 * needs no WebDriver. That was a deliberate choice: `tauri-driver` would add an
 * `msedgedriver` pinned to the exact installed Edge build (re-downloaded on
 * every Edge update) plus a large client dependency, and would still not run in
 * this repo's CI. It buys UI clicking, which none of the failures above needed.
 * If UI-level tests are wanted later — exercising the Import menu or the
 * settings toggles — that is the point to reach for WebDriver.
 *
 * ## Why a fresh WebView2 profile per run
 *
 * Startup is not a pure function of the command line. It reads `localStorage`
 * for crash-recovery drafts and the reopen-last-file preference, and either can
 * open a modal before the requested document loads. Left alone, results would
 * depend on however the developer last used the app. `WEBVIEW2_USER_DATA_FOLDER`
 * points WebView2 at a throwaway directory, so every run starts with empty
 * storage and no prompts.
 *
 * ## Why the tests assert on window titles
 *
 * `refreshTitle()` in `src/main.ts` sets the title through Tauri's `setTitle`,
 * so a title of `"<name> — Monoleaf"` proves our own JavaScript loaded and ran.
 * A binary that failed to load its frontend keeps the title from the window
 * builder and never reaches that call — which is exactly how the
 * `localhost:1420` regression would show up here.
 */

import { spawn, execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * Whether this platform can run the suite at all.
 *
 * The harness inspects a running application from outside: it enumerates
 * top-level windows through PowerShell and finds the process by the name Windows
 * gives it. Both are Windows-specific, and deliberately so — the alternative was
 * a WebDriver stack pinned to an exact Edge build. On any other platform the
 * tests skip rather than fail, so `npm run test:e2e` stays green for a
 * contributor on Linux or macOS instead of reporting a problem they cannot fix.
 *
 * The unit suites (`npm test`, `cargo test`) are cross-platform and cover the
 * logic; what is skipped here is only the "does the built application actually
 * start" class of check.
 */
export const CAN_RUN_E2E = process.platform === "win32";

export const SKIP_REASON =
  `end-to-end tests require Windows (this is ${process.platform}): ` +
  `they enumerate windows via PowerShell and launch the built .exe`;

// Named per platform so the "not built yet" message below is never misleading
// on a machine where the binary would not carry .exe anyway.
const BINARY_NAME = process.platform === "win32" ? "monoleaf.exe" : "monoleaf";

const RELEASE_BINARY = join(
  process.cwd(),
  "src-tauri",
  "target",
  "release",
  BINARY_NAME,
);

/**
 * Path to the binary under test.
 *
 * Deliberately the *release* build: the bugs listed above only exist there,
 * because they involve the embedded frontend and the production bundle. Testing
 * the debug build would miss the entire class.
 */
export function binaryPath() {
  if (!existsSync(RELEASE_BINARY)) {
    throw new Error(
      `Release binary not found at ${RELEASE_BINARY}\n` +
        `Build it first:  npm run tauri build`,
    );
  }
  return RELEASE_BINARY;
}

/** Every visible window title belonging to `pid`, via EnumWindows. */
export async function windowTitles(pid) {
  // Node cannot enumerate windows, so this shells out. One PowerShell call per
  // query is slow (~1s) but there are only a handful of queries per test.
  const script = `
$ErrorActionPreference='Stop'
# Without this, PowerShell writes stdout in the console codepage and the em dash
# in "Untitled — Monoleaf" arrives as an ASCII hyphen. The titles would still
# look plausible, which is the dangerous part: matching silently fails.
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type @'
using System;using System.Text;using System.Collections.Generic;using System.Runtime.InteropServices;
public class MlWin {
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  public static List<string> Titles(uint want) {
    var o = new List<string>();
    EnumWindows((h,l) => {
      uint pid; GetWindowThreadProcessId(h, out pid);
      if (pid == want && IsWindowVisible(h)) {
        int n = GetWindowTextLength(h);
        if (n > 0) { var sb = new StringBuilder(n+1); GetWindowText(h, sb, sb.Capacity); o.Add(sb.ToString()); }
      }
      return true;
    }, IntPtr.Zero);
    return o;
  }
}
'@
[MlWin]::Titles(${pid}) | ForEach-Object { $_ }`;
  const { stdout } = await run(
    "powershell",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { windowsHide: true, maxBuffer: 1 << 20 },
  );
  return stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

/** Process ids of every running instance of the app. */
export async function runningPids() {
  try {
    const { stdout } = await run(
      "powershell",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Get-Process monoleaf -ErrorAction SilentlyContinue | ForEach-Object { $_.Id }",
      ],
      { windowsHide: true },
    );
    return stdout
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .map(Number);
  } catch {
    return [];
  }
}

export async function killAll() {
  await run(
    "powershell",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "Get-Process monoleaf -ErrorAction SilentlyContinue | Stop-Process -Force",
    ],
    { windowsHide: true },
  ).catch(() => {});
}

/**
 * Refuse to run while another instance is up.
 *
 * The single-instance plugin means a second launch forwards its arguments to
 * the running process and exits. A stray dev build or an app the developer left
 * open would therefore swallow the test's arguments and the assertions would
 * describe someone else's window.
 */
export async function assertNoInstanceRunning() {
  const pids = await runningPids();
  if (pids.length > 0) {
    throw new Error(
      `monoleaf.exe is already running (pid ${pids.join(", ")}).\n` +
        `The single-instance plugin would forward this test's arguments to it. ` +
        `Close it (or stop \`npm run tauri dev\`) and retry.`,
    );
  }
}

/** Poll `fn` until it returns a truthy value, or fail after `timeout` ms. */
export async function waitFor(fn, { timeout = 25_000, interval = 500, what }) {
  const deadline = Date.now() + timeout;
  let last;
  for (;;) {
    last = await fn();
    if (last) return last;
    if (Date.now() > deadline) {
      throw new Error(
        `timed out after ${timeout}ms waiting for ${what}\n` +
          `last value: ${JSON.stringify(last)}`,
      );
    }
    await new Promise((r) => setTimeout(r, interval));
  }
}

/**
 * A launched app with an isolated profile. Always `await session.stop()`.
 */
export async function launch({ args = [] } = {}) {
  await assertNoInstanceRunning();
  const profile = await mkdtemp(join(tmpdir(), "ml-e2e-"));
  const child = spawn(binaryPath(), args, {
    env: { ...process.env, WEBVIEW2_USER_DATA_FOLDER: profile },
    detached: false,
    stdio: "ignore",
    windowsHide: false,
  });

  const pid = await waitFor(
    async () => {
      const pids = await runningPids();
      return pids.length > 0 ? pids[0] : null;
    },
    { what: `${BINARY_NAME} to appear in the process list` },
  );

  return {
    pid,
    child,
    profile,
    /** Titles of this app's document windows, excluding plumbing windows. */
    async documentTitles() {
      const titles = await windowTitles(pid);
      // The single-instance plugin owns a hidden helper window whose title is
      // the app identifier; it is not a document.
      return titles.filter((t) => /[—–-] Monoleaf$/.test(t));
    },
    async waitForDocumentTitles(predicate, what) {
      return waitFor(
        async () => {
          const titles = await this.documentTitles();
          return predicate(titles) ? titles : null;
        },
        { what },
      );
    },
    async stop() {
      await killAll();
      await rm(profile, { recursive: true, force: true }).catch(() => {});
    },
  };
}

/**
 * Canonical form for comparing window titles.
 *
 * Monoleaf titles a window "<name> — Monoleaf" with an em dash. Reading titles
 * back crosses a PowerShell pipe, and while the harness forces UTF-8 there, the
 * exact dash character is not what any of these tests are about. Normalising
 * every dash keeps a locale or console-encoding quirk from failing a test for
 * the wrong reason, while error messages still print the raw title.
 */
export function normalizeTitle(title) {
  return title.replace(/[—–-]/g, "-");
}

/** Write a temp markdown file and return its path. */
export async function tempDocument(name, body) {
  const dir = await mkdtemp(join(tmpdir(), "ml-e2e-doc-"));
  const path = join(dir, name);
  await writeFile(path, body, "utf8");
  return path;
}
