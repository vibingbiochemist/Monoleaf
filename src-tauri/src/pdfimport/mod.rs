//! PDF → Markdown import.
//!
//! Converts a PDF into plain CommonMark + GFM and opens it as an ordinary
//! Monoleaf document. Pure Rust throughout — `pdf-extract` over `lopdf`, no
//! Poppler, PDFium, C toolchain or Python/ML runtime — so Monoleaf stays a
//! single static binary.
//!
//! The import deliberately produces a *clean, untracked* document: no metadata
//! block, no tracked changes, no comments — byte-for-byte the kind of content a
//! user could have typed. Monoleaf's own metadata channel is added later, by the
//! editor, only if the user asks for it.
//!
//! ## How the pipeline is split, and why
//!
//! A PDF describes glyphs at coordinates. It has no words, lines, paragraphs,
//! headings or tables, and usually no space characters either — a producer moves
//! the pen instead of drawing a space. So conversion is two distinct jobs, and
//! they are two modules:
//!
//! 1. [`layout`] rebuilds words and lines from glyph positions, and keeps the
//!    thin rectangles and small blobs the page draws. Getting the space
//!    threshold wrong here is what shreds text into `Theplatewasincubated` or
//!    `W arm`, so this module borrows `pdf-extract`'s verified rules verbatim.
//! 2. [`structure`] reads meaning out of the geometry — headings from type size,
//!    paragraphs from leading, lists from markers and indent, tables from the
//!    drawn rules, columns from gutters — and emits escaped Markdown.
//!
//! Structure comes from *drawn shapes* as well as text because that is often the
//! only evidence there is. A table has no table object in a PDF, only ruled
//! lines; a browser's `<ul>` bullet is a filled bezier disc and leaves no
//! character behind at all. Reading those back is what makes a PDF that Monoleaf
//! itself exported import as headings, lists and tables rather than loose prose.
//!
//! Because Markdown is generated here rather than post-processed from another
//! tool's output, hazards are handled by *escaping* rather than deletion: an
//! `<!--` in a PDF's text is escaped so it cannot be read back as one of
//! Monoleaf's metadata blocks, and nothing is lost.
//!
//! ## Known limitations (best-effort by design)
//!
//! - **Tables are reconstructed from their ruled borders**, so a table drawn
//!   without any rules — whitespace-aligned columns, or borders suppressed in
//!   CSS — comes through as text in reading order instead of as a pipe table.
//!   The cells' text is never lost either way. Merged cells flatten: a spanned
//!   cell's text lands in the first column it covers.
//! - **Multi-column layouts** are split on a vertical gutter no line crosses.
//!   Ordinary two-column prose comes out in reading order; a complex magazine
//!   layout with pull quotes, sidebars or captions between columns can still
//!   interleave.
//! - **Scanned / image-only PDFs** have no text layer to extract. There is no
//!   OCR here; such files are rejected with a clear message.
//! - **Bold-only headings** set at body size are not recoverable — type size is
//!   the only heading signal a PDF reliably carries — and arrive as paragraphs.
//! - **Images are dropped.** Extracting them would mean writing sidecar files
//!   next to a document that has no path yet; out of scope for this pass.

// Private: nothing outside this module needs the geometry types. `import` takes
// a path and returns [`PdfImport`], which is the whole public surface.
mod layout;
mod structure;

use pdf_extract::{Document, Error as PdfError, Object};

/// A converted PDF, ready to open in an editor window.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfImport {
    /// Normalized CommonMark + GFM.
    pub markdown: String,
    /// File name to suggest on first save — from the PDF's title metadata, else
    /// derived from the source file name. Always ends in `.md`.
    pub suggested_name: String,
}

/// PDFs larger than this are refused rather than parsed.
///
/// A malformed or hostile PDF can declare enormously long streams; parsing one
/// would balloon memory inside the app process. Real prose documents are orders
/// of magnitude below this, so the cap only ever fires on files no one wants to
/// edit as Markdown anyway.
const MAX_PDF_BYTES: u64 = 128 * 1024 * 1024;

/// Shown when a PDF parses but yields no words — almost always a scan.
const NO_TEXT_MESSAGE: &str = "No text could be extracted from this PDF. \
It is most likely a scan or an image-only document. Monoleaf does not perform \
OCR: convert it to a text PDF first, then import it.";

