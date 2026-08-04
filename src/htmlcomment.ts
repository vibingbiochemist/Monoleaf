/**
 * Making JSON safe to carry inside an HTML comment.
 *
 * Three of Monoleaf's on-disk structures are HTML-comment blocks holding JSON —
 * review comments (`<!--c:id {…}-->`), document metadata (`<!--ml:meta {…}-->`)
 * and page config (`<!--ml:page {…}-->`). All three need the same guarantee, so
 * it lives here once: this used to be three verbatim copies, and the danger of
 * that is not the duplication but the silence — one copy could drift and no
 * test would notice.
 */

/**
 * Replace every `--` so a value cannot terminate the comment carrying it.
 *
 * `JSON.stringify` never emits `--` outside string values, and inside them
 * `-` is a legal escape for `-`, so this round-trips losslessly through
 * `JSON.parse`.
 *
 * The property that matters is about dash *runs*, not pairs. Replacing left to
 * right consumes two dashes at a time and the replacement itself starts with a
 * single dash followed by a backslash, so an odd run's carried-over dash can
 * never meet another one: `---` becomes `---`, not `--` + `-`.
 */
export function escapeDashes(json: string): string {
  return json.replace(/--/g, "-\\u002d");
}
