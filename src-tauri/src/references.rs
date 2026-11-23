//! Reading the references a document names in its header.
//!
//! The editor offers them after `@` and shows one on hover, so what leaves
//! this module is a short summary per entry, the same for every source format.

use crate::biblatex_csl;
use hayagriva::citationberg::json::{DateValue, FixedDateRange, Item, NameValue, Value};
use std::collections::HashSet;
use std::fs;
use std::path::{Component, Path, PathBuf};

/// One reference, as the editor lists it.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
pub struct ReferenceSummary {
    /// The citation key, the part after `@`.
    pub key: String,
    /// Family name first ("Doe, Jane"); an institution has only its name.
    pub authors: Vec<String>,
    pub year: Option<i32>,
    pub title: String,
    pub format: ReferenceFormat,
}

/// What a reference was read from; the editor's summary says it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ReferenceFormat {
    /// A `.bib` file.
    Bib,
    /// CSL data: a JSON or YAML file, or the header's `references:` list.
    Csl,
}

/// The entries a source gave, and a warning for each entry it had to skip.
#[derive(Clone, Debug, Default, PartialEq, Eq, serde::Serialize)]
pub struct References {
    pub entries: Vec<ReferenceSummary>,
    pub warnings: Vec<String>,
}

/// A reference as a CSL item, whatever it was read from: JSON and YAML hold
/// items, a `.bib` entry converts to one (biblatex_csl).
#[derive(Clone, Debug)]
pub struct Reference {
    pub item: Item,
    pub format: ReferenceFormat,
}

impl Reference {
    /// The citation key, the item's `id`.
    pub fn key(&self) -> String {
        self.item.id().unwrap_or_default().into_owned()
    }

    pub fn summary(&self) -> ReferenceSummary {
        summarize_item(&self.key(), &self.item, self.format)
    }
}

/// What a source gave in full: the references, and a warning per skipped entry.
#[derive(Clone, Debug, Default)]
pub struct Read {
    pub references: Vec<Reference>,
    pub warnings: Vec<String>,
}

impl Read {
    /// The editor's view of it: summaries only.
    pub fn summaries(self) -> References {
        References {
            entries: self.references.iter().map(Reference::summary).collect(),
            warnings: self.warnings,
        }
    }
}

/// The entries of a `.bib` file, in file order.
///
/// The parser reads a file as a whole and refuses all of it over one entry it
/// cannot take. Real files have such entries (Crossref exports `month = July`
/// and repeats keys), and an editor is better served by the rest of the
/// library. So the file is then read entry by entry: what parses is kept,
/// and each entry skipped gives a warning with its line.
pub fn references_from_biblatex(text: &str) -> References {
    read_biblatex(text, true).summaries()
}

/// The `.bib` file's entries in full, see references_from_biblatex.
pub fn read_biblatex(text: &str, english_document: bool) -> Read {
    // A byte-order mark is no whitespace: left in, it hides the first entry
    // from the cut at every `@`.
    let text = text.trim_start_matches('\u{feff}');
    let text = &mark_backslashes(&brace_quoted_values(text));
    let text = &mark_following_arguments(&join_command_arguments(text));
    if let Ok(entries) = biblatex_csl::entries(text) {
        let items = entries
            .iter()
            .map(|entry| biblatex_csl::item_of(entry, english_document))
            .collect();
        return collect_items(items, ReferenceFormat::Bib);
    }
    // Entry by entry, each as it reads on its own; then the entries kept are
    // read together, so that crossref and xdata find their parents.
    let mut warnings = Vec::new();
    let mut definitions = String::new();
    let mut keys = HashSet::new();
    let mut kept = String::new();
    for (line, chunk) in entry_chunks(text) {
        let Some((read, chunk_keys)) = parse_chunk(chunk, line, &mut definitions, &mut warnings)
        else {
            continue;
        };
        // An abbreviation defined here serves the entries after it.
        let is_string = chunk
            .trim_start()
            .strip_prefix('@')
            .is_some_and(|rest| rest.trim_start().to_ascii_lowercase().starts_with("string"));
        if is_string {
            definitions.push_str(chunk);
            definitions.push('\n');
            continue;
        }
        if let Some(key) = chunk_keys.iter().find(|key| keys.contains(*key)) {
            warnings.push(format!("line {line}: {}", used_again(key)));
            continue;
        }
        keys.extend(chunk_keys);
        kept.push_str(&read);
        kept.push('\n');
    }
    kept.push_str(&definitions);
    let mut found = match biblatex_csl::entries(&kept) {
        Ok(entries) => {
            let items = entries
                .iter()
                .map(|entry| biblatex_csl::item_of(entry, english_document))
                .collect();
            collect_items(items, ReferenceFormat::Bib)
        }
        Err(error) => {
            warnings.push(format!(
                "the entries that read could not be joined: {error}"
            ));
            Read::default()
        }
    };
    warnings.append(&mut found.warnings);
    found.warnings = warnings;
    found
}

/// The warning for an entry whose key an earlier entry has; the earlier one
/// is kept.
fn used_again(key: &str) -> String {
    format!("key {key} is used again, this entry is skipped")
}

/// The file cut at every line that starts an entry (`@` at line start), each
/// chunk with its first line number. Text before the first entry is ignored,
/// as BibTeX does.
fn entry_chunks(text: &str) -> Vec<(usize, &str)> {
    let mut chunks: Vec<(usize, usize)> = Vec::new();
    let mut offset = 0;
    for (index, line) in text.split_inclusive('\n').enumerate() {
        if line.trim_start().starts_with('@') {
            chunks.push((index + 1, offset));
        }
        offset += line.len();
    }
    let ends = chunks
        .iter()
        .skip(1)
        .map(|(_, start)| *start)
        .chain([text.len()]);
    chunks
        .iter()
        .zip(ends)
        .map(|(&(line, start), end)| (line, &text[start..end]))
        .collect()
}

