//! Watching each window's open document for changes made by other programs.
//!
//! Rust only reports that *something happened* to the file; it never decides
//! whether that matters. Whether a change is Monoleaf's own save, an external
//! edit, or a touch that left the bytes alone is settled by the frontend, by
//! comparing the text on disk with the text it last loaded or saved (see
//! `src/filewatch.ts`). That keeps suppression of our own saves content-based
//! rather than timing-based: a slow disk or a busy event loop can delay an
//! event, but it cannot make different bytes look the same.

use notify_debouncer_mini::notify::{RecommendedWatcher, RecursiveMode};
use notify_debouncer_mini::{new_debouncer, DebounceEventResult, Debouncer};
use std::collections::HashMap;
use std::ffi::OsStr;
use std::path::Path;
use std::sync::Mutex;
use std::time::Duration;

/// Emitted to the owning window when its document changed or vanished on disk.
///
/// COUPLED: `FILE_CHANGED_EVENT` in `src/main.ts`. A rename on either side
/// fails silently: the window simply stops noticing external edits.
pub const FILE_CHANGED_EVENT: &str = "file-changed-on-disk";

/// How long the file has to be quiet before a change is reported.
///
/// Tools rarely write a file in one step. An atomic save is "write a temp file,
/// rename it over the original", a plain one can be several `write` calls, and
/// some editors delete and recreate. Without a debounce the frontend would read
/// the file mid-sequence, see a half-written or missing document and react to a
/// state that never really existed. A quarter of a second covers every save
/// sequence seen in practice and is still well under what reads as a delay.
const DEBOUNCE: Duration = Duration::from_millis(250);

/// What happened to the watched file, as far as the frontend needs to know.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ChangeKind {
    /// The file exists and may have different contents.
    Changed,
    /// The file is gone (deleted, or renamed to something else).
    Removed,
}

/// The event payload. `path` is echoed back exactly as the frontend supplied
/// it, so the window can compare it to its own current path by plain string
/// equality and drop a late event from a watch it has already replaced.
#[derive(Clone, Debug, serde::Serialize)]
pub struct FileChange {
    pub path: String,
    pub kind: ChangeKind,
}

/// File-name equality as the platform's default file system sees it.
///
/// NTFS and APFS are case-insensitive by default, so on Windows and macOS a
/// file opened as `Notes.md` must still match an event reported for
/// `notes.md`. Linux file systems are case-sensitive, and there the two are
/// genuinely different files.
fn same_file_name(a: &OsStr, b: &OsStr) -> bool {
    if cfg!(any(windows, target_os = "macos")) {
        a.to_string_lossy().to_lowercase() == b.to_string_lossy().to_lowercase()
    } else {
        a == b
    }
}

/// Whether an event reported for `event_path` concerns `target`.
///
/// Only the file name is compared. The watch is on the parent directory and is
/// not recursive, so everything it reports is a direct child of that directory
/// — and the platform may spell that directory differently from the path the
/// user opened (macOS reports `/private/var/...` for `/var/...`, Windows may
/// report a different case). Comparing whole paths would turn those spelling
/// differences into missed changes. A false positive here costs nothing: the
/// frontend compares contents and ignores a change that did not change them.
pub fn concerns_target(target: &Path, event_path: &Path) -> bool {
    match (target.file_name(), event_path.file_name()) {
        (Some(t), Some(e)) => same_file_name(t, e),
        _ => false,
    }
}

/// Reduce one debounced batch of event paths to at most one report.
///
/// `None` when nothing in the batch touched the target (a sibling file in the
/// same directory changed). Otherwise the kind is decided by whether the file
/// exists *now*, after the burst settled, rather than by the individual events:
/// a temp-file-and-rename save produces a "removed" and a "created" for the
/// target, and the only thing that matters is that a file is there at the end.
pub fn classify<'a, I>(target: &Path, event_paths: I, exists_now: bool) -> Option<ChangeKind>
where
    I: IntoIterator<Item = &'a Path>,
{
    if !event_paths.into_iter().any(|p| concerns_target(target, p)) {
        return None;
    }
    Some(if exists_now {
        ChangeKind::Changed
    } else {
        ChangeKind::Removed
    })
}

/// The directory to watch for `target`.
///
/// The parent, never the file itself. On Linux a watch on a file follows its
/// inode, so the first atomic save (a new inode renamed into place) leaves the
/// watch listening to a deleted file and deaf to every later change. A
/// directory watch sees the rename, sees a delete followed by a recreate, and
/// keeps working after either.
pub fn watch_dir(target: &Path) -> Result<&Path, String> {
    match target.parent() {
        Some(dir) if !dir.as_os_str().is_empty() && target.file_name().is_some() => Ok(dir),
        _ => Err(format!(
            "Cannot watch {}: no parent directory",
            target.display()
        )),
    }
}

/// A live watch. Dropping it stops the watcher and its debounce thread.
pub struct Watch {
    pub path: String,
    _debouncer: Debouncer<RecommendedWatcher>,
}

