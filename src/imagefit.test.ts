import { describe, expect, it } from "vitest";
import { fittedImageWidth, requestedImageWidth } from "./imagefit";

describe("fittedImageWidth", () => {
  // A 1080×2400 phone screenshot on an A4 body of 956px.
  it("keeps the requested width while the picture fits the page body", () => {
    expect(fittedImageWidth(300, 1080, 2400, 956)).toBe(300); // 667px tall
    expect(fittedImageWidth(430, 1080, 2400, 956)).toBe(430); // 955px tall
  });

  it("shrinks the width so the height lands exactly on the cap", () => {
    expect(fittedImageWidth(600, 1080, 2400, 956)).toBe(430); // was 1333px tall
    expect(fittedImageWidth(1000, 1000, 1000, 400)).toBe(400);
  });

  it("leaves a wide image alone: height is never the constraint", () => {
    expect(fittedImageWidth(642, 4000, 1000, 956)).toBe(642);
  });

  it("does nothing until the picture's dimensions are known", () => {
    expect(fittedImageWidth(600, 0, 0, 956)).toBe(600);
    expect(fittedImageWidth(600, 1080, 2400, 0)).toBe(600);
    expect(fittedImageWidth(600, 1080, 2400, NaN)).toBe(600);
  });
});

describe("requestedImageWidth", () => {
  it("reads a bare number, px, or a percentage of the content width", () => {
    expect(requestedImageWidth("300", 642)).toBe(300);
    expect(requestedImageWidth("300px", 642)).toBe(300);
    expect(requestedImageWidth("100%", 642)).toBe(642);
    expect(requestedImageWidth(" 50% ", 642)).toBe(321);
  });

  it("is NaN for anything else", () => {
    expect(requestedImageWidth("", 642)).toBeNaN();
    expect(requestedImageWidth("auto", 642)).toBeNaN();
    expect(requestedImageWidth("12em", 642)).toBeNaN();
  });
});
