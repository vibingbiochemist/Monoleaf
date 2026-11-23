---
title: Several refs blocks, as pandoc fills them
csl: apa
reference-section-title: Sources
bibliography: refs.bib
---

# Chapter one

Cited here [@doe2020].

::: {#refs}
:::

# Chapter two

Cited here [@smith2019].

::: {#refs .appendix}
# Works cited
:::

A fence in code stays as written:

```
::: {#refs}
:::
```
