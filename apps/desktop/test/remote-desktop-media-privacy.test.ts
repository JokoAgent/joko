import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { REMOTE_DESKTOP_CAPTURE_CHANNELS, type DesktopRemoteDesktopCaptureCommand } from "../src/remote-desktop-capture-protocol.js";

const h = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  commands: [] as DesktopRemoteDesktopCaptureCommand[],
  owner: undefined as undefined | { readonly mainFrame: { readonly url: string; readonly parent: null }; isDestroyed(): boolean },
  getSources: vi.fn(async () => [{ display_id: "1", id: "screen:1:0" }])
}));
vi.mock("electron", () => {
  class Window {
    destroyed = false;
    webContents = Object.assign(new EventEmitter(), {
      mainFrame: { url: "https://remote-desktop.joko.invalid/capture", parent: null },
      isDestroyed: () => this.destroyed, setWindowOpenHandler: vi.fn(),
      send: (_channel: string, command: DesktopRemoteDesktopCaptureCommand) => {
        h.commands.push(command);
        if (command.op === "offer") queueMicrotask(() => h.handlers.get("joko:remote-desktop-capture:reply")!(
          { sender: this.webContents, senderFrame: this.webContents.mainFrame }, command.id, { kind: "offer", answerSdp: "answer" }));
      }
    });
    constructor() { h.owner = this.webContents; }
    isDestroyed() { return this.destroyed; }
    destroy() { this.destroyed = true; }
    async loadURL() { h.handlers.get("joko:remote-desktop-capture:ready")!({ sender: this.webContents, senderFrame: this.webContents.mainFrame }); }
  }
  return { app: {}, BrowserWindow: Window,
    ipcMain: { handle: (channel: string, handler: (...args: unknown[]) => unknown) => h.handlers.set(channel, handler), removeHandler: (channel: string) => h.handlers.delete(channel) },
    desktopCapturer: { getSources: h.getSources }, screen: { getAllDisplays: () => [{ id: 1 }] },
    systemPreferences: { getMediaAccessStatus: () => "granted" },
    nativeImage: { createFromBuffer: () => ({ isEmpty: () => false, getSize: () => ({ width: 1, height: 1 }), toJPEG: () => Buffer.from([1]) }) },
    session: { fromPartition: () => Object.assign(new EventEmitter(), { protocol: { handle: vi.fn(), unhandle: vi.fn() },
      setPermissionCheckHandler: vi.fn(), setPermissionRequestHandler: vi.fn(), setDisplayMediaRequestHandler: vi.fn() }) }
  };
});
import { DesktopRemoteDesktopMedia } from "../src/remote-desktop-media.js";
import { DesktopRemoteDesktopNativeCapture } from "../src/remote-desktop-native-capture.js";

const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
const cleanup: DesktopRemoteDesktopMedia[] = [];
beforeEach(() => { Object.defineProperty(process, "platform", { ...platform, value: "darwin" }); h.handlers.clear(); h.commands.length = 0; h.getSources.mockClear(); });
afterEach(async () => { for (const media of cleanup.splice(0)) await media.retire(); Object.defineProperty(process, "platform", platform); });

