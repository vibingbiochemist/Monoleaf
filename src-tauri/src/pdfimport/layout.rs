//! Glyph stream → positioned lines of text.
//!
//! `pdf-extract` walks a page's content stream and hands us one callback per
//! glyph, with the text matrix in force. This module turns that stream back into
//! lines: where a word ends, where a line ends, and where each line sits on the
//! page. [`super::structure`] then reads meaning out of those coordinates.
//!
//! ## Why the geometry is done here and not inferred from text
//!
//! A PDF has no words, lines, paragraphs or tables — only glyphs at positions.
//! Spaces usually aren't characters either: a producer moves the pen instead. So
//! "is there a space here" is a question about *distance*, answered against the
//! effective font size. Getting that one threshold wrong is what shreds text
//! into `Theplatewasincubated` or `W arm` (see the module docs in `super`).
//!
//! The word- and line-break rules below are deliberately the same ones
//! `pdf-extract`'s own `PlainTextOutput` uses, including the constants, because
//! that implementation is verified to reconstruct browser-printed PDFs
//! correctly. We keep its decisions and only change what we build from them:
//! positioned [`Line`]s instead of a flat string.

use pdf_extract::{ColorSpace, MediaBox, OutputDev, OutputError, Path, PathOp, Transform};

// --- Word and line break thresholds, as multiples of the glyph's own size -----
//
// These three are `pdf-extract`'s own values, taken from its `PlainTextOutput`
// rather than chosen here, because that implementation is verified to
// reconstruct browser-printed PDFs correctly (see the module docs). Changing
// them is how text ends up shredded into `Theplatewasincubated` or `W arm`, so
// they should only move with a fixture proving the improvement.

/// A vertical move larger than this many times the glyph size is a new line,
/// whichever direction the pen went.
const LINE_BREAK_DY: f64 = 1.5;

/// A smaller vertical move is still a new line if the pen also went *back to the
/// left* — that combination is a wrap, not a gap within one line.
const WRAP_DY: f64 = 0.5;

/// A horizontal gap wider than this fraction of the glyph size is a space. Kept
/// tight because intra-word kerning is a gap too, and treating one as a space is
/// what splits `Warm` into `W arm`.
const SPACE_GAP: f64 = 0.1;

// --- Drawn-shape classification, in PDF points -------------------------------
//
// The rule and marker tests are deliberately disjoint, so no shape can be both:
// a rule is hair-thin (well under a point in practice) and long, a bullet is a
// few points square. Everything else a page draws — cell shading, rounded
// boxes, logos — falls between the two and is ignored.

/// Above this, a shape is too thick to be a table rule.
const RULE_MAX_THICKNESS_PT: f64 = 2.5;

/// Below this, a thin shape is too short to be a table rule.
const RULE_MIN_LENGTH_PT: f64 = 4.0;

/// Below this, a small shape is a rule fragment rather than a bullet.
const MARKER_MIN_SIZE_PT: f64 = 1.5;

/// Above this, a small shape is too large to be a list bullet.
const MARKER_MAX_SIZE_PT: f64 = 8.0;

/// A single word and the horizontal band it occupies.
///
/// Kept per word, not just per line, because a table's cells sit on one shared
/// baseline: the line "Sample A Treated 1.24" is one line of text but three
/// cells, and only the words' own x positions can say where the columns split.
#[derive(Debug, Clone, PartialEq)]
pub struct Word {
    pub text: String,
    pub x0: f64,
    pub x1: f64,
}

/// A thin filled or stroked rectangle — a table rule.
///
/// Producers draw table borders as long, hair-thin rectangles rather than as any
/// kind of table object, so these are the only direct evidence a page contains a
/// grid. Monoleaf's own export draws every cell border, which is what makes its
/// PDFs reconstruct well.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Rule {
    pub horizontal: bool,
    pub x0: f64,
    pub x1: f64,
    pub y0: f64,
    pub y1: f64,
}

/// A small filled blob to the left of a line — a list bullet.
///
/// A browser draws `<ul>` markers as filled paths (a bezier disc), not as text,
/// so a bullet leaves *no character at all* in the text layer. Without this the
/// items of a browser-printed list are indistinguishable from an indented
/// paragraph and merge into one.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Marker {
    pub x: f64,
    pub y: f64,
}

