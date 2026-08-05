# Contributing to Monoleaf

Thanks for your interest in improving Monoleaf! This document explains how to
build, test, and submit changes.

## Ground rules — the immutable principles

Monoleaf has a few design invariants. A change that breaks any of these will
not be merged, no matter how useful it otherwise is:

1. **The raw Markdown is the single source of truth.** The editor edits the
   text directly; there is no hidden document model.
2. **One file.** Everything a document needs travels *inside* the `.md`. No
   companion files, no sidecars, no database. (Explicit PDF/HTML *export* is the
   only output that leaves the file.)
3. **Lossless, byte-for-byte round-trip.** Loading a file and saving it with no
   edits must produce an identical file — line endings, BOM, trailing newline
   and all. This is covered by tests; keep them green.
4. **Graceful degradation.** Anything beyond CommonMark + GFM must still read
   sensibly in a plain Markdown viewer (e.g. callouts are blockquotes, config
   lives in HTML comments).
5. **No ProseMirror/Tiptap, no pandoc.** Rendering is CodeMirror in the editor
   and markdown-it for export.
6. **Local and private.** No network calls for document content, no telemetry.

## Getting set up

Requires **Node + npm** and a **Rust toolchain** (MSVC on Windows).

```bash
npm install
npm run tauri dev        # run the app
```

## Before you open a pull request

Every change must pass:

```bash
npx tsc --noEmit                                   # type-check
npm run lint                                       # ESLint
npm run format:check                               # Prettier
npm test                                           # Vitest suite
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml    # Rust unit + integration
```

There is also an end-to-end suite that launches the built application and checks
it from outside — that it starts and runs its own frontend, that a file given on
the command line opens, and that a second launch gets its own window. It needs a
release build first, and it is **Windows-only**: it enumerates windows through
PowerShell, so on Linux and macOS it skips itself and exits cleanly.

```bash
npm run tauri build                                # the suite tests this binary
npm run test:e2e                                   # ~35s; skips off Windows
```

Not required for a pull request, since CI covers the cross-platform builds — but
worth running if you touch application startup, window creation, or the build
itself, because that is the class of bug the unit suites cannot see.

- **Add tests** for new behavior. Editor commands live in `src/commands.ts` and
  are tested headlessly in `src/commands.test.ts` via a real `EditorState`;
  follow that pattern.
- **Match the surrounding style** — naming, comment density, and idioms. Prefer
  small, focused changes.
- **Keep it type-safe** — no `any` escapes; `tsc` must be clean.

## Pull request flow

1. Fork and create a feature branch off `main`.
2. Make your change with tests; ensure the three checks above pass.
3. Write a clear commit message describing the *why*, not just the *what*.
4. Open a PR against `main` with a short description and any relevant context.

## Reporting bugs and ideas

Open a [GitHub issue](https://github.com/vibingbiochemist/Monoleaf/issues). For a bug,
include your OS, the Monoleaf version (in the **ⓘ** About view), and a minimal
`.md` that reproduces it. For security issues, please follow
[SECURITY.md](SECURITY.md) instead of filing a public issue.

By contributing, you agree that your contributions are licensed under the
project's [MIT License](LICENSE).