/// The text with each `"…"` field value that holds a `"` inside braces,
/// `"a {"}q{"} b"`, delimited by braces instead: `{a {"}q{"} b}`. BibTeX ends
/// a quoted value at a `"` outside braces only; the parser ends it at the
/// first `"` and drops the rest of the entry without an error. Only the two
/// delimiters change, so offsets and line numbers stay.
fn brace_quoted_values(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = text.to_owned();
    let mut depth = 0usize;
    let mut line_start = true;
    // A value starts after `=`, or after `#` in a concatenation.
    let mut after_operator = false;
    let mut at = 0;
    while at < bytes.len() {
        let byte = bytes[at];
        match byte {
            b'"' if depth == 1 && after_operator => {
                let Some((length, braced_quote)) = quoted_value(&bytes[at + 1..]) else {
                    break;
                };
                let end = at + 1 + length;
                if braced_quote {
                    out.replace_range(at..=at, "{");
                    out.replace_range(end..=end, "}");
                }
                at = end;
            }
            // An entry starts at depth 0 whatever the text before it left.
            b'@' if line_start => depth = 0,
            b'{' => depth += 1,
            b'}' => depth = depth.saturating_sub(1),
            _ => {}
        }
        if byte == b'\n' {
            line_start = true;
        } else if !byte.is_ascii_whitespace() {
            line_start = false;
            after_operator = matches!(byte, b'=' | b'#');
        }
        at += 1;
    }
    out
}

/// The text with `\textbackslash` as BACKSLASH and the line break `\\` as
/// LINE_BREAK, each with the spaces after it, as LaTeX reads them. The parser
/// turns both into a lone `\` that makes the next word a command. Line
/// numbers stay.
fn mark_backslashes(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let mut copied = 0;
    let mut at = 0;
    while at < bytes.len() {
        if bytes[at] != b'\\' {
            at += 1;
            continue;
        }
        let name = bytes[at + 1..]
            .iter()
            .take_while(|b| b.is_ascii_alphabetic());
        let name_end = at + 1 + name.count();
        let (mark, end) = match &text[at + 1..name_end] {
            "" if bytes.get(at + 1) == Some(&b'\\') => (biblatex_csl::LINE_BREAK, at + 2),
            "textbackslash" => (biblatex_csl::BACKSLASH, name_end),
            _ => {
                // An escape `\x` skips the character after the backslash.
                at = name_end.max(at + 2);
                continue;
            }
        };
        out.push_str(&text[copied..at]);
        out.push(mark);
        let spaces = bytes[end..]
            .iter()
            .take_while(|b| matches!(b, b' ' | b'\t'));
        at = end + spaces.count();
        copied = at;
    }
    out.push_str(&text[copied..]);
    out
}

/// The text with the spaces between a command's name and its braced argument
/// removed: `\foo {x}` becomes `\foo{x}`, as LaTeX reads it. The parser takes
/// a brace after a space as text, not as the argument. An empty `{}` only ends
/// the name, `\ldots {}`, and stays. Line numbers stay.
fn join_command_arguments(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let mut copied = 0;
    let mut at = 0;
    while at < bytes.len() {
        if bytes[at] != b'\\' {
            at += 1;
            continue;
        }
        let name = bytes[at + 1..]
            .iter()
            .take_while(|b| b.is_ascii_alphabetic());
        let name_end = at + 1 + name.count();
        let spaces = bytes[name_end..]
            .iter()
            .take_while(|b| matches!(b, b' ' | b'\t'));
        let brace = name_end + spaces.count();
        let empty = bytes.get(brace + 1) == Some(&b'}');
        if name_end > at + 1 && brace > name_end && bytes.get(brace) == Some(&b'{') && !empty {
            out.push_str(&text[copied..name_end]);
            copied = brace;
        }
        // An escape `\x` skips the character after the backslash.
        at = name_end.max(at + 2);
    }
    out.push_str(&text[copied..]);
    out
}

/// The text with each group that directly follows a command's braced
/// argument marked inside its braces, `\foo{a}{b}` as
/// `\foo{a}{<ARGUMENT_START>b<ARGUMENT_END>}`, so unlatex knows the group.
/// Line numbers stay.
fn mark_following_arguments(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut marks = Vec::new();
    let mut at = 0;
    while at < bytes.len() {
        if bytes[at] != b'\\' {
            at += 1;
            continue;
        }
        let name = bytes[at + 1..]
            .iter()
            .take_while(|b| b.is_ascii_alphabetic());
        let open = at + 1 + name.count();
        // An escape `\x` skips the character after the backslash.
        let command = open > at + 1;
        at = open.max(at + 2);
        if !command || bytes.get(open) != Some(&b'{') {
            continue;
        }
        let mut close = group_end(bytes, open);
        while let Some(end) = close.filter(|end| bytes.get(end + 1) == Some(&b'{')) {
            close = group_end(bytes, end + 1);
            if let Some(next_end) = close {
                marks.push((end + 2, biblatex_csl::ARGUMENT_START));
                marks.push((next_end, biblatex_csl::ARGUMENT_END));
            }
        }
    }
    // An empty group gets its start before its end: ARGUMENT_START sorts first.
    marks.sort_unstable();
    let mut out = String::with_capacity(text.len());
    let mut copied = 0;
    for (at, mark) in marks {
        out.push_str(&text[copied..at]);
        out.push(mark);
        copied = at;
    }
    out.push_str(&text[copied..]);
    out
}

/// The index of the `}` that closes the group whose `{` is at `open`; None
/// when the text ends first. A backslash escapes the byte after it.
fn group_end(bytes: &[u8], open: usize) -> Option<usize> {
    let mut depth = 0usize;
    let mut at = open + 1;
    while at < bytes.len() {
        match bytes[at] {
            b'{' => depth += 1,
            b'}' if depth == 0 => return Some(at),
            b'}' => depth -= 1,
            b'\\' => at += 1,
            _ => {}
        }
        at += 1;
    }
    None
}

/// The length of a quoted value up to its closing `"`, the first outside
/// braces, and whether a `"` inside braces comes before it; None when the text
/// ends first. A backslash escapes the byte after it, as in the parser.
fn quoted_value(value: &[u8]) -> Option<(usize, bool)> {
    let mut depth = 0usize;
    let mut braced_quote = false;
    let mut at = 0;
    while at < value.len() {
        match value[at] {
            b'"' if depth == 0 => return Some((at, braced_quote)),
            b'"' => braced_quote = true,
            b'{' => depth += 1,
            b'}' => depth = depth.saturating_sub(1),
            b'\\' => at += 1,
            _ => {}
        }
        at += 1;
    }
    None
}

/// The example bibliography the references dialog writes beside a document.
pub const EXAMPLE_FILE: &str = "example.bib";

/// How many undefined abbreviations one entry may use before it is skipped.
const UNDEFINED_ABBREVIATIONS_LIMIT: usize = 16;

