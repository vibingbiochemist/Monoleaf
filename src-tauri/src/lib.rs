use std::collections::{HashMap, HashSet};
use std::fs;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Condvar, Mutex};
use std::time::{Duration, Instant};
use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_updater::Update;

pub mod pdfimport;

/// The file path Monoleaf was asked to open — from being launched with a `.md`
/// argument (double-clicking an associated file). The frontend drains this on
/// startup; a second launch while running is delivered via the `open-file`
/// event instead (see the single-instance hook in `run`).
struct LaunchFile(Mutex<Option<String>>);

/// First argument that looks like a Markdown file path (ignores flags and the
/// executable path, which ends in `.exe`).
fn first_markdown_arg<I: IntoIterator<Item = String>>(args: I) -> Option<String> {
    args.into_iter().find(|a| {
        let lower = a.to_lowercase();
        !a.starts_with('-') && (lower.ends_with(".md") || lower.ends_with(".markdown"))
    })
}

/// Return and clear the pending launch file (opened via file association).
#[tauri::command]
fn take_launch_file(state: tauri::State<LaunchFile>) -> Option<String> {
    // `unwrap_or_else(into_inner)` throughout: none of this state carries an
    // invariant a panic could corrupt, so a single panic while a lock is held
    // must not poison it and turn every later call into a panic of its own.
    state.0.lock().unwrap_or_else(|e| e.into_inner()).take()
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
    // Same chrome AND same launch state as the main window (see
    // tauri.conf.json): our own title bar (decorations off) and maximized, so a
    // window spawned by New / Open / a file-association launch opens full-screen
    // like the config-defined "main" window rather than as a small floating box.
    // inner_size is the restored (un-maximized) size the window falls back to.
    let win = WebviewWindowBuilder::new(app, &label, WebviewUrl::App("index.html".into()))
        .title("Monoleaf")
        .inner_size(1000.0, 720.0)
        .maximized(true)
        .decorations(false)
        .focused(true)
        .build()
        .map_err(|e| e.to_string())?;
    // Windows can otherwise place the new window behind the current foreground
    // window; force it to the front so New / Open always surfaces the document.
    let _ = win.set_focus();
    Ok(label)
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
fn is_network_path(path: &str) -> bool {
    matches!(path.as_bytes(), [b'\\' | b'/', b'\\' | b'/', ..])
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
fn set_allow_network_paths(allow: bool) {
    ALLOW_NETWORK_PATHS.store(allow, Ordering::Relaxed);
}

#[tauri::command]
fn read_file(path: String) -> Result<String, String> {
    validate_path(&path, ALLOW_NETWORK_PATHS.load(Ordering::Relaxed))?;
    let bytes = fs::read(&path).map_err(|e| format!("Failed to read {path}: {e}"))?;
    String::from_utf8(bytes).map_err(|_| format!("{path} is not valid UTF-8 text"))
}

#[tauri::command]
fn write_file(path: String, contents: String) -> Result<(), String> {
    validate_write_path(&path, ALLOW_NETWORK_PATHS.load(Ordering::Relaxed))?;
    fs::write(&path, contents.as_bytes()).map_err(|e| format!("Failed to write {path}: {e}"))
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
            "Update postponed: {} did not confirm saving its unsaved work.",
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // The file this process was launched with (double-clicked .md), captured
    // before the window exists so the frontend can drain it on startup.
    let launch_file = first_markdown_arg(std::env::args());

    tauri::Builder::default()
        // Must be registered first. When a second instance is launched (e.g.
        // double-clicking another .md while Monoleaf is open), its argv is
        // delivered here to the running instance instead of opening a new
        // window; we forward the file and focus the window.
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            // A .md double-clicked while Monoleaf is already running opens in
            // its own new window, never replacing an already-open document.
            if let Some(path) = first_markdown_arg(argv) {
                let payload = serde_json::json!({ "path": path }).to_string();
                let _ = spawn_document_window(app, Some(payload));
            } else if let Some(win) = app.get_webview_window("main") {
                let _ = win.unminimize();
                let _ = win.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
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
        //    fails plugin initialization, which fails `Builder::run`, which the
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
        .manage(LaunchFile(Mutex::new(launch_file)))
        .manage(PendingPayloads(Mutex::new(HashMap::new())))
        .manage(WindowCounter(AtomicU32::new(1)))
        .manage(PendingUpdate(Mutex::new(None)))
        .manage(FlushGate::new())
        .invoke_handler(tauri::generate_handler![
            read_file,
            write_file,
            set_allow_network_paths,
            import_pdf_as_markdown,
            spell_suggest,
            spell_add,
            take_launch_file,
            open_document_window,
            take_window_payload,
            check_for_update,
            get_pending_update,
            download_update,
            install_update,
            discard_pending_update,
            ack_recovery_flush
        ])
        // On Windows the OS foreground-lock policy can let the config-defined
        // "main" window open *behind* whatever already has focus. Explicitly
        // raise and focus it once at startup so Monoleaf always comes to front.
        .setup(|app| {
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.unminimize();
                let _ = win.set_focus();
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn read_write_round_trip_is_byte_identical() {
        // CRLF, lone LF, lone CR, BOM, trailing spaces, no final newline
        let original: &[u8] =
            "\u{FEFF}# Title\r\nline one  \r\nlone\nmixed\rend without newline".as_bytes();

        let dir = std::env::temp_dir();
        let src = dir.join("monoleaf_rt_src.md");
        let dst = dir.join("monoleaf_rt_dst.md");
        fs::write(&src, original).unwrap();

        let contents = read_file(src.to_string_lossy().into_owned()).unwrap();
        write_file(dst.to_string_lossy().into_owned(), contents).unwrap();

        assert_eq!(fs::read(&dst).unwrap(), original);
        let _ = fs::remove_file(&src);
        let _ = fs::remove_file(&dst);
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
        assert!(write_file(bad.to_string_lossy().into_owned(), "x".into()).is_err());
        assert!(!bad.exists());
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
        // A NUL is never a path, opted in or not.
        assert!(validate_path("note.md\0.bat", false).is_err());
        assert!(validate_path("note.md\0.bat", true).is_err());
        // The extension allow-list still applies to an opted-in network path.
        assert!(validate_write_path(r"\\host\share\evil.bat", true).is_err());
    }
}