describe("Remote Desktop privacy capture receipt", () => {
  it("unions overlay and privacy windows and restores each remaining owner independently", async () => {
    const f = fixture(), owner = {};
    await f.media.setOverlayExclusions([20]); f.media.setPrivacyExclusions(owner, [10]);
    const combined = f.media.frame(frameRequest()); await vi.waitFor(() => expect(f.children).toHaveLength(1));
    expect(f.args[0]).toEqual(["1", "10,20"]); f.respond(0); await combined;
    f.media.clearPrivacyExclusions(owner);
    const overlay = f.media.frame(frameRequest()); await vi.waitFor(() => expect(f.children).toHaveLength(2));
    expect(f.args[1]).toEqual(["1", "20"]); f.respond(1); await overlay;
    f.media.setPrivacyExclusions(owner, [10]); await f.media.setOverlayExclusions([]);
    const privacy = f.media.frame(frameRequest()); await vi.waitFor(() => expect(f.children).toHaveLength(3));
    expect(f.args[2]).toEqual(["1", "10"]); f.respond(2); await privacy;
    expect(h.getSources).not.toHaveBeenCalled();
  });
  it("requires a current filtered native frame for JPEG and ignores an old owner's clear", async () => {
    const f = fixture(); const owner = {};
    f.media.setPrivacyExclusions(owner, [9]);
    let settled = false;
    const preparing = f.media.preparePrivacy(owner, "1", () => true, new AbortController().signal).then(() => { settled = true; });
    await vi.waitFor(() => expect(f.children).toHaveLength(1));
    expect(settled).toBe(false);
    expect(f.args[0]).toEqual(["1", "9"]);
    f.respond(0); await preparing;
    f.children[0]!.stdin.on("data", () => f.respond(0));
    await expect(f.media.frame(frameRequest())).resolves.toMatchObject({ width: 1, height: 1 });
    expect(h.getSources).not.toHaveBeenCalled();
    f.media.setPrivacyExclusions({}, [10]);
    f.media.clearPrivacyExclusions(owner);
    const next = f.media.frame(frameRequest());
    await vi.waitFor(() => expect(f.children).toHaveLength(2));
    expect(f.args[1]).toEqual(["1", "10"]);
    f.respond(1); await next;
    expect(h.getSources).not.toHaveBeenCalled();
  });

  it("requires the exact trusted source receipt and filtered frame after an active RTC offer", async () => {
    const f = fixture(); await f.offer(); const owner = {};
    f.media.setPrivacyExclusions(owner, [9]);
    const pending = f.media.preparePrivacy(owner, "1", () => true, new AbortController().signal);
    await vi.waitFor(() => expect(h.commands.at(-1)?.op).toBe("nativeSource"));
    const source = h.commands.at(-1)! as Extract<DesktopRemoteDesktopCaptureCommand, { op: "nativeSource" }>;
    const event = { sender: h.owner, senderFrame: h.owner!.mainFrame };
    await expect(h.handlers.get(REMOTE_DESKTOP_CAPTURE_CHANNELS.nativeFrame)!(event, "lease", "attempt", 0)).resolves.toBeNull();
    expect(() => h.handlers.get(REMOTE_DESKTOP_CAPTURE_CHANNELS.reply)!({ ...event, sender: {} }, source.id,
      { kind: "nativeSource", sourceRevision: source.sourceRevision })).toThrow("sender");
    const native = h.handlers.get(REMOTE_DESKTOP_CAPTURE_CHANNELS.nativeFrame)!(event, "lease", "attempt", source.sourceRevision);
    await vi.waitFor(() => expect(f.children).toHaveLength(1)); f.respond(0); await native;
    h.handlers.get(REMOTE_DESKTOP_CAPTURE_CHANNELS.reply)!(event, source.id, { kind: "nativeSource", sourceRevision: source.sourceRevision });
    await pending;
    expect(f.args[0]!.at(-1)).toBe("9");
  });

  it("rejects a renderer ACK without filtered pixels and never replaces it with Chromium JPEG", async () => {
    const f = fixture(); await f.offer(); const owner = {};
    f.media.setPrivacyExclusions(owner, [9]);
    const pending = f.media.preparePrivacy(owner, "1", () => true, new AbortController().signal);
    const rejection = expect(pending).rejects.toThrow("PRIVACY_UNAVAILABLE");
    await vi.waitFor(() => expect(h.commands.at(-1)?.op).toBe("nativeSource"));
    const source = h.commands.at(-1)! as Extract<DesktopRemoteDesktopCaptureCommand, { op: "nativeSource" }>;
    h.handlers.get(REMOTE_DESKTOP_CAPTURE_CHANNELS.reply)!({ sender: h.owner, senderFrame: h.owner!.mainFrame },
      source.id, { kind: "nativeSource", sourceRevision: source.sourceRevision });
    await rejection;
    const jpeg = f.media.frame(frameRequest());
    const failed = expect(jpeg).rejects.toThrow("VIDEO_UNAVAILABLE");
    await vi.waitFor(() => expect(f.children).toHaveLength(1)); f.children[0]!.process.emit("exit", 5); await failed;
    expect(h.getSources).toHaveBeenCalledOnce();
    expect(f.args[0]).toEqual(["1", "9"]);
  });

  it("does not adopt an old source ACK or let an old clear remove replacement exclusions", async () => {
    const f = fixture(); await f.offer(); const previous = {}, replacement = {};
    f.media.setPrivacyExclusions(previous, [9]);
    const pending = f.media.preparePrivacy(previous, "1", () => true, new AbortController().signal);
    const rejected = expect(pending).rejects.toThrow("PRIVACY_EXPIRED");
    await vi.waitFor(() => expect(h.commands.at(-1)?.op).toBe("nativeSource"));
    const source = h.commands.at(-1)! as Extract<DesktopRemoteDesktopCaptureCommand, { op: "nativeSource" }>;
    f.media.setPrivacyExclusions(replacement, [10]); f.media.clearPrivacyExclusions(previous);
    h.handlers.get(REMOTE_DESKTOP_CAPTURE_CHANNELS.reply)!({ sender: h.owner, senderFrame: h.owner!.mainFrame },
      source.id, { kind: "nativeSource", sourceRevision: source.sourceRevision });
    await rejected;
    const next = f.media.frame(frameRequest());
    await vi.waitFor(() => expect(f.children).toHaveLength(1));
    expect(f.args[0]).toEqual(["1", "10"]); f.respond(0); await next;
  });
});

function frameRequest() {
  return { displayId: "1", leaseId: "lease", cursorOverlay: false, current: () => true, signal: new AbortController().signal };
}

function fixture() {
  const children: { readonly process: ChildProcessWithoutNullStreams; readonly stdin: PassThrough; readonly stdout: PassThrough }[] = [], args: string[][] = [];
  const native = new DesktopRemoteDesktopNativeCapture({ platform: "darwin", resolveBinary: async () => "/capture",
    spawn: (_binary, values) => {
      args.push([...values]);
      const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough();
      const stdio: [PassThrough, PassThrough, PassThrough] = [stdin, stdout, stderr];
      const process = Object.assign(new ChildProcess(), { stdin, stdout, stderr, stdio, kill: vi.fn(() => true) });
      children.push({ process, stdin, stdout }); return process;
    } });
  const media = new DesktopRemoteDesktopMedia("/preload", native); cleanup.push(media);
  const respond = (index: number) => children[index]!.stdout.write(`${JSON.stringify({ jpeg: "AQ==", width: 1, height: 1, cursor: null })}\n`);
  const offer = () => media.offer({ displayId: "1", leaseId: "lease", attemptId: "attempt", offerSdp: "offer", cursorOverlay: false,
    current: () => true, signal: new AbortController().signal });
  return { media, children, args, respond, offer };
}
