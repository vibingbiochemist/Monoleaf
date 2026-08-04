// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import {
  blockRemoteContent,
  decodeCssEscapes,
  isRemoteUrl,
  loadRemoteImagePreference,
  remoteImagesAllowed,
  setRemoteImagesAllowed,
  storeRemoteImagePreference,
  styleReferencesRemote,
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

describe("decodeCssEscapes", () => {
  it("resolves the escape forms a CSS parser resolves", () => {
    // Hex escape, with and without the optional trailing whitespace.
    expect(decodeCssEscapes("https\\3a //x")).toBe("https://x");
    expect(decodeCssEscapes("\\68 ttps://x")).toBe("https://x");
    // The hex run stops at the first non-hex character, so no whitespace is
    // needed to terminate it.
    expect(decodeCssEscapes("\\68ttps://x")).toBe("https://x");
    // A backslash before a non-hex character is just that character.
    expect(decodeCssEscapes("u\\rl")).toBe("url");
    expect(decodeCssEscapes("no escapes here")).toBe("no escapes here");
  });
});

describe("styleReferencesRemote", () => {
  it("sees through CSS escapes and past the url() token", () => {
    for (const style of [
      "background:url(https://evil.example/x.png)",
      "background:url('https://evil.example/x')",
      'background:url("//evil.example/x")',
      "background:url(https\\3a //evil.example/x.png)",
      "background:url(\\68 ttps://evil.example/x.png)",
      "background-image:image-set('https://evil.example/x.png' 1x)",
      "background:-webkit-image-set(url(//evil.example/x) 1x)",
    ]) {
      expect(styleReferencesRemote(style), style).toBe(true);
    }
  });

  it("leaves the declarations the renderer actually emits alone", () => {
    for (const style of [
      "border:1px solid #b0b0b0;padding:4pt",
      "border-left:4px solid #0969da;background:#ddf4ff;padding:6pt 12pt",
      "color:#2f8a52;font-style:italic",
      "text-align:right",
      // A data: URI carries its bytes inline and reaches no network.
      "background:url(data:image/gif;base64,R0lGOD)",
    ]) {
      expect(styleReferencesRemote(style), style).toBe(false);
    }
  });
});

// Elements are built directly rather than parsed from HTML: a bare <td> is
// dropped by the parser outside a table, and this is also exactly what the
// sanitizer hook passes in — a live element, not markup.
const make = (tag: string, attrs: Record<string, string>): Element => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
};

