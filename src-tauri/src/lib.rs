use base64::Engine;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Condvar, Mutex};
use std::time::{Duration, Instant};
use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_updater::Update;

mod filewatch;
pub mod pdfimport;

use filewatch::FileWatches;

/// The file path Monoleaf was asked to open — from being launched with a `.md`
/// argument (double-clicking an associated file on Windows/Linux), or from the
/// first `RunEvent::Opened` on macOS. The main window drains this once on
/// startup; anything arriving later opens in a new window instead (see the
/// single-instance hook and the run-event handler in `run`).
///
/// `taken` records that the drain has happened, under the same lock as the
/// slot, so a macOS `Opened` racing the frontend's startup is either stored in
/// time to be drained or sees `taken` and gets its own window — never stored
/// after the drain, where nothing would ever read it.
struct LaunchFile(Mutex<LaunchSlot>);

struct LaunchSlot {
    file: Option<String>,
    taken: bool,
}

impl LaunchFile {
    fn new(file: Option<String>) -> Self {
        LaunchFile(Mutex::new(LaunchSlot { file, taken: false }))
    }

    /// Return the pending file and mark the slot drained for good.
    fn take(&self) -> Option<String> {
        // `unwrap_or_else(into_inner)` throughout: none of this state carries an
        // invariant a panic could corrupt, so a single panic while a lock is held
        // must not poison it and turn every later call into a panic of its own.
        let mut slot = self.0.lock().unwrap_or_else(|e| e.into_inner());
        slot.taken = true;
        slot.file.take()
    }

    /// Store `path` as the launch file if the main window has not drained the
    /// slot yet and it is still empty. Returns false when the caller must open
    /// the file some other way (a new window).
    #[cfg(any(target_os = "macos", test))]
    fn offer(&self, path: String) -> bool {
        let mut slot = self.0.lock().unwrap_or_else(|e| e.into_inner());
        if slot.taken || slot.file.is_some() {
            return false;
        }
        slot.file = Some(path);
        true
    }
}

/// Whether a path names a Markdown file, by extension.
fn is_markdown_path(path: &str) -> bool {
    let lower = path.to_lowercase();
    lower.ends_with(".md") || lower.ends_with(".markdown")
}

/// First argument that looks like a Markdown file path (ignores flags and the
/// executable path, which ends in `.exe`).
fn first_markdown_arg<I: IntoIterator<Item = String>>(args: I) -> Option<String> {
    args.into_iter()
        .find(|a| !a.starts_with('-') && is_markdown_path(a))
}

/// An argv path made absolute against the directory the launching process was
/// started in. `monoleaf notes.md` typed in a terminal arrives relative to the
/// terminal's directory — which, for a second instance, is not ours — and the
/// file watcher and window title need the real path. One routine for first
/// and second launches, so `./notes.md` is spelled the same either way.
fn absolute_from(path: &str, cwd: &std::path::Path) -> String {
    std::path::absolute(cwd.join(path))
        .ok()
        .and_then(|p| p.into_os_string().into_string().ok())
        .unwrap_or_else(|| path.to_string())
}

/// Open `path` in a new editor window, with the payload shape
/// `take_window_payload`'s caller in main.ts expects.
fn open_in_new_window(app: &AppHandle, path: &str) {
    let payload = serde_json::json!({ "path": path }).to_string();
    let _ = spawn_document_window(app, Some(payload));
}

/// The Markdown files among the URLs macOS hands over in `RunEvent::Opened`
/// (a Finder double-click or a drop on the Dock icon). Non-file URLs and other
/// file types are ignored.
#[cfg(any(target_os = "macos", test))]
fn markdown_paths_from_urls(urls: &[tauri::Url]) -> Vec<String> {
    urls.iter()
        .filter(|u| u.scheme() == "file")
        .filter_map(|u| u.to_file_path().ok()?.into_os_string().into_string().ok())
        .filter(|p| is_markdown_path(p))
        .collect()
}

/// macOS delivers associated files as `RunEvent::Opened`, never in argv: the
/// first one becomes the launch file if the main window has not started up
/// yet, every other one opens in its own window (as on a second launch).
#[cfg(target_os = "macos")]
fn open_urls(app: &AppHandle, urls: &[tauri::Url]) {
    for path in markdown_paths_from_urls(urls) {
        if !app.state::<LaunchFile>().offer(path.clone()) {
            open_in_new_window(app, &path);
        }
    }
}

/// Return and clear the pending launch file (opened via file association).
#[tauri::command]
fn take_launch_file(state: tauri::State<LaunchFile>) -> Option<String> {
    state.take()
}

/// Payloads queued for windows created at runtime. The frontend calls
/// `open_document_window` with an opaque JSON string (a file to open, or an
/// unsaved draft to recover); the backend stashes it under the new window's
/// label, and that window drains it on startup via `take_window_payload`. The
/// backend never inspects the payload — it is purely a courier, so its shape
/// stays entirely a frontend concern.
struct PendingPayloads(Mutex<HashMap<String, String>>);

/// Monotonic source of unique labels for runtime-created windows ("win-1",
/// "win-2", …). The single config-defined window is always "main".
struct WindowCounter(AtomicU32);

/// Create a new editor window, optionally seeding it with a payload the window
/// reads on startup. Returns the new window's label.
fn spawn_document_window(app: &AppHandle, payload: Option<String>) -> Result<String, String> {
    let n = app
        .state::<WindowCounter>()
        .0
        .fetch_add(1, Ordering::Relaxed);
    let label = format!("win-{n}");
    if let Some(p) = payload {
        app.state::<PendingPayloads>()
            .0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(label.clone(), p);
    }
    // Same chrome AND same launch state as the main window (see tauri.conf.json
    // / tauri.macos.conf.json): our own title bar, maximized, everywhere except
    // macOS, where a spawned window instead gets native decorations and a
    // normal (not maximized) size — matching the platform override for the
    // config-defined "main" window, because a window builder call like this
    // one is NOT covered by the JSON config merge and would otherwise revert a
    // New/Open window to the Windows-style chrome on Mac. inner_size is the
    // restored (un-maximized) size the window falls back to. It also starts
    // hidden like "main" outside macOS, for the reason given at `reveal_window`.
    let builder = WebviewWindowBuilder::new(app, &label, WebviewUrl::App("index.html".into()))
        .title("Monoleaf")
        .inner_size(1000.0, 720.0)
        .focused(true);
    #[cfg(target_os = "macos")]
    let builder = builder.maximized(false).decorations(true);
    #[cfg(not(target_os = "macos"))]
    let builder = builder.maximized(true).decorations(false).visible(false);
    let win = builder.build().map_err(|e| e.to_string())?;
    // Windows can otherwise place the new window behind the current foreground
    // window; force it to the front so New / Open always surfaces the document.
    // (A no-op while the window is still hidden; `reveal` focuses it then.)
    let _ = win.set_focus();
    reveal_later(win);
    Ok(label)
}

/// Show a window that started hidden, and bring it to the front. Does nothing
/// to a window that is already visible.
fn reveal(win: &tauri::WebviewWindow) {
    if win.is_visible().unwrap_or(true) {
        return;
    }
    let _ = win.show();
    // Focus only after showing: tao ignores set_focus on a hidden window.
    let _ = win.unminimize();
    let _ = win.set_focus();
}

/// Called by each window's frontend once its page is laid out, to show the
/// window it starts hidden in (outside macOS: tauri.conf.json `visible: false`
/// for "main", `spawn_document_window` for the rest).
///
/// Why hidden: since tao 0.37 (Tauri 2.12) a window is made visible while it is
/// being created and only maximized afterwards, so a visible-from-the-start
/// maximized window first appeared as a black, empty maximized frame with the
/// still-unsized white WebView in one corner. Showing it once the page is ready
/// skips all of that. Sync on purpose: sync commands run on the main thread,
/// where `show` takes effect at once, so the `set_focus` after it sees a
/// visible window.
#[tauri::command]
fn reveal_window(window: tauri::WebviewWindow) {
    reveal(&window);
}

/// Safety net for `reveal_window`: if the frontend never calls it (a script
/// error before the end of main.ts, say), show the window anyway after a few
/// seconds rather than leave a running app with no window.
fn reveal_later(win: tauri::WebviewWindow) {
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(5));
        let w = win.clone();
        let _ = win.run_on_main_thread(move || reveal(&w));
    });
}

/// Open a new editor window (blank when `payload` is None). See `PendingPayloads`.
///
/// MUST stay `async`. Building a `WebviewWindow` from a *synchronous* command
/// deadlocks the main thread — the WebView2 window then loads `about:blank`
/// instead of our app, producing a blank white, unclosable window (Tauri issue
/// #13963). An async command runs off the main thread, so window creation can
/// drive the event loop and the page loads. The body stays synchronous.
#[tauri::command]
async fn open_document_window(app: AppHandle, payload: Option<String>) -> Result<String, String> {
    spawn_document_window(&app, payload)
}

/// Drain and return the payload queued for the *calling* window (see
/// `PendingPayloads`).
///
/// The label comes from the webview making the call, not from an argument.
/// Window labels are predictable ("win-1", "win-2", …), so a label parameter
/// would let any window drain another's payload — which can be a file path or
/// the recovered *contents* of an unsaved draft. Taking the caller's own label
/// removes the capability instead of validating it.
#[tauri::command]
fn take_window_payload(
    window: tauri::WebviewWindow,
    state: tauri::State<PendingPayloads>,
) -> Option<String> {
    state
        .0
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(window.label())
}

