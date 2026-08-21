import {
  HighlightStyle,
  syntaxHighlighting,
  syntaxTree,
} from "@codemirror/language";
import { tags } from "@lezer/highlight";
import { isRemoteUrl, remoteImagesAllowed } from "./remoteimages";
import type { Tree } from "@lezer/common";
import {
  Decoration,
  DecorationSet,
  EditorView,
  ViewPlugin,
  ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import {
  EditorSelection,
  EditorState,
  Extension,
  Prec,
  Range,
  Transaction,
} from "@codemirror/state";
import { hideCommentSyntax } from "./comments";
import { hideCriticSyntax, parseCritic } from "./critic";
import {
  ADMONITIONS,
  admonitionKind,
  type AdmonitionKind,
} from "./admonitions";
import { pageBreaksField } from "./pagination";
import { tableExtensions } from "./tablewidget";
import { mathExtensions } from "./math";
import { footnoteExtensions } from "./footnotes";

/**
 * Silent WYSIWYG live preview: the raw markdown is the document, formatting
 * is applied as decorations, and syntax markers are hidden unconditionally —
 * the user edits the rendered text and the markdown underneath follows.
 * Hidden markers are atomic: the cursor skips over them and deletion treats
 * them as single units. Formatting is created via commands (see commands.ts),
 * or by typing raw syntax, which stays visible only until the construct
 * completes. A few deliberate exceptions keep cursor-line reveal, because they
 * are block metadata that would otherwise be hard to see or edit: code-fence
 * lines (the ``` and its language info), horizontal rules, and heading markers
 * (the "# " prefix) — revealed while the cursor is on the line so the level is
 * visible and editable, hidden (rendering the heading) once the cursor leaves.
 *
 * Because nothing here is a second view, toggling live preview on/off cannot
 * move the cursor: it is the same cursor in the same document, restyled.
 */

// ---------------------------------------------------------------------------
// Widgets

class BulletWidget extends WidgetType {
  eq() {
    return true;
  }
  toDOM() {
    const span = document.createElement("span");
    span.className = "cm-live-bullet";
    span.textContent = "•";
    return span;
  }
}

class CheckboxWidget extends WidgetType {
  constructor(readonly checked: boolean) {
    super();
  }
  eq(other: CheckboxWidget) {
    return other.checked === this.checked;
  }
  toDOM() {
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = this.checked;
    box.className = "cm-live-checkbox";
    return box;
  }
  // Let mousedown reach the plugin's event handler instead of being
  // swallowed as an internal widget event.
  ignoreEvent() {
    return false;
  }
}

class HrWidget extends WidgetType {
  eq() {
    return true;
  }
  toDOM() {
    const hr = document.createElement("span");
    hr.className = "cm-live-hr";
    return hr;
  }
}

/** Replaces the raw "[!NOTE]" marker with a coloured "ℹ️ Note" callout title. */
class AdmonitionTitleWidget extends WidgetType {
  constructor(readonly kind: AdmonitionKind) {
    super();
  }
  eq(other: AdmonitionTitleWidget) {
    return other.kind === this.kind;
  }
  toDOM() {
    const style = ADMONITIONS[this.kind];
    const span = document.createElement("span");
    span.className = `cm-live-adm-title cm-live-adm-title-${this.kind}`;
    span.textContent = `${style.icon} ${style.label}`;
    return span;
  }
}

class ImageWidget extends WidgetType {
  constructor(
    readonly url: string,
    readonly alt: string,
    readonly width: string,
  ) {
    super();
  }
  eq(other: ImageWidget) {
    return (
      other.url === this.url &&
      other.alt === this.alt &&
      other.width === this.width
    );
  }
  toDOM(view: EditorView) {
    const wrap = document.createElement("span");
    wrap.className = "cm-image-wrap";

    // A remote image the reader has not opted into is a *span*, not an <img>.
    // An <img> with no src draws the browser's broken-image glyph with the alt
    // text struck through it, which reads as an error when nothing is wrong —
    // and there is no image to resize, so the drag handle is skipped too.
    if (isRemoteUrl(this.url) && !remoteImagesAllowed()) {
      const blocked = document.createElement("span");
      blocked.className = "cm-image-blocked";
      blocked.dataset.blockedSrc = this.url;
      blocked.textContent = this.alt !== "" ? this.alt : "remote image";
      blocked.title = `Not loaded: ${this.url}\nTurn on “Load remote images” in settings to load it.`;
      wrap.appendChild(blocked);
      return wrap;
    }

    const img = document.createElement("img");
    img.className = "cm-live-image";
    img.src = this.url;
    img.alt = this.alt;
    if (this.alt !== "") img.title = this.alt;
    if (this.width !== "") {
      img.style.width = /^\d+$/.test(this.width)
        ? `${this.width}px`
        : this.width; // e.g. "100%"
    }
    wrap.appendChild(img);

    // Word-style drag handle (bottom-right corner) to resize by dragging.
    const handle = document.createElement("span");
    handle.className = "cm-image-handle";
    handle.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const startX = e.clientX;
      const startW = img.offsetWidth;
      const maxW =
        (wrap.parentElement?.clientWidth ?? 800) -
        (wrap.offsetLeft - (wrap.parentElement?.offsetLeft ?? 0));
      let committed = startW;
      const onMove = (ev: MouseEvent) => {
        committed = Math.max(
          40,
          Math.min(Math.round(startW + (ev.clientX - startX)), maxW),
        );
        img.style.width = `${committed}px`;
      };
      const onUp = () => {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        commitImageWidth(view, wrap, String(committed));
      };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    });
    wrap.appendChild(handle);
    return wrap;
  }
  ignoreEvent() {
    return true;
  }
}

