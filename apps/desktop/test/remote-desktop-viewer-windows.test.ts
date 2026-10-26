import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IpcMainInvokeEvent, WebContents } from "electron";
import type { DesktopRemoteDesktopViewerOwner } from "@joko/contracts";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { RemoteDesktopService } from "@joko/contracts";
import { createNavigationPolicy } from "../src/security.js";
import { nativeClipboard, type DesktopViewerSyncClipboard } from "../src/remote-desktop-viewer-clipboard-sync.js";
import type { DesktopViewerCredentialNative } from "../src/remote-desktop-viewer-credentials.js";

const state = vi.hoisted(() => ({ handlers: new Map<string, (...args: any[]) => any>(), windows: [] as any[], connections: [] as any[],
  writeClipboard: vi.fn(), readText: vi.fn(() => "local text") }));
vi.mock("electron", async () => {
  const { EventEmitter } = await import("node:events");
  class Contents extends EventEmitter { mainFrame = { url: "" }; sent: unknown[][] = [];
    setIgnoreMenuShortcuts = vi.fn();
    isDestroyed() { return false; } send(...args: unknown[]) { this.sent.push(args); } setWindowOpenHandler() {} }
  class Window extends EventEmitter {
    webContents = new Contents(); visible = false; minimized = false; focused = false; destroyed = false;
    fullscreen = false; maximized = false; bounds = { x: 200, y: 120, width: 1120, height: 760 };
    setBounds = vi.fn((bounds: typeof this.bounds) => { this.bounds = bounds; });
    title: string;
    constructor(readonly options: object) { super(); this.title = (options as { title: string }).title; state.windows.push(this); }
    setTitle(value: string) { this.title = value; }
    loadURL = vi.fn(async (url: string) => { this.webContents.mainFrame.url = url; this.webContents.emit("did-start-navigation", {}, url, false, true); this.webContents.emit("did-finish-load"); });
    isVisible() { return this.visible; } isMinimized() { return this.minimized; } isFocused() { return this.focused; }
    isDestroyed() { return this.destroyed; }
    show() { this.visible = true; this.emit("show"); } restore() { this.minimized = false; this.emit("restore"); }
    focus() { this.focused = true; } setFullScreen(value: boolean) { this.fullscreen = value; } isFullScreen() { return this.fullscreen; }
    isMaximized() { return this.maximized; } unmaximize() { this.maximized = false; }
    getBounds() { return this.bounds; }
    getContentBounds() { return { ...this.bounds, width: this.bounds.width - 16, height: this.bounds.height - 36 }; }
    getMinimumSize() { return [640, 420]; }
    minimize() { this.minimized = true; this.emit("minimize"); }
    hide() { this.visible = false; this.emit("hide"); }
    destroy() { this.destroyed = true; this.emit("closed"); }
  }
  return { BrowserWindow: Window, ipcMain: { handle: (name: string, handler: (...args: any[]) => any) => state.handlers.set(name, handler) },
    clipboard: { availableFormats: () => [], readImage: () => ({ isEmpty: () => true }), readText: state.readText,
      readHTML: () => "", readRTF: () => "", write: state.writeClipboard }, nativeImage: {},
    nativeTheme: { shouldUseDarkColors: false },
    screen: { getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1440, height: 900 } }) } };
});
vi.mock("../src/remote-desktop-viewer-connection.js", () => ({ DesktopRemoteDesktopViewerConnection: class {
  current = true; lease = undefined; caps = undefined; request = vi.fn(async (_name: string, _bytes: Uint8Array, guard?: () => void) => { guard?.(); return { ok: true, bytes: new Uint8Array() }; });
  stop = vi.fn(async () => undefined); call = vi.fn(async () => undefined); retire = vi.fn(() => { this.current = false; });
  syncRequest = vi.fn(async () => ({ ok: false, code: 9, reason: 0 }));
  constructor() { state.connections.push(this); }
} }));
import { DesktopRemoteDesktopViewerWindows, REMOTE_DESKTOP_VIEWER_CHANNELS as C } from "../src/remote-desktop-viewer-windows.js";

const OWNER: DesktopRemoteDesktopViewerOwner = { profileId: "profile", serverId: "node", deviceId: "self", origin: "https://node.example", connectionGeneration: 1 };
const TARGET = { deviceId: "peer", name: "Remote desktop" };
const owners: DesktopRemoteDesktopViewerWindows[] = [];
afterEach(() => { for (const owner of owners.splice(0)) owner.dispose(); state.handlers.clear(); state.windows.length = 0; state.connections.length = 0; state.writeClipboard.mockClear(); vi.useRealTimers(); });

function fixture(syncClipboard?: DesktopViewerSyncClipboard, credentialNative?: DesktopViewerCredentialNative,
  windowPlatform?: NodeJS.Platform, observeNativeCleanup?: (stage: string) => void) {
  const source = { isDestroyed: () => false } as WebContents;
  let quitting = false;
  const readAuthKey = vi.fn(async () => "A".repeat(43));
  const syncClipboardFactory = vi.fn(() => syncClipboard ?? nativeClipboard());
  const credentialNativeFactory = vi.fn(() => credentialNative!);
  const onOwnerRetired = vi.fn();
  const saved = new Map<string, { audio: boolean; hostMute: boolean; lockOnExit: boolean; clipboardSync: boolean; privacyScreen: boolean }>();
  const preferenceKey = (owner: Pick<DesktopRemoteDesktopViewerOwner, "profileId" | "serverId" | "deviceId">, target: string) =>
    JSON.stringify([owner.profileId, owner.serverId, owner.deviceId, target]);
  const preferences = { initialize: async () => undefined,
    get: vi.fn((owner: Pick<DesktopRemoteDesktopViewerOwner, "profileId" | "serverId" | "deviceId">, target: string) => saved.get(preferenceKey(owner, target)) ?? ({ audio: true, hostMute: false, lockOnExit: false, clipboardSync: false, privacyScreen: false })),
    setAudio: vi.fn(async (owner: Pick<DesktopRemoteDesktopViewerOwner, "profileId" | "serverId" | "deviceId">, target: string, audio: boolean, check?: () => void) => {
      check?.(); const key = preferenceKey(owner, target), value = { audio, hostMute: saved.get(key)?.hostMute ?? false, lockOnExit: saved.get(key)?.lockOnExit ?? false, clipboardSync: saved.get(key)?.clipboardSync ?? false, privacyScreen: saved.get(key)?.privacyScreen ?? false };
      saved.set(key, value); return value;
    }),
    setHostMute: vi.fn(async (owner: Pick<DesktopRemoteDesktopViewerOwner, "profileId" | "serverId" | "deviceId">, target: string, hostMute: boolean, check?: () => void) => {
      check?.(); const key = preferenceKey(owner, target), value = { audio: saved.get(key)?.audio ?? true, hostMute, lockOnExit: saved.get(key)?.lockOnExit ?? false, clipboardSync: saved.get(key)?.clipboardSync ?? false, privacyScreen: saved.get(key)?.privacyScreen ?? false };
      saved.set(key, value); return value;
    }),
    setLockOnExit: vi.fn(async (owner: Pick<DesktopRemoteDesktopViewerOwner, "profileId" | "serverId" | "deviceId">, target: string, lockOnExit: boolean, check?: () => void) => {
      check?.(); const key = preferenceKey(owner, target), value = { audio: saved.get(key)?.audio ?? true, hostMute: saved.get(key)?.hostMute ?? false, lockOnExit, clipboardSync: saved.get(key)?.clipboardSync ?? false, privacyScreen: saved.get(key)?.privacyScreen ?? false };
      saved.set(key, value); return value;
    }),
    setClipboardSync: vi.fn(async (owner: Pick<DesktopRemoteDesktopViewerOwner, "profileId" | "serverId" | "deviceId">, target: string, clipboardSync: boolean, check?: () => void) => {
      check?.(); const key = preferenceKey(owner, target), value = { audio: saved.get(key)?.audio ?? true, hostMute: saved.get(key)?.hostMute ?? false, lockOnExit: saved.get(key)?.lockOnExit ?? false, clipboardSync, privacyScreen: saved.get(key)?.privacyScreen ?? false };
      saved.set(key, value); return value;
    }),
    setPrivacyScreen: vi.fn(async (owner: Pick<DesktopRemoteDesktopViewerOwner, "profileId" | "serverId" | "deviceId">, target: string, privacyScreen: boolean, check?: () => void) => {
      check?.(); const key = preferenceKey(owner, target), value = { ...preferences.get(owner, target), privacyScreen };
      saved.set(key, value); return value;
    }) };
  const manager = new DesktopRemoteDesktopViewerWindows({ sourceDirectory: resolve("dist"), entryUrl: "joko://app/index.html",
    ...(observeNativeCleanup === undefined ? {} : { observeNativeCleanup }),
    navigation: createNavigationPolicy(resolve("dist/web/index.html")), readAuthKey, preferences, syncClipboard: syncClipboardFactory,
    ...(credentialNative ? { credentialNative: credentialNativeFactory, credentialPlatform: "darwin" } : {}),
    ...(windowPlatform ? { windowPlatform } : {}),
    locale: () => "en", quitting: () => quitting, onOwnerRetired, assertSource: (event, occurrence) => {
      if (event.sender !== source || occurrence !== "document") throw new Error("Wrong document.");
    } });
  manager.register(); owners.push(manager);
  const invoke = (channel: string, event: object, ...args: unknown[]) => state.handlers.get(channel)!(event, ...args);
  const event = { sender: source } as IpcMainInvokeEvent;
  const viewerEvent = (window = state.windows[0]) => ({ sender: window.webContents, senderFrame: window.webContents.mainFrame });
  return { source, manager, event, invoke, viewerEvent, preferences, readAuthKey, syncClipboardFactory,
    credentialNativeFactory, onOwnerRetired, setQuitting: (value: boolean) => { quitting = value; } };
}