#[cfg(windows)]
mod spell {
    //! Spelling via the native Windows Spell Checking API — the same engine
    //! (and user dictionaries) the OS and WebView2 use. Checked against the
    //! user's default locale and en-US.
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::RPC_E_CHANGED_MODE;
    use windows::Win32::Globalization::{
        GetUserDefaultLocaleName, ISpellCheckerFactory, SpellCheckerFactory,
    };
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED,
    };

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    fn languages() -> Vec<String> {
        let mut langs = Vec::new();
        unsafe {
            let mut buf = [0u16; 85];
            let len = GetUserDefaultLocaleName(&mut buf);
            if len > 1 {
                langs.push(String::from_utf16_lossy(&buf[..(len as usize - 1)]));
            }
        }
        if !langs.iter().any(|l| l == "en-US") {
            langs.push("en-US".to_string());
        }
        langs
    }

    fn factory() -> Result<ISpellCheckerFactory, String> {
        unsafe {
            // `CoInitializeEx` returns a bare HRESULT with three benign
            // outcomes: S_OK (initialized here), S_FALSE (already initialized
            // in the same mode) and RPC_E_CHANGED_MODE (already initialized in
            // a different mode). The last is fine for this object: it is an
            // in-process server, so calls are direct vtable calls needing no
            // marshalling, and the apartment model does not affect them.
            //
            // Anything else — E_OUTOFMEMORY, say — is a real failure. It used
            // to be discarded, which left `CoCreateInstance` to fail with a
            // less specific error, or the whole call to report "no
            // misspellings" for the rest of the session.
            //
            // Deliberately no `CoUninitialize`: this runs on a thread we do not
            // own, and tearing COM down could break whatever else on that
            // thread is using it. Leaving it initialized is the safe direction.
            let hr = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
            if hr.is_err() && hr != RPC_E_CHANGED_MODE {
                return Err(format!("COM could not be initialized ({hr:?})"));
            }
            CoCreateInstance(&SpellCheckerFactory, None, CLSCTX_INPROC_SERVER)
                .map_err(|e| e.to_string())
        }
    }

    /// None => the word is correct (in at least one user language).
    /// Some(list) => misspelled everywhere; list holds up to `max`
    /// suggestions from the first language that flagged it.
    pub fn suggest(word: &str, max: usize) -> Result<Option<Vec<String>>, String> {
        let factory = factory()?;
        let w = wide(word);
        let mut suggestions: Option<Vec<String>> = None;
        let mut flagged = false;
        unsafe {
            for lang in languages() {
                let wl = wide(&lang);
                if !factory
                    .IsSupported(PCWSTR(wl.as_ptr()))
                    .map(|b| b.as_bool())
                    .unwrap_or(false)
                {
                    continue;
                }
                let Ok(checker) = factory.CreateSpellChecker(PCWSTR(wl.as_ptr())) else {
                    continue;
                };
                let Ok(errors) = checker.Check(PCWSTR(w.as_ptr())) else {
                    continue;
                };
                // A yielded item means the word is misspelled in this
                // language; S_FALSE with no item means it is correct.
                let mut spelling_error = None;
                let _ = errors.Next(&mut spelling_error);
                if spelling_error.is_none() {
                    return Ok(None); // correct somewhere: not misspelled
                }
                flagged = true;
                if suggestions.is_none() {
                    if let Ok(list) = checker.Suggest(PCWSTR(w.as_ptr())) {
                        let mut found = Vec::new();
                        loop {
                            let mut item = [windows::core::PWSTR::null()];
                            let mut fetched = 0u32;
                            let hr = list.Next(&mut item, Some(&mut fetched));
                            if hr.is_err() || fetched == 0 || item[0].is_null() {
                                break;
                            }
                            if let Ok(s) = item[0].to_string() {
                                found.push(s);
                            }
                            windows::Win32::System::Com::CoTaskMemFree(Some(item[0].as_ptr() as _));
                            if found.len() >= max {
                                break;
                            }
                        }
                        suggestions = Some(found);
                    }
                }
            }
        }
        if flagged {
            Ok(Some(suggestions.unwrap_or_default()))
        } else {
            Ok(None)
        }
    }

    /// For each word, whether it is misspelled in every user language: the
    /// same rule as `suggest`, so the underline and the right-click menu
    /// always agree. One factory and one checker per language for the whole
    /// batch, not per word, since the editor asks about a screenful at once.
    pub fn misspelled(words: &[String]) -> Result<Vec<bool>, String> {
        let factory = factory()?;
        let mut checkers = Vec::new();
        unsafe {
            for lang in languages() {
                let wl = wide(&lang);
                if !factory
                    .IsSupported(PCWSTR(wl.as_ptr()))
                    .map(|b| b.as_bool())
                    .unwrap_or(false)
                {
                    continue;
                }
                if let Ok(checker) = factory.CreateSpellChecker(PCWSTR(wl.as_ptr())) {
                    checkers.push(checker);
                }
            }
        }
        if checkers.is_empty() {
            return Err("no spell checker is available for the user's languages".to_string());
        }
        Ok(words
            .iter()
            .map(|word| {
                let w = wide(word);
                // Correct in any language means not misspelled. A checker
                // that fails on this word counts as "correct": an underline
                // the user cannot get rid of is worse than a missed one.
                !checkers.iter().any(|checker| unsafe {
                    match checker.Check(PCWSTR(w.as_ptr())) {
                        Ok(errors) => {
                            let mut spelling_error = None;
                            let _ = errors.Next(&mut spelling_error);
                            spelling_error.is_none()
                        }
                        Err(_) => true,
                    }
                })
            })
            .collect())
    }

    pub fn add(word: &str) -> Result<(), String> {
        let factory = factory()?;
        let w = wide(word);
        unsafe {
            for lang in languages() {
                let wl = wide(&lang);
                if let Ok(checker) = factory.CreateSpellChecker(PCWSTR(wl.as_ptr())) {
                    return checker.Add(PCWSTR(w.as_ptr())).map_err(|e| e.to_string());
                }
            }
        }
        Err("no spell checker available".to_string())
    }
}

/// `Ok(None)` means the word is correctly spelled; `Ok(Some(list))` carries
/// suggestions; `Err` means the spell checker itself failed.
///
/// The failure case is kept distinct from "correctly spelled" on purpose. It used
/// to collapse into `None`, which made an unavailable COM factory or an
/// unsupported locale indistinguishable from a document with no misspellings —
/// silently, and identically, forever. The two are visually the same to a user
/// either way, but only one of them is diagnosable.
#[tauri::command]
fn spell_suggest(word: String) -> Result<Option<Vec<String>>, String> {
    #[cfg(windows)]
    {
        spell::suggest(&word, 3)
    }
    #[cfg(not(windows))]
    {
        let _ = word;
        Ok(None)
    }
}

/// The most words one `spell_check` call will look at. The editor only asks
/// about what is on screen, so this is a guard against a runaway caller, not
/// a limit anyone should reach.
const SPELL_CHECK_MAX_WORDS: usize = 5000;

/// For each word, `true` if it is misspelled (see `spell::misspelled`). Drives
/// the editor's own underline, which replaces the webview's on Windows: that
/// one only checks words as they are typed, so an opened document never
/// showed any. Elsewhere there is no native checker here and nothing is
/// flagged; the frontend leaves those platforms to the webview.
///
/// Async, with the COM work on a blocking thread: a sync command runs on the
/// main thread, and a screenful of words must not stall the window.
#[tauri::command]
async fn spell_check(words: Vec<String>) -> Result<Vec<bool>, String> {
    if words.len() > SPELL_CHECK_MAX_WORDS {
        return Err(format!(
            "spell_check takes at most {SPELL_CHECK_MAX_WORDS} words, got {}",
            words.len()
        ));
    }
    #[cfg(windows)]
    {
        tauri::async_runtime::spawn_blocking(move || spell::misspelled(&words))
            .await
            .map_err(|e| e.to_string())?
    }
    #[cfg(not(windows))]
    {
        Ok(vec![false; words.len()])
    }
}

#[tauri::command]
fn spell_add(word: String) -> Result<(), String> {
    #[cfg(windows)]
    {
        spell::add(&word)
    }
    #[cfg(not(windows))]
    {
        let _ = word;
        Ok(())
    }
}

// File access is deliberately byte-exact: no BOM stripping, no newline
// normalization, no trailing-newline fixups. The frontend must receive and
// return exactly the bytes on disk, or the lossless round trip breaks.

// Extensions Monoleaf is permitted to write. These commands are reachable from
// any script running in the webview, so — as defense in depth behind the CSP
// and HTML sanitization that keep untrusted document content from executing —
// `write_file` refuses anything but a document type. This blocks a compromised
// page from dropping an executable or script (e.g. a `.bat`/`.lnk` in the
// Startup folder) to gain persistence; every legitimate save/export is one of
// these.
const WRITABLE_EXTS: &[&str] = &["md", "markdown", "html", "htm", "txt"];

/// The refusal the frontend recognises in order to offer the setting.
///
/// COUPLED: `main.ts` matches this text to decide whether to ask "Allow network
/// paths?" and retry. Change it here and you must change it there.
const NETWORK_PATH_REFUSED: &str = "Network paths are not supported";

/// True for a UNC/network path. Windows treats `/` and `\` alike, so
/// `//host/share` and `\\host\share` are the same thing, as are the mixed forms.
/// That rule also covers the `\\?\` and `\\.\` device forms, which can name a
/// share (`\\?\UNC\host\share`).
///
/// Also true for anything starting `\??\`. Windows hands such a path straight
/// to the NT object namespace, where `\??\UNC\host\share` is a share like any
/// other — yet it has only one leading separator, so the rule above misses it
/// and a document's `<img src>` counts it as an ordinary absolute path. Refused
/// whole rather than parsed: the namespace can reach a share by other names too
/// (`\??\GLOBALROOT\Device\Mup\...`), and nobody types a local file this way.
///
/// The cost is that verbatim local paths (`\\?\C:\x`) are refused as well. They
/// are left that way on purpose: `\\.\C:\..\UNC\host` normalizes to a share, so
/// telling the safe ones apart takes more than a prefix check, and no dialog or
/// document produces them.
fn is_network_path(path: &str) -> bool {
    matches!(
        path.as_bytes(),
        [b'\\' | b'/', b'\\' | b'/', ..] | [b'\\' | b'/', b'?', b'?', b'\\' | b'/', ..]
    )
}