/** Replace the image markdown/HTML at the widget's position with a sized
 * <img> reflecting a drag-resize. */
function commitImageWidth(
  view: EditorView,
  dom: HTMLElement,
  width: string,
): void {
  const pos = view.posAtDOM(dom);
  const line = view.state.doc.lineAt(pos);
  const re = /!\[[^\]]*\]\([^)]*\)|<img\b[^>]*>/gi;
  for (const m of line.text.matchAll(re)) {
    const from = line.from + (m.index ?? 0);
    const to = from + m[0].length;
    if (pos < from || pos > to) continue;
    const t = m[0];
    let src: string;
    let alt: string;
    if (t.startsWith("![")) {
      const c = t.indexOf("](");
      alt = t.slice(2, c);
      src = t.slice(c + 2, t.length - 1).split(/\s+/)[0];
    } else {
      src =
        /\bsrc\s*=\s*"([^"]*)"/.exec(t)?.[1] ??
        /\bsrc\s*=\s*'([^']*)'/.exec(t)?.[1] ??
        "";
      alt = /\balt\s*=\s*"([^"]*)"/.exec(t)?.[1] ?? "";
    }
    view.dispatch({
      changes: {
        from,
        to,
        insert: `<img src="${src}" alt="${alt}" width="${width}">`,
      },
      userEvent: "input.format",
    });
    return;
  }
}

/** Pull src / alt / width out of an <img …> tag; null if no src. */
function parseImgTag(
  text: string,
): { src: string; alt: string; width: string } | null {
  const src =
    /\bsrc\s*=\s*"([^"]*)"/.exec(text)?.[1] ??
    /\bsrc\s*=\s*'([^']*)'/.exec(text)?.[1];
  if (src === undefined) return null;
  const alt = /\balt\s*=\s*"([^"]*)"/.exec(text)?.[1] ?? "";
  const width = /\bwidth\s*=\s*"?([\d%]+)/.exec(text)?.[1] ?? "";
  return { src, alt, width };
}

class PageBreakDirectiveWidget extends WidgetType {
  eq() {
    return true;
  }
  toDOM() {
    const el = document.createElement("span");
    el.className = "cm-pagebreak-directive";
    el.textContent = "Page break";
    return el;
  }
}

// ---------------------------------------------------------------------------
// Decoration planning (pure; unit-testable without a view)

const hide = Decoration.replace({});
const bulletDeco = Decoration.replace({ widget: new BulletWidget() });
const hrDeco = Decoration.replace({ widget: new HrWidget() });
const subDeco = Decoration.mark({ class: "cm-live-sub" });
const supDeco = Decoration.mark({ class: "cm-live-sup" });
// Bold / italic / strikethrough are styled here in the decoration walk (like
// sub/sup) rather than via the syntax highlighter, so they can be suppressed
// inside CriticMarkup marks, where the *, _ and ~ are literal tracked text.
const strongDeco = Decoration.mark({ class: "cm-live-strong" });
const emphasisDeco = Decoration.mark({ class: "cm-live-em" });
const strikeDeco = Decoration.mark({ class: "cm-live-strike" });
const underlineDeco = Decoration.mark({ class: "cm-live-underline" });
const highlightDeco = Decoration.mark({ class: "cm-live-highlight" });

/** Link styling; with a URL, carries it for Ctrl+click open-in-browser
 * (handled in main.ts) and says so in the hover tooltip. */
