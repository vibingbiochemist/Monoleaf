# Changelog

All notable changes to Monoleaf are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.2.1] - 2026-08-24

### Fixed

- **Page breaks are no longer invisible inside a table that spans multiple
  pages.** A table is rendered in the editor as one interactive grid, so a
  page-break divider landing inside it had nowhere to draw — the divider now
  renders as a row inside the table itself, at the same row the real
  PDF/print output breaks on.
- **A page break landing inside a single tall cell now shows precisely
  where the PDF actually breaks, instead of only at row boundaries.** A
  cell long enough to span a page on its own (a `<br>`-separated list, say)
  has no row to anchor a divider to; the divider is now rendered inline
  inside the cell's own content, at the exact character position the real
  PDF broke at.
- **The gap between pages, and the divider inside a split table, now match
  the editor's actual canvas color** instead of a similar but slightly
  different grey that never quite lined up with the background behind the
  page.
- **The text cursor no longer renders as tall as an entire table** when
  placed at the edge of a table that spans multiple pages. It's now clamped
  to the height it would have in ordinary text.

## [1.2.0] - 2026-08-23

### Added

- **Document fonts.** Page Setup now offers a font: Source Serif 4 (the new
  default), Lora, Source Sans 3, Atkinson Hyperlegible Next or Lexend, plus
  IBM Plex Mono for code blocks and the raw view. All six are bundled with
  the app (SIL Open Font License) rather than drawn from whatever is
  installed on your system, so a document renders and paginates identically
  everywhere — the same reason page size and margins already travel with the
  file. The choice is saved in the document itself and carried into PDF and
  HTML exports; HTML exports embed the font directly so the file looks right
  even on a machine that doesn't have it installed.
  - Existing documents have no font set and now render in Source Serif 4
    instead of the system font; page breaks may shift slightly as a result.
  - Lexend has no italic design; *italic* text in that font is a
    browser-synthesised slant, the same as most other apps do.
  - Code blocks switch from Consolas/Cascadia Mono (Windows-only fonts, so
    they rendered inconsistently on Linux) to the bundled IBM Plex Mono.

### Fixed

- **PDF and print output now actually uses the page's intended typography.**
  The stylesheet that sets the 11pt body size, heading sizes, line spacing,
  justified text and code font was scoped to an element ID that Paged.js
  rewrites internally, so none of those rules ever matched — printed
  documents silently fell back to a 16px browser default instead. Exports
  now render at the intended size, so a document has noticeably more text
  per page and the printed page count may be lower than before.
- **The in-editor page-break indicator now matches the real PDF/print output
  exactly**, instead of landing on a nearby but different line. A long
  paragraph that runs across a page boundary now reads Paged.js's own break
  point for plain-text paragraphs directly, rather than guessing where the
  cut fell; anything with inline formatting (bold, links, code, …) still
  falls back to the previous best-effort estimate, which itself no longer
  collapses onto a single position when a paragraph spans more than two
  pages.
- **Bold, italic, strikethrough, inline code, subscript and superscript no
  longer stack extra markers when toggled twice with nothing typed in
  between.** Clicking the same formatting button again on an empty
  selection used to wrap the cursor in an ever-growing pile of markers
  (`**` → `****` → `********`…) instead of clearing the empty pair.

## [1.1.0] - 2026-08-07

### Added

- **Release notes in the update bar.** When an update is available, a collapsed
  "What's new" disclosure under the offer shows the release notes, instead of
  just a bare version number.
- **Skip a specific update version.** A "Skip this version" button lets you
  decline one release without turning update checks off entirely — a later
  "Check for updates" still offers it, and the next release is unaffected.
- **Periodic update rechecks.** Monoleaf now checks for updates roughly once a
  day while it stays open, not only at startup, so a long-running session
  doesn't miss a release.

### Fixed

- **The update offer now reaches every open window**, not just the one that
  happened to check. Dismissing or skipping an update in one window now clears
  it everywhere, instead of leaving other windows showing a stale offer.

## [1.0.0] - 2026-08-05

### Added