/// Checks every file command applies before touching `fs`.
///
/// Merely opening a UNC path makes Windows contact that host over SMB and
/// authenticate with an NTLM handshake, which hands the host a hash of the
/// user's credentials. Refusing by default means a path a document influenced
/// cannot trigger that.
///
/// `allow_network` is the user's own decision, off unless they turn it on. Plenty
/// of people keep documents on a file server and Monoleaf has to be able to open
/// them; what the default buys is that this only ever happens because someone
/// asked for it. It is a real reduction in protection while it is on, and the
/// setting says so.
///
/// Note the frontend can set this flag, so it is not a defence against a
/// compromised frontend — but a compromised frontend can already read every
/// local file the user can. What the default protects is the credential hash,
/// which is the one thing reachable without any local read at all.
fn validate_path(path: &str, allow_network: bool) -> Result<(), String> {
    if path.contains('\0') {
        return Err("Invalid path".into());
    }
    if !allow_network && is_network_path(path) {
        return Err(NETWORK_PATH_REFUSED.into());
    }
    Ok(())
}

fn validate_write_path(path: &str, allow_network: bool) -> Result<(), String> {
    validate_path(path, allow_network)?;
    let ext = std::path::Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase);
    match ext {
        Some(e) if WRITABLE_EXTS.contains(&e.as_str()) => Ok(()),
        _ => Err(format!(
            "Refusing to write {path}: only {} files may be written",
            WRITABLE_EXTS.join(", ")
        )),
    }
}

/// Whether the user has opted into network paths. See [`validate_path`].
///
/// A process-wide flag rather than Tauri state on purpose: it keeps `read_file`
/// and `write_file` as plain one- and two-argument functions, which is what lets
/// the byte-exact round-trip test call them directly. The frontend owns the
/// preference (it is a settings toggle) and pushes it here on startup and on
/// every change, the same shape as the remote-image setting.
static ALLOW_NETWORK_PATHS: AtomicBool = AtomicBool::new(false);

#[tauri::command]
fn set_allow_network_paths(app: AppHandle, allow: bool) {
    ALLOW_NETWORK_PATHS.store(allow, Ordering::Relaxed);
    // Switching the setting off also ends any watch on a network path. A
    // watch holds an open handle on the share's directory, so leaving it
    // running would keep exactly the kind of connection the user just said
    // they no longer want Monoleaf to make.
    if !allow {
        app.state::<FileWatches>()
            .retain(|path| validate_path(path, false).is_ok());
    }
}

/// Watch the calling window's document for changes made by other programs, or
/// stop watching with `None`. See `filewatch` for what is reported and why.
///
/// The label comes from the calling window, as in `take_window_payload`: one
/// window has no business starting or stopping another's watch.
///
/// The previous watch is stopped *before* the new path is validated, so a
/// window that switches to a document that cannot be watched does not go on
/// reporting changes to the one it left.
///
/// Unlike the other file commands this one stays on the main thread. That is
/// what puts concurrent calls in order: on worker threads, a switch from one
/// document to the next could finish out of order and leave the window
/// watching the one it left. Starting a watch opens a directory handle and
/// reads no file, so it does not wait on a cloud download the way a read does.
#[tauri::command]
fn watch_file(
    window: tauri::WebviewWindow,
    state: tauri::State<FileWatches>,
    path: Option<String>,
) -> Result<(), String> {
    let label = window.label().to_string();
    state.stop(&label);
    let Some(path) = path else {
        return Ok(());
    };
    // Same gate as `read_file`: a path Monoleaf would refuse to open, it also
    // refuses to watch, since watching a share contacts the host just as
    // reading from it does.
    validate_path(&path, ALLOW_NETWORK_PATHS.load(Ordering::Relaxed))?;
    let app = window.app_handle().clone();
    let target = label.clone();
    let reported = path.clone();
    let watch = filewatch::start(&path, move |kind| {
        let _ = app.emit_to(
            target.as_str(),
            filewatch::FILE_CHANGED_EVENT,
            filewatch::FileChange {
                path: reported.clone(),
                kind,
            },
        );
    })?;
    // Inserted, not merely started: a second call that raced this one has
    // already stopped whatever was here, and the newest request wins.
    let replaced = state
        .0
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(label, watch);
    drop(replaced);
    Ok(())
}

/// Run a file command's disk work on a blocking-task thread.
///
/// A synchronous command runs on the main thread, and a read or write can take
/// seconds: a OneDrive file that is only in the cloud downloads on first read,
/// a share answers slowly, a disk flush waits for the hardware. Every window
/// freezes for that long. `find_image_by_name` and `import_pdf_as_markdown`
/// are off the main thread for the same reason; a panic becomes an error here
/// instead of taking the app down.
async fn off_main_thread<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .unwrap_or_else(|_| Err("The file operation failed unexpectedly.".into()))
}

#[tauri::command]
async fn read_file(path: String) -> Result<String, String> {
    off_main_thread(move || {
        validate_path(&path, ALLOW_NETWORK_PATHS.load(Ordering::Relaxed))?;
        let bytes = fs::read(&path).map_err(|e| format!("Failed to read {path}: {e}"))?;
        String::from_utf8(bytes).map_err(|_| format!("{path} is not valid UTF-8 text"))
    })
    .await
}

/// Off the main thread, so two saves can now overlap (an autosave firing during
/// Ctrl+S). Their order is kept by the frontend, which sends one write at a
/// time; see `writeFileInOrder` in `main.ts`.
#[tauri::command]
async fn write_file(path: String, contents: String) -> Result<(), String> {
    off_main_thread(move || {
        validate_write_path(&path, ALLOW_NETWORK_PATHS.load(Ordering::Relaxed))?;
        replace_file(std::path::Path::new(&path), contents.as_bytes())
            .map_err(|e| format!("Failed to write {path}: {e}"))
    })
    .await
}

/// Distinguishes the temporary files of writes running at the same time.
static TEMP_FILE_COUNTER: AtomicU64 = AtomicU64::new(0);

/// Replace `path`'s contents so that it holds either the old bytes or the new
/// ones, never something in between.
///
/// Writing in place truncates first, so a crash, a full disk or a dropped
/// network connection partway through left the document empty or cut short.
/// Instead the new bytes go to a temporary file beside it, are flushed to the
/// disk, and are then renamed over the original, which replaces it in one step
/// (on Windows too: `fs::rename` replaces an existing file). The temporary
/// file sits in the same folder because a rename cannot cross volumes. Its
/// name is short and fixed rather than derived from the document's, so a
/// document whose name is near the 255-character limit can still be saved; it
/// reads as scratch if a crash leaves it behind, and the file watcher ignores
/// it because only the document's own name counts as a change (see
/// `filewatch`).
///
/// A symlink is resolved first and the file it points at is replaced. Renaming
/// over the link itself would turn it into an ordinary file and silently cut
/// it off from the file it shared. A link whose target is missing is an error
/// rather than a file created at the target. A link that points at a network
/// share is followed, as `read_file` follows it: the network-path check looks
/// at the path the user gave, and planting such a link already takes local
/// access.
///
/// A read-only file is refused before anything is written, as writing in place
/// refused it. A rename does not ask whether the target is writable, only the
/// folder, so without this check a save would quietly replace it. The old
/// file's permissions are copied to the new one; otherwise a private note
/// (0600 on macOS/Linux) would become readable by everyone (0644) on its first
/// save.
///
/// Everything else the old file carried beyond its bytes does not survive: a
/// hard link to it keeps the old contents; ownership, ACLs, the hidden
/// attribute, alternate data streams and creation time are those of a new file
/// in that folder; and the name's capitalisation becomes that of the path saved
/// to. Editors that save this way (VS Code, vim) make the same trade.
fn replace_file(path: &std::path::Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;

    let target = match fs::symlink_metadata(path) {
        Ok(meta) if meta.file_type().is_symlink() => fs::canonicalize(path)?,
        _ => path.to_path_buf(),
    };
    let existing = fs::metadata(&target).ok();
    if existing
        .as_ref()
        .is_some_and(|m| m.permissions().readonly())
    {
        return Err(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            "the file is read-only",
        ));
    }
    // The time as well as the process and counter, so a file left behind by a
    // crashed run can never block a later run that got the same process id.
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let temp = target.with_file_name(format!(
        ".~monoleaf-{}-{}-{now}.tmp",
        std::process::id(),
        TEMP_FILE_COUNTER.fetch_add(1, Ordering::Relaxed)
    ));
    // `create_new`: never truncate a file that happens to have this name, and
    // only clean up a temporary file this call created.
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temp)?;
    let written = file
        .write_all(bytes)
        .and_then(|()| file.sync_all())
        .and_then(|()| match &existing {
            Some(meta) => fs::set_permissions(&temp, meta.permissions()),
            None => Ok(()),
        });
    // Closed before the rename or removal: Windows refuses both on an open file.
    drop(file);
    let result = written.and_then(|()| rename_retrying(&temp, &target));
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
}

/// `fs::rename`, retried for about a second while Windows reports the target
/// as in use. A virus scanner, the search indexer or a sync client (OneDrive,
/// Dropbox) often holds a just-changed file open for a moment, and replacing
/// it fails until they let go. Writing in place was rarely refused this way,
/// so without the retry an autosave would now fail at random. npm and VS Code
/// retry here for the same reason.
fn rename_retrying(from: &std::path::Path, to: &std::path::Path) -> std::io::Result<()> {
    // ERROR_SHARING_VIOLATION; "access denied" is how the rest shows up.
    const SHARING_VIOLATION: i32 = 32;
    let mut attempt = 0;
    loop {
        match fs::rename(from, to) {
            Err(e)
                if cfg!(windows)
                    && attempt < 9
                    && (e.kind() == std::io::ErrorKind::PermissionDenied
                        || e.raw_os_error() == Some(SHARING_VIOLATION)) =>
            {
                attempt += 1;
                std::thread::sleep(Duration::from_millis(20 * attempt));
            }
            result => return result,
        }
    }
}

