//! End-to-end tests for PDF import, against generated fixture PDFs.
//!
//! The fixtures are *built* rather than committed as binaries. Layout-based
//! conversion depends entirely on where glyphs sit on the page, so a fixture is
//! only meaningful if you can see those coordinates — and a checked-in PDF hides
//! them. `pdf::` below writes the smallest valid PDF that places given strings at
//! given positions, which makes each test state its own layout in the open.
//!
//! There is exactly one committed binary fixture, `fixtures/browser-print.pdf`,
//! and the reason is spelled out at `browser_print_pdf` below: what it tests is a
//! real producer's glyph encoding, which the writer here cannot fake.
//!
//! Assertions are about *structure* — a heading became a heading, cell text
//! survived in reading order — never about exact bytes. Extraction is a set of
//! geometric heuristics; pinning its output verbatim would make these tests
//! break on every upstream improvement.

use monoleaf_lib::pdfimport;

/// A minimal PDF writer: text at absolute page positions, nothing else.
mod pdf {
    /// One run of text: `(x, y, font_size, text)`, in PDF user space — origin
    /// bottom-left, so a larger `y` is higher on the page.
    pub type Line<'a> = (f32, f32, f32, &'a str);

    /// Escape the three characters that terminate or continue a PDF literal
    /// string.
    fn escape(s: &str) -> String {
        s.replace('\\', r"\\")
            .replace('(', r"\(")
            .replace(')', r"\)")
    }

    /// A content stream placing each line with an absolute text matrix. Using
    /// `Tm` per line rather than accumulating `Td` offsets keeps the coordinate
    /// in the test identical to the coordinate on the page.
    fn content_stream(lines: &[Line]) -> String {
        let mut s = String::new();
        for &(x, y, size, text) in lines {
            s.push_str(&format!(
                "BT\n/F1 {size} Tf\n1 0 0 1 {x} {y} Tm\n({}) Tj\nET\n",
                escape(text)
            ));
        }
        s
    }

    /// Assemble numbered objects into a PDF with a correct xref table.
    ///
    /// `objects[i]` is the body of object `i + 1`, so object numbers match the
    /// references written by the callers below.
    fn assemble(objects: &[String], root: usize, info: Option<usize>) -> Vec<u8> {
        let mut out = String::from("%PDF-1.4\n");
        let mut offsets = Vec::with_capacity(objects.len());
        for (i, body) in objects.iter().enumerate() {
            offsets.push(out.len());
            out.push_str(&format!("{} 0 obj\n{body}\nendobj\n", i + 1));
        }
        let xref_offset = out.len();
        out.push_str(&format!("xref\n0 {}\n", objects.len() + 1));
        // Every xref entry is exactly 20 bytes, the free head entry included.
        out.push_str("0000000000 65535 f \n");
        for off in &offsets {
            out.push_str(&format!("{off:010} 00000 n \n"));
        }
        let info_ref = info.map_or(String::new(), |n| format!(" /Info {n} 0 R"));
        out.push_str(&format!(
            "trailer\n<< /Size {} /Root {root} 0 R{info_ref} >>\nstartxref\n{xref_offset}\n%%EOF\n",
            objects.len() + 1
        ));
        out.into_bytes()
    }

    /// A PDF of US-Letter pages, each holding the given text runs.
    pub fn document(pages: &[Vec<Line>], title: Option<&str>) -> Vec<u8> {
        // 1 = catalog, 2 = page tree, 3 = font, 4 = info (when a title is set);
        // pages and their content streams follow in pairs.
        let first_page_obj = if title.is_some() { 5 } else { 4 };
        let kids: Vec<String> = (0..pages.len())
            .map(|i| format!("{} 0 R", first_page_obj + i * 2))
            .collect();

        let mut objects = vec![
            "<< /Type /Catalog /Pages 2 0 R >>".to_string(),
            format!(
                "<< /Type /Pages /Kids [{}] /Count {} >>",
                kids.join(" "),
                pages.len()
            ),
            "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>"
                .to_string(),
        ];
        if let Some(t) = title {
            objects.push(format!("<< /Title ({}) >>", escape(t)));
        }

        for (i, lines) in pages.iter().enumerate() {
            let contents_obj = first_page_obj + i * 2 + 1;
            objects.push(format!(
                "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] \
                 /Resources << /Font << /F1 3 0 R >> >> /Contents {contents_obj} 0 R >>"
            ));
            let stream = content_stream(lines);
            objects.push(format!(
                "<< /Length {} >>\nstream\n{stream}endstream",
                stream.len()
            ));
        }

        assemble(&objects, 1, title.map(|_| 4))
    }

    /// Write `bytes` to a uniquely named temp file and return its path. The
    /// caller keeps the returned path alive for the length of the test; each
    /// test uses its own `name` so parallel tests never collide.
    pub fn temp_file(name: &str, bytes: &[u8]) -> std::path::PathBuf {
        let path = std::env::temp_dir().join(format!("monoleaf_fixture_{name}.pdf"));
        std::fs::write(&path, bytes).expect("failed to write fixture");
        path
    }
}