const ENCRYPTED_MESSAGE: &str = "This PDF is password-protected. Monoleaf cannot \
import encrypted PDFs: remove the password in a PDF reader, then import the copy.";

/// Convert `path` into Markdown.
///
/// Every failure — unreadable file, encrypted, malformed, or simply no text
/// layer — comes back as a message meant to be shown to the user verbatim.
pub fn import(path: &str) -> Result<PdfImport, String> {
    if path.contains('\0') {
        return Err("Invalid path".into());
    }

    // Checked before parsing so an oversized or truncated file fails instantly
    // rather than after the parser has allocated its way through the document.
    match std::fs::metadata(path) {
        Ok(meta) if meta.len() > MAX_PDF_BYTES => {
            return Err(format!(
                "This PDF is too large to import ({} MB; the limit is {} MB).",
                meta.len() / (1024 * 1024),
                MAX_PDF_BYTES / (1024 * 1024)
            ));
        }
        Ok(meta) if meta.len() == 0 => {
            return Err("This file is empty, so there is nothing to import.".into());
        }
        Err(e) => return Err(format!("Could not open {path}: {e}")),
        Ok(_) => {}
    }

    if !starts_like_a_pdf(path)? {
        return Err("This file is not a PDF, or its header is damaged beyond recognition.".into());
    }

    // The parser walks attacker-controllable structure, and a panic in it would
    // otherwise take the whole app down. `spawn_blocking` in the command layer
    // catches that too, but containing it here means every caller — including
    // tests — gets the same graceful failure.
    //
    // This covers unwinding panics only. An *abort* — stack overflow on a deeply
    // nested object graph, or an allocation failure — cannot be caught by any
    // Rust construct, and would end the process with every open document's
    // unsaved work. That is why the parser is kept current rather than pinned:
    // lopdf 0.36 had exactly such a stack overflow (RUSTSEC-2026-0187), fixed in
    // 0.42. Keep `cargo audit` in mind when touching these versions.
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| convert(path)))
        .unwrap_or_else(|_| Err("This PDF is damaged and could not be read.".into()))
}

/// The conversion proper, once the file has been vetted.
fn convert(path: &str) -> Result<PdfImport, String> {
    let mut doc = Document::load(path).map_err(describe_error)?;

    // An encrypted PDF is usable when the *user* password is empty, which is the
    // common "restrict printing/copying" case; a real password stops the import.
    if doc.is_encrypted() && doc.decrypt("").is_err() {
        return Err(ENCRYPTED_MESSAGE.into());
    }

    let title = pdf_title(&doc);

    let mut collector = layout::Collector::new();
    pdf_extract::output_doc(&doc, &mut collector).map_err(|e| match e {
        pdf_extract::OutputError::PdfError(e) => describe_error(e),
        other => format!("This PDF could not be read ({other})."),
    })?;

    let markdown = structure::to_markdown(&collector.into_pages());
    if !has_extractable_text(&markdown) {
        return Err(NO_TEXT_MESSAGE.into());
    }

    Ok(PdfImport {
        markdown,
        suggested_name: suggested_name(title.as_deref(), path),
    })
}

/// Whether the file begins with a PDF header.
///
/// The marker is allowed anywhere in the first kilobyte because a surprising
/// number of real PDFs carry junk ahead of it, and readers tolerate that.
fn starts_like_a_pdf(path: &str) -> Result<bool, String> {
    use std::io::Read;
    let mut head = [0u8; 1024];
    let mut file = std::fs::File::open(path).map_err(|e| format!("Could not open {path}: {e}"))?;
    let n = file
        .read(&mut head)
        .map_err(|e| format!("Could not read {path}: {e}"))?;
    Ok(head[..n].windows(5).any(|w| w == b"%PDF-"))
}

/// The document's `/Title`, if it has a usable one.
fn pdf_title(doc: &Document) -> Option<String> {
    let info = doc.trailer.get(b"Info").ok()?;
    let dict = match info {
        Object::Reference(id) => doc.get_object(*id).ok()?.as_dict().ok()?,
        Object::Dictionary(d) => d,
        _ => return None,
    };
    // Handles both UTF-16BE (with BOM) and PDFDocEncoded strings.
    pdf_extract::decode_text_string(dict.get(b"Title").ok()?).ok()
}