function linkDeco(url: string | null): Decoration {
  if (url === null) return Decoration.mark({ class: "cm-live-link" });
  return Decoration.mark({
    class: "cm-live-link",
    attributes: {
      title: `Ctrl+click to open in your default browser:\n${url}`,
      "data-url": url,
    },
  });
}
const quoteLine = Decoration.line({ class: "cm-live-quote" });
const codeLine = Decoration.line({ class: "cm-live-codeblock" });
const frontmatterLine = Decoration.line({ class: "cm-live-frontmatter" });
const admonitionLineDeco: Record<AdmonitionKind, Decoration> = {
  note: Decoration.line({ class: "cm-live-adm cm-live-adm-note" }),
  tip: Decoration.line({ class: "cm-live-adm cm-live-adm-tip" }),
  important: Decoration.line({ class: "cm-live-adm cm-live-adm-important" }),
  warning: Decoration.line({ class: "cm-live-adm cm-live-adm-warning" }),
  caution: Decoration.line({ class: "cm-live-adm cm-live-adm-caution" }),
};
const admFirstLine = Decoration.line({ class: "cm-live-adm-first" });
const admLastLine = Decoration.line({ class: "cm-live-adm-last" });
const headingLines = [1, 2, 3, 4, 5, 6].map((n) =>
  Decoration.line({ class: `cm-live-heading cm-live-h${n}` }),
);

/**
 * Reveal-on-cursor for block metadata (fences, rules, directives): only an
 * actual cursor on the line reveals the raw syntax. Range selections keep
 * everything rendered — sweeping a selection across the document must not
 * flip it into raw markdown.
 */
function cursorOnLine(state: EditorState, pos: number) {
  const line = state.doc.lineAt(pos);
  return state.selection.ranges.some(
    (r) => r.empty && r.head >= line.from && r.head <= line.to,
  );
}

/** Extend a marker range over one following space, like Obsidian does. */
function withTrailingSpace(state: EditorState, from: number, to: number) {
  return {
    from,
    to: state.doc.sliceString(to, to + 1) === " " ? to + 1 : to,
  };
}

const ATX_HEADING = /^ATXHeading[1-6]$/;

export interface LivePreviewSets {
  /** Everything the view draws: hides, widgets, marks, line classes. */
  decorations: DecorationSet;
  /** The replaced ranges only, fed to EditorView.atomicRanges so the cursor
   * skips hidden syntax and deletion treats each marker as one unit. */
  atomics: DecorationSet;
}

/**
 * Offset just past a leading YAML front-matter block (`---` … `---`), or 0 when
 * the document does not open with one. Line-based so it stays cheap on big docs.
 */
function frontmatterEnd(state: EditorState): number {
  if (!/^---\r?$/.test(state.doc.line(1).text)) return 0;
  for (let n = 2; n <= state.doc.lines; n++) {
    const line = state.doc.line(n);
    if (/^---\r?$/.test(line.text)) {
      return line.to < state.doc.length ? line.to + 1 : line.to;
    }
  }
  return 0; // no closing fence — not front matter
}

