/**
 * Word count over the document's visible prose. The in-file machinery that a
 * reader never sees as words — comment anchors and bodies, the page-config
 * block, page-break directives — is removed first. CriticMarkup deletions are
 * dropped (they are proposed removals); everything else counts as written.
 */

const STRIP = [
  /<!--c:[a-z0-9]+[se]-->/g, // comment anchors
  /<!--c:[a-z0-9]+ \{[\s\S]*?\}-->/g, // comment bodies
  /<!--ml:page \{[\s\S]*?\}-->/g, // page config
  /<!--ml:meta \{[\s\S]*?\}-->/g, // document metadata
  /<!--ml:pagebreak-->/g, // page break
  /<!--ml:toc(-end)?-->/g, // TOC markers
  /\[!(?:NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]/gi, // admonition markers
  /\{--[\s\S]*?--\}/g, // CriticMarkup deletions
];

// Leading YAML front matter (an alternative metadata format) is not prose.
const LEADING_FRONTMATTER = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/;

export function countWords(text: string): number {
  let t = text.replace(LEADING_FRONTMATTER, " ");
  for (const re of STRIP) t = t.replace(re, " ");
  // A word: a letter/number run, allowing internal apostrophes and hyphens.
  const matches = t.match(/[\p{L}\p{N}][\p{L}\p{M}\p{N}'’-]*/gu);
  return matches === null ? 0 : matches.length;
}
