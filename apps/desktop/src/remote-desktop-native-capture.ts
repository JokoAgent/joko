import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { app } from "electron";

import type { DesktopRemoteDesktopVideoSettings } from "./remote-desktop-media-settings.js";
import { verifyPackagedDesktopRemoteDesktopBinary } from "./remote-desktop-native-manifest.js";
import {
  desktopRemoteDesktopVideoFramerate,
  desktopRemoteDesktopVideoProfile
} from "./remote-desktop-quality.js";

const exec = promisify(execFile);
const CAPTURE_HELPER = "joko-macos-remote-desktop-capture";
const MAXIMUM_NATIVE_FRAME_DIMENSION = 4_096;
const MAXIMUM_CURSOR_PNG_BYTES = 49_152;

export interface DesktopRemoteDesktopCursor {
  readonly visible: boolean;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly hotX: number;
  readonly hotY: number;
  readonly png: string;
}

export interface DesktopRemoteDesktopNativeFrame {
  readonly jpeg: string;
  readonly width: number;
  readonly height: number;
  readonly cursor: DesktopRemoteDesktopCursor | null;
}

export interface DesktopRemoteDesktopNativeCaptureRuntime {
  readonly platform: NodeJS.Platform;
  resolveBinary(): Promise<string>;
  spawn(binary: string, arguments_: readonly string[]): ChildProcessWithoutNullStreams;
}

/** One cursor-free native stream for the current media/session generation. */
export class DesktopRemoteDesktopNativeCapture {
  readonly #runtime: DesktopRemoteDesktopNativeCaptureRuntime;
  #child: ChildProcessWithoutNullStreams | undefined;
  #displayId = "";
  #configuration = "";
  #generation = 0;
  #pending = false;
  #cancel: ((error?: Error) => void) | undefined;

  constructor(runtime: DesktopRemoteDesktopNativeCaptureRuntime = nativeCaptureRuntime()) {
    this.#runtime = runtime;
  }

