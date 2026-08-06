import { EditorView, keymap } from "@codemirror/view";
import { editorSetup, rawViewExtensions } from "./setup";
import { Compartment, Prec, StateCommand } from "@codemirror/state";
import { Channel, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open, save } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
import { MenuItem, showContextMenu } from "./contextmenu";
import {
  htmlToMarkdown,
  htmlHasRichFormatting,
  looksLikeMarkdown,
  tsvToMarkdownTable,
} from "./paste";
import { insertTable, insertTableSized, tableMenuItems } from "./tablewidget";
import { countWords } from "./wordcount";
import { createDocumentState, serializeDocument } from "./document";
import { applyMeta, parseMeta, type DocMeta, type MetaFormat } from "./meta";
import { PortabilityMode, portabilityExtensions } from "./portability";
import { livePreviewExtensions } from "./livepreview";
import {
  applyLink,
  changeCase,
  type CaseMode,
  clearFormatting,
  collectHeadings,
  deleteHardBreakBackward,
  hardBreakEnter,
  imageMarkup,
  insertAdmonition,
  insertMath,
  insertPageBreak,
  insertTableOfContents,
  linkAt,
  paragraphEnter,
  setAlignment,
  setHeading,
  toggleBold,
  toggleBulletList,
  toggleHighlight,
  toggleInlineCode,
  toggleItalic,
  toggleOrderedList,
  toggleStrikethrough,
  toggleSubscript,
  toggleSuperscript,
  toggleQuote,
  toggleTaskList,
  toggleUnderline,
} from "./commands";
import { footnoteDefPos, footnoteRefPos } from "./footnotes";
import { ADMONITIONS, ADMONITION_KINDS } from "./admonitions";
import {
  addReplySpec,
  commentsExtension,
  createCommentSpec,
  parseComments,
  setResolvedSpec,
} from "./comments";
import {
  acceptAllChanges,
  acceptAtCursor,
  criticExtension,
  nextChange,
  parseCritic,
  regionAt,
  rejectAllChanges,
  rejectAtCursor,
  trackingExtension,
} from "./critic";
import { renderSidebar } from "./sidebar";
import { renderOutline } from "./outline";
import { openSearchPanel } from "@codemirror/search";
import {
  buildPrintCss,
  MARGIN_RE,
  marginToPx,
  parsePageConfig,
  PRINT_FONT_PX,
  renderDocumentHtml,
  wrapStandaloneHtml,
  setPageConfigSpec,
} from "./export";
import { sanitizeDocumentHtml } from "./sanitize";
import {
  collectRecoveryDrafts,
  discardDraft,
  draftName,
  recoveryKey,
  writeDraft,
} from "./recovery";
import {
  loadRemoteImagePreference,
  setRemoteImagesAllowed,
  storeRemoteImagePreference,
} from "./remoteimages";
import { Previewer } from "pagedjs";
import {
  extractPageBreaks,
  pageAt,
  pageBreaksField,
  PageBreak,
  setPageBreaks,
} from "./pagination";
import { getVersion } from "@tauri-apps/api/app";
import { clearSkippedVersion, isVersionSkipped, skipVersion } from "./updates";
import thirdPartyLicenses from "../THIRD_PARTY_LICENSES.md?raw";

// Uncaught errors must be visible, not lost in an invisible console.
const errorBar = document.getElementById("error-bar")!;
const errorText = document.getElementById("error-text")!;
document.getElementById("btn-dismiss-error")!.addEventListener("click", () => {
  errorBar.hidden = true;
});
function reportError(message: string) {
  errorText.textContent = message;
  errorBar.hidden = false;
}
// Paged.js internals can hiccup during best-effort measurement: while
// fragmenting content across a page it walks the DOM and dereferences a node
// that's momentarily null — a trailing layout callback touches the measure
// container we already cleared (null nextSibling), or its split/rebuild code
// reads getAttribute/parentNode off a null node. These are Paged.js bugs, not
// ours (our own code guards every such access with optional chaining), the
// document is never affected, and they must not red-flag the app. In dev the
// stack names the pagedjs module; the production bundle is one file, so we also
// match the null-property-read signature on the DOM-walk fields Paged.js uses.
const PAGEDJS_NULL_READ =
  /reading '?(nextSibling|previousSibling|getAttribute|parentNode|firstChild|appendChild|childNodes|dataset)'?/;
function isPagedjsInternalError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  const stack = err instanceof Error ? (err.stack ?? "") : "";
  return stack.includes("pagedjs") || PAGEDJS_NULL_READ.test(msg);
}
window.addEventListener("error", (e) => {
  if (e.filename?.includes("pagedjs") || PAGEDJS_NULL_READ.test(e.message)) {
    console.error("[monoleaf] pagedjs internal error:", e.message);
    return;
  }
  reportError(`${e.message} (${e.filename?.split("/").pop()}:${e.lineno})`);
});
window.addEventListener("unhandledrejection", (e) => {
  reportError(`Unhandled: ${String(e.reason)}`);
});

// Open and save targets. PDF appears in neither: it is not a document Monoleaf
// opens or writes, it is a format converted into one — see IMPORT_FILTERS and
// File ▸ Import from PDF. (The backend's write_file refuses the extension too.)
const MARKDOWN_FILTERS = [
  { name: "Markdown", extensions: ["md", "markdown"] },
  { name: "All files", extensions: ["*"] },
];

// Import targets: formats converted to Markdown rather than opened as-is.
const IMPORT_FILTERS = [{ name: "PDF", extensions: ["pdf"] }];

let currentPath: string | null = null;
let dirty = false;

// File name to offer on first save for a document that has no path yet, set
// when a PDF is imported (from its title metadata or its file name). Purely a
// suggestion: it names the window and seeds the Save dialog, and is cleared as
// soon as the document has a real path.
let suggestedName: string | null = null;

// This window's identity. The config-defined window is "main"; File ▸ Open /
// New, opening multiple files, and file-association launches spawn additional
// "win-N" windows, each an independent document (see open_document_window in
// the Rust backend).
const thisWindow = getCurrentWindow();
const windowLabel = thisWindow.label;
const isMainWindow = windowLabel === "main";

const fileNameEl = document.getElementById("file-name")!;

function fileLabel(): string {
  if (currentPath === null) return suggestedName ?? "Untitled";
  const parts = currentPath.split(/[\\/]/);
  return parts[parts.length - 1] || currentPath;
}

function refreshTitle() {
  const label = `${dirty ? "● " : ""}${fileLabel()}`;
  fileNameEl.textContent = label;
  fileNameEl.title = currentPath ?? "Unsaved document";
  // The em dash here is deliberate, and it is the one em dash in the UI that
  // stays. "<file> — Monoleaf" is the conventional window-title form, and
  // e2e/harness.mjs normalises every dash before comparing titles precisely
  // because of this string — see the note about console encoding there. Changing
  // it rewrites every window title and taskbar entry, so it is a product
  // decision, not a punctuation fix.
  getCurrentWindow()
    .setTitle(`${label} — Monoleaf`)
    .catch(() => {});
}

function setDirty(value: boolean) {
  if (dirty === value) return;
  dirty = value;
  refreshTitle();
}

// Custom title bar: native decorations are off, so the min/maximize/close
// buttons drive the window directly. The maximize glyph swaps to a restore
// glyph whenever the window is maximized.
function setupWindowControls() {
  const win = getCurrentWindow();
  const maxBtn = document.getElementById("win-max");
  document
    .getElementById("win-min")
    ?.addEventListener("click", () => void win.minimize());
  maxBtn?.addEventListener("click", () => void win.toggleMaximize());
  document
    .getElementById("win-close")
    ?.addEventListener("click", () => void win.close());

  const syncMaxState = async () => {
    try {
      const maximized = await win.isMaximized();
      maxBtn?.classList.toggle("maximized", maximized);
      if (maxBtn) maxBtn.title = maximized ? "Restore" : "Maximize";
    } catch {
      /* ignore — window API unavailable */
    }
  };
  void syncMaxState();
  win.onResized(() => void syncMaxState()).catch(() => {});
}

// Closing a window with unsaved changes (custom close button, Alt+F4, or OS
// close) asks Save / Don't save / Cancel first, Word-style. A clean window
// closes immediately. `win.close()` routes through this; `win.destroy()` (used
// once the user commits) force-closes without re-triggering it.
const closeDialog = document.getElementById(
  "close-dialog",
) as HTMLDialogElement;
const closeMessage = document.getElementById("close-message")!;

// In-app confirm/alert built on the styled ml-dialog, so every prompt matches
// the app's look instead of the plain native OS dialog. (File open/save stay
// native — those are the OS file browser.)
const confirmDialog = document.getElementById(
  "confirm-dialog",
) as HTMLDialogElement;
const confirmTitle = document.getElementById("confirm-title")!;
const confirmMessage = document.getElementById("confirm-message")!;
const confirmOk = document.getElementById("confirm-ok") as HTMLButtonElement;
const confirmCancel = document.getElementById(
  "confirm-cancel",
) as HTMLButtonElement;

function uiConfirm(
  msg: string,
  opts: { title?: string; okLabel?: string; cancelLabel?: string } = {},
): Promise<boolean> {
  return new Promise((resolve) => {
    confirmTitle.textContent = opts.title ?? "Monoleaf";
    confirmMessage.textContent = msg;
    confirmOk.textContent = opts.okLabel ?? "OK";
    confirmCancel.hidden = false;
    confirmCancel.textContent = opts.cancelLabel ?? "Cancel";
    confirmDialog.returnValue = "cancel";
    confirmDialog.addEventListener(
      "close",
      () => resolve(confirmDialog.returnValue === "ok"),
      { once: true },
    );
    confirmDialog.showModal();
    confirmOk.focus();
  });
}

function uiAlert(msg: string, opts: { title?: string } = {}): Promise<void> {
  return new Promise((resolve) => {
    confirmTitle.textContent = opts.title ?? "Monoleaf";
    confirmMessage.textContent = msg;
    confirmOk.textContent = "OK";
    confirmCancel.hidden = true; // alert: single acknowledge button
    confirmDialog.returnValue = "ok";
    confirmDialog.addEventListener("close", () => resolve(), { once: true });
    confirmDialog.showModal();
    confirmOk.focus();
  });
}

function promptClose(): Promise<"save" | "discard" | "cancel"> {
  return new Promise((resolve) => {
    closeMessage.textContent = `${fileLabel()} has unsaved changes. Save before closing?`;
    closeDialog.returnValue = "cancel";
    closeDialog.addEventListener(
      "close",
      () => {
        const v = closeDialog.returnValue;
        resolve(v === "save" || v === "discard" ? v : "cancel");
      },
      { once: true },
    );
    closeDialog.showModal();
  });
}

/**
 * Rust's name for "write your unsaved work to localStorage now".
 *
 * COUPLED: `FLUSH_RECOVERY_EVENT` in src-tauri/src/lib.rs. A rename on either
 * side does not break anything loudly — it makes every install postpone itself,
 * because Rust waits for an acknowledgement that can no longer arrive.
 */
const FLUSH_RECOVERY_EVENT = "flush-recovery";

/**
 * Answer Rust's pre-install request that this window secure its unsaved work.
 *
 * Rust installs an update only if *every* window acknowledges, so the one rule
 * here is that every path answers. A clean window that stayed silent would abort
 * every update the user ever tried to install.
 *
 * The snapshot is written synchronously, not scheduled: an acknowledgement has to
 * mean the bytes are in storage. Rescheduling `scheduleAutosaveRecovery` would
 * acknowledge an intention — and the process is about to be replaced by the
 * installer, which is exactly the window in which an intention is worth nothing.
 */
function setupRecoveryFlush() {
  void listen<number>(FLUSH_RECOVERY_EVENT, (event) => {
    // The debounced snapshot is now redundant: this writes the same thing, and
    // sooner. Cancelling it also stops it rewriting the key after the install
    // has already read it.
    window.clearTimeout(autosaveTimer);

    // The user answered "Don't save" to this install's prompt in this window, so
    // there is deliberately nothing to write. Acknowledged all the same, and Rust
    // needs no notion of this: a suppressed window is indistinguishable from a
    // clean one, and clean windows already acknowledge without writing.
    if (flushSuppressedForInstall) {
      void invoke("ack_recovery_flush", { round: event.payload }).catch(
        () => {},
      );
      return;
    }

    // Wider than `dirty` alone as defence in depth, not because a gap is known:
    // every current path that loads content with no file behind it — an imported
    // PDF, a recovered draft — sets dirty on the next line. But `loadIntoEditor`
    // assigns `dirty = false` itself, so a future caller that forgets to flip it
    // would silently make this window's content invisible to an install, and
    // "content with nowhere else to be" is the condition that actually matters.
    const unsaved =
      dirty || (currentPath === null && view.state.doc.length > 0);

    if (unsaved) {
      const stored = writeDraft(
        RECOVERY_KEY,
        currentPath,
        serializeDocument(view.state),
      );
      // Storage refused it — over quota. Deliberately NOT acknowledged: a
      // refused write means this document exists nowhere but in this window, and
      // the install is about to end the process holding it. Withholding the
      // acknowledgement costs a postponed update, which the user can retry after
      // saving; acknowledging would cost the document. Rust names this window in
      // the postponement message, so the cause is findable rather than mysterious.
      if (!stored) return;
    }

    void invoke("ack_recovery_flush", { round: event.payload }).catch(() => {});
  }).catch(() => {
    // Registration failed, so this window can never acknowledge and every
    // install will postpone. Nothing here can fix that, but a silent catch would
    // hide it from whoever has to work out why updates never install.
    console.error(
      `Monoleaf: could not listen for ${FLUSH_RECOVERY_EVENT}; updates will not install.`,
    );
  });
}

