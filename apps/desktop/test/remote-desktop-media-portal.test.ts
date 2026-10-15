import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { REMOTE_DESKTOP_CAPTURE_CHANNELS, type DesktopRemoteDesktopCaptureCommand } from "../src/remote-desktop-capture-protocol.js";

const h = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(), commands: [] as DesktopRemoteDesktopCaptureCommand[],
  windows: [] as { readonly mainFrame: { readonly url: string; readonly parent: null }; isDestroyed(): boolean }[],
  displayRequest: undefined as undefined | ((request: { readonly frame: unknown; readonly videoRequested: boolean;
    readonly audioRequested: boolean; readonly securityOrigin: string }, callback: (value: { readonly video?: unknown }) => void) => void),
  frame: null as null | { readonly jpeg: string; readonly width: number; readonly height: number },
  displayIds: [] as string[],
  getSources: vi.fn<() => Promise<{ readonly id: string; readonly display_id: string; readonly thumbnail?: unknown }[]>>(async () => [{ id: "screen:portal:0", display_id: "" }])
}));
vi.mock(import("../src/remote-desktop-linux.js"), async (original) => ({ ...await original(),
  supportsDesktopRemoteDesktopLinuxCapture: () => false }));
vi.mock("electron", () => {
  class Window {
    destroyed = false;
    webContents = Object.assign(new EventEmitter(), { mainFrame: { url: "https://remote-desktop.joko.invalid/capture", parent: null },
      isDestroyed: () => this.destroyed, setWindowOpenHandler: vi.fn(),
      send: (_channel: string, command: DesktopRemoteDesktopCaptureCommand) => {
        h.commands.push(command);
        if (command.op === "frame" || command.op === "offer") queueMicrotask(() => h.handlers.get(REMOTE_DESKTOP_CAPTURE_CHANNELS.reply)!(
          { sender: this.webContents, senderFrame: this.webContents.mainFrame }, command.id,
          command.op === "frame" ? { kind: "frame", frame: h.frame } : { kind: "offer", answerSdp: "answer" }));
      } });
    constructor() { h.windows.push(this.webContents); }
    isDestroyed() { return this.destroyed; }
    destroy() { this.destroyed = true; }
    async loadURL() { h.handlers.get(REMOTE_DESKTOP_CAPTURE_CHANNELS.ready)!({ sender: this.webContents, senderFrame: this.webContents.mainFrame }); }
  }
  return { app: {}, BrowserWindow: Window,
    ipcMain: { handle: (channel: string, handler: (...args: unknown[]) => unknown) => h.handlers.set(channel, handler),
      removeHandler: (channel: string) => h.handlers.delete(channel) },
    desktopCapturer: { getSources: h.getSources }, screen: { getAllDisplays: () => h.displayIds.map(id => ({ id })) }, systemPreferences: {}, nativeImage: {},
    session: { fromPartition: () => Object.assign(new EventEmitter(), { protocol: { handle: vi.fn(), unhandle: vi.fn() },
      setPermissionCheckHandler: vi.fn(), setPermissionRequestHandler: vi.fn(),
      setDisplayMediaRequestHandler: (handler: typeof h.displayRequest) => { h.displayRequest = handler; } }) } };
});
import { DesktopRemoteDesktopMedia } from "../src/remote-desktop-media.js";
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
const cleanup: DesktopRemoteDesktopMedia[] = [];
beforeEach(() => {
  Object.defineProperty(process, "platform", { ...platform, value: "linux" });
  h.handlers.clear(); h.commands.length = 0; h.windows.length = 0; h.frame = null;
  h.displayRequest = undefined; h.getSources.mockReset().mockResolvedValue([{ id: "screen:portal:0", display_id: "" }]);
  h.displayIds = [];
});
afterEach(async () => { for (const media of cleanup.splice(0)) await media.retire(); Object.defineProperty(process, "platform", platform); vi.useRealTimers(); });

