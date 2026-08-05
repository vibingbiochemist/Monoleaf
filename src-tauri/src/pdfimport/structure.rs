//! Positioned lines → Markdown blocks.
//!
//! Everything here is geometry and text, with no PDF types in sight, so the
//! heuristics can be tested against hand-written [`Line`] values. That is
//! deliberate: these rules are judgement calls about layout, and they need to be
//! readable and adjustable without a PDF in the loop.
//!
//! ## The rules, and why each one
//!
//! - **Body size** is the character-weighted median line size. Weighting by
//!   character count stops a big title on page one from being mistaken for the
//!   document's normal type.
//! - **Headings** are lines set larger than body text, graded by *rank* among
//!   the document's own type sizes rather than by fixed ratios. Type size is the
//!   only heading signal a PDF reliably carries; bold-only headings set at body
//!   size are not recoverable and come through as paragraphs.
//! - **Paragraphs** are runs of same-size lines with ordinary leading. A wider
//!   vertical gap, a size change, or a list marker ends one.
//! - **Lists** are found by their marker glyph, or — when a producer draws the
//!   bullet as a path and leaves no character behind — by a small blob to the
//!   left of the line. Nesting comes from the indent.
//! - **Tables** are read out of the rules drawn around their cells, since a PDF
//!   has no table object. Each *word* is placed by its own position, because a
//!   table row shares one baseline and is a single line of text.
//! - **Columns** are found by looking for a vertical gutter no line crosses.
//!   Best-effort, as the module docs in `super` say.

use super::layout::{Line, Page, Rule};

// --- Type-size thresholds ----------------------------------------------------

/// A line must be at least this much larger than body text to be a heading
/// candidate. Just above measurement noise from the text matrix.
const HEADING_MIN_RATIO: f64 = 1.10;

/// Two type sizes within this fraction of each other are the same heading level.
/// Absorbs the rounding that comes out of the text matrix, so a 19.99pt and a
/// 20.01pt title do not become H1 and H2.
const SIZE_CLUSTER_TOLERANCE: f64 = 0.04;

/// Markdown has six heading levels; a document using more distinct sizes than
/// this collapses the remainder into the last.
const MAX_HEADING_LEVEL: usize = 6;

/// A type-size change by more than this ratio ends a paragraph.
const PARAGRAPH_SIZE_BREAK: f64 = 1.15;

/// A vertical gap larger than this many times the line's own size ends a
/// paragraph. Above ordinary leading, below the space producers put between
/// blocks.
const PARAGRAPH_GAP: f64 = 1.8;

// --- Table grid geometry, in PDF points --------------------------------------

/// Rule coordinates within this distance are the same grid boundary. Producers
/// draw a shared border as two abutting hairlines, and a cell's own left rule
/// sits a fraction from its neighbour's right rule.
const RULE_CLUSTER_TOLERANCE_PT: f64 = 2.0;

/// How far outside a grid's bounds a glyph may sit and still belong to it. A
/// glyph's box legitimately pokes a fraction past the hairline it sits against.
const CELL_SLACK_PT: f64 = 2.0;

/// Horizontal rules further apart than this belong to different tables. Roughly
/// six lines of body text: within one table, never between two.
const TABLE_BAND_GAP_PT: f64 = 120.0;

// --- Column detection --------------------------------------------------------

/// A line covering more than this fraction of the measure cannot sit inside one
/// column, so it is set aside before looking for a gutter (a title, a full-width
/// table).
const SPANNING_LINE_FRACTION: f64 = 0.7;

/// A vertical gap narrower than this fraction of the measure is word spacing,
/// not a column break.
const MIN_GUTTER_FRACTION: f64 = 0.04;

/// Below this many lines a page has too little evidence to split into columns.
const MIN_LINES_FOR_COLUMNS: usize = 4;

/// Each side of a gutter needs at least this many lines, or it is one column
/// with a ragged edge.
const MIN_LINES_PER_COLUMN: usize = 2;

// --- Lists -------------------------------------------------------------------

/// List indents within this fraction of the body size are the same nesting
/// level.
const INDENT_TOLERANCE: f64 = 0.5;

/// How far left of a line's text a drawn bullet may sit, as a multiple of body
/// size.
const BULLET_SEARCH_WIDTH: f64 = 3.0;

/// How far off a line's baseline a drawn bullet may sit, as a multiple of the
/// line's size.
const BULLET_BASELINE_TOLERANCE: f64 = 1.2;

/// A Markdown block recovered from the page.
#[derive(Debug, Clone, PartialEq)]
pub enum Block {
    Heading {
        level: u8,
        text: String,
    },
    Paragraph(String),
    ListItem {
        level: usize,
        ordered: bool,
        text: String,
    },
    /// Row-major cells. The first row is treated as the header, because a table
    /// whose top row is data still reads correctly that way in GFM, and there is
    /// no reliable signal for "this table has no header".
    Table(Vec<Vec<String>>),
}

/// Convert collected pages into a Markdown document.
pub fn to_markdown(pages: &[Page]) -> String {
    let body = body_size(pages);
    let scale = heading_scale(pages, body);
    let mut blocks = Vec::new();
    for page in pages {
        blocks.extend(blocks_for_page(page, body, &scale));
    }
    emit(&blocks)
}

/// The document's normal type size: the median line size, weighted by how many
/// characters are set at it.
///
/// Returns 0 for an empty document, which callers treat as "no text".
fn body_size(pages: &[Page]) -> f64 {
    let mut sizes: Vec<(f64, usize)> = pages
        .iter()
        .flat_map(|p| &p.lines)
        .map(|l| (l.size, l.chars))
        .collect();
    if sizes.is_empty() {
        return 0.0;
    }
    sizes.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
    let total: usize = sizes.iter().map(|(_, n)| n).sum();
    let mut seen = 0;
    for (size, n) in &sizes {
        seen += n;
        if seen * 2 >= total {
            return *size;
        }
    }
    sizes.last().map(|(s, _)| *s).unwrap_or(0.0)
}

/// The distinct type sizes used for headings, largest first.
///
/// Levels are assigned by *rank* within this list rather than by fixed ratio
/// thresholds, because what makes a line an H2 is that it is the second-largest
/// heading size in the document — not that it happens to be 1.4× body. A
/// document setting H1 at 20pt and H2 at 15pt over 11pt body gives ratios of
/// 1.82 and 1.36; fixed buckets would call the second one an H3.
///
/// Sizes within 4% of each other are one level, which absorbs the rounding that
/// comes out of the text matrix.
fn heading_scale(pages: &[Page], body: f64) -> Vec<f64> {
    if body <= 0.0 {
        return Vec::new();
    }
    let mut sizes: Vec<f64> = pages
        .iter()
        .flat_map(|p| &p.lines)
        // A real step up in size, not measurement noise.
        .filter(|l| l.size > body * HEADING_MIN_RATIO)
        .map(|l| l.size)
        .collect();
    sizes.sort_by(|a, b| b.partial_cmp(a).unwrap_or(std::cmp::Ordering::Equal));
    let mut scale: Vec<f64> = Vec::new();
    for size in sizes {
        if !scale
            .iter()
            .any(|s| (s - size).abs() <= s * SIZE_CLUSTER_TOLERANCE)
        {
            scale.push(size);
        }
    }
    // Markdown has six levels; anything finer collapses into the last.
    scale.truncate(MAX_HEADING_LEVEL);
    scale
}