function setupCloseGuard() {
  let handling = false;
  thisWindow
    .onCloseRequested(async (event) => {
      if (!dirty) return; // nothing unsaved — let it close
      event.preventDefault();
      if (handling) return; // a prompt is already open
      handling = true;
      try {
        const choice = await promptClose();
        if (choice === "cancel") return; // stay open
        // Save failed or the Save-As dialog was cancelled: keep the window.
        if (choice === "save" && !(await saveFile())) return;
        // Discarded: forget this window's recovery snapshot so it isn't
        // offered on the next launch.
        if (choice === "discard") discardDraft(RECOVERY_KEY);
        await thisWindow.destroy();
      } finally {
        handling = false;
      }
    })
    .catch(() => {});
}

const MODE_STORAGE_KEY = "monoleaf.portability-mode";
const FLAGS_STORAGE_KEY = "monoleaf.show-portability-flags";
const VIEW_STORAGE_KEY = "monoleaf.view-mode";

// Autosave / crash recovery. RECOVERY_KEY holds a debounced snapshot of
// unsaved work (cleared on save); on launch a lingering snapshot means the
// last session ended with unsaved changes (crash/forced close) and is offered
// for recovery. AUTOSAVE (opt-in) additionally writes straight to the open
// file after edits settle.
// Each window gets its OWN recovery key so two open windows never clobber
// each other's autosave snapshot; on launch the main window sweeps every key
// under this prefix to recover drafts left by a crashed/force-closed session.
const RECOVERY_KEY = recoveryKey(windowLabel);
// Remote images are opt-in: rendering a document fetches them immediately, so a
// document from an untrusted source would otherwise report when it was opened.
// The module owns the storage key and the default (off).
let remoteImagesEnabled = loadRemoteImagePreference();

const AUTOSAVE_KEY = "monoleaf.autosave";
let autosaveEnabled = localStorage.getItem(AUTOSAVE_KEY) === "true";

// Opening a file on a network share (\\server\share) makes Windows authenticate
// to that server and hand it a hash of the user's credentials, so the backend
// refuses those paths unless this is on. Plenty of people keep documents on a
// file server, so it has to be switchable — the default is what stops a path
// Monoleaf did not choose from reaching a host it did not choose.
//
// Rust holds the authoritative flag; this pushes the stored preference to it on
// startup and on every toggle, the same shape as the remote-image setting.
const NETWORK_PATHS_KEY = "monoleaf.allow-network-paths";
let networkPathsEnabled = localStorage.getItem(NETWORK_PATHS_KEY) === "true";
function pushNetworkPathSetting(): void {
  void invoke("set_allow_network_paths", { allow: networkPathsEnabled }).catch(
    () => {},
  );
}
pushNetworkPathSetting();

// Reopen the last file on launch (on by default). LAST_FILE_KEY remembers the
// path of the most recently opened/saved document; on startup — when no crash
// recovery is pending — the user is asked whether to reopen it, otherwise the
// window starts blank.
const LAST_FILE_KEY = "monoleaf.last-file";
const REOPEN_KEY = "monoleaf.reopen-last";
let reopenLastEnabled = localStorage.getItem(REOPEN_KEY) !== "false";

// Appearance: a manual light/dark toggle. Defaults to the OS preference until
// the user picks one, then that choice is remembered. Forcing color-scheme on
// the root makes every light-dark() value resolve to the chosen theme; the
// theme-dark class drives the logo-variant swap (see styles.css).
const THEME_KEY = "monoleaf.theme";
let darkMode =
  localStorage.getItem(THEME_KEY) === "dark" ||
  (localStorage.getItem(THEME_KEY) === null &&
    window.matchMedia("(prefers-color-scheme: dark)").matches);
applyTheme();

function loadMode(): PortabilityMode {
  // Enhanced is the first-launch default; strict only when chosen.
  return localStorage.getItem(MODE_STORAGE_KEY) === "strict"
    ? "strict"
    : "enhanced";
}

function loadShowFlags(): boolean {
  return localStorage.getItem(FLAGS_STORAGE_KEY) === "true";
}

const TRACKING_STORAGE_KEY = "monoleaf.tracking";

let mode: PortabilityMode = loadMode();
let showFlags = loadShowFlags();
// The user works in the pretty view by default; raw view is the opt-out.
let liveView = localStorage.getItem(VIEW_STORAGE_KEY) !== "raw";
let tracking = localStorage.getItem(TRACKING_STORAGE_KEY) === "true";
const modeCompartment = new Compartment();
const liveCompartment = new Compartment();
const trackingCompartment = new Compartment();
const modeButton = document.getElementById("btn-mode")!;
const flagsButton = document.getElementById("btn-flags") as HTMLButtonElement;
const liveButton = document.getElementById("btn-live")!;

const settingsButton = document.getElementById("btn-settings")!;
const settingsMenu = document.getElementById("settings-menu")!;

function refreshModeButtons() {
  liveButton.setAttribute("aria-pressed", String(liveView));
  modeButton.setAttribute("aria-pressed", String(mode === "enhanced"));
  document
    .getElementById("btn-pagination")!
    .setAttribute("aria-pressed", String(paginationEnabled));
  // Flag visibility only means something when enhanced parsing is on.
  flagsButton.disabled = mode !== "enhanced";
  flagsButton.setAttribute("aria-pressed", String(showFlags));
  document
    .getElementById("btn-theme")!
    .setAttribute("aria-pressed", String(darkMode));
  document
    .getElementById("btn-autosave")!
    .setAttribute("aria-pressed", String(autosaveEnabled));
  document
    .getElementById("btn-remote-images")!
    .setAttribute("aria-pressed", String(remoteImagesEnabled));
  document
    .getElementById("btn-network-paths")!
    .setAttribute("aria-pressed", String(networkPathsEnabled));
  document
    .getElementById("btn-reopen")!
    .setAttribute("aria-pressed", String(reopenLastEnabled));
  // Off while consent is unset: nothing is being checked until it is "yes".
  document
    .getElementById("btn-updates")!
    .setAttribute("aria-pressed", String(updateConsent() === "yes"));
  document.getElementById("menu-name")!.textContent =
    localStorage.getItem(AUTHOR_KEY)?.trim() ?? "";
}

function applyTheme() {
  const root = document.documentElement;
  root.style.colorScheme = darkMode ? "dark" : "light";
  root.classList.toggle("theme-dark", darkMode);
}

function toggleTheme() {
  darkMode = !darkMode;
  localStorage.setItem(THEME_KEY, darkMode ? "dark" : "light");
  applyTheme();
  refreshModeButtons();
  view.focus();
}

function toggleSettingsMenu(show = settingsMenu.hidden) {
  settingsMenu.hidden = !show;
  settingsButton.setAttribute("aria-expanded", String(show));
  if (show) {
    // Drop it just below the toolbar (its height varies with the layout).
    const bar = document.getElementById("toolbar")!.getBoundingClientRect();
    settingsMenu.style.top = `${bar.bottom + 4}px`;
    refreshModeButtons();
  }
}

settingsButton.addEventListener("click", (e) => {
  e.stopPropagation();
  toggleSettingsMenu();
});

// Close the menu on any click outside it.
document.addEventListener("mousedown", (e) => {
  if (settingsMenu.hidden) return;
  const target = e.target as HTMLElement;
  if (target.closest("#settings-menu, #btn-settings") === null) {
    toggleSettingsMenu(false);
  }
});

// --- File menu (Word-style) ---
const fileButton = document.getElementById("btn-file")!;
const fileMenu = document.getElementById("file-menu")!;

function toggleFileMenu(show = fileMenu.hidden) {
  fileMenu.hidden = !show;
  fileButton.setAttribute("aria-expanded", String(show));
  if (show) {
    const rect = fileButton.getBoundingClientRect();
    fileMenu.style.top = `${rect.bottom + 4}px`;
    fileMenu.style.left = `${rect.left}px`;
    fileMenu.style.right = "auto";
  }
}

fileButton.addEventListener("click", (e) => {
  e.stopPropagation();
  toggleFileMenu();
});

// --- Ribbon tabs (Edit / Insert / Review) ---
type RibbonTab = "edit" | "review";
const RIBBON_KEY = "monoleaf.ribbon-tab";
const ribbonTabs: Record<RibbonTab, HTMLElement> = {
  edit: document.getElementById("tab-edit")!,
  review: document.getElementById("tab-review")!,
};
const ribbonPanels: Record<RibbonTab, HTMLElement> = {
  edit: document.getElementById("panel-edit")!,
  review: document.getElementById("panel-review")!,
};

function selectRibbonTab(tab: RibbonTab) {
  for (const key of Object.keys(ribbonTabs) as RibbonTab[]) {
    ribbonPanels[key].hidden = key !== tab;
    ribbonTabs[key].setAttribute("aria-selected", String(key === tab));
  }
  localStorage.setItem(RIBBON_KEY, tab);
}

for (const key of Object.keys(ribbonTabs) as RibbonTab[]) {
  ribbonTabs[key].addEventListener("click", () => selectRibbonTab(key));
}
selectRibbonTab(
  localStorage.getItem(RIBBON_KEY) === "review" ? "review" : "edit",
);
// Close after choosing an item (its own id-bound handler runs first on bubble).
fileMenu.addEventListener("click", () => toggleFileMenu(false));
document.addEventListener("mousedown", (e) => {
  if (fileMenu.hidden) return;
  const target = e.target as HTMLElement;
  if (target.closest("#file-menu, #btn-file") === null) toggleFileMenu(false);
});

// --- Toolbar overflow (Word-style "more tools" chevron) ------------------
// When the window is too narrow for every tool, trailing groups are peeled
// into a popover reachable via a chevron, and moved back to their own panel
// when space returns. Groups are relocated as LIVE nodes (never cloned), so
// every button keeps the exact click handler wired to it by id.
const overflowBtn = document.getElementById(
  "btn-overflow",
) as HTMLButtonElement;
const overflowMenu = document.getElementById("overflow-menu")!;
const toolbarPanelsRow = document.querySelector(
  ".toolbar-panels",
) as HTMLElement;

function visibleRibbonPanel(): HTMLElement | null {
  return toolbarPanelsRow.querySelector(".ribbon-panel:not([hidden])");
}

let reflowingToolbar = false;
function reflowToolbarOverflow() {
  if (reflowingToolbar) return;
  reflowingToolbar = true;
  try {
    // 1. Send every parked item home (preserving order) so we measure the
    //    natural layout, then reset the chevron/popover.
    while (overflowMenu.firstElementChild) {
      const el = overflowMenu.firstElementChild as HTMLElement;
      const owner =
        document.getElementById(el.dataset.ownerPanel ?? "") ??
        visibleRibbonPanel();
      if (!owner) {
        el.remove();
        continue;
      }
      owner.appendChild(el);
    }
    overflowMenu.hidden = true;
    overflowBtn.hidden = true;
    overflowBtn.setAttribute("aria-expanded", "false");

    const panel = visibleRibbonPanel();
    if (!panel) return;
    // Everything fits — leave the chevron hidden.
    if (panel.scrollWidth <= panel.clientWidth + 1) return;

    // 2. Reserve the chevron's width, then peel trailing groups (with their
    //    leading separator) into the popover until what remains fits.
    overflowBtn.hidden = false;
    let guard = 0;
    while (panel.scrollWidth > panel.clientWidth + 1 && guard++ < 40) {
      const groups = panel.querySelectorAll<HTMLElement>(
        ":scope > .toolbar-group",
      );
      if (groups.length <= 1) break; // always keep at least one group visible
      const group = groups[groups.length - 1];
      group.dataset.ownerPanel = panel.id;
      overflowMenu.insertBefore(group, overflowMenu.firstChild);
      const sep = panel.lastElementChild;
      if (sep && sep.classList.contains("separator")) {
        (sep as HTMLElement).dataset.ownerPanel = panel.id;
        overflowMenu.insertBefore(sep, overflowMenu.firstChild);
      }
    }
    overflowBtn.hidden = overflowMenu.childElementCount === 0;
  } finally {
    reflowingToolbar = false;
  }
}

function toggleOverflowMenu(show = overflowMenu.hidden) {
  overflowMenu.hidden = !show;
  overflowBtn.setAttribute("aria-expanded", String(show));
  if (show) {
    const r = overflowBtn.getBoundingClientRect();
    overflowMenu.style.top = `${r.bottom + 4}px`;
    overflowMenu.style.left = "auto";
    // Right-align to the chevron, clamped into the viewport.
    overflowMenu.style.right = `${Math.max(8, window.innerWidth - r.right)}px`;
  }
}

overflowBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  toggleOverflowMenu();
});
document.addEventListener("mousedown", (e) => {
  if (overflowMenu.hidden) return;
  const target = e.target as HTMLElement;
  if (target.closest("#overflow-menu, #btn-overflow") === null) {
    toggleOverflowMenu(false);
  }
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !overflowMenu.hidden) toggleOverflowMenu(false);
});

// Recompute when the toolbar's available width changes (window resize) or the
// ribbon tab switches. The observer MUST be kept in a variable — an
// unreferenced ResizeObserver can be garbage-collected and silently stop
// firing. A window resize listener is a belt-and-suspenders fallback, and a
// deferred first pass handles the initial layout.
const toolbarResizeObserver = new ResizeObserver(() => reflowToolbarOverflow());
toolbarResizeObserver.observe(document.getElementById("toolbar")!);
window.addEventListener("resize", () => reflowToolbarOverflow());
requestAnimationFrame(() => reflowToolbarOverflow());
for (const key of Object.keys(ribbonTabs) as RibbonTab[]) {
  ribbonTabs[key].addEventListener("click", () => {
    toggleOverflowMenu(false);
    reflowToolbarOverflow();
  });
}

// A function, not a constant: fresh states (per file load) must pick up the
// mode active at that moment, not the mode at startup.
// --- link dialog ---------------------------------------------------------

