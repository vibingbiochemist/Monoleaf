# Changelog

All notable changes to Monoleaf are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.9.0] - 2026-08-01

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
- **The installer is not code-signed**, so Windows SmartScreen may warn about an
  unknown publisher.
- **Windows is the tested and distributed platform.** macOS and Linux build from
  the same source but are neither distributed nor currently verified.