describe("blockRemoteContent", () => {
  it("strips every attribute that would issue a request", () => {
    for (const [tag, attr] of [
      ["img", "src"],
      ["img", "srcset"],
      ["source", "src"],
      ["source", "srcset"],
      ["image", "href"],
      ["image", "xlink:href"],
      ["feImage", "href"],
      ["use", "href"],
      // src/poster/background are swept on ANY tag: the sanitizer's allowlist
      // is not the thing keeping these out of the document.
      ["input", "src"],
      ["video", "poster"],
      ["table", "background"],
      ["td", "background"],
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

  it("closes the inline-style channel by dropping the whole attribute", () => {
    // Inline styles survive sanitizing on purpose (PDF table borders), so this
    // would otherwise fetch even with every src stripped. The attribute goes
    // entirely rather than being rewritten: see styleReferencesRemote.
    const node = make("td", {
      style: "background:url(https://evil.example/x);border:1px solid #000",
    });
    expect(blockRemoteContent(node)).toBe(true);
    expect(node.hasAttribute("style")).toBe(false);
  });

  it("blocks a remote candidate hiding behind a local one in srcset", () => {
    // A srcset is a candidate list, so testing it as a single URL misses this.
    const node = make("img", {
      srcset: "local.png 1x, https://evil.example/x.png 2x",
    });
    expect(blockRemoteContent(node)).toBe(true);
    expect(node.hasAttribute("srcset")).toBe(false);
  });

  it("leaves local and inline references alone", () => {
    const cases: [string, Record<string, string>][] = [
      ["img", { src: "images/local.png" }],
      ["img", { src: "data:image/gif;base64,R0lGOD" }],
      ["img", { srcset: "small.png 1x, large.png 2x" }],
      ["td", { style: "border:1px solid #b0b0b0" }],
      // href is only swept on image/feImage/use — stripping it here would
      // break every link in the document.
      ["a", { href: "https://example.com/page" }],
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

// ---------------------------------------------------------------------------
// data: URIs, which carry their bytes inline and reach no network.
//
// The base64 alphabet includes "/", so "//" occurs in ordinary PNG/JPEG data
// whenever three source bytes are 0xFF — routine. A rule that condemns any
// value containing "//" therefore strips exactly the images that need no
// network, and only with the setting OFF, which is backwards and contradicts
// this module's documented contract. One line per case.

type AttrCase = [label: string, tag: string, attr: string, value: string];

const DATA_URI_SURVIVES: AttrCase[] = [
  [
    "a base64 payload containing //",
    "img",
    "src",
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg////8AAAA",
  ],
  // The comma in ";base64," is not a candidate separator: splitting there makes
  // the payload its own token, and a payload that starts with 0xFF 0xFF 0xFF
  // then starts with "//".
  [
    "a base64 payload starting with // after the comma",
    "img",
    "src",
    "data:image/png;base64,//8AAAANSUhEUg",
  ],
  [
    "a css url() whose payload contains //",
    "td",
    "style",
    "background:url(data:image/png;base64,AA////BB)",
  ],
  [
    "a css url() whose payload has a comma then //",
    "td",
    "style",
    "background:url(data:image/png;base64,AA,//8AAA)",
  ],
  [
    "a srcset data: candidate beside a local one",
    "img",
    "srcset",
    "data:image/png;base64,AA//BB 1x, local.png 2x",
  ],
  [
    "a srcset with a single data: candidate",
    "img",
    "srcset",
    "data:image/png;base64,AA//BB 1x",
  ],
  [
    "a srcset data: candidate whose payload starts with //",
    "img",
    "srcset",
    "data:image/png;base64,//8ABB 1x, local.png 2x",
  ],
];

const STILL_CONDEMNED: AttrCase[] = [
  [
    "a remote candidate after a local one",
    "img",
    "srcset",
    "local.png 1x, https://tracker.test/x 2x",
  ],
  [
    "a remote candidate with no space after the comma",
    "img",
    "srcset",
    "local.png 1x,https://tracker.test/x 2x",
  ],
  [
    "a remote candidate after a data: candidate",
    "img",
    "srcset",
    "data:image/png;base64,AA//BB 1x, https://tracker.test/y 2x",
  ],
  [
    "a remote url() beside a data: url()",
    "td",
    "style",
    "background:url(data:image/png;base64,AA) , url(https://tracker.test/x)",
  ],
];

describe("a data: URI reaches no network, so it is never remote", () => {
  it.each(DATA_URI_SURVIVES)("keeps %s", (_label, tag, attr, value) => {
    const el = make(tag, { [attr]: value });
    expect(blockRemoteContent(el)).toBe(false);
    // Intact, not rewritten: the blunt whole-attribute rule stays.
    expect(el.getAttribute(attr)).toBe(value);
    expect(el.hasAttribute("data-remote-blocked")).toBe(false);
  });

  it.each(STILL_CONDEMNED)("still blocks %s", (_label, tag, attr, value) => {
    const el = make(tag, { [attr]: value });
    expect(blockRemoteContent(el)).toBe(true);
    expect(el.hasAttribute(attr)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The channel, end to end.

const TRACKER = "tracker.test";

/**
 * Every attribute of the sanitized output that still names the tracker host and
 * could make the engine issue a request.
 *
 * `data-*` is skipped: `data-blocked-src` keeps the URL on purpose so the
 * placeholder can say what was not loaded, and nothing ever fetches a data
 * attribute. Everything else counts — this asserts at the level of "no
 * attribute that would issue a request survives" rather than naming the
 * attribute each vector happened to use, so a variant of a known trick fails
 * the test too.
 */
function requestingAttributes(html: string): string[] {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const hits: string[] = [];
  for (const el of Array.from(doc.body.querySelectorAll("*"))) {
    for (const attr of Array.from(el.attributes)) {
      if (attr.name.startsWith("data-")) continue;
      if (attr.value.includes(TRACKER)) {
        hits.push(`<${el.tagName.toLowerCase()} ${attr.name}="${attr.value}">`);
      }
    }
  }
  return hits;
}

/** One line per vector. Add a row when a new one turns up. */
const REMOTE_VECTORS: [label: string, html: string][] = [
  ["img src", `<img src="https://${TRACKER}/beacon.png">`],
  ["img srcset", `<img srcset="https://${TRACKER}/beacon.png 1x">`],
  [
    "srcset hiding behind a local candidate",
    `<img srcset="local.png 1x, https://${TRACKER}/beacon.png 2x">`,
  ],
  [
    "source srcset in a picture",
    `<picture><source srcset="https://${TRACKER}/beacon.png"><img src="local.png"></picture>`,
  ],
  [
    "input type=image",
    `<input type="image" src="https://${TRACKER}/beacon.png">`,
  ],
  ["video poster", `<video poster="https://${TRACKER}/beacon.png"></video>`],
  [
    "css escape in the scheme",
    `<p style="background:url(https\\3a //${TRACKER}/beacon.png)">x</p>`,
  ],
  [
    "css escape in the host",
    `<p style="background:url(\\68 ttps://${TRACKER}/beacon.png)">x</p>`,
  ],
  [
    "image-set, which has no url() token",
    `<p style="background-image:image-set('https://${TRACKER}/beacon.png' 1x)">x</p>`,
  ],
  [
    "svg feImage href",
    `<svg><filter id="f"><feImage href="https://${TRACKER}/beacon.png"></feImage></filter></svg>`,
  ],
  [
    "svg use xlink:href",
    `<svg><use xlink:href="https://${TRACKER}/beacon.png"></use></svg>`,
  ],
  [
    "legacy background attribute",
    `<table background="https://${TRACKER}/beacon.png"><tbody><tr><td background="https://${TRACKER}/beacon.png">x</td></tr></tbody></table>`,
  ],
];

describe("no vector reaches the network with the setting off", () => {
  beforeEach(() => setRemoteImagesAllowed(false));

  it.each(REMOTE_VECTORS)("blocks %s", (_label, html) => {
    expect(requestingAttributes(sanitizeDocumentHtml(html))).toEqual([]);
  });

  /** What must NOT be collateral damage. */
  const KEPT: [label: string, html: string, expected: string][] = [
    [
      "a local relative src",
      '<img src="images/diagram.png">',
      'src="images/diagram.png"',
    ],
    [
      "a data: URI",
      '<img src="data:image/gif;base64,R0lGOD">',
      "data:image/gif;base64,R0lGOD",
    ],
    [
      "a style with no URL in it",
      '<table><tbody><tr><td style="border:0.75pt solid #b0b0b0;padding:4pt 7pt">x</td></tr></tbody></table>',
      "border:0.75pt solid #b0b0b0",
    ],
    [
      "an ordinary link",
      '<a href="https://example.com/page">x</a>',
      'href="https://example.com/page"',
    ],
  ];

  it.each(KEPT)("keeps %s", (_label, html, expected) => {
    expect(sanitizeDocumentHtml(html)).toContain(expected);
  });
});
