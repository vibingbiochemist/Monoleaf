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

/** Serialize the document using the state's configured line separator. */
export function serializeDocument(state: EditorState): string {
  return state.sliceDoc();
}
