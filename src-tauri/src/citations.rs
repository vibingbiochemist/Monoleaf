//! Rendering of citations and the reference list with hayagriva.
//!
//! The style and the locale come from the document header: `csl:` names one
//! of the bundled Citation Style Language styles, `lang:` picks the locale.
//! Custom style files are not read; a style name is all the header can give.

use crate::references::{self, header_string, Reference, ReferenceFormat};
use hayagriva::archive::{locales, ArchivedStyle};
use hayagriva::citationberg::json::{Item, Value};
use hayagriva::citationberg::taxonomy::{Locator, Term};
use hayagriva::citationberg::{
    CitationFormat, FontStyle, FontVariant, FontWeight, IndependentStyle, Locale, LocaleCode,
    Style, StyleCategory, StyleClass, TermForm, VerticalAlign,
};
use hayagriva::{
    BibliographyDriver, BibliographyRequest, BufWriteFormat, CitationItem, CitationRequest,
    CitePurpose, Elem, ElemChild, ElemChildren, ElemMeta, Formatted, Formatting, LocatorPayload,
    SpecificLocator,
};
use std::collections::HashMap;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::OnceLock;

/// Pandoc's default when the header names no style.
const DEFAULT_STYLE: &str = "chicago-author-date";
/// Styles named in the error for an unknown style, so the user sees the form.
const EXAMPLE_STYLES: &str = "apa, ieee, chicago-author-date, vancouver, nature";

/// The bundled style of the given name, or the default when the header has none.
pub fn style_named(name: Option<&str>) -> Result<IndependentStyle, String> {
    let name = name
        .map(str::trim)
        .filter(|n| !n.is_empty())
        .unwrap_or(DEFAULT_STYLE);
    let archived = ArchivedStyle::by_name(name)
        .ok_or_else(|| format!("unknown citation style \"{name}\"; try one of {EXAMPLE_STYLES}"))?;
    match archived.get() {
        Style::Independent(style) => Ok(style),
        Style::Dependent(_) => Err(format!(
            "citation style \"{name}\" depends on another style"
        )),
    }
}

/// What the references dialog offers: every bundled style by its shortest
/// name, "apa" rather than "american-psychological-association", and every
/// bundled locale by its code, each list sorted.
#[derive(Debug, serde::Serialize)]
pub struct Catalogue {
    pub styles: Vec<String>,
    pub locales: Vec<String>,
}

pub fn catalogue() -> Catalogue {
    let mut styles: Vec<String> = ArchivedStyle::all()
        .iter()
        .filter(|s| matches!(s.get(), Style::Independent(_)))
        .filter_map(|s| s.names().iter().min_by_key(|n| n.len()))
        .map(|n| n.to_string())
        .collect();
    styles.sort();
    let mut locales: Vec<String> = bundled_locales()
        .iter()
        .filter_map(|l| l.lang.as_ref().map(|code| code.0.clone()))
        .collect();
    locales.sort();
    locales.dedup();
    Catalogue { styles, locales }
}

/// The locale from `lang:`; without one the style's own default locale,
/// as Pandoc does, and English (US) when the style names none either.
pub fn locale_named(lang: Option<&str>, style: &IndependentStyle) -> LocaleCode {
    match lang.map(str::trim).filter(|l| !l.is_empty()) {
        Some(lang) => LocaleCode(lang.to_string()),
        None => style
            .default_locale
            .clone()
            .unwrap_or_else(LocaleCode::en_us),
    }
}

/// One citation as the editor found it: `[@a; @b, p. 3]` has two items.
/// The field names are the frontend's; it sends what its parser found.
#[derive(Clone, Debug, Default, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Citation {
    pub items: Vec<CitedItem>,
    /// The in-text form `@key`: "Doe (2020)" rather than "(Doe 2020)".
    #[serde(default)]
    pub in_text: bool,
    /// Inside a footnote, not at its start: a note style prints it in
    /// parentheses, as the footnote already is the note.
    #[serde(default)]
    pub in_note: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CitedItem {
    pub key: String,
    /// Text before the key, `see`.
    #[serde(default)]
    pub prefix: String,
    /// Text after the key, `p. 3, emphasis added`: a locator at its start is
    /// read out, the rest follows the item.
    #[serde(default)]
    pub suffix: String,
    /// `-@key`: the author is left out, "(2020)" in author-date styles.
    #[serde(default)]
    pub suppress_author: bool,
}

/// Every locator kind CSL knows; the locale holds the terms for each.
const LOCATOR_KINDS: [Locator; 29] = [
    Locator::Act,
    Locator::Appendix,
    Locator::ArticleLocator,
    Locator::Book,
    Locator::Canon,
    Locator::Chapter,
    Locator::Column,
    Locator::Elocation,
    Locator::Equation,
    Locator::Figure,
    Locator::Folio,
    Locator::Issue,
    Locator::Line,
    Locator::Note,
    Locator::Opus,
    Locator::Page,
    Locator::Paragraph,
    Locator::Part,
    Locator::Rule,
    Locator::Scene,
    Locator::Section,
    Locator::SubVerbo,
    Locator::Supplement,
    Locator::Table,
    Locator::Timestamp,
    Locator::Title,
    Locator::TitleLocator,
    Locator::Verse,
    Locator::Volume,
];

/// hayagriva's bundled locales, parsed once: parsing them costs a tenth of a
/// second, and every export and live-view render would pay it again.
fn bundled_locales() -> &'static [Locale] {
    static LOCALES: OnceLock<Vec<Locale>> = OnceLock::new();
    LOCALES.get_or_init(locales)
}

/// What the document's locale calls each locator kind, "p.", "pp.", "page",
/// "pages" for a page in English, "S." in German: the terms pandoc reads a
/// locator by. A term the locale lacks comes from its base language's locale,
/// then from English, as hayagriva looks terms up. The longest term comes
/// first, so "pp." is tried before "p.".
fn locator_terms(locales: &[Locale], code: &LocaleCode) -> Vec<(String, Locator)> {
    let lookup: Vec<&Locale> = [
        Some(code.clone()),
        code.fallback(),
        Some(LocaleCode::en_us()),
    ]
    .into_iter()
    .flatten()
    .filter_map(|lang| locales.iter().find(|l| l.lang.as_ref() == Some(&lang)))
    .collect();
    let mut terms = Vec::new();
    for kind in LOCATOR_KINDS {
        for form in [TermForm::Long, TermForm::Short, TermForm::Symbol] {
            let found = lookup
                .iter()
                .find_map(|l| l.term(Term::Locator(kind), form));
            let Some(term) = found else {
                continue;
            };
            for text in [term.single(), term.multiple()].into_iter().flatten() {
                let text = text.trim_end_matches('.');
                if !text.is_empty() {
                    terms.push((text.to_string(), kind));
                }
            }
        }
    }
    terms.sort_by_key(|(text, _)| std::cmp::Reverse(text.len()));
    terms
}

/// Pandoc's reading of what follows a key: a locator term followed by the
/// locator, "p. 3" or "chap. 2", or a locator without a term, which is a
/// page; what follows the locator is the suffix. The term's dot is optional,
/// the kind's own label comes from the style. Nothing for a text that starts
/// with neither.
fn split_locator<'a>(
    text: &'a str,
    terms: &[(String, Locator)],
) -> (Option<SpecificLocator<'a>>, &'a str) {
    let text = text.trim();
    let term = terms.iter().find(|(term, _)| {
        text.is_char_boundary(term.len())
            && text[..term.len()].eq_ignore_ascii_case(term)
            && text[term.len()..].starts_with(['.', ' '])
    });
    let (kind, rest) = match term {
        Some((term, kind)) => (*kind, text[term.len()..].trim_start_matches(['.', ' '])),
        None => (Locator::Page, text),
    };
    let end = locator_end(rest, term.is_some());
    if end == 0 {
        return (None, text);
    }
    (
        Some(SpecificLocator(kind, LocatorPayload::Str(&rest[..end]))),
        &rest[end..],
    )
}

/// A suffix as Pandoc joins it to its citation: as written when it starts
/// with a space or a punctuation mark, " and 4" or ", see" after "p. 3", and
/// after a comma otherwise, "Doe 2020, emphasis added".
fn joined_suffix(suffix: &str) -> String {
    let suffix = suffix.trim_end();
    match suffix.chars().next() {
        Some(c) if c.is_alphanumeric() => format!(", {suffix}"),
        _ => suffix.to_string(),
    }
}

/// Where a locator ends, 0 for none, as Pandoc reads one: words, each after
/// a comma or semicolon and a space, of units joined by "."; a unit runs to
/// a space or a punctuation mark other than "-", "–" and ":". After a term a
/// word needs a digit or a roman numeral, "3–5", "S1", "xii"; without one, a
/// digit. The first word that has neither ends the locator.
fn locator_end(text: &str, after_term: bool) -> usize {
    let mut end = 0;
    while end < text.len() {
        let mut start = end;
        if end > 0 {
            start += text[start..].len() - text[start..].trim_start_matches([',', ';']).len();
        }
        start += text[start..].len() - text[start..].trim_start().len();
        let word = &text[start..];
        let mut length = 0;
        let mut counts = false;
        loop {
            let unit_length = word[length..]
                .find(|c: char| c.is_whitespace() || is_locator_punctuation(c))
                .unwrap_or(word.len() - length);
            if unit_length == 0 {
                break;
            }
            let unit = &word[length..length + unit_length];
            counts |= unit.contains(|c: char| c.is_ascii_digit()) || (after_term && is_roman(unit));
            length += unit_length;
            if !word[length..].starts_with('.') {
                break;
            }
            length += '.'.len_utf8();
        }
        let length = length - usize::from(word[..length].ends_with('.'));
        if length == 0 || !counts {
            break;
        }
        end = start + length;
    }
    end
}

