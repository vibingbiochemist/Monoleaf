/**
 * Platform detection and shortcut labelling.
 *
 * Bindings are written once in Windows/Linux form ("Ctrl+B"); CodeMirror's
 * "Mod-" already maps to Cmd on a Mac, and the few bindings that collide with
 * macOS system shortcuts get a Mac alternative (MAC_OVERRIDES, mirrored by the
 * `mac:` fields of the keymap in main.ts). Every label shown to the user goes
 * through formatShortcut so a Mac user sees ⌘B rather than Ctrl+B.
 */

/** Inside Tauri's own webview (WKWebView on Mac) navigator.platform is
 * trustworthy; there is no arbitrary browser and no user-agent spoofing. */
export const isMac: boolean =
  typeof navigator !== "undefined" &&
  navigator.platform.toUpperCase().startsWith("MAC");

/** Windows: the only platform with a native spell checker behind the
 * `spell_check` / `spell_suggest` commands (see spellcheck.ts). */
export const isWindows: boolean =
  typeof navigator !== "undefined" &&
  navigator.platform.toUpperCase().startsWith("WIN");

/**
 * Windows binding → macOS binding, for the shortcuts whose Cmd equivalent is
 * taken by macOS itself (handled by the system or the default app menu before
 * the webview ever sees the key):
 *   Cmd+Q quits, Cmd+M minimises, Cmd+Option+H hides other apps, Cmd+` cycles
 *   windows.
 */
export const MAC_OVERRIDES: Readonly<Record<string, string>> = {
  "Ctrl+Q": "Ctrl+/", // live / raw view toggle (Typora's source-mode key)
  "Ctrl+M": "Ctrl+Alt+E", // insert equation
  "Ctrl+Alt+H": "Ctrl+Shift+H", // highlight
  "Ctrl+`": "Ctrl+Shift+C", // inline code
  // Headings: ⇧⌘3/4/5/6 are the system screenshot shortcuts, so all seven
  // move to ⌥⌘ digit — Word for Mac's own heading keys (⌥⌘1/2/3).
  "Ctrl+Shift+0": "Ctrl+Alt+0",
  "Ctrl+Shift+1": "Ctrl+Alt+1",
  "Ctrl+Shift+2": "Ctrl+Alt+2",
  "Ctrl+Shift+3": "Ctrl+Alt+3",
  "Ctrl+Shift+4": "Ctrl+Alt+4",
  "Ctrl+Shift+5": "Ctrl+Alt+5",
  "Ctrl+Shift+6": "Ctrl+Alt+6",
};

const MODIFIER_SYMBOL: Record<string, string> = {
  Ctrl: "⌘",
  Alt: "⌥",
  Shift: "⇧",
};
// Apple's canonical modifier order: Control, Option, Shift, Command.
const MODIFIER_ORDER = ["⌃", "⌥", "⇧", "⌘"];

const KEY_SYMBOL: Record<string, string> = {
  Enter: "↩",
  Backspace: "⌫",
};

// One shortcut in Windows notation: "Ctrl+B", "Ctrl+Shift+=", "Ctrl+`",
// "Ctrl+Enter", "Ctrl+click". The key is a word (Enter, click) or one char.
const SHORTCUT_RE = /Ctrl(?:\+(?:Shift|Alt))*\+(?:[A-Za-z]{2,}|[^\s()+])/g;

function macForm(win: string): string {
  const parts = (MAC_OVERRIDES[win] ?? win).split("+");
  const key = parts.pop() ?? "";
  if (key === "click") return "⌘-click";
  const mods = parts
    .map((m) => MODIFIER_SYMBOL[m] ?? m)
    .sort((a, b) => MODIFIER_ORDER.indexOf(a) - MODIFIER_ORDER.indexOf(b));
  return mods.join("") + (KEY_SYMBOL[key] ?? key.toUpperCase());
}

/**
 * Rewrite every Windows-style shortcut in `text` for the current platform:
 * unchanged on Windows/Linux, ⌘-symbol form (with the Mac overrides applied)
 * on macOS. Works on whole labels ("Bold (Ctrl+B)") as well as bare keys.
 */
export function formatShortcut(text: string, mac: boolean = isMac): string {
  if (!mac) return text;
  return text.replace(SHORTCUT_RE, (m) => macForm(m));
}

/**
 * Apply formatShortcut to the static labels in the page: tooltips (`title`)
 * and menu hints. Called once at startup; a no-op off macOS.
 */
export function localizeShortcutLabels(root: ParentNode = document): void {
  if (!isMac) return;
  root.querySelectorAll<HTMLElement>("[title]").forEach((el) => {
    el.title = formatShortcut(el.title);
  });
  root.querySelectorAll<HTMLElement>(".menu-hint").forEach((el) => {
    el.textContent = formatShortcut(el.textContent ?? "");
  });
}
