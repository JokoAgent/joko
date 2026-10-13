import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { REMOTE_DESKTOP_CAPTURE_CHANNELS, type DesktopRemoteDesktopCaptureCommand } from "../src/remote-desktop-capture-protocol.js";

const h = vi.hoisted(() => ({ handlers: new Map<string, (...args: unknown[]) => unknown>(),
  commands: [] as DesktopRemoteDesktopCaptureCommand[],
  windows: [] as { readonly mainFrame: { readonly url: string; readonly parent: null }; isDestroyed(): boolean }[],
  supported: true, native: true, sources: vi.fn(async () => [{ id: "screen:1:0", display_id: "1" }]) }));
vi.mock("../src/remote-desktop-linux-audio.js", () => ({ supportsDesktopRemoteDesktopLinuxAudio: () => h.supported,
  DesktopRemoteDesktopLinuxAudio: class {} }));
vi.mock(import("../src/remote-desktop-linux.js"), async original => ({ ...await original(),
  supportsDesktopRemoteDesktopLinuxCapture: () => h.native }));
vi.mock("electron", () => {
  class Window {
    destroyed = false;
    webContents = Object.assign(new EventEmitter(), { mainFrame: { url: "https://remote-desktop.joko.invalid/capture", parent: null },
      isDestroyed: () => this.destroyed, setWindowOpenHandler: vi.fn(),
      send: (_channel: string, command: DesktopRemoteDesktopCaptureCommand) => {
        h.commands.push(command);
        if (command.op === "offer") queueMicrotask(() => h.handlers.get(REMOTE_DESKTOP_CAPTURE_CHANNELS.reply)!(
          { sender: this.webContents, senderFrame: this.webContents.mainFrame }, command.id, { kind: "offer", answerSdp: "answer" }));
      } });
    constructor() { h.windows.push(this.webContents); }
    isDestroyed() { return this.destroyed; }
    destroy() { this.destroyed = true; }
    async loadURL() { h.handlers.get(REMOTE_DESKTOP_CAPTURE_CHANNELS.ready)!({ sender: this.webContents, senderFrame: this.webContents.mainFrame }); }
  }
  return { app: {}, BrowserWindow: Window, desktopCapturer: { getSources: h.sources }, screen: { getAllDisplays: () => [{ id: 1 }] },
    ipcMain: { handle: (channel: string, fn: (...args: unknown[]) => unknown) => h.handlers.set(channel, fn), removeHandler: (channel: string) => h.handlers.delete(channel) },
    nativeImage: {}, systemPreferences: {}, session: { fromPartition: () => Object.assign(new EventEmitter(), {
      protocol: { handle: vi.fn(), unhandle: vi.fn() }, setPermissionCheckHandler: vi.fn(),
      setPermissionRequestHandler: vi.fn(), setDisplayMediaRequestHandler: vi.fn() }) } };
});
import { DesktopRemoteDesktopMedia, type DesktopRemoteDesktopNativeAudioPort } from "../src/remote-desktop-media.js";
import { readDesktopSystemAudioSupport } from "../src/remote-desktop-media-settings.js";
import type { DesktopRemoteDesktopSessionState } from "../src/remote-desktop-input.js";

const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
const cleanup: DesktopRemoteDesktopMedia[] = [];
beforeEach(() => { Object.defineProperty(process, "platform", { ...platform, value: "linux" });
  h.handlers.clear(); h.commands.length = 0; h.windows.length = 0; h.supported = true; h.native = true; h.sources.mockClear(); });
afterEach(async () => { for (const media of cleanup.splice(0)) await media.retire(); Object.defineProperty(process, "platform", platform); });

function fixture() {
  const lower = { supports: vi.fn(() => true), start: vi.fn<DesktopRemoteDesktopNativeAudioPort["start"]>(async () => undefined),
    read: vi.fn<DesktopRemoteDesktopNativeAudioPort["read"]>(async () => new Uint8Array(8)),
    stop: vi.fn<DesktopRemoteDesktopNativeAudioPort["stop"]>(async () => undefined) };
  const session = vi.fn<(signal: AbortSignal) => Promise<DesktopRemoteDesktopSessionState>>(async () => "unlocked");
  const media = new DesktopRemoteDesktopMedia("/preload", undefined, undefined, lower, session); cleanup.push(media);
  let current = true;
  const offer = (attemptId = "attempt", audio = true) => media.offer({ displayId: "1", leaseId: "lease", attemptId,
    offerSdp: "offer", cursorOverlay: false, current: () => current, signal: new AbortController().signal,
    settings: { fps: 30, quality: "auto", audio } });
  const audioCommand = () => {
    const value = h.commands.findLast(command => command.op === "nativeAudio" && command.enabled);
    if (value?.op !== "nativeAudio") throw new Error("Missing native audio occurrence.");
    return value;
  };
  const read = (command = audioCommand(), event = { sender: h.windows.at(-1), senderFrame: h.windows.at(-1)!.mainFrame }) =>
    h.handlers.get(REMOTE_DESKTOP_CAPTURE_CHANNELS.nativeAudio)!(event, command.leaseId, command.attemptId, command.audioRevision);
  return { media, lower, session, offer, audioCommand, read, revoke: () => { current = false; } };
}

