import { describe, expect, it } from "vitest";
import { formatShortcut, MAC_OVERRIDES } from "./platform";

describe("formatShortcut", () => {
  it("leaves Windows/Linux labels untouched", () => {
    expect(formatShortcut("Bold (Ctrl+B)", false)).toBe("Bold (Ctrl+B)");
    expect(formatShortcut("Ctrl+Shift+X", false)).toBe("Ctrl+Shift+X");
  });

  it("uses the ⌘ symbol form on macOS", () => {
    expect(formatShortcut("Bold (Ctrl+B)", true)).toBe("Bold (⌘B)");
    expect(formatShortcut("Ctrl+Shift+X", true)).toBe("⇧⌘X");
    expect(formatShortcut("Ctrl+Shift+=", true)).toBe("⇧⌘=");
    expect(formatShortcut("Ctrl+=", true)).toBe("⌘=");
    expect(formatShortcut("Ctrl+-", true)).toBe("⌘-");
    expect(formatShortcut("Ctrl+0", true)).toBe("⌘0");
    expect(formatShortcut("Ctrl+Enter", true)).toBe("⌘↩");
    expect(formatShortcut("Ctrl+click to open", true)).toBe("⌘-click to open");
  });

  it("orders modifiers the Apple way: Option, Shift, Command", () => {
    expect(formatShortcut("Ctrl+Shift+Alt+K", true)).toBe("⌥⇧⌘K");
  });

  it("applies the Mac alternatives for keys macOS reserves", () => {
    expect(formatShortcut("Insert equation (Ctrl+M)", true)).toBe(
      "Insert equation (⌥⌘E)",
    );
    expect(formatShortcut("Highlight (Ctrl+Alt+H)", true)).toBe(
      "Highlight (⇧⌘H)",
    );
    expect(formatShortcut("Inline code (Ctrl+`)", true)).toBe(
      "Inline code (⇧⌘C)",
    );
    expect(formatShortcut("source (Ctrl+Q)", true)).toBe("source (⌘/)");
  });

  it("moves headings off the macOS screenshot keys", () => {
    expect(formatShortcut("Heading 3 (Ctrl+Shift+3)", true)).toBe(
      "Heading 3 (⌥⌘3)",
    );
    expect(formatShortcut("Body text (Ctrl+Shift+0)", true)).toBe(
      "Body text (⌥⌘0)",
    );
  });

  it("does not confuse Ctrl+Shift+M (comment) with the Ctrl+M override", () => {
    expect(formatShortcut("press Ctrl+Shift+M or", true)).toBe("press ⇧⌘M or");
  });

  it("rewrites several shortcuts in one text", () => {
    expect(
      formatShortcut("Click to edit directly (Ctrl+Shift+E). Or Ctrl+S.", true),
    ).toBe("Click to edit directly (⇧⌘E). Or ⌘S.");
  });

  it("every override maps a Windows form to a different Windows form", () => {
    for (const [win, mac] of Object.entries(MAC_OVERRIDES)) {
      expect(win).toMatch(/^Ctrl\+/);
      expect(mac).toMatch(/^Ctrl\+/);
      expect(mac).not.toBe(win);
    }
  });
});
