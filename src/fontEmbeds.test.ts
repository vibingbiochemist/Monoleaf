import { afterEach, describe, expect, it, vi } from "vitest";
import { embedFontsForExport } from "./fontEmbeds";

function stubFetch(ok: boolean, status = ok ? 200 : 404) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok,
      status,
      arrayBuffer: async () =>
        new TextEncoder().encode("fake-font-bytes").buffer,
    }),
  );
}

describe("embedFontsForExport", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("skips a face whose fetch resolves with a non-ok status, rather than embedding garbage", async () => {
    // fetch() only rejects on network failure; a 404 still resolves with a
    // body. Without an explicit response.ok check this would silently
    // base64-encode the error page instead of failing soft.
    stubFetch(false);
    const faces = await embedFontsForExport("lora", {
      hasItalic: false,
      hasCode: false,
    });
    expect(faces).toEqual([]);
  });

  it("embeds the upright face(s) with the font's declared weight range", async () => {
    stubFetch(true);
    const faces = await embedFontsForExport("lora", {
      hasItalic: false,
      hasCode: false,
    });
    expect(faces.length).toBeGreaterThan(0);
    for (const f of faces) {
      expect(f.family).toBe("Lora Variable");
      expect(f.weight).toBe("400 700");
      expect(f.italic).toBe(false);
    }
  });

  it("embeds italic faces only when requested, and mono at its static weight only when code is present", async () => {
    stubFetch(true);
    const faces = await embedFontsForExport("lora", {
      hasItalic: true,
      hasCode: true,
    });
    expect(faces.some((f) => f.italic)).toBe(true);
    const mono = faces.find((f) => f.family === "IBM Plex Mono");
    expect(mono?.weight).toBe("400");
  });

  it("omits italic and mono faces when the document uses neither", async () => {
    stubFetch(true);
    const faces = await embedFontsForExport("lora", {
      hasItalic: false,
      hasCode: false,
    });
    expect(faces.some((f) => f.italic)).toBe(false);
    expect(faces.some((f) => f.family === "IBM Plex Mono")).toBe(false);
  });

  it("falls back to the default font's weight range for an unknown id", async () => {
    stubFetch(true);
    const faces = await embedFontsForExport("not-a-real-font", {
      hasItalic: false,
      hasCode: false,
    });
    expect(faces.length).toBeGreaterThan(0);
    expect(faces[0].family).toBe("Source Serif 4 Variable");
    expect(faces[0].weight).toBe("200 900");
  });
});