/// One chunk as it parses with the abbreviations defined so far, and the
/// keys of its entries. An abbreviation the file never defines is taken as
/// its own text and defined for the entries after it, with a warning. A `$`
/// that opens math nobody closes runs to the end of the field; the chunk is
/// then read again with its dollar signs as text, with a warning. Any other
/// problem skips the chunk.
fn parse_chunk(
    chunk: &str,
    line: usize,
    definitions: &mut String,
    warnings: &mut Vec<String>,
) -> Option<(String, Vec<String>)> {
    let entry = chunk_key(chunk).map_or("entry".to_string(), |key| format!("entry {key}"));
    // The chunk with every `$` not already escaped written as `\$`.
    let as_text = chunk.replace('$', r"\$").replace(r"\\$", r"\$");
    let mut text = chunk.to_string();
    let mut unclosed_dollar_at = None;
    let mut defined = 0;
    loop {
        // Definitions after the entry, so its lines keep their numbers.
        let error = match biblatex::Bibliography::parse(&format!("{text}\n{definitions}")) {
            Ok(bibliography) => {
                if let Some(at) = unclosed_dollar_at {
                    warnings.push(format!(
                        "line {at}: {entry} has a $ that is not closed, its dollar signs \
                         are read as text; write \\$ for a dollar sign"
                    ));
                }
                let keys = bibliography.iter().map(|entry| entry.key.clone()).collect();
                return Some((text, keys));
            }
            Err(error) => error,
        };
        let at = line + line_of(error.span.start.min(text.len()), &text) - 1;
        match error.kind {
            biblatex::ParseErrorKind::UnknownAbbreviation(name)
                if defined < UNDEFINED_ABBREVIATIONS_LIMIT =>
            {
                warnings.push(format!(
                    "line {at}: abbreviation {name} is not defined, taken as text"
                ));
                definitions.push_str(&format!("@string{{{name} = {{{name}}}}}\n"));
                defined += 1;
            }
            biblatex::ParseErrorKind::UnknownAbbreviation(_) => {
                warnings.push(format!(
                    "line {at}: {entry} skipped, it uses more than \
                     {UNDEFINED_ABBREVIATIONS_LIMIT} undefined abbreviations"
                ));
                return None;
            }
            biblatex::ParseErrorKind::UnexpectedEof
                if unclosed_dollar_at.is_none() && as_text != chunk =>
            {
                unclosed_dollar_at = Some(at);
                text = as_text.clone();
            }
            kind => {
                warnings.push(format!("line {at}: {entry} skipped, {kind}"));
                return None;
            }
        }
    }
}

/// The key in a chunk's head `@type{key,`, if it reads as one.
fn chunk_key(chunk: &str) -> Option<&str> {
    let key = chunk.split_once(['{', '('])?.1.split_once(',')?.0.trim();
    let is_key = !key.is_empty() && !key.contains(|c: char| c.is_whitespace() || c == '=');
    is_key.then_some(key)
}

/// The entries of CSL-JSON text, the list of items a reference manager exports.
pub fn references_from_csl_json(text: &str) -> Result<References, String> {
    read_csl_json(text).map(Read::summaries)
}

/// The CSL-JSON items in full, see references_from_csl_json.
pub fn read_csl_json(text: &str) -> Result<Read, String> {
    let items: Vec<Item> = serde_json::from_str(text).map_err(|e| e.to_string())?;
    Ok(collect_items(items, ReferenceFormat::Csl))
}

/// The entries of CSL-YAML text: the `references:` list of a pandoc
/// bibliography file or of a document's header, or a bare list of items.
pub fn references_from_csl_yaml(text: &str) -> Result<References, String> {
    read_csl_yaml(text).map(Read::summaries)
}

/// The CSL-YAML items in full, see references_from_csl_yaml.
pub fn read_csl_yaml(text: &str) -> Result<Read, String> {
    use yaml_serde::Value as Yaml;
    let document: Yaml = yaml_serde::from_str(text).map_err(|e| e.to_string())?;
    let list = match document {
        Yaml::Mapping(mut map) => map.remove("references").unwrap_or(Yaml::Null),
        other => other,
    };
    let items: Vec<Item> = match list {
        Yaml::Null => Vec::new(),
        list => yaml_serde::from_value(list).map_err(|e| e.to_string())?,
    };
    Ok(collect_items(items, ReferenceFormat::Csl))
}

/// The files a header names under `bibliography:`, one path or a list of
/// paths as pandoc allows, in header order. Paths are returned as written;
/// where they may point is decided when they are read.
pub fn bibliography_paths(front_matter: &str) -> Result<Vec<String>, String> {
    use yaml_serde::Value as Yaml;
    let document: Yaml = yaml_serde::from_str(front_matter).map_err(|e| e.to_string())?;
    let Yaml::Mapping(map) = document else {
        return Ok(Vec::new());
    };
    Ok(match map.get("bibliography") {
        Some(Yaml::String(path)) => vec![path.clone()],
        Some(Yaml::Sequence(list)) => list
            .iter()
            .filter_map(|path| path.as_str().map(str::to_string))
            .collect(),
        _ => Vec::new(),
    })
}

/// The reference file formats, by extension.
const REFERENCE_EXTS: &[&str] = &["bib", "json", "yaml", "yml"];

/// Where a `bibliography:` path may point: a file in the document's folder
/// or below, in one of the reference formats. The document chooses the path,
/// and a document someone else wrote must not read arbitrary files or fetch
/// anything, so an absolute path, `..`, and a web address are refused.
pub fn bibliography_file(document_dir: &Path, path: &str) -> Result<PathBuf, String> {
    let relative = Path::new(path);
    let escapes = relative.is_absolute()
        || relative
            .components()
            .any(|part| part == Component::ParentDir);
    if escapes || path.contains("://") {
        return Err(format!(
            "{path}: only a file in the document's folder is read"
        ));
    }
    let ext = relative
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase);
    if !ext.is_some_and(|e| REFERENCE_EXTS.contains(&e.as_str())) {
        return Err(format!("{path}: not a .bib, .json, .yaml or .yml file"));
    }
    Ok(document_dir.join(relative))
}

/// The largest reference file that is read. A library export of thousands of
/// entries is a few megabytes; the whole file is held in memory while read.
const BIBLIOGRAPHY_MAX_BYTES: u64 = 10 * 1024 * 1024;