function targetWindows(): any[] { return state.windows.filter(window => window.title !== "Remote Desktop"); }

function electronClipboardPort(): DesktopViewerSyncClipboard {
  const unused = vi.fn(async (): Promise<never> => { throw new Error("This transfer uses the Main-owned Electron clipboard."); });
  return { platform: "win32", available: true, version: unused, read: unused, write: unused, stop: vi.fn() };
}

describe("Desktop viewer native windows", () => {
  it("fences native menu bypass to the current trusted viewer focus and retires it with its owner", async () => {
    const f = fixture(); f.invoke(C.bind, f.event, "document", OWNER); await f.invoke(C.open, f.event, "document", OWNER, TARGET);
    const window = targetWindows()[0], event = f.viewerEvent(window), generation = f.invoke(C.state, event).generation;
    expect(() => f.invoke(C.inputFocus, event, generation, true)).toThrow("inactive");
    f.invoke(C.ready, event, generation);
    const menus = window.webContents.setIgnoreMenuShortcuts;
    f.invoke(C.inputFocus, event, generation, true); expect(menus).toHaveBeenLastCalledWith(true);
    f.invoke(C.inputFocus, event, generation, false); expect(menus).toHaveBeenLastCalledWith(false);
    for (const value of [undefined, "true", 1]) expect(() => f.invoke(C.inputFocus, event, generation, value)).toThrow("focus");
    expect(() => f.invoke(C.inputFocus, { ...event, senderFrame: {} }, generation, true)).toThrow("retired");
    f.manager.prewarm();
    const spare = state.windows.find(value => value !== window);
    expect(() => f.invoke(C.inputFocus, f.viewerEvent(spare), 0, true)).toThrow("focus");
    window.focused = false;
    f.invoke(C.inputFocus, event, generation, true); expect(menus).toHaveBeenLastCalledWith(false);
    window.focused = true; f.invoke(C.inputFocus, event, generation, true);
    window.hide(); expect(menus).toHaveBeenLastCalledWith(false);
    const next = f.invoke(C.state, event).generation;
    await f.invoke(C.open, f.event, "document", OWNER, TARGET);
    f.invoke(C.inputFocus, event, next, true); expect(menus).toHaveBeenLastCalledWith(true);
    expect(() => f.invoke(C.inputFocus, event, generation, false)).toThrow("retired");
    expect(menus).toHaveBeenLastCalledWith(true);
    window.focused = false; window.emit("blur"); expect(menus).toHaveBeenLastCalledWith(false);
    window.focused = true; f.invoke(C.inputFocus, event, next, true);
    f.manager.retireSource(f.source); expect(menus).toHaveBeenLastCalledWith(false);
    expect(() => f.invoke(C.inputFocus, event, next, true)).toThrow("retired");
  });

  it.each(["darwin", "win32", "linux"] as const)("routes native close shortcuts through the current confirmation and safe stop on %s", async platform => {
    const f = fixture(undefined, undefined, platform); f.invoke(C.bind, f.event, "document", OWNER);
    await f.invoke(C.open, f.event, "document", OWNER, TARGET);
    const window = targetWindows()[0], event = f.viewerEvent(window), generation = f.invoke(C.state, event).generation;
    f.invoke(C.ready, event, generation); f.invoke(C.inputFocus, event, generation, true);
    const preventDefault = vi.fn(), connection = state.connections[0];
    window.webContents.emit("before-input-event", { preventDefault }, { type: "keyDown", code: "KeyW", meta: platform === "darwin", control: platform !== "darwin" });
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(window.webContents.sent.at(-1)).toEqual([C.closeRequested, generation]);
    expect(window.visible).toBe(true); expect(connection.stop).not.toHaveBeenCalled();
    for (const input of [{ type: "keyUp", code: "KeyW", meta: true }, { type: "keyDown", code: "KeyW" }, { type: "keyDown", code: "KeyC", control: true }]) {
      window.webContents.emit("before-input-event", { preventDefault }, input);
    }
    expect(preventDefault).toHaveBeenCalledOnce();
    await f.invoke(C.close, event, generation);
    expect(connection.stop).toHaveBeenCalledOnce(); expect(window.visible).toBe(false);
    expect(window.webContents.setIgnoreMenuShortcuts).toHaveBeenLastCalledWith(false);
    f.manager.retireSource(f.source);
    window.webContents.emit("before-input-event", { preventDefault }, { type: "keyDown", code: "KeyW", control: true });
    expect(preventDefault).toHaveBeenCalledOnce();
  });

  it.each(["win32", "darwin", "linux"] as const)("prewarms exactly one hidden local shell without service or native effects on %s", async platform => {
    vi.useFakeTimers();
    const native = { request: vi.fn(), close: vi.fn(async () => undefined) } as DesktopViewerCredentialNative;
    const port: DesktopViewerSyncClipboard = { available: false, version: vi.fn(async () => "version"),
      read: vi.fn(async () => "{}"), write: vi.fn(async () => "version"), stop: vi.fn() };
    const f = fixture(port, native, platform);
    f.manager.prewarm(); f.manager.prewarm(); f.manager.refreshLocale();
    expect(state.windows).toHaveLength(1); const window = state.windows[0], event = f.viewerEvent(window);
    expect(f.invoke(C.state, event)).toEqual({ generation: 0, active: false, target: null, locale: "en",
      audio: true, hostMute: false, lockOnExit: false, clipboardSync: false, privacyScreen: false,
      clipboardSyncState: { available: false, active: false, pending: false } });
    f.invoke(C.ready, event, 0); await vi.advanceTimersByTimeAsync(35000);
    expect(window.visible).toBe(false); expect(window.focused).toBe(false); expect(window.destroyed).toBe(false);
    expect(state.connections).toHaveLength(0); expect(f.preferences.get).not.toHaveBeenCalled();
    expect(f.readAuthKey).not.toHaveBeenCalled(); expect(f.syncClipboardFactory).not.toHaveBeenCalled();
    expect(f.credentialNativeFactory).not.toHaveBeenCalled(); expect(native.request).not.toHaveBeenCalled();
    expect(port.version).not.toHaveBeenCalled(); expect(port.read).not.toHaveBeenCalled(); expect(port.write).not.toHaveBeenCalled();
  });

  it("permits only exact local state and generation-zero ready while a shell is unbound", async () => {
    const f = fixture(); f.manager.prewarm();
    const window = state.windows[0], event = f.viewerEvent(window);
    expect(() => f.invoke(C.state, { ...event, senderFrame: {} })).toThrow("retired");
    const url = window.webContents.mainFrame.url; window.webContents.mainFrame.url = "https://untrusted.example/";
    expect(() => f.invoke(C.state, event)).toThrow("retired"); window.webContents.mainFrame.url = url;
    expect(() => f.invoke(C.ready, event, 1)).toThrow("retired");
    expect(() => f.invoke(C.ready, event, undefined)).toThrow("generation");
    for (const channel of [C.request, C.clipboard, C.retryClipboardSync, C.credential, C.preferences,
      C.resize, C.close, C.minimize, C.fullscreen]) await expect(Promise.resolve().then(() => f.invoke(channel, event, 0))).rejects.toThrow();
    f.invoke(C.ready, event, 0);
    expect(window.visible).toBe(false); expect(state.connections).toHaveLength(0);
    expect(f.readAuthKey).not.toHaveBeenCalled(); expect(f.syncClipboardFactory).not.toHaveBeenCalled();
    expect(f.preferences.get).not.toHaveBeenCalled();
  });

  it("adopts the mounted spare only after authenticated open and requires fresh-generation readiness before remote work", async () => {
    const f = fixture(); f.manager.prewarm();
    const window = state.windows[0], contents = window.webContents, event = f.viewerEvent(window);
    f.invoke(C.ready, event, 0); f.invoke(C.bind, f.event, "document", OWNER);
    expect(window.destroyed).toBe(false); expect(f.onOwnerRetired).not.toHaveBeenCalled();
    expect(await f.invoke(C.open, f.event, "document", OWNER, TARGET)).toEqual({ focusedExisting: true });
    expect(state.windows).toHaveLength(2); expect(window.webContents).toBe(contents); expect(window.loadURL).toHaveBeenCalledOnce();
    expect(f.invoke(C.state, event)).toMatchObject({ generation: 1, active: false, target: TARGET });
    expect(() => f.invoke(C.ready, event, 0)).toThrow("retired");
    expect(() => f.invoke(C.request, event, 1, "getRemoteDesktopCapabilities", new Uint8Array())).toThrow("inactive");
    expect(state.connections).toHaveLength(1); expect(state.connections[0].request).not.toHaveBeenCalled();
    f.invoke(C.ready, event, 1); expect(f.invoke(C.state, event).active).toBe(true);
    expect(window.visible).toBe(true); expect(window.focused).toBe(true);
    const spare = state.windows[1];
    expect(f.invoke(C.state, f.viewerEvent(spare))).toMatchObject({ generation: 0, target: null, active: false });
    expect(spare.visible).toBe(false); expect(spare.focused).toBe(false); expect(f.syncClipboardFactory).toHaveBeenCalledOnce();
    await f.invoke(C.request, event, 1, "getRemoteDesktopCapabilities", new Uint8Array());
    expect(state.connections[0].request).toHaveBeenCalledOnce();
  });

  it("prefers the same bound target and consumes the one spare only for another authenticated target", async () => {
    const f = fixture(); f.manager.prewarm(); const first = state.windows[0]; f.invoke(C.bind, f.event, "document", OWNER);
    await f.invoke(C.open, f.event, "document", OWNER, TARGET);
    const spare = state.windows[1];
    expect(await f.invoke(C.open, f.event, "document", OWNER, TARGET)).toEqual({ focusedExisting: true });
    expect(state.windows).toHaveLength(2); expect(state.windows[0]).toBe(first); expect(state.windows[1]).toBe(spare);
    expect(await f.invoke(C.open, f.event, "document", OWNER, { ...TARGET, deviceId: "second" })).toEqual({ focusedExisting: true });
    f.manager.prewarm(); f.manager.prewarm();
    expect(state.windows).toHaveLength(3); expect(f.invoke(C.state, f.viewerEvent(spare)).target?.deviceId).toBe("second");
    expect(state.connections).toHaveLength(2);
    const unbound = state.windows.filter(window => f.invoke(C.state, f.viewerEvent(window)).target === null);
    expect(unbound).toHaveLength(1); expect(unbound[0].visible).toBe(false); expect(unbound[0].focused).toBe(false);
  });

  it("leaves the spare untouched after an invalid document, owner or target tries to open", async () => {
    const f = fixture(); f.manager.prewarm(); const window = state.windows[0]; f.invoke(C.bind, f.event, "document", OWNER);
    await expect(f.invoke(C.open, f.event, "old-document", OWNER, TARGET)).rejects.toThrow("Wrong document");
    await expect(f.invoke(C.open, f.event, "document", { ...OWNER, profileId: "other" }, TARGET)).rejects.toThrow("retired");
    for (const target of [null, { ...TARGET, deviceId: OWNER.deviceId }, { ...TARGET, extra: true }]) {
      await expect(f.invoke(C.open, f.event, "document", OWNER, target)).rejects.toThrow("target");
    }
    expect(state.windows).toHaveLength(1); expect(window.destroyed).toBe(false);
    expect(f.invoke(C.state, f.viewerEvent(window)).target).toBeNull(); expect(state.connections).toHaveLength(0);
    expect(f.syncClipboardFactory).not.toHaveBeenCalled(); expect(f.preferences.get).not.toHaveBeenCalled();
  });

  it.each(["crash", "load", "reload", "closed"] as const)("retires a spare on %s without recovery, remote cleanup or foreground effects", async failure => {
    vi.useFakeTimers();
    const cleanupStages: string[] = [];
    const f = fixture(undefined, undefined, undefined, stage => {
      cleanupStages.push(stage); throw new Error("A diagnostic observer cannot prevent native retirement.");
    });
    f.manager.prewarm();
    const window = state.windows[0], event = f.viewerEvent(window); f.invoke(C.ready, event, 0);
    if (failure === "crash") window.webContents.emit("render-process-gone");
    else if (failure === "load") window.webContents.emit("did-fail-load", {}, -2, "failed", "", true);
    else if (failure === "reload") window.webContents.emit("did-start-navigation", {}, window.webContents.mainFrame.url, false, true);
    else window.destroy();
    if (failure === "crash") {
      expect(window.destroyed).toBe(false);
      expect(() => f.invoke(C.ready, event, 0)).toThrow("retired");
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(window.destroyed).toBe(true); await vi.advanceTimersByTimeAsync(35000);
    expect(cleanupStages).toContain("viewer_native_closed");
    if (failure === "crash" || failure === "load") {
      expect(cleanupStages).toContain("viewer_failed_native_destroy_started");
      expect(cleanupStages).toContain("viewer_failed_native_destroy_returned");
    }
    expect(state.windows).toHaveLength(1); expect(() => f.invoke(C.ready, event, 0)).toThrow("retired");
    expect(state.connections).toHaveLength(0); expect(f.syncClipboardFactory).not.toHaveBeenCalled();
    f.manager.prewarm(); expect(state.windows).toHaveLength(2);
    expect(f.invoke(C.state, f.viewerEvent(state.windows[1]))).toMatchObject({ generation: 0, target: null, active: false });
    expect(state.windows[1].visible).toBe(false); expect(state.windows[1].focused).toBe(false);
  });

  it.each(["source", "unbind", "owner", "profile", "dispose"] as const)("clears the bound window and local spare when the %s retires", async retirement => {
    vi.useFakeTimers(); const f = fixture(); f.manager.prewarm(); f.invoke(C.bind, f.event, "document", OWNER);
    await f.invoke(C.open, f.event, "document", OWNER, TARGET);
    const bound = state.windows[0], spare = state.windows[1];
    if (retirement === "source") f.manager.retireSource(f.source);
    else if (retirement === "unbind") f.invoke(C.retire, f.event, "document", OWNER);
    else if (retirement === "owner") f.invoke(C.bind, f.event, "document", { ...OWNER, connectionGeneration: 2 });
    else if (retirement === "profile") f.invoke(C.bind, f.event, "document", { ...OWNER, profileId: "next", connectionGeneration: 2 });
    else f.manager.dispose();
    expect(bound.destroyed).toBe(true); expect(spare.destroyed).toBe(true);
    expect(f.onOwnerRetired).toHaveBeenCalledTimes(retirement === "dispose" ? 0 : 1);
    bound.webContents.emit("render-process-gone"); spare.webContents.emit("did-finish-load"); await vi.advanceTimersByTimeAsync(35000);
    expect(state.windows).toHaveLength(2); expect(f.readAuthKey).not.toHaveBeenCalled();
  });

  it("does not prewarm while quitting and retires an unbound shell on source replacement before any owner exists", () => {
    const f = fixture(); f.setQuitting(true); f.manager.prewarm(); expect(state.windows).toHaveLength(0);
    f.setQuitting(false); f.manager.prewarm(); const spare = state.windows[0];
    f.manager.retireSource(f.source); expect(spare.destroyed).toBe(true); expect(f.onOwnerRetired).not.toHaveBeenCalled();
    expect(state.connections).toHaveLength(0); expect(f.syncClipboardFactory).not.toHaveBeenCalled();
  });

  it("retires source authority during gone dispatch and defers native cleanup to only its original windows", async () => {
    vi.useFakeTimers();
    const f = fixture(); f.invoke(C.bind, f.event, "document", OWNER); await f.invoke(C.open, f.event, "document", OWNER, TARGET);
    const originals = [...state.windows], oldEvent = f.viewerEvent(originals[0]);
    const generation = f.invoke(C.state, oldEvent).generation;
    let dispatchingGone = false;
    for (const window of originals) {
      window.webContents.setIgnoreMenuShortcuts.mockImplementation(() => { expect(dispatchingGone).toBe(false); });
      const nativeDestroy = window.destroy.bind(window);
      vi.spyOn(window, "destroy").mockImplementation(() => { expect(dispatchingGone).toBe(false); nativeDestroy(); });
    }
    dispatchingGone = true;
    f.manager.retireSource(f.source, true);
    expect(() => f.invoke(C.ready, oldEvent, generation)).toThrow("retired");
    expect(originals.every(window => !window.destroyed)).toBe(true);
    expect(state.connections[0].current).toBe(false);
    dispatchingGone = false;
    f.manager.prewarm();
    const fresh = state.windows.at(-1);
    await vi.advanceTimersByTimeAsync(0);
    expect(originals.every(window => window.destroyed)).toBe(true);
    expect(fresh.destroyed).toBe(false);
    expect(fresh.webContents.setIgnoreMenuShortcuts).not.toHaveBeenCalled();
  });

  it.each(["win32", "darwin", "linux"] as const)("presents the ready local shell without waiting for remote work on %s", async platform => {
    vi.useFakeTimers();
    const f = fixture(undefined, undefined, platform);
    f.invoke(C.bind, f.event, "document", OWNER); await f.invoke(C.open, f.event, "document", OWNER, TARGET);
    const window = targetWindows()[0], event = f.viewerEvent(), generation = f.invoke(C.state, event).generation;
    expect(window.visible).toBe(false); expect(f.invoke(C.state, event).active).toBe(false);
    await vi.advanceTimersByTimeAsync(4999); expect(targetWindows()).toHaveLength(1);
    f.invoke(C.ready, event, generation);
    expect(window.visible).toBe(true); expect(window.focused).toBe(true); expect(f.invoke(C.state, event).active).toBe(true);
    expect(state.connections[0].request).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); expect(targetWindows()).toHaveLength(1);
  });

  it("joins stop before hiding the same native window and reopens with a fresh connection and unchanged bounds", async () => {
    const f = fixture(); f.invoke(C.bind, f.event, "document", OWNER); await f.invoke(C.open, f.event, "document", OWNER, TARGET);
    const window = targetWindows()[0], event = f.viewerEvent(), generation = f.invoke(C.state, event).generation;
    f.invoke(C.ready, event, generation); window.bounds = { x: 64, y: 95, width: 960, height: 640 };
    const connection = state.connections[0]; let finish!: () => void;
    connection.stop.mockImplementationOnce(async (_lock: boolean, check: () => void) => {
      check(); await new Promise<void>(resolve => { finish = resolve; }); check();
    });
    const closing = f.invoke(C.close, event, generation);
    expect(window.visible).toBe(true); expect(window.destroyed).toBe(false); expect(connection.retire).not.toHaveBeenCalled();
    finish(); await closing;
    expect(window.visible).toBe(false); expect(window.destroyed).toBe(false); expect(connection.retire).toHaveBeenCalledOnce();
    const fresh = f.invoke(C.state, event); expect(fresh.active).toBe(false); expect(fresh.generation).toBeGreaterThan(generation);
    expect(() => f.invoke(C.ready, event, generation)).toThrow("retired");
    expect(await f.invoke(C.open, f.event, "document", OWNER, TARGET)).toEqual({ focusedExisting: true });
    expect(targetWindows()).toHaveLength(1); expect(window.bounds).toEqual({ x: 64, y: 95, width: 960, height: 640 });
    expect(f.invoke(C.state, event)).toMatchObject({ active: true, generation: fresh.generation });
    expect(state.connections[1]).not.toBe(connection); expect(state.connections[1].lease).toBeUndefined();
    await f.invoke(C.request, event, fresh.generation, "startRemoteDesktop", new Uint8Array());
    expect(state.connections[1].request).toHaveBeenCalledOnce(); expect(connection.request).not.toHaveBeenCalled();
  });

  it.each(["leave", "timeout"] as const)("hides a stopped Mac fullscreen window after bounded %s", async trigger => {
    vi.useFakeTimers();
    const f = fixture(undefined, undefined, "darwin"); f.invoke(C.bind, f.event, "document", OWNER);
    await f.invoke(C.open, f.event, "document", OWNER, TARGET);
    const window = targetWindows()[0], event = f.viewerEvent(), generation = f.invoke(C.state, event).generation;
    f.invoke(C.ready, event, generation); window.fullscreen = true;
    await f.invoke(C.close, event, generation);
    expect(window.fullscreen).toBe(false); expect(window.visible).toBe(true); expect(f.invoke(C.state, event).active).toBe(false);
    await vi.advanceTimersByTimeAsync(1999); expect(window.visible).toBe(true);
    if (trigger === "leave") window.emit("leave-full-screen"); else await vi.advanceTimersByTimeAsync(1);
    expect(window.visible).toBe(false); expect(window.destroyed).toBe(false);
    expect(window.listenerCount("leave-full-screen")).toBe(1);
  });

  it("cancels a requested Mac fullscreen entry before its native state has settled", async () => {
    vi.useFakeTimers();
    const f = fixture(undefined, undefined, "darwin"); f.invoke(C.bind, f.event, "document", OWNER);
    await f.invoke(C.open, f.event, "document", OWNER, TARGET);
    const window = targetWindows()[0], event = f.viewerEvent(), generation = f.invoke(C.state, event).generation;
    f.invoke(C.ready, event, generation);
    window.setFullScreen = vi.fn(); f.invoke(C.fullscreen, event);
    expect(window.setFullScreen).toHaveBeenCalledWith(true); expect(window.isFullScreen()).toBe(false);
    await f.invoke(C.close, event, generation);
    expect(window.setFullScreen).toHaveBeenLastCalledWith(false); expect(window.visible).toBe(true);
    window.emit("leave-full-screen"); expect(window.visible).toBe(false);
  });

  it("does not let a late Mac fullscreen leave or its timer hide a reopened occurrence", async () => {
    vi.useFakeTimers();
    const f = fixture(undefined, undefined, "darwin"); f.invoke(C.bind, f.event, "document", OWNER);
    await f.invoke(C.open, f.event, "document", OWNER, TARGET);
    const window = targetWindows()[0], event = f.viewerEvent(), generation = f.invoke(C.state, event).generation;
    f.invoke(C.ready, event, generation); window.fullscreen = true;
    await f.invoke(C.close, event, generation); const fresh = f.invoke(C.state, event).generation;
    await f.invoke(C.open, f.event, "document", OWNER, TARGET); expect(f.invoke(C.state, event)).toMatchObject({ active: true, generation: fresh });
    window.emit("leave-full-screen"); await vi.advanceTimersByTimeAsync(2000);
    expect(window.visible).toBe(true); expect(f.invoke(C.state, event).active).toBe(true); expect(targetWindows()).toHaveLength(1);
  });

  it("hides reload immediately, retires the exact old request and only presents the new quiet generation", async () => {
    const f = fixture(); f.invoke(C.bind, f.event, "document", OWNER); await f.invoke(C.open, f.event, "document", OWNER, TARGET);
    const window = targetWindows()[0], event = f.viewerEvent(), generation = f.invoke(C.state, event).generation;
    f.invoke(C.ready, event, generation); const original = state.connections[0]; let guard!: () => void;
    original.request.mockImplementationOnce(async (_name: string, _body: Uint8Array, check: () => void) => {
      check(); guard = check; return { ok: true, bytes: new Uint8Array() };
    });
    await f.invoke(C.request, event, generation, "sendRemoteDesktopInput", new Uint8Array());
    window.webContents.emit("did-start-navigation", {}, window.webContents.mainFrame.url, false, true);
    expect(window.visible).toBe(false); expect(original.retire).toHaveBeenCalledOnce(); expect(guard).toThrow("retired");
    expect(() => f.invoke(C.ready, event, generation)).toThrow("retired");
    const fresh = f.invoke(C.state, event).generation; expect(fresh).toBeGreaterThan(generation);
    window.webContents.emit("did-finish-load"); expect(window.visible).toBe(false);
    f.invoke(C.ready, event, fresh); expect(window.visible).toBe(true); expect(f.invoke(C.state, event).active).toBe(true);
    expect(state.connections[1].request).not.toHaveBeenCalled(); expect(targetWindows()).toHaveLength(1);
  });

  it("uses the five-second quiet shell fallback without authorizing work before the actual document finishes", async () => {
    vi.useFakeTimers();
    const f = fixture(); f.invoke(C.bind, f.event, "document", OWNER); await f.invoke(C.open, f.event, "document", OWNER, TARGET);
    const window = targetWindows()[0], event = f.viewerEvent(), generation = f.invoke(C.state, event).generation;
    f.invoke(C.ready, event, generation);
    window.webContents.emit("did-start-navigation", {}, window.webContents.mainFrame.url, false, true);
    const fresh = f.invoke(C.state, event).generation; f.invoke(C.ready, event, fresh);
    await vi.advanceTimersByTimeAsync(4999); expect(window.visible).toBe(false);
    await vi.advanceTimersByTimeAsync(1); expect(window.visible).toBe(true); expect(f.invoke(C.state, event).active).toBe(false);
    expect(() => f.invoke(C.request, event, fresh, "startRemoteDesktop", new Uint8Array())).toThrow("inactive");
    window.webContents.emit("did-finish-load"); expect(f.invoke(C.state, event).active).toBe(true);
    expect(targetWindows()).toHaveLength(1); expect(state.connections[1].request).not.toHaveBeenCalled();
  });

  it.each([false, true])("bounds renderer failure recovery to one replacement (visible=%s)", async visible => {
    vi.useFakeTimers();
    const f = fixture(); f.invoke(C.bind, f.event, "document", OWNER); await f.invoke(C.open, f.event, "document", OWNER, TARGET);
    const original = targetWindows()[0], oldEvent = f.viewerEvent(original), oldContents = original.webContents;
    const generation = f.invoke(C.state, oldEvent).generation;
    if (visible) f.invoke(C.ready, oldEvent, generation);
    const oldMessages = oldContents.sent.length;
    oldContents.emit("render-process-gone", {}, { reason: "crashed" });
    expect(original.destroyed).toBe(false); expect(targetWindows()).toHaveLength(2);
    expect(oldContents.sent).toHaveLength(oldMessages);
    const replacement = targetWindows()[1], event = f.viewerEvent(replacement), fresh = f.invoke(C.state, event).generation;
    expect(fresh).toBeGreaterThan(generation); expect(replacement.visible).toBe(false);
    expect(() => f.invoke(C.ready, oldEvent, generation)).toThrow("retired");
    f.invoke(C.ready, event, fresh); expect(f.invoke(C.state, event).active).toBe(true);
    expect(replacement.webContents.sent).toContainEqual([C.state, expect.objectContaining({ generation: fresh, active: true })]);
    await vi.advanceTimersByTimeAsync(0);
    expect(original.destroyed).toBe(true); expect(replacement.destroyed).toBe(false);
    expect(oldContents.sent).toHaveLength(oldMessages);
    oldContents.emit("render-process-gone"); oldContents.emit("did-fail-load", {}, -2, "failed", "", true);
    expect(targetWindows()).toHaveLength(2); expect(f.invoke(C.state, event).generation).toBe(fresh);
    replacement.webContents.emit("render-process-gone"); await vi.advanceTimersByTimeAsync(5000);
    expect(replacement.destroyed).toBe(true); expect(targetWindows()).toHaveLength(2);
    expect(await f.invoke(C.open, f.event, "document", OWNER, TARGET)).toEqual({ focusedExisting: false });
    expect(targetWindows()).toHaveLength(3);
    targetWindows()[2].webContents.emit("render-process-gone"); expect(targetWindows()).toHaveLength(4);
    await vi.advanceTimersByTimeAsync(0);
  });

  it("restores one automatic recovery only after thirty seconds of current ready stability", async () => {
    vi.useFakeTimers();
    const f = fixture(); f.invoke(C.bind, f.event, "document", OWNER); await f.invoke(C.open, f.event, "document", OWNER, TARGET);
    targetWindows()[0].webContents.emit("render-process-gone");
    const replacement = targetWindows()[1], event = f.viewerEvent(replacement), generation = f.invoke(C.state, event).generation;
    f.invoke(C.ready, event, generation); await vi.advanceTimersByTimeAsync(29999);
    expect(targetWindows()).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1); replacement.webContents.emit("render-process-gone");
    expect(targetWindows()).toHaveLength(3); expect(replacement.destroyed).toBe(false);
    await vi.advanceTimersByTimeAsync(0); expect(replacement.destroyed).toBe(true);
  });

  it.each(["crash", "load"] as const)("keeps a hidden %s failure closed and allows other live targets and an explicit reopen", async failure => {
    vi.useFakeTimers();
    const f = fixture(); f.invoke(C.bind, f.event, "document", OWNER); await f.invoke(C.open, f.event, "document", OWNER, TARGET);
    const original = targetWindows()[0], event = f.viewerEvent(original), generation = f.invoke(C.state, event).generation;
    f.invoke(C.ready, event, generation); await f.invoke(C.close, event, generation);
    const contents = original.webContents;
    if (failure === "crash") contents.emit("render-process-gone"); else contents.emit("did-fail-load", {}, -2, "failed", "", true);
    if (failure === "crash") {
      expect(original.destroyed).toBe(false);
      expect(() => f.invoke(C.ready, event, generation + 1)).toThrow("retired");
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(original.destroyed).toBe(true); await vi.advanceTimersByTimeAsync(35000); expect(targetWindows()).toHaveLength(1);
    Object.defineProperty(original, "webContents", { get: () => { throw new Error("Object has been destroyed"); } });
    await f.invoke(C.open, f.event, "document", OWNER, { ...TARGET, deviceId: "other" });
    const otherEvent = f.viewerEvent(targetWindows()[1]), otherGeneration = f.invoke(C.state, otherEvent).generation;
    f.invoke(C.ready, otherEvent, otherGeneration); expect(f.invoke(C.state, otherEvent).active).toBe(true);
    expect(() => f.invoke(C.ready, event, generation)).toThrow("retired");
    expect(await f.invoke(C.open, f.event, "document", OWNER, TARGET)).toEqual({ focusedExisting: false });
    expect(targetWindows()).toHaveLength(3); expect(targetWindows()[2].visible).toBe(false); expect(targetWindows()[1].visible).toBe(true);
  });

  it("recovers a main-frame load failure while ignoring aborted loads and subframe failures", async () => {
    const f = fixture(); f.invoke(C.bind, f.event, "document", OWNER); await f.invoke(C.open, f.event, "document", OWNER, TARGET);
    const window = targetWindows()[0], contents = window.webContents;
    contents.emit("did-fail-load", {}, -3, "aborted", "", true);
    contents.emit("did-fail-load", {}, -2, "failed", "", false); expect(targetWindows()).toHaveLength(1);
    contents.emit("did-fail-load", {}, -2, "failed", "", true);
    expect(window.destroyed).toBe(true); expect(targetWindows()).toHaveLength(2);
    const event = f.viewerEvent(targetWindows()[1]); f.invoke(C.ready, event, f.invoke(C.state, event).generation);
    expect(targetWindows()[1].visible).toBe(true); expect(state.connections.at(-1).request).not.toHaveBeenCalled();
  });

  it("invalidates missing readiness at five seconds and stops after its one automatic replacement", async () => {
    vi.useFakeTimers();
    const f = fixture(); f.invoke(C.bind, f.event, "document", OWNER); await f.invoke(C.open, f.event, "document", OWNER, TARGET);
    await vi.advanceTimersByTimeAsync(4999); expect(targetWindows()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1); expect(targetWindows()[0].destroyed).toBe(true); expect(targetWindows()).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(5000); expect(targetWindows()[1].destroyed).toBe(true); expect(targetWindows()).toHaveLength(2);
    expect(state.connections.every(connection => connection.request.mock.calls.length === 0)).toBe(true);
  });

  it.each(["retire", "replace", "dispose"] as const)("cancels pending readiness and recovery after owner %s", async retirement => {
    vi.useFakeTimers();
    const f = fixture(); f.invoke(C.bind, f.event, "document", OWNER); await f.invoke(C.open, f.event, "document", OWNER, TARGET);
    const window = targetWindows()[0], event = f.viewerEvent(window), generation = f.invoke(C.state, event).generation;
    const contents = window.webContents;
    if (retirement === "retire") f.manager.retireSource(f.source);
    else if (retirement === "replace") f.invoke(C.bind, f.event, "document", { ...OWNER, connectionGeneration: 2 });
    else f.manager.dispose();
    expect(window.destroyed).toBe(true); contents.emit("render-process-gone"); contents.emit("did-finish-load");
    await vi.advanceTimersByTimeAsync(35000); expect(targetWindows()).toHaveLength(1);
    expect(() => f.invoke(C.ready, event, generation)).toThrow("retired");
  });

  it("uses only captured native credential identity and rejects generic credential RPCs and stale private actions", async () => {
    const request = vi.fn(async () => ({ autoUnlock: false, biometricVerification: false, biometricAvailable: true, biometricPreferred: true }));
    const close = vi.fn(async () => undefined);
    const f = fixture(undefined, { request, close } as unknown as DesktopViewerCredentialNative);
    f.invoke(C.bind, f.event, "document", OWNER); await f.invoke(C.open, f.event, "document", OWNER, TARGET);
    const window = targetWindows()[0], event = f.viewerEvent(), generation = f.invoke(C.state, event).generation;
    await f.invoke(C.ready, event, generation); state.connections.at(-1).caps = { platform: "darwin", nativeCredentials: true };
    expect(await f.invoke(C.credential, event, generation, "settings")).toMatchObject({ ok: true, state: { autoUnlock: false } });
    expect(request).toHaveBeenCalledWith("viewerSettings", { owner: { serverId: OWNER.serverId, profileId: OWNER.profileId, deviceId: OWNER.deviceId }, target: TARGET.deviceId }, expect.anything());
    await expect(f.invoke(C.credential, event, generation, "enable", { owner: "forged" })).rejects.toThrow("Invalid native credential action");
    expect(() => f.invoke(C.request, event, generation, "requestRemoteDesktopCredentials", new Uint8Array())).toThrow();
    expect(() => f.invoke(C.credential, event, undefined, "settings")).toThrow();
    window.hide(); expect(() => f.invoke(C.credential, event, generation, "settings")).toThrow();
    await vi.waitFor(() => expect(close).toHaveBeenCalled());
  });

  it("preserves the pending close occurrence while sync pauses and waits for a fresh start after an unconfirmed exit", async () => {
    vi.useFakeTimers();
    const f = fixture({ available: true, version: async () => "1", read: async () => '{"text":"baseline"}', write: async () => "2", stop: vi.fn() });
    f.invoke(C.bind, f.event, "document", OWNER); await f.invoke(C.open, f.event, "document", OWNER, TARGET);
    const window = targetWindows()[0], event = f.viewerEvent(), generation = f.invoke(C.state, event).generation;
    await f.invoke(C.ready, event, generation);
    const connection = state.connections.at(-1);
    connection.caps = { clipboardSync: true, clipboardInline: true };
    connection.lease = { leaseId: "lease", controlling: true, controlGeneration: 2n };
    connection.syncRequest.mockImplementation(async (name: keyof typeof RemoteDesktopService.method, input: any, _lease: object, guard: () => void) => {
      guard(); const method = RemoteDesktopService.method[name];
      const output = name === "setRemoteDesktopClipboardSync" ? { result: { enabled: input.request.enabled, syncGeneration: 1n } } :
        name === "getRemoteDesktopClipboardVersion" ? { result: { version: "1" } } : { result: { data: '{"text":"baseline"}', length: 19 } };
      return { ok: true, bytes: toBinary(method.output, create(method.output, output as never)) };
    });
    await f.invoke(C.preferences, event, generation, { clipboardSync: true });
    for (let i = 0; i < 60; i++) await Promise.resolve();
    expect(f.invoke(C.state, event).clipboardSyncState.active).toBe(true);
    let reject!: (error: Error) => void;
    connection.stop.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
    window.webContents.sent.length = 0;
    const closing = f.invoke(C.close, event, generation);
    for (let i = 0; i < 40; i++) await Promise.resolve();
    expect(window.webContents.sent.filter(([channel]: [string]) => channel === C.state)).toHaveLength(0);
    reject(new Error("Exit unconfirmed")); await expect(closing).rejects.toThrow("confirm disconnection");
    expect(f.invoke(C.state, event)).toMatchObject({ active: true, clipboardSyncState: { active: false, pending: false } });
    const enables = () => connection.syncRequest.mock.calls.filter(([name, input]: [string, any]) => name === "setRemoteDesktopClipboardSync" && input.request.enabled).length;
    expect(enables()).toBe(1);
    await f.invoke(C.request, event, generation, "getRemoteDesktopFrame", new Uint8Array());
    expect(enables()).toBe(1);
    connection.request.mockImplementationOnce(async (_name: string, _body: Uint8Array, guard: () => void) => {
      guard(); connection.lease = { ...connection.lease, leaseId: "fresh-lease" };
      return { ok: true, bytes: new Uint8Array() };
    });
    await f.invoke(C.request, event, generation, "startRemoteDesktop", new Uint8Array());
    await vi.advanceTimersByTimeAsync(3000); expect(enables()).toBe(2);
  });

  it("stores clipboard sync intent in Main and rejects renderer access to system content and sync mutation", async () => {
    const f = fixture(); f.invoke(C.bind, f.event, "document", OWNER); await f.invoke(C.open, f.event, "document", OWNER, TARGET);
    const event = f.viewerEvent(), generation = f.invoke(C.state, event).generation;
    await f.invoke(C.ready, event, generation); expect(f.invoke(C.state, event).clipboardSync).toBe(false);
    await f.invoke(C.preferences, event, generation, { clipboardSync: true });
    expect(f.invoke(C.state, event)).toMatchObject({ clipboardSync: true, clipboardSyncState: { active: false, pending: false } });
    for (const name of ["setRemoteDesktopClipboardSync", "getRemoteDesktopClipboardVersion", "transferRemoteDesktopClipboardContent"]) {
      expect(() => f.invoke(C.request, event, generation, name, new Uint8Array())).toThrow("native viewer owner");
    }
    expect(() => f.invoke(C.retryClipboardSync, event, generation)).toThrow("authority retired");
    await f.invoke(C.close, event, generation); await f.invoke(C.open, f.event, "document", OWNER, TARGET);
    expect(targetWindows()).toHaveLength(1);
    expect(f.invoke(C.state, f.viewerEvent(targetWindows()[0])).clipboardSync).toBe(true);
    expect(JSON.stringify(f.invoke(C.state, f.viewerEvent(targetWindows()[0])))).not.toContain("local text");
  });

  it("captures saved lock intent only through dedicated close, supports a view-only lease and waits for explicit retry after failure", async () => {
    const f = fixture(); f.invoke(C.bind, f.event, "document", OWNER); await f.invoke(C.open, f.event, "document", OWNER, TARGET);
    const window = targetWindows()[0], event = f.viewerEvent(), generation = f.invoke(C.state, event).generation;
    await f.invoke(C.ready, event, generation);
    const connection = state.connections.at(-1); connection.caps = { lockOnExit: true };
    connection.lease = { leaseId: "lease", controlling: false, controlGeneration: 7n };
    expect(f.invoke(C.state, event).lockOnExit).toBe(false);
    await f.invoke(C.preferences, event, generation, { lockOnExit: true });
    const method = RemoteDesktopService.method.stopRemoteDesktop;
    const bytes = toBinary(method.input, create(method.input, { leaseId: "lease", lockScreen: true, controlGeneration: 7n }));
    expect(() => f.invoke(C.request, event, generation, method.localName, bytes)).toThrow("dedicated close");
    expect(connection.request).not.toHaveBeenCalled();
    let reject!: (error: Error) => void;
    connection.stop.mockImplementationOnce(async (lock: boolean, check: () => void) => {
      expect(lock).toBe(true); check(); await new Promise((_resolve, fail) => { reject = fail; }); check();
    });
    const closing = f.invoke(C.close, event, generation);
    expect(window.destroyed).toBe(false); window.emit("blur"); expect(connection.call).not.toHaveBeenCalled();
    reject(new Error("Unknown lock result")); await expect(closing).rejects.toThrow("confirm disconnection");
    expect(window.destroyed).toBe(false); expect(f.invoke(C.state, event).lockOnExit).toBe(true);
    await f.invoke(C.close, event, generation); expect(window.destroyed).toBe(false); expect(window.visible).toBe(false);
    expect(connection.stop).toHaveBeenCalledTimes(2); expect(connection.stop.mock.calls.every(([lock]: [boolean]) => lock)).toBe(true);
  });

  it("retires a pending lock close on hide without destroying the restored window or locking ordinary retirement", async () => {
    const f = fixture(); f.invoke(C.bind, f.event, "document", OWNER); await f.invoke(C.open, f.event, "document", OWNER, TARGET);
    const window = targetWindows()[0], event = f.viewerEvent(), generation = f.invoke(C.state, event).generation;
    await f.invoke(C.ready, event, generation); await f.invoke(C.preferences, event, generation, { lockOnExit: true });
    const connection = state.connections.at(-1); connection.caps = { lockOnExit: true };
    let finish!: () => void;
    connection.stop.mockImplementationOnce(async (_lock: boolean, check: () => void) => {
      check(); await new Promise<void>((resolve) => { finish = resolve; }); check();
    });
    const closing = f.invoke(C.close, event, generation); window.hide(); window.show(); finish();
    await expect(closing).rejects.toThrow("confirm disconnection"); expect(window.destroyed).toBe(false);
    const nextGeneration = f.invoke(C.state, event).generation; expect(nextGeneration).toBeGreaterThan(generation);
    await f.invoke(C.ready, event, nextGeneration); expect(f.invoke(C.state, event).active).toBe(true);
    const next = state.connections.at(-1); await f.invoke(C.close, event, nextGeneration);
    expect(next.stop).toHaveBeenCalledWith(false, expect.any(Function));
  });

  it("allows the generated host mute effect only for the saved intent and original native focus occurrence", async () => {
    const f = fixture(); f.invoke(C.bind, f.event, "document", OWNER); await f.invoke(C.open, f.event, "document", OWNER, TARGET);
    const window = targetWindows()[0], event = f.viewerEvent(), generation = f.invoke(C.state, event).generation;
    await f.invoke(C.ready, event, generation);
    const method = RemoteDesktopService.method.setRemoteDesktopHostMute;
    const bytes = toBinary(method.input, create(method.input, { request: { leaseId: "lease", controlGeneration: 2n, enabled: true } }));
    const connection = state.connections.at(-1);
    await expect(f.invoke(C.request, event, generation, method.localName, bytes)).rejects.toThrow("preference changed");
    await f.invoke(C.preferences, event, generation, { hostMute: true });
    expect(f.invoke(C.state, event)).toMatchObject({ audio: true, hostMute: true });
    let guard!: () => void;
    connection.request.mockImplementationOnce(async (_name: string, _body: Uint8Array, check: () => void) => {
      check(); guard = check; return { ok: true, bytes: new Uint8Array() };
    });
    await f.invoke(C.request, event, generation, method.localName, bytes);
    window.focused = false; window.emit("blur"); window.focused = true;
    expect(guard).toThrow("retired");
  });

  it("admits privacy only for saved privacy and exit intent without deriving cleanup from native focus", async () => {
    const f = fixture(); f.invoke(C.bind, f.event, "document", OWNER); await f.invoke(C.open, f.event, "document", OWNER, TARGET);
    const event = f.viewerEvent(), generation = f.invoke(C.state, event).generation;
    await f.invoke(C.ready, event, generation);
    const method = RemoteDesktopService.method.setRemoteDesktopPrivacyScreen;
    const bytes = toBinary(method.input, create(method.input, { request: { leaseId: "lease", controlGeneration: 2n, enabled: true, lockOnExit: true } }));
    await expect(f.invoke(C.request, event, generation, method.localName, bytes)).rejects.toThrow("preference changed");
    await f.invoke(C.preferences, event, generation, { privacyScreen: true });
    await expect(f.invoke(C.request, event, generation, method.localName, bytes)).rejects.toThrow("preference changed");
    await f.invoke(C.preferences, event, generation, { lockOnExit: true });
    targetWindows()[0].focused = false;
    await f.invoke(C.request, event, generation, method.localName, bytes);
    expect(f.invoke(C.state, event)).toMatchObject({ privacyScreen: true, lockOnExit: true });
    await f.invoke(C.preferences, event, generation, { privacyScreen: false });
    await expect(f.invoke(C.request, event, generation, method.localName, bytes)).rejects.toThrow("preference changed");
  });

  it("publishes playback intent only after save, preserves it on failure and loads it when reopening the same target", async () => {
    const f = fixture(); f.invoke(C.bind, f.event, "document", OWNER); await f.invoke(C.open, f.event, "document", OWNER, TARGET);
    const event = f.viewerEvent(), generation = f.invoke(C.state, event).generation;
    await f.invoke(C.ready, event, generation); expect(f.invoke(C.state, event).audio).toBe(true);
    let complete!: () => void;
    const save = f.preferences.setAudio.getMockImplementation()!;
    f.preferences.setAudio.mockImplementationOnce(async (owner, target, audio) => {
      await new Promise<void>((resolve) => { complete = resolve; }); return save(owner, target, audio);
    });
    const pending = f.invoke(C.preferences, event, generation, { audio: false });
    expect(f.invoke(C.state, event).audio).toBe(true); complete(); await pending;
    expect(f.invoke(C.state, event).audio).toBe(false);
    f.preferences.setAudio.mockRejectedValueOnce(new Error("disk failed"));
    await expect(f.invoke(C.preferences, event, generation, { audio: true })).rejects.toThrow("disk failed");
    expect(f.invoke(C.state, event).audio).toBe(false);
    await f.invoke(C.preferences, event, generation, { audio: false }); await f.invoke(C.close, event, generation);
    expect(await f.invoke(C.open, f.event, "document", OWNER, TARGET)).toEqual({ focusedExisting: true });
    expect(targetWindows()).toHaveLength(1);
    expect(f.invoke(C.state, f.viewerEvent(targetWindows()[0])).audio).toBe(false);
    await f.invoke(C.open, f.event, "document", OWNER, { ...TARGET, deviceId: "different" });
    expect(f.invoke(C.state, f.viewerEvent(targetWindows()[1])).audio).toBe(true);
  });

  it("rejects malformed preferences and rejects a late receipt while new reads use the durable playback intent", async () => {
    const f = fixture(); f.invoke(C.bind, f.event, "document", OWNER); await f.invoke(C.open, f.event, "document", OWNER, TARGET);
    const window = targetWindows()[0], event = f.viewerEvent(), generation = f.invoke(C.state, event).generation;
    await f.invoke(C.ready, event, generation);
    await expect(f.invoke(C.preferences, event, undefined)).rejects.toThrow("retired");
    await expect(f.invoke(C.preferences, event, generation, { audio: false, extra: true })).rejects.toThrow("Invalid");
    let complete!: () => void;
    const save = f.preferences.setAudio.getMockImplementation()!;
    f.preferences.setAudio.mockImplementationOnce(async (owner, target, audio) => {
      await new Promise<void>((resolve) => { complete = resolve; }); return save(owner, target, audio);
    });
    const pending = f.invoke(C.preferences, event, generation, { audio: false });
    window.hide(); window.show(); const publications = window.webContents.sent.length; complete();
    await expect(pending).rejects.toThrow("retired"); expect(window.webContents.sent).toHaveLength(publications);
    expect(f.invoke(C.state, event).audio).toBe(false);
  });

  it("resizes actual content with native frame and minimum size while keeping the window inside its work area", async () => {
    const f = fixture(); f.invoke(C.bind, f.event, "document", OWNER); await f.invoke(C.open, f.event, "document", OWNER, TARGET);
    const window = targetWindows()[0], event = f.viewerEvent(), generation = f.invoke(C.state, event).generation;
    await f.invoke(C.ready, event, generation);
    f.invoke(C.resize, event, generation, 1280, 780);
    expect(window.bounds).toEqual({ x: 112, y: 84, width: 1296, height: 816 });
    f.invoke(C.resize, event, generation, 1, 1); expect(window.bounds.width).toBe(640); expect(window.bounds.height).toBe(420);
    f.invoke(C.resize, event, generation, 32000, 32000);
    expect(window.bounds).toEqual({ x: 0, y: 0, width: 1440, height: 900 });
    expect(() => f.invoke(C.resize, event, undefined, 800, 600)).toThrow("retired");
    expect(() => f.invoke(C.resize, event, generation, 1.5, 500)).toThrow("Invalid");
  });

  it("keeps a visible Mac native fullscreen transition in its authorized generation until actual-size restoration", async () => {
    const f = fixture(undefined, undefined, "darwin"); f.invoke(C.bind, f.event, "document", OWNER);
    await f.invoke(C.open, f.event, "document", OWNER, TARGET);
    const window = targetWindows()[0], event = f.viewerEvent(), generation = f.invoke(C.state, event).generation;
    await f.invoke(C.ready, event, generation);
    const connection = state.connections[0];
    f.invoke(C.fullscreen, event);
    // Native macOS space transitions can notify hide while isVisible stays true.
    window.emit("hide");
    expect(window.isVisible()).toBe(true);
    expect(f.invoke(C.state, event)).toMatchObject({ active: true, generation });
    expect(connection.retire).not.toHaveBeenCalled();
    window.emit("enter-full-screen"); window.emit("show");
    f.invoke(C.resize, event, generation, 32000, 32000);
    window.emit("hide");
    expect(f.invoke(C.state, event)).toMatchObject({ active: true, generation });
    window.emit("leave-full-screen"); window.emit("show");
    await new Promise<void>(resolve => { setImmediate(resolve); });
    expect(window.setBounds).toHaveBeenCalledOnce();
    expect(window.bounds).toEqual({ x: 0, y: 0, width: 1440, height: 900 });
    expect(state.connections[0]).toBe(connection); expect(connection.retire).not.toHaveBeenCalled();
    window.hide(); window.show();
    expect(connection.retire).toHaveBeenCalledOnce();
    expect(f.invoke(C.state, event).generation).toBeGreaterThan(generation);
    expect(() => f.invoke(C.resize, event, generation, 1000, 700)).toThrow("retired");
  });

  it.each(["hide", "minimize", "close-reopen", "reload"] as const)(
    "still retires a pending Mac fullscreen resize on %s", async interruption => {
      const f = fixture(undefined, undefined, "darwin"); f.invoke(C.bind, f.event, "document", OWNER);
      await f.invoke(C.open, f.event, "document", OWNER, TARGET);
      const window = targetWindows()[0], event = f.viewerEvent(), generation = f.invoke(C.state, event).generation;
      await f.invoke(C.ready, event, generation);
      const connection = state.connections[0];
      f.invoke(C.fullscreen, event); window.emit("enter-full-screen");
      f.invoke(C.resize, event, generation, 32000, 32000);
      expect(window.setBounds).not.toHaveBeenCalled();
      if (interruption === "hide") { window.hide(); window.show(); }
      else if (interruption === "minimize") { window.minimize(); window.restore(); }
      else if (interruption === "close-reopen") {
        await f.invoke(C.close, event, generation);
        await f.invoke(C.open, f.event, "document", OWNER, TARGET);
      } else window.webContents.emit("did-start-navigation", {}, window.webContents.mainFrame.url, false, true);
      window.emit("leave-full-screen");
      await new Promise<void>(resolve => { setImmediate(resolve); });
      expect(connection.retire).toHaveBeenCalledOnce();
      expect(f.invoke(C.state, event).generation).toBeGreaterThan(generation);
      expect(window.setBounds).not.toHaveBeenCalled();
      expect(() => f.invoke(C.ready, event, generation)).toThrow("retired");
      expect(() => f.invoke(C.resize, event, generation, 1000, 700)).toThrow("retired");
    });

  it.each(["darwin", "win32"] as const)(
    "does not retain a visible hide outside an owned Mac fullscreen transition on %s", async platform => {
      const f = fixture(undefined, undefined, platform); f.invoke(C.bind, f.event, "document", OWNER);
      await f.invoke(C.open, f.event, "document", OWNER, TARGET);
      const window = targetWindows()[0], event = f.viewerEvent(), generation = f.invoke(C.state, event).generation;
      await f.invoke(C.ready, event, generation);
      const connection = state.connections[0];
      if (platform === "win32") f.invoke(C.fullscreen, event);
      else { f.invoke(C.fullscreen, event); window.emit("enter-full-screen"); }
      window.emit("hide");
      expect(window.isVisible()).toBe(true);
      expect(connection.retire).toHaveBeenCalledOnce();
      expect(f.invoke(C.state, event)).toMatchObject({ active: false, generation: generation + 1 });
    });

  it("waits for fullscreen and maximized exit and prevents delayed resize after the viewer retires", async () => {
    const f = fixture(); f.invoke(C.bind, f.event, "document", OWNER); await f.invoke(C.open, f.event, "document", OWNER, TARGET);
    const window = targetWindows()[0], event = f.viewerEvent(), generation = f.invoke(C.state, event).generation;
    await f.invoke(C.ready, event, generation); window.fullscreen = true; window.maximized = true;
    f.invoke(C.resize, event, generation, 800, 600); expect(window.setBounds).not.toHaveBeenCalled();
    window.emit("leave-full-screen"); expect(window.setBounds).not.toHaveBeenCalled();
    await new Promise<void>((resolve) => { setImmediate(resolve); });
    window.emit("unmaximize"); expect(window.setBounds).not.toHaveBeenCalled();
    await new Promise<void>((resolve) => { setImmediate(resolve); });
    expect(window.setBounds).toHaveBeenCalledOnce();
    window.fullscreen = true; f.invoke(C.resize, event, generation, 1000, 700);
    window.hide(); window.show(); window.emit("leave-full-screen");
    await new Promise<void>((resolve) => { setImmediate(resolve); });
    expect(window.setBounds).toHaveBeenCalledOnce();
    expect(() => f.invoke(C.resize, event, generation, 1000, 700)).toThrow("retired");
  });

  it("copies a portable item directly to the native clipboard and prevents renderer access to the raw transfer", async () => {
    const f = fixture(electronClipboardPort()); f.invoke(C.bind, f.event, "document", OWNER); await f.invoke(C.open, f.event, "document", OWNER, TARGET);
    const event = f.viewerEvent(), generation = f.invoke(C.state, event).generation;
    await f.invoke(C.ready, event, generation);
    const connection = state.connections.at(-1);
    connection.lease = { leaseId: "lease", controlling: true, controlGeneration: 1n }; connection.caps = { clipboardContent: true };
    const data = JSON.stringify({ text: "remote text" });
    connection.request.mockImplementation(async (_name: string, bytes: Uint8Array, guard: () => void) => {
      guard(); const method = RemoteDesktopService.method.transferRemoteDesktopClipboardContent;
      const action = fromBinary(method.input, bytes).transfer?.action;
      const result = action?.case === "copy" ? { transferId: "transfer", length: data.length } :
        action?.case === "read" ? { data } : {};
      return { ok: true, bytes: toBinary(method.output, create(method.output, { result })) };
    });
    await f.invoke(C.clipboard, event, generation, "copy");
    expect(state.writeClipboard).toHaveBeenCalledWith({ text: "remote text" });
    expect(() => f.invoke(C.request, event, generation, "transferRemoteDesktopClipboardContent", new Uint8Array())).toThrow("native viewer owner");
  });

  it.each([false, true])("uses the same Linux system-only port for explicit clipboard (rich=%s)", async rich => {
    const read = vi.fn(async () => '{"text":"Linux local system item"}');
    const write = vi.fn(async (_json: string, version: string, current: () => boolean) => {
      expect(version).toBe("a".repeat(64)); expect(current()).toBe(true); return "b".repeat(64);
    });
    const port: DesktopViewerSyncClipboard = { platform: "linux", available: true,
      version: vi.fn(async (_signal, current) => { expect(current?.()).toBe(true); return "a".repeat(64); }), read, write, stop: vi.fn() };
    const f = fixture(port); f.invoke(C.bind, f.event, "document", OWNER); await f.invoke(C.open, f.event, "document", OWNER, TARGET);
    const event = f.viewerEvent(), generation = f.invoke(C.state, event).generation;
    await f.invoke(C.ready, event, generation);
    const connection = state.connections.at(-1), actions: string[] = [], remote = '{"text":"Linux remote item"}';
    connection.lease = { leaseId: "lease", controlling: true, controlGeneration: 1n };
    connection.caps = { clipboardContent: rich, clipboardText: !rich, clipboardSync: true, clipboardInline: true };
    connection.request.mockImplementation(async (name: keyof typeof RemoteDesktopService.method, bytes: Uint8Array, guard: () => void) => {
      guard(); const method = RemoteDesktopService.method[name], request = fromBinary(method.input, bytes) as any;
      const action = request.transfer.action; actions.push(action.case);
      if (!rich) {
        if (action.case === "paste") expect(action.value.text).toBe("Linux local system item");
        return { ok: true, bytes: toBinary(method.output, create(method.output, { result: { text: "Linux remote item" } } as never)) };
      }
      if (action.case === "write") expect(action.value.data).toBe('{"text":"Linux local system item"}');
      const result = action.case === "copy" ? { transferId: "transfer", length: remote.length } :
        action.case === "read" ? { data: remote } : action.case === "begin" ? { transferId: "transfer" } : {};
      return { ok: true, bytes: toBinary(method.output, create(method.output, { result } as never)) };
    });
    const electronReads = state.readText.mock.calls.length;
    await f.invoke(C.clipboard, event, generation, "copy"); await f.invoke(C.clipboard, event, generation, "paste");
    expect(write).toHaveBeenCalledWith(remote, "a".repeat(64), expect.any(Function), expect.any(AbortSignal));
    expect(read).toHaveBeenCalledTimes(1); expect(state.writeClipboard).not.toHaveBeenCalled();
    expect(state.readText).toHaveBeenCalledTimes(electronReads);
    expect(actions).toContain(rich ? "commit" : "paste");
    expect(JSON.stringify(f.invoke(C.state, event))).not.toContain("Linux local system item");
  });

  it("aborts a Linux local writer on focus retirement but keeps its explicit slot until the actual unknown receipt", async () => {
    let finish!: () => void, signal: AbortSignal | undefined;
    const write = vi.fn(async (_json: string, _version: string, _current: () => boolean, captured: AbortSignal) => {
      signal = captured; await new Promise<void>(resolve => { finish = resolve; });
      throw Object.assign(new Error("REMOTE_DESKTOP_CLIPBOARD_OUTCOME_UNKNOWN"), { outcomeUnknown: true });
    });
    const f = fixture({ platform: "linux", available: true, version: async () => "a".repeat(64),
      read: async () => '{"text":"local"}', write, stop: vi.fn() });
    f.invoke(C.bind, f.event, "document", OWNER); await f.invoke(C.open, f.event, "document", OWNER, TARGET);
    const window = targetWindows()[0], event = f.viewerEvent(), generation = f.invoke(C.state, event).generation;
    await f.invoke(C.ready, event, generation);
    const connection = state.connections.at(-1); connection.lease = { leaseId: "lease", controlling: true, controlGeneration: 1n };
    connection.caps = { clipboardText: true };
    connection.request.mockImplementation(async () => {
      const method = RemoteDesktopService.method.transferRemoteDesktopClipboardText;
      return { ok: true, bytes: toBinary(method.output, create(method.output, { result: { text: "remote" } })) };
    });
    const copying = f.invoke(C.clipboard, event, generation, "copy");
    const rejected = expect(copying).rejects.toThrow("OUTCOME_UNKNOWN");
    await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(1));
    window.focused = false; window.emit("blur"); window.focused = true; expect(signal?.aborted).toBe(true);
    await expect(f.invoke(C.clipboard, event, generation, "copy")).rejects.toThrow("pending");
    finish(); await rejected; expect(write).toHaveBeenCalledTimes(1);
    expect(state.writeClipboard).not.toHaveBeenCalled();
  });

  it("never commits a paste or allows another transfer after the original focus occurrence retires", async () => {
    const f = fixture(electronClipboardPort()); f.invoke(C.bind, f.event, "document", OWNER); await f.invoke(C.open, f.event, "document", OWNER, TARGET);
    const window = targetWindows()[0], event = f.viewerEvent(), generation = f.invoke(C.state, event).generation;
    await f.invoke(C.ready, event, generation);
    const connection = state.connections.at(-1);
    connection.lease = { leaseId: "lease", controlling: true, controlGeneration: 1n }; connection.caps = { clipboardContent: true };
    const actions: string[] = []; let complete!: () => void;
    connection.request.mockImplementation(async (_name: string, bytes: Uint8Array, guard: () => void) => {
      guard(); const method = RemoteDesktopService.method.transferRemoteDesktopClipboardContent;
      const action = fromBinary(method.input, bytes).transfer?.action; actions.push(action?.case ?? "missing");
      if (action?.case === "write") await new Promise<void>((accept) => { complete = accept; });
      guard(); return { ok: true, bytes: toBinary(method.output, create(method.output, { result: { transferId: "transfer" } })) };
    });
    const pending = f.invoke(C.clipboard, event, generation, "paste");
    await vi.waitFor(() => expect(actions).toContain("write"));
    await expect(f.invoke(C.clipboard, event, generation, "paste")).rejects.toThrow("pending");
    window.focused = false; window.emit("blur"); window.focused = true; complete();
    await expect(pending).rejects.toThrow("retired"); expect(actions).not.toContain("commit");
  });
  it("opens a restricted standalone preload and reuses one target window", async () => {
    const f = fixture(); f.invoke(C.bind, f.event, "document", OWNER);
    expect(await f.invoke(C.open, f.event, "document", OWNER, TARGET)).toEqual({ focusedExisting: false });
    expect(await f.invoke(C.open, f.event, "document", OWNER, TARGET)).toEqual({ focusedExisting: true });
    expect(targetWindows()).toHaveLength(1);
    expect(targetWindows()[0].options.webPreferences).toMatchObject({ contextIsolation: true, nodeIntegration: false, sandbox: true });
    expect(targetWindows()[0].options.webPreferences.preload).toContain("remote-desktop-viewer-preload.cjs");
    expect(() => f.invoke(C.state, { ...f.viewerEvent(), senderFrame: {} })).toThrow("retired");
  });

  it("retires old connections while an older retire or bind cannot close or replace the new owner", async () => {
    const f = fixture(); f.invoke(C.bind, f.event, "document", OWNER);
    await f.invoke(C.open, f.event, "document", OWNER, TARGET);
    f.invoke(C.bind, f.event, "document", { ...OWNER, connectionGeneration: 2 });
    expect(targetWindows()[0].destroyed).toBe(true);
    f.invoke(C.retire, f.event, "document", OWNER);
    expect(() => f.invoke(C.bind, f.event, "document", OWNER)).toThrow("retired");
    await f.invoke(C.open, f.event, "document", { ...OWNER, connectionGeneration: 2 }, TARGET);
    expect(targetWindows()[1].destroyed).toBe(false);
    f.manager.retireSource(f.source); expect(targetWindows()[1].destroyed).toBe(true);
  });

  it("requires document readiness and retires the exact lease when hidden, then rejects old generations", async () => {
    const f = fixture(); f.invoke(C.bind, f.event, "document", OWNER); await f.invoke(C.open, f.event, "document", OWNER, TARGET);
    const window = targetWindows()[0], event = f.viewerEvent(window);
    const initial = f.invoke(C.state, event);
    expect(initial.active).toBe(false);
    f.invoke(C.ready, event, initial.generation); expect(f.invoke(C.state, event).active).toBe(true);
    const connection = state.connections.at(-1);
    window.hide(); expect(connection.retire).toHaveBeenCalledOnce();
    expect(f.invoke(C.state, event).active).toBe(false);
    expect(() => f.invoke(C.request, event, initial.generation, "getRemoteDesktopFrame", new Uint8Array())).toThrow("retired");
    window.show(); expect(f.invoke(C.state, event).active).toBe(true);
  });

  it("invalidates an input request on blur even when focus returns before dispatch", async () => {
    const f = fixture(); f.invoke(C.bind, f.event, "document", OWNER); await f.invoke(C.open, f.event, "document", OWNER, TARGET);
    const window = targetWindows()[0], event = f.viewerEvent(window), generation = f.invoke(C.state, event).generation;
    f.invoke(C.ready, event, generation);
    const connection = state.connections.at(-1);
    let guard!: () => void;
    connection.request.mockImplementation(async (_name: string, _body: Uint8Array, check: () => void) => { guard = check; return { ok: true, bytes: new Uint8Array() }; });
    await f.invoke(C.request, event, generation, "setRemoteDesktopControl", new Uint8Array());
    window.focused = false; window.emit("blur"); window.focused = true;
    expect(guard).toThrow("retired");
    expect(() => f.invoke(C.clipboard, event, generation, "sync")).toThrow("Invalid");
  });
});
