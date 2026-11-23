//! A `.bib` entry as a CSL item. The entry types and fields map as Pandoc's
//! BibTeX reader maps them, so a `.bib` file renders like the same works in
//! CSL JSON, and like Pandoc prints them. A field Pandoc does not read is not
//! read here either.

use biblatex::{
    Bibliography, Chunk, Chunks, ChunksExt, ChunksRef, Date, DateValue as BibDate, Entry,
    EntryType, ParseError, RawBibliography, Spanned,
};
use hayagriva::citationberg::json::{
    DateValue, Item, LiteralName, NameItem, NameValue, Value, VecDate, VecDateRange,
};
use std::collections::BTreeMap;

/// The genre Pandoc gives a thesis without a `type` field.
const PHD_THESIS: &str = "PhD thesis";
const MASTERS_THESIS: &str = "Master's thesis";

/// BibLaTeX localisation keys with their English text from BibLaTeX's
/// `english.lbx`, as Pandoc prints them; any other value is its own text.
const KEY_TEXTS: [(&str, &str); 34] = [
    ("bathesis", "Bachelor's thesis"),
    ("mathesis", MASTERS_THESIS),
    ("phdthesis", PHD_THESIS),
    ("candthesis", "Candidate thesis"),
    ("resreport", "research report"),
    ("techreport", "technical report"),
    ("software", "computer software"),
    ("datacd", "CD-ROM"),
    ("audiocd", "audio CD"),
    ("inpreparation", "in preparation"),
    ("submitted", "submitted"),
    ("forthcoming", "forthcoming"),
    ("inpress", "in press"),
    ("prepublished", "pre-published"),
    ("countryde", "Germany"),
    ("countryeu", "European Union"),
    ("countryep", "European Union"),
    ("countryfr", "France"),
    ("countryuk", "United Kingdom"),
    ("countryus", "United States of America"),
    ("patent", "patent"),
    ("patentde", "German patent"),
    ("patenteu", "European patent"),
    ("patentfr", "French patent"),
    ("patentuk", "British patent"),
    ("patentus", "U.S. patent"),
    ("patreq", "patent request"),
    ("patreqde", "German patent request"),
    ("patreqeu", "European patent request"),
    ("patreqfr", "French patent request"),
    ("patrequk", "British patent request"),
    ("patrequs", "U.S. patent request"),
    ("newseries", "new series"),
    ("oldseries", "old series"),
];

/// The start of the command that prints a key's text, as the parser keeps it.
const BIBSTRING: &str = "\\bibstring{";

/// The `pubstate` texts a `year` field may hold instead of a year.
const STATUS_TEXTS: [&str; 5] = [
    "in press",
    "forthcoming",
    "submitted",
    "in preparation",
    "pre-published",
];

/// BibLaTeX language names and the CSL locale each stands for.
const LANGUAGES: [(&str, &str); 21] = [
    ("english", "en-US"),
    ("american", "en-US"),
    ("usenglish", "en-US"),
    ("british", "en-GB"),
    ("ukenglish", "en-GB"),
    ("australian", "en-GB"),
    ("newzealand", "en-GB"),
    ("german", "de-DE"),
    ("ngerman", "de-DE"),
    ("french", "fr-FR"),
    ("spanish", "es-ES"),
    ("italian", "it-IT"),
    ("dutch", "nl-NL"),
    ("portuguese", "pt-PT"),
    ("brazilian", "pt-BR"),
    ("russian", "ru-RU"),
    ("swedish", "sv-SE"),
    ("danish", "da-DK"),
    ("norwegian", "nb-NO"),
    ("finnish", "fi-FI"),
    ("polish", "pl-PL"),
];

/// The `eprinttype` values that name a site, and the URL an eprint id follows.
const EPRINT_SITES: [(&str, &str); 4] = [
    ("arxiv", "https://arxiv.org/abs/"),
    ("jstor", "https://www.jstor.org/stable/"),
    ("pubmed", "https://www.ncbi.nlm.nih.gov/pubmed/"),
    ("googlebooks", "https://books.google.com?id="),
];

/// The LaTeX commands whose argument prints as its text, and whether Pandoc
/// sets it in quotation marks. Pandoc sets the others in italics, bold, small
/// caps, superscript or subscript, which item text cannot carry. A
/// declaration such as `em` takes no argument; Pandoc prints the group after
/// it as one.
const TEXT_COMMANDS: [(&str, bool); 36] = [
    ("emph", false),
    ("textit", false),
    ("textbf", false),
    ("textsc", false),
    ("textup", false),
    ("textrm", false),
    ("textnormal", false),
    ("textsuperscript", false),
    ("textsubscript", false),
    ("mkbibemph", false),
    ("mkbibitalic", false),
    ("mkbibbold", false),
    ("url", false),
    ("textsl", false),
    ("texttt", false),
    ("textsf", false),
    ("textmd", false),
    ("underline", false),
    ("sout", false),
    ("nolinkurl", false),
    ("autocap", false),
    ("NoCaseChange", false),
    ("em", false),
    ("it", false),
    ("bf", false),
    ("sl", false),
    ("tt", false),
    ("rm", false),
    ("itshape", false),
    ("bfseries", false),
    ("scshape", false),
    ("slshape", false),
    ("ttfamily", false),
    ("mkbibquote", true),
    ("enquote", true),
    ("enquote*", true),
];

/// The LaTeX commands without an argument that print a character, as
/// Pandoc's LaTeX reader prints them.
const SYMBOL_COMMANDS: [(&str, char); 3] = [("slash", '/'), ("hyphen", '-'), ("ldots", '\u{2026}')];

/// The LaTeX commands that change the case of their argument, and whether to
/// upper case, as Pandoc's LaTeX reader does.
const CASE_COMMANDS: [(&str, bool); 6] = [
    ("uppercase", true),
    ("MakeUppercase", true),
    ("MakeTextUppercase", true),
    ("lowercase", false),
    ("MakeLowercase", false),
    ("MakeTextLowercase", false),
];

/// The LaTeX commands with two arguments of which Pandoc's LaTeX reader
/// prints one: whether it is the second, and whether Pandoc sets it in
/// quotation marks.
const TWO_ARGUMENT_COMMANDS: [(&str, bool, bool); 6] = [
    ("href", true, false),
    ("textcolor", true, false),
    ("foreignlanguage", true, false),
    ("texorpdfstring", false, false),
    ("foreignquote", true, true),
    ("hyphenquote", true, true),
];

/// The marks the `.bib` pre-pass puts inside the braces of a group that
/// directly follows a command's argument, `\foo{a}{b}`, as the parser drops
/// those braces. Private-use characters, which `.bib` text has no use for.
pub const ARGUMENT_START: char = '\u{e000}';
pub const ARGUMENT_END: char = '\u{e001}';

/// The marks the `.bib` pre-pass puts for `\textbackslash` and for the line
/// break `\\`, both of which the parser turns into a lone `\`. Private-use
/// characters, as the argument marks.
pub const BACKSLASH: char = '\u{e002}';
pub const LINE_BREAK: char = '\u{e003}';

/// The mark a formula's text stands between on its way to unlatex, which
/// prints it as written between "$". The parser keeps no difference between
/// a formula's "$" and an escaped one, so a "$" in the text is a dollar.
const FORMULA: char = '\u{e004}';

/// The named HTML references for the characters markup reserves.
const MARKUP_ENTITIES: [(&str, char); 5] = [
    ("amp", '&'),
    ("lt", '<'),
    ("gt", '>'),
    ("quot", '"'),
    ("apos", '\''),
];

/// The HTML 4 Latin-1 entity set (HTMLlat1.ent), in code point order from
/// `LATIN_1_FIRST`: "nbsp" is U+00A0, "yuml" U+00FF.
const LATIN_1_ENTITIES: [&str; 96] = [
    "nbsp", "iexcl", "cent", "pound", "curren", "yen", "brvbar", "sect", "uml", "copy", "ordf",
    "laquo", "not", "shy", "reg", "macr", "deg", "plusmn", "sup2", "sup3", "acute", "micro",
    "para", "middot", "cedil", "sup1", "ordm", "raquo", "frac14", "frac12", "frac34", "iquest",
    "Agrave", "Aacute", "Acirc", "Atilde", "Auml", "Aring", "AElig", "Ccedil", "Egrave", "Eacute",
    "Ecirc", "Euml", "Igrave", "Iacute", "Icirc", "Iuml", "ETH", "Ntilde", "Ograve", "Oacute",
    "Ocirc", "Otilde", "Ouml", "times", "Oslash", "Ugrave", "Uacute", "Ucirc", "Uuml", "Yacute",
    "THORN", "szlig", "agrave", "aacute", "acirc", "atilde", "auml", "aring", "aelig", "ccedil",
    "egrave", "eacute", "ecirc", "euml", "igrave", "iacute", "icirc", "iuml", "eth", "ntilde",
    "ograve", "oacute", "ocirc", "otilde", "ouml", "divide", "oslash", "ugrave", "uacute", "ucirc",
    "uuml", "yacute", "thorn", "yuml",
];

/// The code point of the first Latin-1 entity, the no-break space.
const LATIN_1_FIRST: u32 = 0xA0;

/// A `&#x` reference is hexadecimal.
const HEX_RADIX: u32 = 16;

/// What a tag's name holds besides ASCII letters and digits: "mml:mi" is the
/// name of a MathML element in a title exported from Crossref.
const TAG_NAME_MARKS: &str = ":._-";

/// What splits a title into words, besides a space, where Pandoc decides
/// which word is the last: "answer.here" is one word, "Answer-here" two.
const WORD_SEPARATORS: &str = "-\u{2013}\u{2014}/~";

/// The CSL item for one entry. Never fails: a field that cannot be read as
/// its type is taken as text, a date that is no date becomes the literal
/// text of the date. `english_document` says whether the citing document is
/// English; only then do titles go to sentence case, as in Pandoc.
pub fn item_of(entry: &Entry, english_document: bool) -> Item {
    let mut csl_variables = CslVariables::default();
    csl_variables.set("id", Some(entry.key.clone()));
    csl_variables.set("type", csl_type(entry).map(str::to_string));
    csl_variables.set("genre", genre(entry));
    titles(entry, &mut csl_variables, english_document);
    numbers(entry, &mut csl_variables);
    publishers(entry, &mut csl_variables);
    identifiers(entry, &mut csl_variables);
    notes(entry, &mut csl_variables);
    names(entry, &mut csl_variables);
    dates(entry, &mut csl_variables);
    Item(csl_variables.0)
}

/// `crossref` under a name no `.bib` field has, so that
/// `Bibliography::from_raw` does not resolve it by its own rules. It sorts
/// where `crossref` sorts, so the fields arrive in Pandoc's order.
const HELD_CROSSREF: &str = "crossref#";

/// `xdata` held as `crossref` is. It sorts after `crossref`, so what it gives
/// comes later and wins, as in Pandoc.
const HELD_XDATA: &str = "xdata#";

/// The entry type as the `.bib` file writes it, in lower case, under a name no
/// `.bib` field has: the crate reads `@www` and `@electronic` as `@online`.
const RAW_TYPE: &str = "type#";