export function buildLivePreviewDecorations(
  state: EditorState,
  from: number,
  to: number,
  tree: Tree = syntaxTree(state),
): LivePreviewSets {
  const ranges: Range<Decoration>[] = [];
  const atomics: Range<Decoration>[] = [];
  const quoteLines = new Set<number>();
  const codeLines = new Set<number>();
  const admonitionLines: {
    from: number;
    kind: AdmonitionKind;
    first: boolean;
    last: boolean;
  }[] = [];

  const hideRange = (hideFrom: number, hideTo: number, deco = hide) => {
    ranges.push(deco.range(hideFrom, hideTo));
    atomics.push(hide.range(hideFrom, hideTo));
  };

  // CriticMarkup marks ({++…++}, {--…--}, {~~old~>new~~}, …) contain literal
  // tildes/carets/asterisks in the tracked text. The markdown parser knows
  // nothing of CriticMarkup, so it emits Subscript/Superscript/Strikethrough/
  // Emphasis nodes over fragments of that text. A critic mark must be opaque to
  // the inline-markdown styler — only the critic decoration renders inside it —
  // so we skip any inline-style node that lies within a critic region.
  // parseCritic is the same range source the critic layer itself uses.
  const criticRegions = parseCritic(state.doc.toString());
  const inCriticMark = (nodeFrom: number, nodeTo: number) =>
    criticRegions.some((r) => r.from <= nodeFrom && nodeTo <= r.to);

  // Leading YAML front matter (the opt-in metadata format): style its lines as
  // a muted metadata block instead of letting `---` render as horizontal rules
  // and the key:value lines read as body text. Only relevant in the top chunk.
  const fmEnd = from === 0 ? frontmatterEnd(state) : 0;
  if (fmEnd > 0) {
    for (let n = 1; n <= state.doc.lines; n++) {
      const line = state.doc.line(n);
      if (line.from >= fmEnd) break;
      ranges.push(frontmatterLine.range(line.from));
    }
  }

  tree.iterate({
    from,
    to,
    enter: (node) => {
      // Inside the front-matter block, skip normal markdown handling so the
      // `---` fences stay as plain (styled) text rather than turning into rules.
      if (fmEnd > 0 && node.to <= fmEnd && node.name !== "Document") {
        return false;
      }

      const parent = node.node.parent;
      const parentName = parent?.name ?? "";

      switch (node.name) {
        // --- syntax markers, hidden unconditionally (silent WYSIWYG)
        case "EmphasisMark": // ** * _ __
        case "StrikethroughMark": // ~~
        case "SubscriptMark": // ~
        case "SuperscriptMark": // ^
          // Inside a critic mark these are literal characters of the tracked
          // text (or the critic delimiters, which the critic layer hides
          // itself) — never markdown syntax to hide.
          if (!inCriticMark(node.from, node.to)) hideRange(node.from, node.to);
          break;

        case "CodeMark":
          if (parentName === "InlineCode") {
            hideRange(node.from, node.to);
          } else if (parentName === "FencedCode") {
            // Block metadata exception: hide the whole fence line (``` plus
            // language info) but reveal it while the selection is on it, so
            // the language stays editable. The empty line keeps its height,
            // so hiding never reflows following lines.
            const line = state.doc.lineAt(node.from);
            if (!cursorOnLine(state, node.from)) {
              hideRange(line.from, line.to);
            }
          }
          break;

        case "Escape":
          // A backslash escape ("\*", "\#", …): hide the "\", show the char.
          hideRange(node.from, node.from + 1);
          break;

        case "HeaderMark":
          // ATX ("# …") hides the mark + its space; setext underline ("===" /
          // "---") is hidden whole. Both stay visible while the cursor is on
          // their line, so you can see the heading level (and its 1–6) and edit
          // it directly; they render once the cursor leaves. Level changes also
          // go through the heading commands (Ctrl+Shift+1–6).
          if (parent && ATX_HEADING.test(parentName)) {
            if (!cursorOnLine(state, node.from)) {
              const r = withTrailingSpace(state, node.from, node.to);
              hideRange(r.from, r.to);
            }
          } else if (parent && /^SetextHeading[12]$/.test(parentName)) {
            if (!cursorOnLine(state, node.from)) hideRange(node.from, node.to);
          }
          break;

        case "SetextHeading1":
        case "SetextHeading2": {
          // Size the heading's text line like the matching ATX level.
          const level = node.name.endsWith("1") ? 1 : 2;
          ranges.push(
            headingLines[level - 1].range(state.doc.lineAt(node.from).from),
          );
          break;
        }

        case "Image": {
          // https images render inline; other references (local files, etc.)
          // stay as their alt text — the .md holds only the reference either
          // way, never image bytes.
          const text = state.doc.sliceString(node.from, node.to);
          const close = text.indexOf("](");
          if (text.startsWith("![") && close >= 0) {
            const alt = text.slice(2, close);
            const url = text.slice(close + 2, text.length - 1).split(/\s+/)[0];
            if (/^https?:\/\//i.test(url)) {
              hideRange(
                node.from,
                node.to,
                Decoration.replace({ widget: new ImageWidget(url, alt, "") }),
              );
            } else {
              hideRange(node.from, node.from + 2); // "!["
              hideRange(node.from + close, node.to); // "](url …)"
            }
          }
          break;
        }

        case "LinkMark":
          // Inline links show only their text; the URL is edited via the
          // link command (Ctrl+K). Image marks are hidden by the Image case.
          if (parentName === "Link") {
            hideRange(node.from, node.to);
          }
          break;

        case "URL":
          if (parentName === "Link") {
            hideRange(node.from, node.to);
          } else if (parentName === "Image") {
            // Hidden by the Image case; nothing to do here.
          } else {
            // Bare autolink: the visible URL itself is Ctrl+clickable.
            const url = state.sliceDoc(node.from, node.to);
            ranges.push(linkDeco(url).range(node.from, node.to));
          }
          break;

        case "ListMark": {
          const isBullet = /^[-*+]$/.test(
            state.doc.sliceString(node.from, node.to),
          );
          const task = node.node.nextSibling;
          if (task?.name === "Task") {
            // Task item: replace "- [x] " (bullet through marker plus the
            // following space) with one real checkbox. In an ordered list
            // ("1. [x]"), the number stays and only the marker is replaced.
            const marker = task.getChild("TaskMarker");
            if (marker !== null) {
              const checked = /x/i.test(
                state.doc.sliceString(marker.from, marker.to),
              );
              const r = withTrailingSpace(
                state,
                isBullet ? node.from : marker.from,
                marker.to,
              );
              hideRange(
                r.from,
                r.to,
                Decoration.replace({ widget: new CheckboxWidget(checked) }),
              );
            }
          } else if (isBullet) {
            const r = withTrailingSpace(state, node.from, node.to);
            hideRange(r.from, r.to, bulletDeco);
          }
          break;
        }

        case "QuoteMark": {
          const r = withTrailingSpace(state, node.from, node.to);
          hideRange(r.from, r.to);
          break;
        }

        case "HTMLBlock": {
          const blockText = state.doc.sliceString(node.from, node.to);
          // A standalone <img …> block: render it (https) or hide it.
          const imgM = /<img\b[^>]*>/i.exec(blockText);
          if (imgM !== null) {
            const info = parseImgTag(imgM[0]);
            const from = node.from + imgM.index;
            const to = from + imgM[0].length;
            if (info !== null && /^https?:\/\//i.test(info.src)) {
              hideRange(
                from,
                to,
                Decoration.replace({
                  widget: new ImageWidget(info.src, info.alt, info.width),
                }),
              );
            } else {
              hideRange(from, to);
            }
            break;
          }
          // <div align="…"> blocks: hide the tag lines (always) and align
          // the enclosed lines.
          const m = /^<div align="(left|center|right|justify)">\s*$/.exec(
            blockText,
          );
          if (m === null) break;
          const openLine = state.doc.lineAt(node.from);
          let closeLine: { from: number; to: number } | null = null;
          for (
            let n = openLine.number + 1;
            n <= Math.min(state.doc.lines, openLine.number + 2000);
            n++
          ) {
            const l = state.doc.line(n);
            if (/^<\/div>\s*$/.test(l.text)) {
              closeLine = l;
              break;
            }
            if (/^<div align="/.test(l.text)) break;
          }
          if (closeLine === null) break;
          // Always hide the <div align> / </div> lines (never reveal on the
          // cursor line) — alignment is changed via the toolbar, not by hand
          // editing the tags, so revealing them just leaks raw markdown.
          hideRange(openLine.from, openLine.to);
          hideRange(closeLine.from, closeLine.to);
          const cls = Decoration.line({ class: `cm-align-${m[1]}` });
          for (
            let n = openLine.number + 1;
            n < state.doc.lineAt(closeLine.from).number;
            n++
          ) {
            ranges.push(cls.range(state.doc.line(n).from));
          }
          break;
        }

        case "HTMLTag": {
          const tag = state.sliceDoc(node.from, node.to);
          // Inline <img …>: render it (https) or hide it (no raw bleed).
          if (/^<img\b/i.test(tag)) {
            const info = parseImgTag(tag);
            if (info !== null && /^https?:\/\//i.test(info.src)) {
              hideRange(
                node.from,
                node.to,
                Decoration.replace({
                  widget: new ImageWidget(info.src, info.alt, info.width),
                }),
              );
            } else {
              hideRange(node.from, node.to);
            }
            break;
          }
          // Inline <u> / <mark>: hide the tag pair, style the content.
          const kind = tag === "<u>" ? "u" : tag === "<mark>" ? "mark" : null;
          if (kind !== null && parent !== null) {
            // Position math must count line breaks as 1 unit, so use
            // sliceString with the default separator, not sliceDoc.
            const rest = state.doc.sliceString(node.to, parent.to);
            const closeIdx = rest.indexOf(`</${kind}>`);
            if (closeIdx >= 0) {
              const closeFrom = node.to + closeIdx;
              hideRange(node.from, node.to);
              hideRange(closeFrom, closeFrom + kind.length + 3);
              if (closeFrom > node.to) {
                ranges.push(
                  (kind === "u" ? underlineDeco : highlightDeco).range(
                    node.to,
                    closeFrom,
                  ),
                );
              }
            }
          }
          break;
        }

        case "HardBreak": {
          // Hide the break's syntax ("\" or trailing spaces) but never the
          // line break itself (inline replacements must not cross lines).
          const lineEnd = state.doc.lineAt(node.from).to;
          const to = Math.min(node.to, lineEnd);
          if (to > node.from) hideRange(node.from, to);
          break;
        }

        case "HorizontalRule":
          // Block metadata exception: raw "---" shows while the cursor is
          // on its line, so it can be edited or removed in place.
          if (!cursorOnLine(state, node.from)) {
            hideRange(node.from, node.to, hrDeco);
          }
          break;

        case "CommentBlock": {
          const c = state.sliceDoc(node.from, node.to);
          if (c === "<!--ml:pagebreak-->") {
            // Explicit page break renders as a divider (atomic; never raw).
            hideRange(
              node.from,
              node.to,
              Decoration.replace({ widget: new PageBreakDirectiveWidget() }),
            );
          } else if (c === "<!--ml:toc-->" || c === "<!--ml:toc-end-->") {
            // TOC boundary markers stay hidden; the list between them shows.
            hideRange(node.from, node.to);
          } else if (c.startsWith("<!--ml:meta ")) {
            // Document metadata (default format): hidden like the page-config
            // marker; edited via File ▸ Document properties. Reveal it on its
            // line so it can still be removed by hand.
            if (!cursorOnLine(state, node.from)) hideRange(node.from, node.to);
          } else if (c.startsWith("<!--ml:page ")) {
            // Page config: edited via File ▸ Page setup… or the toolbar font
            // picker, not by hand — hidden the same way ml:meta is, revealed
            // on its own line so it can still be inspected or removed.
            if (!cursorOnLine(state, node.from)) hideRange(node.from, node.to);
          }
          break;
        }

        // --- construct-level styling and line classes
        case "ATXHeading1":
        case "ATXHeading2":
        case "ATXHeading3":
        case "ATXHeading4":
        case "ATXHeading5":
        case "ATXHeading6": {
          // Line class for document-like spacing above/below headings.
          const level = Number(node.name.slice(-1));
          ranges.push(
            headingLines[level - 1].range(state.doc.lineAt(node.from).from),
          );
          break;
        }

        case "Link": {
          const urlNode = node.node.getChild("URL");
          const url =
            urlNode === null ? null : state.sliceDoc(urlNode.from, urlNode.to);
          ranges.push(linkDeco(url).range(node.from, node.to));
          break;
        }
        case "Subscript":
          if (!inCriticMark(node.from, node.to)) {
            ranges.push(subDeco.range(node.from, node.to));
          }
          break;
        case "Superscript":
          if (!inCriticMark(node.from, node.to)) {
            ranges.push(supDeco.range(node.from, node.to));
          }
          break;
        case "StrongEmphasis":
          if (!inCriticMark(node.from, node.to)) {
            ranges.push(strongDeco.range(node.from, node.to));
          }
          break;
        case "Emphasis":
          if (!inCriticMark(node.from, node.to)) {
            ranges.push(emphasisDeco.range(node.from, node.to));
          }
          break;
        case "Strikethrough":
          if (!inCriticMark(node.from, node.to)) {
            ranges.push(strikeDeco.range(node.from, node.to));
          }
          break;

        case "Blockquote": {
          const first = state.doc.lineAt(node.from);
          const kind = admonitionKind(first.text);
          if (kind !== null) {
            // Callout: collect the block's lines, then swap the raw "[!TYPE]"
            // marker for a coloured title — unless the cursor is on that line,
            // where it stays raw so the type can be edited or removed.
            const starts: number[] = [];
            let p = node.from;
            while (p <= node.to && p <= state.doc.length) {
              const line = state.doc.lineAt(p);
              starts.push(line.from);
              if (line.to >= node.to) break;
              p = line.to + 1;
            }
            starts.forEach((from, idx) =>
              admonitionLines.push({
                from,
                kind,
                first: idx === 0,
                last: idx === starts.length - 1,
              }),
            );
            if (!cursorOnLine(state, first.from)) {
              const markerStart = first.from + first.text.indexOf("[!");
              hideRange(
                markerStart,
                first.to,
                Decoration.replace({
                  widget: new AdmonitionTitleWidget(kind),
                }),
              );
            }
            break;
          }
          let pos = node.from;
          while (pos <= node.to && pos <= state.doc.length) {
            const line = state.doc.lineAt(pos);
            quoteLines.add(line.from);
            if (line.to >= node.to) break;
            pos = line.to + 1;
          }
          break;
        }

        case "FencedCode": {
          let pos = node.from;
          while (pos <= node.to && pos <= state.doc.length) {
            const line = state.doc.lineAt(pos);
            codeLines.add(line.from);
            if (line.to >= node.to) break;
            pos = line.to + 1;
          }
          break;
        }
      }
    },
  });

  // A just-typed Shift+Enter: the trailing "\" only becomes a HardBreak once
  // the next line has content, so it would flash visibly while the cursor
  // waits on the continuation line. Hide it during that moment; if the
  // cursor leaves it dangling, it shows again (it would print literally).
  for (const r of state.selection.ranges) {
    if (!r.empty) continue;
    const line = state.doc.lineAt(r.head);
    if (line.number <= 1) continue;
    const prev = state.doc.line(line.number - 1);
    if (!prev.text.endsWith("\\") || prev.length === 0) continue;
    if (tree.resolveInner(prev.to - 1, 1).name === "HardBreak") continue;
    hideRange(prev.to - 1, prev.to);
  }

  for (const lineStart of quoteLines) {
    ranges.push(quoteLine.range(lineStart));
  }
  for (const lineStart of codeLines) {
    ranges.push(codeLine.range(lineStart));
  }
  for (const a of admonitionLines) {
    ranges.push(admonitionLineDeco[a.kind].range(a.from));
    if (a.first) ranges.push(admFirstLine.range(a.from));
    if (a.last) ranges.push(admLastLine.range(a.from));
  }

  return {
    decorations: Decoration.set(ranges, true),
    atomics: Decoration.set(atomics, true),
  };
}

// ---------------------------------------------------------------------------
// View plugin

function mergeSets(sets: DecorationSet[]): DecorationSet {
  if (sets.length === 1) return sets[0];
  const all: Range<Decoration>[] = [];
  for (const set of sets) {
    const it = set.iter();
    while (it.value !== null) {
      all.push(it.value.range(it.from, it.to));
      it.next();
    }
  }
  return Decoration.set(all, true);
}

const livePreviewPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    atomics: DecorationSet;

    constructor(view: EditorView) {
      [this.decorations, this.atomics] = this.build(view);
    }

    update(update: ViewUpdate) {
      if (
        update.docChanged ||
        update.selectionSet ||
        update.viewportChanged ||
        syntaxTree(update.state) !== syntaxTree(update.startState)
      ) {
        [this.decorations, this.atomics] = this.build(update.view);
      }
    }

    build(view: EditorView): [DecorationSet, DecorationSet] {
      const sets = view.visibleRanges.map(({ from, to }) =>
        buildLivePreviewDecorations(view.state, from, to),
      );
      return [
        mergeSets(sets.map((s) => s.decorations)),
        mergeSets(sets.map((s) => s.atomics)),
      ];
    }
  },
  {
    decorations: (plugin) => plugin.decorations,
    eventHandlers: {
      mousedown(e, view) {
        const target = e.target as HTMLElement;
        if (!target.classList.contains("cm-live-checkbox")) return false;
        return toggleTaskAt(view, view.posAtDOM(target));
      },
    },
  },
);