/// Import a fixture, asserting only that it succeeded.
fn import_fixture(name: &str, bytes: &[u8]) -> pdfimport::PdfImport {
    let path = pdf::temp_file(name, bytes);
    let result = pdfimport::import(&path.to_string_lossy());
    let _ = std::fs::remove_file(&path);
    result.unwrap_or_else(|e| panic!("fixture {name} failed to import: {e}"))
}

fn import_err(name: &str, bytes: &[u8]) -> String {
    let path = pdf::temp_file(name, bytes);
    let result = pdfimport::import(&path.to_string_lossy());
    let _ = std::fs::remove_file(&path);
    match result {
        Ok(doc) => panic!("fixture {name} unexpectedly imported: {:?}", doc.markdown),
        Err(e) => e,
    }
}

/// Lines of a heading level, e.g. `headings(md, 1)` for every `# ` line.
fn headings(md: &str, level: usize) -> Vec<String> {
    let prefix = format!("{} ", "#".repeat(level));
    md.lines()
        .filter(|l| l.starts_with(&prefix))
        .map(|l| l[prefix.len()..].trim().to_string())
        .collect()
}

/// Position of `needle` in `haystack`, for reading-order assertions.
fn order(haystack: &str, needle: &str) -> usize {
    haystack
        .find(needle)
        .unwrap_or_else(|| panic!("{needle:?} missing from:\n{haystack}"))
}

// ---------------------------------------------------------------------------
// 1. A simple single-column document.
// ---------------------------------------------------------------------------

/// Heading at 20pt over 11pt body, the only size above body on the page, so it
/// ranks as the top heading level. Consecutive body lines are one paragraph; the
/// 30pt gap starts a new one.
fn single_column() -> Vec<u8> {
    pdf::document(
        &[vec![
            (72.0, 720.0, 20.0, "Cell Viability Protocol"),
            (
                72.0,
                686.0,
                11.0,
                "Warm the assay buffer to room temperature",
            ),
            (72.0, 670.0, 11.0, "before adding the reagent to each well."),
            (
                72.0,
                640.0,
                11.0,
                "Read absorbance at 450 nm within ten minutes",
            ),
            (72.0, 624.0, 11.0, "of the final incubation step."),
        ]],
        Some("Cell Viability Protocol"),
    )
}

#[test]
fn single_column_text_keeps_its_heading_and_paragraphs() {
    let doc = import_fixture("single_column", &single_column());
    let md = &doc.markdown;

    // The large line became a heading, not body text.
    assert!(
        headings(md, 1)
            .iter()
            .any(|h| h.contains("Cell Viability Protocol")),
        "expected an H1, got:\n{md}"
    );

    // Body text survives, and lines of one paragraph are joined into prose
    // rather than left as a per-line transcript.
    assert!(md.contains("room temperature"), "got:\n{md}");
    assert!(md.contains("450 nm"), "got:\n{md}");
    assert!(
        md.contains("buffer to room temperature before adding")
            || md.contains("buffer to room temperature\nbefore adding"),
        "paragraph lines were not joined:\n{md}"
    );

    // Reading order is preserved.
    assert!(
        order(md, "Warm the assay") < order(md, "Read absorbance"),
        "got:\n{md}"
    );

    // The two paragraphs are separated by a blank line, not run together.
    assert!(md.contains("\n\n"), "no paragraph break at all:\n{md}");

    // Normalization invariants hold on real output, not just on unit fixtures.
    assert_document_is_clean(md);
}