/// How many `crossref` or `xdata` links in a row are followed: a part, its
/// volume and the multi-volume set make two, eight leaves room and still ends
/// a cycle.
const CROSSREF_DEPTH: usize = 8;

/// The fields Pandoc never passes from parent to child.
const NOT_INHERITED: &str = "ids xref entryset entrysubtype execute label options presort \
    related relatedoptions relatedstring relatedtype shorthand shorthandintro sortkey";

/// The entries of a `.bib` text, each with the fields it inherits through
/// `crossref` and `xdata` as Pandoc's BibTeX reader gives them, without the
/// `@xdata` entries, which only hold fields.
pub fn entries(text: &str) -> Result<Vec<Entry>, ParseError> {
    let mut raw = RawBibliography::parse(text)?;
    for pair in raw.entries.iter_mut().flat_map(|entry| &mut entry.v.fields) {
        if pair.key.v.eq_ignore_ascii_case("crossref") {
            pair.key.v = HELD_CROSSREF;
        } else if pair.key.v.eq_ignore_ascii_case("xdata") {
            pair.key.v = HELD_XDATA;
        }
    }
    let raw_types: Vec<String> = raw
        .entries
        .iter()
        .map(|entry| entry.v.kind.v.to_ascii_lowercase())
        .collect();
    let mut entries = Bibliography::from_raw(raw)?.into_vec();
    join_display_formulas(&mut entries, text);
    for (entry, raw_type) in entries.iter_mut().zip(raw_types) {
        let value = vec![Spanned::detached(Chunk::Verbatim(raw_type))];
        entry.fields.insert(RAW_TYPE.to_string(), value);
    }
    let inherited: Vec<_> = entries
        .iter()
        .map(|entry| {
            [HELD_CROSSREF, HELD_XDATA]
                .map(|held| from_parent(entry, entry.get(held), &entries, CROSSREF_DEPTH))
                .concat()
        })
        .collect();
    for (entry, fields) in entries.iter_mut().zip(inherited) {
        entry.fields.extend(fields);
    }
    entries.retain(|entry| entry.entry_type != EntryType::XData);
    Ok(entries)
}

/// Each display formula, "$$…$$", in the fields of `entries` as one formula
/// holding its text as written in `text`, the source they were parsed from.
/// The parser reads "$$" as an empty formula and what stands between two of
/// them as text, which loses its braces.
fn join_display_formulas(entries: &mut [Entry], text: &str) {
    for entry in entries {
        for chunks in entry.fields.values_mut() {
            *chunks = display_formulas_joined(chunks, text);
        }
    }
}

/// The chunks with each display formula joined, see join_display_formulas.
/// A "$$" without a second one stays as the parser read it.
fn display_formulas_joined(chunks: ChunksRef, text: &str) -> Chunks {
    // Each "$$" is an empty formula's span with one "$" on either side.
    let dollar = '$'.len_utf8();
    let mut joined = Chunks::new();
    let mut open: Option<(usize, std::ops::Range<usize>)> = None;
    for chunk in chunks {
        if matches!(&chunk.v, Chunk::Math(math) if math.is_empty()) {
            match open.take() {
                None => open = Some((joined.len(), chunk.span.clone())),
                Some((at, start)) => {
                    let between = start.end + dollar..chunk.span.start.saturating_sub(dollar);
                    if let Some(formula) = text.get(between) {
                        joined.truncate(at);
                        let span = start.start..chunk.span.end;
                        joined.push(Spanned::new(Chunk::Math(format!("${formula}$")), span));
                        continue;
                    }
                }
            }
        }
        joined.push(chunk.clone());
    }
    joined
}

/// The fields `child` lacks and takes from the entries `keys` names, split at
/// commas and white space; of two with one name the later wins, and a parent
/// later in the file comes later, whatever the order of the keys.
fn from_parent(
    child: &Entry,
    keys: Option<ChunksRef>,
    entries: &[Entry],
    depth: usize,
) -> Vec<(String, Chunks)> {
    let keys = keys.map(|keys| keys.format_verbatim()).unwrap_or_default();
    let keys: Vec<&str> = keys
        .split(|c: char| c == ',' || c.is_whitespace())
        .collect();
    entries
        .iter()
        .filter(|entry| depth > 0 && keys.contains(&entry.key.as_str()))
        .flat_map(|parent| parent_fields(child, parent, entries, depth))
        .collect()
}

/// The fields `child` lacks and takes from one parent, with those of that
/// parent's own parents.
fn parent_fields(
    child: &Entry,
    parent: &Entry,
    entries: &[Entry],
    depth: usize,
) -> Vec<(String, Chunks)> {
    let mut fields = Vec::new();
    let book_author = takes_book_author(&parent.entry_type, &child.entry_type);
    for (name, value) in &parent.fields {
        if name == "author" && book_author && !child.fields.contains_key("bookauthor") {
            fields.push(("bookauthor".to_string(), value.clone()));
        }
        if name == HELD_CROSSREF || name == HELD_XDATA {
            let nested = from_parent(child, Some(value), entries, depth - 1);
            fields.extend(
                nested
                    .into_iter()
                    .filter(|(n, _)| !parent.fields.contains_key(n)),
            );
        } else if let Some(target) = inherited_name(&parent.entry_type, &child.entry_type, name) {
            if !child.fields.contains_key(&target) {
                fields.push((target, value.clone()));
            }
        }
    }
    fields
}

/// Whether the child takes the parent's `author` as its `bookauthor` too, as
/// Pandoc's `transformKey` gives it.
fn takes_book_author(parent: &EntryType, child: &EntryType) -> bool {
    use EntryType::*;
    matches!(
        (parent, child),
        (MvBook | Book, InBook | BookInBook | SuppBook) | (MvBook, Book)
    )
}

/// The name a parent's field takes in the child, after Pandoc's
/// `transformKey` (Appendix C of the BibLaTeX manual); `None` for a field
/// that is not inherited.
fn inherited_name(parent: &EntryType, child: &EntryType, name: &str) -> Option<String> {
    use EntryType::*;
    if NOT_INHERITED.split_whitespace().any(|field| field == name) {
        return None;
    }
    let prefix = match (parent, child) {
        (MvBook, Book | InBook | BookInBook | SuppBook)
        | (MvCollection | MvReference, Collection | Reference | InCollection)
        | (MvCollection | MvReference, InReference | SuppCollection)
        | (MvProceedings, Proceedings | InProceedings) => "main",
        (Book, InBook | BookInBook | SuppBook)
        | (Collection | Reference, InCollection | InReference | SuppCollection)
        | (Proceedings, InProceedings) => "book",
        (Periodical, Article | SuppPeriodical) => "journal",
        _ => return Some(name.to_string()),
    };
    match name {
        "title" | "subtitle" => Some(format!("{prefix}{name}")),
        "titleaddon" if prefix != "journal" => Some(format!("{prefix}{name}")),
        "shorttitle" | "sorttitle" | "indextitle" | "indexsorttitle" => None,
        _ => Some(name.to_string()),
    }
}

/// The variables of an item while it is built; `set` with `None` sets nothing.
#[derive(Default)]
struct CslVariables(BTreeMap<String, Value>);

impl CslVariables {
    fn set(&mut self, name: &str, value: Option<String>) {
        if let Some(value) = value.filter(|v| !v.is_empty()) {
            self.0.insert(name.to_string(), Value::String(value));
        }
    }

    fn has(&self, name: &str) -> bool {
        self.0.contains_key(name)
    }
}

/// The CSL item type of the entry type; `None` for `misc`, `set`, `xdata`
/// and unknown types, which Pandoc leaves without a type.
fn csl_type(entry: &Entry) -> Option<&'static str> {
    use EntryType::*;
    Some(match &entry.entry_type {
        Article | Periodical | SuppPeriodical => match text(entry, "entrysubtype").as_deref() {
            Some("magazine") => "article-magazine",
            Some("newspaper") => "article-newspaper",
            _ => "article-journal",
        },
        Book | BookInBook | Collection | Manual | MvBook | MvCollection | MvProceedings
        | MvReference | Proceedings | Reference => "book",
        Booklet => "pamphlet",
        Dataset => "dataset",
        Online => "webpage",
        InBook | InCollection | SuppBook | SuppCollection => "chapter",
        InReference => "entry-encyclopedia",
        InProceedings => "paper-conference",
        MastersThesis | PhdThesis | Thesis => "thesis",
        Patent => "patent",
        Report | TechReport => "report",
        Software => "software",
        Unpublished => {
            if ["eventdate", "eventtitle", "venue"]
                .iter()
                .any(|f| entry.get(f).is_some())
            {
                "speech"
            } else {
                "manuscript"
            }
        }
        Misc | Set | XData => return None,
        Unknown(name) => match name.to_ascii_lowercase().as_str() {
            "electronic" | "www" => "webpage",
            "artwork" | "image" => "graphic",
            "audio" | "music" => "song",
            "jurisdiction" => "legal_case",
            "legislation" | "standard" => "legislation",
            "legal" => "treaty",
            "letter" | "letters" => "personal_communication",
            "movie" | "video" => "motion_picture",
            "performance" => "speech",
            "review" => "review",
            "newsarticle" => "article-newspaper",
            "commentary" => "book",
            "data" => "dataset",
            _ => return None,
        },
    })
}

/// A part of a book: its `booktitle` is the container.
fn is_chapter_like(entry: &Entry) -> bool {
    use EntryType::*;
    matches!(
        entry.entry_type,
        InBook
            | InCollection
            | InProceedings
            | InReference
            | BookInBook
            | SuppBook
            | SuppCollection
    )
}

/// A periodical article: its `number` is the issue.
fn is_article_like(entry: &Entry) -> bool {
    use EntryType::*;
    match &entry.entry_type {
        Article | Periodical | SuppPeriodical => true,
        Unknown(name) => name.eq_ignore_ascii_case("review"),
        _ => false,
    }
}

/// A book or a part of one: its `number` is the number in the series.
fn is_book_like(entry: &Entry) -> bool {
    use EntryType::*;
    matches!(
        entry.entry_type,
        Book | Collection
            | Proceedings
            | Reference
            | MvBook
            | MvCollection
            | MvProceedings
            | MvReference
    ) || is_chapter_like(entry)
}

/// The `type` field as text, or the thesis kind the entry type implies.
fn genre(entry: &Entry) -> Option<String> {
    match text(entry, "type") {
        Some(value) => Some(key_text(&value)),
        None => match entry.entry_type {
            EntryType::PhdThesis => Some(PHD_THESIS.to_string()),
            EntryType::MastersThesis => Some(MASTERS_THESIS.to_string()),
            _ => None,
        },
    }
}

/// A BibLaTeX key's English text; any other value, "PatentEU" too, is its
/// own text.
fn key_text(value: &str) -> String {
    KEY_TEXTS
        .iter()
        .find(|(name, _)| *name == value)
        .map_or_else(|| value.to_string(), |(_, text)| text.to_string())
}

/// Text with every word that is a BibLaTeX key replaced by the key's text.
fn keys_resolved(value: &str) -> String {
    value.split(' ').map(key_text).collect::<Vec<_>>().join(" ")
}