/** Flip the TaskMarker on the line at `pos` between "[ ]" and "[x]". */
function toggleTaskAt(view: EditorView, pos: number): boolean {
  const line = view.state.doc.lineAt(pos);
  let marker: { from: number; to: number } | null = null;
  syntaxTree(view.state).iterate({
    from: line.from,
    to: line.to,
    enter: (node) => {
      if (node.name === "TaskMarker" && marker === null) {
        marker = { from: node.from, to: node.to };
      }
    },
  });
  if (marker === null) return false;
  const { from, to } = marker;
  const checked = /x/i.test(view.state.doc.sliceString(from, to));
  view.dispatch({
    changes: { from, to, insert: checked ? "[ ]" : "[x]" },
  });
  return true;
}

// ---------------------------------------------------------------------------
// Styling

// Heading sizes as em multiples of the 11pt body, matching the print CSS
// (h1 20pt, h2 16pt, h3 13pt, h4-6 11pt) so headings line up with the PDF.
const liveHighlightStyle = HighlightStyle.define([
  { tag: tags.heading1, fontSize: "1.82em", fontWeight: "700" },
  { tag: tags.heading2, fontSize: "1.45em", fontWeight: "700" },
  { tag: tags.heading3, fontSize: "1.18em", fontWeight: "700" },
  { tag: tags.heading4, fontSize: "1em", fontWeight: "700" },
  { tag: tags.heading5, fontSize: "1em", fontWeight: "700" },
  {
    tag: tags.heading6,
    fontSize: "1em",
    fontWeight: "700",
    fontStyle: "italic",
  },
  // Bold / italic / strikethrough are applied in the decoration walk
  // (strongDeco / emphasisDeco / strikeDeco) so they can be skipped inside
  // CriticMarkup marks; keeping them out of the highlighter avoids styling the
  // literal *, _ and ~ characters of tracked text.
  { tag: tags.link, color: "#2a6db2", textDecoration: "underline" },
  { tag: tags.url, color: "#888888" },
  { tag: tags.monospace, fontFamily: "Consolas, 'Cascadia Mono', monospace" },
  { tag: tags.quote, fontStyle: "italic" },
  { tag: tags.processingInstruction, color: "#9a9a9a" },

  // Fenced-code token colors — languages are nested via codeLanguages, so this
  // is what actually paints the highlighting. Midtone hues, chosen to stay
  // legible on both the white page (light) and the dark canvas.
  {
    tag: [tags.comment, tags.lineComment, tags.blockComment],
    color: "#7d8794",
    fontStyle: "italic",
  },
  {
    tag: [
      tags.keyword,
      tags.controlKeyword,
      tags.moduleKeyword,
      tags.operatorKeyword,
      tags.definitionKeyword,
    ],
    color: "#b0519f",
  },
  {
    tag: [tags.string, tags.special(tags.string), tags.regexp],
    color: "#2f8a52",
  },
  { tag: [tags.number, tags.bool, tags.null, tags.atom], color: "#c17d2b" },
  {
    tag: [
      tags.function(tags.variableName),
      tags.function(tags.propertyName),
      tags.labelName,
    ],
    color: "#3f7fc1",
  },
  {
    tag: [tags.typeName, tags.className, tags.namespace, tags.tagName],
    color: "#c1962b",
  },
  { tag: [tags.propertyName, tags.attributeName], color: "#3f7fc1" },
  { tag: tags.meta, color: "#7d8794" },
]);