const linkDialog = document.getElementById("link-dialog") as HTMLDialogElement;
const linkInput = document.getElementById("link-url") as HTMLInputElement;

function promptForUrl(initial: string): Promise<string | null> {
  return new Promise((resolve) => {
    linkInput.value = initial;
    linkDialog.returnValue = "cancel";
    linkDialog.addEventListener(
      "close",
      () => {
        const url = linkInput.value.trim();
        resolve(linkDialog.returnValue === "ok" && url !== "" ? url : null);
      },
      { once: true },
    );
    linkDialog.showModal();
    linkInput.select();
  });
}

async function editLink() {
  const existing = linkAt(view.state);
  const initial =
    existing === null
      ? ""
      : view.state.sliceDoc(existing.urlFrom, existing.urlTo);
  const url = await promptForUrl(initial);
  if (url !== null) {
    view.dispatch(applyLink(view.state, url));
  }
  view.focus();
}

// --- document properties (metadata) ---
const metaDialog = document.getElementById("meta-dialog") as HTMLDialogElement;
const metaFields: Record<keyof DocMeta, HTMLInputElement> = {
  title: document.getElementById("meta-title") as HTMLInputElement,
  author: document.getElementById("meta-author") as HTMLInputElement,
  date: document.getElementById("meta-date") as HTMLInputElement,
  subject: document.getElementById("meta-subject") as HTMLInputElement,
  keywords: document.getElementById("meta-keywords") as HTMLInputElement,
};
const metaFrontmatter = document.getElementById(
  "meta-frontmatter",
) as HTMLInputElement;

function openMetaDialog() {
  const { meta, format } = parseMeta(view.state.doc.toString());
  metaFields.title.value = meta.title;
  metaFields.author.value =
    meta.author || (localStorage.getItem(AUTHOR_KEY)?.trim() ?? "");
  // Convenience: seed the date with today when the document has none yet.
  // Only committed if the user hits Save; they can overwrite or clear it.
  metaFields.date.value = meta.date || new Date().toLocaleDateString();
  metaFields.subject.value = meta.subject;
  metaFields.keywords.value = meta.keywords;
  metaFrontmatter.checked = format === "frontmatter";
  metaDialog.returnValue = "cancel";
  metaDialog.addEventListener(
    "close",
    () => {
      if (metaDialog.returnValue !== "ok") return;
      const next: DocMeta = {
        title: metaFields.title.value,
        author: metaFields.author.value,
        date: metaFields.date.value,
        subject: metaFields.subject.value,
        keywords: metaFields.keywords.value,
      };
      const fmt: MetaFormat = metaFrontmatter.checked
        ? "frontmatter"
        : "comment";
      const current = view.state.doc.toString();
      const updated = applyMeta(current, next, fmt);
      if (updated !== current) {
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: updated },
          userEvent: "input.meta",
        });
      }
      view.focus();
    },
    { once: true },
  );
  metaDialog.showModal();
  metaFields.title.select();
}

const imageDialog = document.getElementById(
  "image-dialog",
) as HTMLDialogElement;
const imageUrlInput = document.getElementById("image-url") as HTMLInputElement;
const imageAltInput = document.getElementById("image-alt") as HTMLInputElement;

// Insert a URL image reference (![alt](url)); any selected text prefills alt.
async function insertImage() {
  const { from, to } = view.state.selection.main;
  imageUrlInput.value = "";
  imageAltInput.value = view.state.sliceDoc(from, to);
  imageDialog.returnValue = "cancel";
  const result = await new Promise<{ url: string; alt: string } | null>(
    (resolve) => {
      imageDialog.addEventListener(
        "close",
        () => {
          const url = imageUrlInput.value.trim();
          resolve(
            imageDialog.returnValue === "ok" && url !== ""
              ? { url, alt: imageAltInput.value.trim() }
              : null,
          );
        },
        { once: true },
      );
      imageDialog.showModal();
      imageUrlInput.select();
    },
  );
  if (result !== null) {
    const md = imageMarkup(result.url, result.alt);
    const sel = view.state.selection.main;
    view.dispatch({
      changes: { from: sel.from, to: sel.to, insert: md },
      selection: { anchor: sel.from + md.length },
      userEvent: "input.image",
    });
  }
  view.focus();
}

// --- comments ---------------------------------------------------------------

const AUTHOR_KEY = "monoleaf.author";
const commentsSidebar = document.getElementById("comments-sidebar")!;
const commentsButton = document.getElementById("btn-comments")!;
const commentDialog = document.getElementById(
  "comment-dialog",
) as HTMLDialogElement;
const commentText = document.getElementById(
  "comment-text",
) as HTMLTextAreaElement;
const nameDialog = document.getElementById("name-dialog") as HTMLDialogElement;
const nameInput = document.getElementById("name-input") as HTMLInputElement;

let showComments = false;

function author(): string {
  return localStorage.getItem(AUTHOR_KEY)?.trim() || "Anonymous";
}

function promptForName(): Promise<string | null> {
  return new Promise((resolve) => {
    nameInput.value = localStorage.getItem(AUTHOR_KEY) ?? "";
    nameDialog.returnValue = "cancel";
    nameDialog.addEventListener(
      "close",
      () => {
        const name = nameInput.value.trim();
        resolve(nameDialog.returnValue === "ok" && name !== "" ? name : null);
      },
      { once: true },
    );
    nameDialog.showModal();
    nameInput.select();
  });
}

async function changeName() {
  const name = await promptForName();
  if (name !== null) {
    localStorage.setItem(AUTHOR_KEY, name);
    refreshComments();
  }
  view.focus();
}

/** Make sure a name is set; asks once (first use) and remembers. */
async function ensureAuthor(): Promise<boolean> {
  if (localStorage.getItem(AUTHOR_KEY)?.trim()) return true;
  const name = await promptForName();
  if (name === null) return false;
  localStorage.setItem(AUTHOR_KEY, name);
  return true;
}

/** Mirror the document's paper size (ml:page block) into CSS variables so
 * the live view's page card matches: A4/Letter at CSS 96dpi. */
let paperDims = { w: 794, h: 1123 }; // A4 at CSS 96dpi
let pageMarginPx = { top: 75.6, right: 75.6, bottom: 75.6, left: 75.6 }; // 20mm

// CSS custom properties would not resolve in the .cm-content sizing in this
// WebView (a literal works, a var/calc silently drops), so the page size is
// scaled by editing the actual rule's literal values through the CSSOM.
let liveContentRule: CSSStyleRule | null = null;
let editorFontRule: CSSStyleRule | null = null;

function findRule(selector: string): CSSStyleRule | null {
  for (const sheet of Array.from(document.styleSheets)) {
    let rules: CSSRuleList;
    try {
      rules = sheet.cssRules;
    } catch {
      continue; // cross-origin sheet; skip
    }
    for (const r of Array.from(rules)) {
      if (r instanceof CSSStyleRule && r.selectorText === selector) return r;
    }
  }
  return null;
}

/**
 * Scale the page card (width, height, padding, font) and the raw-view font
 * by the zoom factor, by writing literal px into the live rules. Page width,
 * height, font and padding scale together, so line and page breaks are
 * identical at every zoom — only the sheet size changes.
 */
function applyPageVars() {
  // Best-effort: must never throw, or it would abort the init sequence
  // (and applyViewClass, leaving the page card unstyled).
  try {
    const z = (Number.isFinite(zoom) ? zoom : 100) / 100;
    if (liveContentRule?.parentStyleSheet == null) {
      liveContentRule = findRule("#editor.live .cm-content");
    }
    if (liveContentRule !== null) {
      const s = liveContentRule.style;
      const m = pageMarginPx;
      // Page card mirrors the print page: same paper size, same margins,
      // same 11pt body font — so text lands at the same spot as the PDF.
      s.setProperty("width", `${Math.round(paperDims.w * z)}px`, "important");
      s.setProperty("min-height", `${Math.round(paperDims.h * z)}px`);
      s.setProperty(
        "padding",
        `${m.top * z}px ${m.right * z}px ${m.bottom * z}px ${m.left * z}px`,
      );
      s.setProperty("font-size", `${(PRINT_FONT_PX * z).toFixed(2)}px`);
    }
    if (editorFontRule?.parentStyleSheet == null) {
      editorFontRule = findRule("#editor .cm-editor");
    }
    editorFontRule?.style.setProperty(
      "font-size",
      `${(PRINT_FONT_PX * z).toFixed(2)}px`,
    );
  } catch (err) {
    console.error("[monoleaf] applyPageVars failed:", err);
  }
}

function updatePageMetrics() {
  const cfg = parsePageConfig(view.state.doc.toString());
  paperDims =
    cfg.size === "Letter"
      ? { w: 816, h: 1056 } // 8.5in × 11in
      : { w: 794, h: 1123 }; // 210mm × 297mm
  pageMarginPx = marginToPx(cfg.margin);
  const editorEl = document.getElementById("editor")!;
  editorEl.style.setProperty("--doc-align", cfg.justify ? "justify" : "left");
  applyPageVars();
}

function refreshComments() {
  updatePageMetrics();
  const threads = parseComments(view.state.doc.toString());
  const open = threads.filter((t) => t.body !== null && !t.resolved).length;
  const badge = document.getElementById("comments-count")!;
  badge.hidden = open === 0;
  badge.textContent = String(open);
  commentsButton.title =
    open > 0 ? `Comments sidebar (${open} open)` : "Comments sidebar";
  commentsButton.setAttribute("aria-pressed", String(showComments));
  commentsSidebar.hidden = !showComments;
  if (!showComments) return;
  renderSidebar(commentsSidebar, threads, author(), {
    onChangeName() {
      void changeName();
    },
    onReply(id, text) {
      void (async () => {
        if (!(await ensureAuthor())) return;
        const spec = addReplySpec(view.state, id, {
          author: author(),
          ts: new Date().toISOString(),
          text,
        });
        if (spec !== null) view.dispatch(spec);
      })();
    },
    onResolve(id, resolved) {
      const spec = setResolvedSpec(view.state, id, resolved);
      if (spec !== null) view.dispatch(spec);
    },
    onSelect(id) {
      const thread = parseComments(view.state.doc.toString()).find(
        (t) => t.id === id,
      );
      if (thread?.anchor == null) return;
      view.dispatch({
        selection: { anchor: thread.anchor.startTo },
        effects: EditorView.scrollIntoView(thread.anchor.startTo, {
          y: "center",
        }),
      });
      view.focus();
    },
  });
}

let commentsRefreshQueued = false;
function scheduleCommentsRefresh() {
  if (commentsRefreshQueued) return;
  commentsRefreshQueued = true;
  requestAnimationFrame(() => {
    commentsRefreshQueued = false;
    refreshComments();
  });
}

function toggleCommentsSidebar() {
  showComments = !showComments;
  refreshComments();
}

async function newComment() {
  if (view.state.selection.main.empty) {
    await uiAlert("Select the text you want to comment on first.", {
      title: "Monoleaf",
    });
    return;
  }
  if (!(await ensureAuthor())) return;
  commentText.value = "";
  commentDialog.returnValue = "cancel";
  commentDialog.addEventListener(
    "close",
    () => {
      const text = commentText.value.trim();
      if (commentDialog.returnValue !== "ok" || text === "") {
        view.focus();
        return;
      }
      const spec = createCommentSpec(
        view.state,
        author(),
        text,
        new Date().toISOString(),
      );
      if (spec !== null) {
        view.dispatch(spec);
        showComments = true;
        refreshComments();
      }
      view.focus();
    },
    { once: true },
  );
  commentDialog.showModal();
  commentText.focus();
}

// --- About ------------------------------------------------------------------

const aboutDialog = document.getElementById(
  "about-dialog",
) as HTMLDialogElement;

function showAbout() {
  const licensesEl = document.getElementById("about-licenses")!;
  if (licensesEl.textContent === "") {
    licensesEl.textContent = thirdPartyLicenses;
  }
  getVersion()
    .then((v) => {
      document.getElementById("about-title")!.textContent = `Monoleaf ${v}`;
    })
    .catch(() => {});
  aboutDialog.showModal();
}

document.getElementById("btn-about")!.addEventListener("click", showAbout);
document.getElementById("btn-close-about")!.addEventListener("click", () => {
  aboutDialog.close();
  view.focus();
});

// --- PDF export -------------------------------------------------------------

const printPreview = document.getElementById("print-preview")!;
const printRoot = document.getElementById("print-root")!;
const pageDialog = document.getElementById("page-dialog") as HTMLDialogElement;
const pageSize = document.getElementById("page-size") as HTMLSelectElement;
const pageMargin = document.getElementById("page-margin") as HTMLInputElement;
const pageHeader = document.getElementById("page-header") as HTMLInputElement;
const pageFooter = document.getElementById("page-footer") as HTMLInputElement;

function closePreview() {
  printPreview.hidden = true;
  printRoot.innerHTML = "";
  // Drop the stylesheets Paged.js injected into the document head.
  document
    .querySelectorAll("style[data-pagedjs-inserted-styles]")
    .forEach((s) => s.remove());
  schedulePagination(300);
  view.focus();
}

async function exportPdf() {
  // Never run two Paged.js layouts at once: cancel pending measurements and
  // wait out a running one before taking over the pipeline.
  window.clearTimeout(paginationTimer);
  paginationQueued = false;
  while (paginationRunning) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const markdown = serializeDocument(view.state);
  const cfg = parsePageConfig(markdown);
  const fileTitle = fileLabel().replace(/\.(md|markdown)$/i, "");
  const { meta } = parseMeta(markdown);
  const html = sanitizeDocumentHtml(renderDocumentHtml(markdown, mode));
  // Header/footer placeholders resolve from the document metadata, falling
  // back to the filename, the saved author name, and today's date.
  const css = buildPrintCss(cfg, {
    title: meta.title.trim() || fileTitle,
    author:
      meta.author.trim() || (localStorage.getItem(AUTHOR_KEY)?.trim() ?? ""),
    date: meta.date.trim() || new Date().toLocaleDateString(),
  });
  printRoot.innerHTML = "";
  printPreview.hidden = false;
  const source = document.createElement("div");
  source.innerHTML = html;
  try {
    await new Previewer().preview(
      source,
      [{ "monoleaf-print": css }],
      printRoot,
    );
    printRoot.querySelectorAll("a[href]").forEach((a) => {
      a.setAttribute("title", "Opens in your default browser");
    });
  } catch (err) {
    closePreview();
    await showError(err);
  }
}