/// The entries of one `bibliography:` file of the document in `document_dir`.
/// `allow_network` is the user's setting for network paths, see validate_path.
pub fn read_bibliography(
    document_dir: &Path,
    path: &str,
    allow_network: bool,
    english_document: bool,
) -> Result<Read, String> {
    let file = bibliography_file(document_dir, path)?;
    let file_str = file.to_string_lossy();
    crate::validate_path(&file_str, allow_network)?;
    // A link may point at a network share, and resolving it would make the
    // system contact that host; the link's target is checked first.
    if let Ok(target) = fs::read_link(&file) {
        crate::validate_path(&target.to_string_lossy(), allow_network)
            .map_err(|e| format!("{path}: {e}"))?;
    }
    // A link inside the folder can still lead out of it; the resolved path
    // has to stay below the resolved folder.
    let resolved = fs::canonicalize(&file).map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => format!("{path}: not found"),
        _ => format!("{path}: {e}"),
    })?;
    let root = fs::canonicalize(document_dir).map_err(|e| e.to_string())?;
    if !resolved.starts_with(&root) {
        return Err(format!(
            "{path}: only a file in the document's folder is read"
        ));
    }
    let bytes = crate::read_capped(&file_str, BIBLIOGRAPHY_MAX_BYTES)
        .map_err(|e| format!("{path}: {e}"))?
        .ok_or_else(|| format!("{path}: larger than {} MB", BIBLIOGRAPHY_MAX_BYTES >> 20))?;
    let text = String::from_utf8(bytes).map_err(|_| format!("{path}: not UTF-8 text"))?;
    match file
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase)
    {
        Some(ext) if ext == "bib" => Ok(read_biblatex(&text, english_document)),
        Some(ext) if ext == "json" => read_csl_json(&text),
        _ => read_csl_yaml(&text),
    }
    .map_err(|e| format!("{path}: {e}"))
}

/// One place the header named and how many entries it gave; a source that
/// could not be read gives none, and its warning says why. Every warning
/// starts with the source's name, so the editor can group them.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
pub struct Source {
    /// `header` for the inline list, else the path as written.
    pub name: String,
    pub entries: usize,
}

/// What the editor gets for a document: every entry, every warning, and the
/// sources in header order.
#[derive(Clone, Debug, Default, PartialEq, Eq, serde::Serialize)]
pub struct LoadedSummaries {
    pub entries: Vec<ReferenceSummary>,
    pub warnings: Vec<String>,
    pub sources: Vec<Source>,
}

/// The same with the references in full, as rendering needs them.
#[derive(Default)]
pub struct LoadedReferences {
    pub references: Vec<Reference>,
    pub warnings: Vec<String>,
    pub sources: Vec<Source>,
    keys: HashSet<String>,
}

impl LoadedReferences {
    fn add(&mut self, name: &str, result: Result<Read, String>) {
        let mut entries = 0;
        match result {
            Ok(found) => {
                let named = found.warnings.iter().map(|w| format!("{name}: {w}"));
                self.warnings.extend(named);
                for reference in found.references {
                    let key = reference.key();
                    if !self.keys.insert(key.clone()) {
                        self.warnings.push(format!("{name}: {}", used_again(&key)));
                        continue;
                    }
                    entries += 1;
                    self.references.push(reference);
                }
            }
            // Already named: a read refuses with the path in front.
            Err(problem) => self.warnings.push(problem),
        }
        self.sources.push(Source {
            name: name.to_string(),
            entries,
        });
    }

    /// The editor's view of it: summaries only.
    pub fn summaries(self) -> LoadedSummaries {
        LoadedSummaries {
            entries: self.references.iter().map(Reference::summary).collect(),
            warnings: self.warnings,
            sources: self.sources,
        }
    }
}

/// Everything the header of the document at `document_path` names: the
/// inline `references:` list first, then each `bibliography:` file in header
/// order. A file that cannot be read becomes a warning, so the editor keeps
/// what the other sources gave. An unsaved document has no folder for the
/// files to be relative to, so they wait until it is saved.
pub fn load_summaries(
    document_path: Option<&str>,
    front_matter: &str,
    allow_network: bool,
) -> LoadedSummaries {
    load_references(document_path, front_matter, allow_network).summaries()
}

/// A string the header gives under `key`, `csl: apa`; absent or no string
/// gives `None`.
pub fn header_string(front_matter: &str, key: &str) -> Option<String> {
    let document: yaml_serde::Value = yaml_serde::from_str(front_matter).ok()?;
    document.get(key)?.as_str().map(str::to_string)
}

/// Whether the document's `lang:` is English or absent, as Pandoc decides
/// whether a `.bib` title goes to sentence case.
fn is_english_document(front_matter: &str) -> bool {
    header_string(front_matter, "lang").is_none_or(|lang| lang.trim().starts_with("en"))
}

pub fn load_references(
    document_path: Option<&str>,
    front_matter: &str,
    allow_network: bool,
) -> LoadedReferences {
    let mut loaded = LoadedReferences::default();
    // A header list that does not read still leaves the files it names.
    let lists_references = front_matter
        .lines()
        .any(|line| line.starts_with("references:"));
    match read_csl_yaml(front_matter) {
        Ok(inline) if lists_references => loaded.add("header", Ok(inline)),
        Ok(_) => {}
        Err(problem) => loaded.warnings.push(format!("header: {problem}")),
    }
    let dir = document_path.map(Path::new).and_then(Path::parent);
    let english = is_english_document(front_matter);
    for path in bibliography_paths(front_matter).unwrap_or_default() {
        let result = match dir {
            Some(dir) => read_bibliography(dir, &path, allow_network, english),
            None => Err(format!(
                "{path}: save the document first, the path is relative to it"
            )),
        };
        loaded.add(&path, result);
    }
    loaded
}

fn collect_items(items: Vec<Item>, format: ReferenceFormat) -> Read {
    let mut found = Read::default();
    for (index, mut item) in items.into_iter().enumerate() {
        normalise_dates(&mut item, index, &mut found.warnings);
        // Without an `id` there is nothing to write after `@`.
        if item.id().is_some() {
            found.references.push(Reference { item, format });
        } else {
            let skipped = format!("entry {} skipped, it has no id", index + 1);
            found.warnings.push(skipped);
        }
    }
    found
}

fn summarize_item(id: &str, item: &Item, format: ReferenceFormat) -> ReferenceSummary {
    let authors = match item.0.get("author") {
        Some(Value::Names(names)) => names.iter().map(name_first).collect(),
        _ => Vec::new(),
    };
    let title = item.0.get("title").and_then(Value::to_str);
    ReferenceSummary {
        format,
        key: id.to_string(),
        authors,
        year: item.0.get("issued").and_then(year_of),
        title: title.unwrap_or_default().into_owned(),
    }
}