function fixture() {
  const stopped = vi.fn(); const media = new DesktopRemoteDesktopMedia("/preload", undefined, stopped); cleanup.push(media);
  let current = true;
  const frame = (leaseId = "lease") => ({ displayId: "wayland-portal", leaseId, cursorOverlay: false,
    current: () => current, signal: new AbortController().signal });
  const offer = (attemptId: string, leaseId = "lease") => media.offer({ ...frame(leaseId), attemptId, offerSdp: "offer" });
  return { media, stopped, frame, offer, revoke: () => { current = false; } };
}
function request(owner = h.windows.at(-1)!) {
  return { frame: owner.mainFrame, videoRequested: true, audioRequested: false, securityOrigin: "https://remote-desktop.joko.invalid" };
}

describe("trusted Main portal capture owner", () => {
  it("forwards fresh credentials per attempt, falls back to public STUN, and rejects credentials aged during capture setup", async () => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-10-15T00:00:00Z"));
    const f = fixture(); h.displayIds = ["1"];
    const source = { id: "screen:1:0", display_id: "1" };
    h.getSources.mockResolvedValue([source]);
    const request = { ...f.frame(), displayId: "1", attemptId: "configured", offerSdp: "offer" };
    const iceServers = [{ urls: ["turn:relay.example.test:3478?transport=udp", "turns:relay.example.test:5349?transport=tcp"],
      username: "ephemeral-user", credential: "ephemeral-secret", expiresAt: Date.now() + 300_000 }];
    await expect(f.media.offer({ ...request, iceServers })).resolves.toBe("answer");
    expect(h.commands.findLast(value => value.op === "offer")).toMatchObject({ iceServers: [{
      urls: iceServers[0]!.urls, username: "ephemeral-user", credential: "ephemeral-secret"
    }], iceExpiresAt: iceServers[0]!.expiresAt });
    await f.media.offer({ ...request, attemptId: "unconfigured" });
    const fallback = h.commands.findLast(value => value.op === "offer");
    expect(fallback).toMatchObject({ iceServers: [{ urls: ["stun:stun.cloudflare.com:3478"] }, { urls: ["stun:stun.l.google.com:19302"] }] });
    expect(fallback).not.toHaveProperty("iceExpiresAt");
    h.getSources.mockImplementationOnce(async () => { vi.setSystemTime(Date.now() + 180_001); return [source]; });
    await expect(f.media.offer({ ...request, attemptId: "expired", iceServers })).rejects.toThrow("INVALID_REMOTE_DESKTOP_ICE_CONFIG");
    expect(h.commands.filter(value => value.op === "offer")).toHaveLength(2);
    expect(h.windows.at(-1)?.isDestroyed()).toBe(true);
  });

  it("Windows retains its exact physical-source JPEG path and rejects late pixels through the required frame owner", async () => {
    Object.defineProperty(process, "platform", { ...platform, value: "win32" });
    const f = fixture(); h.displayIds = ["1"];
    const source = { id: "screen:1:0", display_id: "1", thumbnail: { isEmpty: () => false,
      getSize: () => ({ width: 1, height: 1 }), toJPEG: () => Buffer.from([1]) } };
    h.getSources.mockResolvedValueOnce([source]);
    await expect(f.media.frame({ ...f.frame(), displayId: "1" })).resolves.toEqual({ jpeg: "AQ==", width: 1, height: 1 });
    let deliver!: (value: typeof source[]) => void;
    h.getSources.mockImplementationOnce(() => new Promise(resolve => { deliver = resolve; }));
    const late = f.media.frame({ ...f.frame(), displayId: "1" });
    await vi.waitFor(() => expect(deliver).toBeTypeOf("function"));
    f.revoke(); deliver([source]);
    await expect(late).resolves.toBeNull();
    expect(h.windows).toHaveLength(0);
  });

  it("preserves one window and consent grant through pending and repeated RTC offers", async () => {
    const f = fixture(); await expect(f.offer("pending")).rejects.toThrow("REMOTE_DESKTOP_CAPTURE_PENDING");
    expect(h.windows).toHaveLength(1); expect(h.commands.filter(value => value.op === "preparePortal")).toHaveLength(1);
    const granted = vi.fn(); h.displayRequest!(request(), granted);
    await vi.waitFor(() => expect(granted).toHaveBeenCalledWith({ video: { id: "screen:portal:0", display_id: "" } }));
    h.frame = { jpeg: "YWJj", width: 100, height: 50 };
    await expect(f.offer("one")).resolves.toBe("answer"); await expect(f.offer("two")).resolves.toBe("answer");
    expect(h.windows).toHaveLength(1); expect(h.windows[0]!.isDestroyed()).toBe(false);
    expect(h.commands.filter(value => value.op === "preparePortal")).toHaveLength(1);
    expect(h.commands.filter(value => value.op === "offer")).toEqual([
      expect.objectContaining({ attemptId: "one", portalCapture: true, nativeCapture: false, chromiumCapture: false }),
      expect.objectContaining({ attemptId: "two", portalCapture: true, nativeCapture: false, chromiumCapture: false })]);
    const again = vi.fn(); h.displayRequest!(request(), again); expect(again).toHaveBeenCalledWith({});
    expect(h.getSources).toHaveBeenCalledOnce();
  });

  it("rejects subframes and audio without consuming the exact mainFrame grant", async () => {
    const f = fixture(); await f.media.frame(f.frame());
    for (const bad of [{ ...request(), frame: {} }, { ...request(), audioRequested: true }]) {
      const callback = vi.fn(); h.displayRequest!(bad, callback); expect(callback).toHaveBeenCalledWith({});
    }
    expect(h.getSources).not.toHaveBeenCalled();
    const callback = vi.fn(); h.displayRequest!(request(), callback);
    await vi.waitFor(() => expect(callback).toHaveBeenCalledWith(expect.objectContaining({ video: expect.any(Object) })));
    expect(h.getSources).toHaveBeenCalledOnce();
  });

  it("a retired window's late local selection cannot grant replacement and its stopped IPC cannot terminate it", async () => {
    const f = fixture(); await f.media.frame(f.frame("old")); const old = h.windows[0]!;
    let selected!: (value: { id: string; display_id: string }[]) => void;
    h.getSources.mockImplementationOnce(() => new Promise(resolve => { selected = resolve; }));
    const callback = vi.fn(); h.displayRequest!(request(old), callback);
    await f.media.frame(f.frame("new"));
    expect(old.isDestroyed()).toBe(true); selected([{ id: "screen:portal:0", display_id: "" }]);
    await vi.waitFor(() => expect(callback).toHaveBeenCalledWith({}));
    expect(() => h.handlers.get(REMOTE_DESKTOP_CAPTURE_CHANNELS.stopped)!({ sender: old, senderFrame: old.mainFrame }, "old"))
      .toThrow("sender"); expect(f.stopped).not.toHaveBeenCalled();
    const replacement = vi.fn(); h.displayRequest!(request(), replacement);
    await vi.waitFor(() => expect(replacement).toHaveBeenCalledWith(expect.objectContaining({ video: expect.any(Object) })));
  });

  it("revoked lease selection fails closed and trusted actual stream-ended reports only its captured lease", async () => {
    const f = fixture(); await f.media.frame(f.frame());
    let selected!: (value: { id: string; display_id: string }[]) => void;
    h.getSources.mockImplementationOnce(() => new Promise(resolve => { selected = resolve; }));
    const callback = vi.fn(); h.displayRequest!(request(), callback); f.revoke();
    selected([{ id: "screen:portal:0", display_id: "" }]); await vi.waitFor(() => expect(callback).toHaveBeenCalledWith({}));
    const owner = h.windows[0]!;
    h.handlers.get(REMOTE_DESKTOP_CAPTURE_CHANNELS.stopped)!({ sender: owner, senderFrame: owner.mainFrame }, "lease");
    expect(f.stopped).toHaveBeenCalledExactlyOnceWith("lease"); expect(owner.isDestroyed()).toBe(true);
  });
});
