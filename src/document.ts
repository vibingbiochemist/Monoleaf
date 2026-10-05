import { EditorState, Extension } from "@codemirror/state";

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
