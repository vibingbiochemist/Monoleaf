import { describe, expect, it, vi } from "vitest";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import {
  AmbiguousImageError,
  loadLocalImage,
  loadLocalImagesForExport,
  loadLocalImageWithFallback,
  relativizeUnderDocument,
  resolveLocalImagePath,
} from "./localimages";

describe("resolveLocalImagePath", () => {
  it("returns an already-absolute reference as-is, regardless of the document", () => {
    for (const [path, doc] of [
      ["/etc/hosts", null],
      ["/etc/hosts", "/home/x/notes.md"],
      ["C:\\Users\\x\\pic.png", null],
      ["C:/Users/x/pic.png", "C:\\docs\\note.md"],
      [String.raw`\\host\share\pic.png`, null],
      ["//host/share/pic.png", "/a/b.md"],
    ] as const) {
      expect(resolveLocalImagePath(path, doc), path).toBe(path);
    }
  });

  it("joins a relative reference against the open document's directory", () => {
    expect(resolveLocalImagePath("img.png", "/home/x/notes.md")).toBe(
      "/home/x/img.png",
    );
    expect(resolveLocalImagePath("./img.png", "/home/x/notes.md")).toBe(
      "/home/x/img.png",
    );
    expect(resolveLocalImagePath("images/img.png", "/home/x/notes.md")).toBe(
      "/home/x/images/img.png",
    );
    expect(resolveLocalImagePath("../img.png", "/home/x/sub/notes.md")).toBe(
      "/home/x/img.png",
    );
    expect(
      resolveLocalImagePath("..\\assets\\img.png", "C:\\docs\\sub\\note.md"),
    ).toBe("C:\\docs\\assets\\img.png");
  });

  it("cannot resolve a relative reference with no open document", () => {
    expect(resolveLocalImagePath("img.png", null)).toBeNull();
    expect(resolveLocalImagePath("./img.png", null)).toBeNull();
  });
});

describe("relativizeUnderDocument", () => {
  it("rewrites a path under the document's own directory as relative", () => {
    expect(relativizeUnderDocument("/home/x/img.png", "/home/x/notes.md")).toBe(
      "img.png",
    );
    expect(
      relativizeUnderDocument("/home/x/assets/img.png", "/home/x/notes.md"),
    ).toBe("assets/img.png");
    expect(
      relativizeUnderDocument("C:\\docs\\img.png", "C:\\docs\\note.md"),
    ).toBe("img.png");
  });

  it("uses / regardless of the document's own separator style", () => {
    expect(
      relativizeUnderDocument("C:\\docs\\assets\\img.png", "C:\\docs\\note.md"),
    ).toBe("assets/img.png");
  });

  it("falls back to null (caller keeps the absolute path) when not under the document's directory", () => {
    // A sibling directory: not a prefix match, even though both are under /home/x.
    expect(
      relativizeUnderDocument("/home/x/other/img.png", "/home/x/sub/notes.md"),
    ).toBeNull();
    // A different drive entirely.
    expect(
      relativizeUnderDocument("D:\\img.png", "C:\\docs\\note.md"),
    ).toBeNull();
    // The path IS the document's directory (no file name left to reference).
    expect(relativizeUnderDocument("/home/x", "/home/x/notes.md")).toBeNull();
  });

  it("cannot relativize with no open document", () => {
    expect(relativizeUnderDocument("/home/x/img.png", null)).toBeNull();
  });
});

// invokeMock is reset at the top of each test body rather than in a
// beforeEach: resetting it from a hook was observed to make Vitest misreport
// a properly-handled rejection in a later test as an uncaught error (the
// mock's async-result tracking gets confused about which test a settled
// promise belongs to). Resetting inline avoids that.
describe("loadLocalImage", () => {
  it("invokes read_image_as_data_url with the resolved path", async () => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue("data:image/png;base64,AAAA");
    const result = await loadLocalImage("/home/x/img-a.png");
    expect(result).toBe("data:image/png;base64,AAAA");
    expect(invokeMock).toHaveBeenCalledWith("read_image_as_data_url", {
      path: "/home/x/img-a.png",
    });
  });

  it("calls invoke only once for the same resolved path (cached)", async () => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue("data:image/png;base64,BBBB");
    const path = "/home/x/img-b.png";
    const [a, b] = await Promise.all([
      loadLocalImage(path),
      loadLocalImage(path),
    ]);
    expect(a).toBe(b);
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });

  it("propagates a rejection (e.g. a non-image extension) to the caller", async () => {
    invokeMock.mockReset();
    invokeMock.mockRejectedValue(
      "/home/x/notes.txt is not a supported image type",
    );
    await expect(loadLocalImage("/home/x/notes.txt")).rejects.toBe(
      "/home/x/notes.txt is not a supported image type",
    );
  });

  it("does not cache a rejection: the next call for the same path retries", async () => {
    invokeMock.mockReset();
    const path = "/home/x/not-there-yet.png";

    invokeMock.mockRejectedValueOnce("ENOENT: no such file");
    await expect(loadLocalImage(path)).rejects.toBe("ENOENT: no such file");

    // The file has since appeared (or the reference was a typo now fixed) —
    // a later re-render must not still be looking at the failed promise.
    invokeMock.mockResolvedValueOnce("data:image/png;base64,DDDD");
    await expect(loadLocalImage(path)).resolves.toBe(
      "data:image/png;base64,DDDD",
    );
    expect(invokeMock).toHaveBeenCalledTimes(2);
  });
});