/// Map a file extension to the MIME type an `<img>` needs to decode it.
///
/// An explicit, closed list rather than a guess (e.g. from magic bytes):
/// anything not on it is refused with a clear error instead of being served
/// under a wrong or made-up type.
fn image_mime_type(ext: &str) -> Option<&'static str> {
    match ext {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        "svg" => Some("image/svg+xml"),
        "bmp" => Some("image/bmp"),
        "avif" => Some("image/avif"),
        _ => None,
    }
}

/// Read a local image referenced by a document (`![](diagram.png)`,
/// `<img src="../x.png">`) and hand it back as a `data:` URL the webview can
/// decode with no extra permission — the CSP already permits `img-src data:`
/// unconditionally.
///
/// Guarded by the same [`validate_path`] every file command uses: the
/// frontend already has this level of disk access via `read_file`, so this
/// adds no new capability, only a new way to reach the same one. No separate
/// directory scoping on top — see `validate_path`'s doc comment for why.
///
/// Images larger than [`IMAGE_MAX_BYTES`] are refused. The whole file is held
/// in memory three times over (bytes, base64, the webview's decoded copy), and
/// a document pointing at a multi-gigabyte file would otherwise exhaust memory
/// rather than show a broken picture.
#[tauri::command]
async fn read_image_as_data_url(path: String) -> Result<String, String> {
    off_main_thread(move || {
        validate_path(&path, ALLOW_NETWORK_PATHS.load(Ordering::Relaxed))?;
        let ext = std::path::Path::new(&path)
            .extension()
            .and_then(|e| e.to_str())
            .map(str::to_ascii_lowercase);
        let mime = ext
            .as_deref()
            .and_then(image_mime_type)
            .ok_or_else(|| format!("{path} is not a supported image type"))?;
        let bytes = read_capped(&path, IMAGE_MAX_BYTES)
            .map_err(|e| format!("Failed to read {path}: {e}"))?
            .ok_or_else(|| {
                format!(
                    "{path} is too large to show (the limit is {} MB)",
                    IMAGE_MAX_BYTES / 1024 / 1024
                )
            })?;
        let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
        Ok(format!("data:{mime};base64,{encoded}"))
    })
    .await
}

const IMAGE_MAX_BYTES: u64 = 50 * 1024 * 1024;

/// The file's bytes, or `None` if it is larger than `max`. The size is checked
/// on the open handle, so it is the same file that is then read, and the read
/// itself is capped in case the file grows in between.
fn read_capped(path: &str, max: u64) -> std::io::Result<Option<Vec<u8>>> {
    use std::io::Read;

    let file = fs::File::open(path)?;
    if file.metadata()?.len() > max {
        return Ok(None);
    }
    let mut bytes = Vec::new();
    file.take(max + 1).read_to_end(&mut bytes)?;
    Ok((bytes.len() as u64 <= max).then_some(bytes))
}

/// How deep below the document's folder [`find_image_by_name`] looks, and how
/// many directory entries it visits before giving up. Both are caps on cost,
/// not tuning knobs: a document's figures sit beside it or a folder or two
/// down, and a tree that needs more than this is not one a stray image
/// reference should make the editor crawl for every missing picture.
const IMAGE_SEARCH_MAX_DEPTH: usize = 4;
const IMAGE_SEARCH_MAX_ENTRIES: usize = 20_000;

/// Find files named `name` beneath `dir` (the open document's folder), for a
/// reference whose own path did not load — the Obsidian-style "wherever the
/// image is" fallback, bounded to the document's own tree.
///
/// Breadth-first, so the shallowest matches win: the search stops at the end
/// of the first depth level holding any match and returns everything found on
/// that level. One result is the answer; several mean the name is ambiguous,
/// and the caller says so instead of guessing. Hidden folders (`.git`,
/// `.obsidian`), `node_modules` and symlinks are skipped — the first two
/// because figures never live there, the last so a link loop cannot defeat
/// the depth cap. Matching is case-insensitive: the user who typed `Plot.PNG`
/// for `plot.png` meant that file.
///
/// `name` must be a bare file name with an image extension. This command
/// reads no file itself, but what it returns feeds `read_image_as_data_url`,
/// and a caller handing it a path segment would be a bug worth failing on
/// rather than searching for.
///
/// Async, on a blocking-task thread, like `import_pdf_as_markdown`: a
/// synchronous command runs on the main thread, and a walk of up to 20 000
/// entries — each a stat, possibly over SMB when network paths are allowed —
/// would freeze every window for its duration, once per broken reference.
#[tauri::command]
async fn find_image_by_name(dir: String, name: String) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || find_images_named(&dir, &name))
        .await
        .unwrap_or_else(|_| Err("The image search failed unexpectedly.".into()))
}

fn find_images_named(dir: &str, name: &str) -> Result<Vec<String>, String> {
    validate_path(dir, ALLOW_NETWORK_PATHS.load(Ordering::Relaxed))?;
    if name.is_empty() || name.contains(['/', '\\']) {
        return Err(format!("{name:?} is not a file name"));
    }
    let ext = std::path::Path::new(name)
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase);
    if ext.as_deref().and_then(image_mime_type).is_none() {
        return Err(format!("{name} is not a supported image type"));
    }
    let wanted = name.to_lowercase();

    let mut level = vec![std::path::PathBuf::from(dir)];
    let mut visited = 0usize;
    for _depth in 0..=IMAGE_SEARCH_MAX_DEPTH {
        let mut matches = Vec::new();
        let mut next = Vec::new();
        for folder in &level {
            let Ok(entries) = fs::read_dir(folder) else {
                continue;
            };
            for entry in entries.flatten() {
                visited += 1;
                if visited > IMAGE_SEARCH_MAX_ENTRIES {
                    matches.sort();
                    return Ok(matches);
                }
                let Ok(kind) = entry.file_type() else {
                    continue;
                };
                let file_name = entry.file_name();
                let file_name = file_name.to_string_lossy();
                if kind.is_dir() {
                    if !file_name.starts_with('.') && file_name != "node_modules" {
                        next.push(entry.path());
                    }
                } else if kind.is_file() && file_name.to_lowercase() == wanted {
                    matches.push(entry.path().to_string_lossy().into_owned());
                }
            }
        }
        if !matches.is_empty() {
            matches.sort();
            return Ok(matches);
        }
        if next.is_empty() {
            break;
        }
        level = next;
    }
    Ok(Vec::new())
}

/// Convert a PDF to Markdown for opening as a new, unsaved document.
///
/// Unlike `read_file` this is not a passthrough: there is no lossless round trip
/// to protect, because the imported document has no file on disk yet. The
/// returned Markdown is the document, and the PDF is never written to.
///
/// The conversion runs on a blocking-task thread rather than in the command
/// itself. Parsing a large PDF is seconds of CPU work — on the main thread it
/// would freeze the window — and `spawn_blocking` additionally turns a panic
/// deep inside the parser into a failed join, i.e. an error dialog, instead of
/// taking the app down with it.
#[tauri::command]
async fn import_pdf_as_markdown(path: String) -> Result<pdfimport::PdfImport, String> {
    tauri::async_runtime::spawn_blocking(move || pdfimport::import(&path))
        .await
        .unwrap_or_else(|_| {
            Err("This PDF could not be imported: the converter failed unexpectedly.".into())
        })
}

// ---------------------------------------------------------------------------
// Updates
//
// The frontend is given NO updater permissions: the plugin's own commands
// (`plugin:updater|check` and friends) are ACL-gated and nothing in
// capabilities/default.json grants them, so the webview cannot reach them. What
// it can call is the three commands below, which are ours and therefore not
// ACL-gated at all. That is the whole point of the arrangement — the decision to
// contact a remote host and run an installer stays in Rust, where document
// content cannot influence it.
//
// The shape is check -> download -> install, as three separate calls rather than
// the plugin's `download_and_install`, because a download must not begin until
// the user has been told an update exists, and an install must not begin until
// every window has flushed its recovery snapshot (see `flush_recovery_snapshots`).
// ---------------------------------------------------------------------------

/// How long the *manifest* request may take before the check is abandoned.
///
/// Applies only to fetching latest.json, not to downloading the installer:
/// `Updater::check` deliberately constructs its `Update` with `timeout: None`
/// (tauri-plugin-updater 2.10.1, updater.rs:553), so a short timeout here cannot
/// cut off a slow download later. Twenty seconds is chosen for the case this has
/// to survive rather than the happy path: a filtered corporate DNS or a proxy
/// that blackholes the request fails by hanging, not by refusing, and the
/// alternative to a bounded wait is a "Checking…" state that never resolves.
///
/// Gated to release builds because that is where the only use of it is; in a
/// debug build the check is compiled out, and an unused const is a `dead_code`
/// warning, which the gate treats as an error.
#[cfg(not(debug_assertions))]
const UPDATE_CHECK_TIMEOUT: Duration = Duration::from_secs(20);

/// Asks the receiving window to write its recovery snapshot NOW, bypassing the
/// 1500 ms debounce in `scheduleAutosaveRecovery`. The payload is the round id,
/// which the window must hand back to `ack_recovery_flush`.
///
/// COUPLED: `src/main.ts` listens for this and answers. A window that does not
/// answer blocks the install (by design — see `flush_recovery_snapshots`), so
/// renaming this event silently disables updating rather than breaking loudly.
const FLUSH_RECOVERY_EVENT: &str = "flush-recovery";

/// How long every window gets to acknowledge the flush before the install is
/// abandoned.
///
/// No human is in this loop — nothing is being asked of the user — so this is
/// bounded by machine speed, and the write itself is a synchronous
/// `localStorage.setItem` of one document. What it actually has to absorb is a
/// window whose main thread is busy: a Paged.js pagination pass over a long
/// document is seconds of uninterruptible layout work in that window, and it
/// cannot service the event until that finishes. Three seconds covers that on a
/// slow machine while keeping the worst case — click Install, nothing visible
/// happens, then "update postponed" — short enough to read as a hiccup.
const FLUSH_ACK_TIMEOUT: Duration = Duration::from_secs(3);

