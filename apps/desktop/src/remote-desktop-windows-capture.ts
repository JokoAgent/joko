import { nativeImage, screen } from "electron";
import type { DesktopRemoteDesktopNativeFrame, DesktopRemoteDesktopCursor } from "./remote-desktop-native-capture.js";
import type { DesktopRemoteDesktopVideoSettings } from "./remote-desktop-media-settings.js";
import { desktopRemoteDesktopWindowsHost, type DesktopRemoteDesktopWindowsConnection } from "./remote-desktop-windows-host.js";

export interface DesktopRemoteDesktopWindowsCaptureRuntime {
  display(id: string): { readonly rect: readonly number[]; readonly scale: number } | undefined;
  open(rect: readonly number[], cursor: boolean, bitrate: number, signal?: AbortSignal): Promise<DesktopRemoteDesktopWindowsConnection>;
  encodeCursor(pixels: Buffer, size: { width: number; height: number }): Buffer;
}

/** Captures only through the current Main's authorized SYSTEM worker. */
export class DesktopRemoteDesktopWindowsCapture {
  readonly #runtime: DesktopRemoteDesktopWindowsCaptureRuntime;
  readonly #releases = new Set<DesktopRemoteDesktopWindowsConnection>();
  readonly #frames = new Set<Promise<DesktopRemoteDesktopNativeFrame | null>>();
  #connection: DesktopRemoteDesktopWindowsConnection | undefined;
  #configuration = "";
  #generation = 0;
  #pending = false;
  constructor(runtime: DesktopRemoteDesktopWindowsCaptureRuntime = {
    display: id => {
      const display = screen.getAllDisplays().find(item => String(item.id) === id);
      if (display === undefined) return undefined;
      const bounds = screen.dipToScreenRect(null, display.bounds);
      return { rect: [bounds.x, bounds.y, bounds.width, bounds.height], scale: display.scaleFactor };
    },
    open: (rect, cursorOverlay, bitrate, signal) => desktopRemoteDesktopWindowsHost.open({ mode: "capture", rect, cursorOverlay, bitrate }, signal),
    encodeCursor: (pixels, size) => nativeImage.createFromBitmap(pixels, size).toPNG()
  }) { this.#runtime = runtime; }

  async frame(displayId: string, streaming: boolean, cursorOverlay: boolean,
    settings?: DesktopRemoteDesktopVideoSettings, signal?: AbortSignal): Promise<DesktopRemoteDesktopNativeFrame | null> {
    const promise = this.#frame(displayId, streaming, cursorOverlay, settings, signal);
    this.#frames.add(promise);
    try { return await promise; } finally { this.#frames.delete(promise); }
  }

  async #frame(displayId: string, _streaming: boolean, cursorOverlay: boolean,
    settings?: DesktopRemoteDesktopVideoSettings, signal?: AbortSignal): Promise<DesktopRemoteDesktopNativeFrame | null> {
    if (this.#pending) return null;
    const display = this.#runtime.display(displayId);
    if (display === undefined) throw new Error("REMOTE_DESKTOP_VIDEO_UNAVAILABLE");
    const bitrate = settings?.quality === "hd" ? 20_000_000 : settings?.quality === "saver" ? 0 : 8_000_000;
    const configuration = JSON.stringify([displayId, display.rect, cursorOverlay, bitrate]);
    if (this.#connection !== undefined && configuration !== this.#configuration) this.stop();
    const generation = this.#generation;
    this.#pending = true;
    try {
      await this.#join();
      if (signal?.aborted || generation !== this.#generation) return null;
      if (this.#connection === undefined) {
        const connection = await this.#runtime.open(display.rect, cursorOverlay, bitrate, signal);
        if (signal?.aborted || generation !== this.#generation) {
          this.#release(connection); await this.#join(); return null;
        }
        this.#connection = connection;
        this.#configuration = configuration;
      }
      const connection = this.#connection;
      const frame = decodeDesktopRemoteDesktopWindowsFrame(await connection.request("f"), cursorOverlay, display.scale, this.#runtime.encodeCursor);
      return signal?.aborted || generation !== this.#generation || this.#connection !== connection ? null : frame;
    } catch {
      if (generation === this.#generation) this.stop();
      if (signal?.aborted) throw signal.reason;
      throw new Error("REMOTE_DESKTOP_VIDEO_UNAVAILABLE");
    } finally { if (generation === this.#generation) this.#pending = false; }
  }
  stop(): void {
    ++this.#generation; this.#pending = false; this.#configuration = "";
    const connection = this.#connection; this.#connection = undefined;
    if (connection !== undefined) this.#release(connection);
  }
  #release(connection: DesktopRemoteDesktopWindowsConnection): void {
    this.#releases.add(connection);
    void connection.close().then(() => { this.#releases.delete(connection); }, () => { /* Retain unknown worker release for retry. */ });
  }
  async #join(): Promise<void> {
    await Promise.all([...this.#releases].map(async connection => { await connection.close(); this.#releases.delete(connection); }));
  }
  async release(): Promise<void> { this.stop(); await Promise.allSettled([...this.#frames]); await this.#join(); }
}

/** Stable BGRA-to-PNG projection; unavailable cursor metadata drops only the overlay. */
export function decodeDesktopRemoteDesktopWindowsFrame(text: string, overlay: boolean, scale: number,
  encode: DesktopRemoteDesktopWindowsCaptureRuntime["encodeCursor"]): DesktopRemoteDesktopNativeFrame {
  if (Buffer.byteLength(text, "utf8") > 1_750_000 || !text.endsWith("\n")) throw new Error("invalid");
  const frame: unknown = JSON.parse(text);
  if (!record(frame) || Object.keys(frame).sort().join(",") !== "cursor,height,jpeg,width"
    || typeof frame["jpeg"] !== "string" || !dimension(frame["width"], 4_096) || !dimension(frame["height"], 4_096)
    || !base64(frame["jpeg"], 1_000_000)) throw new Error("invalid");
  let cursor: DesktopRemoteDesktopCursor | null = null;
  const raw = frame["cursor"];
  if (overlay && record(raw) && typeof raw["visible"] === "boolean" && unit(raw["x"]) && unit(raw["y"])
    && dimension(raw["width"], 256) && dimension(raw["height"], 256)
    && typeof raw["hotX"] === "number" && Number.isFinite(raw["hotX"]) && raw["hotX"] >= 0 && raw["hotX"] <= raw["width"]
    && typeof raw["hotY"] === "number" && Number.isFinite(raw["hotY"]) && raw["hotY"] >= 0 && raw["hotY"] <= raw["height"]
    && typeof raw["bgra"] === "string" && base64(raw["bgra"], 256 * 256 * 4)) {
    const pixels = Buffer.from(raw["bgra"], "base64");
    if (pixels.byteLength === raw["width"] * raw["height"] * 4) {
      try {
        const png = encode(pixels, { width: raw["width"], height: raw["height"] });
        const factor = Number.isFinite(scale) && scale > 0 ? scale : 1;
        if (png.byteLength >= 33 && png.byteLength <= 49_152) cursor = Object.freeze({
          visible: raw["visible"], x: raw["x"], y: raw["y"], width: raw["width"] / factor,
          height: raw["height"] / factor, hotX: raw["hotX"] / factor, hotY: raw["hotY"] / factor, png: png.toString("base64")
        });
      } catch { /* Cursor conversion does not retire valid video. */ }
    }
  }
  return Object.freeze({ jpeg: frame["jpeg"], width: frame["width"], height: frame["height"], cursor });
}
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function dimension(value: unknown, bound: number): value is number { return Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= bound; }
function unit(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1; }
function base64(value: string, bound: number): boolean {
  if (!value || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(value)) return false;
  const bytes = Buffer.from(value, "base64");
  return bytes.length >= 1 && bytes.length <= bound && bytes.toString("base64") === value;
}