/// Heading level for a line, or `None` if it reads as body text.
fn heading_level(size: f64, scale: &[f64]) -> Option<u8> {
    let idx = scale
        .iter()
        .position(|s| (s - size).abs() <= s * SIZE_CLUSTER_TOLERANCE)?;
    Some(idx as u8 + 1)
}

/// Split a leading list marker off a line, returning `(ordered, rest)`.
///
/// Recognises the bullet glyphs producers actually emit, and ordered markers as
/// a number or single letter followed by `.` or `)`, optionally parenthesised.
/// A marker must be followed by text, so a line that is only a dash stays prose.
fn list_marker(text: &str) -> Option<(bool, &str)> {
    const BULLETS: [char; 10] = ['•', '●', '○', '▪', '▫', '‣', '·', '-', '–', '—'];
    let t = text.trim_start();

    let mut chars = t.chars();
    if let Some(first) = chars.next() {
        if BULLETS.contains(&first) || first == '*' {
            let rest = chars.as_str().trim_start();
            // `-` and `*` need a following space to be a marker, or "well-known"
            // and "*emphasis*" would be eaten.
            let needs_space = first == '-' || first == '*' || first == '–' || first == '—';
            let had_space = chars.as_str().starts_with(char::is_whitespace);
            if !rest.is_empty() && (!needs_space || had_space) {
                return Some((false, rest));
            }
        }
    }

    // Ordered: optional "(", then digits or a single letter, then "." or ")".
    let body = t.strip_prefix('(').unwrap_or(t);
    let split = body.find(['.', ')'])?;
    let (label, after) = body.split_at(split);
    let rest = after[1..].trim_start();
    if label.is_empty() || rest.is_empty() {
        return None;
    }
    let numeric = label.chars().all(|c| c.is_ascii_digit()) && label.len() <= 3;
    let alpha = label.len() == 1 && label.chars().all(|c| c.is_ascii_alphabetic());
    if numeric || alpha {
        return Some((true, rest));
    }
    None
}

/// Fewest boundaries that bound anything: two lines make one cell.
const MIN_GRID_BOUNDARIES: usize = 2;

/// A grid of cell boundaries recovered from a page's drawn rules.
///
/// **Invariant:** both axes hold at least [`MIN_GRID_BOUNDARIES`] boundaries, in
/// ascending order. The accessors below index and subtract on that basis, so the
/// fields are private and [`Grid::new`] is the only way in — an under-sized grid
/// is unrepresentable rather than a panic waiting to happen.
#[derive(Debug, Clone, PartialEq)]
pub struct Grid {
    /// Column boundaries, left to right: `columns.len() - 1` columns.
    columns: Vec<f64>,
    /// Row boundaries, top to bottom.
    rows: Vec<f64>,
}

impl Grid {
    /// A grid from ascending boundary coordinates, or `None` if either axis has
    /// too few to bound a cell.
    fn new(columns: Vec<f64>, rows: Vec<f64>) -> Option<Self> {
        if columns.len() < MIN_GRID_BOUNDARIES || rows.len() < MIN_GRID_BOUNDARIES {
            return None;
        }
        Some(Self { columns, rows })
    }

    fn column_count(&self) -> usize {
        self.columns.len() - 1
    }

    fn row_count(&self) -> usize {
        self.rows.len() - 1
    }

    fn contains(&self, x: f64, y: f64) -> bool {
        // Indexing is sound: the invariant guarantees both axes are non-empty.
        let (l, r) = (self.columns[0], self.columns[self.column_count()]);
        let (t, b) = (self.rows[0], self.rows[self.row_count()]);
        // A little slack: a glyph's box can poke a fraction past a hairline.
        x >= l - CELL_SLACK_PT
            && x <= r + CELL_SLACK_PT
            && y >= t - CELL_SLACK_PT
            && y <= b + CELL_SLACK_PT
    }

    fn column_of(&self, x: f64) -> Option<usize> {
        (0..self.column_count())
            .find(|&i| x >= self.columns[i] - CELL_SLACK_PT && x < self.columns[i + 1])
    }

    fn row_of(&self, y: f64) -> Option<usize> {
        (0..self.row_count())
            .find(|&i| y >= self.rows[i] - CELL_SLACK_PT && y < self.rows[i + 1] + CELL_SLACK_PT)
    }
}

/// Collapse near-equal coordinates into one boundary each.
fn cluster(mut values: Vec<f64>, tolerance: f64) -> Vec<f64> {
    values.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let mut out: Vec<f64> = Vec::new();
    for v in values {
        match out.last() {
            Some(last) if (v - last).abs() <= tolerance => {}
            _ => out.push(v),
        }
    }
    out
}

/// Recover table grids from the rules drawn on a page.
///
/// A grid needs at least two column boundaries and two row boundaries — one real
/// cell — and its rules must actually meet, so a single underline beneath a
/// heading or a horizontal divider never becomes a table. Rules are grouped into
/// separate grids by vertical proximity, so two tables on one page stay separate.
pub fn grids(rules: &[Rule]) -> Vec<Grid> {
    let horizontals: Vec<&Rule> = rules.iter().filter(|r| r.horizontal).collect();
    let verticals: Vec<&Rule> = rules.iter().filter(|r| !r.horizontal).collect();
    if horizontals.len() < MIN_GRID_BOUNDARIES || verticals.len() < MIN_GRID_BOUNDARIES {
        return Vec::new();
    }

    // Group horizontal rules into bands: a gap larger than this between
    // consecutive rules means a different table.
    let mut ys: Vec<f64> = cluster(
        horizontals.iter().map(|r| r.y0).collect(),
        RULE_CLUSTER_TOLERANCE_PT,
    );
    ys.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let mut bands: Vec<Vec<f64>> = Vec::new();
    for y in ys {
        match bands.last_mut() {
            // 120pt is roughly six lines: within one table, never between two.
            Some(band) if y - band.last().copied().unwrap_or(y) <= TABLE_BAND_GAP_PT => {
                band.push(y)
            }
            _ => bands.push(vec![y]),
        }
    }

    let mut out = Vec::new();
    for band in bands {
        // `Grid::new` rejects an under-sized band, but the bounds are needed
        // before then to pick the verticals, so an empty one is skipped here.
        let (Some(&top), Some(&bottom)) = (band.first(), band.last()) else {
            continue;
        };
        // Only the verticals that span this band's rows belong to this table.
        let xs: Vec<f64> = verticals
            .iter()
            .filter(|r| r.y1 >= top - CELL_SLACK_PT && r.y0 <= bottom + CELL_SLACK_PT)
            .map(|r| r.x0)
            .collect();
        // The only construction site: an under-sized grid is rejected here
        // rather than panicking later in `contains` or `column_of`.
        out.extend(Grid::new(cluster(xs, RULE_CLUSTER_TOLERANCE_PT), band));
    }
    out
}

