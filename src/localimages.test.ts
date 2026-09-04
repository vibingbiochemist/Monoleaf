import { describe, expect, it, vi } from "vitest";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import { loadLocalImage, resolveLocalImagePath } from "./localimages";

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