/// Text with every `\bibstring{key}` replaced by the key's text.
fn bibstrings_resolved(raw: &str) -> String {
    let mut out = String::new();
    let mut rest = raw;
    while let Some((before, after)) = rest.split_once(BIBSTRING) {
        let Some((key, tail)) = after.split_once('}') else {
            break;
        };
        out.push_str(before);
        out.push_str(&key_text(key));
        rest = tail;
    }
    out.push_str(rest);
    out
}

/// Title, container and series. A book with a `maintitle` is a volume of
/// it: the main title is the title, the book's own becomes the volume title.
/// A chapter of such a volume is in the main title, its book is the volume.
/// Titles of an English entry go to sentence case, as Pandoc puts them, so a
/// style may raise them again; a journal's name keeps its case. A periodical
/// is an issue of a journal: its `title` names the journal, and its own title
/// is the `issuetitle` where it has one.
fn titles(entry: &Entry, csl_variables: &mut CslVariables, english_document: bool) {
    let english = english_document && is_english(entry);
    let periodical = entry.entry_type == EntryType::Periodical;
    let issue_or = |issue_field: &'static str, field: &'static str| {
        if periodical && entry.get(issue_field).is_some() {
            issue_field
        } else {
            field
        }
    };
    let subtitle = issue_or("issuesubtitle", "subtitle");
    let own = joined(
        entry,
        issue_or("issuetitle", "title"),
        subtitle,
        "titleaddon",
        english,
    );
    if !is_chapter_like(entry) && entry.get("maintitle").is_some() {
        csl_variables.set(
            "title",
            joined(
                entry,
                "maintitle",
                "mainsubtitle",
                "maintitleaddon",
                english,
            ),
        );
        csl_variables.set("volume-title", own);
    } else {
        csl_variables.set("title", own.clone());
        let short = match titled(entry, "shorttitle", english) {
            Some(short) => Some(short),
            None => {
                // A subtitle of a chapter in a multi-volume work makes no
                // short title, as in Pandoc; a colon in the title still does.
                let title = titled(entry, "title", english);
                let has_more = (entry.get("maintitle").is_none()
                    && (entry.get(subtitle).is_some() || entry.get("titleaddon").is_some()))
                    || title.as_deref().is_some_and(|t| t.contains(':'));
                has_more.then(|| title.map(|t| before_colon(&t))).flatten()
            }
        };
        csl_variables.set("title-short", short);
    }
    if periodical {
        csl_variables.set(
            "container-title",
            joined(entry, "title", "subtitle", "titleaddon", false),
        );
    } else if is_chapter_like(entry) && entry.get("maintitle").is_some() {
        csl_variables.set(
            "container-title",
            joined(
                entry,
                "maintitle",
                "mainsubtitle",
                "maintitleaddon",
                english,
            ),
        );
        csl_variables.set(
            "volume-title",
            joined(
                entry,
                "booktitle",
                "booksubtitle",
                "booktitleaddon",
                english,
            ),
        );
    } else if is_chapter_like(entry) && entry.get("booktitle").is_some() {
        csl_variables.set(
            "container-title",
            joined(
                entry,
                "booktitle",
                "booksubtitle",
                "booktitleaddon",
                english,
            ),
        );
    } else if entry.get("journaltitle").is_some() {
        csl_variables.set(
            "container-title",
            joined(
                entry,
                "journaltitle",
                "journalsubtitle",
                "journaltitleaddon",
                false,
            ),
        );
    } else {
        csl_variables.set("container-title", text(entry, "journal"));
    }
    csl_variables.set(
        "container-title-short",
        text(entry, "shorttitle")
            .filter(|_| periodical)
            .or_else(|| text(entry, "shortjournal")),
    );
    csl_variables.set("collection-title", series(entry, english));
    csl_variables.set("event", titled(entry, "eventtitle", english));
    csl_variables.set("original-title", titled(entry, "origtitle", english));
}

/// The series. A number is the count of a journal's series and becomes
/// "3rd series", in English whatever the document's language, as Pandoc
/// writes it; any other value is a title whose unbraced words that are
/// BibLaTeX keys print as the key's text, "newseries" as "New series".
fn series(entry: &Entry, english: bool) -> Option<String> {
    let chunks: Chunks = entry
        .get("series")?
        .iter()
        .map(|chunk| match &chunk.v {
            Chunk::Normal(text) => {
                Spanned::new(Chunk::Normal(keys_resolved(text)), chunk.span.clone())
            }
            _ => chunk.clone(),
        })
        .collect();
    let value = plain(&chunks);
    if value.is_empty() {
        None
    } else if value.bytes().all(|b| b.is_ascii_digit()) {
        Some(format!("{} series", ordinal(&value)))
    } else if english {
        Some(unlatex(&sentence_case_of(&chunks)))
    } else {
        Some(value)
    }
}

/// A number with its English ordinal suffix: "st", "nd" and "rd" after a
/// last digit 1, 2 and 3, except in 11, 12 and 13; "th" otherwise.
fn ordinal(number: &str) -> String {
    let suffix = match number.as_bytes() {
        [.., b'1', b'1' | b'2' | b'3'] => "th",
        [.., b'1'] => "st",
        [.., b'2'] => "nd",
        [.., b'3'] => "rd",
        _ => "th",
    };
    format!("{number}{suffix}")
}

/// The part of a title before its first colon, the whole title without one.
fn before_colon(title: &str) -> String {
    title
        .split(':')
        .next()
        .unwrap_or_default()
        .trim()
        .to_string()
}

/// Whether the entry's titles are English: no `langid`, or one that names an
/// English variant. Pandoc puts only those into sentence case.
fn is_english(entry: &Entry) -> bool {
    match text(entry, "langid").or_else(|| text(entry, "hyphenation")) {
        None => true,
        Some(name) => language_code(&name).starts_with("en"),
    }
}

/// The CSL locale of a BibLaTeX language name; an unknown name as it is.
fn language_code(name: &str) -> String {
    let key = name.to_ascii_lowercase();
    LANGUAGES
        .iter()
        .find(|(bib, _)| *bib == key)
        .map_or_else(|| name.to_string(), |(_, code)| code.to_string())
}

/// "Title: Subtitle. Addon", each part only when present; after a part that
/// ends in punctuation only a space follows.
fn joined(
    entry: &Entry,
    title: &str,
    subtitle: &str,
    addon: &str,
    sentence_case: bool,
) -> Option<String> {
    let mut out = titled(entry, title, sentence_case)?;
    for (field, separator) in [(subtitle, ":"), (addon, ".")] {
        if let Some(part) = titled(entry, field, sentence_case) {
            if !out.ends_with(['!', '?', '.', ',', ':', ';']) {
                out.push_str(separator);
            }
            out.push(' ');
            out.push_str(&part);
        }
    }
    Some(out)
}

/// Pages, volume, edition and the `number` field, which is the issue of an
/// article, the number in a series of a book, and a plain number elsewhere.
fn numbers(entry: &Entry, csl_variables: &mut CslVariables) {
    csl_variables.set(
        "page",
        text(entry, "pages").map(|p| p.replace('\u{2013}', "-")),
    );
    let volume = text(entry, "volume");
    let part = text(entry, "part");
    csl_variables.set(
        "volume",
        match (volume, part) {
            (Some(volume), Some(part)) => Some(format!("{volume}.{part}")),
            (volume, part) => volume.or(part),
        },
    );
    csl_variables.set("number-of-volumes", text(entry, "volumes"));
    csl_variables.set("number-of-pages", text(entry, "pagetotal"));
    csl_variables.set("chapter-number", text(entry, "chapter"));
    csl_variables.set("edition", text(entry, "edition"));
    csl_variables.set("version", text(entry, "version"));
    let number = text(entry, "number");
    if is_article_like(entry) {
        let issue = text(entry, "issue");
        csl_variables.set(
            "issue",
            match (number, issue) {
                (Some(number), Some(issue)) => Some(format!("{number}, {issue}")),
                (number, _) => number,
            },
        );
    } else if is_book_like(entry) {
        csl_variables.set("collection-number", number);
    } else {
        csl_variables.set("number", number);
    }
}

/// Publisher and places. School, institution, organization, `howpublished`
/// and publisher are all the publisher, in that order; a `location` of a
/// patent is its jurisdiction.
fn publishers(entry: &Entry, csl_variables: &mut CslVariables) {
    let mut parts = Vec::new();
    for field in ["school", "institution", "organization"] {
        parts.extend(list(entry, field));
    }
    parts.extend(text(entry, "howpublished"));
    parts.extend(list(entry, "publisher"));
    csl_variables.set("publisher", (!parts.is_empty()).then(|| parts.join("; ")));
    let is_patent = entry.entry_type == EntryType::Patent;
    let address = listed(entry, "address");
    if is_patent {
        let countries: Vec<String> = list(entry, "location")
            .iter()
            .map(|place| keys_resolved(place))
            .collect();
        csl_variables.set("publisher-place", address);
        csl_variables.set(
            "jurisdiction",
            (!countries.is_empty()).then(|| countries.join("; ")),
        );
    } else {
        csl_variables.set("publisher-place", address.or(listed(entry, "location")));
    }
    csl_variables.set("original-publisher", text(entry, "origpublisher"));
    csl_variables.set("original-publisher-place", listed(entry, "origlocation"));
    csl_variables.set("event-place", text(entry, "venue"));
}

/// URL, DOI and the identifier fields, which CSL names in capitals; an
/// eprint on a known site gives the URL when the entry has none.
fn identifiers(entry: &Entry, csl_variables: &mut CslVariables) {
    // The options `url=false` and `doi=false` leave the field out, though an
    // entry written as `@online` keeps its URL, as in Pandoc.
    let online = verbatim(entry, RAW_TYPE)
        .map_or(entry.entry_type == EntryType::Online, |raw| raw == "online");
    if online || !has_option(entry, "url", "false") {
        csl_variables.set("URL", verbatim(entry, "url"));
    }
    if !csl_variables.has("URL") {
        let site = verbatim(entry, "eprinttype")
            .or_else(|| verbatim(entry, "archiveprefix"))
            .map(|s| s.to_ascii_lowercase());
        if let (Some(site), Some(id)) = (site, verbatim(entry, "eprint")) {
            if let Some((_, base)) = EPRINT_SITES.iter().find(|(name, _)| *name == site) {
                csl_variables.set("URL", Some(format!("{base}{id}")));
            }
        }
    }
    if !has_option(entry, "doi", "false") {
        csl_variables.set("DOI", verbatim(entry, "doi"));
    }
    csl_variables.set("ISBN", verbatim(entry, "isbn"));
    csl_variables.set("ISSN", verbatim(entry, "issn"));
    csl_variables.set("PMID", verbatim(entry, "pmid"));
    csl_variables.set("PMCID", verbatim(entry, "pmcid"));
    csl_variables.set("call-number", text(entry, "library"));
}

