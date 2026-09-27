import { describe, expect, it, vi } from "vitest";

import { materializeDesktopDeepLinkNavigation } from "../src/portable-deep-link-materialization.js";

describe("portable deep-link materialization", () => {
  it("snapshots an accepted package into the bounded renderer handoff", async () => {
    const bytes = new Uint8Array([0x4a, 0x4f, 0x4b, 0x4f]);
    const readFileSnapshot = vi.fn(async () => bytes);

    await expect(materializeDesktopDeepLinkNavigation(
      { kind: "portableFile", path: "/Transfers/Task.JSHARE" },
      readFileSnapshot
    )).resolves.toEqual({
      kind: "portable",
      file: {
        name: "Task.JSHARE",
        mediaType: "application/vnd.joko.session",
        bytes
      }
    });
    expect(readFileSnapshot).toHaveBeenCalledExactlyOnceWith(
      "/Transfers/Task.JSHARE",
      256 * 1024 * 1024
    );
  });

  it("falls back to a path-free recovery surface when the native snapshot fails", async () => {
    const readFileSnapshot = vi.fn(async () => {
      throw new Error("/Transfers/private-task.jshare could not be read");
    });

    const navigation = await materializeDesktopDeepLinkNavigation(
      { kind: "portableFile", path: "/Transfers/private-task.jshare" },
      readFileSnapshot
    );

    expect(navigation).toEqual({ kind: "portable" });
    expect(Object.keys(navigation)).toEqual(["kind"]);
    expect(JSON.stringify(navigation)).not.toMatch(/private-task|Transfers|could not be read|path|error/iu);
  });
});