// Each case below uses its own file names: the resolved-path cache and the
// search cache in localimages.ts are module-global.
describe("loadLocalImageWithFallback", () => {
  it("returns the direct load, searching nothing, when the path loads", async () => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue("data:image/png;base64,EEEE");
    await expect(
      loadLocalImageWithFallback("/docs/direct.png", "/docs/notes.md"),
    ).resolves.toEqual({
      dataUrl: "data:image/png;base64,EEEE",
      foundAt: null,
    });
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith("read_image_as_data_url", {
      path: "/docs/direct.png",
    });
  });

  it("searches the document's folder by name when the path fails, and says where the file was", async () => {
    invokeMock.mockReset();
    invokeMock.mockImplementation(
      (cmd: string, args?: Record<string, unknown>) => {
        if (cmd === "find_image_by_name") {
          return Promise.resolve(["/docs/figures/plot.png"]);
        }
        return args?.path === "/docs/figures/plot.png"
          ? Promise.resolve("data:image/png;base64,FFFF")
          : Promise.reject("ENOENT: no such file");
      },
    );
    await expect(
      loadLocalImageWithFallback("/docs/plot.png", "/docs/notes.md"),
    ).resolves.toEqual({
      dataUrl: "data:image/png;base64,FFFF",
      foundAt: "/docs/figures/plot.png",
    });
    expect(invokeMock).toHaveBeenCalledWith("find_image_by_name", {
      dir: "/docs",
      name: "plot.png",
    });
  });

  it("refuses to guess between several files of that name", async () => {
    invokeMock.mockReset();
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "find_image_by_name"
        ? Promise.resolve(["C:\\docs\\a\\dup.png", "C:\\docs\\b\\dup.png"])
        : Promise.reject("ENOENT"),
    );
    const err: unknown = await loadLocalImageWithFallback(
      "C:\\docs\\dup.png",
      "C:\\docs\\note.md",
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AmbiguousImageError);
    expect((err as AmbiguousImageError).candidates).toHaveLength(2);
    // The search root is the document's folder, in its own separator style.
    expect(invokeMock).toHaveBeenCalledWith("find_image_by_name", {
      dir: "C:\\docs",
      name: "dup.png",
    });
  });

  it("rethrows the original error when nothing is found, when the search fails, and without a document", async () => {
    invokeMock.mockReset();
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "find_image_by_name"
        ? Promise.resolve([])
        : Promise.reject("ENOENT: gone.png"),
    );
    await expect(
      loadLocalImageWithFallback("/docs/gone.png", "/docs/notes.md"),
    ).rejects.toBe("ENOENT: gone.png");

    invokeMock.mockImplementation((cmd: string) =>
      cmd === "find_image_by_name"
        ? Promise.reject("not a supported image type")
        : Promise.reject("ENOENT: gone2.pdf"),
    );
    await expect(
      loadLocalImageWithFallback("/docs/gone2.pdf", "/docs/notes.md"),
    ).rejects.toBe("ENOENT: gone2.pdf");

    invokeMock.mockReset();
    invokeMock.mockRejectedValue("ENOENT: nodoc.png");
    await expect(
      loadLocalImageWithFallback("/abs/nodoc.png", null),
    ).rejects.toBe("ENOENT: nodoc.png");
    expect(invokeMock).toHaveBeenCalledTimes(1); // no search without a folder
  });

  it("runs one search per folder and name, even across repeated failing loads", async () => {
    invokeMock.mockReset();
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "find_image_by_name"
        ? Promise.resolve([])
        : Promise.reject("ENOENT"),
    );
    for (let i = 0; i < 3; i++) {
      await loadLocalImageWithFallback(
        "/docs/once.png",
        "/docs/notes.md",
      ).catch(() => undefined);
    }
    const searches = invokeMock.mock.calls.filter(
      (call: unknown[]) => call[0] === "find_image_by_name",
    );
    expect(searches).toHaveLength(1);
  });
});

describe("loadLocalImagesForExport", () => {
  it("maps each loadable reference to its data URL and leaves the rest out", async () => {
    invokeMock.mockReset();
    invokeMock.mockImplementation(
      (cmd: string, args?: Record<string, unknown>) => {
        if (cmd === "find_image_by_name") return Promise.resolve([]);
        return args?.path === "/docs/ok.png"
          ? Promise.resolve("data:image/png;base64,GGGG")
          : Promise.reject("ENOENT");
      },
    );
    const map = await loadLocalImagesForExport(
      ["ok.png", "./missing.png", "/abs/also-missing.png"],
      "/docs/notes.md",
    );
    expect([...map]).toEqual([["ok.png", "data:image/png;base64,GGGG"]]);
  });

  it("resolves nothing without an open document", async () => {
    invokeMock.mockReset();
    const map = await loadLocalImagesForExport(["rel.png"], null);
    expect(map.size).toBe(0);
    expect(invokeMock).not.toHaveBeenCalled();
  });
});
