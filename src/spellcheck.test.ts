// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { ensureSyntaxTree } from "@codemirror/language";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import { markdownForMode } from "./portability";
import {
  extractWords,
  recheckWord,
  resetSpellCacheForTests,
  spellUnderlines,
} from "./spellcheck";

function words(doc: string): string[] {
  const state = EditorState.create({
    doc,
    extensions: markdownForMode("enhanced"),
  });
  ensureSyntaxTree(state, doc.length, 5000);
  return extractWords(state, 0, doc.length).map((w) => w.word);
}

describe("extractWords", () => {
  it("finds plain words, keeping apostrophes and accented letters", () => {
    expect(words("Don't worry, Müller's café é.")).toEqual([
      "Don't",
      "worry",
      "Müller's",
      "café",
    ]);
  });

  it("checks link text but not the address", () => {
    expect(
      words("See [the docs](https://exmple.com/pth) and <https://a.b>"),
    ).toEqual(["See", "the", "docs", "and"]);
  });

  it("skips code, inline and fenced", () => {
    expect(
      words("Use `cnst` here.\n\n```js\nlet wrods = 1;\n```\n\nDone"),
    ).toEqual(["Use", "here", "Done"]);
  });

  it("skips HTML tags, entities and images but keeps the text between tags", () => {
    expect(
      words(
        'A <span class="clss">vizible</span>&nbsp;word ![alt txt](imgs/pic.png)',
      ),
    ).toEqual(["vizible", "word"]);
  });

  it("checks commented text but not the comment syntax", () => {
    expect(
      words(
        '<!--c:a1s-->comented text<!--c:a1e-->\n\n<!--c:a1 {"resolved":false,"thread":[]}-->',
      ),
    ).toEqual(["comented", "text"]);
  });

  it("skips math, emoji, footnote and callout markers", () => {
    expect(
      words(
        "Area $x^2 + yy$ is :sparkles: big[^nte].\n\n> [!NOTE]\n> Hello\n\n$$\n\\frac{aa}{bb}\n$$",
      ),
    ).toEqual(["Area", "is", "big", "Hello"]);
  });

  it("skips front matter", () => {
    expect(words("---\ntitle: Tset\nauthor: Me\n---\n\nBody txt")).toEqual([
      "Body",
      "txt",
    ]);
  });

  it("skips single letters and words glued to digits, underscores or paths", () => {
    expect(words("a H2O x86 snake_case dir/file C:\\Users ok")).toEqual(["ok"]);
  });
});

describe("spell underlines", () => {
  const MISSPELLED = new Set(["teh", "wrods"]);
  let views: EditorView[] = [];

  beforeEach(() => {
    vi.useFakeTimers();
    resetSpellCacheForTests();
    invokeMock.mockReset();
    invokeMock.mockImplementation(
      async (cmd: string, args: { words: string[] }) => {
        if (cmd !== "spell_check") throw new Error(`unexpected ${cmd}`);
        return args.words.map((w) => MISSPELLED.has(w));
      },
    );
  });

  afterEach(() => {
    for (const v of views) v.destroy();
    views = [];
    vi.useRealTimers();
  });

  function mount(doc: string): EditorView {
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const state = EditorState.create({
      doc,
      extensions: [markdownForMode("enhanced"), spellUnderlines()],
    });
    ensureSyntaxTree(state, doc.length, 5000);
    const view = new EditorView({ state, parent });
    views.push(view);
    return view;
  }

  const underlined = (view: EditorView) =>
    Array.from(view.dom.querySelectorAll(".cm-misspelled")).map(
      (e) => e.textContent,
    );

  async function settle() {
    await vi.advanceTimersByTimeAsync(300);
    await vi.runAllTimersAsync();
  }

  it("underlines the words the checker flags, in one batched call", async () => {
    const view = mount("Fix teh wrods in teh text.");
    expect(underlined(view)).toEqual([]);
    await settle();
    expect(underlined(view)).toEqual(["teh", "wrods", "teh"]);
    expect(invokeMock).toHaveBeenCalledTimes(1);
    // Each distinct word asked about once.
    expect(invokeMock.mock.calls[0][1].words.sort()).toEqual(
      ["Fix", "in", "teh", "text", "wrods"].sort(),
    );
  });

  it("does not judge the word being typed until the cursor moves on", async () => {
    const view = mount("Good start ");
    await settle();
    const end = view.state.doc.length;
    view.dispatch({
      changes: { from: end, insert: "teh" },
      selection: EditorSelection.cursor(end + 3),
      userEvent: "input.type",
    });
    await settle();
    expect(underlined(view)).toEqual([]);
    view.dispatch({ selection: EditorSelection.cursor(0) });
    expect(underlined(view)).toEqual(["teh"]);
  });

  it("drops an underline once the word was added to the dictionary", async () => {
    const view = mount("A wrods test.");
    await settle();
    expect(underlined(view)).toEqual(["wrods"]);
    MISSPELLED.delete("wrods");
    recheckWord(view, "wrods");
    await settle();
    expect(underlined(view)).toEqual([]);
    MISSPELLED.add("wrods");
  });

  it("underlines nothing, and stops asking, when the checker fails", async () => {
    invokeMock.mockRejectedValue(new Error("no checker"));
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const view = mount("Fix teh wrods.");
    await settle();
    expect(underlined(view)).toEqual([]);
    view.dispatch({
      changes: { from: 0, insert: "More " },
      userEvent: "input.type",
    });
    await settle();
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(errors).toHaveBeenCalledTimes(1);
    errors.mockRestore();
  });
});