// Self-contained HTML: one portable .html file, everything inlined. No
// pagination pipeline needed — it's a screen document, not print media.
async function exportHtml() {
  try {
    const markdown = serializeDocument(view.state);
    const fileTitle = fileLabel().replace(/\.(md|markdown)$/i, "");
    const { meta } = parseMeta(markdown);
    const body = sanitizeDocumentHtml(renderDocumentHtml(markdown, mode));
    // The exported file gets a CSP mirroring this window's setting, so a shared
    // .html cannot fetch what the app itself was told not to fetch.
    const html = wrapStandaloneHtml(
      body,
      meta.title.trim() || fileTitle,
      remoteImagesEnabled,
    );
    const path = await save({
      filters: [{ name: "HTML", extensions: ["html"] }],
      defaultPath: `${fileTitle}.html`,
    });
    if (path === null) return;
    await invoke("write_file", { path, contents: html });
  } catch (err) {
    await showError(err);
  }
}

const pageJustify = document.getElementById("page-justify") as HTMLInputElement;

function pageSetup() {
  const cfg = parsePageConfig(view.state.doc.toString());
  pageSize.value = cfg.size;
  pageMargin.value = cfg.margin;
  pageHeader.value = cfg.header;
  pageFooter.value = cfg.footer;
  pageJustify.checked = cfg.justify;
  pageDialog.returnValue = "cancel";
  pageDialog.addEventListener(
    "close",
    () => {
      if (pageDialog.returnValue === "ok") {
        // The margin is interpolated into the @page block, so only plain CSS
        // lengths may be written (see MARGIN_RE). Say so rather than silently
        // storing a different margin than the one that was typed.
        const margin = pageMargin.value.trim();
        if (!MARGIN_RE.test(margin)) {
          reportError(
            `Page margin must be one to four CSS lengths, e.g. "20mm" or "25mm 18mm". Page setup was not saved.`,
          );
          view.focus();
          return;
        }
        view.dispatch(
          setPageConfigSpec(view.state, {
            size: pageSize.value === "Letter" ? "Letter" : "A4",
            margin,
            header: pageHeader.value,
            footer: pageFooter.value,
            justify: pageJustify.checked,
          }),
        );
      }
      view.focus();
    },
    { once: true },
  );
  pageDialog.showModal();
}

// The app webview must NEVER navigate away (there is no back button — the
// editor would be lost). Links are routed to the system's default browser
// instead: plain click on <a> elements (print preview), Ctrl+click on
// editor links (which carry data-url and say so in their hover tooltip).
function openExternal(url: string) {
  if (/^(https?:|mailto:|tel:)/i.test(url)) {
    openUrl(url).catch(() => {});
  }
}