/// Note, abstract, keywords, status and language. The note of a periodical
/// is not read, as Pandoc does not read it.
fn notes(entry: &Entry, csl_variables: &mut CslVariables) {
    csl_variables.set(
        "annote",
        text(entry, "annotation").or_else(|| text(entry, "annote")),
    );
    csl_variables.set("abstract", text(entry, "abstract"));
    csl_variables.set("keyword", text(entry, "keywords"));
    let note = (entry.entry_type != EntryType::Periodical)
        .then(|| text(entry, "note"))
        .flatten();
    let addendum = text(entry, "addendum");
    csl_variables.set(
        "note",
        match (note, addendum) {
            (Some(note), Some(addendum)) => Some(joined_sentences(note, &addendum)),
            (note, addendum) => note.or(addendum),
        },
    );
    csl_variables.set("status", text(entry, "pubstate").map(|s| key_text(&s)));
    // Pandoc keeps "in press" as the literal text of the date and the style
    // prints it there; hayagriva prints no literal date, so the status says it.
    if !csl_variables.has("status") && entry.get("date").is_none() {
        if let Some(literal) = text(entry, "year") {
            let known = STATUS_TEXTS
                .iter()
                .any(|t| t.eq_ignore_ascii_case(&literal));
            csl_variables.set("status", known.then_some(literal));
        }
    }
    let language = text(entry, "langid").or_else(|| text(entry, "hyphenation"));
    csl_variables.set("language", language.map(|name| language_code(&name)));
}

/// "First. Second", with only a space when the first already ends a sentence.
fn joined_sentences(mut first: String, second: &str) -> String {
    if !first.ends_with(['!', '?', '.', ',', ':', ';']) {
        first.push('.');
    }
    first.push(' ');
    first.push_str(second);
    first
}

/// Author, editor, translator and the author of the book a chapter is in.
/// An `editortype` of director makes the editors directors.
fn names(entry: &Entry, csl_variables: &mut CslVariables) {
    let editor_variable = match text(entry, "editortype").as_deref() {
        Some("director") => "director",
        _ => "editor",
    };
    let use_prefix = has_option(entry, "useprefix", "true");
    for (field, variable) in [
        ("author", "author"),
        ("editor", editor_variable),
        ("director", "director"),
        ("translator", "translator"),
        ("bookauthor", "container-author"),
    ] {
        let Ok(persons) = entry.get_as::<Vec<biblatex::Person>>(field) else {
            continue;
        };
        let values: Vec<NameValue> = persons
            .iter()
            .map(|person| name_value(person, use_prefix))
            .collect();
        if !values.is_empty() {
            csl_variables
                .0
                .insert(variable.to_string(), Value::Names(values));
        }
    }
}

/// Whether the entry's `options` field, a comma-separated list, gives the
/// option the value; `useprefix` alone is `useprefix=true`. An option given
/// twice takes its first value, as Pandoc reads it.
fn has_option(entry: &Entry, option: &str, wanted: &str) -> bool {
    text(entry, "options").is_some_and(|options| {
        options
            .split(',')
            .find_map(|setting| {
                let mut parts = setting.splitn(2, '=');
                let key = parts.next().unwrap_or_default().trim();
                let value = parts.next().map_or("true", str::trim);
                key.eq_ignore_ascii_case(option).then_some(value)
            })
            .is_some_and(|value| value.eq_ignore_ascii_case(wanted))
    })
}

/// One name. A name the parser could not split, "{Copernicus Climate Change
/// Service}", is a literal name. A particle is a dropping particle, as
/// Pandoc takes it, unless the name or the entry's options say `useprefix`.
fn name_value(person: &biblatex::Person, use_prefix: bool) -> NameValue {
    let (particle, family) = particle_and_family(unlatex(&person.prefix), unlatex(&person.name));
    let given = unlatex(&person.given_name);
    let suffix = unlatex(&person.suffix);
    if given.is_empty()
        && particle.is_empty()
        && suffix.is_empty()
        && family.contains(char::is_whitespace)
    {
        return NameValue::Literal(LiteralName { literal: family });
    }
    let (non_dropping, dropping) = match person.use_prefix.unwrap_or(use_prefix) {
        true => (Some(particle), None),
        false => (None, Some(particle)),
    };
    NameValue::Item(NameItem {
        family,
        given: (!given.is_empty()).then(|| spaced_initials(&given)),
        non_dropping_particle: non_dropping.filter(|p| !p.is_empty()),
        dropping_particle: dropping.filter(|p| !p.is_empty()),
        suffix: (!suffix.is_empty()).then_some(suffix),
        comma_suffix: None,
    })
}

/// The particle and family name as Pandoc splits them: the particle is the
/// name's leading words whose first letter is lower case, "van ’t" in
/// "van ’t Veer" and "de" in "de Assis Guedes de Vasconcelos". The crate goes
/// by a word's first character and runs the particle to the last lower-case
/// word, as BibTeX does. A word of the family name moves only when it starts
/// with a mark, since a braced name such as "{'t Hooft}" reaches here without
/// its braces.
fn particle_and_family(particle: String, family: String) -> (String, String) {
    fn lower_case(word: &str) -> bool {
        word.chars()
            .find(|c| c.is_alphabetic())
            .is_some_and(char::is_lowercase)
    }
    let mut particle_words: Vec<&str> = particle.split_whitespace().collect();
    let leading = particle_words
        .iter()
        .take_while(|word| lower_case(word))
        .count();
    let mut family_words = particle_words.split_off(leading);
    family_words.extend(family.split(' '));
    if !particle_words.is_empty() {
        let marked = family_words[..family_words.len() - 1]
            .iter()
            .take_while(|word| !word.starts_with(char::is_alphabetic) && lower_case(word))
            .count();
        particle_words.extend(family_words.drain(..marked));
    }
    (particle_words.join(" "), family_words.join(" "))
}

/// "J.G." as "J. G.": a space after an initial's period when a capital
/// follows directly.
fn spaced_initials(given: &str) -> String {
    let mut out = String::with_capacity(given.len() + 2);
    let mut chars = given.chars().peekable();
    while let Some(c) = chars.next() {
        out.push(c);
        if c == '.' && chars.peek().is_some_and(|next| next.is_uppercase()) {
            out.push(' ');
        }
    }
    out
}

/// The date fields: `date` or year, month and day; the original, URL and
/// event dates likewise. A date that is no date keeps its text as the
/// literal, so "in press" is not lost.
fn dates(entry: &Entry, csl_variables: &mut CslVariables) {
    for (prefix, variable) in [
        ("", "issued"),
        ("orig", "original-date"),
        ("url", "accessed"),
        ("event", "event-date"),
    ] {
        let field = format!("{prefix}date");
        let year = format!("{prefix}year");
        let date = match entry.get(&field) {
            Some(chunks) => Date::parse(chunks)
                .map(Some)
                .unwrap_or_else(|_| None)
                .map(Ok)
                .unwrap_or_else(|| Err(plain(chunks))),
            None => match entry.get(&year) {
                Some(chunks) => Date::parse_three_fields(
                    chunks,
                    entry.get(&format!("{prefix}month")),
                    entry.get(&format!("{prefix}day")),
                )
                .map_err(|_| plain(chunks)),
                None => continue,
            },
        };
        let value = match date {
            Ok(date) => date_parts(&date),
            Err(literal) => DateValue::DateParts {
                date_parts: VecDateRange(Vec::new()),
                literal: Some(literal),
                season: None,
                circa: false,
            },
        };
        csl_variables
            .0
            .insert(variable.to_string(), Value::Date(value));
    }
}

/// A parsed date as CSL date parts: year, then month and day where given.
fn date_parts(date: &Date) -> DateValue {
    let parts = |d: &biblatex::Datetime| {
        let mut parts = vec![d.year as i16];
        if let Some(month) = d.month {
            // The parser counts months and days from zero, CSL from one.
            parts.push(i16::from(month) + 1);
            if let Some(day) = d.day {
                parts.push(i16::from(day) + 1);
            }
        }
        VecDate(parts)
    };
    let range = match &date.value {
        BibDate::At(d) | BibDate::After(d) | BibDate::Before(d) => vec![parts(d)],
        BibDate::Between(start, end) => vec![parts(start), parts(end)],
    };
    DateValue::DateParts {
        date_parts: VecDateRange(range),
        literal: None,
        season: None,
        circa: date.approximate || date.uncertain,
    }
}

/// A field's text, or `None` when the entry has no such field or it is empty.
fn text(entry: &Entry, field: &str) -> Option<String> {
    let value = plain(entry.get(field)?);
    (!value.is_empty()).then_some(value)
}

/// A title field's text, in sentence case when asked.
fn titled(entry: &Entry, field: &str, sentence_case: bool) -> Option<String> {
    if !sentence_case {
        return text(entry, field);
    }
    let value = unlatex(&sentence_case_of(entry.get(field)?));
    (!value.is_empty()).then_some(value)
}

/// A title in sentence case, by the rule Pandoc applies: a word is lowered
/// only when its first letter is its only capital, so "NASA", "McDonald" and
/// "iPhone" stay; the first word, and the first after a ":", "?", "!" or "."
/// that ends a word (not the one in "a:b", "http://" or "u.s"), gets a
/// capital unless it has one of its own, as "eBay", or is the title's last
/// word, as "answer" in "Why cite? answer"; a word with a digit, as
/// "A2605", stays as written; a hyphen and an apostrophe end a word; what
/// braces protect stays as written. An HTML reference to a letter is decoded
/// before casing, Pandoc keeps it as written.
fn sentence_case_of(chunks: ChunksRef) -> String {
    let mut out = String::new();
    let mut sentence_start = true;
    for (index, chunk) in chunks.iter().enumerate() {
        match &chunk.v {
            Chunk::Normal(text) => {
                let text = bibstrings_resolved(text);
                let mut word = String::new();
                let mut chars = text.chars().peekable();
                while let Some(c) = chars.next() {
                    if c == '\\' && chars.peek().is_some_and(char::is_ascii_alphabetic) {
                        flush_word(&mut word, &mut out, &mut sentence_start);
                        out.push(c);
                        out.push_str(&command_name(&mut chars));
                        continue;
                    }
                    // A tag ends a word, as in Pandoc: "Co<sub>3</sub>O" is "Co3o".
                    if c == '<' && markup_tag(&mut chars) {
                        flush_word(&mut word, &mut out, &mut sentence_start);
                        continue;
                    }
                    if c == '&' {
                        let mut ahead = chars.clone();
                        if let Some(letter) =
                            html_reference(&mut ahead).filter(|d| d.is_alphanumeric())
                        {
                            word.push(letter);
                            chars = ahead;
                            continue;
                        }
                    }
                    if c.is_alphanumeric() {
                        word.push(c);
                        continue;
                    }
                    flush_word(&mut word, &mut out, &mut sentence_start);
                    out.push(c);
                    let ends_word = chars.peek().is_none_or(|next| next.is_whitespace());
                    if matches!(c, ':' | '?' | '!' | '.')
                        && ends_word
                        && !is_last_word(chars.clone(), &chunks[index + 1..])
                    {
                        sentence_start = true;
                    }
                }
                flush_word(&mut word, &mut out, &mut sentence_start);
            }
            Chunk::Verbatim(text) => {
                out.push_str(text);
                sentence_start = false;
            }
            Chunk::Math(text) => {
                out.push(FORMULA);
                out.push_str(text);
                out.push(FORMULA);
                sentence_start = false;
            }
        }
    }
    out
}