/// One line of text with the geometry needed to classify it.
///
/// Coordinates are in PDF points with the y-axis flipped to grow *downward*, so
/// a smaller `y` is higher on the page and lines sort naturally by reading order.
#[derive(Debug, Clone, PartialEq)]
pub struct Line {
    /// The line's words joined by single spaces.
    pub text: String,
    /// The same words, with their positions, for splitting a line into cells.
    pub words: Vec<Word>,
    /// Left edge of the first glyph — the indent, which is what marks a nested
    /// list item or a continuation line.
    pub x0: f64,
    /// Right edge of the last glyph.
    pub x1: f64,
    /// Baseline, y-down.
    pub y: f64,
    /// Mean effective font size over the line's glyphs. Heading detection
    /// compares this against the document's body size.
    pub size: f64,
    /// Glyphs on the line, used to weight the body-size estimate so a short
    /// heading cannot outvote a page of prose.
    pub chars: usize,
}

/// A page's lines in the order their glyphs appeared, plus the shapes drawn on
/// it that carry structure.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Page {
    pub width: f64,
    pub height: f64,
    pub lines: Vec<Line>,
    pub rules: Vec<Rule>,
    pub markers: Vec<Marker>,
}

/// Accumulates one line at a time.
#[derive(Default)]
struct LineBuilder {
    words: Vec<Word>,
    word: Option<Word>,
    x0: f64,
    x1: f64,
    y: f64,
    size_sum: f64,
    chars: usize,
}

impl LineBuilder {
    /// Close the word in progress.
    fn break_word(&mut self) {
        if let Some(w) = self.word.take() {
            if !w.text.trim().is_empty() {
                self.words.push(w);
            }
        }
    }

    fn finish(mut self) -> Option<Line> {
        self.break_word();
        // A line of nothing but spaces carries no content but would still take
        // part in paragraph spacing, so it is dropped here.
        if self.words.is_empty() {
            return None;
        }
        Some(Line {
            text: self
                .words
                .iter()
                .map(|w| w.text.as_str())
                .collect::<Vec<_>>()
                .join(" "),
            words: self.words,
            x0: self.x0,
            x1: self.x1,
            y: self.y,
            size: if self.chars > 0 {
                self.size_sum / self.chars as f64
            } else {
                0.0
            },
            chars: self.chars,
        })
    }
}

/// Transform a user-space point by `ctm` and flip y to grow downward.
fn device_point(ctm: &Transform, x: f64, y: f64, page_height: f64) -> (f64, f64) {
    let dx = x * ctm.m11 + y * ctm.m21 + ctm.m31;
    let dy = x * ctm.m12 + y * ctm.m22 + ctm.m32;
    (dx, page_height - dy)
}

/// The device-space bounding box of a path: `(x0, y0, x1, y1)`, y-down.
fn path_bounds(ctm: &Transform, path: &Path, page_height: f64) -> Option<(f64, f64, f64, f64)> {
    let mut pts: Vec<(f64, f64)> = Vec::new();
    for op in &path.ops {
        match *op {
            PathOp::MoveTo(x, y) | PathOp::LineTo(x, y) => {
                pts.push(device_point(ctm, x, y, page_height))
            }
            PathOp::Rect(x, y, w, h) => {
                pts.push(device_point(ctm, x, y, page_height));
                pts.push(device_point(ctm, x + w, y + h, page_height));
            }
            PathOp::CurveTo(a, b, c, d, e, f) => {
                // Control points overstate a curve's extent slightly; for the
                // size tests below that is immaterial.
                pts.push(device_point(ctm, a, b, page_height));
                pts.push(device_point(ctm, c, d, page_height));
                pts.push(device_point(ctm, e, f, page_height));
            }
            PathOp::Close => {}
        }
    }
    if pts.is_empty() {
        return None;
    }
    let x0 = pts.iter().map(|p| p.0).fold(f64::MAX, f64::min);
    let x1 = pts.iter().map(|p| p.0).fold(f64::MIN, f64::max);
    let y0 = pts.iter().map(|p| p.1).fold(f64::MAX, f64::min);
    let y1 = pts.iter().map(|p| p.1).fold(f64::MIN, f64::max);
    Some((x0, y0, x1, y1))
}