/// Family name first, "van der Roe, Richard", whichever kind its particle is.
fn name_first(name: &NameValue) -> String {
    match name {
        NameValue::Literal(name) => name.literal.clone(),
        NameValue::Item(name) => {
            let particle = name
                .non_dropping_particle
                .as_deref()
                .or(name.dropping_particle.as_deref());
            let family = particle.map_or(name.family.clone(), |p| format!("{p} {}", name.family));
            name.given
                .as_ref()
                .map_or(family.clone(), |given| format!("{family}, {given}"))
        }
    }
}

/// CSL allows a date as a bare year, as text ("2019-07") or as date parts.
/// The date variables of CSL.
const DATE_VARIABLES: [&str; 6] = [
    "accessed",
    "available-date",
    "event-date",
    "issued",
    "original-date",
    "submitted",
];

/// hayagriva reads a date only in the CSL form, `{date-parts: [[2019]]}` or
/// a date string, and panics on a range. The bare `issued: 2019` pandoc takes
/// becomes that form; a range keeps its start. What is no date stays as it
/// is, with a warning, and renders as "n.d.".
fn normalise_dates(item: &mut Item, index: usize, warnings: &mut Vec<String>) {
    for name in DATE_VARIABLES {
        let Some(value) = item.0.get_mut(name) else {
            continue;
        };
        // Date parts without a year, `[[]]`, make citationberg panic when
        // the date is read; such a date is dropped before it gets there.
        let no_year = matches!(
            value,
            Value::Date(DateValue::DateParts { date_parts, .. })
                if date_parts.0.iter().any(|d| d.0.is_empty())
        );
        if no_year {
            warnings.push(format!("entry {}: {name} has no year", index + 1));
            item.0.remove(name);
            continue;
        }
        let range = match value {
            Value::Number(year) => year.to_string().parse::<FixedDateRange>().ok(),
            Value::String(text) => text.parse::<FixedDateRange>().ok(),
            Value::Date(date) => match FixedDateRange::try_from(date.clone()) {
                Ok(range) => Some(range),
                // A literal date, `{literal: in press}`, has no parts to take.
                Err(()) if literal_of(date).is_some() => continue,
                Err(()) => None,
            },
            Value::Names(_) => None,
        };
        let Some(mut range) = range else {
            warnings.push(format!("entry {}: {name} is not a date", index + 1));
            continue;
        };
        if range.end.take().is_some() {
            let note = format!(
                "entry {}: {name} is a range, only its start is used",
                index + 1
            );
            warnings.push(note);
        }
        *value = Value::Date(DateValue::Raw {
            raw: range,
            literal: None,
            season: None,
        });
    }
}

/// The literal text of a date, where it has one.
fn literal_of(date: &DateValue) -> Option<&str> {
    match date {
        DateValue::Raw { literal, .. } | DateValue::DateParts { literal, .. } => literal.as_deref(),
    }
}

fn year_of(issued: &Value) -> Option<i32> {
    match issued {
        Value::Date(date) => Some(
            FixedDateRange::try_from(date.clone())
                .ok()?
                .start
                .year
                .into(),
        ),
        _ => None,
    }
}