// Jump to the heading matching a #anchor link (table-of-contents links).
function scrollToAnchor(anchor: string): void {
  const slug = anchor.replace(/^#/, "");
  const h = collectHeadings(view.state).find((x) => x.slug === slug);
  if (h === undefined) return;
  const line = view.state.doc.line(h.line);
  view.dispatch({
    selection: { anchor: line.from },
    effects: EditorView.scrollIntoView(line.from, { y: "start" }),
  });
  view.focus();
}

// Scroll to (and place the cursor at) a document position, if found.
function scrollToPos(pos: number | null): void {
  if (pos === null) return;
  view.dispatch({
    selection: { anchor: pos },
    effects: EditorView.scrollIntoView(pos, { y: "center" }),
  });
  view.focus();
}

function followLink(url: string): void {
  if (url.startsWith("#fn:"))
    scrollToPos(footnoteDefPos(view.state, url.slice(4)));
  else if (url.startsWith("#fnref:"))
    scrollToPos(footnoteRefPos(view.state, url.slice(7)));
  else if (url.startsWith("#")) scrollToAnchor(url);
  else openExternal(url);
}

for (const eventName of ["click", "auxclick"] as const) {
  document.addEventListener(
    eventName,
    (e) => {
      const target = e.target as HTMLElement | null;
      if (target === null) return;
      const editorLink = target.closest("[data-url]");
      if (editorLink !== null && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        e.stopPropagation();
        followLink(editorLink.getAttribute("data-url")!);
        return;
      }
      const anchor = target.closest("a");
      if (anchor !== null && anchor.hasAttribute("href")) {
        e.preventDefault();
        e.stopPropagation();
        if (eventName === "click") {
          openExternal(anchor.getAttribute("href")!);
        }
      }
    },
    { capture: true },
  );
}

document.getElementById("btn-print")!.addEventListener("click", () => {
  window.print();
});
document
  .getElementById("btn-close-preview")!
  .addEventListener("click", closePreview);

// --- accurate pagination ------------------------------------------------------
// Runs the real export pipeline (markdown-it + print CSS + Paged.js) in a
// hidden container after edits settle, then feeds the true break positions
// into the editor as decorations. Purely ephemeral: never touches the file.

// --- zoom (geometric page scaling; see applyPageVars) -----------------------

const ZOOM_KEY = "monoleaf.zoom";
const zoomSlider = document.getElementById("zoom-slider") as HTMLInputElement;
const zoomPct = document.getElementById("zoom-pct")!;
let zoom = Math.min(
  200,
  Math.max(50, Number(localStorage.getItem(ZOOM_KEY)) || 100),
);

function applyZoom() {
  applyPageVars(); // recompute the scaled page-size CSS vars
  zoomSlider.value = String(zoom);
  zoomPct.textContent = `${zoom}%`;
  localStorage.setItem(ZOOM_KEY, String(zoom));
  // The font/geometry changed underneath CodeMirror; make it re-measure so the
  // caret and selection are repositioned (otherwise they lag or vanish until
  // the next editor interaction). Guarded: applyZoom also runs once at init,
  // which is after `view` is created.
  view.requestMeasure();
}

function setZoom(percent: number) {
  zoom = Math.min(200, Math.max(50, Math.round(percent / 10) * 10));
  applyZoom();
}

document
  .getElementById("zoom-out")!
  .addEventListener("click", () => setZoom(zoom - 10));
document
  .getElementById("zoom-in")!
  .addEventListener("click", () => setZoom(zoom + 10));
zoomPct.addEventListener("click", () => setZoom(100));
zoomSlider.addEventListener("input", () => setZoom(Number(zoomSlider.value)));

// Ctrl+scroll zooms the page (like a browser/editor). Capture phase +
// preventDefault so it wins over — and suppresses — WebView2's own ctrl+wheel
// zoom. One 10% step per wheel notch, following the wheel direction.
window.addEventListener(
  "wheel",
  (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    setZoom(zoom + (e.deltaY < 0 ? 10 : -10));
  },
  { passive: false, capture: true },
);

const wordCountEl = document.getElementById("word-count")!;
function refreshWordCount() {
  const n = countWords(view.state.doc.toString());
  wordCountEl.textContent = n === 1 ? "1 word" : `${n} words`;
}

const measureRoot = document.getElementById("pagination-measure")!;
const pageIndicator = document.getElementById("page-indicator")!;
const PAGINATION_KEY = "monoleaf.pagination";
let paginationEnabled = localStorage.getItem(PAGINATION_KEY) !== "false";
let knownBreaks: PageBreak[] = [];
let knownPages = 1;
let paginationTimer: number | undefined;
let paginationRunning = false;
let paginationQueued = false;
let lastMeasureKey = "";

function refreshPageIndicator() {
  if (
    !paginationEnabled ||
    view.state.field(pageBreaksField, false) === undefined
  ) {
    pageIndicator.textContent = "";
    return;
  }
  const page = pageAt(knownBreaks, view.state.selection.main.head);
  pageIndicator.textContent = `p. ${page} / ${knownPages}`;
}

function togglePagination() {
  paginationEnabled = !paginationEnabled;
  localStorage.setItem(PAGINATION_KEY, String(paginationEnabled));
  if (paginationEnabled) {
    lastMeasureKey = "";
    schedulePagination(50);
  } else {
    knownBreaks = [];
    knownPages = 1;
    if (view.state.field(pageBreaksField, false) !== undefined) {
      view.dispatch({ effects: setPageBreaks.of([]) });
    }
  }
  refreshModeButtons();
  refreshPageIndicator();
  view.focus();
}

async function runPagination() {
  // Skip when off, while the export preview owns the Paged.js styles, or in
  // raw view.
  if (!paginationEnabled || !printPreview.hidden) return;
  if (view.state.field(pageBreaksField, false) === undefined) return;
  if (paginationRunning) {
    paginationQueued = true;
    return;
  }
  paginationRunning = true;
  try {
    const markdown = serializeDocument(view.state);
    // Nothing changed since the last measurement: skip the costly Paged.js
    // pass — but still re-apply the cached breaks. The decoration field lives
    // in livePreviewExtensions, so it gets wiped whenever the state is reloaded
    // (open file) or re-created by a live/raw (or flags) toggle; doing nothing
    // here would leave that fresh field empty and the page boundaries gone.
    const key = `${mode}|${markdown}`;
    if (key === lastMeasureKey) {
      view.dispatch({ effects: setPageBreaks.of(knownBreaks) });
      refreshPageIndicator();
      return;
    }
    const cfg = parsePageConfig(markdown);
    const html = sanitizeDocumentHtml(renderDocumentHtml(markdown, mode, true));
    const css = buildPrintCss(
      cfg,
      { title: "", author: "", date: "" },
      "#pagination-measure",
    );
    measureRoot.innerHTML = "";
    const source = document.createElement("div");
    source.innerHTML = html;
    const previewer = new Previewer();
    await previewer.preview(source, [{ "monoleaf-measure": css }], measureRoot);
    const { breaks, pages } = extractPageBreaks(measureRoot, view.state);
    knownBreaks = breaks;
    knownPages = pages;
    lastMeasureKey = key;
    view.dispatch({ effects: setPageBreaks.of(breaks) });
    refreshPageIndicator();
  } catch (err) {
    // Measurement is best-effort; the document is never affected. A Paged.js
    // internal crash (see isPagedjsInternalError) is swallowed to the console —
    // the same category the global error handler already ignores — and we keep
    // the last known breaks/indicator rather than blanking them, since the doc
    // is fine and only this one measurement pass failed. Anything else is a
    // genuine bug in our own code, so it must be visible, not silent.
    console.error("[monoleaf] pagination measurement failed:", err);
    if (isPagedjsInternalError(err)) {
      view.dispatch({ effects: setPageBreaks.of(knownBreaks) });
      refreshPageIndicator();
    } else {
      reportError(`Pagination: ${String(err)}`);
      pageIndicator.textContent = "";
    }
  } finally {
    measureRoot.innerHTML = "";
    document
      .querySelectorAll("style[data-pagedjs-inserted-styles]")
      .forEach((s) => s.remove());
    paginationRunning = false;
    if (paginationQueued) {
      paginationQueued = false;
      schedulePagination();
    }
  }
}

function schedulePagination(delay = 450) {
  window.clearTimeout(paginationTimer);
  paginationTimer = window.setTimeout(() => void runPagination(), delay);
}

// --- tracked changes --------------------------------------------------------

const suggestButton = document.getElementById("btn-suggest")!;
const acceptButton = document.getElementById("btn-accept") as HTMLButtonElement;
const rejectButton = document.getElementById("btn-reject") as HTMLButtonElement;
const acceptAllButton = document.getElementById(
  "btn-accept-all",
) as HTMLButtonElement;
const rejectAllButton = document.getElementById(
  "btn-reject-all",
) as HTMLButtonElement;
const nextChangeButton = document.getElementById(
  "btn-next-change",
) as HTMLButtonElement;

function refreshReviewButtons(state = view.state) {
  const regions = parseCritic(state.doc.toString());
  const at = regionAt(regions, state.selection.main.head) !== null;
  const any = regions.some((r) =>
    ["insertion", "deletion", "substitution"].includes(r.kind),
  );
  acceptButton.disabled = !at;
  rejectButton.disabled = !at;
  acceptAllButton.disabled = !any;
  rejectAllButton.disabled = !any;
  nextChangeButton.disabled = !any;

  suggestButton.textContent = "Track changes";
  suggestButton.setAttribute("aria-pressed", String(tracking));
  suggestButton.title = tracking
    ? "Track changes is ON: edits become tracked changes (CriticMarkup). Click to edit directly (Ctrl+Shift+E)."
    : "Track changes is OFF. Click so edits become tracked changes instead of applying directly (Ctrl+Shift+E).";
}

function toggleTracking() {
  tracking = !tracking;
  localStorage.setItem(TRACKING_STORAGE_KEY, String(tracking));
  view.dispatch({
    effects: trackingCompartment.reconfigure(
      tracking ? trackingExtension() : [],
    ),
  });
  refreshReviewButtons();
  view.focus();
}

// --- editor ---------------------------------------------------------------

const formattingKeymap = keymap.of([
  { key: "Backspace", run: deleteHardBreakBackward },
  { key: "Enter", run: paragraphEnter },
  { key: "Shift-Enter", run: hardBreakEnter },
  { key: "Mod-Enter", run: insertPageBreak },
  { key: "Mod-b", run: toggleBold },
  { key: "Mod-i", run: toggleItalic },
  { key: "Mod-Shift-x", run: toggleStrikethrough },
  { key: "Mod-u", run: toggleUnderline },
  { key: "Mod-Alt-h", run: toggleHighlight },
  { key: "Mod-l", run: setAlignment("left") },
  { key: "Mod-e", run: setAlignment("center") },
  { key: "Mod-r", run: setAlignment("right") },
  { key: "Mod-j", run: setAlignment("justify") },
  { key: "Mod-`", run: toggleInlineCode },
  { key: "Mod-=", run: toggleSubscript },
  { key: "Mod-Shift-=", run: toggleSuperscript },
  { key: "Mod-m", run: insertMath },
  ...[1, 2, 3, 4, 5, 6].map((n) => ({
    key: `Mod-Shift-${n}`,
    run: setHeading(n),
  })),
  { key: "Mod-Shift-0", run: setHeading(0) },
  {
    key: "Mod-k",
    run: () => {
      void editLink();
      return true;
    },
  },
  {
    key: "Mod-Shift-m",
    run: () => {
      void newComment();
      return true;
    },
  },
  {
    key: "Mod-Shift-v",
    run: () => {
      void clipboardPaste(); // plain text, no formatting
      return true;
    },
  },
  {
    key: "Mod-Shift-e",
    run: () => {
      toggleTracking();
      return true;
    },
  },
]);

// Ctrl+click on a link opens it in the default browser INSTEAD of moving
// the cursor; handled at mousedown so CodeMirror's own mouse handling (and
// its pointer capture) never sees the event.
const linkClickExtension = Prec.highest(
  EditorView.domEventHandlers({
    mousedown(e) {
      if (!(e.ctrlKey || e.metaKey) || e.button !== 0) return false;
      const link = (e.target as HTMLElement).closest("[data-url]");
      if (link === null) return false;
      e.preventDefault();
      followLink(link.getAttribute("data-url")!);
      return true;
    },
  }),
);

// Paste-with-formatting: when the clipboard carries genuinely rich HTML (Word,
// Outlook, rendered web pages) or a spreadsheet grid, convert it to markdown.
// When it is only plain text — including markdown SOURCE, which browsers put on
// the clipboard as text wrapped in bare <div>/<br> tags — we must NOT run it
// through turndown (that escapes every markdown character, so `#### Focus`
// becomes `\#### Focus` and never renders); instead we let CodeMirror paste the
// plain text as-is, which already renders as markdown. Ctrl+Shift+V remains the
// explicit paste-without-formatting escape hatch.
const richPaste = Prec.highest(
  EditorView.domEventHandlers({
    paste(e, v) {
      const plain = e.clipboardData?.getData("text/plain") ?? "";
      const html = e.clipboardData?.getData("text/html") ?? "";
      let markdown: string;
      try {
        // Excel/Sheets: the clean TSV plain text beats their messy HTML.
        const tsv = tsvToMarkdownTable(plain);
        if (tsv !== null) markdown = tsv;
        // Already markdown source? Paste it verbatim — converting the HTML
        // flavor would escape the syntax and it would never render.
        else if (looksLikeMarkdown(plain)) return false;
        // Otherwise only convert HTML that actually carries formatting; plain
        // text (incl. wrapper-only HTML) is pasted verbatim.
        else if (html !== "" && htmlHasRichFormatting(html))
          markdown = htmlToMarkdown(html);
        else return false; // let CM paste the plain text as-is
      } catch (err) {
        console.error("[monoleaf] paste conversion failed:", err);
        return false; // fall back to the plain-text paste
      }
      if (markdown === "") return false;
      e.preventDefault();
      // Inserted strings split only on the document's configured separator,
      // so turndown's \n must become the document's line break first.
      const text = markdown.replace(/\n/g, v.state.lineBreak);
      v.dispatch({
        ...v.state.replaceSelection(text),
        userEvent: "input.paste",
        scrollIntoView: true,
      });
      return true;
    },
  }),
);

const editorExtensions = () => [
  editorSetup,
  linkClickExtension,
  richPaste,
  Prec.high(formattingKeymap),
  modeCompartment.of(portabilityExtensions(mode, showFlags)),
  liveCompartment.of(liveView ? livePreviewExtensions() : rawViewExtensions),
  trackingCompartment.of(tracking ? trackingExtension() : []),
  commentsExtension(),
  criticExtension(),
  EditorView.lineWrapping,
  EditorView.updateListener.of((update) => {
    if (update.docChanged) {
      setDirty(true);
      scheduleCommentsRefresh();
      schedulePagination();
      scheduleAutosaveRecovery();
    }
    if (update.docChanged) refreshWordCount();
    if (update.docChanged || update.selectionSet) {
      refreshReviewButtons(update.state);
      refreshPageIndicator();
      refreshStyleButton();
      refreshOutline();
    }
  }),
];

const view = new EditorView({
  state: createDocumentState("", editorExtensions()),
  parent: document.getElementById("editor")!,
});

// --- Outline sidebar (document navigator) ---
const outlineSidebar = document.getElementById("outline-sidebar")!;
const outlineButton = document.getElementById("btn-outline")!;
const OUTLINE_KEY = "monoleaf.outline";

function refreshOutline() {
  if (outlineSidebar.hidden) return;
  renderOutline(view, outlineSidebar);
}

function toggleOutline(show = outlineSidebar.hidden) {
  outlineSidebar.hidden = !show;
  outlineButton.setAttribute("aria-pressed", String(show));
  localStorage.setItem(OUTLINE_KEY, show ? "1" : "0");
  refreshOutline();
}

outlineButton.addEventListener("click", () => toggleOutline());
if (localStorage.getItem(OUTLINE_KEY) === "1") toggleOutline(true);

// Reconfigure in place: same document, same cursor, only the parser and
// flagging change.
function applyModeConfig() {
  view.dispatch({
    effects: modeCompartment.reconfigure(
      portabilityExtensions(mode, showFlags),
    ),
  });
  refreshModeButtons();
  schedulePagination(100);
  view.focus();
}

function toggleMode() {
  mode = mode === "enhanced" ? "strict" : "enhanced";
  localStorage.setItem(MODE_STORAGE_KEY, mode);
  applyModeConfig();
}

function toggleFlags() {
  showFlags = !showFlags;
  localStorage.setItem(FLAGS_STORAGE_KEY, String(showFlags));
  applyModeConfig();
}

// The `live` class drives the page-card CSS (styles.css #editor.live …).
function applyViewClass() {
  document.getElementById("editor")!.classList.toggle("live", liveView);
}

function toggleLiveView() {
  liveView = !liveView;
  localStorage.setItem(VIEW_STORAGE_KEY, liveView ? "live" : "raw");
  // Same document, decorations only: the cursor cannot move here.
  view.dispatch({
    effects: liveCompartment.reconfigure(
      liveView ? livePreviewExtensions() : rawViewExtensions,
    ),
  });
  applyViewClass();
  refreshModeButtons();
  schedulePagination(100);
  refreshPageIndicator();
  view.focus();
}

/** Remember (or forget) the document to reopen on the next launch. */
function rememberLastFile(path: string | null) {
  if (path === null) localStorage.removeItem(LAST_FILE_KEY);
  else localStorage.setItem(LAST_FILE_KEY, path);
}

function loadIntoEditor(
  content: string,
  path: string | null,
  suggested: string | null = null,
) {
  // A fresh state per file so the lineSeparator facet matches the file's
  // actual line endings (the facet is fixed at state creation).
  view.setState(createDocumentState(content, editorExtensions()));
  currentPath = path;
  // A document with a path needs no suggestion; one without keeps whatever the
  // caller supplied (an import) and otherwise reverts to "Untitled".
  suggestedName = path === null ? suggested : null;
  if (path !== null) rememberLastFile(path);
  dirty = false;
  knownBreaks = [];
  knownPages = 1;
  // setState wiped the (per-state) page-break field; force a real re-measure
  // rather than let a matching cache key short-circuit it to an empty field.
  lastMeasureKey = "";
  refreshTitle();
  refreshComments();
  refreshPageIndicator();
  refreshWordCount();
  schedulePagination(300);
  view.focus();
}

async function showError(err: unknown) {
  await uiAlert(String(err), { title: "Monoleaf" });
}

/** A brand-new, empty, unsaved window — safe to reuse when opening a file
 * instead of spawning (and leaving behind) another empty one. */
function isPristineBlank(): boolean {
  return currentPath === null && !dirty && view.state.doc.length === 0;
}

/** Open a new editor window. `payload` seeds what it loads on startup:
 * {path} opens a file, {recover} restores an unsaved draft; blank otherwise.
 *
 * Returns the new window's label, or null if it could not be opened. Most callers
 * have no use for it; recovery does, because a draft handed to a new window has
 * to be written back under *that* window's key. */
async function openWindow(payload?: {
  path?: string;
  recover?: { path: string | null; content: string };
}): Promise<string | null> {
  try {
    return await invoke<string>("open_document_window", {
      payload: payload ? JSON.stringify(payload) : null,
    });
  } catch (err) {
    await showError(err);
    return null;
  }
}

// New / Open never destroy the current document — they open a fresh window
// instead. The one exception: if THIS window is still a pristine blank, reuse
// it rather than leave an empty window behind.
async function newFile() {
  if (isPristineBlank()) return; // already an empty document here
  await openWindow();
}

function isPdfPath(path: string): boolean {
  return path.toLowerCase().endsWith(".pdf");
}

/** What the backend returns for an imported PDF (see import_pdf_as_markdown). */
interface PdfImport {
  markdown: string;
  suggestedName: string;
}

/** Convert a PDF and load the Markdown into THIS editor as a new document.
 *
 * The result is deliberately path-less and dirty: it is a *conversion*, not a
 * file Monoleaf can save back over. Saving prompts for a .md name (seeded from
 * the PDF's title metadata), so the original PDF is never at risk of being
 * overwritten, and closing without saving warns like any other unsaved work. */
async function importPdf(path: string) {
  try {
    const imported = await invoke<PdfImport>("import_pdf_as_markdown", {
      path,
    });
    loadIntoEditor(imported.markdown, null, imported.suggestedName);
    setDirty(true);
  } catch (err) {
    await showError(err);
  }
}

/** Load a document by path into THIS editor: Markdown is read as-is, PDF is
 * converted.
 *
 * A PDF cannot be chosen through Open — Import is its own command — but the
 * dispatch belongs here anyway, because importing several PDFs at once spawns a
 * window per file and each one is seeded with nothing but a path. This is the
 * single place that knows a path ending in .pdf means "convert", so the child
 * window needs no special payload. */
async function loadPath(path: string) {
  if (isPdfPath(path)) {
    await importPdf(path);
    return;
  }
  try {
    const content = await invoke<string>("read_file", { path });
    loadIntoEditor(content, path);
  } catch (err) {
    // A refused network path is a setting the user can reverse, so offer it and
    // retry once rather than reporting a dead end.
    if (await offerNetworkPaths(err)) {
      try {
        loadIntoEditor(await invoke<string>("read_file", { path }), path);
        return;
      } catch (retryErr) {
        await showError(retryErr);
        return;
      }
    }
    await showError(err);
  }
}

/** Convert one or more PDFs, each into its own new document.
 *
 * Separate from Open on purpose: a PDF is not a Monoleaf document that can be
 * opened and saved back, it is a format converted into one. Keeping the two
 * commands apart is what makes that visible — Open offers Markdown, Import
 * offers PDF, and what Import produces is an unsaved document with a suggested
 * name rather than a file with a path. */
async function importPdfFile() {
  const selection = await open({ filters: IMPORT_FILTERS, multiple: true });
  if (selection === null) return;
  const paths = Array.isArray(selection) ? selection : [selection];
  for (let i = 0; i < paths.length; i++) {
    // Same rule as Open: reuse this window only for the first file, and only
    // if it is still blank; every other conversion gets its own window.
    if (i === 0 && isPristineBlank()) await importPdf(paths[i]);
    else await openWindow({ path: paths[i] });
  }
}

async function openFile() {
  const selection = await open({ filters: MARKDOWN_FILTERS, multiple: true });
  if (selection === null) return;
  const paths = Array.isArray(selection) ? selection : [selection];
  for (let i = 0; i < paths.length; i++) {
    // Reuse this window only for the first file, and only if it's blank;
    // every other file opens in its own window.
    if (i === 0 && isPristineBlank()) await loadPath(paths[i]);
    else await openWindow({ path: paths[i] });
  }
}

async function saveFile(forcePrompt = false): Promise<boolean> {
  try {
    let path = currentPath;
    if (path === null || forcePrompt) {
      path = await save({
        filters: MARKDOWN_FILTERS,
        defaultPath: currentPath ?? suggestedName ?? "Untitled.md",
      });
      if (path === null) return false;
    }
    const contents = serializeDocument(view.state);
    try {
      await invoke("write_file", { path, contents });
    } catch (err) {
      // Same offer as on open: saving to a share is the user's call to make.
      if (!(await offerNetworkPaths(err))) throw err;
      await invoke("write_file", { path, contents });
    }
    currentPath = path;
    // The document has a real name now, so any imported suggestion is spent.
    suggestedName = null;
    dirty = false;
    rememberLastFile(path);
    discardDraft(RECOVERY_KEY); // the file now matches
    refreshTitle();
    return true;
  } catch (err) {
    await showError(err);
    return false;
  }
}

const actions: Record<string, () => void> = {
  new: () => void newFile(),
  open: () => void openFile(),
  save: () => void saveFile(),
  "save-as": () => void saveFile(true),
};

for (const [id, handler] of Object.entries(actions)) {
  document.getElementById(`btn-${id}`)!.addEventListener("click", handler);
}

// --- autosave / crash recovery ---
let autosaveTimer: number | undefined;

// Debounced after edits settle: autosave to the file when enabled, otherwise
// keep a recovery snapshot of the unsaved work.
function scheduleAutosaveRecovery() {
  window.clearTimeout(autosaveTimer);
  autosaveTimer = window.setTimeout(() => {
    if (!dirty) return;
    if (autosaveEnabled && currentPath !== null) {
      void saveFile(); // writes, clears dirty, clears the recovery snapshot
      return;
    }
    // Returns false if storage refused it (over quota); skipping one snapshot
    // is preferable to interrupting the user.
    writeDraft(RECOVERY_KEY, currentPath, serializeDocument(view.state));
  }, 1500);
}

function toggleAutosave() {
  autosaveEnabled = !autosaveEnabled;
  localStorage.setItem(AUTOSAVE_KEY, String(autosaveEnabled));
  refreshModeButtons();
  if (autosaveEnabled && dirty && currentPath !== null) void saveFile();
  view.focus();
}

/** Toggling this has to re-render: an image widget caches its DOM, so a blocked
 * one keeps showing its placeholder until the decorations are rebuilt, and page
 * breaks move once images occupy space. */
function toggleRemoteImages() {
  remoteImagesEnabled = !remoteImagesEnabled;
  setRemoteImagesAllowed(remoteImagesEnabled);
  storeRemoteImagePreference(remoteImagesEnabled);
  // Same document, decorations only — as in toggleLiveView. Reconfiguring the
  // compartment rebuilds the image widgets while leaving the document, the
  // undo history and the cursor untouched, which `setState` would discard.
  view.dispatch({
    effects: liveCompartment.reconfigure(
      liveView ? livePreviewExtensions() : rawViewExtensions,
    ),
  });
  refreshModeButtons();
  schedulePagination(50);
  view.focus();
}

function setNetworkPaths(enabled: boolean) {
  networkPathsEnabled = enabled;
  localStorage.setItem(NETWORK_PATHS_KEY, String(enabled));
  pushNetworkPathSetting();
  refreshModeButtons();
}

function toggleNetworkPaths() {
  setNetworkPaths(!networkPathsEnabled);
  view.focus();
}

/**
 * The backend refused a network path. Offer the setting rather than leaving the
 * user at a dead end with no idea what to do about it — the refusal is a policy
 * decision they are allowed to reverse, and the alternative (mapping a drive) is
 * not something most people would think of.
 *
 * Returns true when the setting was just switched on, meaning the caller should
 * retry the operation. COUPLED: the match below is on NETWORK_PATH_REFUSED in
 * src-tauri/src/lib.rs.
 */
async function offerNetworkPaths(err: unknown): Promise<boolean> {
  if (!String(err).includes("Network paths are not supported")) return false;
  const allow = await uiConfirm(
    "This file is on a network share.\n\n" +
      "Opening it makes Windows sign in to that server, which hands it a hash " +
      "of your credentials. Monoleaf does not do that without your say-so.\n\n" +
      "You can switch this off again in Settings. Mapped drives (Z:) are " +
      "unaffected.",
    {
      title: "Network path",
      okLabel: "Allow network paths",
      cancelLabel: "Cancel",
    },
  );
  if (allow) setNetworkPaths(true);
  return allow;
}

function toggleReopen() {
  reopenLastEnabled = !reopenLastEnabled;
  localStorage.setItem(REOPEN_KEY, String(reopenLastEnabled));
  refreshModeButtons();
  view.focus();
}

// Startup for the MAIN window. Precedence for what the main window shows: a
// file Monoleaf was launched with (double-clicked .md) wins; then a recovered
// draft; then a prompt to reopen the last file. On top of that, since at a fresh launch the
// main window is the only live one, EVERY recovery key is an orphaned draft
// from a crashed/force-closed session: the user is asked once, then the first
// draft (if the main window is otherwise free) restores here and any remaining
// drafts each reopen in their own window — so no window's work is lost.
// --- updates ----------------------------------------------------------------
//
// The webview cannot reach the updater plugin at all — its commands are ACL-gated
// and no capability grants them. Everything here goes through our own commands;
// see the block above the plugin registration in src-tauri/src/lib.rs for why the
// configuration is split the way it is.

/**
 * Whether Monoleaf may check for updates. THREE states, not two: a missing value
 * means the user has not been asked, which is not the same as having said no.
 * Only the missing state offers the consent dialog, and only "yes" ever checks.
 */
const UPDATE_CONSENT_KEY = "monoleaf.update-checks";

function updateConsent(): "yes" | "no" | "unset" {
  const stored = localStorage.getItem(UPDATE_CONSENT_KEY);
  return stored === "yes" || stored === "no" ? stored : "unset";
}

/** What `check_for_update` reports. */
interface UpdateInfo {
  version: string;
  notes: string | null;
}

/** What `download_update` streams over the channel it is given. */
interface DownloadProgress {
  downloaded: number;
  contentLength: number | null;
  done: boolean;
}

const consentDialog = document.getElementById(
  "consent-dialog",
) as HTMLDialogElement;
const consentYes = document.getElementById("consent-yes")!;
const updateBar = document.getElementById("update-bar")!;
const updateText = document.getElementById("update-text")!;
const updateProgress = document.getElementById(
  "update-progress",
) as HTMLProgressElement;
const updateAction = document.getElementById(
  "btn-update-action",
) as HTMLButtonElement;

/** The offer on screen in THIS window, and how far it has got. */
let offeredUpdate: UpdateInfo | null = null;
let updateReadyToInstall = false;
let updateBusy = false;

/**
 * Set for exactly one flush round when the user answers "Don't save" to the
 * install prompt in this window. See `installOfferedUpdate` for why this exists
 * instead of clearing `dirty`, and `setupRecoveryFlush` for what it does.
 */
let flushSuppressedForInstall = false;

/**
 * Ask once, on a first run, whether update checks are allowed.
 *
 * Two answers and no third way out. Escape is blocked because a consent dialog
 * that can be dismissed is worse than useless: dismissal either has to nag again
 * at every launch or be recorded as a silent no, and afterwards nothing can tell
 * which of those the user meant.
 */
function askUpdateConsent(): Promise<"yes" | "no"> {
  return new Promise((resolve) => {
    const blockEscape = (e: Event) => e.preventDefault();
    consentDialog.addEventListener("cancel", blockEscape);
    consentDialog.returnValue = "";
    consentDialog.addEventListener(
      "close",
      () => {
        consentDialog.removeEventListener("cancel", blockEscape);
        // Only the two buttons can close this, so anything else is a browser
        // quirk rather than an answer; treat it as the conservative one.
        resolve(consentDialog.returnValue === "yes" ? "yes" : "no");
      },
      { once: true },
    );
    consentDialog.showModal();
    consentYes.focus();
  });
}

function hideUpdateBar() {
  updateBar.hidden = true;
  updateProgress.hidden = true;
  offeredUpdate = null;
  updateReadyToInstall = false;
}

function showUpdateOffer(info: UpdateInfo) {
  offeredUpdate = info;
  updateReadyToInstall = false;
  updateProgress.hidden = true;
  updateText.textContent = `Monoleaf ${info.version} is available.`;
  updateAction.textContent = "Download";
  updateAction.disabled = false;
  updateAction.hidden = false;
  updateBar.hidden = false;
}

/**
 * The one place a check happens. `userInitiated` decides who hears about
 * failures: a click is owed an answer, including "nothing to install", while an
 * automatic check that finds no network stays silent rather than teaching people
 * to dismiss whatever Monoleaf says.
 *
 * It now also decides whether a skipped version is honoured. An automatic check
 * respects the skip, because that is what the user asked for. A click does not:
 * "Check for updates" is a question about right now, and answering "you are up
 * to date" when an update exists and is merely declined would be a lie — the one
 * thing this bar cannot afford to be.
 */
async function checkForUpdate(userInitiated: boolean) {
  try {
    const info = await invoke<UpdateInfo | null>("check_for_update", {
      userInitiated,
    });
    if (info !== null) {
      if (!userInitiated && isVersionSkipped(info.version)) return;
      // Cleared before showing, never after: once this version is in the bar,
      // storage saying it was declined would contradict the screen, and the next
      // automatic check would hide it again with nothing to explain why.
      clearSkippedVersion();
      showUpdateOffer(info);
    } else if (userInitiated) {
      await uiAlert(`Monoleaf ${await getVersion()} is the latest version.`, {
        title: "No update available",
      });
    }
  } catch (err) {
    if (userInitiated) await showError(err);
  }
}

async function downloadOfferedUpdate() {
  if (offeredUpdate === null || updateBusy) return;
  const version = offeredUpdate.version;
  updateBusy = true;
  updateAction.disabled = true;
  updateText.textContent = `Downloading Monoleaf ${version}…`;
  updateProgress.hidden = false;
  updateProgress.value = 0;

  const progress = new Channel<DownloadProgress>();
  progress.onmessage = (message) => {
    if (message.contentLength !== null && message.contentLength > 0) {
      updateProgress.max = message.contentLength;
      updateProgress.value = message.downloaded;
    } else {
      // No Content-Length: an indeterminate bar is honest, a full one is not.
      updateProgress.removeAttribute("value");
    }
  };

  try {
    await invoke("download_update", { onProgress: progress });
    updateReadyToInstall = true;
    updateProgress.hidden = true;
    updateText.textContent = `Monoleaf ${version} is ready to install. Monoleaf will close and reopen.`;
    updateAction.textContent = "Install and restart";
  } catch (err) {
    // Reported in the bar rather than a dialog: a failed download interrupts
    // nothing and costs nothing to retry.
    updateProgress.hidden = true;
    updateText.textContent = `Monoleaf ${version} could not be downloaded: ${String(err)}`;
    updateAction.textContent = "Try again";
  } finally {
    updateBusy = false;
    updateAction.disabled = false;
  }
}

async function installOfferedUpdate() {
  if (offeredUpdate === null || !updateReadyToInstall || updateBusy) return;

  // THIS window's unsaved work is the user's decision, and it is the same
  // decision closing the window would present, so it uses the same prompt. Every
  // other window is handled by the flush protocol in Rust and is deliberately
  // not prompted: nothing is being asked of those windows, so there is nothing
  // for their users to answer.
  if (dirty) {
    const choice = await promptClose();
    if (choice === "cancel") return;
    if (choice === "save" && !(await saveFile())) return;
    if (choice === "discard") {
      // "Don't save" applies to THIS install attempt, not to the document, so it
      // suppresses one flush round and nothing else. `dirty` is deliberately left
      // alone: clearing it would assert, the moment the install postpones, that a
      // document whose content is nowhere on disk is saved — no title marker, no
      // close guard, no snapshot. That is precisely the state this whole protocol
      // exists to prevent, and it would have been created by the protocol itself.
      // An install that does not happen must leave no trace.
      discardDraft(RECOVERY_KEY);
      flushSuppressedForInstall = true;
    }
  }

  updateBusy = true;
  updateAction.disabled = true;
  updateText.textContent = "Installing…";
  try {
    await invoke("install_update");
    // Not reached on success: the installer takes over and the process exits.
  } catch (err) {
    // The suppression covered one attempt, and that attempt is over. Put the
    // snapshot back so the window ends up exactly as it was before the click: an
    // unsaved document, marked unsaved, with a copy in storage.
    if (flushSuppressedForInstall) {
      flushSuppressedForInstall = false;
      writeDraft(RECOVERY_KEY, currentPath, serializeDocument(view.state));
    }
    // Postponement is the expected failure, not an exception: some window could
    // not confirm that its unsaved work is safe. Rust names the window; what the
    // user needs on top of that is what to do about it. The bar stays exactly as
    // it was, so retrying installs the bytes already downloaded.
    updateText.textContent = `${String(err)} Save your work in that window, then try again.`;
    updateAction.textContent = "Install and restart";
  } finally {
    updateBusy = false;
    updateAction.disabled = false;
  }
}

updateAction.addEventListener("click", () => {
  if (updateReadyToInstall) void installOfferedUpdate();
  else void downloadOfferedUpdate();
});
document
  .getElementById("btn-dismiss-update")!
  .addEventListener("click", hideUpdateBar);

/**
 * "Not this version" — the answer the bar previously had no way to express.
 *
 * Without it the only lasting way to decline a specific version was to switch
 * update checks off, which declines every future version too and says nothing
 * about having done so. Dismiss stays what it was, a hide until the next check.
 *
 * Rust is told as well, for the same reason `toggleUpdateChecks` tells it: an
 * update left sitting in `PendingUpdate` keeps `install_update` armed, so a
 * declined version could still be installed from a stale bar in another window.
 */
function skipOfferedVersion() {
  // Read before `hideUpdateBar`, which clears `offeredUpdate`.
  const version = offeredUpdate?.version;
  if (version !== undefined) skipVersion(version);
  hideUpdateBar();
  void invoke("discard_pending_update").catch(() => {});
}

document
  .getElementById("btn-skip-update")!
  .addEventListener("click", skipOfferedVersion);

/**
 * The settings toggle. Renders off while consent is unset, because nothing is
 * being checked in that state.
 */
function toggleUpdateChecks() {
  const next = updateConsent() === "yes" ? "no" : "yes";
  localStorage.setItem(UPDATE_CONSENT_KEY, next);
  refreshModeButtons();
  if (next === "yes") {
    // Checking straight away is the point: the next startup is too late to be
    // evidence that the switch did anything, and a switch with no visible effect
    // reads as broken.
    void checkForUpdate(true);
  } else {
    // Rust has to forget any downloaded update too, or install-on-click stays
    // armed for a feature the user has just switched off.
    hideUpdateBar();
    void invoke("discard_pending_update").catch(() => {});
  }
  view.focus();
}

/**
 * First run consent, then the single startup check.
 *
 * MODAL ORDER. This runs only after the name prompt and the recovery prompt have
 * both settled (see the startup chain at the end of this file), so the consent
 * dialog can never be stacked on top of either. Consenting falls through to the
 * check below rather than doing its own, which is what keeps the startup check to
 * one call site.
 */
async function startupUpdateFlow() {
  if (!isMainWindow) return; // one consent question per install, not per window
  if (updateConsent() === "unset") {
    const answer = await askUpdateConsent();
    localStorage.setItem(UPDATE_CONSENT_KEY, answer);
    refreshModeButtons();
    view.focus();
  }
  if (updateConsent() === "yes") await checkForUpdate(false);
}

async function startupOpen() {
  const launched = await invoke<string | null>("take_launch_file").catch(
    () => null,
  );

  let drafts = collectRecoveryDrafts();
  if (drafts.length > 0) {
    const restore = await uiConfirm(
      drafts.length === 1
        ? `Monoleaf has unsaved changes from your last session (${draftName(drafts[0].path)}). Recover them?`
        : `Monoleaf has ${drafts.length} unsaved documents from your last session. Recover them?`,
      {
        title: "Recover unsaved changes",
        okLabel: "Recover",
        cancelLabel: "Discard",
      },
    );
    // Consume the snapshots either way (recovered below, or discarded).
    //
    // The keys are removed here rather than after the drafts are loaded because a
    // key from the previous session can be *this* window's key, and rewriting it
    // below would then be undone by a later discard. Everything recovered is
    // written straight back under the key of whichever window ends up holding it
    // — see the `writeDraft` calls below.
    for (const d of drafts) discardDraft(d.key);
    if (!restore) drafts = [];
  }

  if (launched) {
    await loadPath(launched);
  } else if (drafts.length > 0) {
    const first = drafts.shift()!;
    loadIntoEditor(first.content, first.path);
    setDirty(true); // still unsaved relative to disk
    // Re-snapshot immediately, under this window's own key. Recovering used to
    // *consume* the only copy: the snapshot was deleted here and the next one was
    // 1500 ms away and debounced behind an edit that might never come, so a
    // document recovered and then left untouched existed nowhere but in memory.
    // A crash, a forced close or a pulled plug in that window lost it — the exact
    // failure recovery exists to prevent, reintroduced by recovery itself. Not an
    // updater problem; it just becomes reachable more often once installing an
    // update ends the process on purpose.
    writeDraft(RECOVERY_KEY, first.path, first.content);
  } else if (reopenLastEnabled) {
    const last = localStorage.getItem(LAST_FILE_KEY);
    if (last !== null) {
      const reopen = await uiConfirm(
        `Reopen your last document (${draftName(last)})?`,
        {
          title: "Reopen last document",
          okLabel: "Reopen",
          cancelLabel: "Start blank",
        },
      );
      if (reopen) {
        try {
          const content = await invoke<string>("read_file", { path: last });
          loadIntoEditor(content, last);
        } catch {
          // Moved, deleted, or unreadable — forget it and start blank.
          localStorage.removeItem(LAST_FILE_KEY);
        }
      } else {
        // Declining once means "don't ask again" — same as switching off
        // "Reopen last file" in the menu, so it stays off until turned back on.
        reopenLastEnabled = false;
        localStorage.setItem(REOPEN_KEY, "false");
        refreshModeButtons();
      }
    }
  }

  // Any drafts the main window didn't take reopen in their own windows.
  for (const d of drafts) {
    const label = await openWindow({
      recover: { path: d.path, content: d.content },
    });
    // Same reasoning as the re-snapshot above, one window along: write the draft
    // back before its window has even finished loading, so it is never in flight
    // with no copy on disk. Under the new window's key when there is one; if the
    // window could not be opened, back under the key it came from, which is what
    // makes it show up again at the next launch instead of vanishing.
    writeDraft(label ? recoveryKey(label) : d.key, d.path, d.content);
  }
}

// Startup for a runtime-created window: load whatever the backend queued for it
// (a file to open, or a draft to recover); otherwise it stays blank.
async function startupChild() {
  // No label argument: the backend uses the calling window's own label, so one
  // window cannot drain another's queued payload.
  const raw = await invoke<string | null>("take_window_payload").catch(
    () => null,
  );
  if (raw === null) return;
  let payload: {
    path?: string;
    recover?: { path: string | null; content: string };
  };
  try {
    payload = JSON.parse(raw);
  } catch {
    return;
  }
  if (payload.recover) {
    loadIntoEditor(payload.recover.content, payload.recover.path ?? null);
    setDirty(true);
  } else if (typeof payload.path === "string") {
    await loadPath(payload.path);
  }
}

modeButton.addEventListener("click", toggleMode);
flagsButton.addEventListener("click", toggleFlags);
liveButton.addEventListener("click", toggleLiveView);

// --- text style dropdown (Paragraph / Heading 1-3) --------------------------

const styleButton = document.getElementById("btn-style")!;
const STYLE_LABELS = [
  "Paragraph",
  "Heading 1",
  "Heading 2",
  "Heading 3",
  "Heading 4",
  "Heading 5",
  "Heading 6",
];

/** Heading level (0 = paragraph) of the line at the cursor. */
function currentHeadingLevel(): number {
  const line = view.state.doc.lineAt(view.state.selection.main.head);
  const m = /^ {0,3}(#{1,6}) /.exec(line.text);
  return m === null ? 0 : m[1].length;
}

function refreshStyleButton() {
  styleButton.firstChild!.textContent = STYLE_LABELS[currentHeadingLevel()];
}

styleButton.addEventListener("click", (e) => {
  e.stopPropagation();
  const rect = styleButton.getBoundingClientRect();
  const level = currentHeadingLevel();
  showContextMenu(
    rect.left,
    rect.bottom + 4,
    [0, 1, 2, 3].map((n) => ({
      kind: "item",
      label: STYLE_LABELS[n],
      strong: n === level,
      action: runInEditor(setHeading(n)),
    })),
  );
});

// --- change case (Word-style picker) ----------------------------------------
const CASE_MODES: { mode: CaseMode; label: string }[] = [
  { mode: "upper", label: "UPPERCASE" },
  { mode: "lower", label: "lowercase" },
  { mode: "title", label: "Title Case" },
  { mode: "sentence", label: "Sentence case" },
];

function caseMenuItems(): MenuItem[] {
  return CASE_MODES.map((c) => ({
    kind: "item",
    label: c.label,
    action: runInEditor(changeCase(c.mode)),
  }));
}

const caseButton = document.getElementById("btn-case")!;
caseButton.addEventListener("click", (e) => {
  e.stopPropagation();
  const rect = caseButton.getBoundingClientRect();
  showContextMenu(rect.left, rect.bottom + 4, caseMenuItems());
});

// --- callout / admonition insert (type picker) ------------------------------
const calloutButton = document.getElementById("btn-callout")!;
calloutButton.addEventListener("click", (e) => {
  e.stopPropagation();
  const rect = calloutButton.getBoundingClientRect();
  showContextMenu(
    rect.left,
    rect.bottom + 4,
    ADMONITION_KINDS.map((k) => ({
      kind: "item",
      label: `${ADMONITIONS[k].icon}  ${ADMONITIONS[k].label}`,
      action: runInEditor(insertAdmonition(k)),
    })),
  );
});

// --- Word-style table size picker -------------------------------------------

const tablePicker = document.getElementById("table-picker")!;
const tpGrid = document.getElementById("tp-grid")!;
const tpLabel = document.getElementById("tp-label")!;
const tpCols = document.getElementById("tp-cols") as HTMLInputElement;
const tpRows = document.getElementById("tp-rows") as HTMLInputElement;
const TP_COLS = 10;
const TP_ROWS = 8;

for (let r = 1; r <= TP_ROWS; r++) {
  for (let c = 1; c <= TP_COLS; c++) {
    const cell = document.createElement("div");
    cell.className = "tp-cell";
    cell.dataset.c = String(c);
    cell.dataset.r = String(r);
    cell.addEventListener("mouseenter", () => {
      tpGrid.querySelectorAll<HTMLElement>(".tp-cell").forEach((el) => {
        el.classList.toggle(
          "on",
          Number(el.dataset.c) <= c && Number(el.dataset.r) <= r,
        );
      });
      tpLabel.textContent = `${c} × ${r} table`;
    });
    cell.addEventListener("click", () => {
      hideTablePicker();
      runInEditor(insertTableSized(c, r))();
    });
    tpGrid.appendChild(cell);
  }
}

function hideTablePicker() {
  tablePicker.hidden = true;
}

// One handler for every table button (there is a copy per tab); the picker
// opens under whichever button was clicked.
for (const btn of document.querySelectorAll<HTMLElement>(
  '[data-tool="table"]',
)) {
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (!tablePicker.hidden) {
      hideTablePicker();
      return;
    }
    const rect = btn.getBoundingClientRect();
    tablePicker.style.left = `${rect.left}px`;
    tablePicker.style.top = `${rect.bottom + 4}px`;
    tablePicker.style.right = "auto";
    tpLabel.textContent = "Insert table";
    tpGrid
      .querySelectorAll(".tp-cell")
      .forEach((el) => el.classList.remove("on"));
    tablePicker.hidden = false;
  });
}

