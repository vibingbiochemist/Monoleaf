import { describe, expect, it } from "vitest";
import { imageReferenceAt } from "./imageref";
import { imageMarkup } from "./commands";

describe("imageReferenceAt", () => {
  it("reads a plain markdown image", () => {
    const line = "see ![pic](img/a.png) here";
    const ref = imageReferenceAt(line, line.indexOf("]("));
    expect(ref).toEqual({
      from: 4,
      to: 21,
      src: "img/a.png",
      alt: "pic",
      width: "",
    });
    expect(line.slice(ref!.from, ref!.to)).toBe("![pic](img/a.png)");
  });

  it("drops a trailing title from a bare destination", () => {
    const ref = imageReferenceAt('![pic](a.png "Title")', 3);
    expect(ref?.src).toBe("a.png");
  });

  it("reads the whole <...>-wrapped destination, parenthesis and all (#70)", () => {
    // The old regex stopped at the ")" inside "(1)", truncating src to
    // "<C:\Users\x\pic" and leaving ".png>)" behind after a rewrite.
    const line = "![pic](<C:\\Users\\x\\pic (1).png>)";
    const ref = imageReferenceAt(line, 3);
    expect(ref).toEqual({
      from: 0,
      to: line.length,
      src: "C:\\Users\\x\\pic (1).png",
      alt: "pic",
      width: "",
    });
  });

  it("reads a <...>-wrapped destination containing a space", () => {
    const line = "![pic](<C:\\Users\\x\\OneDrive - Co\\pic.png>)";
    expect(imageReferenceAt(line, 3)).toMatchObject({
      to: line.length,
      src: "C:\\Users\\x\\OneDrive - Co\\pic.png",
    });
  });

  it("reads src, alt and width from an <img> tag", () => {
    const line =
      '<img src="C:\\Users\\x\\OneDrive - Co\\pic.png" alt="a b" width="300">';
    expect(imageReferenceAt(line, 5)).toEqual({
      from: 0,
      to: line.length,
      src: "C:\\Users\\x\\OneDrive - Co\\pic.png",
      alt: "a b",
      width: "300",
    });
    expect(imageReferenceAt("<img src='x.png' width=50%>", 2)).toMatchObject({
      src: "x.png",
      alt: "",
      width: "50%",
    });
  });

  it("picks the reference under the offset when a line has several", () => {
    const line = "![a](a.png) and ![b](<b (2).png>)";
    expect(imageReferenceAt(line, 2)?.src).toBe("a.png");
    expect(imageReferenceAt(line, line.length - 1)?.src).toBe("b (2).png");
    // Inclusive at both ends: resting on the closing ")" still counts.
    expect(imageReferenceAt(line, 11)?.src).toBe("a.png");
    // Between the two, on plain text, there is none.
    expect(imageReferenceAt(line, 13)).toBeNull();
  });

  it("returns null when the offset is not on an image", () => {
    expect(imageReferenceAt("plain text", 3)).toBeNull();
    expect(imageReferenceAt("![pic](a.png) tail", 17)).toBeNull();
  });

  it("round-trips a path needing <...> through imageMarkup (#70)", () => {
    // "Original size" in the image menu rebuilds the markdown form from a
    // sized <img>. It must go through imageMarkup, or a bare destination
    // with a space comes out, which no CommonMark parser reads as an image.
    const src = "C:\\Users\\x\\OneDrive - Co\\pic (1).png";
    const sized = `<img src="${src}" alt="pic" width="300">`;
    const ref = imageReferenceAt(sized, 1)!;
    const md = imageMarkup(ref.src, ref.alt);
    expect(md).toBe(`![pic](<${src}>)`);
    expect(imageReferenceAt(md, 1)).toMatchObject({
      to: md.length,
      src,
      alt: "pic",
    });
  });
});