/// The parser reports a byte position; a line number is what finds the spot.
fn line_of(position: usize, text: &str) -> usize {
    let before = &text.as_bytes()[..position.min(text.len())];
    before.iter().filter(|byte| **byte == b'\n').count() + 1
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"@article{doe2020,
  author = {Doe, Jane and van der Roe, Richard},
  title = {A study of {ERA5} d{\"a}ta},
  year = {2020},
}

@dataset{ERA5LandHourlyData2019,
  author = {{Copernicus Climate Change Service}},
  title = {ERA5-Land hourly data from 1950 to present},
  date = {2019-07-12},
}

@misc{bare, title = {No author, no date}}
"#;

    #[test]
    fn bib_entries_come_in_file_order_with_key_year_and_title() {
        let References { entries, warnings } = references_from_biblatex(SAMPLE);
        let keys: Vec<&str> = entries.iter().map(|e| e.key.as_str()).collect();
        assert_eq!(keys, ["doe2020", "ERA5LandHourlyData2019", "bare"]);
        // From `year` or `date`, and missing where the entry has neither.
        let years: Vec<Option<i32>> = entries.iter().map(|e| e.year).collect();
        assert_eq!(years, [Some(2020), Some(2019), None]);
        // Braces and LaTeX accents are resolved.
        assert_eq!(entries[0].title, "A study of ERA5 däta");
        assert!(warnings.is_empty());
    }

    #[test]
    fn bib_authors_are_family_name_first_and_an_institution_stays_whole() {
        let entries = references_from_biblatex(SAMPLE).entries;
        assert_eq!(entries[0].format, ReferenceFormat::Bib);
        assert_eq!(entries[0].authors, ["Doe, Jane", "van der Roe, Richard"]);
        assert_eq!(entries[1].authors, ["Copernicus Climate Change Service"]);
        assert!(entries[2].authors.is_empty());
    }

    #[test]
    fn an_entry_with_in_press_as_its_year_is_kept_without_a_year() {
        let odd = "@article{odd,\n  title = {T},\n  year = {in press},\n}\n";
        let found = references_from_biblatex(&format!("{SAMPLE}{odd}"));
        assert_eq!(found.entries.len(), 4);
        assert_eq!(found.entries[3].year, None);
        assert!(found.warnings.is_empty(), "{:?}", found.warnings);
        assert!(found.warnings.is_empty());
    }

    #[test]
    fn a_quote_in_braces_does_not_end_a_quoted_field() {
        // pandoc's test case escapedquotes, shortened.
        let bib = r#"@comment{Double quotes escaped using {"}.}
@ARTICLE{Koff2009-gn,
  title  = "Irreversible compression ratios
            ({"}lossy{"} compression)",
  author = "Koff, David and
            Volkening, Andrew",
}
"#;
        let found = references_from_biblatex(bib);
        let entry = &found.entries[0];
        assert_eq!(entry.authors, ["Koff, David", "Volkening, Andrew"]);
        let title = r#"Irreversible compression ratios ("lossy" compression)"#;
        assert_eq!(entry.title, title);
        assert!(found.warnings.is_empty(), "{:?}", found.warnings);
        // In an abbreviation and in a concatenation too.
        let bib = r#"@string{q = "{"}q{"}"} @misc{m, title = "A" # "{"}b{"}" # q}"#;
        assert_eq!(references_from_biblatex(bib).entries[0].title, r#"A"b""q""#);
    }

    #[test]
    fn a_space_before_a_command_argument_changes_nothing() {
        let bib = "@misc{k, title={T}, note={A \\foo {bar} \\emph  {x} Gar\\c {c}on \\ldots {} \\o {} \\em\t{y} B}}";
        let read = read_biblatex(bib, true);
        let note = Value::String("A  x Garçon … ø y B".into());
        assert_eq!(read.references[0].item.0.get("note"), Some(&note));
    }

    #[test]
    fn a_group_right_after_a_command_argument_is_marked() {
        let (start, end) = (biblatex_csl::ARGUMENT_START, biblatex_csl::ARGUMENT_END);
        let marked = mark_following_arguments(r"\foo{a{b}}{c}{} \\x{d} \bar {e}");
        let expected =
            format!(r"\foo{{a{{b}}}}{{{start}c{end}}}{{{start}{end}}} \\x{{d}} \bar {{e}}");
        assert_eq!(marked, expected);
        let read = read_biblatex(r"@misc{k, title={T}, note={A \emph{a}{b} B}}", true);
        let note = Value::String("A ab B".into());
        assert_eq!(read.references[0].item.0.get("note"), Some(&note));
    }

    #[test]
    fn a_two_argument_command_prints_the_argument_pandoc_prints() {
        let bib = r"@book{k, title={The \texorpdfstring{Big One}{Big Two} Now},
            note={\href{u}{x \emph{y} z} \textcolor{red}{x} \foreignlanguage{german}{x}
            \texorpdfstring{x}{y} \foreignquote{english}{x} \hyphenquote{english}{x}}}";
        let item = &read_biblatex(bib, true).references[0].item;
        let field = |name: &str| item.0.get(name).cloned();
        let text = |text: &str| Some(Value::String(text.into()));
        assert_eq!(field("title"), text("The big one now"));
        assert_eq!(field("note"), text("x y z x x x “x” “x”"));
    }

    #[test]
    fn an_unknown_command_drops_every_group_right_after_it() {
        let bib = r"@misc{k, title={T},
            note={A \foo{a}{b} \foo{a}{b}{c} \foo{a} {b} \foo{a}{\bar{x}{y}} \emph{a}{b} B}}";
        let read = read_biblatex(bib, true);
        let note = Value::String("A    b  ab B".into());
        assert_eq!(read.references[0].item.0.get("note"), Some(&note));
    }

    #[test]
    fn a_backslash_command_and_a_line_break_print_as_pandoc_prints_them() {
        let bib = r"@book{k, title={The \textbackslash Big Word}, url={http://x.org/a\\b},
            note={The \textbackslash n escape, C:\textbackslash Users, C:\\Users, a \\ b}}";
        let item = &read_biblatex(bib, true).references[0].item;
        let field = |name: &str| item.0.get(name).cloned();
        let text = |text: &str| Some(Value::String(text.into()));
        assert_eq!(field("title"), text(r"The \big word"));
        assert_eq!(field("URL"), text(r"http://x.org/a\\b"));
        let note = "The \\n escape, C:\\Users, C:\nUsers, a\nb";
        assert_eq!(field("note"), text(note));
    }

    #[test]
    fn a_quoted_field_without_a_quote_in_braces_is_left_as_written() {
        for bib in [
            r#"@misc{m, title = "A {B} c" # "d"}"#,
            r#"@misc{m, title = {A "b {"} c"}}"#,
            r#"@misc{m, title = "M{\"u}ller"}"#,
        ] {
            assert_eq!(brace_quoted_values(bib), bib);
        }
    }

    #[test]
    fn csl_json_items_give_the_same_summary_as_bib_entries() {
        let json = r#"[
          {"id": "doe2020", "title": "A study", "issued": {"date-parts": [[2020, 3]]},
           "author": [{"family": "Doe", "given": "Jane"},
                      {"family": "Roe", "given": "Richard", "non-dropping-particle": "van der"}]},
          {"id": "era5", "title": "ERA5-Land", "issued": 2019,
           "author": [{"literal": "Copernicus Climate Change Service"}]},
          {"id": "text", "issued": "2018-07"},
          {"title": "No id"}
        ]"#;
        let References { entries, warnings } = references_from_csl_json(json).unwrap();
        let years: Vec<Option<i32>> = entries.iter().map(|e| e.year).collect();
        assert_eq!(years, [Some(2020), Some(2019), Some(2018)]);
        assert_eq!(entries[0].authors, ["Doe, Jane", "van der Roe, Richard"]);
        assert_eq!(entries[1].authors, ["Copernicus Climate Change Service"]);
        assert_eq!(entries[1].title, "ERA5-Land");
        assert_eq!(warnings, ["entry 4 skipped, it has no id"]);
        let broken = references_from_csl_json("[{").unwrap_err();
        assert!(broken.contains("line 1"));
    }

    #[test]
    fn csl_yaml_gives_the_same_items_from_a_references_list_or_a_bare_list() {
        let header = "title: My paper\ncsl: apa\nreferences:\n- id: era5\n  type: dataset\n  title: ERA5-Land\n  author:\n  - literal: Copernicus Climate Change Service\n  issued: 2019\n";
        let found = references_from_csl_yaml(header).unwrap();
        assert_eq!(found.entries.len(), 1);
        assert_eq!(found.entries[0].key, "era5");
        assert_eq!(found.entries[0].format, ReferenceFormat::Csl);
        assert_eq!(
            found.entries[0].authors,
            ["Copernicus Climate Change Service"]
        );
        assert_eq!(found.entries[0].year, Some(2019));
        let bare = "- id: doe\n  title: A study\n  issued:\n    date-parts: [[2020, 3]]\n";
        let found = references_from_csl_yaml(bare).unwrap();
        assert_eq!(
            (found.entries[0].year, found.entries[0].title.as_str()),
            (Some(2020), "A study")
        );
        assert_eq!(
            references_from_csl_yaml("title: No references\n"),
            Ok(References::default())
        );
        assert_eq!(references_from_csl_yaml(""), Ok(References::default()));
        assert!(references_from_csl_yaml("- id: [\n")
            .unwrap_err()
            .contains("line"));
    }

    #[test]
    fn bibliography_paths_come_from_one_value_or_a_list() {
        let one = "title: T\nbibliography: refs.bib\n";
        assert_eq!(bibliography_paths(one), Ok(vec!["refs.bib".to_string()]));
        let many = "bibliography:\n- refs.bib\n- \"My Library.json\"\n";
        assert_eq!(
            bibliography_paths(many),
            Ok(vec!["refs.bib".to_string(), "My Library.json".to_string()])
        );
        assert_eq!(bibliography_paths("title: T\n"), Ok(vec![]));
        assert_eq!(bibliography_paths(""), Ok(vec![]));
        assert_eq!(bibliography_paths("- not a header\n"), Ok(vec![]));
        assert!(bibliography_paths("bibliography: [\n").is_err());
    }

    #[test]
    fn a_bibliography_file_stays_in_the_document_folder_with_a_known_format() {
        let dir = Path::new("/docs/paper");
        let file = |path: &str| bibliography_file(dir, path);
        assert_eq!(file("refs.bib"), Ok(PathBuf::from("/docs/paper/refs.bib")));
        assert_eq!(
            file("lib/Zotero.JSON"),
            Ok(PathBuf::from("/docs/paper/lib/Zotero.JSON"))
        );
        let outside = "only a file in the document's folder is read";
        assert!(file("/etc/passwd.bib").unwrap_err().ends_with(outside));
        assert!(file("../shared/refs.bib").unwrap_err().ends_with(outside));
        assert!(file("https://example.org/refs.bib")
            .unwrap_err()
            .ends_with(outside));
        assert!(file("notes.txt")
            .unwrap_err()
            .ends_with("not a .bib, .json, .yaml or .yml file"));
        assert!(file("refs").is_err());
    }

    #[test]
    fn a_bibliography_file_is_read_by_its_format_from_inside_the_folder() {
        let dir = std::env::temp_dir().join(format!("monoleaf_refs-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("lib")).unwrap();
        fs::write(dir.join("lib/refs.bib"), SAMPLE).unwrap();
        fs::write(
            dir.join("refs.json"),
            r#"[{"id": "j", "title": "From JSON"}]"#,
        )
        .unwrap();
        fs::write(
            dir.join("refs.yml"),
            "references:\n- id: y\n  title: From YAML\n",
        )
        .unwrap();
        let read = |path: &str| read_bibliography(&dir, path, false, true);
        let summary = |path: &str| read(path).unwrap().summaries().entries;
        assert_eq!(summary("lib/refs.bib").len(), 3);
        assert_eq!(summary("refs.json")[0].title, "From JSON");
        assert_eq!(summary("refs.yml")[0].key, "y");
        assert_eq!(read("missing.bib").unwrap_err(), "missing.bib: not found");
        #[cfg(unix)]
        {
            // A link that leads out of the folder is refused like `..`.
            let outside = dir.with_extension("outside.bib");
            fs::write(&outside, SAMPLE).unwrap();
            std::os::unix::fs::symlink(&outside, dir.join("link.bib")).unwrap();
            assert!(read("link.bib").unwrap_err().ends_with("folder is read"));
            let _ = fs::remove_file(outside);
            // A link to a share is refused before the system resolves it.
            std::os::unix::fs::symlink(r"\\server\share\x.bib", dir.join("share.bib")).unwrap();
            assert_eq!(
                read("share.bib").unwrap_err(),
                "share.bib: Network paths are not supported"
            );
        }
        // The size cap and the text check give their reasons.
        fs::write(
            dir.join("big.bib"),
            vec![b' '; BIBLIOGRAPHY_MAX_BYTES as usize + 1],
        )
        .unwrap();
        assert_eq!(read("big.bib").unwrap_err(), "big.bib: larger than 10 MB");
        fs::write(dir.join("bytes.bib"), [0xff, 0xfe, b'@']).unwrap();
        assert_eq!(read("bytes.bib").unwrap_err(), "bytes.bib: not UTF-8 text");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn load_joins_the_inline_list_and_the_files_and_warns_per_problem() {
        let dir = std::env::temp_dir().join(format!("monoleaf_load-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("refs.bib"), SAMPLE).unwrap();
        let doc = dir.join("paper.md");
        let header = "bibliography:\n- refs.bib\n- missing.bib\nreferences:\n- id: inline\n  title: Inline\n- title: No id\n";
        let found = load_summaries(doc.to_str(), header, false);
        let keys: Vec<&str> = found.entries.iter().map(|e| e.key.as_str()).collect();
        assert_eq!(
            keys,
            ["inline", "doe2020", "ERA5LandHourlyData2019", "bare"]
        );
        assert_eq!(
            found.warnings,
            [
                "header: entry 2 skipped, it has no id",
                "missing.bib: not found"
            ]
        );
        let sources: Vec<(&str, usize)> = found
            .sources
            .iter()
            .map(|s| (s.name.as_str(), s.entries))
            .collect();
        assert_eq!(
            sources,
            [("header", 1), ("refs.bib", 3), ("missing.bib", 0)]
        );
        let unsaved = load_summaries(None, header, false);
        assert_eq!(unsaved.entries.len(), 1);
        assert!(unsaved.warnings[1].starts_with("refs.bib: save the document first"));
        assert!(load_summaries(None, "references: [\n", false).warnings[0].starts_with("header: "));
        let not_a_list = load_summaries(
            doc.to_str(),
            "bibliography: refs.bib\nreferences: 5\n",
            false,
        );
        assert_eq!(not_a_list.entries.len(), 3);
        assert_eq!(
            not_a_list.warnings,
            ["header: invalid type: integer `5`, expected a sequence"]
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_key_another_source_has_already_is_skipped_with_a_warning() {
        let dir = std::env::temp_dir().join(format!("monoleaf_again-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("a.bib"),
            "@misc{a, title={A}}\n@misc{b, title={B}}\n",
        )
        .unwrap();
        fs::write(dir.join("b.json"), r#"[{"id": "a", "title": "Other"}]"#).unwrap();
        let doc = dir.join("paper.md");
        let header = "bibliography: [a.bib, b.json]\nreferences:\n- id: b\n  title: Inline\n";
        let found = load_summaries(doc.to_str(), header, false);
        let kept: Vec<(&str, &str)> = found
            .entries
            .iter()
            .map(|e| (e.key.as_str(), e.title.as_str()))
            .collect();
        assert_eq!(kept, [("b", "Inline"), ("a", "A")]);
        assert_eq!(
            found.warnings,
            [
                "a.bib: key b is used again, this entry is skipped",
                "b.json: key a is used again, this entry is skipped",
            ]
        );
        let counts: Vec<usize> = found.sources.iter().map(|s| s.entries).collect();
        assert_eq!(counts, [1, 1, 0]);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_undefined_abbreviation_is_taken_as_its_text_with_a_warning() {
        let crossref =
            "@article{a, title={T}, year={2021}, month=July}\n@misc{b, title={U}, journal=jphys}\n";
        let found = references_from_biblatex(crossref);
        assert_eq!(found.entries.len(), 2);
        assert_eq!(
            found.warnings,
            [
                "line 1: abbreviation July is not defined, taken as text",
                "line 2: abbreviation jphys is not defined, taken as text",
            ]
        );
    }

    #[test]
    fn an_entry_with_too_many_undefined_abbreviations_is_skipped_with_a_warning() {
        let entry = |count: usize| {
            let fields: Vec<String> = (1..=count).map(|i| format!("f{i}=a{i}")).collect();
            format!("@misc{{k, title={{T}}, {}}}\n", fields.join(", "))
        };
        let most = read_biblatex(&entry(UNDEFINED_ABBREVIATIONS_LIMIT), true);
        assert_eq!(most.references.len(), 1);
        assert_eq!(most.warnings.len(), UNDEFINED_ABBREVIATIONS_LIMIT);
        let more = read_biblatex(&entry(UNDEFINED_ABBREVIATIONS_LIMIT + 1), true);
        assert!(more.references.is_empty());
        let skipped = "line 1: entry k skipped, it uses more than 16 undefined abbreviations";
        assert_eq!(more.warnings.last().map(String::as_str), Some(skipped));
    }

    #[test]
    fn crossref_and_xdata_read_entry_by_entry_as_in_a_whole_file() {
        let bib = "@inbook{part, crossref={whole}, xdata={x}, title={Part}}\n\
                   @book{whole, title={Whole}, publisher={Pub}}\n@xdata{x, note={N}}\n";
        let shown = |read: &Read| -> Vec<Vec<Option<String>>> {
            read.references
                .iter()
                .map(|r| {
                    ["id", "container-title", "publisher", "note"]
                        .map(|name| {
                            r.item
                                .0
                                .get(name)
                                .and_then(Value::to_str)
                                .map(|v| v.into_owned())
                        })
                        .to_vec()
                })
                .collect()
        };
        let whole = read_biblatex(bib, true);
        let by_entry = read_biblatex(&bib.replace("{Pub}", "{Pub}, month=July"), true);
        assert_eq!(
            by_entry.warnings,
            ["line 2: abbreviation July is not defined, taken as text"]
        );
        assert_eq!(shown(&by_entry), shown(&whole));
        let part = ["part", "Whole", "Pub", "N"].map(|v| Some(v.to_string()));
        assert_eq!(shown(&whole)[0], part);
    }

    #[test]
    fn a_formula_reads_as_written_whole_file_or_entry_by_entry() {
        let entry = r"@misc{k, title={T}, note={$\frac{a}{b}$ and $${\alpha (m_Z^2)}$$}";
        let note = Value::String(r"$\frac{a}{b}$ and $${\alpha (m_Z^2)}$$".into());
        for bib in [format!("{entry}}}"), format!("{entry}, month=July}}")] {
            let read = read_biblatex(&bib, true);
            assert_eq!(read.references[0].item.0.get("note"), Some(&note), "{bib}");
        }
    }

    #[test]
    fn an_unclosed_dollar_is_read_as_text_with_a_warning_naming_the_entry() {
        let math = "@misc{c, title={$x^2$}}\n";
        let found = references_from_biblatex(&format!("@article{{a,\n title={{$14.95}}}}\n{math}"));
        assert_eq!(found.entries[0].title, "$14.95");
        assert_eq!(
            found.entries[1].title,
            references_from_biblatex(math).entries[0].title
        );
        assert_eq!(
            found.warnings,
            [
                "line 2: entry a has a $ that is not closed, its dollar signs are read as text; \
              write \\$ for a dollar sign"
            ]
        );
    }

    #[test]
    fn a_broken_or_repeated_entry_is_skipped_with_its_line_and_the_rest_stays() {
        let unclosed = "@article{a,\n  title = {Unclosed,\n}\n@misc{b, title = {B}}\n";
        let found = references_from_biblatex(unclosed);
        assert_eq!(found.entries.len(), 1);
        assert_eq!(found.warnings, ["line 4: entry a skipped, expected comma"]);
        let twice = "@misc{a, title = {A}}\n@misc{a, title = {B}}\n@misc{c, title = {C}}\n";
        let found = references_from_biblatex(twice);
        assert_eq!(found.entries.len(), 2);
        assert_eq!(
            found.warnings,
            ["line 2: key a is used again, this entry is skipped"]
        );
        assert_eq!(references_from_biblatex(""), References::default());
        assert_eq!(
            references_from_biblatex("no entries here\n"),
            References::default()
        );
    }

    #[test]
    fn a_csl_date_without_a_year_is_dropped_with_a_warning() {
        for parts in ["[[]]", "[[\"\"]]"] {
            let json =
                format!(r#"[{{"id": "a", "title": "T", "issued": {{"date-parts": {parts}}}}}]"#);
            let read = read_csl_json(&json).unwrap();
            assert_eq!(read.references.len(), 1, "{parts}");
            assert!(!read.references[0].item.0.contains_key("issued"), "{parts}");
            assert_eq!(read.warnings, ["entry 1: issued has no year"], "{parts}");
        }
    }

    #[test]
    fn a_no_break_space_or_a_byte_order_mark_before_an_entry_costs_nothing() {
        // `month = July` makes the whole file fail, so both go the entry-by-entry way.
        let second = "@article{b, title={B}, month = July, year={2021}}\n";
        let nbsp = format!("@article{{a, title={{A}}, year={{2020}}}}\n\u{a0}{second}");
        let bom = format!("\u{feff}@article{{a, title={{A}}, year={{2020}}}}\n{second}");
        for text in [nbsp, bom] {
            let found = references_from_biblatex(&text);
            let keys: Vec<&str> = found.entries.iter().map(|e| e.key.as_str()).collect();
            assert_eq!(keys, ["a", "b"], "{text:?}");
            assert_eq!(found.warnings.len(), 1, "{:?}", found.warnings);
            assert!(found.warnings[0].contains("July"), "{:?}", found.warnings);
        }
    }

    #[test]
    fn item_dates_take_the_csl_form_and_a_range_keeps_its_start() {
        let text = "references:\n- id: a\n  issued: 2019\n- id: b\n  issued: 2019/2021\n\
                    - id: c\n  issued: soon\n";
        let read = read_csl_yaml(text).unwrap();
        let issued = |n: usize| read.references[n].item.0.get("issued").cloned();
        assert!(matches!(issued(0), Some(Value::Date(_))));
        assert_eq!(year_of(&issued(1).unwrap()), Some(2019));
        assert_eq!(issued(2), Some(Value::String("soon".into())));
        assert_eq!(
            read.warnings,
            [
                "entry 2: issued is a range, only its start is used",
                "entry 3: issued is not a date"
            ]
        );
    }
}