// The page-card styling (fixed-width centered sheet, gray canvas) lives in
// styles.css under `#editor.live` — a CodeMirror theme proved unreliable for
// overriding .cm-content's flex sizing. Only the writing font stays here.
const liveTheme = EditorView.theme({
  // Same font family as the print stylesheet so the editor and PDF wrap and
  // position text identically (both rendered by WebView2/Chromium).
  ".cm-scroller": {
    fontFamily: '"Segoe UI", system-ui, sans-serif',
  },
});

/**
 * Word users click into the visual gap between paragraphs and type,
 * expecting a NEW paragraph — but that gap is the blank separator line, and
 * filling it would merge everything into one printed paragraph (CommonMark
 * soft breaks). This filter pads typed text on an empty separator line with
 * blank lines so it becomes its own paragraph, exactly as it looks.
 */
export const paragraphGuard = EditorState.transactionFilter.of((tr) => {
  if (!tr.docChanged) return tr;
  if (tr.annotation(Transaction.userEvent) !== "input.type") return tr;
  const state = tr.startState;
  let result: { from: number; insert: string; cursor: number } | null = null;
  let applicable = true;
  let count = 0;
  tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    count++;
    if (count > 1 || fromA !== toA) {
      applicable = false;
      return;
    }
    const text = inserted.sliceString(0, inserted.length, state.lineBreak);
    if (text.includes("\n") || text.includes("\r") || text.trim() === "") {
      applicable = false;
      return;
    }
    const line = state.doc.lineAt(fromA);
    if (line.length !== 0) {
      applicable = false;
      return;
    }
    const nl = state.lineBreak;
    const prevLine = line.number > 1 ? state.doc.line(line.number - 1) : null;
    // The line after a Shift+Enter hard break ("\" or two trailing spaces)
    // is a continuation of the paragraph, not a separator — typing there
    // must stay in the paragraph, so the guard stands down.
    if (
      prevLine !== null &&
      (prevLine.text.endsWith("\\") || prevLine.text.endsWith("  "))
    ) {
      applicable = false;
      return;
    }
    const prevFull = prevLine !== null && prevLine.length > 0;
    const nextFull =
      line.number < state.doc.lines &&
      state.doc.line(line.number + 1).length > 0;
    if (!prevFull && !nextFull) {
      applicable = false;
      return;
    }
    const insert = (prevFull ? nl : "") + text + (nextFull ? nl : "");
    const cursor = fromA + (prevFull ? 1 : 0) + text.length;
    result = { from: fromA, insert, cursor };
  });
  if (!applicable || result === null) return tr;
  const r = result as { from: number; insert: string; cursor: number };
  return {
    changes: { from: r.from, insert: r.insert },
    selection: EditorSelection.cursor(r.cursor),
    userEvent: "input.type.paragraph",
    scrollIntoView: true,
  };
});

export function livePreviewExtensions(): Extension {
  return [
    livePreviewPlugin,
    mathExtensions(),
    footnoteExtensions(),
    pageBreaksField,
    tableExtensions(),
    paragraphGuard,
    // Native (Chromium/WebView2) spellcheck in the writing view.
    EditorView.contentAttributes.of({ spellcheck: "true" }),
    hideCommentSyntax.of(true),
    hideCriticSyntax.of(true),
    EditorView.atomicRanges.of(
      (view) => view.plugin(livePreviewPlugin)?.atomics ?? Decoration.none,
    ),
    Prec.high(syntaxHighlighting(liveHighlightStyle)),
    liveTheme,
  ];
}