/// The update that has been found, and its bytes once downloaded.
///
/// The bytes live here rather than being re-fetched at install time on purpose.
/// `Update::install` needs them, so the alternative is a network round trip
/// *between* "every window has snapshotted its unsaved work" and "the process is
/// replaced" — which is the one place in this sequence where an unbounded wait
/// must not be.
struct PendingUpdate(Mutex<Option<PendingInstall>>);

struct PendingInstall {
    update: Update,
    /// `None` until `download_update` has run. `install_update` refuses without it.
    bytes: Option<Vec<u8>>,
}

/// Tracks one round of "every window, flush your recovery snapshot".
///
/// A `Condvar` rather than a channel because the interesting state is *which
/// windows have not answered yet* — that is both the wait predicate and, on
/// timeout, the diagnostic. A round id makes a late answer harmless: an
/// acknowledgement for a round that has already been resolved is ignored instead
/// of being counted towards the next one.
struct FlushGate {
    round: Mutex<Option<FlushRound>>,
    acknowledged: Condvar,
    next_round: AtomicU64,
}

struct FlushRound {
    id: u64,
    /// Labels still to answer. Empty means the round succeeded.
    awaiting: HashSet<String>,
}

impl FlushGate {
    fn new() -> Self {
        Self {
            round: Mutex::new(None),
            acknowledged: Condvar::new(),
            next_round: AtomicU64::new(1),
        }
    }
}

/// What the frontend is told about an available update.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateInfo {
    version: String,
    notes: Option<String>,
}

/// Download progress, sent over an `ipc::Channel` the frontend supplies.
///
/// One flat shape rather than a tagged enum: `rename_all` on an enum renames its
/// variants, not the fields inside them, so a tagged enum would hand the frontend
/// `content_length` while every other field it receives is camelCase. A progress
/// bar needs "how much of how many, and is it finished" and nothing else.
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct DownloadProgress {
    downloaded: u64,
    /// `None` when the server sent no Content-Length — the bar has to go
    /// indeterminate rather than pretend to know a total.
    content_length: Option<u64>,
    done: bool,
}

/// Look for an update. `Ok(None)` means "nothing to offer", including every
/// failure of an automatic check.
///
/// `user_initiated` decides who hears about a failure. Someone who clicked
/// "Check for updates" is owed an answer, even if it is "DNS lookup failed". An
/// automatic check has no such contract: no network, a captive portal, a
/// filtered DNS resolver and a 404 from a repository with no published release
/// yet are all ordinary, all outside the user's control, and reporting them
/// would train people to dismiss the one message that matters.
///
/// COMPILED OUT OF DEV BUILDS. In a `debug_assertions` build this returns
/// `Ok(None)` without contacting anything, so `npm run tauri dev` can never
/// offer — or install — a production release over a working tree. The command
/// still exists in both profiles so the frontend needs no build-time awareness
/// of which one it is running in. Note this also disables it for
/// `tauri build --debug`, which is the right side to err on.
#[tauri::command]
async fn check_for_update(
    app: AppHandle,
    user_initiated: bool,
) -> Result<Option<UpdateInfo>, String> {
    #[cfg(debug_assertions)]
    {
        let _ = (&app, user_initiated);
        Ok(None)
    }

    #[cfg(not(debug_assertions))]
    {
        // Imported here rather than at the top of the file: in a debug build the
        // body below is compiled out and the trait would be an unused import.
        use tauri_plugin_updater::UpdaterExt;

        let checked = async {
            let updater = app
                .updater_builder()
                .timeout(UPDATE_CHECK_TIMEOUT)
                .build()?;
            updater.check().await
        }
        .await;

        match checked {
            Ok(Some(update)) => {
                let info = UpdateInfo {
                    version: update.version.clone(),
                    notes: update.body.clone(),
                };
                app.state::<PendingUpdate>()
                    .0
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .replace(PendingInstall {
                        update,
                        bytes: None,
                    });
                Ok(Some(info))
            }
            Ok(None) => Ok(None),
            // Deliberately swallowed for an automatic check. There is no logging
            // in this binary to send it to, and inventing a channel for an error
            // nobody is meant to see would be the wrong shape.
            Err(_) if !user_initiated => Ok(None),
            Err(e) => Err(e.to_string()),
        }
    }
}

/// What is currently on offer, for a window that was not open when the check
/// happened.
///
/// Read-only, and deliberately so: it contacts nothing and decides nothing, it
/// reports the state `check_for_update` already put there. That is what makes it
/// safe to call from every window at startup — a window opening cannot cause a
/// network request, which is the property the consent switch is protecting.
///
/// `None` in a debug build, because `check_for_update` never populates the state
/// there. No `cfg` needed to arrange that; it falls out.
#[tauri::command]
fn get_pending_update(app: AppHandle) -> Option<UpdateInfo> {
    let state = app.state::<PendingUpdate>();
    let guard = state.0.lock().unwrap_or_else(|e| e.into_inner());
    guard.as_ref().map(|pending| UpdateInfo {
        version: pending.update.version.clone(),
        notes: pending.update.body.clone(),
    })
}

/// Download the update found by `check_for_update`, reporting progress.
#[tauri::command]
async fn download_update(
    app: AppHandle,
    on_progress: Channel<DownloadProgress>,
) -> Result<(), String> {
    // Cloned out of the mutex, and the guard dropped, before the first await: a
    // `std::sync::MutexGuard` is not `Send` and holding one across an await
    // point would not compile — but more to the point, this download takes
    // seconds and must not hold a lock the other commands need.
    let update = {
        let pending = app.state::<PendingUpdate>();
        let guard = pending.0.lock().unwrap_or_else(|e| e.into_inner());
        guard
            .as_ref()
            .map(|pending| pending.update.clone())
            .ok_or("There is no update to download.")?
    };

    let mut downloaded: u64 = 0;
    let bytes = update
        .download(
            |chunk_len, content_length| {
                downloaded += chunk_len as u64;
                let _ = on_progress.send(DownloadProgress {
                    downloaded,
                    content_length,
                    done: false,
                });
            },
            // Nothing here on purpose. `download` runs this callback *before* it
            // verifies the signature, so reporting completion from it would tell
            // the frontend the update was ready and then fail.
            || {},
        )
        .await
        .map_err(|e| e.to_string())?;

    // A second check could have replaced the pending update while this was in
    // flight; attaching these bytes to a different version would install
    // something nobody agreed to.
    let state = app.state::<PendingUpdate>();
    let mut guard = state.0.lock().unwrap_or_else(|e| e.into_inner());
    match guard.as_mut() {
        Some(pending) if pending.update.version == update.version => {
            pending.bytes = Some(bytes);
            // Signalled here rather than from the download callback: this is the
            // first point at which the bytes are verified AND stored, which is
            // what "ready to install" has to mean.
            let _ = on_progress.send(DownloadProgress {
                downloaded,
                content_length: Some(downloaded),
                done: true,
            });
            Ok(())
        }
        _ => Err("The pending update changed while it was downloading.".into()),
    }
}

/// Forget whatever update has been checked for or downloaded.
///
/// Switching update checks off has to reach Rust, not just stop the next check:
/// an update already sitting in `PendingUpdate` would otherwise keep
/// `install_update` armed, so a banner left on screen — or a stale one in another
/// window — could still install something the user has just declined.
#[tauri::command]
fn discard_pending_update(app: AppHandle) {
    let state = app.state::<PendingUpdate>();
    *state.0.lock().unwrap_or_else(|e| e.into_inner()) = None;
}

/// Ask every window to flush its recovery snapshot, and wait for all of them.
///
/// Nothing is being asked of the user here, so there is no cancellation to
/// detect and no negative answer to interpret: a window either acknowledges or
/// it does not. Any window that does not is treated as a refusal and the install
/// is abandoned, because the cost of guessing wrong in the other direction is
/// somebody's unsaved document. A missed update is the safe failure.
///
/// Blocking, so callers must keep it off the main thread (see `install_update`).
fn flush_recovery_snapshots(app: &AppHandle) -> Result<(), String> {
    let gate = app.state::<FlushGate>();
    let asked: HashSet<String> = app.webview_windows().keys().cloned().collect();
    if asked.is_empty() {
        return Ok(());
    }

    let id = gate.next_round.fetch_add(1, Ordering::Relaxed);
    {
        let mut round = gate.round.lock().unwrap_or_else(|e| e.into_inner());
        *round = Some(FlushRound {
            id,
            awaiting: asked.clone(),
        });
    }

    // Addressed per window rather than broadcast, so the set that is asked and
    // the set that is awaited are the same set by construction.
    for label in &asked {
        let _ = app.emit_to(label.as_str(), FLUSH_RECOVERY_EVENT, id);
    }

    // Ok(labels) is the answer to "who had not answered when we stopped waiting";
    // Err is "this round is not ours to answer for any more".
    let waited: Result<Vec<String>, String> = {
        let mut round = gate.round.lock().unwrap_or_else(|e| e.into_inner());
        let deadline = Instant::now() + FLUSH_ACK_TIMEOUT;
        loop {
            // A round that was cleared or replaced is deliberately NOT treated as
            // a success. Nothing can do that today — `install_update` takes the
            // pending update before it gets here, so a second install finds
            // nothing to install and never opens a round — but "someone else
            // resolved this" must not be allowed to read as "every window
            // confirmed", or a later second caller would install over unsaved work.
            match round.as_ref() {
                Some(current) if current.id == id => {}
                _ => break Err("Update postponed: preparing to install was superseded.".into()),
            }
            if round
                .as_ref()
                .is_some_and(|current| current.awaiting.is_empty())
            {
                break Ok(Vec::new());
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                break Ok(round
                    .as_ref()
                    .map(|current| current.awaiting.iter().cloned().collect())
                    .unwrap_or_default());
            }
            // wait_timeout, not a sleep-and-poll loop: an acknowledgement that
            // arrives before the wait starts is not lost, because the predicate
            // above is state rather than a signal.
            let (guard, _) = gate
                .acknowledged
                .wait_timeout(round, remaining)
                .unwrap_or_else(|e| e.into_inner());
            round = guard;
        }
    };

    // Cleared before the result is propagated, so an abandoned round never
    // outlives the attempt that opened it.
    {
        let mut round = gate.round.lock().unwrap_or_else(|e| e.into_inner());
        if round.as_ref().is_some_and(|current| current.id == id) {
            *round = None;
        }
    }

    let outstanding = waited?;
    if !outstanding.is_empty() {
        // Named by window title, not by label: "win-2" is an internal name and
        // tells the user nothing, whereas the title is the document they are
        // looking at. The most likely reason a window withholds its
        // acknowledgement is that storage refused the write, which the user can
        // only resolve in that specific window.
        let named: Vec<String> = outstanding
            .iter()
            .map(|label| {
                app.get_webview_window(label)
                    .and_then(|window| window.title().ok())
                    .unwrap_or_else(|| label.clone())
            })
            .collect();
        return Err(format!(
            "Update postponed: {} hasn't confirmed saving its unsaved work yet.",
            named.join(", ")
        ));
    }

    // A window that appeared *during* the round was never asked, and one kind of
    // late window is not safe to lose: a window opened to hold a recovered draft
    // is marked unsaved while its localStorage snapshot has already been
    // consumed by the startup sweep, so until the user types there is no copy of
    // it anywhere but that window. A file opened by association is clean and
    // would be harmless, but this cannot tell the two apart, so it declines.
    let appeared: Vec<String> = app
        .webview_windows()
        .keys()
        .filter(|label| !asked.contains(*label))
        .cloned()
        .collect();
    if !appeared.is_empty() {
        return Err(format!(
            "Update postponed: {} opened while preparing to install.",
            appeared.join(", ")
        ));
    }

    Ok(())
}