/// A mark that ends a unit of a locator: anything but a letter, a digit, a
/// dash, which joins a range, and a colon, which joins a volume and a page.
fn is_locator_punctuation(c: char) -> bool {
    !c.is_alphanumeric() && !matches!(c, '-' | '\u{2013}' | ':')
}

/// How often a roman numeral repeats a letter for one, ten or a hundred: III.
const ROMAN_REPEAT: usize = 3;

/// Whether a unit is a roman numeral, "xii" or "IV", in either case.
fn is_roman(unit: &str) -> bool {
    let upper = unit.to_ascii_uppercase();
    let mut rest = upper.as_str();
    for _ in 0..ROMAN_REPEAT {
        rest = rest.strip_prefix('M').unwrap_or(rest);
    }
    for (one, five, ten) in [('C', 'D', 'M'), ('X', 'L', 'C'), ('I', 'V', 'X')] {
        rest = roman_place(rest, one, five, ten);
    }
    rest.is_empty() && !upper.is_empty()
}

/// The text after one place of a roman numeral written with its letters for
/// one, five and ten: "IX", "IV", or an optional five and up to three ones.
fn roman_place(text: &str, one: char, five: char, ten: char) -> &str {
    for next in [ten, five] {
        if let Some(rest) = text.strip_prefix(one).and_then(|r| r.strip_prefix(next)) {
            return rest;
        }
    }
    let mut rest = text.strip_prefix(five).unwrap_or(text);
    for _ in 0..ROMAN_REPEAT {
        rest = rest.strip_prefix(one).unwrap_or(rest);
    }
    rest
}

fn is_numeric(style: &IndependentStyle) -> bool {
    let numeric = |category: &StyleCategory| {
        matches!(
            category,
            StyleCategory::CitationFormat {
                format: CitationFormat::Numeric
            }
        )
    };
    style.info.category.iter().any(numeric)
}

/// A style whose citations are footnotes, by the CSL `class` attribute, the
/// same test pandoc's citeproc applies.
fn is_note(style: &IndependentStyle) -> bool {
    style.settings.class == StyleClass::Note
}

/// What pandoc steps over to reach the letter it capitalises: opening
/// quotation marks, the straight one as escape_html() writes it, a bracket.
const BEFORE_FIRST_LETTER: [&str; 9] = ["&quot;", "'", "“", "‘", "„", "‚", "«", "‹", "("];

/// Pandoc capitalises the first letter of a note, past any tag and opening
/// mark, if its word is lower case, as CSL's capitalize-first does: "eBay"
/// and a note that opens with a digit or a dash stay as they are.
fn capitalise_first(html: &mut String) {
    let mut at = 0;
    loop {
        let rest = &html[at..];
        let skip = match rest.starts_with('<') {
            true => rest.find('>').map(|end| end + 1),
            false => BEFORE_FIRST_LETTER
                .iter()
                .find(|m| rest.starts_with(*m))
                .map(|m| m.len()),
        };
        match skip {
            Some(skip) => at += skip,
            None => break,
        }
    }
    let word = html[at..]
        .split(|c: char| c.is_whitespace() || c == '<')
        .next()
        .unwrap_or_default();
    if word.chars().any(char::is_uppercase) {
        return;
    }
    if let Some(first) = word.chars().next().filter(|c| c.is_lowercase()) {
        html.replace_range(at..at + first.len_utf8(), &first.to_uppercase().to_string());
    }
}

/// The bracket the style's layout opens a rendered citation with. A style
/// that brackets each number inside the layout, as ieee does, has none.
fn opening<'h>(html: &'h str, style: &IndependentStyle) -> Option<&'h str> {
    let own = style.citation.layout.prefix.as_deref()?;
    html.starts_with(own).then(|| &html[..own.len()])
}

fn closing<'h>(html: &'h str, style: &IndependentStyle) -> Option<&'h str> {
    let own = style.citation.layout.suffix.as_deref()?;
    html.ends_with(own).then(|| &html[html.len() - own.len()..])
}

/// Pandoc's extras hayagriva has no item for. A suppressed author cuts the
/// prose form "Doe (2020, p. 3)" at its bracket. hayagriva writes the prose
/// form's bracket inside the item, at a depth that differs by style, so its
/// one prefix goes in after the bracket of the text and its suffix before the
/// closing one.
fn decorate(
    mut html: String,
    citation: &Citation,
    suffixes: &[&str],
    style: &IndependentStyle,
) -> String {
    let (Some(first), Some(suffix)) = (citation.items.first(), suffixes.last()) else {
        return html;
    };
    let bracket = style.citation.layout.prefix.as_deref().unwrap_or("(");
    if suppresses_author(citation, style) {
        if let Some(at) = html.find(bracket) {
            html.replace_range(..at, "");
        }
    }
    // A note style has no bracket; hayagriva opens the prose form with "("
    // all the same and ends it with the note's full stop.
    let prose = is_prose(citation, style);
    if suppresses_author(citation, style) && is_note(style) {
        if let Some(at) = html.find(bracket) {
            html.replace_range(at..at + bracket.len(), "");
        }
    }
    let prefix = first.prefix.trim();
    if prose && !prefix.is_empty() {
        let at = opening(&html, style).map_or(0, str::len);
        html.insert_str(at, &format!("{} ", escape_html(prefix)));
    }
    if prose && !suffix.trim().is_empty() {
        let at = html.len() - closing(&html, style).map_or(0, str::len);
        html.insert_str(at, &escape_html(&joined_suffix(suffix)));
    }
    // A style without a year, as modern-language-association, leaves the
    // prose form's bracket empty without a locator; pandoc leaves it out.
    let close = style.citation.layout.suffix.as_deref().unwrap_or(")");
    if let Some(at) = html.rfind(bracket).filter(|_| prose) {
        if let Some(rest) = html[at + bracket.len()..].trim_start().strip_prefix(close) {
            html = format!("{}{rest}", html[..at].trim_end());
        }
    }
    // A note starts with a capital; the in-text form of a note style prints
    // its author in the sentence, and a citation inside a footnote is text of
    // the note.
    if is_note(style) && !citation.in_text && !citation.in_note {
        capitalise_first(&mut html);
    }
    html
}

/// Pandoc's form of a citation inside a footnote in a note style: in
/// parentheses, without the note's final period.
fn in_parentheses(html: String) -> String {
    format!("({})", html.strip_suffix('.').unwrap_or(&html))
}

/// What follows a note's full stop: nothing, or the closing quotation mark
/// an American English locale moves it inside.
const AFTER_FULL_STOP: [&str; 3] = ["", "”", "’"];

/// A note as pandoc prints it inside a sentence: without its full stop.
fn without_full_stop(html: &str) -> String {
    for close in AFTER_FULL_STOP {
        if let Some(note) = html.strip_suffix(close).and_then(|h| h.strip_suffix('.')) {
            return format!("{note}{close}");
        }
    }
    html.to_string()
}

/// Every prefix goes in front of its item, every suffix after it; hayagriva
/// marks each item it prints with the item's index.
fn place_affixes(children: &mut ElemChildren, citation: &Citation, suffixes: &[&str]) {
    let text = |text: String| {
        ElemChild::Text(Formatted {
            text,
            formatting: Formatting::default(),
        })
    };
    let mut affixes: Vec<_> = citation
        .items
        .iter()
        .zip(suffixes)
        .map(|(item, suffix)| {
            let prefix = item.prefix.trim();
            (
                (!prefix.is_empty()).then(|| text(format!("{prefix} "))),
                (!suffix.trim().is_empty()).then(|| text(joined_suffix(suffix))),
            )
        })
        .collect();
    let mut out = Vec::with_capacity(children.0.len());
    let mut placed = Vec::new();
    for child in children.0.drain(..) {
        let entry = match &child {
            ElemChild::Elem(Elem {
                meta: Some(ElemMeta::Entry(index)),
                ..
            }) => affixes.get_mut(*index),
            _ => None,
        };
        let Some((prefix, suffix)) = entry else {
            out.push(child);
            continue;
        };
        out.extend(prefix.take());
        out.push(child);
        if let Some(suffix) = suffix.take() {
            placed.push(out.len());
            out.push(suffix);
        }
    }
    // Pandoc prints one full stop where a suffix's meets the note's own.
    for at in placed {
        let stop_follows = out.get(at + 1).is_some_and(|next| {
            let mut text = String::new();
            let _ = ElemChildren(vec![next.clone()]).write_buf(&mut text, BufWriteFormat::Plain);
            text.starts_with('.')
        });
        if let (true, ElemChild::Text(suffix)) = (stop_follows, &mut out[at]) {
            if let Some(kept) = suffix.text.strip_suffix('.') {
                suffix.text = kept.to_string();
            }
        }
    }
    children.0 = out;
}

/// hayagriva's prose form "Doe (2020)". Pandoc prints the in-text form of a
/// numeric style as the bare number, that of a note style inside a footnote
/// as the note.
fn is_prose(citation: &Citation, style: &IndependentStyle) -> bool {
    (citation.in_text && !is_numeric(style) && !(is_note(style) && citation.in_note))
        || suppresses_author(citation, style)
}

/// Only a citation of one work drops its author; numeric styles never do.
fn suppresses_author(citation: &Citation, style: &IndependentStyle) -> bool {
    citation.items.len() == 1 && citation.items[0].suppress_author && !is_numeric(style)
}

