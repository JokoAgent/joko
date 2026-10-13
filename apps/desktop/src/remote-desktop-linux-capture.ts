import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { nativeImage } from "electron";
import type { DesktopRemoteDesktopVideoSettings } from "./remote-desktop-media-settings.js";
import {
  parseDesktopRemoteDesktopNativeFrame, type DesktopRemoteDesktopNativeFrame
} from "./remote-desktop-native-capture.js";
import { desktopRemoteDesktopVideoProfile } from "./remote-desktop-quality.js";
import {
  readDesktopRemoteDesktopLinuxMonitor, readDesktopRemoteDesktopLinuxSessionState,
  resolveDesktopRemoteDesktopLinuxBinary, supportsDesktopRemoteDesktopLinuxCapture,
  WAYLAND_REMOTE_DESKTOP_DISPLAY_ID, type DesktopRemoteDesktopLinuxMonitor
} from "./remote-desktop-linux.js";
import type { DesktopRemoteDesktopSessionState } from "./remote-desktop-input.js";

const MAXIMUM_JPEG_BYTES = 8 * 1_024 * 1_024;
const MAXIMUM_NATIVE_LINE_BYTES = 1_500_000;
export interface DesktopRemoteDesktopLinuxCaptureRuntime {
  supported(): boolean;
  session(signal: AbortSignal): Promise<DesktopRemoteDesktopSessionState>;
  monitor(displayId: string, signal: AbortSignal): Promise<DesktopRemoteDesktopLinuxMonitor>;
  resolveBinary(): Promise<string>;
  spawn(binary: string, arguments_: readonly string[]): ChildProcessWithoutNullStreams;
  grim(arguments_: readonly string[], signal: AbortSignal): Promise<Buffer>;
  image(jpeg: Buffer, edge: number, maximumBytes: number, quality: number): {
    readonly jpeg: Buffer; readonly width: number; readonly height: number;
  };
}