- **Optional update checks.** Monoleaf can ask GitHub once per launch whether a
  newer version exists, then download and install it on request. Off by default:
  you are asked once on first run and can change the answer in Settings at any
  time. The check is a single HTTPS request carrying no identifiers and nothing
  about your documents. Updates are cryptographically signed and the signature is
  verified before installation.
- Installing an update closes and reopens Monoleaf. Before it does, every open
  window writes its unsaved work to the crash-recovery snapshot, and the
  restarted app offers those drafts back.

### Fixed

- **Recovering an unsaved draft no longer consumes the only copy of it.** The
  snapshot used to be deleted at the moment it was offered back, and the next one
  was over a second away and waiting on an edit that might never come, so a
  document recovered and then left untouched existed nowhere but in memory. A
  crash or a forced close in that window lost it: the exact failure recovery
  exists to prevent. Each draft is now written straight back, under the key of
  whichever window ends up holding it.

### Changed

- **Dialogs no longer stretch to the width of the window** when they hold a long
  message. Their width is capped at a readable column, for every dialog rather
  than only the ones where it had been noticed.
- Em dashes in labels and messages give way to plainer punctuation: a colon, a
  comma or parentheses. The window title keeps its dash, which is the
  conventional form there.

## [0.9.0] - 2026-08-04

First public release.

### Added

- **Single-file WYSIWYG editing.** A silent live preview renders headings, bold,
  tables, math, callouts and code in place while the file on disk stays pure
  Markdown. `Ctrl+Q` shows the raw view, which is exactly what is on disk.
- **Lossless, byte-for-byte round-trip.** Opening a file and saving it untouched
  reproduces it exactly: line endings (CRLF/CR/LF), BOMs and missing trailing
  newlines included. Enforced by tests, not hoped for.
- **Writing.** Bold, italic, strikethrough, inline code, underline, highlight,
  sub/superscript, change case and clear formatting; headings, bullet, numbered
  and task lists, blockquotes, tables and horizontal rules; GitHub-style
  admonitions, LaTeX math, fenced code with syntax highlighting, footnotes, and
  an outline sidebar. Pasting from Word, Excel or the web arrives as clean
  Markdown, tables included.
- **Document.** Table of contents, in-file document properties, page setup
  (size, margins, header/footer with field substitution), find & replace, live
  word count, and a page-accurate layout view with zoom.
- **Review.** Inline threaded comments that resolve, and CriticMarkup tracked
  changes with accept/reject. Both live in the `.md` itself with no sidecar files
  and no character offsets, so both survive editing elsewhere and diff in git.
- **Export.** PDF with true page geometry via CSS Paged Media, and
  self-contained HTML with styles inlined and no external resources.