/// A window reporting that it has written its recovery snapshot.
///
/// The label comes from the calling window, never from an argument — the same
/// reasoning as `take_window_payload`, and here it also means no window can
/// acknowledge on another's behalf and let the install proceed over an
/// unsnapshotted document.
#[tauri::command]
fn ack_recovery_flush(window: tauri::WebviewWindow, state: tauri::State<FlushGate>, round: u64) {
    {
        let mut current = state.round.lock().unwrap_or_else(|e| e.into_inner());
        match current.as_mut() {
            Some(active) if active.id == round => {
                active.awaiting.remove(window.label());
            }
            // A stale or unknown round: the install it belonged to has already
            // been resolved one way or the other.
            _ => return,
        }
    }
    state.acknowledged.notify_all();
}

/// Install the downloaded update, after every window has secured its unsaved work.
///
/// No window is closed by this: the existing close guard owns that interaction,
/// and the window the user clicked in has already dealt with its own unsaved
/// state before invoking this. What happens instead is that the process is
/// replaced — `Update::install` hands off to the NSIS installer and ends in
/// `std::process::exit(0)` (updater.rs:865), so nothing after that call runs and
/// anything that must happen first happens before it. The installer relaunches
/// the app, which is intended: the restarted main window sweeps localStorage and
/// offers back exactly the snapshots the flush below just wrote.
#[tauri::command]
async fn install_update(app: AppHandle) -> Result<(), String> {
    let pending = {
        let state = app.state::<PendingUpdate>();
        let mut guard = state.0.lock().unwrap_or_else(|e| e.into_inner());
        guard.take().ok_or("There is no update to install.")?
    };

    // Taken out rather than borrowed, so put it back on every path that does not
    // install: an abandoned install must be retryable without downloading again.
    let restore = |pending: PendingInstall| {
        app.state::<PendingUpdate>()
            .0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .replace(pending);
    };

    if pending.bytes.is_none() {
        restore(pending);
        return Err("The update has not been downloaded yet.".into());
    }

    // Off the main thread: the wait below blocks for up to FLUSH_ACK_TIMEOUT, and
    // the windows it is waiting on cannot answer while the event loop is stuck.
    let flushing = app.clone();
    let flushed = tauri::async_runtime::spawn_blocking(move || flush_recovery_snapshots(&flushing))
        .await
        .unwrap_or_else(|_| Err("Update postponed: preparing to install failed.".into()));
    if let Err(e) = flushed {
        restore(pending);
        return Err(e);
    }

    // Borrowed for the duration of the call only, so `pending` can still be
    // moved back into the mutex on the failure path below.
    if let Err(e) = pending
        .update
        .install(pending.bytes.as_deref().unwrap_or_default())
    {
        // Reachable only if the handoff failed before the installer launched —
        // on success the process is already gone.
        let message = e.to_string();
        restore(pending);
        return Err(message);
    }
    Ok(())
}