/// [`OutputDev`] that collects positioned lines instead of writing text.
#[derive(Default)]
pub struct Collector {
    pages: Vec<Page>,
    page_width: f64,
    page_height: f64,
    lines: Vec<Line>,
    rules: Vec<Rule>,
    markers: Vec<Marker>,
    line: Option<LineBuilder>,
    /// True at the first glyph of a word — the only point at which a break can
    /// be introduced (see the module docs).
    first_char: bool,
    /// Baseline of the previous glyph, y-down.
    last_y: f64,
    /// Right edge of the previous glyph; the gap to the next one decides whether
    /// a space belongs between them.
    last_end: f64,
}

impl Collector {
    pub fn new() -> Self {
        Self {
            // Starts far to the right so the very first glyph can never be read
            // as continuing a previous line.
            last_end: f64::MAX,
            ..Default::default()
        }
    }

    /// The collected pages, flushing whatever is still open.
    pub fn into_pages(mut self) -> Vec<Page> {
        self.flush_line();
        self.flush_page();
        self.pages
    }

    fn flush_line(&mut self) {
        if let Some(line) = self.line.take().and_then(LineBuilder::finish) {
            self.lines.push(line);
        }
    }

    fn flush_page(&mut self) {
        if self.lines.is_empty() {
            self.rules.clear();
            self.markers.clear();
            return;
        }
        self.pages.push(Page {
            width: self.page_width,
            height: self.page_height,
            lines: std::mem::take(&mut self.lines),
            rules: std::mem::take(&mut self.rules),
            markers: std::mem::take(&mut self.markers),
        });
    }

    /// Classify a drawn shape, keeping only the two kinds that carry structure.
    ///
    /// Everything else a page draws — cell shading, rounded boxes, logos, image
    /// placements — is deliberately ignored. The two size tests are disjoint: a
    /// rule is hair-thin (well under a point) and long, a bullet is a few points
    /// square, and nothing is both.
    fn record_shape(&mut self, ctm: &Transform, path: &Path) {
        let Some((x0, y0, x1, y1)) = path_bounds(ctm, path, self.page_height) else {
            return;
        };
        let (w, h) = (x1 - x0, y1 - y0);
        let (thin, thick) = if w < h { (w, h) } else { (h, w) };

        if thin <= RULE_MAX_THICKNESS_PT && thick >= RULE_MIN_LENGTH_PT {
            self.rules.push(Rule {
                horizontal: w >= h,
                x0,
                x1,
                y0,
                y1,
            });
        } else if thin >= MARKER_MIN_SIZE_PT && thick <= MARKER_MAX_SIZE_PT {
            self.markers.push(Marker {
                x: (x0 + x1) / 2.0,
                y: (y0 + y1) / 2.0,
            });
        }
    }
}

impl OutputDev for Collector {
    fn begin_page(
        &mut self,
        _page_num: u32,
        media_box: &MediaBox,
        _art_box: Option<(f64, f64, f64, f64)>,
    ) -> Result<(), OutputError> {
        self.flush_line();
        self.flush_page();
        self.page_width = media_box.urx - media_box.llx;
        self.page_height = media_box.ury - media_box.lly;
        self.last_end = f64::MAX;
        self.last_y = 0.0;
        Ok(())
    }

    fn end_page(&mut self) -> Result<(), OutputError> {
        self.flush_line();
        self.flush_page();
        Ok(())
    }

