import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { PassThrough } from "node:stream";
import { ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process";

import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ app: {} }));

import { DesktopRemoteDesktopNativeCapture, parseDesktopRemoteDesktopNativeFrame, type DesktopRemoteDesktopNativeCaptureRuntime } from
  "../src/remote-desktop-native-capture.js";

describe("Remote Desktop native capture boundary", () => {
  it("retires an unfiltered pull and proves exclusions only after a current filtered frame", async () => {
    const children: ReturnType<typeof fakeChild>[] = [];
    const arguments_: string[][] = [];
    const capture = new DesktopRemoteDesktopNativeCapture({
      platform: "darwin", resolveBinary: async () => "/capture",
      spawn: (_binary, values) => {
        arguments_.push([...values]);
        const child = fakeChild(); children.push(child); return child.process;
      }
    });
    const previous = capture.frame("1", false, false);
    await vi.waitFor(() => expect(children).toHaveLength(1));
    capture.setExcludedWindows([20, 10]);
    expect(capture.privacyReady).toBe(false);
    await expect(previous).resolves.toBeNull();
    children[0]!.stdout.write(`${JSON.stringify({ jpeg: "AQ==", width: 1, height: 1, cursor: null })}\n`);
    expect(capture.privacyReady).toBe(false);
    const filtered = capture.frame("1", false, false);
    await vi.waitFor(() => expect(children).toHaveLength(2));
    expect(arguments_).toEqual([["1"], ["1", "10,20"]]);
    expect(capture.privacyReady).toBe(false);
    children[1]!.stdout.write(`${JSON.stringify({ jpeg: "AQ==", width: 1, height: 1, cursor: null })}\n`);
    await expect(filtered).resolves.toMatchObject({ width: 1 });
    expect(capture.privacyReady).toBe(true);
    capture.setExcludedWindows([]);
    expect(capture.privacyReady).toBe(false);
    capture.stop();
  });

  it("keeps failed filtered streams unconfirmed and never dispatches an unfiltered fallback", async () => {
    const child = fakeChild();
    const spawn = vi.fn<DesktopRemoteDesktopNativeCaptureRuntime["spawn"]>(() => child.process);
    const capture = new DesktopRemoteDesktopNativeCapture({ platform: "darwin", resolveBinary: async () => "/capture", spawn });
    capture.setExcludedWindows([123]);
    const pending = capture.frame("1", true, false, { fps: 30, quality: "auto", audio: false });
    const failure = expect(pending).rejects.toThrow("REMOTE_DESKTOP_VIDEO_UNAVAILABLE");
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());
    child.process.emit("exit", 5);
    await failure;
    expect(capture.privacyReady).toBe(false);
    expect(spawn.mock.calls[0]![1]).toEqual(["1", "native-video", "30", "0.8", "2560", "1500000", "123"]);
    expect(() => capture.setExcludedWindows([0])).toThrow("PRIVACY_UNAVAILABLE");
    expect(() => capture.setExcludedWindows([1, 1])).toThrow("PRIVACY_UNAVAILABLE");
    capture.stop();
  });

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

  it("enforces the host-owned native frame budget for the selected tier", () => {
    const frame = { jpeg: "A".repeat(4_000_000), width: 1, height: 1, cursor: null };
    expect(parseDesktopRemoteDesktopNativeFrame(
      frame,
      true,
      false,
      { fps: 60, quality: "hd", audio: false }
    )).toEqual(frame);
    expect(() => parseDesktopRemoteDesktopNativeFrame(
      frame,
      true,
      false,
      { fps: 60, quality: "auto", audio: false }
    )).toThrowError("invalid");
  });

  it("passes the effective saver profile to the native helper", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const child = Object.assign(new EventEmitter(), {
      stdin,
      stdout,
      stderr,
      kill: vi.fn(() => true)
    }) as unknown as ChildProcessWithoutNullStreams;
    stdin.once("data", () => stdout.write(`${JSON.stringify({
      jpeg: "AQ==",
      width: 1,
      height: 1,
      cursor: null
    })}\n`));
    let arguments_: readonly string[] = [];
    const capture = new DesktopRemoteDesktopNativeCapture({
      platform: "darwin",
      resolveBinary: async () => "/capture",
      spawn: (_binary, next) => {
        arguments_ = next;
        return child;
      }
    });

    await expect(capture.frame(
      "1",
      true,
      false,
      { fps: 60, quality: "saver", audio: false }
    )).resolves.toMatchObject({ width: 1, height: 1, cursor: null });
    expect(arguments_).toEqual(["1", "native-video", "30", "0.65", "0", "1000000"]);
    capture.stop();
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

function fakeChild() {
  const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough();
  const stdio: [PassThrough, PassThrough, PassThrough] = [stdin, stdout, stderr];
  const process = Object.assign(new ChildProcess(), { stdin, stdout, stderr, stdio, kill: vi.fn(() => true) });
  return { stdin, stdout, stderr, process };
}

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