describe("Linux native output audio capture owner", () => {
  it("adopts only native Linux audio without Chromium source grants and keeps an initial audio failure optional", async () => {
    const f = fixture(); f.lower.start.mockRejectedValueOnce(new Error("DESKTOP_AUDIO_UNAVAILABLE"));
    await expect(f.offer()).resolves.toBe("answer");
    expect(h.sources).not.toHaveBeenCalled(); expect(h.windows[0]!.isDestroyed()).toBe(false);
    expect(h.commands.find(value => value.op === "offer")).toMatchObject({ nativeAudio: true, audioRevision: 1,
      nativeCapture: true, nativeVideo: true, chromiumCapture: false });
    expect(h.commands.findLast(value => value.op === "nativeAudio")).toMatchObject({ enabled: false });
  });

  it("admits PCM only from the exact capture document, lease, attempt and audio occurrence", async () => {
    const f = fixture(); await f.offer(); await expect(f.read()).resolves.toEqual(new Uint8Array(8));
    const command = f.audioCommand();
    for (const changed of [{ ...command, leaseId: "other" }, { ...command, attemptId: "old" }, { ...command, audioRevision: 0 }]) {
      await expect(f.read(changed)).rejects.toThrow("AUDIO_UNAVAILABLE");
    }
    await expect(f.read(command, { sender: h.windows[0], senderFrame: { ...h.windows[0]!.mainFrame, url: "https://other.invalid" } })).rejects.toThrow("sender");
    expect(f.lower.read).toHaveBeenCalledOnce();
  });

  it("a late old fresh-session proof cannot read or stop a replacement audio owner", async () => {
    const f = fixture(); await f.offer(); let resolve!: (state: DesktopRemoteDesktopSessionState) => void;
    f.session.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const pending = f.read(); const rejected = expect(pending).rejects.toThrow("AUDIO_UNAVAILABLE");
    await f.offer("replacement"); const replacement = f.lower.start.mock.calls.at(-1)![0];
    const stopCount = f.lower.stop.mock.calls.length; resolve("locked-logged-in"); await rejected;
    expect(f.lower.read).not.toHaveBeenCalled(); expect(f.lower.stop).toHaveBeenCalledTimes(stopCount);
    expect(f.lower.stop.mock.calls.every(call => call[0] !== replacement)).toBe(true);
    await expect(f.read()).resolves.toEqual(new Uint8Array(8));
  });

  it("fresh lock clears exact PCM while video survives and known unlock softly replaces that audio occurrence", async () => {
    const f = fixture(); await f.offer(); const previous = f.audioCommand(); const window = h.windows[0]!;
    f.session.mockResolvedValueOnce("locked-logged-in");
    await expect(f.read()).rejects.toThrow("AUDIO_UNAVAILABLE"); expect(f.lower.read).not.toHaveBeenCalled();
    f.media.setSessionState(false, "unknown"); f.media.setSessionState(true, "locked-logged-in");
    expect(window.isDestroyed()).toBe(false); expect(h.commands.findLast(value => value.op === "captureReset")).toMatchObject({ resume: true });
    f.media.setSessionState(false, "unlocked"); await vi.waitFor(() => expect(f.lower.start).toHaveBeenCalledTimes(2));
    expect(f.audioCommand().audioRevision).toBeGreaterThan(previous.audioRevision);
    await expect(f.read(previous)).rejects.toThrow("AUDIO_UNAVAILABLE");
    expect(h.commands.filter(value => value.op === "offer")).toHaveLength(1);
  });

  it("drops PCM after a late session change and clears optional audio on malformed frame bounds", async () => {
    const f = fixture(); await f.offer(); f.session.mockResolvedValueOnce("unlocked").mockResolvedValueOnce("locked-logged-in");
    await expect(f.read()).rejects.toThrow("AUDIO_UNAVAILABLE");
    expect(f.lower.read).toHaveBeenCalledOnce(); expect(h.windows[0]!.isDestroyed()).toBe(false);
    await f.offer("second"); f.lower.read.mockResolvedValueOnce(new Uint8Array(38_408));
    await expect(f.read()).rejects.toThrow("AUDIO_UNAVAILABLE"); expect(h.windows.at(-1)!.isDestroyed()).toBe(false);
  });

  it("audio off and retirement join the captured actual close without claiming a stop call is completion", async () => {
    const f = fixture(); await f.offer(); let close!: () => void;
    f.lower.stop.mockImplementationOnce(() => new Promise(done => { close = done; }));
    await f.offer("off", false); expect(h.commands.findLast(value => value.op === "offer")).not.toHaveProperty("nativeAudio");
    let retired = false; const pending = f.media.retire().then(() => { retired = true; });
    await Promise.resolve(); expect(retired).toBe(false); close(); await pending; expect(retired).toBe(true);
  });

  it("Linux capability comes from actual lower support while portal audio remains unavailable", async () => {
    expect(readDesktopSystemAudioSupport()).toBe(true); h.supported = false;
    expect(readDesktopSystemAudioSupport()).toBe(false); const f = fixture();
    await expect(f.offer()).rejects.toThrow("AUDIO_UNAVAILABLE"); expect(f.lower.start).not.toHaveBeenCalled();
  });
});