    fn output_character(
        &mut self,
        trm: &Transform,
        width: f64,
        _spacing: f64,
        font_size: f64,
        ch: &str,
    ) -> Result<(), OutputError> {
        // The glyph's position, y flipped so it grows downward. This is
        // `trm.post_transform(flip)` written out: composing with
        // [1 0; 0 -1; 0 height] leaves x alone and maps y to height - y.
        let x = trm.m31;
        let y = self.page_height - trm.m32;

        // The size the glyph is actually drawn at. `font_size` is only the `Tf`
        // operand, and producers routinely set `Tf 1` and put the real scale in
        // the text matrix — so the matrix has to be applied or every size
        // comparison downstream is meaningless. This is the side of the square
        // with the same area as the transformed (size, size) box.
        let vx = font_size * (trm.m11 + trm.m21);
        let vy = font_size * (trm.m12 + trm.m22);
        let size = (vx * vy).abs().sqrt();
        // A degenerate matrix would otherwise poison every threshold below.
        let size = if size.is_finite() && size > 0.0 {
            size
        } else {
            font_size.abs().max(1.0)
        };

        if self.first_char {
            // Far vertical move, or any move back to the left combined with a
            // vertical one: a new line either way.
            let dy = (y - self.last_y).abs();
            if dy > size * LINE_BREAK_DY || (x < self.last_end && dy > size * WRAP_DY) {
                self.flush_line();
            } else if x > self.last_end + size * SPACE_GAP {
                // Same line, pen skipped ahead: that gap is a space.
                if let Some(line) = self.line.as_mut() {
                    line.break_word();
                }
            }
        }

        let line = self.line.get_or_insert_with(|| LineBuilder {
            x0: x,
            y,
            ..Default::default()
        });
        // A space arriving as an actual character is a word break too.
        if ch.chars().all(char::is_whitespace) {
            line.break_word();
        } else {
            match line.word.as_mut() {
                Some(word) => {
                    word.text.push_str(ch);
                    word.x1 = x + width * size;
                }
                None => {
                    line.word = Some(Word {
                        text: ch.to_string(),
                        x0: x,
                        x1: x + width * size,
                    })
                }
            }
        }
        line.x1 = x + width * size;
        line.size_sum += size;
        line.chars += 1;

        self.first_char = false;
        self.last_y = y;
        self.last_end = x + width * size;
        Ok(())
    }

    fn begin_word(&mut self) -> Result<(), OutputError> {
        self.first_char = true;
        Ok(())
    }

    fn end_word(&mut self) -> Result<(), OutputError> {
        Ok(())
    }

    fn end_line(&mut self) -> Result<(), OutputError> {
        // Deliberately ignored: this fires on the content stream's own line
        // operators, which producers use for wrapping *within* a paragraph as
        // well as between them. Geometry is the more reliable signal.
        Ok(())
    }

    fn fill(
        &mut self,
        ctm: &Transform,
        _colorspace: &ColorSpace,
        _color: &[f64],
        path: &Path,
    ) -> Result<(), OutputError> {
        self.record_shape(ctm, path);
        Ok(())
    }