/// What the export prints: the citations in order and the reference list.
#[derive(Clone, Debug, Default, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderedCitations {
    /// One per citation given; `None` where it stays as written. In a note
    /// style, what stays in the sentence: nothing, or the author of `@key`.
    pub citations: Vec<Option<String>>,
    /// One per citation given: in a note style, the footnote a citation
    /// outside a footnote becomes, as pandoc makes one; `None` otherwise.
    /// Left out where no citation has one.
    #[serde(skip_serializing_if = "has_no_note")]
    pub notes: Vec<Option<String>>,
    pub bibliography: Vec<BibliographyEntry>,
    pub hanging_indent: bool,
    /// The heading over the list, from `reference-section-title:`; none
    /// without it, as pandoc prints the list.
    pub title: Option<String>,
    pub warnings: Vec<String>,
}

fn has_no_note(notes: &[Option<String>]) -> bool {
    notes.iter().all(Option::is_none)
}

#[derive(Clone, Debug, Default, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BibliographyEntry {
    pub key: String,
    /// What numeric styles print in front of the entry, `[1]`.
    pub label: Option<String>,
    pub html: String,
}

fn html(children: &ElemChildren) -> String {
    let mut out = String::new();
    let _ = escaped(children).write_buf(&mut out, BufWriteFormat::Html);
    out
}

/// A rendering without a letter or digit, such as the "[]" of hayagriva's
/// own alphanumeric style, which prints no label.
fn is_empty(children: &ElemChildren) -> bool {
    let mut text = String::new();
    let _ = children.write_buf(&mut text, BufWriteFormat::Plain);
    !text.chars().any(char::is_alphanumeric)
}

fn html_of(child: &ElemChild) -> String {
    let mut out = String::new();
    let _ = escaped_child(child).write_buf(&mut out, BufWriteFormat::Html);
    out
}

/// hayagriva writes a reference's text into the HTML as it is, so a "<" in a
/// title would open a tag. A copy with every text and URL escaped; the tags
/// hayagriva writes for its own formatting stay.
fn escaped(children: &ElemChildren) -> ElemChildren {
    ElemChildren(children.0.iter().map(escaped_child).collect())
}

fn escaped_child(child: &ElemChild) -> ElemChild {
    let formatted = |f: &Formatted| Formatted {
        text: escape_html(&f.text),
        formatting: f.formatting,
    };
    match child {
        ElemChild::Text(text) => rich_text(text),
        ElemChild::Elem(elem) => ElemChild::Elem(Elem {
            children: escaped(&elem.children),
            display: elem.display,
            meta: elem.meta.clone(),
        }),
        ElemChild::Link { text, url } => ElemChild::Link {
            text: formatted(text),
            url: escape_html(url),
        },
        other => other.clone(),
    }
}

/// The four characters HTML gives a meaning, in text and in an attribute.
fn escape_html(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            _ => out.push(c),
        }
    }
    out
}

/// What a rich-text tag pair does to the formatting of its text.
type Format = fn(&mut Formatting);

/// The CSL rich-text tags pandoc reads in CSL data: opening and closing tag,
/// the private-use mark the pair becomes before hayagriva runs, and the
/// formatting it gives. hayagriva changes the case of a string as a whole,
/// which would turn `class` into `Class`; a mark has no case. The marks lie
/// past biblatex_csl's own, U+E000 to U+E003. `nocase` prints as plain text:
/// hayagriva cannot keep a CSL string's case.
const RICH_TEXT: [(&str, &str, char, Format); 6] = [
    ("<i>", "</i>", '\u{e100}', |f| {
        f.font_style = FontStyle::Italic
    }),
    ("<b>", "</b>", '\u{e101}', |f| {
        f.font_weight = FontWeight::Bold
    }),
    ("<sup>", "</sup>", '\u{e102}', |f| {
        f.vertical_align = VerticalAlign::Sup
    }),
    ("<sub>", "</sub>", '\u{e103}', |f| {
        f.vertical_align = VerticalAlign::Sub
    }),
    (
        "<span style=\"font-variant:small-caps;\">",
        "</span>",
        '\u{e104}',
        |f| f.font_variant = FontVariant::SmallCaps,
    ),
    ("<span class=\"nocase\">", "</span>", '\u{e105}', |_| {}),
];
/// Where a rich-text pair closes; the pair it closes is the last one open.
const RICH_TEXT_CLOSE: char = '\u{e106}';

/// The reference's item with the rich-text tags of its CSL strings as marks;
/// a `.bib` entry's "<" is text.
fn rich_text_marked(reference: &Reference) -> Item {
    let mut item = reference.item.clone();
    if reference.format == ReferenceFormat::Csl {
        for value in item.0.values_mut() {
            if let Value::String(text) = value {
                *text = marked(text);
            }
        }
    }
    item
}

/// The text with each pair of RICH_TEXT that closes in order as its marks;
/// every other "<" stays.
fn marked(text: &str) -> String {
    let mut pieces: Vec<String> = Vec::new();
    // Each tag still open: its piece and its index in RICH_TEXT.
    let mut open: Vec<(usize, usize)> = Vec::new();
    let mut rest = text;
    while let Some(at) = rest.find('<') {
        pieces.push(rest[..at].to_string());
        rest = &rest[at..];
        let closes = open
            .last()
            .filter(|(_, tag)| rest.starts_with(RICH_TEXT[*tag].1))
            .copied();
        let tag = if let Some(tag) = RICH_TEXT.iter().position(|t| rest.starts_with(t.0)) {
            open.push((pieces.len(), tag));
            pieces.push(RICH_TEXT[tag].0.to_string());
            RICH_TEXT[tag].0
        } else if let Some((piece, tag)) = closes {
            open.pop();
            pieces[piece] = RICH_TEXT[tag].2.to_string();
            pieces.push(RICH_TEXT_CLOSE.to_string());
            RICH_TEXT[tag].1
        } else {
            pieces.push("<".to_string());
            "<"
        };
        rest = &rest[tag.len()..];
    }
    pieces.push(rest.to_string());
    pieces.concat()
}

/// A text leaf escaped, with the marks of RICH_TEXT turned into formatting:
/// a leaf for each stretch between two marks.
fn rich_text(text: &Formatted) -> ElemChild {
    let mut leaves = Vec::new();
    let mut open: Vec<usize> = Vec::new();
    let mut stretch = String::new();
    // The closing mark at the end writes the last stretch.
    for c in text.text.chars().chain([RICH_TEXT_CLOSE]) {
        let tag = RICH_TEXT.iter().position(|t| t.2 == c);
        if tag.is_none() && c != RICH_TEXT_CLOSE {
            stretch.push(c);
            continue;
        }
        if !stretch.is_empty() {
            let mut formatting = text.formatting;
            for &tag in &open {
                (RICH_TEXT[tag].3)(&mut formatting);
            }
            leaves.push(ElemChild::Text(Formatted {
                text: escape_html(&std::mem::take(&mut stretch)),
                formatting,
            }));
        }
        match tag {
            Some(tag) => open.push(tag),
            None => {
                open.pop();
            }
        }
    }
    match leaves.len() {
        1 => leaves.remove(0),
        _ => ElemChild::Elem(Elem {
            children: ElemChildren(leaves),
            display: None,
            meta: None,
        }),
    }
}