#[test]
fn the_title_metadata_names_the_imported_document() {
    let doc = import_fixture("titled", &single_column());
    assert_eq!(doc.suggested_name, "Cell Viability Protocol.md");
}

#[test]
fn without_title_metadata_the_file_name_is_used() {
    // Same layout, no /Info entry — the fixture's own file name must win.
    let bytes = pdf::document(
        &[vec![(
            72.0,
            720.0,
            11.0,
            "Body text with no title metadata.",
        )]],
        None,
    );
    let doc = import_fixture("no_title_here", &bytes);
    assert_eq!(doc.suggested_name, "monoleaf_fixture_no_title_here.md");
}

// ---------------------------------------------------------------------------
// 2. A document with a table.
// ---------------------------------------------------------------------------

/// Four rows of three cells on a shared column grid (x = 72 / 250 / 430). Column
/// alignment is the only signal a PDF gives for a table — there are no table
/// operators in the format — so this is what detection has to work from.
fn with_table() -> Vec<u8> {
    let mut lines: Vec<pdf::Line> = vec![(72.0, 720.0, 18.0, "Assay Results")];
    let rows = [
        ["Sample", "Group one", "Signal"],
        ["Sample A", "Treated", "1.24"],
        ["Sample B", "Control", "0.98"],
        ["Sample C", "Treated", "1.31"],
    ];
    for (r, row) in rows.iter().enumerate() {
        let y = 670.0 - (r as f32) * 22.0;
        for (c, cell) in row.iter().enumerate() {
            lines.push(([72.0, 250.0, 430.0][c], y, 11.0, *cell));
        }
    }
    pdf::document(&[lines], None)
}

#[test]
fn table_cells_survive_in_reading_order() {
    let doc = import_fixture("table", &with_table());
    let md = &doc.markdown;

    // Whether or not the grid is recognised as a table, no cell may be lost —
    // that is the invariant worth protecting. Recognition is a heuristic and is
    // asserted separately below.
    for cell in [
        "Sample",
        "Group one",
        "Signal",
        "Sample A",
        "Treated",
        "1.24",
        "Sample B",
        "Control",
        "0.98",
        "Sample C",
        "1.31",
    ] {
        assert!(md.contains(cell), "cell {cell:?} lost:\n{md}");
    }

    // Row-major order: every row's first cell precedes the next row's.
    assert!(order(md, "Sample A") < order(md, "Sample B"), "got:\n{md}");
    assert!(order(md, "Sample B") < order(md, "Sample C"), "got:\n{md}");
    // Within a row, columns stay left to right.
    assert!(order(md, "Sample A") < order(md, "1.24"), "got:\n{md}");

    assert_document_is_clean(md);
}

#[test]
fn a_table_is_not_emitted_as_a_broken_pipe_table() {
    // This fixture draws no cell borders, so there is no grid to recover and its
    // cells arrive as text in reading order (the test above checks none are
    // lost). What must never happen either way is a *half* table — pipe rows
    // with no delimiter row — because GFM renders that as a paragraph full of
    // pipes. Either every pipe block is a well-formed table, or there are none.
    let doc = import_fixture("table_gfm", &with_table());
    let md = &doc.markdown;

    let mut i = 0;
    let lines: Vec<&str> = md.lines().collect();
    while i < lines.len() {
        if !lines[i].trim_start().starts_with('|') {
            i += 1;
            continue;
        }
        let start = i;
        while i < lines.len() && lines[i].trim_start().starts_with('|') {
            i += 1;
        }
        let block = &lines[start..i];
        let delimiters: Vec<usize> = block
            .iter()
            .enumerate()
            .filter(|(_, l)| {
                let t = l.trim();
                t.trim_matches('|').split('|').all(|c| {
                    let c = c.trim();
                    !c.is_empty() && c.chars().all(|ch| ch == '-' || ch == ':')
                })
            })
            .map(|(n, _)| n)
            .collect();
        assert_eq!(
            delimiters,
            vec![1],
            "pipe block is not a well-formed GFM table:\n{md}"
        );
    }
}