    fn stroke(
        &mut self,
        ctm: &Transform,
        _colorspace: &ColorSpace,
        _color: &[f64],
        path: &Path,
    ) -> Result<(), OutputError> {
        self.record_shape(ctm, path);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A text matrix for upright text of the given size at (x, y-up).
    fn trm(x: f64, y: f64, scale: f64) -> Transform {
        Transform::row_major(scale, 0.0, 0.0, scale, x, y)
    }

    /// Feed a string as consecutive glyphs of equal width on one baseline.
    fn write(c: &mut Collector, x: f64, y: f64, size: f64, text: &str) {
        // 0.5 em per glyph — close enough to a real average advance.
        let advance = 0.5;
        for (i, ch) in text.chars().enumerate() {
            c.begin_word().unwrap();
            let gx = x + i as f64 * advance * size;
            c.output_character(&trm(gx, y, 1.0), advance, 0.0, size, &ch.to_string())
                .unwrap();
        }
    }

    fn page(height: f64) -> MediaBox {
        MediaBox {
            llx: 0.0,
            lly: 0.0,
            urx: 612.0,
            ury: height,
        }
    }

    #[test]
    fn glyphs_on_one_baseline_become_one_line() {
        let mut c = Collector::new();
        c.begin_page(1, &page(792.0), None).unwrap();
        write(&mut c, 72.0, 700.0, 10.0, "Hello");
        let pages = c.into_pages();
        assert_eq!(pages.len(), 1);
        assert_eq!(pages[0].lines.len(), 1);
        assert_eq!(pages[0].lines[0].text, "Hello");
        assert_eq!(pages[0].lines[0].chars, 5);
    }

    #[test]
    fn the_y_axis_is_flipped_so_lines_sort_by_reading_order() {
        let mut c = Collector::new();
        c.begin_page(1, &page(792.0), None).unwrap();
        write(&mut c, 72.0, 700.0, 10.0, "top");
        write(&mut c, 72.0, 600.0, 10.0, "bottom");
        let pages = c.into_pages();
        let lines = &pages[0].lines;
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0].text, "top");
        // y grows downward: the higher line on the page has the smaller y.
        assert!(lines[0].y < lines[1].y, "{:?}", lines);
        assert_eq!(lines[0].y, 92.0); // 792 - 700
    }

    #[test]
    fn a_pen_gap_becomes_a_space_and_a_tight_gap_does_not() {
        // This is the defect that shreds browser-printed PDFs in both
        // directions: gaps must become spaces, kerning must not.
        let mut c = Collector::new();
        c.begin_page(1, &page(792.0), None).unwrap();
        // "up" then, after a wide gap on the same baseline, "down".
        write(&mut c, 72.0, 700.0, 10.0, "up");
        write(&mut c, 140.0, 700.0, 10.0, "down");
        let lines = c.into_pages().remove(0).lines;
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0].text, "up down");
    }

    #[test]
    fn kerning_does_not_split_a_word() {
        let mut c = Collector::new();
        c.begin_page(1, &page(792.0), None).unwrap();
        // Glyphs placed with a tiny negative adjustment, as a kern pair would be.
        let size = 10.0;
        for (i, ch) in "Warm".chars().enumerate() {
            c.begin_word().unwrap();
            let gx = 72.0 + i as f64 * 5.0 - 0.3; // slight tuck-in
            c.output_character(&trm(gx, 700.0, 1.0), 0.5, 0.0, size, &ch.to_string())
                .unwrap();
        }
        let lines = c.into_pages().remove(0).lines;
        assert_eq!(lines[0].text, "Warm", "kerning was read as a space");
    }

    #[test]
    fn the_effective_size_comes_from_the_matrix_not_the_tf_operand() {
        // `Tf 1` with the real scale in the text matrix — very common, and
        // trusting font_size alone would report every line as 1pt.
        let mut c = Collector::new();
        c.begin_page(1, &page(792.0), None).unwrap();
        c.begin_word().unwrap();
        c.output_character(&trm(72.0, 700.0, 24.0), 0.5, 0.0, 1.0, "H")
            .unwrap();
        let lines = c.into_pages().remove(0).lines;
        assert!(
            (lines[0].size - 24.0).abs() < 0.001,
            "size was {}",
            lines[0].size
        );
    }

    #[test]
    fn a_degenerate_matrix_does_not_produce_a_nan_size() {
        let mut c = Collector::new();
        c.begin_page(1, &page(792.0), None).unwrap();
        c.begin_word().unwrap();
        c.output_character(
            &Transform::row_major(0.0, 0.0, 0.0, 0.0, 72.0, 700.0),
            0.5,
            0.0,
            11.0,
            "x",
        )
        .unwrap();
        let lines = c.into_pages().remove(0).lines;
        assert!(lines[0].size.is_finite() && lines[0].size > 0.0);
    }

    #[test]
    fn blank_and_whitespace_only_lines_are_dropped() {
        let mut c = Collector::new();
        c.begin_page(1, &page(792.0), None).unwrap();
        write(&mut c, 72.0, 700.0, 10.0, "   ");
        write(&mut c, 72.0, 600.0, 10.0, "real");
        let lines = c.into_pages().remove(0).lines;
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0].text, "real");
    }

    #[test]
    fn interior_whitespace_runs_collapse_to_one_space() {
        let mut c = Collector::new();
        c.begin_page(1, &page(792.0), None).unwrap();
        write(&mut c, 72.0, 700.0, 10.0, "a     b");
        let lines = c.into_pages().remove(0).lines;
        assert_eq!(lines[0].text, "a b");
    }

    #[test]
    fn each_page_is_collected_separately() {
        let mut c = Collector::new();
        c.begin_page(1, &page(792.0), None).unwrap();
        write(&mut c, 72.0, 700.0, 10.0, "one");
        c.end_page().unwrap();
        c.begin_page(2, &page(792.0), None).unwrap();
        write(&mut c, 72.0, 700.0, 10.0, "two");
        c.end_page().unwrap();
        let pages = c.into_pages();
        assert_eq!(pages.len(), 2);
        assert_eq!(pages[0].lines[0].text, "one");
        assert_eq!(pages[1].lines[0].text, "two");
    }

    #[test]
    fn an_empty_page_contributes_nothing() {
        let mut c = Collector::new();
        c.begin_page(1, &page(792.0), None).unwrap();
        c.end_page().unwrap();
        assert!(c.into_pages().is_empty());
    }

    #[test]
    fn words_keep_their_own_horizontal_positions() {
        // What lets a shared baseline be split back into table cells.
        let mut c = Collector::new();
        c.begin_page(1, &page(792.0), None).unwrap();
        write(&mut c, 72.0, 700.0, 10.0, "ab");
        write(&mut c, 300.0, 700.0, 10.0, "cd");
        let lines = c.into_pages().remove(0).lines;
        assert_eq!(lines.len(), 1);
        let words = &lines[0].words;
        assert_eq!(words.len(), 2, "{words:?}");
        assert_eq!(words[0].text, "ab");
        assert_eq!(words[1].text, "cd");
        assert!((words[0].x0 - 72.0).abs() < 0.01, "{words:?}");
        assert!((words[1].x0 - 300.0).abs() < 0.01, "{words:?}");
        assert!(words[0].x1 < words[1].x0, "{words:?}");
    }

    // --- drawn shapes ---

    /// Fill a rectangle in device-ish space (identity ctm, y measured from the
    /// bottom as PDF does).
    fn fill_rect(c: &mut Collector, x: f64, y: f64, w: f64, h: f64) {
        let path = Path {
            ops: vec![PathOp::Rect(x, y, w, h)],
        };
        c.fill(
            &Transform::row_major(1.0, 0.0, 0.0, 1.0, 0.0, 0.0),
            &ColorSpace::DeviceGray,
            &[0.0],
            &path,
        )
        .unwrap();
    }

    #[test]
    fn thin_long_rectangles_are_recorded_as_table_rules() {
        let mut c = Collector::new();
        c.begin_page(1, &page(792.0), None).unwrap();
        write(&mut c, 72.0, 700.0, 10.0, "x"); // a page needs text to be kept
        fill_rect(&mut c, 63.0, 500.0, 180.0, 0.7); // horizontal rule
        fill_rect(&mut c, 63.0, 480.0, 0.7, 24.0); // vertical rule
        let p = c.into_pages().remove(0);
        assert_eq!(p.rules.len(), 2, "{:?}", p.rules);
        assert!(p.rules[0].horizontal, "{:?}", p.rules);
        assert!(!p.rules[1].horizontal, "{:?}", p.rules);
        assert!(p.markers.is_empty(), "{:?}", p.markers);
    }

    #[test]
    fn a_small_blob_is_recorded_as_a_list_marker() {
        let mut c = Collector::new();
        c.begin_page(1, &page(792.0), None).unwrap();
        write(&mut c, 93.0, 700.0, 10.0, "item");
        fill_rect(&mut c, 81.7, 700.0, 3.0, 3.0);
        let p = c.into_pages().remove(0);
        assert_eq!(p.markers.len(), 1, "{:?}", p.markers);
        assert!((p.markers[0].x - 83.2).abs() < 0.5, "{:?}", p.markers);
        assert!(p.rules.is_empty(), "{:?}", p.rules);
    }

    #[test]
    fn cell_shading_and_large_fills_are_ignored() {
        // A table header's background is a big rectangle; it is neither a rule
        // nor a bullet and must not be mistaken for either.
        let mut c = Collector::new();
        c.begin_page(1, &page(792.0), None).unwrap();
        write(&mut c, 72.0, 700.0, 10.0, "x");
        fill_rect(&mut c, 63.0, 480.0, 180.0, 23.0);
        let p = c.into_pages().remove(0);
        assert!(p.rules.is_empty(), "{:?}", p.rules);
        assert!(p.markers.is_empty(), "{:?}", p.markers);
    }

    #[test]
    fn the_y_flip_applies_to_shapes_as_well_as_text() {
        let mut c = Collector::new();
        c.begin_page(1, &page(792.0), None).unwrap();
        write(&mut c, 72.0, 700.0, 10.0, "x");
        fill_rect(&mut c, 63.0, 500.0, 180.0, 0.7);
        let p = c.into_pages().remove(0);
        // A rule at y=500 from the bottom of a 792pt page is at ~292 from the top.
        assert!(
            (p.rules[0].y0 - (792.0 - 500.7)).abs() < 0.01,
            "{:?}",
            p.rules
        );
    }
}