document.getElementById("tp-insert")!.addEventListener("click", () => {
  const cols = Math.max(1, Math.min(20, Number(tpCols.value) || 3));
  const rows = Math.max(1, Math.min(50, Number(tpRows.value) || 3));
  hideTablePicker();
  runInEditor(insertTableSized(cols, rows))();
});

document.addEventListener("mousedown", (e) => {
  if (tablePicker.hidden) return;
  const target = e.target as HTMLElement;
  if (target.closest('#table-picker, [data-tool="table"]') === null)
    hideTablePicker();
});

// --- clipboard (via the Tauri plugin; the browser API is unreliable here) --

async function clipboardCut() {
  const { from, to } = view.state.selection.main;
  if (from === to) return;
  await writeText(view.state.sliceDoc(from, to));
  view.dispatch({ changes: { from, to }, userEvent: "delete.cut" });
  view.focus();
}

async function clipboardCopy() {
  const { from, to } = view.state.selection.main;
  if (from === to) return;
  await writeText(view.state.sliceDoc(from, to));
  view.focus();
}

/** Menu paste: prefer the clipboard's HTML flavor (converted to markdown),
 * fall back to plain text. */
async function menuPasteRich() {
  const insert = (markdown: string) => {
    // Normalise any CR/CRLF first, then to the document's separator, so pasting
    // plain text that carries Windows line endings can't produce doubled "\r".
    const text = markdown
      .replace(/\r\n?/g, "\n")
      .replace(/\n/g, view.state.lineBreak);
    view.dispatch({
      ...view.state.replaceSelection(text),
      userEvent: "input.paste",
      scrollIntoView: true,
    });
    view.focus();
  };
  try {
    const items = await navigator.clipboard.read();
    for (const item of items) {
      let plain = "";
      if (item.types.includes("text/plain")) {
        plain = await (await item.getType("text/plain")).text();
        const tsv = tsvToMarkdownTable(plain);
        if (tsv !== null) return insert(tsv); // spreadsheet grid → GFM table
        // Already markdown source? Paste verbatim (converting would escape it).
        if (looksLikeMarkdown(plain)) return insert(plain);
      }
      if (item.types.includes("text/html")) {
        const html = await (await item.getType("text/html")).text();
        // Only convert genuinely rich HTML; wrapper-only HTML around plain text
        // would be escaped by turndown, so leave it to the plain paste.
        if (htmlHasRichFormatting(html)) return insert(htmlToMarkdown(html));
      }
      if (plain !== "") return insert(plain); // plain text, verbatim
    }
  } catch {
    // Async clipboard unavailable: plain paste below.
  }
  await clipboardPaste();
}

