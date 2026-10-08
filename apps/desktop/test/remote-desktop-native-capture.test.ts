import { readFile } from "node:fs/promises";

import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ app: {} }));

import { parseDesktopRemoteDesktopNativeFrame } from
  "../src/remote-desktop-native-capture.js";

describe("Remote Desktop native capture boundary", () => {
  it("accepts a bounded cursor only when its first PNG chunk is a bounded IHDR", () => {
    const value = frame(cursorPng(32, 48).toString("base64"));
    expect(parseDesktopRemoteDesktopNativeFrame(value, true, true).cursor)
      .toMatchObject({ width: 16, height: 16 });

    const wrongChunk = cursorPng(32, 48);
    wrongChunk.write("IDAT", 12, "ascii");
    expect(() => parseDesktopRemoteDesktopNativeFrame(
      frame(wrongChunk.toString("base64")), true, true
    )).toThrowError("invalid");

    const oversized = cursorPng(513, 1);
    expect(() => parseDesktopRemoteDesktopNativeFrame(
      frame(oversized.toString("base64")), true, true
    )).toThrowError("invalid");
  });

  it("keeps compatibility pixels at 1280 while allowing cursor-free native video up to 4096", () => {
    const large = { jpeg: "AQ==", width: 2_560, height: 1_440, cursor: null };
    expect(() => parseDesktopRemoteDesktopNativeFrame(large, false, false))
      .toThrowError("invalid");
    expect(parseDesktopRemoteDesktopNativeFrame(large, true, false)).toEqual(large);
    expect(() => parseDesktopRemoteDesktopNativeFrame(
      { ...large, cursor: frame(cursorPng(1, 1).toString("base64")).cursor },
      true,
      false
    )).toThrowError("invalid");
  });

  it("duplicates the same strict IHDR/raster checks at the isolated preload boundary", async () => {
    const source = await readFile(
      new URL("../src/remote-desktop-capture-preload.cts", import.meta.url),
      "utf8"
    );
    expect(source).toContain("decoded.length < 33 || decoded.length > 49_152");
    expect(source).toContain('decoded.slice(12, 16) !== "IHDR"');
    expect(source).toContain("width >= 1 && width <= 512 && height >= 1 && height <= 512");
  });
});

function frame(png: string): Record<string, unknown> {
  return {
    jpeg: "AQ==",
    width: 1,
    height: 1,
    cursor: {
      visible: true,
      x: 0.5,
      y: 0.5,
      width: 16,
      height: 16,
      hotX: 1,
      hotY: 1,
      png
    }
  };
}

function cursorPng(width: number, height: number): Buffer {
  const png = Buffer.alloc(33);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png);
  png.writeUInt32BE(13, 8);
  png.write("IHDR", 12, "ascii");
  png.writeUInt32BE(width, 16);
  png.writeUInt32BE(height, 20);
  return png;
}