/// Map a parser failure onto a message a user can act on.
///
/// The distinctions that survive are the ones a reader can do something about:
/// a password, an unreadable file, or a damaged one. Whether the damage was a
/// bad xref, a missing object or an undecodable stream is not actionable for
/// someone who just wants to read the document, so those collapse together.
pub fn describe_error(err: PdfError) -> String {
    match err {
        PdfError::Decryption(_) => ENCRYPTED_MESSAGE.into(),
        PdfError::IO(e) => format!("Could not read the file ({e})."),
        PdfError::Unimplemented(what) => {
            format!("This PDF uses a feature Monoleaf cannot read yet ({what}).")
        }
        other => format!("This PDF is damaged and could not be read ({other})."),
    }
}

/// True when the converted document contains actual words.
///
/// Deliberately generous: a single alphanumeric character anywhere is enough.
/// The case being caught is the empty extraction of a scanned page, and a
/// stricter threshold would reject legitimately terse documents (a title page,
/// a one-line memo). Punctuation and Markdown syntax do not count, so a
/// document of nothing but stray rules still fails.
pub fn has_extractable_text(markdown: &str) -> bool {
    markdown.chars().any(char::is_alphanumeric)
}

/// Choose the file name to suggest when the imported document is first saved.
///
/// The PDF's title metadata wins when it is usable, because it is what the
/// author called the document; producers frequently leave it as a file path, a
/// LaTeX job name, or empty, so the source file name is the fallback.
pub fn suggested_name(title: Option<&str>, path: &str) -> String {
    if let Some(stem) = title.and_then(usable_title) {
        return format!("{stem}.md");
    }
    let file_stem = std::path::Path::new(path)
        .file_stem()
        .and_then(|s| s.to_str())
        .and_then(sanitize_stem)
        .unwrap_or_else(|| "Imported".to_string());
    format!("{file_stem}.md")
}

/// A title worth using: has letters or digits, is not itself a file name, and
/// survives sanitizing.
fn usable_title(title: &str) -> Option<String> {
    let t = title.trim();
    // Producers commonly dump the source path or the original file name into
    // /Title ("C:\\jobs\\report.docx", "untitled.dvi"). The file-name fallback
    // handles those better than a stem with an extension glued on.
    let looks_like_a_filename = t.contains('/')
        || t.contains('\\')
        || std::path::Path::new(t)
            .extension()
            .is_some_and(|e| !e.is_empty() && e.len() <= 5);
    if looks_like_a_filename {
        return None;
    }
    sanitize_stem(t)
}