async function clipboardPaste() {
  try {
    const text = await readText();
    if (text !== "") {
      view.dispatch({
        ...view.state.replaceSelection(text),
        userEvent: "input.paste",
        scrollIntoView: true,
      });
    }
  } catch {
    // Clipboard empty or non-text: nothing to paste.
  }
  view.focus();
}

const runInEditor = (cmd: StateCommand) => () => {
  cmd({ state: view.state, dispatch: (tr) => view.dispatch(tr) });
  view.focus();
};

const formatButtons: Record<string, () => void> = {
  bold: runInEditor(toggleBold),
  italic: runInEditor(toggleItalic),
  strike: runInEditor(toggleStrikethrough),
  underline: runInEditor(toggleUnderline),
  highlight: runInEditor(toggleHighlight),
  subscript: runInEditor(toggleSubscript),
  superscript: runInEditor(toggleSuperscript),
  math: runInEditor(insertMath),
  ul: runInEditor(toggleBulletList),
  ol: runInEditor(toggleOrderedList),
  task: runInEditor(toggleTaskList),
  quote: runInEditor(toggleQuote),
  "clear-format": runInEditor(clearFormatting),
  "align-left": runInEditor(setAlignment("left")),
  "align-center": runInEditor(setAlignment("center")),
  "align-right": runInEditor(setAlignment("right")),
  "align-justify": runInEditor(setAlignment("justify")),
  code: runInEditor(toggleInlineCode),
  link: () => void editLink(),
  image: () => void insertImage(),
  comment: () => void newComment(),
  comments: toggleCommentsSidebar,
  suggest: toggleTracking,
  accept: runInEditor(acceptAtCursor),
  reject: runInEditor(rejectAtCursor),
  "accept-all": runInEditor(acceptAllChanges),
  "reject-all": runInEditor(rejectAllChanges),
  "next-change": runInEditor(nextChange),
  toc: runInEditor(insertTableOfContents),
  "import-pdf": () => void importPdfFile(),
  export: () => void exportPdf(),
  "export-html": () => void exportHtml(),
  "page-setup": pageSetup,
  "doc-props": openMetaDialog,
  find: () => {
    openSearchPanel(view);
  },
  name: () => {
    toggleSettingsMenu(false);
    void changeName();
  },
  pagination: togglePagination,
  theme: toggleTheme,
  autosave: toggleAutosave,
  "remote-images": toggleRemoteImages,
  "network-paths": toggleNetworkPaths,
  reopen: toggleReopen,
  updates: toggleUpdateChecks,
  "check-now": () => {
    toggleSettingsMenu(false);
    // Explicitly user-initiated: this is a click, so it reports whatever it
    // finds, including that there is nothing to install. It works even when the
    // startup check is switched off — that switch governs what Monoleaf does on
    // its own, and this is the user asking.
    void checkForUpdate(true);
  },
};