/// Whether the rest of a title is a single word, punctuation included.
fn is_last_word(rest: std::iter::Peekable<std::str::Chars>, later: ChunksRef) -> bool {
    let later = later.iter().flat_map(|chunk| match &chunk.v {
        Chunk::Normal(text) | Chunk::Verbatim(text) | Chunk::Math(text) => text.chars(),
    });
    let rest: String = rest.chain(later).collect();
    !rest
        .trim()
        .contains(|c: char| c.is_whitespace() || WORD_SEPARATORS.contains(c))
}

/// Appends the word in its sentence-case form and clears it: capitalised at
/// a sentence start when it has no capital, lowered when its first letter is
/// its only capital, otherwise as written; a word with a digit stays as
/// written.
fn flush_word(word: &mut String, out: &mut String, sentence_start: &mut bool) {
    if word.is_empty() {
        return;
    }
    let mut chars = word.chars();
    let first_is_capital = chars.next().is_some_and(char::is_uppercase);
    let rest_keeps_case = chars.any(|c| c.is_uppercase() || c.is_numeric());
    if *sentence_start && !first_is_capital && !rest_keeps_case {
        let mut chars = word.chars();
        out.extend(chars.next().into_iter().flat_map(char::to_uppercase));
        out.extend(chars);
    } else if !*sentence_start && first_is_capital && !rest_keeps_case {
        out.push_str(&word.to_lowercase());
    } else {
        out.push_str(word);
    }
    word.clear();
    *sentence_start = false;
}

/// An identifier field as written: a URL or DOI keeps its "~" and "'".
fn verbatim(entry: &Entry, field: &str) -> Option<String> {
    let value = as_written(&entry.get(field)?.format_verbatim());
    let value = value.trim().to_string();
    (!value.is_empty()).then_some(value)
}

/// Text as the `.bib` file writes it: the marks of the reader's pre-pass
/// gone, its backslashes back.
fn as_written(text: &str) -> String {
    text.chars()
        .filter(|c| !matches!(*c, ARGUMENT_START | ARGUMENT_END))
        .collect::<String>()
        .replace(LINE_BREAK, "\\\\")
        .replace(BACKSLASH, "\\")
}

/// A field that BibLaTeX lists with `and`, as its parts.
fn list(entry: &Entry, field: &str) -> Vec<String> {
    match entry.get_as::<Vec<Chunks>>(field) {
        Ok(parts) => parts
            .iter()
            .map(|chunks| plain(chunks))
            .filter(|part| !part.is_empty())
            .collect(),
        Err(_) => text(entry, field).into_iter().collect(),
    }
}

/// A list field's parts joined with "; ", or `None` when it has none.
fn listed(entry: &Entry, field: &str) -> Option<String> {
    let parts = list(entry, field);
    (!parts.is_empty()).then(|| parts.join("; "))
}

/// Chunks as plain text: braces gone, what LaTeX writes as text resolved.
fn plain(chunks: ChunksRef) -> String {
    let marked: Vec<_> = chunks
        .iter()
        .map(|chunk| match &chunk.v {
            Chunk::Math(text) => Spanned::new(
                Chunk::Verbatim(format!("{FORMULA}{text}{FORMULA}")),
                chunk.span.clone(),
            ),
            _ => chunk.clone(),
        })
        .collect();
    unlatex(&bibstrings_resolved(&marked.format_verbatim()))
}

/// Text with TeX's conventions resolved: "--" an en dash, "---" an em dash,
/// "~" a no-break space, an escaped character the character itself, quotes
/// and apostrophes the typographic ones, a text command its argument, any
/// other command with a braced argument nothing, a command without one its
/// symbol or nothing, with the space after it, an HTML reference its
/// character, an HTML or XML tag nothing, a formula between "$" as written.
fn unlatex(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut chars = raw.chars().peekable();
    let mut closers = Vec::new();
    while let Some(c) = chars.next() {
        match c {
            '`' if chars.peek() == Some(&'`') => {
                chars.next();
                out.push('\u{201c}');
            }
            '\'' if chars.peek() == Some(&'\'') => {
                chars.next();
                out.push('\u{201d}');
            }
            '\'' => out.push('\u{2019}'),
            '`' => out.push('\u{2018}'),
            '-' if chars.peek() == Some(&'-') => {
                chars.next();
                if chars.peek() == Some(&'-') {
                    chars.next();
                    out.push('\u{2014}');
                } else {
                    out.push('\u{2013}');
                }
            }
            '~' => out.push('\u{a0}'),
            '\\' if chars.peek().is_some_and(|next| "&%$#_{}".contains(*next)) => {
                out.push(chars.next().unwrap_or_default());
            }
            '\\' if chars.peek().is_some_and(char::is_ascii_alphabetic) => {
                let name = command_name(&mut chars);
                let two = TWO_ARGUMENT_COMMANDS
                    .iter()
                    .find(|(command, ..)| *command == name);
                if let Some(&(_, second, quoted)) = two {
                    if chars.next_if_eq(&'{').is_some() {
                        out.push_str(&kept_argument(&mut chars, second, quoted));
                        continue;
                    }
                }
                let case = CASE_COMMANDS.iter().find(|(command, _)| *command == name);
                if let Some(&(_, upper)) = case {
                    if chars.next_if_eq(&'{').is_some() {
                        let text = unlatex(&argument(&mut chars, '{', '}'));
                        out.push_str(&if upper {
                            text.to_uppercase()
                        } else {
                            text.to_lowercase()
                        });
                        continue;
                    }
                }
                match TEXT_COMMANDS.iter().find(|(command, _)| *command == name) {
                    Some((_, quoted)) if chars.next_if_eq(&'{').is_some() => {
                        out.push_str(if *quoted { "\u{201c}" } else { "" });
                        closers.push(if *quoted { "\u{201d}" } else { "" });
                    }
                    None if chars.next_if_eq(&'{').is_some() => {
                        argument(&mut chars, '{', '}');
                        while chars.next_if_eq(&ARGUMENT_START).is_some() {
                            argument(&mut chars, ARGUMENT_START, ARGUMENT_END);
                        }
                    }
                    _ => {
                        if let Some((_, symbol)) =
                            SYMBOL_COMMANDS.iter().find(|(command, _)| *command == name)
                        {
                            out.push(*symbol);
                        }
                        chars.next_if_eq(&' ');
                    }
                }
            }
            '{' => {
                out.push(c);
                closers.push("}");
            }
            '}' => out.push_str(closers.pop().unwrap_or("}")),
            ARGUMENT_START | ARGUMENT_END => {}
            BACKSLASH => out.push('\\'),
            LINE_BREAK => {
                out.truncate(out.trim_end_matches(' ').len());
                out.push('\n');
            }
            '&' => out.push(html_reference(&mut chars).unwrap_or(c)),
            '<' => {
                if !markup_tag(&mut chars) {
                    out.push(c);
                }
            }
            // A formula has no text of its own: it stays as written.
            FORMULA => {
                let formula: String = chars.by_ref().take_while(|math| *math != FORMULA).collect();
                out.push('$');
                out.push_str(&as_written(&formula));
                out.push('$');
            }
            _ => out.push(c),
        }
    }
    out.trim().to_string()
}

/// The name of the LaTeX command after a "\", with the "*" of a starred form.
fn command_name(chars: &mut std::iter::Peekable<std::str::Chars>) -> String {
    std::iter::from_fn(|| chars.next_if(|c| c.is_ascii_alphabetic() || *c == '*')).collect()
}

/// The text a two-argument command prints, its "{" consumed: the first
/// argument or the marked second one, in quotation marks when asked.
fn kept_argument(
    chars: &mut std::iter::Peekable<std::str::Chars>,
    second: bool,
    quoted: bool,
) -> String {
    let first = argument(chars, '{', '}');
    let following = match chars.next_if_eq(&ARGUMENT_START) {
        Some(_) => argument(chars, ARGUMENT_START, ARGUMENT_END),
        None => String::new(),
    };
    let kept = unlatex(if second { &following } else { &first });
    if quoted {
        format!("\u{201c}{kept}\u{201d}")
    } else {
        kept
    }
}

/// Consumes an argument after its opening character, up to the closing one,
/// and returns its text.
fn argument(chars: &mut std::iter::Peekable<std::str::Chars>, open: char, close: char) -> String {
    let mut text = String::new();
    let mut depth = 0;
    while let Some(c) = chars.next() {
        match c {
            '\\' => {
                text.push(c);
                text.extend(chars.next());
                continue;
            }
            c if c == open => depth += 1,
            c if c == close && depth == 0 => break,
            c if c == close => depth -= 1,
            _ => {}
        }
        text.push(c);
    }
    text
}

/// The character of the HTML reference after a "&": "#233;", "#xE9;" or
/// "eacute;". Its characters are consumed only when they form one.
fn html_reference(chars: &mut std::iter::Peekable<std::str::Chars>) -> Option<char> {
    let mut ahead = chars.clone();
    let numeric = ahead.next_if_eq(&'#').is_some();
    let mut name = String::new();
    while let Some(c) = ahead.next_if(char::is_ascii_alphanumeric) {
        name.push(c);
    }
    ahead.next_if_eq(&';')?;
    let decoded = if numeric {
        match name.strip_prefix(['x', 'X']) {
            Some(hex) => u32::from_str_radix(hex, HEX_RADIX).ok(),
            None => name.parse().ok(),
        }
        .and_then(char::from_u32)
    } else if let Some(&(_, markup)) = MARKUP_ENTITIES.iter().find(|(entity, _)| *entity == name) {
        Some(markup)
    } else {
        let index = LATIN_1_ENTITIES.iter().position(|entity| *entity == name)?;
        char::from_u32(LATIN_1_FIRST + index as u32)
    }?;
    *chars = ahead;
    Some(decoded)
}