/// Read a grid's cells out of the lines that fall inside it.
///
/// Each *word* is placed by its own midpoint, because one line of text usually
/// spans a whole table row: "Sample A Treated 1.24" is three cells. Words landing
/// in the same cell are joined in x order, and a cell whose text wraps over two
/// rules-free lines accumulates both.
fn table_cells(grid: &Grid, lines: &[&Line]) -> Vec<Vec<String>> {
    let rows = grid.row_count();
    let cols = grid.column_count();
    let mut cells: Vec<Vec<Vec<(f64, String)>>> = vec![vec![Vec::new(); cols]; rows];
    for line in lines {
        for word in &line.words {
            let mid = (word.x0 + word.x1) / 2.0;
            if let (Some(r), Some(c)) = (grid.row_of(line.y), grid.column_of(mid)) {
                cells[r][c].push((word.x0, word.text.clone()));
            }
        }
    }
    cells
        .into_iter()
        .map(|row| {
            row.into_iter()
                .map(|mut words| {
                    words
                        .sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
                    words
                        .into_iter()
                        .map(|(_, t)| t)
                        .collect::<Vec<_>>()
                        .join(" ")
                })
                .collect()
        })
        .collect()
}

/// Order a page's lines for reading, splitting columns where a gutter exists.
///
/// Lines that span most of the page (a title over two columns, a full-width
/// table) cannot belong to one column, so they are set aside before looking for
/// a gutter and re-inserted around the column groups by position. Anything more
/// elaborate — text flowing around a figure, a sidebar mid-column — is out of
/// scope and comes out in y order.
fn reading_order(page: &Page) -> Vec<&Line> {
    let mut by_y: Vec<&Line> = page.lines.iter().collect();
    by_y.sort_by(|a, b| a.y.partial_cmp(&b.y).unwrap_or(std::cmp::Ordering::Equal));
    if by_y.len() < MIN_LINES_FOR_COLUMNS {
        return by_y;
    }

    let content_left = by_y.iter().map(|l| l.x0).fold(f64::MAX, f64::min);
    let content_right = by_y.iter().map(|l| l.x1).fold(f64::MIN, f64::max);
    let content_width = content_right - content_left;
    if content_width <= 0.0 {
        return by_y;
    }

    // A line covering most of the measure cannot sit inside one column.
    let (spanning, columnar): (Vec<&Line>, Vec<&Line>) = by_y
        .iter()
        .partition(|l| (l.x1 - l.x0) > content_width * SPANNING_LINE_FRACTION);
    if columnar.len() < MIN_LINES_FOR_COLUMNS {
        return by_y;
    }

    // Merge the columnar lines' horizontal extents; a surviving gap is a gutter.
    let mut spans: Vec<(f64, f64)> = columnar.iter().map(|l| (l.x0, l.x1)).collect();
    spans.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
    let mut merged: Vec<(f64, f64)> = Vec::new();
    for (x0, x1) in spans {
        match merged.last_mut() {
            Some(last) if x0 <= last.1 => last.1 = last.1.max(x1),
            _ => merged.push((x0, x1)),
        }
    }
    // A gutter narrower than this is word spacing, not a column break.
    let min_gutter = content_width * MIN_GUTTER_FRACTION;
    let gutter = merged
        .windows(2)
        .map(|w| (w[0].1, w[1].0))
        .find(|(a, b)| b - a >= min_gutter);
    let Some((_, right_start)) = gutter else {
        return by_y;
    };

    let (left, right): (Vec<&Line>, Vec<&Line>) = columnar.iter().partition(|l| l.x1 < right_start);
    // Both sides must hold real content, or this is one column with a ragged edge.
    if left.len() < MIN_LINES_PER_COLUMN || right.len() < MIN_LINES_PER_COLUMN {
        return by_y;
    }

    // Spanning lines above the columns come first, those below come last; a
    // spanning line *between* columns is rare and is treated as a header.
    let columns_top = left
        .iter()
        .chain(&right)
        .map(|l| l.y)
        .fold(f64::MAX, f64::min);
    let mut ordered: Vec<&Line> = Vec::with_capacity(by_y.len());
    ordered.extend(spanning.iter().filter(|l| l.y < columns_top).copied());
    ordered.extend(left);
    ordered.extend(right);
    ordered.extend(spanning.iter().filter(|l| l.y >= columns_top).copied());
    ordered
}

/// Whether a bullet was *drawn* to the left of this line.
///
/// A browser renders `<ul>` markers as filled paths, so the item has no marker
/// character to find in the text — without this the items of a browser-printed
/// list merge into one indented paragraph.
fn has_drawn_bullet(line: &Line, page: &Page, body: f64) -> bool {
    page.markers.iter().any(|m| {
        // Just left of the text, within about three ems, and on its baseline.
        m.x < line.x0 - 0.5
            && m.x > line.x0 - body.max(1.0) * BULLET_SEARCH_WIDTH
            && (m.y - line.y).abs() <= line.size.max(1.0) * BULLET_BASELINE_TOLERANCE
    })
}

/// Append `next` to `text`, honouring an end-of-line hyphen.
fn append_line(text: &mut String, next: &str) {
    if text.ends_with('-') {
        // Joined without a space, so a compound broken across lines ("thirty-" +
        // "seven") comes back correct. A word genuinely hyphenated by the
        // typesetter keeps a visible hyphen rather than being silently glued
        // into a non-word.
        text.push_str(next);
    } else {
        if !text.is_empty() {
            text.push(' ');
        }
        text.push_str(next);
    }
}

/// Whether the vertical gap from `prev` to `line` is wider than ordinary leading.
fn is_gap_break(prev: Option<&Line>, line: &Line) -> bool {
    prev.is_some_and(|p| (line.y - p.y).abs() > line.size * PARAGRAPH_GAP)
}

/// Whether the type size changed enough between `prev` and `line` to end a block.
fn is_size_break(prev: Option<&Line>, line: &Line) -> bool {
    prev.is_some_and(|p| {
        let (a, b) = (p.size, line.size);
        a > 0.0 && (a / b).max(b / a) > PARAGRAPH_SIZE_BREAK
    })
}

/// Which grid, if any, owns each line's text.
///
/// A line is placed by its midpoint: a table row spans the whole grid, so its
/// centre is inside by construction.
fn grid_owners(lines: &[&Line], grids: &[Grid]) -> Vec<Option<usize>> {
    lines
        .iter()
        .map(|l| {
            let mid = (l.x0 + l.x1) / 2.0;
            grids.iter().position(|g| g.contains(mid, l.y))
        })
        .collect()
}

/// Accumulates blocks while walking a page's lines in reading order.
///
/// The point of the type is that exactly one block is ever open — a paragraph or
/// a list item being extended line by line — and every way of starting a new one
/// has to close it first. Keeping that in one place is what stops the walk below
/// from being a soup of mutable flags.
struct BlockBuilder {
    blocks: Vec<Block>,
    /// Text of the block currently being accumulated.
    open: Option<String>,
    /// Set when the open block is a list item: `(ordered, nesting level)`.
    open_kind: Option<(bool, usize)>,
    /// Distinct list indents seen so far, shallowest first; position gives the
    /// nesting level.
    indents: Vec<f64>,
    /// Document body size, for indent tolerance.
    body: f64,
}

