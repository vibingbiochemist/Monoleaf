// Generates THIRD_PARTY_LICENSES.md programmatically (brief Stage 6: never
// hand-maintained). JS side via license-checker-rseidelsohn, Rust side via
// cargo-about (which also FAILS if a non-accepted license enters the tree —
// see src-tauri/about.toml). Run: npm run licenses
import { execSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const run = (cmd) =>
  execSync(cmd, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });

// --- JS dependencies -------------------------------------------------------
const packages = JSON.parse(
  run(
    "npx license-checker-rseidelsohn --production --json --excludePrivatePackages",
  ),
);

let js = "# JavaScript dependencies\n\n";
for (const [name, info] of Object.entries(packages)) {
  js += `## ${name}\n\nLicense: ${info.licenses}\n`;
  if (info.repository) js += `Repository: ${info.repository}\n`;
  js += "\n";
  if (info.licenseFile && existsSync(info.licenseFile)) {
    const text = readFileSync(info.licenseFile, "utf8").trim();
    js += "```\n" + text + "\n```\n\n";
  }
}

// --- Rust dependencies -----------------------------------------------------
// cargo-about refuses stdout capture under PowerShell (encoding issues), so
// it writes to a temp file which we read back.
const rustOut = join(tmpdir(), "monoleaf-rust-licenses.md");
run(
  `cargo about generate --manifest-path src-tauri/Cargo.toml -o "${rustOut}" src-tauri/about.hbs`,
);
const rust = readFileSync(rustOut, "utf8");
rmSync(rustOut);

const header = `<!-- GENERATED FILE - do not edit. Run: npm run licenses -->

# Third-party licenses

Monoleaf bundles the following open-source software.

`;

writeFileSync("THIRD_PARTY_LICENSES.md", header + js + rust);
console.log(
  `THIRD_PARTY_LICENSES.md written (${Object.keys(packages).length} JS packages + Rust tree).`,
);