/// Reduce arbitrary text to something usable as a file-name stem.
///
/// Path separators, the characters Windows forbids in a name, and control
/// characters are dropped; runs of whitespace collapse to single spaces. Returns
/// `None` when nothing usable is left. The length cap keeps the whole path
/// inside the classic 260-character limit once a directory is prepended.
fn sanitize_stem(s: &str) -> Option<String> {
    let cleaned: String = s
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => ' ',
            c if c.is_control() => ' ',
            c => c,
        })
        .collect();
    let collapsed = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    // A trailing dot or space is legal in the string but not in a Windows file
    // name, and a name of only dots would be a directory reference.
    let trimmed = collapsed.trim_matches(|c: char| c == '.' || c.is_whitespace());
    if trimmed.is_empty() || !trimmed.chars().any(char::is_alphanumeric) {
        return None;
    }
    let capped: String = trimmed.chars().take(120).collect();
    Some(capped.trim_end().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    // --- no-text detection ---

    #[test]
    fn documents_without_words_are_rejected() {
        assert!(!has_extractable_text(""));
        assert!(!has_extractable_text("\n\n---\n\n"));
        assert!(!has_extractable_text("| | |\n| --- | --- |"));
        // Terse but real content is accepted; the check must not be a threshold.
        assert!(has_extractable_text("Hi"));
        assert!(has_extractable_text("# 7"));
        assert!(has_extractable_text("Überschrift"));
        assert!(has_extractable_text("見出し"));
    }

    // --- suggested file name ---

    #[test]
    fn title_metadata_names_the_document() {
        assert_eq!(
            suggested_name(Some("Quarterly Report"), "C:/tmp/q3-final-v2.pdf"),
            "Quarterly Report.md"
        );
    }

    #[test]
    fn unusable_titles_fall_back_to_the_source_file_name() {
        let path = "C:/tmp/annual-review.pdf";
        for title in [
            None,
            Some(""),
            Some("   "),
            Some("\u{0}\u{1}"),
            Some("---"),
            // Producers that dump a path or a source file name into /Title.
            Some("C:\\jobs\\report.docx"),
            Some("/home/u/thesis.tex"),
            Some("untitled.dvi"),
        ] {
            assert_eq!(
                suggested_name(title, path),
                "annual-review.md",
                "title {title:?} should have been rejected"
            );
        }
    }

    #[test]
    fn titles_are_reduced_to_legal_file_names() {
        // Characters Windows forbids become spaces, runs collapse.
        assert_eq!(
            suggested_name(Some("Q3: profit? <draft>"), "x.pdf"),
            "Q3 profit draft.md"
        );
        assert_eq!(
            suggested_name(Some("  spaced   out  "), "x.pdf"),
            "spaced out.md"
        );
        // Trailing dots are legal in the metadata but not in a file name.
        assert_eq!(suggested_name(Some("Report ..."), "x.pdf"), "Report.md");
        // Long titles are capped, and never end mid-space.
        let long = "A".repeat(300);
        let name = suggested_name(Some(&long), "x.pdf");
        assert_eq!(name, format!("{}.md", "A".repeat(120)));
    }

    #[test]
    fn a_nameless_path_still_produces_a_file_name() {
        // No stem to work with at all.
        assert_eq!(suggested_name(None, ""), "Imported.md");
        assert_eq!(suggested_name(None, "/"), "Imported.md");
        // A file named only `.pdf` has no stem to speak of — Rust reads the
        // whole name as the stem, and the leading dot is dropped because a
        // name starting with one is hidden on Unix. "pdf.md" is odd but legal;
        // what matters is that it is a name and not an empty string.
        assert_eq!(suggested_name(None, "C:/tmp/.pdf"), "pdf.md");
        // The stem is used as-is when it is already a reasonable name.
        assert_eq!(
            suggested_name(None, "/srv/docs/Minutes 2026.pdf"),
            "Minutes 2026.md"
        );
    }

    // --- error mapping ---

    #[test]
    fn every_failure_reason_gets_an_actionable_message() {
        // Encryption is the one the user can act on, so it must not be lumped
        // in with "damaged".
        let msg = describe_error(PdfError::Decryption(
            pdf_extract::encryption::DecryptionError::IncorrectPassword,
        ));
        assert!(msg.contains("password"), "got: {msg}");

        let msg = describe_error(PdfError::IO(std::io::Error::other("disk gone")));
        assert!(msg.contains("Could not read"), "got: {msg}");

        for err in [
            PdfError::ObjectIdMismatch,
            PdfError::MissingXrefEntry,
            PdfError::InvalidStream("bad filter".into()),
        ] {
            let msg = describe_error(err);
            assert!(msg.contains("damaged"), "got: {msg}");
        }
    }

    #[test]
    fn error_messages_are_sentences() {
        for err in [
            PdfError::ObjectIdMismatch,
            PdfError::Unimplemented("weird filter"),
            PdfError::IO(std::io::Error::other("nope")),
        ] {
            let msg = describe_error(err);
            assert!(msg.ends_with('.'), "got: {msg}");
            assert!(msg.chars().next().unwrap().is_uppercase(), "got: {msg}");
        }
    }

    // --- file-level guards ---

    #[test]
    fn missing_and_empty_files_fail_before_parsing() {
        let missing = std::env::temp_dir().join("monoleaf_no_such_file.pdf");
        let _ = std::fs::remove_file(&missing);
        let err = import(&missing.to_string_lossy()).unwrap_err();
        assert!(err.starts_with("Could not open"), "got: {err}");

        let empty = std::env::temp_dir().join("monoleaf_empty_import.pdf");
        std::fs::write(&empty, b"").unwrap();
        let err = import(&empty.to_string_lossy()).unwrap_err();
        assert!(err.contains("empty"), "got: {err}");
        let _ = std::fs::remove_file(&empty);
    }

    #[test]
    fn a_file_without_a_pdf_header_is_refused_before_parsing() {
        let p = std::env::temp_dir().join("monoleaf_not_pdf.pdf");
        std::fs::write(&p, b"This is a plain text file, not a PDF at all.").unwrap();
        let err = import(&p.to_string_lossy()).unwrap_err();
        assert!(err.contains("not a PDF"), "got: {err}");
        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn a_path_with_a_nul_byte_is_refused() {
        assert!(import("C:/tmp/evil\u{0}.pdf").is_err());
    }
}