// ---------------------------------------------------------------------------
// 3. A multi-column document — best-effort, see the module docs.
// ---------------------------------------------------------------------------

/// Two columns with a wide gutter: left at x = 72, right at x = 340.
///
/// The baselines are deliberately *not* aligned across the gutter and the columns
/// hold different numbers of lines, because that is what running text looks like
/// — and because perfectly aligned rows are a table, not a layout. A PDF carries
/// no marker distinguishing the two; both are just glyphs at coordinates, so a
/// grid of short aligned strings is correctly read as a table (see the note in
/// the test below). This fixture exercises the column-splitting path instead.
fn two_column() -> Vec<u8> {
    let mut lines: Vec<pdf::Line> = vec![(72.0, 730.0, 18.0, "Two Column Layout")];
    let left = [
        "LEFT one the first column of this page begins",
        "at the top and continues downward through",
        "several lines of ordinary running prose that",
        "fill the measure completely.",
        "LEFT last a closing line for this column.",
    ];
    let right = [
        "RIGHT one the second column sits across a",
        "wide gutter from the first and holds its own",
        "sequence of sentences, set at baselines that",
        "do not line up with the column beside it,",
        "exactly as continuous prose behaves when it",
        "RIGHT last flows from one column to the next.",
    ];
    for (i, text) in left.iter().enumerate() {
        lines.push((72.0, 690.0 - (i as f32) * 15.0, 11.0, *text));
    }
    // Offset by 7pt so no right-column baseline coincides with a left one.
    for (i, text) in right.iter().enumerate() {
        lines.push((340.0, 683.0 - (i as f32) * 15.0, 11.0, *text));
    }
    pdf::document(&[lines], None)
}

#[test]
fn multi_column_text_is_not_lost_and_columns_are_not_interleaved_mid_line() {
    let doc = import_fixture("two_column", &two_column());
    let md = &doc.markdown;

    // No text may be dropped, whatever order the columns come out in. This is
    // the guarantee that actually matters for an import: the words are all in
    // the document, so nothing is silently lost even if the layout is imperfect.
    for fragment in [
        "first column of this page begins",
        "fill the measure completely",
        "LEFT last",
        "second column sits across a",
        "RIGHT last",
    ] {
        assert!(md.contains(fragment), "fragment {fragment:?} lost:\n{md}");
    }

    // Within each column, lines stay in order. Whether the left column is
    // emitted before the right is a property of the XY-cut and is not asserted
    // — see the module docs on multi-column being best-effort.
    assert!(order(md, "LEFT one") < order(md, "LEFT last"), "got:\n{md}");
    assert!(
        order(md, "RIGHT one") < order(md, "RIGHT last"),
        "got:\n{md}"
    );

    // The columns are read one after the other, not zip-stitched by baseline:
    // all of the left column precedes all of the right.
    assert!(
        order(md, "LEFT last") < order(md, "RIGHT one"),
        "columns interleaved:\n{md}"
    );

    // And no line mixes text from both columns.
    for line in md.lines() {
        assert!(
            !(line.contains("LEFT one") && line.contains("RIGHT one")),
            "columns interleaved within one line:\n{md}"
        );
    }

    assert_document_is_clean(md);
}

// ---------------------------------------------------------------------------
// 4. A real browser-printed PDF — the regression this pipeline exists for.
// ---------------------------------------------------------------------------