/// Renders the citations in document order and the reference list, in one
/// hayagriva run over every reference.
pub fn render(
    references: &[Reference],
    style: &IndependentStyle,
    locale: &LocaleCode,
    citations: &[Citation],
) -> RenderedCitations {
    let mut out = RenderedCitations {
        citations: vec![None; citations.len()],
        notes: vec![None; citations.len()],
        ..Default::default()
    };
    let items: Vec<Item> = references.iter().map(rich_text_marked).collect();
    let mut by_key = HashMap::new();
    for (reference, item) in references.iter().zip(&items) {
        by_key.entry(reference.key()).or_insert(item);
    }
    let locales = bundled_locales();
    let terms = locator_terms(locales, locale);
    // The suffix of each item once its locator is read out, for decorate().
    let suffixes: Vec<Vec<&str>> = citations
        .iter()
        .map(|c| {
            c.items
                .iter()
                .map(|i| split_locator(&i.suffix, &terms).1)
                .collect()
        })
        .collect();
    let mut cited = Vec::new();
    for (index, citation) in citations.iter().enumerate() {
        let mut items = Vec::new();
        let mut known = true;
        for item in &citation.items {
            match by_key.get(&item.key) {
                Some(reference) => items.push((*reference, item)),
                None => {
                    out.warnings.push(format!(
                        "citation {}: no reference has the key {}",
                        index + 1,
                        item.key
                    ));
                    known = false;
                }
            }
        }
        if citation.items.len() > 1 && citation.items.iter().any(|item| item.suppress_author) {
            out.warnings.push(format!(
                "citation {}: -@ is ignored inside a group",
                index + 1
            ));
        }
        if known {
            cited.push((index, items));
        }
    }
    if cited.is_empty() {
        return out;
    }
    // Pandoc keeps each item with a prefix or suffix where it is written and
    // collapses nothing across it; hayagriva can turn sorting and collapsing
    // off only for a whole citation. Its group delimiter goes too: hayagriva
    // would join different authors with it, as elsevier-harvard's
    // "(see Doe and Roe, 2020, p. 3, also Roe, 2019, chap. 2)".
    let mut written_order = style.clone();
    written_order.citation.sort = None;
    written_order.citation.collapse = None;
    written_order.citation.cite_group_delimiter = None;
    let mut driver = BibliographyDriver::new();
    for (index, items) in &cited {
        let citation = &citations[*index];
        let affixed = citation
            .items
            .iter()
            .zip(&suffixes[*index])
            .any(|(item, suffix)| !item.prefix.trim().is_empty() || !suffix.trim().is_empty());
        let request_style = match affixed {
            true => &written_order,
            false => style,
        };
        let items = items
            .iter()
            .map(|(reference, cited)| {
                let locator = split_locator(&cited.suffix, &terms).0;
                let item = CitationItem::with_locator(*reference, locator);
                match is_prose(citation, style) {
                    true => item.kind(CitePurpose::Prose),
                    false => item,
                }
            })
            .collect();
        // In a note style every citation is its own footnote, numbered in
        // document order as pandoc numbers them; hayagriva ignores the
        // number in other styles.
        let note = Some(index + 1);
        let request =
            CitationRequest::new(items, request_style, Some(locale.clone()), locales, note);
        driver.citation(request);
    }
    let request = BibliographyRequest::new(style, Some(locale.clone()), locales);
    // hayagriva 0.10 panics in MLA's name disambiguation when one cited
    // work's author list is the start of another's; the panic stays on this
    // thread, and the citations stay as written.
    let Ok(rendered) = catch_unwind(AssertUnwindSafe(|| driver.finish(request))) else {
        out.warnings.push(
            "the citation library failed on these citations in this style; \
             they stay as written"
                .to_string(),
        );
        return out;
    };
    for ((index, _), mut citation) in cited.iter().zip(rendered.citations) {
        let empty = is_empty(&citation.citation);
        if !is_prose(&citations[*index], style) {
            place_affixes(
                &mut citation.citation,
                &citations[*index],
                &suffixes[*index],
            );
        }
        let text = html(&citation.citation);
        let citation = &citations[*index];
        let mut text = decorate(text, citation, &suffixes[*index], style);
        // Cutting a suppressed author can leave only the empty bracket,
        // which decorate() drops.
        if empty || text.is_empty() {
            let name = style.info.id.rsplit('/').next().unwrap_or_default();
            out.warnings.push(format!(
                "citation {}: the style {name} prints nothing for it here; \
                 it stays as written",
                index + 1
            ));
            continue;
        }
        if is_note(style) {
            match (citation.in_text, citation.in_note) {
                (true, true) => text = without_full_stop(&text),
                // hayagriva's prose form "Doe (note.": the author stays in
                // the sentence and the rest is its footnote, as in pandoc.
                (true, false) => {
                    if let Some((author, rest)) = text.split_once(" (") {
                        let mut note = rest.to_string();
                        capitalise_first(&mut note);
                        out.notes[*index] = Some(note);
                        text = author.to_string();
                    }
                }
                (false, true) => text = in_parentheses(text),
                (false, false) => out.notes[*index] = Some(std::mem::take(&mut text)),
            }
        }
        out.citations[*index] = Some(text);
    }
    if let Some(list) = rendered.bibliography {
        out.hanging_indent = list.hanging_indent;
        out.bibliography = list
            .items
            .into_iter()
            .map(|item| BibliographyEntry {
                key: item.key,
                label: item.first_field.as_ref().map(html_of),
                html: html(&item.content),
            })
            .collect();
    }
    out
}

/// The export's one call: reads the references the header names, takes the
/// style and the locale from the header, and renders. The loader's warnings
/// come first in the result, each named after its source.
pub fn render_document(
    document_path: Option<&str>,
    front_matter: &str,
    allow_network: bool,
    citations: &[Citation],
) -> Result<RenderedCitations, String> {
    let style = style_named(header_string(front_matter, "csl").as_deref())?;
    let locale = locale_named(header_string(front_matter, "lang").as_deref(), &style);
    let loaded = references::load_references(document_path, front_matter, allow_network);
    let mut out = render(&loaded.references, &style, &locale, citations);
    out.title = header_string(front_matter, "reference-section-title");
    if header_truish(front_matter, "suppress-bibliography") {
        out.bibliography.clear();
    }
    out.warnings.splice(0..0, loaded.warnings);
    Ok(out)
}