impl BlockBuilder {
    fn new(body: f64) -> Self {
        Self {
            blocks: Vec::new(),
            open: None,
            open_kind: None,
            indents: Vec::new(),
            body,
        }
    }

    /// Close the open block, if any, and push it.
    fn close(&mut self) {
        let Some(text) = self.open.take() else { return };
        let kind = self.open_kind.take();
        if text.trim().is_empty() {
            return;
        }
        match kind {
            Some((ordered, level)) => self.blocks.push(Block::ListItem {
                level,
                ordered,
                text,
            }),
            None => self.blocks.push(Block::Paragraph(text)),
        }
    }

    /// A heading is always its own block. Consecutive heading lines at the same
    /// level are one wrapped heading, unless a wide gap separates them.
    fn heading(&mut self, level: u8, text: &str, wrapped: bool) {
        self.close();
        match self.blocks.last_mut() {
            Some(Block::Heading { level: l, text: t }) if *l == level && wrapped => {
                append_line(t, text);
            }
            _ => self.blocks.push(Block::Heading {
                level,
                text: text.to_string(),
            }),
        }
    }

    /// Open a list item, nesting it by its indent: an indent deeper than any seen
    /// opens a level, a shallower one closes back to the matching level.
    fn list_item(&mut self, ordered: bool, text: &str, x0: f64) {
        self.close();
        let tolerance = self.body.max(1.0) * INDENT_TOLERANCE;
        self.indents.retain(|i| *i <= x0 + tolerance);
        if !self.indents.iter().any(|i| (*i - x0).abs() <= tolerance) {
            self.indents.push(x0);
        }
        let level = self.indents.len().saturating_sub(1);
        self.open = Some(text.to_string());
        self.open_kind = Some((ordered, level));
    }

    /// Extend the open block with another line, or start a paragraph.
    fn text(&mut self, text: &str, continues: bool) {
        match self.open.as_mut() {
            Some(open) if continues => append_line(open, text),
            _ => {
                self.close();
                self.open = Some(text.to_string());
                self.open_kind = None;
            }
        }
    }

    /// Push a table, skipping one whose every cell is empty.
    fn table(&mut self, cells: Vec<Vec<String>>) {
        self.close();
        if cells.iter().any(|r| r.iter().any(|c| !c.trim().is_empty())) {
            self.blocks.push(Block::Table(cells));
        }
    }

    fn finish(mut self) -> Vec<Block> {
        self.close();
        self.blocks
    }
}

/// Turn one page's lines into blocks.
fn blocks_for_page(page: &Page, body: f64, scale: &[f64]) -> Vec<Block> {
    let lines = reading_order(page);
    let grids = grids(&page.rules);
    let owner = grid_owners(&lines, &grids);

    let mut builder = BlockBuilder::new(body);
    let mut emitted_grids = vec![false; grids.len()];
    let mut prev: Option<&Line> = None;

    for (i, line) in lines.iter().enumerate() {
        // Both breaks are judged against the previous line, so they are computed
        // before `prev` advances. Every branch below advances it, so it moves
        // here once rather than at the end of each arm.
        let gap_break = is_gap_break(prev, line);
        let size_break = is_size_break(prev, line);
        prev = Some(line);

        // A line inside a table grid belongs to the table, not to the prose. The
        // table is emitted in full the first time one of its lines is reached, so
        // it lands in the right place in the document.
        if let Some(g) = owner[i] {
            if !std::mem::replace(&mut emitted_grids[g], true) {
                let members: Vec<&Line> = lines
                    .iter()
                    .zip(&owner)
                    .filter(|(_, o)| **o == Some(g))
                    .map(|(l, _)| *l)
                    .collect();
                builder.table(table_cells(&grids[g], &members));
            } else {
                builder.close();
            }
            continue;
        }

        if let Some(level) = heading_level(line.size, scale) {
            builder.heading(level, &line.text, !gap_break);
            continue;
        }

        // A drawn bullet has no marker character to strip, so the whole line is
        // the item's text.
        let marker = list_marker(&line.text)
            .or_else(|| has_drawn_bullet(line, page, body).then_some((false, line.text.as_str())));
        if let Some((ordered, rest)) = marker {
            builder.list_item(ordered, rest, line.x0);
            continue;
        }

        builder.text(&line.text, !gap_break && !size_break);
    }
    builder.finish()
}

/// The two characters that follow `{` in every CriticMarkup opener.
///
/// Kept beside `escape` so the list stays checkable against `CRITIC_RE` in
/// `src/critic.ts`: `{++`, `{--`, `{~~`, `{==`, `{>>`.
fn is_critic_opener(a: char, b: char) -> bool {
    matches!(
        (a, b),
        ('+', '+') | ('-', '-') | ('~', '~') | ('=', '=') | ('>', '>')
    )
}

/// Escape text so it reads literally in Markdown.
///
/// Only characters that would otherwise be taken as markup are escaped, because
/// over-escaping litters the source view with backslashes. `_` is left alone:
/// CommonMark does not emphasise intra-word underscores, so `snake_case`
/// survives untouched.
///
/// ## Why some characters become entities and not `\`-escapes
///
/// Monoleaf reads its own constructs out of the **raw source**, not the rendered
/// output, and for those a backslash is worthless: `\<!--ml:meta …-->` still
/// *contains* `<!--ml:meta …-->`, so the regex still matches. The character has
/// to be removed from the source outright, which an entity does while still
/// rendering as the original glyph. Two channels need it:
///
/// - **HTML comments** carry metadata, comment threads and page setup —
///   `/<!--ml:meta (\{[\s\S]*?\})-->/` in `src/meta.ts`, plus the equivalents in
///   `src/comments.ts` and `src/export.ts`. A `<` that could open one becomes
///   `&lt;`.
/// - **CriticMarkup** carries tracked changes — `CRITIC_RE` in `src/critic.ts`
///   matches `{++ins++}`, `{--del--}`, `{~~old~>new~~}`, `{==mark==}` and
///   `{>>note<<}`. A `{` that could open one becomes `&#123;`.
///
/// Without the second of those, PDF text reading `{~~10 mg~>100 mg~~}` would be
/// imported as a genuine tracked substitution: Accept All Changes — an ordinary
/// review action — would rewrite the document, and the import would arrive with
/// fabricated edit history despite being documented as untracked. Only the
/// opening delimiter is neutralised, which is enough, because `CRITIC_RE` cannot
/// match a closing token on its own.
///
/// `&` is escaped alongside them so text that already reads `&lt;` or `&#123;`
/// in the PDF survives as those characters rather than collapsing into `<`/`{`.
fn escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let chars: Vec<char> = text.chars().collect();
    for (i, &c) in chars.iter().enumerate() {
        let next = chars.get(i + 1).copied().unwrap_or(' ');
        let next2 = chars.get(i + 2).copied().unwrap_or(' ');
        match c {
            '\\' | '`' | '*' | '[' | ']' | '|' => {
                out.push('\\');
                out.push(c);
            }
            // Only where it could begin a tag or a comment; "a < b" is left be.
            '<' if next == '!' || next == '/' || next.is_ascii_alphabetic() => {
                out.push_str("&lt;");
            }
            // Only where it could open a CriticMarkup token; "{foo}" is left be.
            '{' if is_critic_opener(next, next2) => out.push_str("&#123;"),
            // Only where it could begin an entity reference.
            '&' if next == '#' || next.is_ascii_alphanumeric() => out.push_str("&amp;"),
            _ => out.push(c),
        }
    }
    out
}