/// True for a URL served by the app itself: the bundled frontend, which wry
/// serves as `tauri://localhost` on macOS/Linux and `http(s)://tauri.localhost`
/// on Windows, or — in `tauri dev` only — the Vite dev server. Everything else
/// leaves the app. IPC is a fetch to ipc.localhost, not a navigation, so it
/// never reaches this.
fn is_app_url(url: &tauri::Url, dev_url: Option<&tauri::Url>) -> bool {
    let host = url.host_str();
    match url.scheme() {
        "tauri" if host == Some("localhost") => true,
        "http" | "https" if host == Some("tauri.localhost") => true,
        _ => dev_url.is_some_and(|dev| dev.origin() == url.origin()),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // The file this process was launched with (double-clicked .md), captured
    // before the window exists so the frontend can drain it on startup.
    let cwd = std::env::current_dir().unwrap_or_default();
    let launch_file = first_markdown_arg(std::env::args()).map(|p| absolute_from(&p, &cwd));

    tauri::Builder::default()
        // Must be registered first. When a second instance is launched (e.g.
        // double-clicking another .md while Monoleaf is open), its argv is
        // delivered here to the running instance instead of opening a new
        // window; we forward the file and focus the window.
        .plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
            // A .md double-clicked while Monoleaf is already running opens in
            // its own new window, never replacing an already-open document.
            // A plain relaunch surfaces "main", or — if the user closed that
            // one — whichever document window is still open.
            if let Some(path) = first_markdown_arg(argv) {
                open_in_new_window(app, &absolute_from(&path, cwd.as_ref()));
            } else if let Some(win) = app
                .get_webview_window("main")
                .or_else(|| app.webview_windows().into_values().next())
            {
                let _ = win.unminimize();
                let _ = win.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        // Defence in depth behind the frontend's link interception: a window
        // that navigates away has lost its editor, and there is no back
        // button. Only leaving the app is refused; a same-origin link would
        // still reload it (refusing that would also refuse reload in dev), so
        // the frontend interception stays the primary guard. A plugin hook
        // rather than WebviewWindowBuilder::on_navigation
        // because it covers every webview, including the config-defined "main"
        // window that no builder call here creates.
        .plugin(
            tauri::plugin::Builder::<_, ()>::new("navigation-guard")
                .on_navigation(|webview, url| {
                    let dev_url = webview.config().build.dev_url.as_ref();
                    is_app_url(url, dev_url.filter(|_| tauri::is_dev()))
                })
                .build(),
        )
        // The updater. Its configuration lives in `plugins.updater` in
        // tauri.conf.json, which is strict JSON and cannot hold comments, so the
        // four things a reader needs to know about it are recorded here.
        //
        // COUPLED: everything below describes keys in tauri.conf.json. Change
        // them there and this comment is what tells the next person why they
        // were what they were.
        //
        // 1. WHY `pubkey` IS IN THE BASE CONFIG. The plugin's `Config` declares
        //    `pubkey: String` with no serde default, and Tauri hands a plugin
        //    `Value::Null` when its config key is absent — so a missing pubkey
        //    fails plugin initialization, which fails `Builder::build`, which the
        //    `.expect` at the bottom of this function turns into a panic. Not "a
        //    working app with a dead updater": an app that does not start. It is
        //    safe to keep here because a public key demands no signing secret;
        //    only `bundle.createUpdaterArtifacts` does, which is why that one
        //    key lives in tauri.release.conf.json5 and must never move here.
        //
        // 2. WHAT THE ENDPOINT RESOLVES TO. GitHub defines
        //    /releases/latest/download/ as the most recent release that is
        //    neither a draft nor a prerelease. Our release workflow opens every
        //    release as a draft, and marks any tag containing "-" a prerelease,
        //    so a draft and an rc serve nothing until deliberately published as
        //    a full release. That is the intended safety property: nothing can
        //    reach users because a tag was pushed.
        //
        // 3. WHY `installMode` IS PINNED TO "passive" RATHER THAN LEFT DEFAULT.
        //    Passive is also the plugin's default, but it is stated explicitly
        //    because the behaviour is user-visible: it skips every installer
        //    page except the progress page, and passes NSIS `/R`, so the app is
        //    relaunched after installing. THE RELAUNCH IS INTENDED — it is what
        //    lets the restarted main window sweep localStorage and offer back
        //    the recovery snapshots taken just before installing. Do not try to
        //    suppress it: it cannot be suppressed at this version anyway
        //    (`nsis_args()` prepends `/R` for passive and quiet, `installer_args`
        //    only appends, and the mode that omits `/R` — basicUi — turns the
        //    install into a full click-through wizard whose finish page reruns
        //    the app from a pre-checked box).
        //
        // 4. THE TRAP WHEN EDITING OR TESTING. Endpoints are validated when the
        //    plugin initializes, by a custom `Deserialize` (2.10.1 config.rs:
        //    126-132 and 145-164). A non-https endpoint only warns in a debug
        //    build; in a release build it is `Err(InsecureTransportProtocol)`,
        //    so the app fails to start. A plain http test server is therefore
        //    not an option, and `dangerousInsecureTransportProtocol` must never
        //    be set to make one work.
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(LaunchFile::new(launch_file))
        .manage(PendingPayloads(Mutex::new(HashMap::new())))
        .manage(WindowCounter(AtomicU32::new(1)))
        .manage(PendingUpdate(Mutex::new(None)))
        .manage(FlushGate::new())
        .manage(FileWatches::default())
        .invoke_handler(tauri::generate_handler![
            read_file,
            write_file,
            read_image_as_data_url,
            find_image_by_name,
            set_allow_network_paths,
            watch_file,
            import_pdf_as_markdown,
            spell_suggest,
            spell_check,
            spell_add,
            take_launch_file,
            open_document_window,
            take_window_payload,
            reveal_window,
            check_for_update,
            get_pending_update,
            download_update,
            install_update,
            discard_pending_update,
            ack_recovery_flush
        ])
        // A closed window's document is no longer anyone's concern; without
        // this its watch (and debounce thread) would outlive it and keep
        // emitting to a label nothing listens on.
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                window.state::<FileWatches>().stop(window.label());
            }
        })
        // On Windows the OS foreground-lock policy can let the config-defined
        // "main" window open *behind* whatever already has focus. Explicitly
        // raise and focus it once at startup so Monoleaf always comes to front.
        // Outside macOS it is still hidden here, which makes these no-ops; the
        // same raise then happens when it is revealed (see `reveal_window`).
        .setup(|app| {
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.unminimize();
                let _ = win.set_focus();
                reveal_later(win);
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        // macOS hands associated files to a running (or just-launching) app as
        // `Opened`, not argv; nothing else needs run events today.
        .run(|_app, _event| {
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Opened { urls } = &_event {
                open_urls(_app, urls);
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;
    use tauri::async_runtime::block_on;

    #[test]
    fn a_relative_launch_path_resolves_against_the_launching_cwd() {
        let cwd = std::env::temp_dir();
        let expected = cwd.join("notes.md");
        let expected = expected.to_str().unwrap();
        assert_eq!(absolute_from("notes.md", &cwd), expected);
        // `./` is dropped, so it names the file the same way as without it.
        assert_eq!(absolute_from("./notes.md", &cwd), expected);
        let abs = cwd.join("elsewhere").join("a.md");
        let abs = abs.to_str().unwrap();
        assert_eq!(absolute_from(abs, std::path::Path::new("/other")), abs);
    }

    #[test]
    fn opened_urls_keep_only_markdown_files() {
        let md = std::env::temp_dir().join("Notes.MD");
        let urls = [
            tauri::Url::from_file_path(&md).unwrap(),
            tauri::Url::from_file_path(std::env::temp_dir().join("a.txt")).unwrap(),
            tauri::Url::parse("https://example.com/readme.md").unwrap(),
        ];
        assert_eq!(
            markdown_paths_from_urls(&urls),
            vec![md.to_str().unwrap().to_string()]
        );
    }

    // The macOS race: an `Opened` before the main window drains the slot is
    // stored for it; one after (or a second one before) must be refused so the
    // caller opens a window for it — never stored where nothing reads it.
    #[test]
    fn the_launch_slot_takes_one_file_until_drained_then_refuses() {
        let slot = LaunchFile::new(None);
        assert!(slot.offer("a.md".into()));
        assert!(!slot.offer("b.md".into()));
        assert_eq!(slot.take().as_deref(), Some("a.md"));
        assert!(!slot.offer("c.md".into()));
        assert_eq!(slot.take(), None);

        let drained_empty = LaunchFile::new(None);
        assert_eq!(drained_empty.take(), None);
        assert!(!drained_empty.offer("d.md".into()));

        let from_argv = LaunchFile::new(Some("argv.md".into()));
        assert!(!from_argv.offer("e.md".into()));
        assert_eq!(from_argv.take().as_deref(), Some("argv.md"));
    }

    // Against the real Windows spell checker, so Windows-only. en-US is always
    // among the languages tried (see spell::languages).
    #[cfg(windows)]
    #[test]
    fn spell_check_flags_only_words_wrong_in_every_language() {
        let words: Vec<String> = ["the", "teh", "sentence", "sentense", "Monday"]
            .iter()
            .map(|w| w.to_string())
            .collect();
        assert_eq!(
            spell::misspelled(&words).unwrap(),
            vec![false, true, false, true, false]
        );
        assert_eq!(spell::misspelled(&[]).unwrap(), Vec::<bool>::new());
    }

    #[test]
    fn spell_check_refuses_an_oversized_batch() {
        let words = vec!["a".to_string(); SPELL_CHECK_MAX_WORDS + 1];
        let result = tauri::async_runtime::block_on(spell_check(words));
        assert!(result.is_err());
    }

    #[test]
    fn read_write_round_trip_is_byte_identical() {
        // CRLF, lone LF, lone CR, BOM, trailing spaces, no final newline
        let original: &[u8] =
            "\u{FEFF}# Title\r\nline one  \r\nlone\nmixed\rend without newline".as_bytes();

        let dir = std::env::temp_dir();
        let src = dir.join("monoleaf_rt_src.md");
        let dst = dir.join("monoleaf_rt_dst.md");
        fs::write(&src, original).unwrap();

        let contents = block_on(read_file(src.to_string_lossy().into_owned())).unwrap();
        block_on(write_file(dst.to_string_lossy().into_owned(), contents)).unwrap();

        assert_eq!(fs::read(&dst).unwrap(), original);
        let _ = fs::remove_file(&src);
        let _ = fs::remove_file(&dst);
    }

    /// A fresh, empty folder of its own, so a leftover temporary file is
    /// visible as an extra directory entry.
    fn empty_test_dir(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn entries(dir: &std::path::Path) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    #[test]
    fn write_file_creates_and_replaces_without_leaving_a_temp_file() {
        let dir = empty_test_dir("monoleaf_atomic_write");
        let doc = dir.join("note.md");
        let path = doc.to_string_lossy().into_owned();

        block_on(write_file(path.clone(), "first".into())).unwrap();
        assert_eq!(fs::read_to_string(&doc).unwrap(), "first");
        // Shorter than before: a replace, not an overwrite that leaves a tail.
        block_on(write_file(path.clone(), "2nd".into())).unwrap();
        assert_eq!(fs::read_to_string(&doc).unwrap(), "2nd");
        assert_eq!(entries(&dir), ["note.md"]);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_failed_write_leaves_the_original_and_no_temp_file() {
        let dir = empty_test_dir("monoleaf_atomic_write_fail");
        // A folder where the document should be: the rename onto it fails
        // after the temporary file was written.
        fs::create_dir(dir.join("note.md")).unwrap();
        let path = dir.join("note.md").to_string_lossy().into_owned();

        let err = block_on(write_file(path.clone(), "x".into())).unwrap_err();
        assert!(
            err.starts_with(&format!("Failed to write {path}: ")),
            "{err}"
        );
        assert!(dir.join("note.md").is_dir());
        assert_eq!(entries(&dir), ["note.md"]);

        let _ = fs::remove_dir_all(&dir);
    }

    /// Saving through a symlink replaces the file it points at and leaves the
    /// link a link. Creating a symlink needs Developer Mode or admin rights on
    /// Windows, so there the test passes vacuously when it cannot make one.
    #[test]
    fn write_file_through_a_symlink_keeps_the_link() {
        let dir = empty_test_dir("monoleaf_atomic_write_link");
        let real = dir.join("real.md");
        let link = dir.join("link.md");
        fs::write(&real, "old").unwrap();
        #[cfg(windows)]
        let made = std::os::windows::fs::symlink_file(&real, &link);
        #[cfg(unix)]
        let made = std::os::unix::fs::symlink(&real, &link);
        if made.is_ok() {
            block_on(write_file(
                link.to_string_lossy().into_owned(),
                "new".into(),
            ))
            .unwrap();
            assert!(fs::symlink_metadata(&link)
                .unwrap()
                .file_type()
                .is_symlink());
            assert_eq!(fs::read_to_string(&real).unwrap(), "new");
            assert_eq!(entries(&dir), ["link.md", "real.md"]);
        }
        let _ = fs::remove_dir_all(&dir);
    }

    /// Replacing by rename must not widen a private file's permissions, nor
    /// replace a read-only file the old in-place write would have refused.
    #[cfg(unix)]
    #[test]
    fn write_file_keeps_permissions_and_refuses_read_only_files() {
        use std::os::unix::fs::PermissionsExt;

        let dir = empty_test_dir("monoleaf_atomic_write_mode");
        let private = dir.join("private.md");
        fs::write(&private, "old").unwrap();
        fs::set_permissions(&private, fs::Permissions::from_mode(0o600)).unwrap();
        block_on(write_file(
            private.to_string_lossy().into_owned(),
            "new".into(),
        ))
        .unwrap();
        assert_eq!(fs::read_to_string(&private).unwrap(), "new");
        let mode = fs::metadata(&private).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);

        let locked = dir.join("locked.md");
        fs::write(&locked, "old").unwrap();
        fs::set_permissions(&locked, fs::Permissions::from_mode(0o444)).unwrap();
        let path = locked.to_string_lossy().into_owned();
        let err = block_on(write_file(path.clone(), "new".into())).unwrap_err();
        assert!(
            err.starts_with(&format!("Failed to write {path}: ")),
            "{err}"
        );
        assert_eq!(fs::read_to_string(&locked).unwrap(), "old");
        assert_eq!(entries(&dir), ["locked.md", "private.md"]);

        let _ = fs::remove_dir_all(&dir);
    }

    /// The Windows counterpart: the read-only attribute is refused, not
    /// replaced.
    #[cfg(windows)]
    #[test]
    fn write_file_refuses_read_only_files() {
        let dir = empty_test_dir("monoleaf_atomic_write_readonly");
        let locked = dir.join("locked.md");
        fs::write(&locked, "old").unwrap();
        let mut perms = fs::metadata(&locked).unwrap().permissions();
        perms.set_readonly(true);
        fs::set_permissions(&locked, perms.clone()).unwrap();
        let path = locked.to_string_lossy().into_owned();
        assert!(block_on(write_file(path, "new".into())).is_err());
        assert_eq!(fs::read_to_string(&locked).unwrap(), "old");
        assert_eq!(entries(&dir), ["locked.md"]);

        #[allow(clippy::permissions_set_readonly_false)]
        perms.set_readonly(false);
        fs::set_permissions(&locked, perms).unwrap();
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn read_capped_refuses_files_over_the_limit() {
        let dir = empty_test_dir("monoleaf_read_capped");
        let file = dir.join("img.png");
        fs::write(&file, b"12345").unwrap();
        let path = file.to_string_lossy().into_owned();
        assert_eq!(read_capped(&path, 5).unwrap(), Some(b"12345".to_vec()));
        assert_eq!(read_capped(&path, 4).unwrap(), None);
        let _ = fs::remove_dir_all(&dir);
    }

    /// Exercises the real COM path: initialize, create the factory, check a
    /// word. Asserts only that the call *succeeds*, not what the dictionary
    /// thinks — the installed languages differ per machine, but initialization
    /// failing is exactly what a mistake in `factory()` would cause.
    #[cfg(windows)]
    #[test]
    fn the_spell_checker_initializes_and_answers() {
        for word in ["hello", "zzqwxv"] {
            let result = spell::suggest(word, 3);
            assert!(
                result.is_ok(),
                "spell check failed for {word:?}: {:?}",
                result.err()
            );
        }
        // And a correctly spelled English word is not reported as misspelled,
        // since en-US is always among the languages checked.
        assert_eq!(spell::suggest("hello", 3), Ok(None));
    }

    #[test]
    fn write_file_only_accepts_document_extensions() {
        // Document types the app legitimately saves/exports.
        assert!(validate_write_path("C:/Users/x/note.md", false).is_ok());
        assert!(validate_write_path("/tmp/brief.markdown", false).is_ok());
        assert!(validate_write_path("/tmp/export.html", false).is_ok());
        assert!(validate_write_path("/tmp/notes.txt", false).is_ok());
        // Executable/script droppers and extensionless paths are refused.
        assert!(validate_write_path("C:/Users/x/Startup/evil.bat", false).is_err());
        assert!(validate_write_path("/tmp/evil.exe", false).is_err());
        assert!(validate_write_path("/tmp/evil.lnk", false).is_err());
        assert!(validate_write_path("/tmp/noextension", false).is_err());
        // And the command itself refuses to touch disk for a bad path.
        let bad = std::env::temp_dir().join("monoleaf_evil.bat");
        assert!(block_on(write_file(bad.to_string_lossy().into_owned(), "x".into())).is_err());
        assert!(!bad.exists());
    }

    #[test]
    fn read_image_as_data_url_round_trips_and_picks_mime_type() {
        let cases: &[(&str, &str, &[u8])] = &[
            (
                "monoleaf_img_test.png",
                "image/png",
                b"\x89PNG not-a-real-image-but-bytes-are-bytes",
            ),
            (
                "monoleaf_img_test.svg",
                "image/svg+xml",
                b"<svg xmlns='x'></svg>",
            ),
            (
                "monoleaf_img_test.JPG",
                "image/jpeg",
                b"\xff\xd8\xff\xe0 pretend jpeg",
            ),
        ];
        for (name, mime, bytes) in cases {
            let path = std::env::temp_dir().join(name);
            fs::write(&path, bytes).unwrap();

            let data_url =
                block_on(read_image_as_data_url(path.to_string_lossy().into_owned())).unwrap();
            let prefix = format!("data:{mime};base64,");
            assert!(
                data_url.starts_with(&prefix),
                "{name}: expected prefix {prefix:?}, got {data_url:?}"
            );
            let decoded = base64::engine::general_purpose::STANDARD
                .decode(&data_url[prefix.len()..])
                .unwrap();
            assert_eq!(&decoded, bytes, "{name}: payload did not round-trip");

            let _ = fs::remove_file(&path);
        }
    }

    #[test]
    fn read_image_as_data_url_rejects_non_image_extensions() {
        for name in ["monoleaf_img_reject.txt", "monoleaf_img_reject.exe"] {
            let path = std::env::temp_dir().join(name);
            fs::write(&path, b"not an image").unwrap();
            let result = block_on(read_image_as_data_url(path.to_string_lossy().into_owned()));
            assert!(result.is_err(), "{name} should have been refused");
            let _ = fs::remove_file(&path);
        }
        // Extensionless, and a path that never existed: both are refused
        // (the former on the extension check, the latter reaches fs::read
        // only for a path that would have passed it).
        assert!(block_on(read_image_as_data_url("no_extension_here".into())).is_err());
    }

    #[test]
    fn read_image_as_data_url_rejects_network_paths_unless_allowed() {
        // ALLOW_NETWORK_PATHS defaults to false and no other test in this
        // binary flips it, so this observes the real default rather than a
        // value another test happened to leave behind.
        for path in [
            r"\\attacker.test\share\note.png",
            "//attacker.test/share/note.png",
        ] {
            assert_eq!(
                block_on(read_image_as_data_url(path.to_string())),
                Err(NETWORK_PATH_REFUSED.to_string()),
                "not rejected: {path}"
            );
        }
    }

    #[test]
    fn find_image_by_name_prefers_the_shallowest_match_and_reports_duplicates() {
        let root = std::env::temp_dir().join("monoleaf_find_image_test");
        let _ = fs::remove_dir_all(&root);
        for sub in ["figures/sub", ".hidden", "node_modules/pkg", "a/b/c/d/e"] {
            fs::create_dir_all(root.join(sub)).unwrap();
        }
        for file in [
            "figures/plot.png",
            "figures/sub/plot.png", // deeper than the first: not reported
            ".hidden/secret.png",   // hidden folder: skipped
            "node_modules/pkg/logo.png",
            "a/b/c/d/e/deep.png", // depth 5, beyond the cap of 4
            "figures/Dup.PNG",
            "a/dup.png",
        ] {
            fs::write(root.join(file), b"x").unwrap();
        }
        let dir = root.to_string_lossy().into_owned();
        let find = |name: &str| find_images_named(&dir, name);

        // Joined segment by segment: `join("figures/plot.png")` would keep the
        // forward slash on Windows and never equal what read_dir hands back.
        let expected = root.join("figures").join("plot.png");
        assert_eq!(
            find("plot.png").unwrap(),
            vec![expected.to_string_lossy().into_owned()]
        );
        // Case-insensitive, and two files on the same level are both reported.
        let dups = find("dup.png").unwrap();
        assert_eq!(dups.len(), 2, "{dups:?}");
        for name in ["secret.png", "logo.png", "deep.png", "missing.png"] {
            assert!(find(name).unwrap().is_empty(), "{name} should not be found");
        }
        // Not a bare image file name: refused before any directory is read.
        assert!(find("notes.md").is_err());
        assert!(find("sub/plot.png").is_err());
        assert!(find("").is_err());

        let _ = fs::remove_dir_all(&root);
    }

    /// Both file commands refuse UNC/network paths *unless the user has opted
    /// in*. Asserted on the shared validator, not by calling the commands:
    /// before this guard existed the commands would reach `fs`, and on Windows
    /// that is precisely the SMB handshake (and the multi-second timeout) the
    /// guard exists to prevent.
    #[test]
    fn file_commands_reject_network_paths_unless_allowed() {
        for path in [
            r"\\attacker.test\share\note.md",
            "//attacker.test/share/note.md",
            r"\/attacker.test/share/note.md",
            r"/\attacker.test\share\note.md",
            // NT-namespace and device forms of the same share.
            r"\??\UNC\attacker.test\share\note.md",
            "/??/UNC/attacker.test/share/note.md",
            r"\??\GLOBALROOT\Device\Mup\attacker.test\share\note.md",
            r"\\?\UNC\attacker.test\share\note.md",
            "//?/UNC/attacker.test/share/note.md",
            r"\\.\UNC\attacker.test\share\note.md",
        ] {
            assert_eq!(
                validate_path(path, false),
                Err(NETWORK_PATH_REFUSED.to_string()),
                "not rejected with the setting off: {path}"
            );
            // write_file layers the extension check on top of the same guard.
            assert!(
                validate_write_path(path, false).is_err(),
                "not rejected: {path}"
            );
            // Opted in: the user's own network share has to be usable.
            assert!(
                validate_path(path, true).is_ok(),
                "still rejected with the setting on: {path}"
            );
            assert!(
                validate_write_path(path, true).is_ok(),
                "still rejected with the setting on: {path}"
            );
        }
        // A single leading separator is an ordinary absolute path.
        assert!(validate_path("/tmp/note.md", false).is_ok());
        assert!(validate_path(r"C:\Users\x\note.md", false).is_ok());
        assert!(validate_path(r"C:\??\note.md", false).is_ok());
        // A NUL is never a path, opted in or not.
        assert!(validate_path("note.md\0.bat", false).is_err());
        assert!(validate_path("note.md\0.bat", true).is_err());
        // The extension allow-list still applies to an opted-in network path.
        assert!(validate_write_path(r"\\host\share\evil.bat", true).is_err());
    }

    #[test]
    fn navigation_guard_allows_only_the_app_itself() {
        let u = |s: &str| tauri::Url::parse(s).unwrap();
        let dev = u("http://localhost:1420");
        for ok in [
            "tauri://localhost",
            "tauri://localhost/index.html",
            "http://tauri.localhost/",
            "https://tauri.localhost/index.html#x",
        ] {
            assert!(is_app_url(&u(ok), None), "refused: {ok}");
        }
        assert!(is_app_url(
            &u("http://localhost:1420/index.html"),
            Some(&dev)
        ));
        for bad in [
            "https://example.com/",
            "http://localhost:1420/", // dev server outside `tauri dev`
            "tauri://example.com/",
            "https://tauri.localhost.example.com/",
            "about:blank",
            "file:///C:/x.html",
            "data:text/html,x",
        ] {
            assert!(!is_app_url(&u(bad), None), "allowed: {bad}");
        }
        // Same host, other port: a different origin.
        assert!(!is_app_url(&u("http://localhost:1421/"), Some(&dev)));
    }
}
