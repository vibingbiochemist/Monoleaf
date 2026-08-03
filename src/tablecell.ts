/**
 * Display rendering for GFM table cells.
 *
 * Tables written by other tools routinely put inline HTML and HTML entity
 * references inside cells — `<br>` for a line break within a cell, `&nbsp;`
 * for indentation of sub-rows. GitHub renders both, and so does our export
 * path (markdown-it with `html: true`, then DOMPurify). The live-view table
 * widget assigned cell text with `textContent`, so it showed the literal
 * `<br>` / `&nbsp;` and disagreed with the PDF. These helpers close that gap.
 *
 * Scope is deliberately narrow: inline HTML from the allow-list below, plus
 * entity references. Markdown syntax inside a cell (`**bold**`) is still shown
 * literally, exactly as before — this module changes how incoming GFM is
 * DISPLAYED and never what we write. The widget reveals the raw source while a
 * cell is focused, so editing round-trips the original `<br>` / `&nbsp;`.
 *
 * Safety: the output is sanitized BY CONSTRUCTION rather than by filtering.
 * Only the tag names below can ever be emitted, always without attributes;
 * every other byte goes through escapeHtml. There is no path by which markup
 * from the document reaches the DOM verbatim, so a hostile cell (`<script>`,
 * `<img onerror=…>`, `javascript:`) renders as visible literal text.
 */

/**
 * Inline tags rendered inside cells. The five the GFM gap is really about are
 * br/sub/sup/u/mark; the rest are inline formatting tags that our export
 * already renders, so leaving them literal in the editor would be the same
 * editor-vs-PDF disagreement. Nothing here can carry attributes or children
 * that affect anything outside the cell.
 */
const INLINE_TAGS = [
  "br",
  "sub",
  "sup",
  "u",
  "mark",
  "b",
  "strong",
  "i",
  "em",
  "s",
  "del",
  "ins",
  "code",
  "small",
  "kbd",
] as const;

const VOID_TAGS = new Set(["br"]);

// <tag>, </tag>, <tag/>, <tag attr="…"> — attributes are matched so the tag is
// recognized, then dropped. `[^<>]` keeps the match from spanning tags.
const TAG_RE = new RegExp(
  `<(/?)(${INLINE_TAGS.join("|")})(\\s[^<>]*?)?\\s*(/?)>`,
  "gi",
);

/**
 * Named entities we decode. Not the full HTML5 set (that would mean pulling in
 * an entity package); this is the practical range for prose and scientific
 * tables. An unrecognized name is left as literal text, which is safe and
 * visible rather than silently wrong.
 */
const NAMED_ENTITIES: Record<string, string> = {
  // Markup-significant
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  // Spaces — the reason sub-row indentation works on GitHub
  nbsp: " ",
  ensp: " ",
  emsp: " ",
  thinsp: " ",
  hairsp: " ",
  zwnj: "‌",
  zwj: "‍",
  shy: "­",
  // Dashes, quotes, punctuation
  ndash: "–",
  mdash: "—",
  horbar: "―",
  hellip: "…",
  lsquo: "‘",
  rsquo: "’",
  sbquo: "‚",
  ldquo: "“",
  rdquo: "”",
  bdquo: "„",
  laquo: "«",
  raquo: "»",
  lsaquo: "‹",
  rsaquo: "›",
  dagger: "†",
  Dagger: "‡",
  bull: "•",
  middot: "·",
  sect: "§",
  para: "¶",
  prime: "′",
  Prime: "″",
  oline: "‾",
  // Symbols and marks
  copy: "©",
  reg: "®",
  trade: "™",
  euro: "€",
  pound: "£",
  yen: "¥",
  cent: "¢",
  curren: "¤",
  deg: "°",
  micro: "µ",
  permil: "‰",
  // Maths and relations
  times: "×",
  divide: "÷",
  plusmn: "±",
  minus: "−",
  frac12: "½",
  frac14: "¼",
  frac34: "¾",
  sup1: "¹",
  sup2: "²",
  sup3: "³",
  le: "≤",
  ge: "≥",
  ne: "≠",
  equiv: "≡",
  asymp: "≈",
  prop: "∝",
  infin: "∞",
  radic: "√",
  sum: "∑",
  prod: "∏",
  int: "∫",
  part: "∂",
  nabla: "∇",
  isin: "∈",
  notin: "∉",
  cap: "∩",
  cup: "∪",
  // Arrows
  larr: "←",
  rarr: "→",
  uarr: "↑",
  darr: "↓",
  harr: "↔",
  lArr: "⇐",
  rArr: "⇒",
  hArr: "⇔",
  // Greek (common in assay/statistics tables)
  alpha: "α",
  beta: "β",
  gamma: "γ",
  delta: "δ",
  epsilon: "ε",
  zeta: "ζ",
  eta: "η",
  theta: "θ",
  kappa: "κ",
  lambda: "λ",
  mu: "μ",
  nu: "ν",
  pi: "π",
  rho: "ρ",
  sigma: "σ",
  tau: "τ",
  phi: "φ",
  chi: "χ",
  psi: "ψ",
  omega: "ω",
  Alpha: "Α",
  Beta: "Β",
  Gamma: "Γ",
  Delta: "Δ",
  Theta: "Θ",
  Lambda: "Λ",
  Pi: "Π",
  Sigma: "Σ",
  Phi: "Φ",
  Psi: "Ψ",
  Omega: "Ω",
};