/// Whether the header sets `key` to true as pandoc reads it: the boolean
/// `true`, or the text "t", "true" or "yes" in any case.
fn header_truish(front_matter: &str, key: &str) -> bool {
    let Ok(document) = yaml_serde::from_str::<yaml_serde::Value>(front_matter) else {
        return false;
    };
    match document.get(key) {
        Some(yaml_serde::Value::Bool(value)) => *value,
        Some(yaml_serde::Value::String(text)) => {
            ["t", "true", "yes"].contains(&text.trim().to_ascii_lowercase().as_str())
        }
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::references::{read_biblatex, read_csl_json, read_csl_yaml};

    const BIB: &str = "@article{doe2020, author={Doe, Jane and Roe, Richard}, title={A Study}, \
                       journal={J. Stud.}, year={2020}, volume={3}, pages={1--9}}";
    const ISSUE_EXAMPLE: &str = "references:\n- id: ERA5LandHourlyData2019\n  type: dataset\n  \
                                 title: ERA5-Land hourly data from 1950 to present\n  author:\n  \
                                 - literal: Copernicus Climate Change Service\n  issued: 2019\n";

    fn cite(keys: &[&str]) -> Citation {
        let items = keys.iter().map(|key| CitedItem {
            key: key.to_string(),
            ..Default::default()
        });
        Citation {
            items: items.collect(),
            in_text: false,
            in_note: false,
        }
    }

    #[test]
    fn a_citation_inside_a_footnote_prints_in_parentheses_in_note_styles() {
        let references = read_biblatex(BIB, true).references;
        let mut noted = cite(&["doe2020"]);
        noted.items[0].suffix = "p. 40".into();
        noted.in_note = true;
        let mut prose = noted.clone();
        prose.in_text = true;
        let mut opening = noted.clone();
        opening.in_note = false;
        let mut see = noted.clone();
        see.items[0].prefix = "see".into();
        let cited = [opening, noted, prose, see];
        let render_in = |name| {
            let style = style_named(Some(name)).unwrap();
            render(&references, &style, &LocaleCode::en_us(), &cited)
        };
        let out = render_in("chicago-notes");
        assert_eq!(out.citations[0].as_deref(), Some(""));
        assert!(out.notes[0].as_deref().unwrap().ends_with("40."));
        let chicago = out.citations;
        assert_eq!(chicago[1].as_deref(), Some("(Doe and Roe, “A Study,” 40)"));
        assert!(!chicago[2].as_deref().unwrap().starts_with('('));
        assert_eq!(
            chicago[3].as_deref(),
            Some("(see Doe and Roe, “A Study,” 40)")
        );
        let apa = render_in("apa");
        assert_eq!(
            apa.citations[1].as_deref(),
            Some("(Doe &amp; Roe, 2020, p. 40)")
        );
        assert!(apa.notes.iter().all(Option::is_none));
    }

    #[test]
    fn style_defaults_to_chicago_author_date() {
        let style = style_named(None).unwrap();
        assert!(style.info.id.ends_with("/styles/chicago-author-date"));
        assert_eq!(style_named(Some("  ")).unwrap().info.id, style.info.id);
    }

    #[test]
    fn style_is_found_by_name() {
        let style = style_named(Some(" apa ")).unwrap();
        assert!(style.info.id.ends_with("/styles/apa"), "{}", style.info.id);
    }

    #[test]
    fn unknown_style_names_examples() {
        let err = style_named(Some("harvard")).unwrap_err();
        assert!(err.contains("\"harvard\"") && err.contains("apa"));
    }

    #[test]
    fn locale_comes_from_the_header_then_the_style_then_en_us() {
        let apa = style_named(Some("apa")).unwrap();
        let thieme = style_named(Some("thieme")).unwrap();
        assert_eq!(locale_named(None, &apa), LocaleCode::en_us());
        assert_eq!(locale_named(None, &thieme).0, "de-DE");
        assert_eq!(locale_named(Some("en-GB"), &thieme).0, "en-GB");
        // pandoc 3.13 warns about an empty lang: and keeps the style's.
        assert_eq!(locale_named(Some(" "), &thieme).0, "de-DE");
    }

    #[test]
    fn the_issue_example_renders_in_the_default_and_in_apa() {
        let references = read_csl_yaml(ISSUE_EXAMPLE).unwrap().references;
        let cited = [cite(&["ERA5LandHourlyData2019"])];
        let style = style_named(None).unwrap();
        let locale = locale_named(None, &style);
        let out = render(&references, &style, &locale, &cited);
        assert_eq!(
            out.citations,
            [Some("(Copernicus Climate Change Service 2019)".into())]
        );
        assert!(out.bibliography[0]
            .html
            .starts_with("Copernicus Climate Change Service. 2019."));
        assert!(out.hanging_indent && out.warnings.is_empty());
        let apa = render(
            &references,
            &style_named(Some("apa")).unwrap(),
            &locale,
            &cited,
        );
        assert_eq!(
            apa.citations,
            [Some("(Copernicus Climate Change Service, 2019)".into())]
        );
    }

    #[test]
    fn bib_and_csl_references_share_one_numbering() {
        let mut references = read_biblatex(BIB, true).references;
        references.extend(read_csl_yaml(ISSUE_EXAMPLE).unwrap().references);
        let mut page = cite(&["doe2020"]);
        page.items[0].suffix = "3".into();
        let cited = [
            cite(&["ERA5LandHourlyData2019"]),
            page,
            cite(&["doe2020", "ERA5LandHourlyData2019"]),
            cite(&["nobody"]),
        ];
        let style = style_named(Some("ieee")).unwrap();
        let out = render(&references, &style, &locale_named(None, &style), &cited);
        assert_eq!(out.citations[0].as_deref(), Some("[1]"));
        assert_eq!(out.citations[1].as_deref(), Some("[2, p. 3]"));
        assert_eq!(out.citations[2].as_deref(), Some("[1], [2]"));
        assert_eq!(out.citations[3], None);
        let keys: Vec<_> = out.bibliography.iter().map(|e| e.key.as_str()).collect();
        assert_eq!(keys, ["ERA5LandHourlyData2019", "doe2020"]);
        assert_eq!(out.warnings.len(), 1, "{:?}", out.warnings);
        assert!(out.warnings[0].contains("nobody"));
    }

    #[test]
    fn prefix_suffix_locator_and_suppressed_author_print_as_pandoc_does() {
        let references = read_biblatex(BIB, true).references;
        let mut seen = cite(&["doe2020"]);
        seen.items[0].prefix = "see".into();
        seen.items[0].suffix = "chap. 2, emphasis added".into();
        let mut year = cite(&["doe2020"]);
        year.items[0].suppress_author = true;
        year.items[0].suffix = "p. 3".into();
        let mut page = cite(&["doe2020"]);
        page.items[0].suffix = "12".into();
        let mut group = cite(&["doe2020", "doe2020"]);
        group.items[1].prefix = "also".into();
        group.items[1].suppress_author = true;
        let mut year_affixed = cite(&["doe2020"]);
        year_affixed.items[0].suppress_author = true;
        year_affixed.items[0].prefix = "see & compare".into();
        year_affixed.items[0].suffix = "emphasis & more".into();
        let mut in_text = cite(&["doe2020"]);
        in_text.in_text = true;
        in_text.items[0].suffix = "p. 3, emphasis added".into();
        let cited = [seen, year, page, group, year_affixed, in_text];
        let locale = LocaleCode::en_us();
        let apa = render(
            &references,
            &style_named(Some("apa")).unwrap(),
            &locale,
            &cited,
        );
        let texts: Vec<_> = apa
            .citations
            .iter()
            .map(|c| c.as_deref().unwrap())
            .collect();
        assert_eq!(
            texts[..3],
            [
                "(see Doe &amp; Roe, 2020, Chapter 2, emphasis added)",
                "(2020, p. 3)",
                "(Doe &amp; Roe, 2020, p. 12)"
            ]
        );
        // -@ inside a group prints the author, with a warning; pandoc 3.13
        // prints (Doe & Roe, 2020; also 2020).
        assert_eq!(texts[3], "(Doe &amp; Roe, 2020; also Doe &amp; Roe, 2020)");
        // pandoc 3.13: (see & compare 2020, emphasis & more) and
        // Doe & Roe (2020, p. 3, emphasis added).
        assert_eq!(
            texts[4..],
            [
                "(see &amp; compare 2020, emphasis &amp; more)",
                "Doe &amp; Roe (2020, p. 3, emphasis added)"
            ]
        );
        assert_eq!(apa.warnings.len(), 1, "{:?}", apa.warnings);
        let ieee = render(
            &references,
            &style_named(Some("ieee")).unwrap(),
            &locale,
            &cited,
        );
        assert_eq!(
            ieee.citations[0].as_deref(),
            Some("see [1, Ch. 2], emphasis added")
        );
        assert_eq!(ieee.citations[1].as_deref(), Some("[1, p. 3]"));
    }

    #[test]
    fn in_text_form_prints_the_name_only_in_author_date_styles() {
        let references = read_biblatex(BIB, true).references;
        let mut prose = cite(&["doe2020"]);
        prose.in_text = true;
        let mut page = prose.clone();
        page.items[0].suffix = "p. 3".into();
        let cited = [prose, page];
        let texts = |name| {
            let style = style_named(Some(name)).unwrap();
            let out = render(&references, &style, &LocaleCode::en_us(), &cited);
            out.citations
                .into_iter()
                .map(Option::unwrap)
                .collect::<Vec<_>>()
        };
        assert_eq!(texts("ieee"), ["[1]", "[1, p. 3]"]);
        // Pandoc drops nature's locator too.
        let one = "<span style=\"vertical-align: super;\">1</span>";
        assert_eq!(texts("nature"), [one, one]);
        assert_eq!(
            texts("apa"),
            ["Doe &amp; Roe (2020)", "Doe &amp; Roe (2020, p. 3)"]
        );
    }

    #[test]
    fn ieee_prints_prefix_and_comment_outside_the_number_bracket() {
        let mut references = read_biblatex(BIB, true).references;
        references.extend(read_csl_yaml(ISSUE_EXAMPLE).unwrap().references);
        let mut see = cite(&["doe2020"]);
        see.items[0].prefix = "see".into();
        let mut page = cite(&["doe2020"]);
        page.items[0].suffix = "p. 3, emphasis added".into();
        let mut group = cite(&["doe2020", "ERA5LandHourlyData2019"]);
        group.items[0].prefix = "see".into();
        let style = style_named(Some("ieee")).unwrap();
        let cited = [see, page, group];
        let out = render(&references, &style, &LocaleCode::en_us(), &cited);
        assert_eq!(
            out.citations,
            [
                Some("see [1]".into()),
                Some("[1, p. 3], emphasis added".into()),
                Some("see [1], [2]".into())
            ]
        );
    }

    #[test]
    fn a_note_style_prints_the_note_without_an_opening_parenthesis() {
        let references = read_biblatex(BIB, true).references;
        let mut in_text = cite(&["doe2020"]);
        in_text.in_text = true;
        let mut year = cite(&["doe2020"]);
        year.items[0].suppress_author = true;
        let mut page = year.clone();
        page.items[0].suffix = "p. 3".into();
        let out = render(
            &references,
            &style_named(Some("chicago-notes")).unwrap(),
            &LocaleCode::en_us(),
            &[in_text, year, page],
        );
        let in_sentence: Vec<_> = out.citations.iter().flatten().collect();
        assert_eq!(in_sentence, ["Jane Doe and Richard Roe", "", ""]);
        let notes: Vec<_> = out.notes.iter().flatten().collect();
        assert_eq!(
            notes,
            [
                "“A Study,” <span style=\"font-style: italic;\">J. Stud.</span> 3 (2020): 1–9.",
                "“A Study.”",
                "“A Study,” 3."
            ]
        );
    }

    #[test]
    fn the_in_text_form_of_a_note_style_is_the_author_and_a_footnote() {
        let references = read_biblatex(BIB, true).references;
        let mut first = cite(&["doe2020"]);
        first.in_text = true;
        let mut page = first.clone();
        page.items[0].suffix = "p. 3".into();
        let cited = [first.clone(), page, first];
        let texts = |name| {
            let style = style_named(Some(name)).unwrap();
            let out = render(&references, &style, &locale_named(None, &style), &cited);
            let pair = |(author, note): (&Option<String>, &Option<String>)| {
                format!(
                    "{} | {}",
                    author.as_deref().unwrap(),
                    note.as_deref().unwrap()
                )
            };
            out.citations
                .iter()
                .zip(&out.notes)
                .map(pair)
                .collect::<Vec<_>>()
        };
        let journal = "<span style=\"font-style: italic;\">J. Stud.</span>";
        // pandoc 3.13, chicago-notes-bibliography: the author in the
        // sentence, the rest of the note in a footnote.
        assert_eq!(
            texts("chicago-notes"),
            [
                format!("Jane Doe and Richard Roe | “A Study,” {journal} 3 (2020): 1–9."),
                "Doe and Roe | “A Study,” 3.".to_string(),
                "Doe and Roe | “A Study.”".to_string()
            ]
        );
        assert_eq!(
            texts("modern-humanities-research-association-notes"),
            [
                format!("Jane Doe and Richard Roe | ‘A Study’, {journal}, 3 (2020), pp. 1–9."),
                "Doe and Roe | ‘A Study’, p. 3.".to_string(),
                "Doe and Roe | ‘A Study’.".to_string()
            ]
        );
    }

    #[test]
    fn a_citation_rendered_empty_stays_as_written_with_a_warning() {
        let references = read_biblatex(BIB, true).references;
        // hayagriva's own alphanumeric style prints "[]" without its label.
        let style = style_named(Some("alphanumeric")).unwrap();
        let out = render(
            &references,
            &style,
            &LocaleCode::en_us(),
            &[cite(&["doe2020"])],
        );
        assert_eq!(out.citations, [None]);
        assert_eq!(
            out.warnings,
            ["citation 1: the style alphanumeric prints nothing for it here; it stays as written"]
        );
    }

    #[test]
    fn a_prose_form_without_a_year_drops_its_empty_parentheses() {
        let references = read_biblatex(BIB, true).references;
        let mut prose = cite(&["doe2020"]);
        prose.in_text = true;
        let mut page = prose.clone();
        page.items[0].suffix = "p. 90".into();
        let mut year = cite(&["doe2020"]);
        year.items[0].suppress_author = true;
        let style = style_named(Some("modern-language-association")).unwrap();
        let out = render(
            &references,
            &style,
            &LocaleCode::en_us(),
            &[prose, page, year],
        );
        assert_eq!(
            out.citations,
            [
                Some("Doe and Roe".into()),
                Some("Doe and Roe (90)".into()),
                None
            ]
        );
        assert_eq!(out.warnings.len(), 1, "{:?}", out.warnings);
        assert!(out.warnings[0].starts_with("citation 3:"));
    }

    #[test]
    fn a_repeated_citation_in_a_note_style_names_the_note_that_first_cited_it() {
        let mut references = read_biblatex(BIB, true).references;
        references.extend(read_csl_yaml(ISSUE_EXAMPLE).unwrap().references);
        let mut again = cite(&["doe2020"]);
        again.in_text = true;
        let cited = [cite(&["doe2020"]), cite(&["ERA5LandHourlyData2019"]), again];
        let render_in = |name| {
            let style = style_named(Some(name)).unwrap();
            render(&references, &style, &LocaleCode::en_us(), &cited)
        };
        let gb = render_in("gb-7714-2015-note");
        assert!(gb.warnings.is_empty(), "{:?}", gb.warnings);
        assert_eq!(gb.citations[2].as_deref(), Some("DOE J, ROE R"));
        assert_eq!(gb.notes[2].as_deref(), Some("同1."));
        let notes = render_in("chicago-shortened-notes");
        assert!(notes.warnings.is_empty(), "{:?}", notes.warnings);
        assert_eq!(notes.citations[2].as_deref(), Some("Doe and Roe"));
        assert_eq!(notes.notes[2].as_deref(), Some("“A Study.”"));
    }

    #[test]
    fn a_note_starts_with_a_capital_as_in_pandoc() {
        let mut references = read_biblatex(BIB, true).references;
        let berg = "references:\n- id: berg\n  title: Names\n  author:\n  - family: Berg\n    \
                    given: Ludwig\n    non-dropping-particle: van der\n";
        references.extend(read_csl_yaml(berg).unwrap().references);
        let prefixed = |prefix: &str, key: &str| {
            let mut citation = cite(&[key]);
            citation.items[0].prefix = prefix.into();
            citation
        };
        let mut prose = cite(&["berg"]);
        prose.in_text = true;
        let cited = [
            prefixed("see", "doe2020"),
            cite(&["berg"]),
            prefixed("\"see\"", "doe2020"),
            prefixed("2nd ed.", "doe2020"),
            prose,
            prefixed("\u{201c}see\u{201d}", "doe2020"),
            prefixed("eBay", "doe2020"),
        ];
        let locale = LocaleCode::en_us();
        let out = |style: &str| {
            let style = style_named(Some(style)).unwrap();
            render(&references, &style, &locale, &cited)
        };
        let shortened = out("chicago-shortened-notes");
        let notes: Vec<_> = shortened.notes.iter().flatten().collect();
        assert_eq!(
            notes[..4],
            [
                "See Doe and Roe, “A Study”.",
                "Van der Berg, <span style=\"font-style: italic;\">Names</span>.",
                "&quot;See&quot; Doe and Roe, “A Study”.",
                "2nd ed. Doe and Roe, “A Study”."
            ]
        );
        let in_sentence = shortened.citations[4].as_deref().unwrap();
        assert!(in_sentence.starts_with("van der Berg"), "{in_sentence}");
        // pandoc 3.13: “See” Doe and Roe, and a word with a capital inside
        // stays as written: eBay Doe and Roe.
        assert_eq!(
            shortened.notes[5].as_deref(),
            Some("\u{201c}See\u{201d} Doe and Roe, \u{201c}A Study\u{201d}.")
        );
        assert_eq!(
            shortened.notes[6].as_deref(),
            Some("eBay Doe and Roe, \u{201c}A Study\u{201d}.")
        );
        let author_date = out("chicago-author-date").citations[0].clone();
        assert_eq!(author_date.as_deref(), Some("(see Doe and Roe 2020)"));
    }

    /// The text of rendered HTML: tags dropped, entities read.
    fn plain(html: &str) -> String {
        let mut out = String::new();
        let mut in_tag = false;
        for c in html.chars() {
            match c {
                '<' => in_tag = true,
                '>' => in_tag = false,
                c if !in_tag => out.push(c),
                _ => {}
            }
        }
        out.replace("&quot;", "\"")
            .replace("&lt;", "<")
            .replace("&gt;", ">")
            .replace("&amp;", "&")
    }

    #[test]
    fn a_note_in_another_language_starts_with_a_capital_too() {
        let references = read_csl_yaml(
            "references:\n- id: low\n  type: article-journal\n  title: eine studie\n  \
             author:\n  - family: Doe\n    given: Jane\n  container-title: J. Stud.\n  \
             volume: 3\n  page: 1-9\n  issued: 2020\n- id: low2\n  type: book\n  \
             title: eine geschichte\n  publisher: Pub\n  issued: 2019\n",
        )
        .unwrap()
        .references;
        let mut in_text = cite(&["low"]);
        in_text.in_text = true;
        let style = style_named(Some("chicago-notes")).unwrap();
        let german = LocaleCode("de-DE".into());
        let out = render(&references, &style, &german, &[in_text, cite(&["low2"])]);
        // pandoc 3.13 with lang: de-DE: Jane Doe, with the note
        // „Eine studie“, J. Stud. 3 (2020): 1–9.; then
        // Eine geschichte (Pub, 2019).
        assert_eq!(out.citations[0].as_deref(), Some("Jane Doe"));
        assert_eq!(
            plain(out.notes[0].as_deref().unwrap()),
            "\u{201e}Eine studie\u{201c}, J. Stud. 3 (2020): 1\u{2013}9."
        );
        assert_eq!(
            plain(out.notes[1].as_deref().unwrap()),
            "Eine geschichte (Pub, 2019)."
        );
    }

    #[test]
    fn the_in_text_form_inside_a_footnote_is_the_note_without_its_full_stop() {
        let references = read_biblatex(BIB, true).references;
        let mut cited = cite(&["doe2020"]);
        cited.in_text = true;
        cited.in_note = true;
        let style = style_named(Some("chicago-shortened-notes")).unwrap();
        let out = render(&references, &style, &LocaleCode::en_us(), &[cited]);
        // pandoc 3.13: [^1]: As @doe2020 says. prints
        // As Doe and Roe, “A Study” says.
        assert_eq!(
            out.citations[0].as_deref(),
            Some("Doe and Roe, \u{201c}A Study\u{201d}")
        );
        assert_eq!(out.notes[0], None);
    }

    #[test]
    fn a_group_with_an_affix_collapses_nothing_across_it() {
        let more = "@article{doe2021, author={Doe, Jane and Roe, Richard}, title={A Sequel}, \
                    journal={J. Stud.}, year={2021}, volume={4}, pages={2--8}}\n\
                    @book{roe2019, author={Roe, Jim}, title={Other Book}, publisher={Pub}, \
                    year={2019}}\n\
                    @book{moe2018, author={Moe, Dan}, title={Third Book}, publisher={Pub}, \
                    year={2018}}";
        let references = read_biblatex(&format!("{BIB}\n{more}"), true).references;
        let three = cite(&["doe2020", "roe2019", "moe2018"]);
        let mut see_three = three.clone();
        see_three.items[0].prefix = "see".into();
        let locale = LocaleCode::en_us();
        let vancouver = style_named(Some("elsevier-vancouver")).unwrap();
        let out = render(&references, &vancouver, &locale, &[three, see_three]);
        // pandoc 3.13: [1–3] and [see 1,2,3].
        assert_eq!(
            out.citations,
            [Some("[1\u{2013}3]".into()), Some("[see 1,2,3]".into())]
        );
        let mut two_authors = cite(&["doe2020", "roe2019"]);
        two_authors.items[0].prefix = "see".into();
        two_authors.items[0].suffix = "p. 3".into();
        two_authors.items[1].prefix = "also".into();
        two_authors.items[1].suffix = "chap. 2".into();
        let harvard = style_named(Some("elsevier-harvard")).unwrap();
        let out = render(&references, &harvard, &locale, &[two_authors]);
        // pandoc 3.13: (see Doe and Roe, 2020, p. 3; also Roe, 2019, chap. 2).
        assert_eq!(
            out.citations[0].as_deref(),
            Some("(see Doe and Roe, 2020, p. 3; also Roe, 2019, chap. 2)")
        );
        let mut see_second = cite(&["doe2020", "doe2021"]);
        see_second.items[1].prefix = "see".into();
        let mut year_first = cite(&["doe2020", "roe2019"]);
        year_first.items[0].suppress_author = true;
        let apa = style_named(Some("apa")).unwrap();
        let out = render(&references, &apa, &locale, &[see_second, year_first]);
        // pandoc 3.13: (Doe & Roe, 2020; see Doe & Roe, 2021).
        assert_eq!(
            out.citations[0].as_deref(),
            Some("(Doe &amp; Roe, 2020; see Doe &amp; Roe, 2021)")
        );
        // -@ inside a group prints the author, with a warning; pandoc 3.13
        // prints (2020; Roe, 2019).
        assert_eq!(
            out.citations[1].as_deref(),
            Some("(Doe &amp; Roe, 2020; Roe, 2019)")
        );
    }

    #[test]
    fn a_link_in_the_reference_list_is_escaped() {
        let references = read_csl_yaml(
            "references:\n- id: web\n  type: webpage\n  title: Page\n  \
             URL: https://x.org/?a=1&b=2\n  issued: 2020\n",
        )
        .unwrap()
        .references;
        let style = style_named(Some("apa")).unwrap();
        let out = render(&references, &style, &LocaleCode::en_us(), &[cite(&["web"])]);
        let entry = &out.bibliography[0].html;
        assert!(entry.contains(">https://x.org/?a=1&amp;b=2</a>"), "{entry}");
    }

    #[test]
    fn every_item_of_a_group_prints_its_prefix_and_suffix() {
        let mut references = read_biblatex(BIB, true).references;
        references.extend(read_csl_yaml(ISSUE_EXAMPLE).unwrap().references);
        let mut group = cite(&["ERA5LandHourlyData2019", "doe2020"]);
        group.items[0].prefix = "see".into();
        group.items[0].suffix = "first note".into();
        group.items[1].prefix = "also".into();
        group.items[1].suffix = "p. 3, last note".into();
        let cited = [group];
        let printed = |style: &str| {
            let out = render(
                &references,
                &style_named(Some(style)).unwrap(),
                &LocaleCode::en_us(),
                &cited,
            );
            assert!(out.warnings.is_empty(), "{:?}", out.warnings);
            out.citations[0].clone().unwrap()
        };
        assert_eq!(
            printed("apa"),
            "(see Copernicus Climate Change Service, 2019, first note; \
             also Doe &amp; Roe, 2020, p. 3, last note)"
        );
        assert_eq!(
            printed("chicago-author-date"),
            "(see Copernicus Climate Change Service 2019, first note; \
             also Doe and Roe 2020, 3, last note)"
        );
    }

    #[test]
    fn a_group_with_a_prefix_or_suffix_prints_in_the_order_written() {
        let mut references = read_biblatex(BIB, true).references;
        references.extend(read_csl_yaml(ISSUE_EXAMPLE).unwrap().references);
        let berg = "references:\n- id: berg\n  title: Names\n  author:\n  - family: Berg\n";
        references.extend(read_csl_yaml(berg).unwrap().references);
        let mut group = cite(&["doe2020", "ERA5LandHourlyData2019"]);
        group.items[0].prefix = "see".into();
        group.items[0].suffix = "first note".into();
        group.items[1].prefix = "also".into();
        let mut see = cite(&["doe2020"]);
        see.items[0].prefix = "see".into();
        let range = cite(&["doe2020", "ERA5LandHourlyData2019", "berg"]);
        let mut see_first = cite(&["berg", "doe2020", "ERA5LandHourlyData2019"]);
        see_first.items[0].prefix = "see".into();
        let cited = [group, see, range, see_first];
        let printed = |style: &str| {
            let style = style_named(Some(style)).unwrap();
            render(&references, &style, &LocaleCode::en_us(), &cited).citations
        };
        assert_eq!(
            printed("apa")[0].as_deref(),
            Some(
                "(see Doe &amp; Roe, 2020, first note; \
                 also Copernicus Climate Change Service, 2019)"
            )
        );
        let vancouver = printed("elsevier-vancouver");
        assert_eq!(
            vancouver[2..],
            [Some("[1–3]".into()), Some("[see 3,1,2]".into())]
        );
        // The bracket is part of the layout, superscript with the number.
        let sup = |text| format!("<span style=\"vertical-align: super;\">{text}</span>");
        assert_eq!(
            printed("angewandte-chemie")[1],
            Some(format!("{}see {}{}", sup("["), sup("1"), sup("]")))
        );
    }

    #[test]
    fn a_locator_is_read_as_pandoc_reads_it() {
        let references = read_biblatex(BIB, true).references;
        // Each suffix with what pandoc 3.13 prints for it in apa.
        let cases = [
            ("p. xii", "p. xii"),
            ("\u{a7} 3", "Section 3"),
            ("\u{a7}\u{a7} 3\u{2013}5", "Sections 3\u{2013}5"),
            ("pp. 3, 5", "pp. 3, 5"),
            ("pp. 3\u{2013}5", "pp. 3\u{2013}5"),
            ("Fig. 3", "Figure 3"),
            ("fig. S1", "Figure S1"),
            ("chap. one", "chap. one"),
            ("p. 3 and 4", "p. 3 and 4"),
            ("12a", "p. 12a"),
            ("p. 1.2", "p. 1.2"),
            // A chapter that is not a plain number prints without its label,
            // so these show whether the term and the number were read out.
            ("chap. iv", "iv"),
            ("chap. xl", "xl"),
            ("chap. MCMXC", "MCMXC"),
            ("chap. 1.2", "1.2"),
            // Without a term a roman numeral is no page.
            ("xii", "xii"),
        ];
        let style = style_named(Some("apa")).unwrap();
        for (suffix, expected) in cases {
            let mut cited = cite(&["doe2020"]);
            cited.items[0].suffix = suffix.to_string();
            let out = render(&references, &style, &LocaleCode::en_us(), &[cited]);
            let text = out.citations[0].as_deref().unwrap();
            assert_eq!(
                text,
                format!("(Doe &amp; Roe, 2020, {expected})"),
                "{suffix}"
            );
        }
    }

    #[test]
    fn the_longest_locator_term_wins() {
        // Pandoc tries "to find the largest match for a label"; hu-HU has
        // "s." for a line and "s. v." for sub verbo.
        let terms = locator_terms(bundled_locales(), &LocaleCode("hu-HU".into()));
        assert_eq!(
            split_locator("s. v. 3", &terms),
            (
                Some(SpecificLocator(Locator::SubVerbo, LocatorPayload::Str("3"))),
                ""
            )
        );
    }

    #[test]
    fn a_locator_runs_over_dots_colons_and_semicolons() {
        // pandoc 3.13 prints these in apa as A.3, 2:15–17 and pp. 3; 5 (the
        // last written `pp. 3\; 5`), and 321-328. as 321–28. in
        // chicago-author-date: the term read out, the full stop no part of
        // the range. hayagriva prints them otherwise, so the reading is
        // checked here.
        let terms = locator_terms(bundled_locales(), &LocaleCode::en_us());
        let cases = [
            ("chap. A.3", Locator::Chapter, "A.3", ""),
            ("chap. 2:15-17", Locator::Chapter, "2:15-17", ""),
            ("pp. 3; 5", Locator::Page, "3; 5", ""),
            ("pp. 321-328.", Locator::Page, "321-328", "."),
        ];
        for (suffix, kind, locator, rest) in cases {
            assert_eq!(
                split_locator(suffix, &terms),
                (
                    Some(SpecificLocator(kind, LocatorPayload::Str(locator))),
                    rest
                ),
                "{suffix}"
            );
        }
    }

    #[test]
    fn a_suffix_and_a_note_end_in_one_full_stop() {
        let references = read_biblatex(BIB, true).references;
        let mut cited = cite(&["doe2020"]);
        cited.items[0].suffix = "p. 3.".into();
        let style = style_named(Some("chicago-shortened-notes")).unwrap();
        let out = render(&references, &style, &LocaleCode::en_us(), &[cited]);
        // pandoc 3.13: one full stop, Doe and Roe, “A Study,” 3.
        assert_eq!(
            out.notes[0].as_deref(),
            Some("Doe and Roe, \u{201c}A Study,\u{201d} 3.")
        );
    }

    #[test]
    fn the_catalogue_lists_each_style_and_locale_once_in_order() {
        let catalogue = catalogue();
        assert!(catalogue.styles.windows(2).all(|w| w[0] < w[1]));
        assert!(catalogue.locales.windows(2).all(|w| w[0] < w[1]));
        for name in &catalogue.styles {
            assert!(style_named(Some(name)).is_ok(), "{name}");
        }
    }

    #[test]
    fn locator_terms_come_from_the_document_locale() {
        let references = read_biblatex(BIB, true).references;
        let texts = [
            "pp. 3-5, emphasis added",
            "Kap. 2",
            "S. 7",
            "page 9, see",
            "nothing numeric",
        ];
        let cited: Vec<Citation> = texts
            .iter()
            .map(|text| {
                let mut c = cite(&["doe2020"]);
                c.items[0].suffix = text.to_string();
                c
            })
            .collect();
        let style = style_named(Some("apa")).unwrap();
        let out = render(
            &references,
            &style,
            &locale_named(Some("de"), &style),
            &cited,
        );
        let texts: Vec<_> = out
            .citations
            .iter()
            .map(|c| c.as_deref().unwrap())
            .collect();
        assert_eq!(
            texts,
            [
                "(Doe &amp; Roe, 2020, pp. 3-5, emphasis added)",
                "(Doe &amp; Roe, 2020, Kapitel 2)",
                "(Doe &amp; Roe, 2020, S. 7)",
                "(Doe &amp; Roe, 2020, page 9, see)",
                "(Doe &amp; Roe, 2020, nothing numeric)"
            ]
        );
        let style = style_named(Some("gb-7714-2015-note")).unwrap();
        let out = render(&references, &style, &locale_named(None, &style), &cited);
        let note = out.notes[0].as_deref().unwrap();
        assert!(
            note.ends_with("2020, 3: 1-9, pp. 3-5, emphasis added."),
            "{note}"
        );
    }

    #[test]
    fn a_document_renders_from_its_header_alone() {
        let header = format!(
            "csl: apa\nlang: en-US\nreference-section-title: Sources\n{ISSUE_EXAMPLE}bibliography: gone.bib\n"
        );
        let cited = [cite(&["ERA5LandHourlyData2019"])];
        let document = std::env::temp_dir().join("paper.md");
        let out = render_document(document.to_str(), &header, false, &cited).unwrap();
        assert_eq!(
            out.citations[0].as_deref(),
            Some("(Copernicus Climate Change Service, 2019)")
        );
        assert_eq!(out.warnings, ["gone.bib: not found"]);
        assert_eq!(out.title.as_deref(), Some("Sources"));
        let json = serde_json::to_value(&out).unwrap();
        assert!(json.get("hangingIndent").is_some());
        let sent: Citation =
            serde_json::from_str(r#"{"items":[{"key":"a"}],"inText":true}"#).unwrap();
        assert!(sent.in_text && sent.items[0].key == "a");
        let err = render_document(None, "csl: nope\n", false, &cited).unwrap_err();
        assert!(err.starts_with("unknown citation style"));
    }

    #[test]
    fn suppress_bibliography_keeps_the_citations_and_drops_the_list() {
        let cited = [cite(&["ERA5LandHourlyData2019"])];
        for (setting, suppressed) in [
            ("true", true),
            ("\"Yes\"", true),
            ("t", true),
            ("false", false),
            ("no", false),
        ] {
            let header = format!("suppress-bibliography: {setting}\n{ISSUE_EXAMPLE}");
            let out = render_document(None, &header, false, &cited).unwrap();
            assert!(out.citations[0].is_some(), "{setting}");
            assert_eq!(out.bibliography.is_empty(), suppressed, "{setting}");
        }
    }

    #[test]
    fn a_failing_style_warns_and_leaves_the_citations_as_written() {
        // Two works whose shorter author list is the start of the longer one
        // make hayagriva 0.10's MLA disambiguation index past the list.
        let refs = read_csl_yaml(
            "- id: a2012\n  type: article-journal\n  title: Forcing\n  issued: 2012\n  author:\n  \
             - family: Andrews\n    given: Timothy\n  - family: Gregory\n    given: Jonathan\n  \
             - family: Webb\n    given: Mark\n  - family: Taylor\n    given: Karl\n\
             - id: a2015\n  type: article-journal\n  title: Feedback\n  issued: 2015\n  author:\n  \
             - family: Andrews\n    given: Timothy\n  - family: Gregory\n    given: Jonathan\n  \
             - family: Webb\n    given: Mark\n",
        )
        .unwrap();
        let style = style_named(Some("modern-language-association")).unwrap();
        let locale = locale_named(None, &style);
        let out = render(
            &refs.references,
            &style,
            &locale,
            &[cite(&["a2012"]), cite(&["a2015"])],
        );
        assert_eq!(out.citations, vec![None, None]);
        assert!(out.bibliography.is_empty());
        assert_eq!(out.warnings.len(), 1, "{:?}", out.warnings);
        assert!(out.warnings[0].contains("failed"));
    }

    /// The header of a fixture document, between its `---` lines.
    /// The header as the app's `frontMatter()` takes it, for LF and CRLF files.
    fn front_matter(text: &str) -> &str {
        let (open, close) = if text.starts_with("---\r\n") {
            ("---\r\n", "\r\n---\r\n")
        } else {
            ("---\n", "\n---\n")
        };
        let body = text.strip_prefix(open).unwrap_or("");
        body.split(close).next().unwrap_or("")
    }

    /// The citation chain's Rust link (see src/citations.fixtures.test.ts):
    /// `name.citations.json`, what the export sends for `name.md`, renders
    /// with the document's header to `name.rendered.json`, which the export
    /// snapshot feeds back in. MONOLEAF_UPDATE_FIXTURES=1 rewrites the
    /// rendered files after an intended change.
    #[test]
    fn fixture_documents_render_as_committed() {
        let dir =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../src/__fixtures__/citations");
        let mut seen = 0;
        for entry in std::fs::read_dir(&dir).unwrap() {
            let path = entry.unwrap().path();
            if path.extension().and_then(|e| e.to_str()) != Some("md") {
                continue;
            }
            let base = path.with_extension("").display().to_string();
            let text = std::fs::read_to_string(&path).unwrap();
            let sent = std::fs::read_to_string(format!("{base}.citations.json")).unwrap();
            let cited: Vec<Citation> = serde_json::from_str(&sent).unwrap();
            let out = render_document(path.to_str(), front_matter(&text), false, &cited).unwrap();
            let json = serde_json::to_string_pretty(&out).unwrap() + "\n";
            let rendered = format!("{base}.rendered.json");
            if std::env::var_os("MONOLEAF_UPDATE_FIXTURES").is_some() {
                std::fs::write(&rendered, &json).unwrap();
            } else {
                let committed = std::fs::read_to_string(&rendered).unwrap_or_default();
                assert_eq!(committed, json, "{rendered} differs from the rendering; MONOLEAF_UPDATE_FIXTURES=1 cargo test rewrites it");
            }
            seen += 1;
        }
        assert!(seen > 0, "no fixture documents in {}", dir.display());
    }

    /// Every bundled style with several locales, among them an unknown and
    /// an empty one, renders the test references without a panic: hayagriva
    /// panics on a date range, which the reader removes, and this sweep is
    /// the net under the rest.
    #[test]
    fn every_bundled_style_renders_in_every_locale_without_a_panic() {
        let mut references = read_biblatex(BIB, true).references;
        references.extend(read_csl_yaml(ISSUE_EXAMPLE).unwrap().references);
        let mut seen = cite(&["doe2020"]);
        seen.items[0].prefix = "see".into();
        seen.items[0].suffix = "p. 3, emphasis added".into();
        let mut year = cite(&["doe2020"]);
        year.items[0].suppress_author = true;
        let mut prose = cite(&["ERA5LandHourlyData2019"]);
        prose.in_text = true;
        let group = cite(&["doe2020", "ERA5LandHourlyData2019", "nobody"]);
        let cited = [seen, year, prose, group];
        let mut styles = 0;
        for archived in hayagriva::archive::ArchivedStyle::all() {
            let Style::Independent(style) = archived.get() else {
                continue;
            };
            styles += 1;
            for lang in [None, Some("en-GB"), Some("de-DE"), Some("xx"), Some("")] {
                let locale = locale_named(lang, &style);
                let out = render(&references, &style, &locale, &cited);
                assert_eq!(out.citations.len(), 4, "{}", archived.names()[0]);
                // hayagriva's own alphanumeric style prints "[]" without a
                // label where the locator is not read out.
                let printed = out.citations[..3].iter().flatten().count();
                let empty = out.warnings.iter().filter(|w| w.contains("prints nothing"));
                assert_eq!(
                    printed + empty.count(),
                    3,
                    "{} {lang:?}: {:?}",
                    archived.names()[0],
                    out.citations
                );
                // hayagriva's own alphanumeric style has no bibliography layout.
                if style.bibliography.is_some() {
                    assert_eq!(out.bibliography.len(), 2, "{}", archived.names()[0]);
                }
            }
        }
        assert_eq!(styles, 80);
    }

    #[test]
    fn the_catalogue_lists_every_bundled_style_and_locale() {
        let found = catalogue();
        assert_eq!(found.styles.len(), 80);
        assert!(found.styles.contains(&"apa".to_string()));
        assert!(found.locales.contains(&"de-DE".to_string()));
        assert!(found.locales.len() > 40, "{}", found.locales.len());
    }

    #[test]
    fn markup_in_a_reference_never_prints_as_html() {
        let bib = "@article{odd, author={Doe, Jane}, title={A <b>bold</b> x < y & co}, \
                   journal={J}, year={2020}, doi={10.1/a\"b}}";
        let references = read_biblatex(bib, true).references;
        let style = style_named(Some("apa")).unwrap();
        let mut cited = cite(&["odd"]);
        cited.items[0].prefix = "<i>see</i>".into();
        cited.items[0].suffix = "p. 3, <u>really</u>".into();
        let out = render(&references, &style, &LocaleCode::en_us(), &[cited]);
        assert_eq!(
            out.citations[0].as_deref(),
            Some("(&lt;i&gt;see&lt;/i&gt; Doe, 2020, p. 3, &lt;u&gt;really&lt;/u&gt;)")
        );
        let html = &out.bibliography[0].html;
        assert!(html.contains("A bold x &lt; y &amp; co"), "{html}");
        assert!(
            html.contains("href=\"https://doi.org/10.1/a&quot;b\""),
            "{html}"
        );
        assert!(!html.contains("<b>"), "{html}");
    }

    #[test]
    fn csl_rich_text_prints_as_formatting_and_other_tags_as_text() {
        let json = r#"[{"id": "k", "type": "article-journal", "issued": 2020, "container-title": "J",
            "author": [{"family": "Doe", "given": "Jane"}],
            "title": "The <i>emphasised</i> word, <i>a <b>b</b></i>, X<sup>2</sup> H<sub>2</sub>O <span style=\"font-variant:small-caps;\">Sc</span> <span class=\"nocase\">iPhone</span>"},
            {"id": "h", "type": "article-journal", "issued": 2020, "container-title": "J",
            "author": [{"family": "Roe", "given": "Ann"}],
            "title": "<script>x</script> <a onclick=\"y\">z</a> 1 < 2 &amp; <I>u</I> <i>open <b>b</i> c</b>"}]"#;
        let references = read_csl_json(json).unwrap().references;
        let style = style_named(Some("apa")).unwrap();
        let out = render(
            &references,
            &style,
            &LocaleCode::en_us(),
            &[cite(&["k", "h"])],
        );
        let italic = |text| format!("<span style=\"font-style: italic;\">{text}</span>");
        assert_eq!(
            out.bibliography[0].html,
            format!(
                "Doe, J. (2020). The {} word, {}<span style=\"font-style: italic;font-weight: bold;\">b</span>, \
                 X<span style=\"vertical-align: super;\">2</span> H<span style=\"vertical-align: sub;\">2</span>O \
                 <span style=\"font-variant: small-caps;\">Sc</span> iPhone. {}.",
                italic("emphasised"),
                italic("a "),
                italic("J")
            )
        );
        assert_eq!(
            out.bibliography[1].html,
            "Roe, A. (2020). &lt;script&gt;x&lt;/script&gt; &lt;a onclick=&quot;y&quot;&gt;z&lt;/a&gt; \
             1 &lt; 2 &amp;amp; &lt;I&gt;u&lt;/I&gt; &lt;i&gt;open \
             <span style=\"font-weight: bold;\">b&lt;/i&gt; c</span>. \
             <span style=\"font-style: italic;\">J</span>."
        );
    }
}