/// The one fixture that is a committed binary rather than generated.
///
/// Everything else here is built in-process, because a hand-written layout is
/// reviewable and a checked-in PDF is not. This one is the exception on purpose:
/// what it tests *is* a specific producer's glyph encoding. Chromium positions
/// text with per-glyph advances and emits no space characters, and that encoding
/// cannot be faked with the writer above — which is exactly why the first
/// implementation of this feature passed every synthetic test and still shredded
/// real browser output into `Theplatewasincubated` and `W arm`.
///
/// Monoleaf's own PDF export goes through WebView2, i.e. this same engine, so
/// this fixture stands in for re-importing a document Monoleaf exported.
/// `tests/fixtures/browser-print.html` is the source, with the command to
/// regenerate it.
fn browser_print_pdf() -> Vec<u8> {
    std::fs::read(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/browser-print.pdf"),
    )
    .expect("fixture tests/fixtures/browser-print.pdf is missing")
}

#[test]
fn a_browser_printed_pdf_keeps_its_word_spacing() {
    let doc = import_fixture("browser_print", &browser_print_pdf());
    let md = &doc.markdown;

    // Phrases that only survive if spaces are reconstructed from pen advances.
    for phrase in [
        "Warm the assay buffer to room temperature",
        "Read absorbance at 450 nm",
        "The plate was incubated for ninety minutes",
        "humidified chamber",
    ] {
        assert!(md.contains(phrase), "phrase {phrase:?} not intact:\n{md}");
    }

    // And the specific corruptions that motivated this pipeline.
    for garbled in [
        "Theplatewasincubated",
        "W arm",
        "AssayRepo",
        "m id if ie",
        "thereagentwasaddedto",
    ] {
        assert!(
            !md.contains(garbled),
            "text was shredded ({garbled:?}):\n{md}"
        );
    }

    assert_document_is_clean(md);
}

#[test]
fn a_browser_printed_pdf_keeps_its_reading_order() {
    let doc = import_fixture("browser_print_order", &browser_print_pdf());
    let md = &doc.markdown;
    assert!(
        order(md, "Assay Report") < order(md, "Method notes"),
        "got:\n{md}"
    );
    assert!(
        order(md, "Method notes") < order(md, "Closing paragraph"),
        "got:\n{md}"
    );
    // A word must not be split across blocks, as it was before.
    assert!(
        order(md, "Assay Report") + 40 > order(md, "Warm the assay"),
        "the heading and the paragraph after it drifted apart:\n{md}"
    );
}

#[test]
fn a_browser_printed_pdf_keeps_its_structure() {
    let doc = import_fixture("browser_print_structure", &browser_print_pdf());
    let md = &doc.markdown;

    // 20pt over 11pt body, and 15pt over 11pt: two heading levels.
    assert!(
        headings(md, 1).iter().any(|h| h.contains("Assay Report")),
        "no H1:\n{md}"
    );
    assert!(
        headings(md, 2).iter().any(|h| h.contains("Method notes")),
        "no H2:\n{md}"
    );

    // The <ul> becomes list items.
    let bullets: Vec<&str> = md.lines().filter(|l| l.starts_with("- ")).collect();
    assert_eq!(
        bullets.len(),
        2,
        "expected two list items, got {bullets:?}\n{md}"
    );
    assert!(bullets[0].contains("First bullet point"), "got:\n{md}");

    // The bordered table is recovered as a real GFM table, from the 0.7pt rules
    // the browser draws for the cell borders.
    assert!(
        md.contains("| Sample | Group | Signal |"),
        "no header row:\n{md}"
    );
    assert!(
        md.contains("| --- | --- | --- |"),
        "no delimiter row:\n{md}"
    );
    assert!(
        md.contains("| Sample A | Treated | 1.24 |"),
        "no data row:\n{md}"
    );
    assert!(md.contains("| Sample B | Control | 0.98 |"), "got:\n{md}");

    // The title metadata Chrome writes is the HTML file name, which is rejected
    // as a title, so the suggestion falls back to the source file name.
    assert_eq!(
        doc.suggested_name,
        "monoleaf_fixture_browser_print_structure.md"
    );
}

// ---------------------------------------------------------------------------
// 5. Failure modes — must be a clear message, never a panic or an empty doc.
// ---------------------------------------------------------------------------