/// Whether an HTML or XML tag follows a "<": a name that starts with a
/// letter, after a "/" in a closing tag, then any attributes up to the ">".
/// Pandoc drops such a tag from a field and keeps the text around it. Its
/// characters are consumed only when they form one, so "p < 0.05" is text.
fn markup_tag(chars: &mut std::iter::Peekable<std::str::Chars>) -> bool {
    let mut ahead = chars.clone();
    ahead.next_if_eq(&'/');
    if ahead.next_if(char::is_ascii_alphabetic).is_none() {
        return false;
    }
    while ahead
        .next_if(|c| c.is_ascii_alphanumeric() || TAG_NAME_MARKS.contains(*c))
        .is_some()
    {}
    if ahead
        .peek()
        .is_some_and(|c| !c.is_whitespace() && !matches!(c, '/' | '>'))
    {
        return false;
    }
    loop {
        match ahead.next() {
            Some('>') => break,
            Some('<') | None => return false,
            Some(_) => {}
        }
    }
    *chars = ahead;
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(bib: &str) -> Item {
        let bibliography = biblatex::Bibliography::parse(bib).unwrap();
        item_of(bibliography.iter().next().unwrap(), true)
    }

    fn string<'a>(item: &'a Item, name: &str) -> Option<&'a str> {
        match item.0.get(name) {
            Some(Value::String(s)) => Some(s.as_str()),
            _ => None,
        }
    }

    /// Names as "family|given|non-dropping|dropping|suffix", a literal in braces.
    fn names(item: &Item, variable: &str) -> Vec<String> {
        let Some(Value::Names(names)) = item.0.get(variable) else {
            return Vec::new();
        };
        names
            .iter()
            .map(|name| match name {
                NameValue::Literal(l) => format!("{{{}}}", l.literal),
                NameValue::Item(n) => [
                    n.family.as_str(),
                    n.given.as_deref().unwrap_or_default(),
                    n.non_dropping_particle.as_deref().unwrap_or_default(),
                    n.dropping_particle.as_deref().unwrap_or_default(),
                    n.suffix.as_deref().unwrap_or_default(),
                ]
                .join("|"),
            })
            .collect()
    }

    /// A date as its parts and its literal: "[[2019, 3]] in press".
    fn date(item: &Item, variable: &str) -> String {
        match item.0.get(variable) {
            Some(Value::Date(DateValue::DateParts {
                date_parts,
                literal,
                ..
            })) => {
                let parts: Vec<&Vec<i16>> = date_parts.0.iter().map(|d| &d.0).collect();
                format!("{parts:?} {}", literal.as_deref().unwrap_or_default())
            }
            _ => String::from("none"),
        }
    }

    #[test]
    fn an_article_is_an_article_with_an_issue() {
        let item = item(
            "@article{doe2020, author={Doe, Jane and Roe, Richard}, title={A Study}, \
             subtitle={Of Lists}, journal={J. Stud.}, year={2020}, volume={3}, number={2}, \
             pages={1--9}, doi={10.1000/x}}",
        );
        assert_eq!(string(&item, "id"), Some("doe2020"));
        assert_eq!(string(&item, "type"), Some("article-journal"));
        assert_eq!(string(&item, "title"), Some("A study: Of lists"));
        assert_eq!(string(&item, "title-short"), Some("A study"));
        assert_eq!(string(&item, "container-title"), Some("J. Stud."));
        assert_eq!(string(&item, "volume"), Some("3"));
        assert_eq!(string(&item, "issue"), Some("2"));
        assert_eq!(string(&item, "page"), Some("1-9"));
        assert_eq!(string(&item, "DOI"), Some("10.1000/x"));
        assert_eq!(names(&item, "author"), ["Doe|Jane|||", "Roe|Richard|||"]);
        assert_eq!(date(&item, "issued"), "[[2020]] ");
    }

    #[test]
    fn entry_types_map_as_pandoc_maps_them() {
        let cases = [
            ("@book{k, title={T}}", Some("book")),
            ("@inproceedings{k, title={T}}", Some("paper-conference")),
            ("@incollection{k, title={T}}", Some("chapter")),
            ("@phdthesis{k, title={T}}", Some("thesis")),
            ("@techreport{k, title={T}}", Some("report")),
            ("@online{k, title={T}}", Some("webpage")),
            ("@electronic{k, title={T}}", Some("webpage")),
            ("@unpublished{k, title={T}}", Some("manuscript")),
            ("@unpublished{k, title={T}, eventtitle={E}}", Some("speech")),
            (
                "@article{k, title={T}, entrysubtype={newspaper}}",
                Some("article-newspaper"),
            ),
            ("@misc{k, title={T}}", None),
            ("@whatever{k, title={T}}", None),
        ];
        for (bib, expected) in cases {
            assert_eq!(string(&item(bib), "type"), expected, "{bib}");
        }
    }

    #[test]
    fn a_thesis_and_a_report_keep_their_institution_and_genre() {
        let thesis = item("@phdthesis{k, title={T}, school={MIT}, year={2001}}");
        assert_eq!(string(&thesis, "publisher"), Some("MIT"));
        assert_eq!(string(&thesis, "genre"), Some("PhD thesis"));
        let masters = item("@mastersthesis{k, title={T}, type={mathesis}}");
        assert_eq!(string(&masters, "genre"), Some("Master's thesis"));
        let report = item(
            "@techreport{k, title={T}, institution={NASA}, number={TR-7}, type={Technical Memo}}",
        );
        assert_eq!(string(&report, "publisher"), Some("NASA"));
        assert_eq!(string(&report, "number"), Some("TR-7"));
        assert_eq!(string(&report, "genre"), Some("Technical Memo"));
        let book = item("@book{k, title={T}, series={S}, number={4}, publisher={A and B}}");
        assert_eq!(string(&book, "collection-number"), Some("4"));
        assert_eq!(string(&book, "publisher"), Some("A; B"));
    }

    #[test]
    fn in_press_is_a_status_and_a_literal_date() {
        let pubstate = item("@article{k, title={T}, pubstate={inpress}, journal={J}}");
        assert_eq!(string(&pubstate, "status"), Some("in press"));
        assert!(!pubstate.0.contains_key("issued"));
        let year = item("@article{k, title={T}, year={in press}, journal={J}}");
        assert_eq!(date(&year, "issued"), "[] in press");
        assert_eq!(string(&year, "status"), Some("in press"));
        let odd = item("@article{k, title={T}, year={soon}, journal={J}}");
        assert_eq!(date(&odd, "issued"), "[] soon");
        assert_eq!(string(&odd, "status"), None);
    }

    #[test]
    fn dates_come_from_date_or_year_month_day_with_ranges_and_origdate() {
        let full = item("@misc{k, title={T}, year={2019}, month={mar}, day={4}}");
        assert_eq!(date(&full, "issued"), "[[2019, 3, 4]] ");
        let range = item(
            "@misc{k, title={T}, date={2019-03/2020-01}, origdate={1905}, urldate={2021-05-06}}",
        );
        assert_eq!(date(&range, "issued"), "[[2019, 3], [2020, 1]] ");
        assert_eq!(date(&range, "original-date"), "[[1905]] ");
        assert_eq!(date(&range, "accessed"), "[[2021, 5, 6]] ");
    }

    #[test]
    fn names_have_particles_literals_suffixes_and_spaced_initials() {
        let item = item(
            "@misc{k, title={T}, author={van der Berg, Ludwig and {Copernicus Climate Change Service} \
             and Smith, Jr., J.G. and Plato}, editor={Doe, Jane}, editortype={director}}",
        );
        assert_eq!(
            names(&item, "author"),
            [
                "Berg|Ludwig||van der|",
                "{Copernicus Climate Change Service}",
                "Smith|J. G.|||Jr.",
                "Plato||||",
            ]
        );
        assert_eq!(names(&item, "director"), ["Doe|Jane|||"]);
        assert!(names(&item, "editor").is_empty());
    }

    #[test]
    fn a_particle_word_is_known_by_its_first_letter() {
        let item = item(
            "@misc{k, title={T}, author={van 't Veer, Anna and van 't de Veer, B \
             and de {la Cruz}, J and {'t Hooft}, G and de Assis Guedes de Vasconcelos, F. \
             and de la Rue du Can, S.}}",
        );
        assert_eq!(
            names(&item, "author"),
            [
                "Veer|Anna||van \u{2019}t|",
                "Veer|B||van \u{2019}t de|",
                "la Cruz|J||de|",
                "\u{2019}t Hooft|G|||",
                "Assis Guedes de Vasconcelos|F.||de|",
                "Rue du Can|S.||de la|",
            ]
        );
    }

    #[test]
    fn a_single_backtick_is_an_opening_quote() {
        let item = item("@misc{k, title={`Quoted' Word}, author={O`Loughlin, Fiachra}}");
        assert_eq!(string(&item, "title"), Some("\u{2018}Quoted\u{2019} word"));
        assert_eq!(names(&item, "author"), ["O\u{2018}Loughlin|Fiachra|||"]);
    }

    #[test]
    fn a_useprefix_particle_is_non_dropping() {
        let item = item(
            "@misc{k, title={T}, author={family=Berg, given=Ludwig, prefix=van der, useprefix=true}}",
        );
        assert_eq!(names(&item, "author"), ["Berg|Ludwig|van der||"]);
    }

    #[test]
    fn a_web_page_keeps_its_site_and_an_eprint_gives_a_url() {
        // BibLaTeX lists `organization` with "and"; braces keep a name whole.
        let page = item(
            "@online{k, title={T}, organization={{Hyperbole and a Half}}, url={https://x.org}}",
        );
        assert_eq!(string(&page, "publisher"), Some("Hyperbole and a Half"));
        assert_eq!(string(&page, "URL"), Some("https://x.org"));
        let arxiv = item("@misc{k, title={T}, eprint={2101.00001}, eprinttype={arXiv}}");
        assert_eq!(
            string(&arxiv, "URL"),
            Some("https://arxiv.org/abs/2101.00001")
        );
        let magazine = item(
            "@article{k, title={T}, entrysubtype={magazine}, note={N}, addendum={A}, \
             langid={german}, keywords={a, b}}",
        );
        assert_eq!(string(&magazine, "type"), Some("article-magazine"));
        assert_eq!(string(&magazine, "note"), Some("N. A"));
        assert_eq!(string(&magazine, "language"), Some("de-DE"));
        assert_eq!(string(&magazine, "keyword"), Some("a, b"));
    }

    #[test]
    fn a_chapter_has_its_book_as_container_once() {
        let chapter = item(
            "@incollection{k, title={T}, booktitle={Bioinformatics}, bookauthor={Doe, Jane}, \
             publisher={P}, address={Berlin}, chapter={3}, edition={2}}",
        );
        assert_eq!(string(&chapter, "container-title"), Some("Bioinformatics"));
        assert_eq!(string(&chapter, "publisher-place"), Some("Berlin"));
        assert_eq!(string(&chapter, "chapter-number"), Some("3"));
        assert_eq!(string(&chapter, "edition"), Some("2"));
        assert_eq!(names(&chapter, "container-author"), ["Doe|Jane|||"]);
        let volume = item("@book{k, title={Vol. 2}, maintitle={Collected Works}, volume={2}}");
        assert_eq!(string(&volume, "title"), Some("Collected works"));
        assert_eq!(string(&volume, "volume-title"), Some("Vol. 2"));
    }

    #[test]
    fn a_chapter_of_a_multi_volume_work_is_in_its_main_title() {
        let chapter = item(
            "@incollection{k, title={The Chapter}, booktitle={The Book Title}, \
             maintitle={Collected Works}, mainsubtitle={A Critical Edition}, volume={3}}",
        );
        assert_eq!(
            string(&chapter, "container-title"),
            Some("Collected works: A critical edition")
        );
        assert_eq!(string(&chapter, "volume-title"), Some("The book title"));
        assert_eq!(string(&chapter, "volume"), Some("3"));
        let volume = item(
            "@book{k, title={The Volume}, maintitle={Collected Works}, \
             mainsubtitle={A Critical Edition}, volume={3}}",
        );
        assert_eq!(
            string(&volume, "title"),
            Some("Collected works: A critical edition")
        );
        assert_eq!(string(&volume, "volume-title"), Some("The volume"));
        assert_eq!(string(&volume, "container-title"), None);
    }

    #[test]
    fn latex_conventions_become_text() {
        let item = item(
            "@misc{k, title={Caf\\'e {NASA} --- a tale, 1--2 \\& more~here}, author={M\\\"uller, Hans}}",
        );
        assert_eq!(
            string(&item, "title"),
            Some("Café NASA \u{2014} a tale, 1\u{2013}2 & more\u{a0}here")
        );
        assert_eq!(names(&item, "author"), ["Müller|Hans|||"]);
    }

    #[test]
    fn text_commands_print_their_argument_and_quoting_commands_quote_it() {
        let cases = [
            ("\\emph{De Anima} \\textsc{mcxcviii}", "De Anima mcxcviii"),
            ("\\textit{I} \\textbf{B} \\url{x.org}", "I B x.org"),
            ("\\mkbibquote{De} \\enquote*{A--B}", "“De” “A–B”"),
            ("\\emph{A \\foo{x} \\enquote{B}} C", "A  “B” C"),
        ];
        for (title, expected) in cases {
            let entry = item(&format!("@book{{k, title={{{title}}}, langid={{german}}}}"));
            assert_eq!(string(&entry, "title"), Some(expected), "{title}");
        }
        let english = item("@book{k, title={\\emph{the Title} Rest}}");
        assert_eq!(string(&english, "title"), Some("The title rest"));
    }

    #[test]
    fn an_unknown_command_with_an_argument_prints_nothing() {
        let entry =
            item(r"@misc{k, title={T}, note={A \foo{a{b}c} \href{u}{x} \textsl{y} \sout{z} B}}");
        assert_eq!(string(&entry, "note"), Some("A  x y z B"));
    }

    #[test]
    fn a_command_without_an_argument_prints_nothing_with_the_space_after_it() {
        let entry =
            item(r"@misc{k, title={T}, note={A \foo B \protect C \relax D \foo* E\addcomma F}}");
        assert_eq!(string(&entry, "note"), Some("A B C D EF"));
        let entry = item(r"@misc{k, title={T}, note={\em text \it B \bf C \sc D}}");
        assert_eq!(string(&entry, "note"), Some("text B C D"));
    }

    #[test]
    fn a_case_command_changes_the_case_of_its_argument() {
        let entry = item(
            r#"@book{k, title={The \MakeUppercase{nasa} Rocket and \lowercase{NASA Now} End},
            note={\uppercase{x Ab} \MakeLowercase{X Ab} \uppercase{a \emph{b} {c}} \uppercase{straße}
            \lowercase{\"{O}}}}"#,
        );
        assert_eq!(
            string(&entry, "title"),
            Some("The NASA rocket and nasa now end")
        );
        assert_eq!(string(&entry, "note"), Some("X AB x ab A B C STRASSE ö"));
    }

    #[test]
    fn a_declaration_before_a_group_prints_the_group() {
        let entry = item(r"@misc{k, title={T}, note={A \em{x} \ttfamily{y} \sf{z} B}}");
        assert_eq!(string(&entry, "note"), Some("A x y  B"));
    }

    #[test]
    fn a_symbol_command_prints_its_character() {
        let entry = item(r"@misc{k, title={T}, note={A\slash B\hyphen C\ldots D\space E}}");
        assert_eq!(string(&entry, "note"), Some("A/B-C\u{2026}DE"));
    }

    #[test]
    fn a_text_command_with_a_space_before_its_argument_prints_the_argument() {
        let entry = item(r"@misc{k, title={T}, note={A \emph {x} B}}");
        assert_eq!(string(&entry, "note"), Some("A x B"));
    }

    #[test]
    fn html_character_references_become_characters_and_a_bare_ampersand_stays() {
        let item =
            item("@book{k, publisher={Soci&#233;t&#xE9; &Eacute;d. &amp; R&D, AT&T; &x; \\& Co}}");
        let expected = "Société Éd. & R&D, AT&T; &x; & Co";
        assert_eq!(string(&item, "publisher"), Some(expected));
    }

    #[test]
    fn a_markup_tag_prints_its_text_and_ends_a_word() {
        let item = item(
            "@article{k, title={<i>Nipah Virus</i>: Co<sub>3</sub>O<sub>4</sub> and <scp>Lif</scp>},
            note={<em>e</em> <foo a=\"1\">x</foo> a<br/>b
            <mml:math xmlns:mml=“http://www.w3.org/1998/Math/MathML”><mml:mi>PbMoO</mml:mi><mml:mn>3</mml:mn></mml:math>
            p < 0.05, a < b > c, <3 <i}}",
        );
        assert_eq!(string(&item, "title"), Some("Nipah virus: Co3o4 and lif"));
        let note = "e x ab PbMoO3 p < 0.05, a < b > c, <3 <i";
        assert_eq!(string(&item, "note"), Some(note));
    }

    #[test]
    fn a_formula_stays_as_written() {
        let bib = r"@article{k, title={Canonical $\mathbf{Q}$-Fano 3-Folds},
            note={A $\alpha^2 -- x~y$ and $$\sqrt{x_1}$$ cost \$5 -- {$\emph{z}$}}}";
        let item = item_of(&entries(bib).unwrap()[0], true);
        let title = r"Canonical $\mathbf{Q}$-fano 3-folds";
        assert_eq!(string(&item, "title"), Some(title));
        let note = "A $\\alpha^2 -- x~y$ and $$\\sqrt{x_1}$$ cost $5 \u{2013} $\\emph{z}$";
        assert_eq!(string(&item, "note"), Some(note));
    }

    #[test]
    fn english_titles_go_to_sentence_case_and_braces_protect() {
        let english = item(
            "@incollection{k, title={The Alot Is Better Than {You} at Everything}, \
             booktitle={Collected {NASA} Posts}, series={Great Series}}",
        );
        assert_eq!(
            string(&english, "title"),
            Some("The alot is better than You at everything")
        );
        assert_eq!(
            string(&english, "container-title"),
            Some("Collected NASA posts")
        );
        assert_eq!(string(&english, "collection-title"), Some("Great series"));
        let german = item("@book{k, title={Die Welt Als Wille}, langid={german}}");
        assert_eq!(string(&german, "title"), Some("Die Welt Als Wille"));
        let bibliography =
            biblatex::Bibliography::parse("@book{k, title={Die Welt Als Wille}}").unwrap();
        let in_german_document = item_of(bibliography.iter().next().unwrap(), false);
        assert_eq!(
            string(&in_german_document, "title"),
            Some("Die Welt Als Wille")
        );
        let article = item("@article{k, title={T}, journal={Journal of Studies}}");
        assert_eq!(
            string(&article, "container-title"),
            Some("Journal of Studies")
        );
    }

    #[test]
    fn list_fields_join_their_parts_with_a_semicolon() {
        let book = item(
            "@book{k, title={T}, location={Durham and London}, origlocation={A and B}, \
             publisher={P1 and {{P2 and P3}}}}",
        );
        assert_eq!(string(&book, "publisher-place"), Some("Durham; London"));
        assert_eq!(string(&book, "original-publisher-place"), Some("A; B"));
        assert_eq!(string(&book, "publisher"), Some("P1; P2 and P3"));
        let addressed = item("@book{k, title={T}, address={A1 and A2}, location={L}}");
        assert_eq!(string(&addressed, "publisher-place"), Some("A1; A2"));
    }

    #[test]
    fn a_numbered_series_is_an_ordinal_series() {
        let cases = [
            ("1", "1st series"),
            ("2", "2nd series"),
            ("3", "3rd series"),
            ("4", "4th series"),
            ("11", "11th series"),
            ("12", "12th series"),
            ("13", "13th series"),
            ("21", "21st series"),
            ("Quarterly", "Quarterly"),
        ];
        for (series, expected) in cases {
            let article = item(&format!(
                "@article{{k, title={{T}}, journaltitle={{J}}, series={{{series}}}}}"
            ));
            assert_eq!(string(&article, "collection-title"), Some(expected));
        }
    }

    #[test]
    fn a_key_in_the_series_prints_its_text_before_sentence_case() {
        let cases = [
            ("series={newseries}", "New series"),
            ("series={Studies: newseries}", "Studies: New series"),
            ("series={newseries, Studies}", "Newseries, studies"),
            ("series={{newseries}}", "newseries"),
            (
                "series={Studies newseries}, langid={german}",
                "Studies new series",
            ),
        ];
        for (fields, expected) in cases {
            let book = item(&format!("@book{{k, title={{T}}, {fields}}}"));
            assert_eq!(string(&book, "collection-title"), Some(expected));
        }
    }

    #[test]
    fn a_short_title_is_the_part_before_the_colon() {
        let colon = item("@book{k, title={Molecular Cloning: A Laboratory Manual}}");
        assert_eq!(
            string(&colon, "title"),
            Some("Molecular cloning: A laboratory manual")
        );
        assert_eq!(string(&colon, "title-short"), Some("Molecular cloning"));
        let plain = item("@book{k, title={No Colon Here}}");
        assert_eq!(string(&plain, "title-short"), None);
        let chapter = "@inbook{k, title={Chapter}, subtitle={Sub}, booktitle={B}";
        let alone = item(&format!("{chapter}}}"));
        assert_eq!(string(&alone, "title-short"), Some("Chapter"));
        let in_volume = item(&format!("{chapter}, maintitle={{M}}}}"));
        assert_eq!(string(&in_volume, "title-short"), None);
    }

    #[test]
    fn a_periodical_is_an_issue_of_the_journal_its_title_names() {
        let issue = item(
            "@periodical{k, title={Computers and Graphics}, \
             issuetitle={Semantic {3D} Media}, issuesubtitle={A Survey}}",
        );
        assert_eq!(string(&issue, "type"), Some("article-journal"));
        assert_eq!(string(&issue, "title"), Some("Semantic 3D media: A survey"));
        assert_eq!(
            string(&issue, "container-title"),
            Some("Computers and Graphics")
        );
        assert_eq!(
            string(&issue, "title-short"),
            Some("Computers and graphics")
        );
        let journal = item("@periodical{k, title={Computers and Graphics}, shorttitle={CaG}}");
        assert_eq!(string(&journal, "title"), Some("Computers and graphics"));
        assert_eq!(
            string(&journal, "container-title"),
            Some("Computers and Graphics")
        );
        assert_eq!(string(&journal, "container-title-short"), Some("CaG"));
    }

    #[test]
    fn the_entry_options_set_useprefix_for_every_name() {
        let on =
            item("@misc{k, title={T}, author={van Dijk, Dirk}, options={doi=false, useprefix}}");
        assert_eq!(names(&on, "author"), ["Dijk|Dirk|van||"]);
        let off = item("@misc{k, title={T}, author={van Dijk, Dirk}, options={useprefix=false}}");
        assert_eq!(names(&off, "author"), ["Dijk|Dirk||van|"]);
    }

    #[test]
    fn an_option_given_twice_takes_its_first_value() {
        let fields = "title={T}, url={http://u}, doi={1/2}, author={van Dijk, Dirk}";
        let first_on = item(&format!(
            "@article{{k, {fields}, options={{doi=true, doi=false, useprefix, useprefix=false}}}}"
        ));
        assert_eq!(string(&first_on, "DOI"), Some("1/2"));
        assert_eq!(names(&first_on, "author"), ["Dijk|Dirk|van||"]);
        let first_off = item(&format!(
            "@article{{k, {fields}, options={{url=false, url=true}}}}"
        ));
        assert_eq!(string(&first_off, "URL"), None);
    }

    #[test]
    fn the_entry_options_url_false_and_doi_false_leave_the_field_out() {
        let fields = "title={T}, url={http://u}, doi={1/2}";
        let doi_off = item(&format!("@article{{k, {fields}, options={{doi=false}}}}"));
        assert_eq!(string(&doi_off, "DOI"), None);
        assert_eq!(string(&doi_off, "URL"), Some("http://u"));
        let url_off = item(&format!(
            "@article{{k, {fields}, options={{ URL = False }}}}"
        ));
        assert_eq!(string(&url_off, "URL"), None);
        assert_eq!(string(&url_off, "DOI"), Some("1/2"));
        let plain = item(&format!(
            "@article{{k, {fields}, options={{doi, url=true}}}}"
        ));
        assert_eq!(string(&plain, "URL"), Some("http://u"));
        assert_eq!(string(&plain, "DOI"), Some("1/2"));
        let online = item(&format!("@online{{k, {fields}, options={{url=false}}}}"));
        assert_eq!(string(&online, "URL"), Some("http://u"));
    }

    #[test]
    fn apostrophes_and_quotes_turn_typographic_but_identifiers_stay() {
        let item = item(
            "@misc{k, title={Shin'ya's ``Quoted'' Words}, author={Shin'ya, Ono}, \
             url={https://x.org/~me/it's}, doi={10.1/a'b}}",
        );
        assert_eq!(
            string(&item, "title"),
            Some("Shin\u{2019}ya\u{2019}s \u{201c}quoted\u{201d} words")
        );
        assert_eq!(names(&item, "author"), ["Shin\u{2019}ya|Ono|||"]);
        assert_eq!(string(&item, "URL"), Some("https://x.org/~me/it's"));
        assert_eq!(string(&item, "DOI"), Some("10.1/a'b"));
    }

    #[test]
    fn sentence_case_lowers_only_words_with_a_single_leading_capital() {
        let cases = [
            (
                "DNA Repair and the NASA Archive",
                "DNA repair and the NASA archive",
            ),
            ("COVID-19 and the Lab", "COVID-19 and the lab"),
            ("Study of A2605 Cells", "Study of A2605 cells"),
            ("a2605 study", "a2605 study"),
            ("Study of Li–O2 Batteries", "Study of li–O2 batteries"),
            ("Model T-1000 Fails", "Model t-1000 fails"),
            ("CO2 Capture of R2d2 and A1b", "CO2 capture of R2d2 and A1b"),
            ("World War II Records", "World war II records"),
            (
                "iPhone Apps and McDonald Stories",
                "iPhone apps and McDonald stories",
            ),
            ("eBay Markets", "eBay markets"),
            ("&#233;cole Normale Today", "\u{c9}cole normale today"),
            (
                "The &Ouml;BB and R&amp;amp;D Map",
                "The \u{d6}BB and r&amp;d map",
            ),
            ("Why Cite? A Short Answer", "Why cite? A short answer"),
            ("Why Cite? answer", "Why cite? answer"),
            ("Report: Second", "Report: second"),
            ("The U.S. Treasury", "The u.s. treasury"),
            ("Why? (Answer).", "Why? (answer)."),
            ("Why? Answer.Here", "Why? answer.here"),
            ("Why? Answer-Here {X}", "Why? Answer-here X"),
            ("Report: Second Part", "Report: Second part"),
            ("answer", "Answer"),
            ("report. second part", "Report. Second part"),
            (
                "O'Brien and Children's Books",
                "O\u{2019}brien and children\u{2019}s books",
            ),
            (
                "'twas Don't L\u{2019}Enfant Aristotle's Ethics",
                "\u{2019}Twas don\u{2019}t l\u{2019}enfant aristotle\u{2019}s ethics",
            ),
            ("Why? O'Brien", "Why? o\u{2019}brien"),
            ("the u.s. treasury report", "The u.s. Treasury report"),
            ("Apples vs. the Oranges here", "Apples vs. The oranges here"),
            (
                "Report.second... (third) part",
                "Report.second... (Third) part",
            ),
            (
                "Molecular cloning: a laboratory manual",
                "Molecular cloning: A laboratory manual",
            ),
            ("molecular cloning", "Molecular cloning"),
            (
                "Long-Term Effects of Self-Citation",
                "Long-term effects of self-citation",
            ),
            ("Walking in {London} Today", "Walking in London today"),
            ("A Study of I and You", "A study of i and you"),
            (
                "Ratio a:b and http://x.org: The End",
                "Ratio a:b and http://x.org: The end",
            ),
            ("Tags <mml:Mi>A</mml:Mi> Here", "Tags a here"),
        ];
        for (title, expected) in cases {
            let entry = item(&format!("@book{{k, title={{{title}}}}}"));
            assert_eq!(string(&entry, "title"), Some(expected), "{title}");
        }
    }

    #[test]
    fn localisation_keys_print_their_english_text() {
        let patent = item("@patent{p, title={T}, location={Near countryfr}, type={patenteu}}");
        assert_eq!(string(&patent, "jurisdiction"), Some("Near France"));
        assert_eq!(string(&patent, "genre"), Some("European patent"));
        let patent = item("@patent{p, title={T}, location={countryfr and countryuk and Spain}}");
        let countries = "France; United Kingdom; Spain";
        assert_eq!(string(&patent, "jurisdiction"), Some(countries));
        let book = item(
            r"@book{b, title={The Title: \bibstring{newseries}},
              note={In \bibstring{countryuk}}, location={countryfr}}",
        );
        assert_eq!(string(&book, "title"), Some("The title: New series"));
        assert_eq!(string(&book, "note"), Some("In United Kingdom"));
        assert_eq!(string(&book, "publisher-place"), Some("countryfr"));
    }

    #[test]
    fn a_localisation_key_matches_only_in_lower_case() {
        let patent = item(
            r"@patent{p, title={T}, type={PatentEU}, location={countryDE and countryde},
              pubstate={InPress}, note={\bibstring{InPress}}}",
        );
        assert_eq!(string(&patent, "genre"), Some("PatentEU"));
        assert_eq!(string(&patent, "jurisdiction"), Some("countryDE; Germany"));
        assert_eq!(string(&patent, "status"), Some("InPress"));
        assert_eq!(string(&patent, "note"), Some("InPress"));
    }

    #[test]
    fn a_crossref_child_takes_the_fields_it_lacks_from_its_parent() {
        let entries = entries(
            "@inbook{part, crossref={whole}, title={Part}, publisher={Own}} \
             @book{whole, title={Whole}, publisher={Pub}, location={Here}, date={1970}}",
        )
        .unwrap();
        let part = item_of(&entries[0], true);
        assert_eq!(string(&part, "title"), Some("Part"));
        assert_eq!(string(&part, "container-title"), Some("Whole"));
        assert_eq!(string(&part, "publisher"), Some("Own"));
        assert_eq!(string(&part, "publisher-place"), Some("Here"));
        assert_eq!(date(&part, "issued"), "[[1970]] ");
    }

    #[test]
    fn a_crossref_chain_gives_the_nearest_parents_date() {
        let entries = entries(
            "@inbook{part, crossref={volume}, title={Part}} \
             @book{volume, crossref={set}, title={Volume}, date={1975}} \
             @mvbook{set, title={Set}, publisher={Pub}, date={1970/1980}}",
        )
        .unwrap();
        let part = item_of(&entries[0], true);
        assert_eq!(date(&part, "issued"), "[[1975]] ");
        assert_eq!(string(&part, "publisher"), Some("Pub"));
        assert_eq!(date(&item_of(&entries[1], true), "issued"), "[[1975]] ");
    }

    #[test]
    fn a_part_of_a_book_takes_the_books_author_as_container_author() {
        let entries = entries(
            "@inbook{part, crossref={whole}, title={Part}} \
             @inbook{own, crossref={whole}, author={Roe, Richard}, title={Own}} \
             @book{whole, author={Doe, Jane}, title={Whole}}",
        )
        .unwrap();
        let part = item_of(&entries[0], true);
        assert_eq!(names(&part, "author"), ["Doe|Jane|||"]);
        assert_eq!(names(&part, "container-author"), ["Doe|Jane|||"]);
        let own = item_of(&entries[1], true);
        assert_eq!(names(&own, "author"), ["Roe|Richard|||"]);
        assert_eq!(names(&own, "container-author"), ["Doe|Jane|||"]);
    }

    #[test]
    fn a_crossref_with_several_keys_takes_from_each_and_the_later_entry_wins() {
        let entries = entries(
            "@inbook{part, crossref={a, b}, title={Part}} \
             @book{b, title={B}, location={There}} \
             @book{a, title={A}, publisher={Pub}}",
        )
        .unwrap();
        let part = item_of(&entries[0], true);
        assert_eq!(string(&part, "container-title"), Some("A"));
        assert_eq!(string(&part, "publisher"), Some("Pub"));
        assert_eq!(string(&part, "publisher-place"), Some("There"));
    }

    #[test]
    fn an_xdata_field_wins_over_a_crossref_one_and_xdata_entries_are_dropped() {
        let entries = entries(
            "@inbook{part, xdata={x2, x1}, crossref={whole}, title={Part}, location={Own}, \
             date={1999}} \
             @book{whole, title={Whole}, publisher={Whole pub}, date={1980}} \
             @xdata{x1, publisher={X1 pub}, note={X1 note}, date={2001}} \
             @xdata{x2, note={X2 note}, xdata={x3}} \
             @xdata{x3, edition={3}, note={X3 note}}",
        )
        .unwrap();
        assert_eq!(entries.len(), 2);
        let part = item_of(&entries[0], true);
        assert_eq!(string(&part, "container-title"), Some("Whole"));
        assert_eq!(string(&part, "publisher"), Some("X1 pub"));
        assert_eq!(string(&part, "publisher-place"), Some("Own"));
        assert_eq!(string(&part, "note"), Some("X2 note"));
        assert_eq!(string(&part, "edition"), Some("3"));
        assert_eq!(date(&part, "issued"), "[[1999]] ");
    }

    #[test]
    fn only_an_entry_written_as_online_keeps_its_url_under_url_false() {
        let entries = entries(
            "@ONLINE{on, url={http://on}, options={url=false}} \
             @www{www, url={http://www}, options={url=false}} \
             @electronic{el, url={http://el}, options={url=false}}",
        )
        .unwrap();
        let urls: Vec<bool> = entries
            .iter()
            .map(|entry| string(&item_of(entry, true), "URL").is_some())
            .collect();
        assert_eq!(urls, [true, false, false]);
    }
}
