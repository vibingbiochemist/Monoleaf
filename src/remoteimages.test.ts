// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import {
  blockRemoteContent,
  isRemoteUrl,
  loadRemoteImagePreference,
  remoteImagesAllowed,
  setRemoteImagesAllowed,
  storeRemoteImagePreference,
  stripRemoteUrls,
} from "./remoteimages";
import { sanitizeDocumentHtml } from "./sanitize";

describe("isRemoteUrl", () => {
  it("treats anything that leaves the machine as remote", () => {
    for (const url of [
      "https://evil.example/x.png",
      "http://evil.example/x.png",
      "HTTPS://EVIL.EXAMPLE/x.png",
      "  https://evil.example/x.png  ",
      "//evil.example/x.png", // protocol-relative
    ]) {
      expect(isRemoteUrl(url), url).toBe(true);
    }
  });

  it("treats inline and app-local references as local", () => {
    for (const url of [
      "data:image/png;base64,iVBORw0KGgo=",
      "images/diagram.png",
      "./diagram.png",
      "/assets/logo.svg",
      "",
    ]) {
      expect(isRemoteUrl(url), url).toBe(false);
    }
  });
});

describe("the preference", () => {
  it("defaults to off, and only an explicit true enables it", () => {
    const store = (value: string | null) => ({ getItem: () => value });
    expect(loadRemoteImagePreference(store(null))).toBe(false);
    expect(loadRemoteImagePreference(store("false"))).toBe(false);
    expect(loadRemoteImagePreference(store("yes"))).toBe(false);
    expect(loadRemoteImagePreference(store("true"))).toBe(true);
  });

  it("round-trips through storage", () => {
    const written: Record<string, string> = {};
    const store = { setItem: (k: string, v: string) => (written[k] = v) };
    storeRemoteImagePreference(true, store);
    expect(Object.values(written)).toEqual(["true"]);
    storeRemoteImagePreference(false, store);
    expect(Object.values(written)).toEqual(["false"]);
  });
});

describe("stripRemoteUrls", () => {
  it("removes remote url() but keeps everything else in the declaration", () => {
    expect(stripRemoteUrls("background:url(https://evil.example/x.png)")).toBe(
      "background:none",
    );
    expect(stripRemoteUrls("background:url('https://evil.example/x')")).toBe(
      "background:none",
    );
    expect(stripRemoteUrls('background:url("//evil.example/x")')).toBe(
      "background:none",
    );
    // The border styles inline table rendering depends on must survive.
    expect(stripRemoteUrls("border:1px solid #b0b0b0;padding:4pt")).toBe(
      "border:1px solid #b0b0b0;padding:4pt",
    );
    // A data: URI reaches no network.
    const inline = "background:url(data:image/gif;base64,R0lGOD)";
    expect(stripRemoteUrls(inline)).toBe(inline);
  });
});

describe("blockRemoteContent", () => {
  // Elements are built directly rather than parsed from HTML: a bare <td> is
  // dropped by the parser outside a table, and this is also exactly what the
  // sanitizer hook passes in — a live element, not markup.
  const make = (tag: string, attrs: Record<string, string>): Element => {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    return el;
  };

  it("strips every attribute that would issue a request", () => {
    for (const [tag, attr] of [
      ["img", "src"],
      ["img", "srcset"],
      ["source", "src"],
      ["source", "srcset"],
      ["image", "href"],
    ]) {
      const label = `<${tag} ${attr}>`;
      const node = make(tag, { [attr]: "https://evil.example/x.png" });
      expect(blockRemoteContent(node), label).toBe(true);
      expect(node.getAttribute(attr), label).toBeNull();
      expect(node.hasAttribute("data-remote-blocked"), label).toBe(true);
      // The URL is kept so the placeholder can say what was not loaded.
      expect(node.getAttribute("data-blocked-src"), label).toContain(
        "evil.example",
      );
    }
  });

  it("closes the inline-style channel", () => {
    // Inline styles survive sanitizing on purpose (PDF table borders), so this
    // would otherwise fetch even with every src stripped.
    const node = make("td", {
      style: "background:url(https://evil.example/x)",
    });
    expect(blockRemoteContent(node)).toBe(true);
    expect(node.getAttribute("style")).not.toContain("evil.example");
  });

  it("leaves local and inline references alone", () => {
    const cases: [string, Record<string, string>][] = [
      ["img", { src: "images/local.png" }],
      ["img", { src: "data:image/gif;base64,R0lGOD" }],
      ["td", { style: "border:1px solid #b0b0b0" }],
    ];
    for (const [tag, attrs] of cases) {
      const node = make(tag, attrs);
      const label = `${tag} ${JSON.stringify(attrs)}`;
      expect(blockRemoteContent(node), label).toBe(false);
      expect(node.hasAttribute("data-remote-blocked"), label).toBe(false);
    }
  });
});

describe("sanitizeDocumentHtml honours the setting", () => {
  beforeEach(() => setRemoteImagesAllowed(false));

  it("blocks remote images in raw HTML by default", () => {
    // Raw <img> bypasses markdown-it's image rule, so the sanitizer is the only
    // thing standing between a hostile document and a request.
    const out = sanitizeDocumentHtml(
      '<p><img src="https://evil.example/t.png"></p>',
    );
    // No src attribute at all: that is what would have issued the request. The
    // URL itself survives in data-blocked-src on purpose, for the placeholder.
    expect(out).not.toMatch(/\ssrc=/);
    expect(out).toMatch(/data-remote-blocked/);
  });

  it("blocks a remote url() in an inline style by default", () => {
    const out = sanitizeDocumentHtml(
      '<td style="background:url(https://evil.example/x)">a</td>',
    );
    expect(out).not.toContain("url(https://evil.example");
  });

  it("loads remote images once enabled", () => {
    setRemoteImagesAllowed(true);
    const out = sanitizeDocumentHtml('<img src="https://cdn.example/ok.png">');
    expect(out).toContain("https://cdn.example/ok.png");
    expect(out).not.toContain("data-remote-blocked");
  });

  it("still strips script and event handlers either way", () => {
    for (const allowed of [false, true]) {
      setRemoteImagesAllowed(allowed);
      expect(remoteImagesAllowed()).toBe(allowed);
      const out = sanitizeDocumentHtml(
        '<img src="https://x.example/a.png" onerror="alert(1)"><script>alert(2)</script>',
      );
      expect(out, String(allowed)).not.toMatch(/onerror/i);
      expect(out, String(allowed)).not.toMatch(/<script/i);
    }
  });

  it("keeps data: images regardless of the setting", () => {
    const out = sanitizeDocumentHtml(
      '<img src="data:image/gif;base64,R0lGOD">',
    );
    expect(out).toContain("data:image/gif");
  });
});
