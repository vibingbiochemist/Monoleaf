# Security Policy

## Supported versions

Security fixes are applied to the latest released version.

| Version | Supported |
| ------- | --------- |
| 1.0.x   | ✅        |
| < 1.0   | ❌        |

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
  The one network request Monoleaf can make on its own is the optional update
  check described below, which is off until you turn it on and sends nothing
  about you or your documents.
- The app window **never navigates** — external links open in your system
  browser instead.
- Untrusted input to consider is primarily the **content of `.md` files** you
  open and **clipboard HTML** you paste; reports about how those are parsed or
  rendered are in scope.

Three consequences of that design are worth stating plainly, because they affect
anyone handling confidential documents and are not otherwise visible without
reading the source:

- **Unsaved work is stored in plaintext.** So that a crash or a forced shutdown
  does not lose your document, Monoleaf keeps a debounced snapshot of any
  unsaved draft in the webview's local storage (`src/recovery.ts`), on disk in
  your user profile, unencrypted. The snapshot is discarded once the document is
  saved. If you open a confidential document, save it — an unsaved one has a copy
  outside the file you chose.
- **Installers are unsigned, and update checks are optional and off by default.**
  Monoleaf can ask `github.com` once per launch whether a newer version exists,
  if you allow it on first run or in Settings. That is a single HTTPS request for
  a small JSON file; it carries no identifiers and nothing about you or your
  documents, though GitHub necessarily sees your IP address and the time of the
  request, as it would for any download. With checks off, Monoleaf makes no
  network request of its own. Updates are signed with a key held by the
  maintainer and the signature is verified before anything is installed, but the
  installer itself is unsigned, so Windows SmartScreen and macOS Gatekeeper will
  still warn; code signing needs a paid developer account. If you leave checks
  off, watch the
  [releases page](https://github.com/vibingbiochemist/Monoleaf/releases) for
  security fixes, because nothing will tell you.
- **Installing an update writes your unsaved work to disk first.** Installing
  replaces the running process, so before it happens every open window writes its
  unsaved draft to the plaintext snapshot described above, and the restarted app
  offers those drafts back. This is deliberate, and it is how an update avoids
  losing work, but it means an update is a moment when unsaved confidential text
  is written to your user profile unencrypted. If that matters, save your
  documents before installing.
