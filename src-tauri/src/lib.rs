use std::collections::HashMap;
use std::fs;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

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
        .manage(LaunchFile(Mutex::new(launch_file)))
        .manage(PendingPayloads(Mutex::new(HashMap::new())))
        .manage(WindowCounter(AtomicU32::new(1)))
        .invoke_handler(tauri::generate_handler![
            read_file,
            write_file,
            set_allow_network_paths,
            import_pdf_as_markdown,
            spell_suggest,
            spell_add,
            take_launch_file,
            open_document_window,
            take_window_payload
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