- **PDF import** under **File ▸ Import from PDF…**, a separate command from Open
  because a PDF is converted rather than opened. The result is a new unsaved
  document named from the PDF's title metadata; the original is only ever read.

  Conversion is pure Rust, using [`pdf-extract`](https://crates.io/crates/pdf-extract)
  over [`lopdf`](https://crates.io/crates/lopdf), no Poppler, PDFium, Python or
  ML runtime, so Monoleaf stays a single static binary. Because a PDF contains
  only glyphs at coordinates (no words, no paragraphs, usually not even spaces),
  structure is reconstructed from geometry: word spacing from pen advances,
  headings from relative type size, paragraphs from leading, list items from
  markers or from the bullet glyph a browser draws as a filled path, tables from
  ruled cell borders, and columns from a gutter no line crosses.

  Imported documents are plain CommonMark + GFM and start completely untracked.
  Text that would read as markup is escaped rather than deleted, so nothing in a
  PDF can impersonate Monoleaf's own constructs: an `<!--` cannot return as a
  metadata or comment block, and a `{--…--}` cannot return as a tracked change
  that Accept All would then apply.
- **Remote images are not loaded unless you enable them** (Settings ▸ Load
  remote images). Otherwise opening a document fetches every image it
  references, which turns `![](https://tracker.example/abc123.png)` into a
  tracking pixel telling whoever wrote it your IP address, when you opened the
  file and, from a unique URL, which file. Blocked images show their alt text.
  Mail clients block remote images by default for the same reason.
- **Portability modes.** Strict/Enhanced flagging of anything beyond
  CommonMark + GFM, so you always know how portable a document is. Constructs
  other viewers do not understand (callouts, comments, page setup) are written
  as ordinary blockquotes or HTML comments, so the file still reads cleanly on
  GitHub or in any plain editor.
- Light and dark themes, autosave with crash recovery, reopen-last-file, and a
  Windows installer that installs per-user with no administrator rights.

### Security

- Rendered document HTML is sanitized with DOMPurify before it reaches the DOM
  or an exported file, under a restrictive Content-Security-Policy, with
  `withGlobalTauri` disabled and file writes constrained to document extensions.
- Documents never leave your machine: no account, no cloud, no telemetry. The
  app window never navigates; external links open in your system browser.
- **The page-setup block cannot inject CSS.** A margin value travels with the
  document and is interpolated into the printed page's `@page` rule, so it is
  validated as plain CSS lengths and nothing else. Without that, a document could
  close the rule and append styles of its own (applied on open, since page
  layout is measured when a file loads, not when it is printed).
- **Remote content is blocked on every attribute that fetches**, not just
  `<img src>`: `srcset`, `poster` and the legacy `background` attribute on any
  element, `href`/`xlink:href` on the SVG elements that load one, and any inline
  `style` that references a remote URL, including through CSS escape sequences
  and `image-set()`, neither of which a pattern over `url()` tokens catches.
  Inline `data:` images are unaffected, in either setting.
- **Exported HTML carries its own Content-Security-Policy.** A shared `.html`
  opens in an ordinary browser, which applies none of the app's restrictions;
  scripts are refused outright and images are limited to what the reader's remote
  content setting allowed at the moment of export. Links that open a new tab now
  carry `rel="noopener noreferrer"`.
- **Network paths need your permission** (Settings ▸ Allow network paths, off by
  default). On Windows, merely opening a `\\server\share` path makes the system
  sign in to that server and hand it a hash of your credentials, so a path
  Monoleaf did not choose cannot reach a host you did not choose. Opening a file
  on a share offers to switch the setting on and then retries, so it is one
  click rather than a dead end; mapped drives (`Z:`) never needed it.
- **A panic while importing a PDF cannot take the app down**, and cannot poison
  the locks that the rest of the session depends on.
- Supply chain: CI runs on a least-privilege token with every third-party action
  pinned to a commit hash, blocking npm and cargo advisory audits on both the
  build and release paths, CodeQL static analysis, dependency review on incoming
  changes, and Dependabot across npm, Cargo and Actions. A release tag is checked
  against the version in all three manifests before anything is published.

### Known limitations

- **PDF import is best-effort by nature.** Tables are rebuilt from their ruled
  borders, so a borderless, whitespace-aligned table arrives as text in reading
  order, with no cell text lost, and merged cells flatten into the first column
  they cover. Multi-column layouts are split on a vertical gutter and can still
  interleave on complex pages. Scanned or image-only PDFs are refused with an
  explanation rather than opened blank; there is no OCR. Bold-only headings at
  body size arrive as paragraphs, since relative type size is the only heading
  signal a PDF reliably carries. Images are dropped. Encrypted, damaged and
  oversized files each fail with a specific message.
- **Embedded media is not rendered.** Raw `<video>`, `<audio>` and `<track>`
  elements in a document are removed rather than displayed, in the editor and in
  both exports. Monoleaf does not emit them, and allowing tags it never produces
  only widens what an untrusted document can reach for. Images, math and tables
  are unaffected.
- **Page margins accept plain CSS lengths only:** one to four values in `mm`,
  `cm`, `in`, `pt` or `px`, or a bare `0`. Anything else in a document's page
  setup falls back to the default, because a margin travels with the file
  straight into the printed page's style rule.
- **The installer is not code-signed**, so Windows SmartScreen may warn about an
  unknown publisher.
- **Windows is the tested and distributed platform.** macOS and Linux build from
  the same source but are neither distributed nor currently verified.
