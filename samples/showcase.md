# Monoleaf feature showcase

This document demonstrates everything Monoleaf can do. Open it in the app to
see live formatting; press **Ctrl+Q** to see the raw markdown underneath, and
export it to PDF to see it paginated.

Tip: right-click and choose **Table of contents** to generate a linked
contents list here (Ctrl+click a link jumps to that heading).

## Text formatting

This paragraph mixes **bold**, *italic*, <u>underline</u>, <mark>highlight</mark>,
~~strikethrough~~ and `inline code`. Here is a [link to CommonMark](https://commonmark.org)
— in the editor, Ctrl+click it to open in your browser.

A line ending with a hard break\
continues on the next line without a new paragraph (Shift+Enter).

## Headings and text styles

Use the **Style** dropdown or Ctrl+Shift+1–3 to set headings.

### This is a Heading 3

Body text sits at 11pt to match the exported PDF exactly.

## Lists

- A bullet list item
- Another item, with **bold** inside
- A third item

1. A numbered list
2. Second step
3. Third step

- [x] A completed task
- [ ] A task still to do

## Quote and rule

> A blockquote for citations or callouts.
> It can span multiple lines.

---

## Enhanced constructs (enhanced mode)

Water is H~2~O and energy is E = mc^2^. Turn on **Flags** in Settings to see
these marked as non-portable.

## Alignment

<div align="center">

This paragraph is centered (Ctrl+E).

</div>

<div align="right">

This one is right-aligned (Ctrl+R).

</div>

## Images

Images referenced by an `https://` URL render inline (the image bytes stay at
the URL, never in this file):

<img src="https://github.com/vibingbiochemist.png" alt="Martin's GitHub avatar" width="200">

Right-click an image to resize it (Small / Medium / Large / Full / Original)
or align it left / center / right — sizing is stored as `<img width>`, which
GitHub honors. A local or relative reference like `![diagram](figure.png)`
shows its alt text instead, since Monoleaf keeps everything in the single
portable `.md`.

## A table

Right-click inside it for row/column actions, or paste a range from Excel.

| Antibody | Kd (nM) | Verdict   |
| :------- | ------: | :-------: |
| ab-101   |    0.44 | Reliable  |
| ab-102   |   12.00 | Marginal  |
| ab-103   |    0.07 | Reliable  |

## Code block

```python
def kd_ratio(bound, total):
    return bound / total
```

## Comments

The binding affinity <!--c:k7m3s-->was sub-nanomolar<!--c:k7m3e--> in the
second assay. Open the **Comments** sidebar to see the thread attached to the
highlighted phrase; a plain markdown viewer shows only the clean prose.

## Tracked changes

Turn on **Track changes** (Ctrl+Shift+E) and edit below; it produces
CriticMarkup like this: the dose was {~~10 mg~>20 mg~~} given {++once ++}daily,
and the {--preliminary --}results held. You can also {==highlight==} passages
and leave {>>a reviewer note<<} inline. Use the ✓ / ✗ toolbar buttons to accept
or reject each change.

<!--ml:pagebreak-->

## After a page break

This heading starts on a new page (inserted with Ctrl+Enter). The page
boundary is also drawn in the editor when **Page layout** is on.

Everything above lives in this single `.md` file — comments, tracked changes,
alignment, and page settings included — fully readable as plain text.

<!--c:k7m3 {"resolved":false,"thread":[{"author":"Martin","ts":"2026-07-19T09:00:00Z","text":"Can we cite the exact Kd from the repeat run here?"}]}-->

<!--ml:page {"size":"A4","margin":"20mm","header":"{title}","footer":"Page {page} of {pages}","justify":false}-->