/** User-session screencopy first; grim is the same captured output's bounded fallback. */
export class DesktopRemoteDesktopLinuxCapture {
  readonly #runtime: DesktopRemoteDesktopLinuxCaptureRuntime;
  #child: ChildProcessWithoutNullStreams | undefined;
  #configuration = "";
  #closing: Promise<void> = Promise.resolve();
  #cancel: (() => void) | undefined;
  #active: AbortController | undefined;
  #fallback = false;
  #generation = 0;
  constructor(runtime: DesktopRemoteDesktopLinuxCaptureRuntime = linuxCaptureRuntime()) { this.#runtime = runtime; }

  async frame(displayId: string, streaming: boolean, overlay: boolean,
    settings?: DesktopRemoteDesktopVideoSettings, signal?: AbortSignal): Promise<DesktopRemoteDesktopNativeFrame | null> {
    if (this.#active !== undefined || !this.#runtime.supported()
      || (displayId !== WAYLAND_REMOTE_DESKTOP_DISPLAY_ID && !/^hyprland:[A-Za-z0-9_.-]{1,80}$/u.test(displayId))) return null;
    const active = new AbortController(); this.#active = active;
    const generation = this.#generation;
    const cancel = (): void => active.abort();
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) cancel();
    const current = (): boolean => this.#active === active && this.#generation === generation && !active.signal.aborted;
    let session: DesktopRemoteDesktopSessionState | undefined;
    const view = async (): Promise<void> => {
      if (!current()) throw new Error("expired");
      const state = await this.#runtime.session(active.signal);
      if (!current() || (state !== "unlocked" && state !== "locked-logged-in")
        || (session !== undefined && state !== session)) throw new Error("expired");
      session = state;
    };
    const profile = desktopRemoteDesktopVideoProfile(settings);
    const maximumBytes = streaming ? profile.maxFrameBytes : 180_000;
    const edge = streaming ? Math.min(profile.physicalMaxEdge || 1_920, 4_096) : 1_280;
    try {
      await this.#closing; await view();
      const monitor = displayId === WAYLAND_REMOTE_DESKTOP_DISPLAY_ID ? undefined : await this.#runtime.monitor(displayId, active.signal);
      await view();
      const configuration = JSON.stringify([displayId, overlay, settings?.quality ?? "auto", monitor]);
      if (this.#child !== undefined && this.#configuration !== configuration) { this.#closeNative(); await this.#closing; await view(); }
      if (!this.#fallback) {
        try {
          if (this.#child === undefined) {
            const binary = await this.#runtime.resolveBinary(); await view();
            const child = this.#runtime.spawn(binary, [overlay ? "cursor-overlay" : "video",
              String(monitor?.scale ?? 1), String(Math.round(profile.jpegQuality * 100)), ...(monitor ? [monitor.name] : [])]);
            this.#child = child; this.#configuration = configuration;
            child.stderr.resume();
            child.once("error", () => { if (this.#child === child) this.#closeNative(); });
            child.once("exit", () => { if (this.#child === child) this.#closeNative(); });
            child.stdin.on("error", () => { if (this.#child === child) this.#closeNative(); });
          }
          const line = await this.#line(active.signal);
          if (line === null) throw new Error("unavailable");
          let jpeg: string; let cursor: unknown = null;
          if (overlay) {
            const value: unknown = JSON.parse(line);
            if (typeof value !== "object" || value === null || Array.isArray(value)
              || Object.keys(value).length !== 2 || !("jpeg" in value) || !("cursor" in value) || typeof value.jpeg !== "string") throw new Error("invalid");
            jpeg = value.jpeg; cursor = value.cursor;
          } else jpeg = line;
          if (jpeg.length > 1_400_000 || jpeg.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(jpeg)
            || Buffer.from(jpeg, "base64").toString("base64") !== jpeg) throw new Error("invalid");
          const frame = this.#frame(Buffer.from(jpeg, "base64"), cursor, streaming, overlay, edge, maximumBytes, profile.jpegQuality, settings);
          await view(); return current() ? frame : null;
        } catch {
          this.#closeNative(); await this.#closing;
          if (!current()) return null;
          this.#fallback = true;
        }
      }
      await view();
      const jpeg = await this.#runtime.grim(["-t", "jpeg", "-q", String(Math.round(profile.jpegQuality * 100)), "-s", "1",
        ...(monitor ? ["-o", monitor.name] : []), "-"], active.signal);
      await view();
      return current() ? this.#frame(jpeg, null, streaming, overlay, edge, maximumBytes, profile.jpegQuality, settings) : null;
    } catch { this.#closeNative(); await this.#closing; return null; }
    finally { signal?.removeEventListener("abort", cancel); if (this.#active === active) this.#active = undefined; }
  }

  stop(): void {
    this.#generation += 1; this.#active?.abort();
    // Retain the active slot until its actual native/grim receipt or close settles.
    this.#closeNative(); this.#fallback = false;
  }
  #frame(jpeg: Buffer, cursor: unknown, streaming: boolean, overlay: boolean, edge: number,
    maximumBytes: number, quality: number, settings?: DesktopRemoteDesktopVideoSettings): DesktopRemoteDesktopNativeFrame {
    const size = desktopRemoteDesktopLinuxJpegSize(jpeg);
    if (size === null) throw new Error("invalid");
    const image = this.#runtime.image(jpeg, edge, maximumBytes, quality);
    const actual = desktopRemoteDesktopLinuxJpegSize(image.jpeg);
    if (!Number.isSafeInteger(image.width) || !Number.isSafeInteger(image.height)
      || image.width < 1 || image.height < 1 || image.width > edge || image.height > edge
      || image.jpeg.length > maximumBytes || actual === null || actual.width !== image.width || actual.height !== image.height) throw new Error("invalid");
    return parseDesktopRemoteDesktopNativeFrame({ jpeg: image.jpeg.toString("base64"), width: image.width, height: image.height, cursor },
      streaming, overlay, settings);
  }
  #line(signal: AbortSignal): Promise<string | null> {
    const child = this.#child; if (child === undefined) return Promise.resolve(null);
    return new Promise((resolveLine) => {
      let bytes = 0; let text = ""; let finished = false;
      const finish = (line: string | null): void => {
        if (finished) return; finished = true; clearTimeout(timer);
        signal.removeEventListener("abort", canceled); child.stdout.off("data", receive);
        if (this.#cancel === canceled) this.#cancel = undefined;
        resolveLine(line);
      };
      const canceled = (): void => { finish(null); this.#closeNative(); };
      const receive = (chunk: Buffer): void => {
        bytes += chunk.length; if (bytes > MAXIMUM_NATIVE_LINE_BYTES) { canceled(); return; }
        text += chunk.toString("ascii"); const newline = text.indexOf("\n");
        if (newline >= 0) finish(newline === text.length - 1 ? text.slice(0, newline) : null);
      };
      const timer = setTimeout(canceled, 3_000); timer.unref?.();
      this.#cancel = canceled; signal.addEventListener("abort", canceled, { once: true });
      child.stdout.on("data", receive);
      if (signal.aborted) canceled(); else try { child.stdin.write("f"); } catch { canceled(); }
    });
  }
  #closeNative(): void {
    const child = this.#child; this.#child = undefined; this.#configuration = "";
    this.#cancel?.(); this.#cancel = undefined;
    if (child === undefined) return;
    const prior = this.#closing;
    const closed = new Promise<void>((resolveClose) => {
      child.once("close", () => resolveClose());
      try { child.stdin.destroy(); child.kill(); } catch { /* Actual close still owns this slot. */ }
    });
    this.#closing = Promise.all([prior, closed]).then(() => undefined);
  }
}

/** Validate dimensions before a JPEG reaches the native decoder. */
export function desktopRemoteDesktopLinuxJpegSize(jpeg: Buffer): { width: number; height: number } | null {
  if (jpeg.length < 12 || jpeg.length > MAXIMUM_JPEG_BYTES || jpeg[0] !== 0xff || jpeg[1] !== 0xd8
    || jpeg[jpeg.length - 2] !== 0xff || jpeg[jpeg.length - 1] !== 0xd9) return null;
  for (let offset = 2; offset + 4 < jpeg.length;) {
    if (jpeg[offset++] !== 0xff) return null;
    while (jpeg[offset] === 0xff) offset += 1;
    const marker = jpeg[offset++]; if (marker === undefined || marker === 0xda || marker === 0xd9) return null;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > jpeg.length) return null;
    const length = jpeg.readUInt16BE(offset);
    if (length < 2 || offset + length > jpeg.length) return null;
    if ([0xc0, 0xc1, 0xc2].includes(marker)) {
      if (length < 8) return null;
      const height = jpeg.readUInt16BE(offset + 3); const width = jpeg.readUInt16BE(offset + 5);
      return width >= 1 && height >= 1 && width <= 8_192 && height <= 8_192 && width * height <= 16_777_216
        ? { width, height } : null;
    }
    offset += length;
  }
  return null;
}

function linuxCaptureRuntime(): DesktopRemoteDesktopLinuxCaptureRuntime {
  return {
    supported: supportsDesktopRemoteDesktopLinuxCapture, session: readDesktopRemoteDesktopLinuxSessionState,
    monitor: readDesktopRemoteDesktopLinuxMonitor, resolveBinary: () => resolveDesktopRemoteDesktopLinuxBinary("capture"),
    spawn: (binary, arguments_) => spawn(binary, [...arguments_], { stdio: "pipe" }),
    grim: (arguments_, signal) => new Promise<Buffer>((resolveGrim, rejectGrim) => {
      const child = spawn("/usr/bin/grim", [...arguments_], { stdio: "pipe" });
      let bytes = Buffer.alloc(0); let failed = false;
      const stop = (): void => { failed = true; try { child.kill("SIGKILL"); } catch { /* Wait for close. */ } };
      const timer = setTimeout(stop, 2_500); signal.addEventListener("abort", stop, { once: true });
      child.stdin.end(); child.stderr.resume(); child.once("error", stop);
      child.stdout.on("data", (chunk: Buffer) => {
        if (bytes.length + chunk.length > MAXIMUM_JPEG_BYTES) stop(); else bytes = Buffer.concat([bytes, chunk]);
      });
      child.once("close", (code) => {
        clearTimeout(timer); signal.removeEventListener("abort", stop);
        if (failed || signal.aborted || code !== 0) rejectGrim(new Error("REMOTE_DESKTOP_VIDEO_UNAVAILABLE")); else resolveGrim(bytes);
      });
      if (signal.aborted) stop();
    }),
    image: (jpeg, edge, maximumBytes, quality) => {
      const original = nativeImage.createFromBuffer(jpeg); if (original.isEmpty()) throw new Error("invalid");
      let size = original.getSize(); let target = Math.min(1, edge / Math.max(size.width, size.height));
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const image = target >= 1 ? original : original.resize({ width: Math.max(1, Math.round(size.width * target)), height: Math.max(1, Math.round(size.height * target)) });
        const encoded = image.toJPEG(Math.round(quality * 100));
        if (encoded.length <= maximumBytes) { size = image.getSize(); return { jpeg: encoded, width: size.width, height: size.height }; }
        target *= 0.75;
      }
      throw new Error("invalid");
    }
  };
}