  async frame(
    displayId: string,
    streaming: boolean,
    cursorOverlay: boolean,
    settings?: DesktopRemoteDesktopVideoSettings
  ): Promise<DesktopRemoteDesktopNativeFrame | null> {
    if (this.#runtime.platform !== "darwin" || !/^[0-9]{1,10}$/u.test(displayId)) return null;
    const profile = desktopRemoteDesktopVideoProfile(settings);
    const fps = desktopRemoteDesktopVideoFramerate(settings);
    const configuration = streaming
      ? `${fps}:${settings?.quality ?? "auto"}:${cursorOverlay ? "cursor" : "video"}`
      : "compatibility";
    if (this.#child !== undefined
      && (this.#displayId !== displayId || this.#configuration !== configuration)) {
      this.stop();
    }
    if (this.#pending) return null;
    this.#pending = true;
    const generation = this.#generation;
    try {
      if (this.#child === undefined) {
        const binary = await this.#runtime.resolveBinary();
        if (generation !== this.#generation) return null;
        const arguments_ = streaming
          ? [displayId, cursorOverlay ? "cursor-overlay" : "native-video",
              String(fps), String(profile.jpegQuality), String(profile.physicalMaxEdge),
              String(profile.maxFrameBytes)]
          : [displayId];
        const child = this.#runtime.spawn(binary, arguments_);
        this.#child = child;
        this.#displayId = displayId;
        this.#configuration = configuration;
        child.stderr.resume();
        child.stdin.on("error", () => { if (this.#child === child) this.stop(); });
        child.on("error", () => { if (this.#child === child) this.stop(); });
        child.on("exit", (code) => {
          if (this.#child !== child) return;
          this.#cancel?.(new Error(code === 3
            ? "REMOTE_DESKTOP_SCREEN_PERMISSION_REQUIRED"
            : "REMOTE_DESKTOP_VIDEO_UNAVAILABLE"));
          this.stop();
        });
      }
      const child = this.#child;
      if (child === undefined) return null;
      const frameBytes = streaming ? profile.maxFrameBytes : 180_000;
      const encodedFrameBytes = Math.ceil(frameBytes / 3) * 4;
      const messageBytes = encodedFrameBytes + (streaming ? 166_664 : 4_096);
      return await new Promise<DesktopRemoteDesktopNativeFrame | null>((resolveFrame, rejectFrame) => {
        let bytes = 0;
        let text = "";
        let settled = false;
        const finish = (value: DesktopRemoteDesktopNativeFrame | null, error?: Error): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          child.stdout.off("data", receive);
          if (this.#cancel === cancel) this.#cancel = undefined;
          if (error === undefined) resolveFrame(value);
          else rejectFrame(error);
        };
        const cancel = (error?: Error): void => finish(null, error);
        const receive = (chunk: Buffer): void => {
          bytes += chunk.byteLength;
          if (bytes > messageBytes) {
            this.stop();
            return;
          }
          text += chunk.toString("ascii");
          const newline = text.indexOf("\n");
          if (newline < 0) return;
          if (newline !== text.length - 1) {
            this.stop();
            return;
          }
          try {
            const frame = parseDesktopRemoteDesktopNativeFrame(
              JSON.parse(text.slice(0, -1)),
              streaming,
              cursorOverlay,
              settings
            );
            finish(generation === this.#generation ? frame : null);
          } catch {
            this.stop();
          }
        };
        const timer = setTimeout(() => this.stop(), 3_000);
        timer.unref?.();
        this.#cancel = cancel;
        child.stdout.on("data", receive);
        try { child.stdin.write("f"); }
        catch { this.stop(); }
      });
    } finally {
      if (generation === this.#generation) this.#pending = false;
    }
  }

  stop(): void {
    this.#generation += 1;
    this.#cancel?.();
    this.#cancel = undefined;
    const child = this.#child;
    this.#child = undefined;
    this.#displayId = "";
    this.#configuration = "";
    this.#pending = false;
    if (child !== undefined) {
      try { child.stdin.destroy(); } catch { /* The child already retired. */ }
      try { child.kill(); } catch { /* The child already retired. */ }
    }
  }
}

let captureBuild: Promise<string> | undefined;

export async function resolveDesktopRemoteDesktopCaptureBinary(): Promise<string> {
  if (process.platform !== "darwin") throw new Error("REMOTE_DESKTOP_VIDEO_UNAVAILABLE");
  if (app.isPackaged) {
    try {
      return await verifyPackagedDesktopRemoteDesktopBinary(
        join(process.resourcesPath, "native-remote-desktop"),
        "capture",
        CAPTURE_HELPER,
        process.platform,
        process.arch
      );
    } catch {
      throw new Error("REMOTE_DESKTOP_VIDEO_UNAVAILABLE");
    }
  }
  captureBuild ??= (async () => {
    const source = join(app.getAppPath(), "native", "remote-desktop", "macos-capture.m");
    const digest = createHash("sha256").update(await readFile(source)).update(process.arch).digest("hex");
    const directory = join(app.getPath("userData"), "remote-desktop", "native", digest);
    const binary = join(directory, CAPTURE_HELPER);
    try {
      await access(binary);
      return binary;
    } catch { /* Compile this exact source version. */ }
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = `${binary}.${process.pid}.tmp`;
    try {
      await exec("xcrun", [
        "--sdk", "macosx", "clang", source, "-fobjc-arc", "-fblocks", "-O2",
        "-framework", "Foundation", "-framework", "AppKit", "-framework", "CoreGraphics",
        "-framework", "CoreImage", "-framework", "IOSurface", "-framework", "ImageIO",
        "-framework", "IOKit", "-o", temporary
      ], { timeout: 120_000, windowsHide: true });
      await rename(temporary, binary);
    } finally {
      await rm(temporary, { force: true });
    }
    return binary;
  })().finally(() => { captureBuild = undefined; });
  return captureBuild;
}

function nativeCaptureRuntime(): DesktopRemoteDesktopNativeCaptureRuntime {
  return {
    platform: process.platform,
    resolveBinary: resolveDesktopRemoteDesktopCaptureBinary,
    spawn: (binary, arguments_) => spawn(binary, [...arguments_], { stdio: "pipe", windowsHide: true })
  };
}

export function parseDesktopRemoteDesktopNativeFrame(
  value: unknown,
  streaming: boolean,
  cursorOverlay: boolean,
  settings?: DesktopRemoteDesktopVideoSettings
): DesktopRemoteDesktopNativeFrame {
  if (!record(value) || !exactKeys(value, ["jpeg", "width", "height", "cursor"])
    || typeof value["jpeg"] !== "string"
    || !Number.isSafeInteger(value["width"]) || !Number.isSafeInteger(value["height"])) {
    throw new Error("invalid");
  }
  const dimension = streaming ? MAXIMUM_NATIVE_FRAME_DIMENSION : 1_280;
  const byteLimit = streaming
    ? desktopRemoteDesktopVideoProfile(settings).maxFrameBytes
    : 180_000;
  const width = value["width"] as number;
  const height = value["height"] as number;
  if (width < 1 || height < 1 || width > dimension || height > dimension
    || base64Bytes(value["jpeg"]) < 1 || base64Bytes(value["jpeg"]) > byteLimit) {
    throw new Error("invalid");
  }
  const cursor = value["cursor"] === null ? null : parseCursor(value["cursor"]);
  if (!cursorOverlay && cursor !== null) throw new Error("invalid");
  return Object.freeze({ jpeg: value["jpeg"], width, height, cursor });
}

function parseCursor(value: unknown): DesktopRemoteDesktopCursor {
  if (!record(value) || !exactKeys(value,
    ["visible", "x", "y", "width", "height", "hotX", "hotY", "png"])
    || typeof value["visible"] !== "boolean" || !unit(value["x"]) || !unit(value["y"])
    || !positiveBounded(value["width"], 256) || !positiveBounded(value["height"], 256)
    || typeof value["hotX"] !== "number" || !Number.isFinite(value["hotX"])
    || typeof value["hotY"] !== "number" || !Number.isFinite(value["hotY"])
    || value["hotX"] < 0 || value["hotX"] > value["width"]
    || value["hotY"] < 0 || value["hotY"] > value["height"]
    || typeof value["png"] !== "string" || !validCursorPng(value["png"])) {
    throw new Error("invalid");
  }
  return Object.freeze({
    visible: value["visible"],
    x: value["x"],
    y: value["y"],
    width: value["width"],
    height: value["height"],
    hotX: value["hotX"],
    hotY: value["hotY"],
    png: value["png"]
  });
}

function validCursorPng(value: string): boolean {
  const encodedBytes = base64Bytes(value);
  if (encodedBytes < 33 || encodedBytes > MAXIMUM_CURSOR_PNG_BYTES) return false;
  let png: Buffer;
  try { png = Buffer.from(value, "base64"); }
  catch { return false; }
  if (png.byteLength !== encodedBytes
    || !png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    || png.readUInt32BE(8) !== 13 || png.toString("ascii", 12, 16) !== "IHDR") return false;
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  return width >= 1 && width <= 512 && height >= 1 && height <= 512;
}

function base64Bytes(value: string): number {
  if (value.length < 1 || value.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(value)) {
    return Number.POSITIVE_INFINITY;
  }
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return Math.floor((value.length * 3) / 4) - padding;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function unit(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function positiveBounded(value: unknown, maximum: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= maximum;
}
