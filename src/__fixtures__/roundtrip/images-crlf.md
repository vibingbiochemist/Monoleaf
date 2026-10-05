# Images and line endings

This fixture is committed with CRLF line endings and `-text`, so the
round-trip suite checks Windows line endings on every platform.

A relative reference: ![Plot](./figures/plot.png)

A path with a space, in the angle-bracket form Monoleaf writes for it:

![Screenshot](<OneDrive - Company/Screenshot (1).png>)

An explicitly sized HTML image:

<img src="../diagram.png" width="320" alt="Diagram">

A remote image stays a remote reference: ![Logo](https://example.com/logo.png)

Trailing spaces make a hard break  
right here, and the file ends without a newline.