#[test]
fn an_image_only_pdf_is_rejected_as_having_no_text() {
    // A page with no text operators at all — what a scan looks like once its
    // image is set aside. Import must refuse it rather than open a blank doc.
    let bytes = pdf::document(&[vec![]], None);
    let err = import_err("image_only", &bytes);
    assert!(err.contains("No text could be extracted"), "got: {err}");
    // The message has to say why, and that OCR is not coming to the rescue.
    assert!(err.contains("scan"), "got: {err}");
    assert!(err.contains("OCR"), "got: {err}");
}

#[test]
fn a_malformed_pdf_fails_with_a_message_not_a_panic() {
    // Right header, garbage body: passes the format sniff, fails to parse.
    let mut bytes = b"%PDF-1.4\n".to_vec();
    bytes.extend_from_slice(&[0xDE, 0xAD, 0xBE, 0xEF].repeat(64));
    let err = import_err("malformed", &bytes);
    assert!(!err.is_empty());
    assert!(err.ends_with('.'), "not a sentence: {err}");
}

#[test]
fn a_truncated_pdf_fails_with_a_message_not_a_panic() {
    // A valid PDF cut off mid-body: the xref table it points to is gone.
    let full = single_column();
    let bytes = &full[..full.len() / 2];
    let err = import_err("truncated", bytes);
    assert!(!err.is_empty());
    assert!(err.ends_with('.'), "not a sentence: {err}");
}

#[test]
fn a_file_that_is_not_a_pdf_at_all_is_rejected() {
    let err = import_err("not_a_pdf", b"This is a plain text file, not a PDF.");
    assert!(!err.is_empty());
    assert!(err.ends_with('.'), "not a sentence: {err}");
}

// ---------------------------------------------------------------------------
// Invariants every imported document must satisfy.
// ---------------------------------------------------------------------------

/// The properties that make converted output safe to treat as a Monoleaf
/// document. Checked on every successful fixture above, so real extraction
/// output is held to them and not only the normalizer's unit fixtures.
fn assert_document_is_clean(md: &str) {
    // An HTML comment in the source would be matched by Monoleaf's own metadata,
    // comment-thread and page-setup regexes, which run over the raw text.
    assert!(!md.contains("<!--"), "HTML comment survived:\n{md}");
    assert!(!md.contains("ml:meta"), "metadata block present:\n{md}");

    // Likewise a CriticMarkup opener would be read as a real tracked change,
    // and accepting changes would then rewrite the document.
    for token in ["{++", "{--", "{~~", "{==", "{>>"] {
        assert!(
            !md.contains(token),
            "critic opener {token:?} survived:\n{md}"
        );
    }

    // No YAML frontmatter — an imported document starts untracked.
    assert!(!md.starts_with("---\n"), "frontmatter injected:\n{md}");

    // Images are not extracted, so no link may point at a missing file.
    assert!(
        !md.contains("]("),
        "an image or link to nowhere survived:\n{md}"
    );

    // No absurdly long run of non-space characters. This is the general form of
    // the browser-print defect: when word spacing is not reconstructed, whole
    // clauses fuse into one token. Natural language, and every fixture here,
    // stays far below this.
    for token in md.split_whitespace() {
        assert!(
            token.chars().count() <= 40,
            "token {token:?} looks like fused words — spacing was lost:\n{md}"
        );
    }

    // Whitespace is normalized: LF only, no trailing spaces, no triple blank
    // line, exactly one final newline.
    assert!(!md.contains('\r'), "CR survived:\n{md}");
    assert!(!md.contains("\n\n\n"), "blank run not collapsed:\n{md}");
    assert!(md.ends_with('\n'), "no final newline:\n{md}");
    assert!(!md.ends_with("\n\n"), "more than one final newline:\n{md}");
    for line in md.lines() {
        assert_eq!(line, line.trim_end(), "trailing whitespace on {line:?}");
    }

    // And it is not empty, which is the failure this whole path guards against.
    assert!(pdfimport::has_extractable_text(md), "no words:\n{md}");
}
