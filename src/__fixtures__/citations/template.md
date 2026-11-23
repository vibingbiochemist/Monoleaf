---
csl: chicago-author-date
bibliography: example.bib
suppress-bibliography: false
refsegment: false
---

# How to cite

The references button wrote this text and the file `example.bib` beside this document; the header above names the citation style and that file. Delete the text once you have seen what it shows.

A key in brackets cites a work, and the style decides how it prints [@doe2020]. A page number follows the key after a comma [@smith2019, p. 3], and the other locators work the same way, such as a chapter [@smith2019, chap. 2] or a figure [@doe2020, fig. 1]. Words before the key are a prefix and words after the locator a suffix, both printed with the citation [see @kim2018, chap. 2, for the method]. Several works cite together when semicolons separate them [@doe2020; @smith2019].

A key written without brackets makes the author part of the sentence, as @lee2021 shows, and a bracket right after it holds the locator, as @smith2019 [p. 7] shows. A minus sign before the key leaves the author out when the sentence names them already: Kim [-@kim2018] compared the styles. A footnote can cite as well.[^how]

[^how]: A citation in a footnote is numbered where the footnote's mark stands [@doe2020].

In the live view a citation shows as the style prints it; put the cursor on its line to see and edit the source. Type `@` to pick a key from the list of references, and rest the pointer on a key to see its entry. The reference list stands where the refs block below is; without a block it goes to the end of the document, under the heading the header's `reference-section-title` gives it.

## References

::: {#refs}
:::