/// Start watching `path`, calling `on_change` from the debouncer's thread.
///
/// Takes a callback rather than an `AppHandle` so the watching itself can be
/// tested without a running Tauri app.
pub fn start<F>(path: &str, on_change: F) -> Result<Watch, String>
where
    F: Fn(ChangeKind) + Send + 'static,
{
    let target = Path::new(path).to_path_buf();
    let dir = watch_dir(&target)?.to_path_buf();
    let handler_target = target.clone();
    let mut debouncer = new_debouncer(DEBOUNCE, move |result: DebounceEventResult| {
        let exists = handler_target.exists();
        match result {
            Ok(events) => {
                if let Some(kind) = classify(
                    &handler_target,
                    events.iter().map(|e| e.path.as_path()),
                    exists,
                ) {
                    on_change(kind);
                }
            }
            // The backend failed rather than reporting a change: on Windows this
            // is what deleting or renaming the *watched directory* looks like.
            // The file is then gone too, and saying so is the one thing the
            // frontend can act on. Any other error is unactionable, so silent.
            Err(_) if !exists => on_change(ChangeKind::Removed),
            Err(_) => {}
        }
    })
    .map_err(|e| format!("Cannot watch {path}: {e}"))?;
    debouncer
        .watcher()
        .watch(&dir, RecursiveMode::NonRecursive)
        .map_err(|e| format!("Cannot watch {path}: {e}"))?;
    Ok(Watch {
        path: path.to_string(),
        _debouncer: debouncer,
    })
}

/// One watch per window label. A window shows one document, so it has at most
/// one watch; replacing the entry drops (and so stops) the previous one.
#[derive(Default)]
pub struct FileWatches(pub Mutex<HashMap<String, Watch>>);

impl FileWatches {
    /// Stop the watch belonging to `label`, if any.
    pub fn stop(&self, label: &str) {
        // Removed under the lock but dropped after it is released: dropping a
        // debouncer only sends it a shutdown message, but there is no reason
        // to do even that while every other window waits on this mutex.
        let removed = self
            .0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(label);
        drop(removed);
    }

    /// Stop every watch whose path no longer passes `keep`.
    pub fn retain(&self, keep: impl Fn(&str) -> bool) {
        let mut watches = self.0.lock().unwrap_or_else(|e| e.into_inner());
        watches.retain(|_, w| keep(&w.path));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::mpsc;

    #[test]
    fn only_events_for_the_target_file_name_count() {
        let target = Path::new("/docs/notes.md");
        assert!(concerns_target(target, Path::new("/docs/notes.md")));
        // A differently spelled parent (symlink, 8.3 name, /private prefix) is
        // still the same file as far as a non-recursive directory watch goes.
        assert!(concerns_target(target, Path::new("/private/docs/notes.md")));
        assert!(!concerns_target(target, Path::new("/docs/notes.md.tmp")));
        assert!(!concerns_target(target, Path::new("/docs/other.md")));
        assert!(!concerns_target(target, Path::new("/")));
    }

    #[test]
    fn file_name_case_follows_the_platform() {
        let target = Path::new("/docs/Notes.md");
        let lower = Path::new("/docs/notes.md");
        assert_eq!(
            concerns_target(target, lower),
            cfg!(any(windows, target_os = "macos"))
        );
    }

    #[test]
    fn a_batch_is_classified_by_whether_the_file_exists_after_it() {
        let target = Path::new("/docs/notes.md");
        let tmp = PathBuf::from("/docs/notes.md.tmp");
        let real = PathBuf::from("/docs/notes.md");
        let sibling = PathBuf::from("/docs/other.md");

        // Temp file written, then renamed over the target: one change.
        assert_eq!(
            classify(target, [tmp.as_path(), real.as_path()], true),
            Some(ChangeKind::Changed)
        );
        // Deleted or renamed away.
        assert_eq!(
            classify(target, [real.as_path()], false),
            Some(ChangeKind::Removed)
        );
        // Only the temp file or a sibling moved: nothing to report.
        assert_eq!(classify(target, [tmp.as_path()], true), None);
        assert_eq!(classify(target, [sibling.as_path()], false), None);
        assert_eq!(classify(target, std::iter::empty(), true), None);
    }

    #[test]
    fn the_watched_directory_is_the_parent() {
        assert_eq!(
            watch_dir(Path::new("/docs/notes.md")).unwrap(),
            Path::new("/docs")
        );
        assert!(watch_dir(Path::new("notes.md")).is_err());
        assert!(watch_dir(Path::new("/")).is_err());
    }

    /// End to end against the real platform watcher: an atomic replace and a
    /// delete of the watched file are both reported, a sibling is not.
    #[test]
    fn reports_atomic_replace_and_removal_but_not_siblings() {
        let dir = std::env::temp_dir().join(format!(
            "monoleaf-watch-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("doc.md");
        std::fs::write(&file, "one").unwrap();

        let (tx, rx) = mpsc::channel();
        let watch = start(file.to_str().unwrap(), move |kind| {
            let _ = tx.send(kind);
        })
        .unwrap();
        let wait = Duration::from_secs(10);

        // A sibling alone produces nothing. Checked first and with a short
        // wait, since the absence of an event can only be observed by waiting.
        std::fs::write(dir.join("other.md"), "x").unwrap();
        assert!(rx.recv_timeout(Duration::from_millis(1000)).is_err());

        // Temp file + rename, the way most tools save.
        let tmp = dir.join("doc.md.tmp");
        std::fs::write(&tmp, "two").unwrap();
        std::fs::rename(&tmp, &file).unwrap();
        assert_eq!(rx.recv_timeout(wait), Ok(ChangeKind::Changed));
        while rx.recv_timeout(Duration::from_millis(600)).is_ok() {}

        std::fs::remove_file(&file).unwrap();
        assert_eq!(rx.recv_timeout(wait), Ok(ChangeKind::Removed));

        drop(watch);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
