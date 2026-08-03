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