/// Escape a block's leading characters so a paragraph cannot become a heading,
/// quote, list or table row.
fn escape_leading(text: &str) -> String {
    let t = text.trim_start();
    let leading = &text[..text.len() - t.len()];
    // A run of only `=` or `-` under a paragraph is a setext heading underline.
    if !t.is_empty() && t.chars().all(|c| c == '=' || c == '-') {
        return format!("{leading}\\{t}");
    }
    // `|` is not listed: `escape` handles it everywhere, leading included.
    for p in ['#', '>', '+', '-', '~'] {
        if let Some(rest) = t.strip_prefix(p) {
            return format!("{leading}\\{p}{}", escape(rest));
        }
    }
    // "1." or "1)" at the start would open an ordered list.
    let digits: String = t.chars().take_while(char::is_ascii_digit).collect();
    if !digits.is_empty() {
        let after = &t[digits.len()..];
        for p in ['.', ')'] {
            if let Some(rest) = after.strip_prefix(p) {
                return format!("{leading}{digits}\\{p}{}", escape(rest));
            }
        }
    }
    format!("{leading}{}", escape(t))
}

/// Render blocks as CommonMark, one blank line between them.
fn emit(blocks: &[Block]) -> String {
    let mut out = String::new();
    let mut counters: Vec<usize> = Vec::new();
    let mut prev_was_list = false;

    for block in blocks {
        let is_list = matches!(block, Block::ListItem { .. });
        if !out.is_empty() {
            out.push('\n');
            // List items sit on consecutive lines; every other block gets a
            // blank line before it.
            if !(is_list && prev_was_list) {
                out.push('\n');
            }
        }
        match block {
            Block::Heading { level, text } => {
                counters.clear();
                out.push_str(&"#".repeat(*level as usize));
                out.push(' ');
                out.push_str(&escape(text.trim()));
            }
            Block::Paragraph(text) => {
                counters.clear();
                out.push_str(escape_leading(text.trim()).trim_end());
            }
            Block::ListItem {
                level,
                ordered,
                text,
            } => {
                counters.truncate(level + 1);
                while counters.len() <= *level {
                    counters.push(0);
                }
                counters[*level] += 1;
                out.push_str(&"  ".repeat(*level));
                if *ordered {
                    out.push_str(&format!("{}. ", counters[*level]));
                } else {
                    out.push_str("- ");
                }
                out.push_str(&escape(text.trim()));
            }
            Block::Table(rows) => {
                counters.clear();
                // Width comes from the widest row so no cell is dropped, and the
                // delimiter row is written to match — a GFM table is sized by
                // that row, and one that disagrees silently loses columns.
                let width = rows.iter().map(Vec::len).max().unwrap_or(0);
                for (r, row) in rows.iter().enumerate() {
                    let mut cells: Vec<String> = row.iter().map(|c| escape(c.trim())).collect();
                    cells.resize(width, String::new());
                    out.push_str(&format!("| {} |\n", cells.join(" | ")));
                    if r == 0 {
                        out.push_str(&format!("| {} |\n", vec!["---"; width].join(" | ")));
                    }
                }
                // The rows above each ended with a newline; the block separator
                // adds its own, so drop the trailing one.
                while out.ends_with('\n') {
                    out.pop();
                }
            }
        }
        prev_was_list = is_list;
    }
    if !out.is_empty() {
        out.push('\n');
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A line at (x0, y) of the given size, with words laid out left to right at
    /// half an em per glyph and one em between words.
    fn line(x0: f64, y: f64, size: f64, text: &str) -> Line {
        let advance = size * 0.5;
        let mut words = Vec::new();
        let mut cursor = x0;
        for w in text.split_whitespace() {
            let width = w.chars().count() as f64 * advance;
            words.push(super::super::layout::Word {
                text: w.to_string(),
                x0: cursor,
                x1: cursor + width,
            });
            cursor += width + advance;
        }
        Line {
            text: text.split_whitespace().collect::<Vec<_>>().join(" "),
            words,
            x0,
            x1: (cursor - advance).max(x0),
            y,
            size,
            chars: text.chars().count(),
        }
    }

    fn page(lines: Vec<Line>) -> Page {
        Page {
            width: 612.0,
            height: 792.0,
            lines,
            ..Default::default()
        }
    }

    fn md(lines: Vec<Line>) -> String {
        to_markdown(&[page(lines)])
    }

    // --- body size and headings ---

    #[test]
    fn body_size_is_not_swayed_by_a_large_title() {
        // One 24pt title against three lines of 11pt prose.
        let p = page(vec![
            line(72.0, 100.0, 24.0, "A Very Long Title Indeed"),
            line(72.0, 140.0, 11.0, "many more characters of body text here"),
            line(72.0, 156.0, 11.0, "and more body text continuing onwards"),
            line(72.0, 172.0, 11.0, "and still more body text to weigh it"),
        ]);
        assert_eq!(body_size(&[p]), 11.0);
    }

    #[test]
    fn heading_levels_come_from_rank_not_fixed_ratios() {
        // 20pt and 15pt over an 11pt body: ratios of 1.82 and 1.36. Ranking makes
        // the second one an H2; a fixed 1.4 threshold would have called it an H3.
        let p = page(vec![
            line(72.0, 60.0, 20.0, "Title"),
            line(72.0, 100.0, 15.0, "Section"),
            line(
                72.0,
                140.0,
                11.0,
                "body text with plenty of characters here",
            ),
            line(72.0, 156.0, 11.0, "and more body text to settle the median"),
        ]);
        let body = body_size(std::slice::from_ref(&p));
        let scale = heading_scale(std::slice::from_ref(&p), body);
        assert_eq!(scale.len(), 2, "{scale:?}");
        assert_eq!(heading_level(20.0, &scale), Some(1));
        assert_eq!(heading_level(15.0, &scale), Some(2));
        assert_eq!(heading_level(11.0, &scale), None);
    }

    #[test]
    fn the_heading_scale_merges_sizes_that_differ_only_by_rounding() {
        let p = page(vec![
            line(72.0, 60.0, 19.99, "Title One"),
            line(72.0, 100.0, 20.01, "Title Two"),
            line(
                72.0,
                140.0,
                11.0,
                "body text with plenty of characters here",
            ),
            line(72.0, 156.0, 11.0, "and more body text to settle the median"),
        ]);
        let scale = heading_scale(std::slice::from_ref(&p), 11.0);
        assert_eq!(scale.len(), 1, "{scale:?}");
    }

    #[test]
    fn a_document_with_no_headings_has_an_empty_scale() {
        let p = page(vec![
            line(72.0, 100.0, 11.0, "just body text all the way down here"),
            line(72.0, 116.0, 11.0, "with nothing set any larger than this"),
        ]);
        assert!(heading_scale(std::slice::from_ref(&p), 11.0).is_empty());
        assert_eq!(heading_level(11.0, &[]), None);
    }

    #[test]
    fn a_larger_line_becomes_a_heading_and_prose_stays_prose() {
        let out = md(vec![
            line(72.0, 100.0, 20.0, "Assay Report"),
            line(
                72.0,
                140.0,
                11.0,
                "Warm the assay buffer to room temperature",
            ),
            line(72.0, 156.0, 11.0, "before adding the reagent to each well."),
            line(72.0, 172.0, 11.0, "Read absorbance at 450 nm afterwards ok"),
        ]);
        assert_eq!(
            out,
            "# Assay Report\n\nWarm the assay buffer to room temperature before adding the reagent to each well. Read absorbance at 450 nm afterwards ok\n"
        );
    }

    #[test]
    fn a_wrapped_heading_is_one_heading() {
        let out = md(vec![
            line(72.0, 100.0, 20.0, "A Title That Wraps"),
            line(72.0, 124.0, 20.0, "Onto A Second Line"),
            line(
                72.0,
                160.0,
                11.0,
                "Body text follows here with enough chars",
            ),
            line(72.0, 176.0, 11.0, "to establish the body size for the doc."),
        ]);
        assert!(
            out.starts_with("# A Title That Wraps Onto A Second Line\n"),
            "got:\n{out}"
        );
        assert_eq!(out.matches('#').count(), 1, "got:\n{out}");
    }

    // --- paragraphs ---

    #[test]
    fn a_wide_vertical_gap_starts_a_new_paragraph() {
        let out = md(vec![
            line(72.0, 100.0, 11.0, "First paragraph line one of the text"),
            line(72.0, 116.0, 11.0, "and its second line follows closely."),
            // ~3x leading: a paragraph break.
            line(72.0, 165.0, 11.0, "Second paragraph starts after the gap"),
            line(72.0, 181.0, 11.0, "and also has a second line of text."),
        ]);
        assert_eq!(
            out,
            "First paragraph line one of the text and its second line follows closely.\n\nSecond paragraph starts after the gap and also has a second line of text.\n"
        );
    }

    #[test]
    fn a_line_ending_in_a_hyphen_joins_without_a_space() {
        // Keeps a compound correct across a line break.
        let out = md(vec![
            line(72.0, 100.0, 11.0, "incubated for ninety minutes at thirty-"),
            line(72.0, 116.0, 11.0, "seven degrees in a humidified chamber"),
        ]);
        assert!(out.contains("thirty-seven degrees"), "got:\n{out}");
    }

    // --- lists ---

    #[test]
    fn bullet_glyphs_become_list_items() {
        for bullet in ["•", "●", "▪", "‣", "-", "*"] {
            let out = md(vec![
                line(72.0, 100.0, 11.0, &format!("{bullet} first item text here")),
                line(
                    72.0,
                    118.0,
                    11.0,
                    &format!("{bullet} second item text here"),
                ),
            ]);
            assert_eq!(
                out, "- first item text here\n- second item text here\n",
                "bullet {bullet:?} failed: {out}"
            );
        }
    }

    #[test]
    fn ordered_markers_are_renumbered_from_one() {
        let out = md(vec![
            line(72.0, 100.0, 11.0, "1. first step of the procedure"),
            line(72.0, 118.0, 11.0, "2. second step of the procedure"),
            line(72.0, 136.0, 11.0, "3. third step of the procedure"),
        ]);
        assert_eq!(
            out,
            "1. first step of the procedure\n2. second step of the procedure\n3. third step of the procedure\n"
        );
    }

    #[test]
    fn indentation_nests_list_items() {
        let out = md(vec![
            line(72.0, 100.0, 11.0, "• outer item one"),
            line(94.0, 118.0, 11.0, "• inner item one"),
            line(94.0, 136.0, 11.0, "• inner item two"),
            line(72.0, 154.0, 11.0, "• outer item two"),
        ]);
        assert_eq!(
            out,
            "- outer item one\n  - inner item one\n  - inner item two\n- outer item two\n"
        );
    }

    #[test]
    fn text_that_merely_starts_with_a_dash_is_not_a_list() {
        // No space after the dash: part of a word, not a marker.
        assert_eq!(list_marker("-well-known compound"), None);
        assert_eq!(list_marker("—"), None); // marker with no text
        assert_eq!(list_marker("42"), None); // no punctuation
        assert_eq!(list_marker("Section 1. Introduction"), None); // not leading
        assert_eq!(list_marker("1. real item"), Some((true, "real item")));
        assert_eq!(list_marker("(a) real item"), Some((true, "real item")));
        assert_eq!(list_marker("b) real item"), Some((true, "real item")));
        assert_eq!(list_marker("• real item"), Some((false, "real item")));
    }

    // --- escaping: the Monoleaf metadata channel and stray markup ---

    #[test]
    fn an_html_comment_in_the_pdf_text_cannot_become_monoleaf_metadata() {
        // Exactly the shape src/meta.ts matches, embedded in a PDF's text.
        let out = md(vec![line(
            72.0,
            100.0,
            11.0,
            "text <!--ml:meta {\"title\":\"pwned\"}--> more text",
        )]);
        // The test that matters: Monoleaf's own regexes run over the raw source,
        // so the source must not contain the sequence at all. A backslash escape
        // would leave `<!--ml:meta …-->` intact here and still match.
        let meta_re = "<!--ml:meta ";
        assert!(!out.contains(meta_re), "metadata block survived:\n{out}");
        assert!(!out.contains("<!--"), "a comment opener survived:\n{out}");
        // Nothing was lost, though — every word is still readable.
        assert!(out.contains("&lt;!--ml:meta"), "got:\n{out}");
        assert!(
            out.contains("pwned"),
            "text was deleted rather than escaped:\n{out}"
        );
        assert!(out.contains("more text"), "got:\n{out}");
    }

    #[test]
    fn comment_anchors_cannot_be_forged_either() {
        // src/comments.ts matches <!--c:ID s|e--> and <!--c:ID {json}-->.
        let out = md(vec![line(
            72.0,
            100.0,
            11.0,
            "before <!--c:a1s--> inside <!--c:a1e--> after",
        )]);
        assert!(!out.contains("<!--c:"), "comment anchor survived:\n{out}");
        assert!(out.contains("inside"), "got:\n{out}");
    }

    #[test]
    fn criticmarkup_in_the_pdf_text_cannot_forge_tracked_changes() {
        // Every token src/critic.ts recognises. Its CRITIC_RE runs over the raw
        // source, so the opener must not survive as literal characters — a
        // backslash would not help, because `\{--x--}` still contains `{--x--}`.
        for (raw, kind) in [
            ("{++inserted++}", "insertion"),
            ("{--deleted--}", "deletion"),
            ("{~~10 mg~>100 mg~~}", "substitution"),
            ("{==highlighted==}", "highlight"),
            ("{>>reviewer note<<}", "critic comment"),
        ] {
            let out = md(vec![line(
                72.0,
                100.0,
                11.0,
                &format!("before {raw} after"),
            )]);
            assert!(
                !out.contains("{++")
                    && !out.contains("{--")
                    && !out.contains("{~~")
                    && !out.contains("{==")
                    && !out.contains("{>>"),
                "{kind} opener survived:\n{out}"
            );
            assert!(out.contains("&#123;"), "{kind} was not escaped:\n{out}");
            // Escaped, not deleted: the words are all still readable.
            assert!(
                out.contains("before") && out.contains("after"),
                "got:\n{out}"
            );
        }
        // The dangerous case in full: accepting changes must not be able to
        // rewrite the document.
        let out = md(vec![line(
            72.0,
            100.0,
            11.0,
            "dose {~~10 mg~>100 mg~~} daily",
        )]);
        assert!(out.contains("100 mg"), "text lost:\n{out}");
        assert!(out.contains("10 mg"), "text lost:\n{out}");
        assert!(!out.contains("~>}") && !out.contains("{~~"), "got:\n{out}");
    }

    #[test]
    fn an_ordinary_brace_is_left_alone() {
        // Only a CriticMarkup opener is neutralised; braces are common in code,
        // maths and citations, and escaping them all would be pure noise.
        assert_eq!(
            md(vec![line(72.0, 100.0, 11.0, "fn main() {}")]),
            "fn main() {}\n"
        );
        assert_eq!(
            md(vec![line(72.0, 100.0, 11.0, "set {a, b}")]),
            "set {a, b}\n"
        );
        // A single delimiter char is not an opener either.
        assert_eq!(md(vec![line(72.0, 100.0, 11.0, "{+ok}")]), "{+ok}\n");
        assert_eq!(md(vec![line(72.0, 100.0, 11.0, "{>ok}")]), "{>ok}\n");
    }

    #[test]
    fn markup_characters_in_the_source_text_are_escaped() {
        let out = md(vec![line(72.0, 100.0, 11.0, "a * b [c] `d` e\\f g|h")]);
        assert_eq!(out, "a \\* b \\[c\\] \\`d\\` e\\\\f g\\|h\n");
    }

    #[test]
    fn an_existing_entity_in_the_pdf_text_stays_literal() {
        // Otherwise "&lt;" in the source would render as "<" and could rebuild
        // a comment opener at display time.
        let out = md(vec![line(
            72.0,
            100.0,
            11.0,
            "&lt;!--ml:meta x--> and &amp;",
        )]);
        assert!(out.contains("&amp;lt;"), "got:\n{out}");
        assert!(out.contains("&amp;amp;"), "got:\n{out}");
    }

    #[test]
    fn a_bare_less_than_is_not_escaped() {
        // "a < b" cannot open a tag, so escaping it would be pure noise.
        assert_eq!(
            md(vec![line(72.0, 100.0, 11.0, "if a < b then")]),
            "if a < b then\n"
        );
    }

    #[test]
    fn a_paragraph_cannot_be_promoted_to_a_heading_or_row() {
        assert_eq!(
            md(vec![line(72.0, 100.0, 11.0, "# not a heading")]),
            "\\# not a heading\n"
        );
        assert_eq!(
            md(vec![line(72.0, 100.0, 11.0, "> not a quote")]),
            "\\> not a quote\n"
        );
        assert_eq!(
            md(vec![line(72.0, 100.0, 11.0, "| not | a row |")]),
            "\\| not \\| a row \\|\n"
        );
        assert_eq!(md(vec![line(72.0, 100.0, 11.0, "---")]), "\\---\n");
    }

    #[test]
    fn underscores_are_left_alone() {
        // CommonMark does not emphasise intra-word underscores, so escaping
        // would only add noise.
        assert_eq!(
            md(vec![line(72.0, 100.0, 11.0, "snake_case_name")]),
            "snake_case_name\n"
        );
    }

    // --- columns ---

    #[test]
    fn a_gutter_splits_two_columns_into_reading_order() {
        // Left column at x=72, right at x=340, interleaved by y as they would be
        // on the page. Reading order must be all of the left, then all of the
        // right — not the y-sorted interleaving.
        let out = md(vec![
            line(72.0, 100.0, 11.0, "LEFT one of the first column"),
            line(340.0, 104.0, 11.0, "RIGHT one of the second col"),
            line(72.0, 118.0, 11.0, "LEFT two of the first column"),
            line(340.0, 122.0, 11.0, "RIGHT two of the second col"),
            line(72.0, 136.0, 11.0, "LEFT three of the first col"),
            line(340.0, 140.0, 11.0, "RIGHT three of the second c"),
        ]);
        let left = out.find("LEFT three").expect("left missing");
        let right = out.find("RIGHT one").expect("right missing");
        assert!(left < right, "columns were interleaved:\n{out}");
    }

    #[test]
    fn a_single_column_page_is_not_split() {
        let out = md(vec![
            line(72.0, 100.0, 11.0, "one line of ordinary running text"),
            line(72.0, 118.0, 11.0, "two lines of ordinary running text"),
            line(72.0, 136.0, 11.0, "three lines of ordinary running text"),
            line(72.0, 154.0, 11.0, "four lines of ordinary running text"),
        ]);
        assert!(out.starts_with("one line"), "got:\n{out}");
    }

    #[test]
    fn a_full_width_title_stays_above_the_columns() {
        let mut lines = vec![line(
            72.0,
            60.0,
            20.0,
            "Title Spanning The Whole Page Width Here",
        )];
        for i in 0..3 {
            lines.push(line(
                72.0,
                100.0 + i as f64 * 18.0,
                11.0,
                "LEFT column line",
            ));
            lines.push(line(
                340.0,
                104.0 + i as f64 * 18.0,
                11.0,
                "RIGHT column line",
            ));
        }
        let out = md(lines);
        assert!(out.starts_with("# Title Spanning"), "got:\n{out}");
    }

    // --- tables from drawn rules ---

    fn hrule(x0: f64, x1: f64, y: f64) -> Rule {
        Rule {
            horizontal: true,
            x0,
            x1,
            y0: y,
            y1: y + 0.7,
        }
    }

    fn vrule(x: f64, y0: f64, y1: f64) -> Rule {
        Rule {
            horizontal: false,
            x0: x,
            x1: x + 0.7,
            y0,
            y1,
        }
    }

    /// A 3×2 grid: columns at 63/244/400/550, rows at 280/304/328.
    fn grid_rules() -> Vec<Rule> {
        let mut rules = Vec::new();
        for y in [280.0, 304.0, 328.0] {
            rules.push(hrule(63.0, 550.0, y));
        }
        for x in [63.0, 244.0, 400.0, 550.0] {
            rules.push(vrule(x, 280.0, 328.0));
        }
        rules
    }

    fn page_with_rules(lines: Vec<Line>, rules: Vec<Rule>) -> Page {
        Page {
            width: 612.0,
            height: 792.0,
            lines,
            rules,
            markers: Vec::new(),
        }
    }

    #[test]
    fn a_drawn_grid_becomes_a_gfm_table() {
        // One line of text per row, spanning all three columns — which is how a
        // table row actually arrives, since its cells share a baseline.
        let mut lines = vec![line(70.0, 292.0, 10.0, "Sample")];
        lines[0] = line(70.0, 292.0, 10.0, "Sample");
        // Place words in the three column bands by hand.
        let row = |y: f64, a: &str, b: &str, c: &str| {
            let mut l = line(70.0, y, 10.0, &format!("{a} {b} {c}"));
            // Spread the three words across the columns.
            l.words[0].x0 = 70.0;
            l.words[0].x1 = 120.0;
            l.words[1].x0 = 250.0;
            l.words[1].x1 = 300.0;
            l.words[2].x0 = 410.0;
            l.words[2].x1 = 440.0;
            l.x1 = 440.0;
            l
        };
        lines = vec![
            row(292.0, "Sample", "Group", "Signal"),
            row(316.0, "A", "Treated", "1.24"),
        ];
        let out = to_markdown(&[page_with_rules(lines, grid_rules())]);
        assert_eq!(
            out,
            "| Sample | Group | Signal |\n| --- | --- | --- |\n| A | Treated | 1.24 |\n"
        );
    }

    #[test]
    fn an_undersized_grid_cannot_be_constructed() {
        // The accessors index and subtract on the two-boundary invariant, so the
        // constructor is what keeps them from panicking.
        assert!(Grid::new(vec![], vec![]).is_none());
        assert!(Grid::new(vec![0.0], vec![0.0, 10.0]).is_none());
        assert!(Grid::new(vec![0.0, 10.0], vec![0.0]).is_none());
        let g = Grid::new(vec![0.0, 10.0], vec![0.0, 20.0]).expect("two each is enough");
        assert_eq!(g.column_count(), 1);
        assert_eq!(g.row_count(), 1);
        // And the accessors are safe on the minimum case.
        assert!(g.contains(5.0, 10.0));
        assert_eq!(g.column_of(5.0), Some(0));
        assert_eq!(g.row_of(10.0), Some(0));
    }

    #[test]
    fn a_lone_rule_is_not_a_table() {
        // An underline beneath a heading, or a horizontal divider.
        let out = to_markdown(&[page_with_rules(
            vec![line(72.0, 100.0, 11.0, "Just a paragraph under a rule")],
            vec![hrule(63.0, 550.0, 90.0)],
        )]);
        assert_eq!(out, "Just a paragraph under a rule\n");
    }

    #[test]
    fn vertical_rules_alone_are_not_a_table() {
        let out = to_markdown(&[page_with_rules(
            vec![line(72.0, 100.0, 11.0, "Text beside a vertical line here")],
            vec![vrule(60.0, 90.0, 200.0), vrule(70.0, 90.0, 200.0)],
        )]);
        assert_eq!(out, "Text beside a vertical line here\n");
    }

    #[test]
    fn prose_outside_the_grid_stays_prose_and_keeps_its_position() {
        let mut lines = vec![line(72.0, 200.0, 11.0, "Paragraph before the table here")];
        let mut r = line(70.0, 292.0, 10.0, "A B");
        r.words[0].x0 = 70.0;
        r.words[0].x1 = 120.0;
        r.words[1].x0 = 250.0;
        r.words[1].x1 = 300.0;
        r.x1 = 300.0;
        lines.push(r);
        lines.push(line(72.0, 400.0, 11.0, "Paragraph after the table here"));
        let out = to_markdown(&[page_with_rules(lines, grid_rules())]);
        assert!(out.starts_with("Paragraph before"), "got:\n{out}");
        assert!(
            out.trim_end().ends_with("after the table here"),
            "got:\n{out}"
        );
        assert!(out.contains("| --- |"), "no table emitted:\n{out}");
    }

    #[test]
    fn an_empty_grid_produces_no_table() {
        // Rules drawn with no text inside them.
        let out = to_markdown(&[page_with_rules(
            vec![line(72.0, 600.0, 11.0, "Text far below the empty grid")],
            grid_rules(),
        )]);
        assert!(!out.contains('|'), "got:\n{out}");
    }

    #[test]
    fn cells_are_padded_so_no_column_is_dropped() {
        // A row that only reaches the first column still yields a full-width row.
        let mut r = line(70.0, 292.0, 10.0, "only");
        r.words[0].x0 = 70.0;
        r.words[0].x1 = 100.0;
        let out = to_markdown(&[page_with_rules(vec![r], grid_rules())]);
        let rows: Vec<&str> = out.lines().collect();
        assert_eq!(rows[0], "| only |  |  |", "got:\n{out}");
        assert_eq!(rows[1], "| --- | --- | --- |", "got:\n{out}");
    }

    // --- bullets drawn as paths ---

    #[test]
    fn a_drawn_bullet_makes_a_list_item() {
        // What a browser emits: no marker character, just a disc to the left.
        let page = Page {
            width: 612.0,
            height: 792.0,
            lines: vec![
                line(93.0, 250.0, 11.0, "First bullet point in the list"),
                line(93.0, 267.0, 11.0, "Second bullet point here"),
            ],
            rules: Vec::new(),
            markers: vec![
                super::super::layout::Marker { x: 83.2, y: 250.0 },
                super::super::layout::Marker { x: 83.2, y: 267.0 },
            ],
        };
        assert_eq!(
            to_markdown(&[page]),
            "- First bullet point in the list\n- Second bullet point here\n"
        );
    }

    #[test]
    fn a_marker_far_from_a_line_does_not_make_it_a_list() {
        let page = Page {
            width: 612.0,
            height: 792.0,
            lines: vec![line(93.0, 250.0, 11.0, "An ordinary indented paragraph")],
            // A dot elsewhere on the page — a bullet in a figure, say.
            markers: vec![super::super::layout::Marker { x: 400.0, y: 600.0 }],
            rules: Vec::new(),
        };
        assert_eq!(to_markdown(&[page]), "An ordinary indented paragraph\n");
    }

    // --- whole-document shape ---

    #[test]
    fn an_empty_document_produces_an_empty_string() {
        assert_eq!(to_markdown(&[]), "");
        assert_eq!(md(vec![]), "");
    }

    #[test]
    fn output_ends_with_exactly_one_newline_and_no_trailing_space() {
        let out = md(vec![
            line(72.0, 100.0, 20.0, "Heading Here"),
            line(72.0, 140.0, 11.0, "Body text of the document goes here."),
        ]);
        assert!(out.ends_with('\n'));
        assert!(!out.ends_with("\n\n"));
        for l in out.lines() {
            assert_eq!(l, l.trim_end(), "trailing space on {l:?}");
        }
    }
}