const ENTITY_RE = /&(#[0-9]+|#[xX][0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g;

function codePointText(raw: string): string | null {
  const cp =
    raw[1] === "x" || raw[1] === "X"
      ? Number.parseInt(raw.slice(2), 16)
      : Number.parseInt(raw.slice(1), 10);
  // Reject NUL, surrogates and out-of-range: String.fromCodePoint would throw
  // or produce a lone surrogate.
  if (!Number.isFinite(cp) || cp <= 0 || cp > 0x10ffff) return null;
  if (cp >= 0xd800 && cp <= 0xdfff) return null;
  return String.fromCodePoint(cp);
}

/**
 * Resolve entity references to the characters they denote. Single pass, so
 * `&amp;nbsp;` correctly yields the literal text `&nbsp;` and is not decoded
 * twice.
 */
export function decodeEntities(text: string): string {
  return text.replace(ENTITY_RE, (whole, body: string) => {
    if (body.startsWith("#")) return codePointText(body) ?? whole;
    // HTML named entities are case-sensitive (&Omega; ≠ &omega;).
    return NAMED_ENTITIES[body] ?? whole;
  });
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * True when the cell contains something that renders differently from its
 * source. Plain cells — the overwhelming majority — then keep the existing
 * `textContent` path untouched.
 */
export function cellHasRichContent(raw: string): boolean {
  TAG_RE.lastIndex = 0;
  if (TAG_RE.test(raw)) return true;
  return decodeEntities(raw) !== raw;
}

/**
 * Safe display HTML for one cell: allow-listed inline tags kept (stripped of
 * attributes), entities resolved, everything else escaped to literal text.
 */
export function cellDisplayHtml(raw: string): string {
  let out = "";
  let at = 0;
  TAG_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TAG_RE.exec(raw)) !== null) {
    out += escapeHtml(decodeEntities(raw.slice(at, m.index)));
    const closing = m[1] === "/";
    const name = m[2].toLowerCase();
    if (VOID_TAGS.has(name)) {
      // A stray "</br>" is a break on GitHub too; emit the void form.
      out += `<${name}>`;
    } else {
      out += closing ? `</${name}>` : `<${name}>`;
    }
    at = m.index + m[0].length;
  }
  out += escapeHtml(decodeEntities(raw.slice(at)));
  return out;
}

/**
 * The plain text a rendered cell reads back as — entities resolved, tags gone.
 * `<br>` contributes nothing, matching how `textContent` sees a real <br>.
 */
export function cellDisplayText(raw: string): string {
  return decodeEntities(raw.replace(TAG_RE, ""));
}
