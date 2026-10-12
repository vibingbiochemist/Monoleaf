import { EditorState, Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

/**
 * Pick the line separator for a document, or undefined for CodeMirror's
 * default handling.
 *
 * CodeMirror's default mode splits on any of "\n", "\r\n", "\r" and rejoins
 * with "\n", which silently rewrites CRLF/CR files. Configuring an explicit
 * separator via EditorState.lineSeparator makes split+join an identity
 * transform: any occurrence of the *other* separators is treated as ordinary
 * line content and passes through untouched. So an explicit separator is
 * required whenever the text contains "\r" at all; pure-LF text is safe with
 * the default.
 */
export function detectLineSeparator(text: string): string | undefined {
  if (text.includes("\r\n")) return "\r\n";
  if (text.includes("\r")) return "\r";
  return undefined;
}

/**
 * Build an editor state whose serialization (see serializeDocument) is
 * byte-identical to `content` as long as the document is not edited.
 */
export function createDocumentState(
  content: string,
  extensions: Extension[] = [],
): EditorState {
  const separator = detectLineSeparator(content);
  return EditorState.create({
    doc: content,
    extensions: [
      separator !== undefined ? EditorState.lineSeparator.of(separator) : [],
      extensions,
    ],
  });
}

/**
 * How many document positions `text` occupies once inserted.
 *
 * Not `text.length`: a line break is ONE position in the document whatever
 * the file's separator, so a string built with state.lineBreak overcounts by
 * one per break in a CRLF file. A cursor placed with the string length lands
 * past the insert, and near the end of the document past the end itself,
 * which throws and lets the browser insert a bare "\n" instead (shown as a red
 * control character).
 */
export function insertedLength(state: EditorState, text: string): number {
  return state.toText(text).length;
}

/** Serialize the document using the state's configured line separator. */
export function serializeDocument(state: EditorState): string {
  return state.sliceDoc();
}

/**
 * `text` with every line break in it (LF, CRLF or a lone CR) rewritten as the
 * document's own separator.
 *
 * Needed for any outside text inserted as a string: in a CRLF or CR file the
 * state splits inserted text only on that file's separator, so a bare "\n"
 * from the clipboard, or from code that joins with "\n", stays inside one line
 * as a control character (two lines shown as one) and is saved as a stray LF.
 * The regex takes CRLF as one break, so a Windows clipboard can't produce a
 * doubled "\r". A no-op in an LF document, which splits on all three anyway.
 *
 * In a mixed file, copying a stray LF that the editor holds as line content
 * (see detectLineSeparator) and pasting it back turns it into a real break in
 * the file's separator. Deliberate: inserted text gets one kind of break.
 */
export function toDocumentLineBreaks(state: EditorState, text: string): string {
  return text.replace(/\r\n?|\n/g, state.lineBreak);
}

/**
 * Applies toDocumentLineBreaks to text CodeMirror pastes or drops itself, which
 * otherwise inserts the clipboard's LF verbatim into a CRLF or CR file. Paths
 * that insert clipboard text on their own (the menu's paste, Ctrl+Shift+V) do
 * not pass through here and call toDocumentLineBreaks directly.
 */
export const documentLineBreakInput = EditorView.clipboardInputFilter.of(
  (text, state) => toDocumentLineBreaks(state, text),
);
