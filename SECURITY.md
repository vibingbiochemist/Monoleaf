# Security Policy

## Supported versions

Security fixes are applied to the latest released version.

| Version | Supported |
| ------- | --------- |
| 0.9.x   | ✅        |
| < 0.9   | ❌        |

## Reporting a vulnerability

**Please do not report security issues in public GitHub issues.**

Use GitHub's private reporting instead: go to the repository's **Security** tab
and choose **"Report a vulnerability"** (Private vulnerability reporting). This
opens a confidential channel with the maintainer.

If you're unable to use private reporting, email
**info@monoleaf.org** instead.

Please include:

- a description of the issue and its impact,
- steps to reproduce (a minimal `.md` if relevant),
- the Monoleaf version (shown in the **ⓘ** About view) and your OS.

You can expect an initial acknowledgement within a few days. Once a fix is
released, we're happy to credit you unless you prefer to remain anonymous.

## Scope & posture

Monoleaf is a **local, offline** desktop app:

- Documents never leave your machine; there is no account, cloud, or telemetry.
- The app window **never navigates** — external links open in your system
  browser instead.
- Untrusted input to consider is primarily the **content of `.md` files** you
  open and **clipboard HTML** you paste; reports about how those are parsed or
  rendered are in scope.

Two consequences of that design are worth stating plainly, because they affect
anyone handling confidential documents and are not otherwise visible without
reading the source:

- **Unsaved work is stored in plaintext.** So that a crash or a forced shutdown
  does not lose your document, Monoleaf keeps a debounced snapshot of any
  unsaved draft in the webview's local storage (`src/recovery.ts`), on disk in
  your user profile, unencrypted. The snapshot is discarded once the document is
  saved. If you open a confidential document, save it — an unsaved one has a copy
  outside the file you chose.
- **Installers are unsigned and there is no auto-update.** Monoleaf never phones
  home, which also means it will not tell you that a security fix exists. Updates
  are a manual download and reinstall, so watch the
  [releases page](https://github.com/vibingbiochemist/Monoleaf/releases) if that
  matters to you. Windows SmartScreen and macOS Gatekeeper will warn about the
  unsigned installer; code signing needs a paid developer account.
