# Portability sample

## Portable baseline (never flagged, parsed in both modes)

**Bold**, *italic*, `code`, [a link](https://example.com), ~~strikethrough~~.

| Table | GFM |
|-------|-----|
| yes   | ok  |

- [x] task list item
- [ ] open item

Autolink: www.example.com

## Beyond the baseline (flagged in enhanced mode only)

Water is H~2~O (subscript).

The 5^th^ element (superscript).

Emoji shortcode: :smile: and :rocket:

In strict mode all three lines above are plain literal text — exactly what a
dumb viewer shows.
