// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { EditorSelection, Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import { loadCorpus } from "./corpus.testutil";
import { createDocumentState, serializeDocument } from "./document";
import { editorSetup, rawViewExtensions } from "./setup";
import { PortabilityMode, portabilityExtensions } from "./portability";
import { livePreviewExtensions } from "./livepreview";
import { commentsExtension } from "./comments";
import { criticExtension, trackingExtension } from "./critic";

/**
 * Open-and-save with no edits must leave a real document byte-identical, with
 * the editor's whole document-facing extension stack mounted, not just a bare
 * EditorState (document.test.ts covers that half).
 *
 * The stack is where a regression would come from: the markup-repair
 * transaction filter, the live preview's atomic ranges and the tracking
 * extension all see every transaction, and any of them appending a change to
 * a selection-only one would rewrite a file the user never touched. So each
 * document is mounted in every configuration the app can be in, the cursor is
 * walked through every position (as arrow keys and clicks would), and the
 * serialized text must still equal the bytes on disk.
 *
 * The corpus is samples/ plus src/__fixtures__/roundtrip/; see
 * corpus.testutil.ts.
 *
 * Mirrors editorExtensions() in main.ts minus the input handlers (paste, link
 * clicks, the formatting keymap), which only act on user input and so cannot
 * fire here. Keep the two in step when an extension is added there.
 */

interface Config {
  mode: PortabilityMode;
  live: boolean;
  tracking: boolean;
}

const CONFIGS: Config[] = [];
for (const mode of ["enhanced", "strict"] as const)
  for (const live of [true, false])
    for (const tracking of [false, true])
      CONFIGS.push({ mode, live, tracking });

const label = (c: Config) =>
  `${c.mode}, ${c.live ? "live" : "raw"}${c.tracking ? ", tracking" : ""}`;

function extensions(c: Config): Extension[] {
  return [
    editorSetup,
    portabilityExtensions(c.mode, false),
    c.live ? livePreviewExtensions() : rawViewExtensions,
    c.tracking ? trackingExtension() : [],
    commentsExtension(),
    criticExtension(),
    EditorView.lineWrapping,
  ];
}

const views: EditorView[] = [];
afterEach(() => {
  while (views.length) views.pop()!.destroy();
  document.body.innerHTML = "";
});

/** Every cursor stop worth visiting: each position for short documents, a
 * stride through long ones so the suite stays fast, always both ends. */
function cursorStops(length: number): number[] {
  const step = Math.max(1, Math.floor(length / 1000));
  const stops: number[] = [];
  for (let pos = 0; pos <= length; pos += step) stops.push(pos);
  if (stops[stops.length - 1] !== length) stops.push(length);
  return stops;
}

const files = loadCorpus();

describe("real documents survive open and save unchanged", () => {
  it("finds a corpus to check", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    describe(file.name, () => {
      // Read as the app does: Rust hands the frontend the file as UTF-8.
      const text = file.bytes.toString("utf8");

      for (const config of CONFIGS) {
        it(
          label(config),
          () => {
            const parent = document.createElement("div");
            document.body.appendChild(parent);
            const view = new EditorView({
              state: createDocumentState(text, extensions(config)),
              parent,
            });
            views.push(view);
            view.focus();

            for (const pos of cursorStops(view.state.doc.length)) {
              view.dispatch({ selection: EditorSelection.cursor(pos) });
            }
            // A selection across the whole document, as Ctrl+A would make.
            view.dispatch({
              selection: EditorSelection.range(0, view.state.doc.length),
            });

            const saved = serializeDocument(view.state);
            // The string comparison first, for a readable diff on failure; the
            // byte comparison is the actual requirement.
            expect(saved).toBe(text);
            expect(Buffer.from(saved, "utf8").equals(file.bytes)).toBe(true);
          },
          30_000,
        );
      }
    });
  }
});