for (const [id, handler] of Object.entries(formatButtons)) {
  document.getElementById(`btn-${id}`)!.addEventListener("click", handler);
}

// Comment lives in both the Edit tab (this copy) and the Review tab (the
// canonical btn-comment); bind the copy to the same handler.
document
  .getElementById("btn-comment-2")
  ?.addEventListener("click", formatButtons.comment);

// --- right-click context menu ----------------------------------------------
// Custom menu in the editor; Shift+right-click passes through to the native
// menu, which is the only place spelling suggestions exist (no web API).

/** Top spelling suggestions for the word at pos, via the native Windows
 * spell checker (same engine and user dictionaries as the OS). */
async function spellingItems(pos: number): Promise<MenuItem[]> {
  const range = view.state.wordAt(pos);
  if (range === null) return [];
  const word = view.state.sliceDoc(range.from, range.to);
  if (word.length < 2 || !/^[\p{L}\p{M}'’-]+$/u.test(word)) return [];
  let suggestions: string[] | null;
  try {
    suggestions = await invoke<string[] | null>("spell_suggest", { word });
  } catch (err) {
    // The command distinguishes "spelled correctly" (null) from "the checker
    // failed" (a rejection). A failure must not be silent, or an unavailable
    // spell checker looks exactly like a document with no misspellings — but it
    // also must not nag, since nothing the user typed is wrong.
    console.error("[monoleaf] spell check unavailable:", err);
    return [];
  }
  if (suggestions === null) return []; // correctly spelled
  const items: MenuItem[] = suggestions.slice(0, 3).map((s) => ({
    kind: "item" as const,
    label: s,
    strong: true,
    action: () => {
      view.dispatch({
        changes: { from: range.from, to: range.to, insert: s },
        userEvent: "input.type",
      });
      view.focus();
    },
  }));
  if (items.length === 0) {
    items.push({ kind: "note", label: "No spelling suggestions" });
  }
  items.push(
    {
      kind: "item",
      label: "Add to dictionary",
      action: () => {
        invoke("spell_add", { word }).catch(() => {});
        view.focus();
      },
    },
    { kind: "separator" },
  );
  return items;
}

view.dom.addEventListener("contextmenu", (e) => {
  if (e.shiftKey) return;
  e.preventDefault();

  // Word behavior: right-click outside the selection moves the cursor there;
  // inside the selection keeps it.
  const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
  if (pos !== null) {
    const sel = view.state.selection.main;
    if (pos < sel.from || pos > sel.to) {
      view.dispatch({ selection: { anchor: pos } });
    }
  }

  void openEditorContextMenu(e, pos);
});

interface ImageInfo {
  from: number;
  to: number;
  src: string;
  alt: string;
  width: string;
}

/** Resolve the image markdown/HTML at a right-clicked rendered image. */
function imageAt(target: EventTarget | null): ImageInfo | null {
  if (!(target instanceof HTMLElement)) return null;
  const imgEl = target.closest("img.cm-live-image");
  if (imgEl === null) return null;
  const pos = view.posAtDOM(imgEl);
  const line = view.state.doc.lineAt(pos);
  const re = /!\[[^\]]*\]\([^)]*\)|<img\b[^>]*>/gi;
  for (const m of line.text.matchAll(re)) {
    const from = line.from + (m.index ?? 0);
    const to = from + m[0].length;
    if (pos < from || pos > to) continue;
    const t = m[0];
    if (t.startsWith("![")) {
      const close = t.indexOf("](");
      return {
        from,
        to,
        alt: t.slice(2, close),
        src: t.slice(close + 2, t.length - 1).split(/\s+/)[0],
        width: "",
      };
    }
    return {
      from,
      to,
      src:
        /\bsrc\s*=\s*"([^"]*)"/.exec(t)?.[1] ??
        /\bsrc\s*=\s*'([^']*)'/.exec(t)?.[1] ??
        "",
      alt: /\balt\s*=\s*"([^"]*)"/.exec(t)?.[1] ?? "",
      width: /\bwidth\s*=\s*"?([\d%]+)/.exec(t)?.[1] ?? "",
    };
  }
  return null;
}

/** Rewrite an image with a new width (px number or "100%"), or null to reset
 * to a plain markdown image at natural size. */
function rewriteImage(info: ImageInfo, width: string | null) {
  const insert =
    width === null
      ? `![${info.alt}](${info.src})`
      : `<img src="${info.src}" alt="${info.alt}" width="${width}">`;
  view.dispatch({
    changes: { from: info.from, to: info.to, insert },
    userEvent: "input.format",
  });
  view.focus();
}

/** Wrap the image's paragraph in a <div align> block. */
function alignImageAt(info: ImageInfo, align: "left" | "center" | "right") {
  view.dispatch({ selection: { anchor: info.from } });
  setAlignment(align)({
    state: view.state,
    dispatch: (tr) => view.dispatch(tr),
  });
  view.focus();
}

function imageMenuItems(target: EventTarget | null): MenuItem[] | null {
  const info = imageAt(target);
  if (info === null) return null;
  const size = (label: string, w: string | null): MenuItem => ({
    kind: "item",
    label,
    strong: info.width === (w ?? ""),
    action: () => rewriteImage(info, w),
  });
  return [
    size("Small (200 px)", "200"),
    size("Medium (400 px)", "400"),
    size("Large (640 px)", "640"),
    size("Full width", "100%"),
    size("Original size", null),
    { kind: "separator" },
    {
      kind: "item",
      label: "Align left",
      action: () => alignImageAt(info, "left"),
    },
    {
      kind: "item",
      label: "Center",
      action: () => alignImageAt(info, "center"),
    },
    {
      kind: "item",
      label: "Align right",
      action: () => alignImageAt(info, "right"),
    },
  ];
}

async function openEditorContextMenu(e: MouseEvent, pos: number | null) {
  const state = view.state;
  const hasSel = !state.selection.main.empty;
  const items: MenuItem[] = [];

  const imageItems = imageMenuItems(e.target);

  // Inside a table widget: the table actions join the general menu as a
  // submenu (cell spelling stays on Shift+right-click's native menu).
  const tableItems = tableMenuItems(view, e.target);
  if (imageItems !== null) {
    items.push({ kind: "submenu", label: "Image", items: imageItems });
    items.push({ kind: "separator" });
  } else if (tableItems !== null) {
    items.push({ kind: "submenu", label: "Table", items: tableItems });
    items.push({ kind: "separator" });
  } else if (pos !== null) {
    items.push(...(await spellingItems(pos)));
  }

  const region = regionAt(
    parseCritic(state.doc.toString()),
    state.selection.main.head,
  );
  if (region !== null) {
    items.push(
      {
        kind: "item",
        label: "Accept change",
        hint: "✓",
        action: formatButtons.accept,
      },
      {
        kind: "item",
        label: "Reject change",
        hint: "✗",
        action: formatButtons.reject,
      },
      { kind: "separator" },
    );
  }

  items.push(
    {
      kind: "row",
      buttons: [
        {
          html: "<b>B</b>",
          title: "Bold (Ctrl+B)",
          action: formatButtons.bold,
        },
        {
          html: "<i>I</i>",
          title: "Italic (Ctrl+I)",
          action: formatButtons.italic,
        },
        {
          html: "<u>U</u>",
          title: "Underline (Ctrl+U)",
          action: formatButtons.underline,
        },
        {
          html: "<s>S</s>",
          title: "Strikethrough (Ctrl+Shift+X)",
          action: formatButtons.strike,
        },
        {
          html: '<span class="hl-glyph">ab</span>',
          title: "Highlight (Ctrl+Alt+H)",
          action: formatButtons.highlight,
        },
        {
          html: '<span class="script-glyph">x<sub>2</sub></span>',
          title: "Subscript (Ctrl+=)",
          action: formatButtons.subscript,
        },
        {
          html: '<span class="script-glyph">x<sup>2</sup></span>',
          title: "Superscript (Ctrl+Shift+=)",
          action: formatButtons.superscript,
        },
        {
          html: "&#8730;<i>x</i>",
          title: "Insert equation (Ctrl+M)",
          action: formatButtons.math,
        },
      ],
    },
    { kind: "submenu", label: "Change case", items: caseMenuItems() },
    { kind: "separator" },
    {
      kind: "item",
      label: "Cut",
      hint: "Ctrl+X",
      disabled: !hasSel,
      action: () => void clipboardCut(),
    },
    {
      kind: "item",
      label: "Copy",
      hint: "Ctrl+C",
      disabled: !hasSel,
      action: () => void clipboardCopy(),
    },
    {
      kind: "item",
      label: "Paste",
      hint: "Ctrl+V",
      action: () => void menuPasteRich(),
    },
    {
      kind: "item",
      label: "Paste without formatting",
      hint: "Ctrl+Shift+V",
      action: () => void clipboardPaste(),
    },
    { kind: "separator" },
    {
      kind: "item",
      label: "Link…",
      hint: "Ctrl+K",
      action: formatButtons.link,
    },
    {
      kind: "item",
      label: "Add comment",
      hint: "Ctrl+Shift+M",
      disabled: !hasSel,
      action: formatButtons.comment,
    },
    {
      kind: "item",
      label: "Insert table",
      action: runInEditor(insertTable),
    },
    {
      kind: "item",
      label: "Table of contents (insert / update)",
      action: runInEditor(insertTableOfContents),
    },
    {
      kind: "item",
      label: "Insert page break",
      hint: "Ctrl+Enter",
      action: runInEditor(insertPageBreak),
    },
    { kind: "separator" },
    { kind: "note", label: "More spelling options: Shift+right-click" },
  );

  showContextMenu(e.clientX, e.clientY, items);
}

// Capture-phase, window-level shortcuts so they work regardless of focus and
// run before CodeMirror's own keymap sees the event.
window.addEventListener(
  "keydown",
  (e) => {
    if (e.key === "Escape" && !tablePicker.hidden) {
      hideTablePicker();
      return;
    }
    if (e.key === "Escape" && !settingsMenu.hidden) {
      toggleSettingsMenu(false);
      return;
    }
    if (e.key === "Escape" && !printPreview.hidden) {
      e.preventDefault();
      closePreview();
      return;
    }
    if (!(e.ctrlKey || e.metaKey)) return;
    const key = e.key.toLowerCase();
    // Ctrl+Q toggles live/raw ("Quelltext"); Ctrl+E belongs to centering.
    if (key === "q" && !e.shiftKey) {
      e.preventDefault();
      toggleLiveView();
      return;
    }
    // Zoom: Ctrl +/- and Ctrl+0 (Word/browser convention).
    if (key === "=" || key === "+") {
      e.preventDefault();
      setZoom(zoom + 10);
      return;
    }
    if (key === "-") {
      e.preventDefault();
      setZoom(zoom - 10);
      return;
    }
    if (key === "0") {
      e.preventDefault();
      setZoom(100);
      return;
    }
    const action =
      key === "n"
        ? "new"
        : key === "o"
          ? "open"
          : key === "s" && e.shiftKey
            ? "save-as"
            : key === "s"
              ? "save"
              : null;
    if (action) {
      e.preventDefault();
      actions[action]();
    }
  },
  { capture: true },
);

// First, and before either startup path runs: until this listener exists this
// window cannot acknowledge a flush, and Rust declines to install while any
// window is in that state. The registration is an IPC round trip, so the gap
// cannot be closed entirely — only kept as short as possible.
setupRecoveryFlush();
setupWindowControls();
setupCloseGuard();
applyViewClass();
applyZoom();
refreshTitle();
refreshModeButtons();
refreshComments();
refreshReviewButtons();
refreshPageIndicator();
refreshStyleButton();
refreshWordCount();
schedulePagination(500);
view.focus();

// STARTUP MODALS, IN A DEFINED ORDER.
//
// Three things can raise a modal at startup: the name prompt, the recovery prompt
// inside startupOpen, and the update-consent dialog. They use three different
// <dialog> elements, so nothing stops them stacking — a second showModal() simply
// opens on top of the first.
//
// The rule imposed here is that consent goes last, after both of the others have
// settled. It is the only one of the three that is not about the document in front
// of the user, so it is the one that must wait; and asking for permission to talk
// to the network on top of "recover your unsaved work?" would be the worst of the
// possible orders.
//
// `allSettled`, not `all`: a rejection in either of the first two must not swallow
// the consent question. Deliberately NOT restructured into a single sequential
// chain — the name prompt and startupOpen keep running concurrently exactly as
// they did before, because making them sequential would quietly change existing
// behaviour (see the note about their stacking in the step-5b report).
const namePrompted: Promise<unknown> = localStorage.getItem(AUTHOR_KEY)?.trim()
  ? Promise.resolve()
  : // First startup: ask for the name once; it signs all comments and replies.
    promptForName().then((name) => {
      if (name !== null) {
        localStorage.setItem(AUTHOR_KEY, name);
        refreshComments();
      }
      view.focus();
    });

// Main window: offer to restore unsaved work from a crashed/forced-closed
// session, then reopen the last document. Other windows: load whatever they
// were opened for (a file, or a draft to recover).
const startupOpened: Promise<unknown> = isMainWindow
  ? startupOpen()
  : startupChild();

void Promise.allSettled([namePrompted, startupOpened]).then(startupUpdateFlow);
