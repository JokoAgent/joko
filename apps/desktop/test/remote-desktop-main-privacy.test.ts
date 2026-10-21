import { EventEmitter } from "node:events";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { DesktopRemoteDesktopHostDependencies } from "../src/remote-desktop-host.js";
import type { DesktopRemoteDesktopPrivacyScreenDependencies } from "../src/remote-desktop-privacy-screen.js";

const h = vi.hoisted(() => ({
  host: undefined as DesktopRemoteDesktopHostDependencies | undefined,
  privacy: undefined as DesktopRemoteDesktopPrivacyScreenDependencies | undefined,
  excluded: vi.fn(), cleared: vi.fn(), prepare: vi.fn(async () => undefined),
  coverage: vi.fn(), pause: vi.fn(async () => async () => undefined), active: true,
  os: "10.0.19041", macVersion: "14.0", linuxNative: false, linuxWayland: true,
  linuxSession: "unlocked" as "unlocked" | "locked-logged-in" | "unsupported",
  linuxInput: false, linuxCursor: false, linuxModes: false,
  linuxViewer: false, linuxLock: false, linuxMute: false, muteSet: vi.fn(async () => undefined), muteRelease: vi.fn(async () => undefined),
  packaged: true, macViewer: false, macProbe: vi.fn(async (_signal?: AbortSignal) => false), macFactory: vi.fn(),
  linuxPrivacy: false, linuxPrivacyPrepare: vi.fn(async () => undefined), linuxPrivacySet: vi.fn(), linuxPrivacyRelease: vi.fn(),
  linuxWorkspace: false, linuxSystemMenu: false,
  workspaceRequest: vi.fn(async () => undefined), workspaceStop: vi.fn(async () => undefined),
  managedViewer: undefined as { sourceDisplayId: string; displayId: string } | undefined,
  linuxAllMonitors: undefined as { name: string; width: number; height: number; x: number; y: number; scale: number; transform: number }[] | undefined,
  linuxMonitors: [{ name: "DP-1", width: 1920, height: 1080, x: -1920, y: 0, scale: 1, transform: 0 }],
  releaseControl: vi.fn(), managedGeometry: vi.fn(() => false), resetSource: vi.fn(), linuxAudio: false,
  linuxClipboard: false, closeClipboardWriter: vi.fn<() => Promise<void>>(async () => undefined),
  windowsReady: false, idle: "active"
}));
vi.mock("../src/remote-desktop-linux-mute.js", () => ({
  supportsDesktopRemoteDesktopLinuxMute: () => h.linuxMute,
  DesktopRemoteDesktopLinuxMute: class { set = h.muteSet; release = h.muteRelease; }
}));
vi.mock("../src/remote-desktop-linux-workspace.js", () => ({
  readDesktopRemoteDesktopLinuxWorkspaceSupport: vi.fn(async () => ({
    workspaceNavigation: h.linuxWorkspace, systemMenu: h.linuxSystemMenu
  })),
  DesktopRemoteDesktopLinuxWorkspace: class { request = h.workspaceRequest; stop = h.workspaceStop; }
}));
vi.mock("../src/remote-desktop-linux-privacy.js", () => ({
  supportsDesktopRemoteDesktopLinuxPrivacy: vi.fn(async () => h.linuxPrivacy),
  prepareDesktopRemoteDesktopLinuxPrivacy: h.linuxPrivacyPrepare,
  DesktopRemoteDesktopLinuxPrivacyScreen: class { set = h.linuxPrivacySet; release = h.linuxPrivacyRelease; get active() { return h.active; } }
}));
vi.mock("../src/remote-desktop-linux-viewer-display.js", () => ({
  supportsDesktopRemoteDesktopLinuxViewerDisplay: vi.fn(async () => h.linuxViewer),
  createDesktopRemoteDesktopLinuxViewerDisplay: vi.fn()
}));
vi.mock("../src/remote-desktop-macos-viewer-display.js", () => ({
  supportsDesktopRemoteDesktopMacViewerDisplay: h.macProbe,
  createDesktopRemoteDesktopMacViewerDisplay: h.macFactory
}));
vi.mock("../src/remote-desktop-linux-lock.js", () => ({
  supportsDesktopRemoteDesktopLinuxLock: vi.fn(async () => h.linuxLock),
  lockDesktopRemoteDesktopLinuxScreen: vi.fn(async () => undefined)
}));
vi.mock("../src/remote-desktop-linux-credentials.js", () => ({
  readDesktopRemoteDesktopLinuxCredentialLockState: vi.fn(async () => "locked")
}));
vi.mock("../src/remote-desktop-linux-display.js", () => ({
  supportsDesktopRemoteDesktopLinuxDisplayModes: vi.fn(async () => h.linuxModes),
  readDesktopRemoteDesktopLinuxDisplayModes: vi.fn(),
  setDesktopRemoteDesktopLinuxDisplayMode: vi.fn(),
  restoreDesktopRemoteDesktopLinuxDisplayMode: vi.fn()
}));
vi.mock("../src/remote-desktop-linux-audio.js", () => ({
  supportsDesktopRemoteDesktopLinuxAudio: () => h.linuxAudio, DesktopRemoteDesktopLinuxAudio: class {}
}));
vi.mock("../src/remote-desktop-linux-clipboard.js", () => ({
  supportsDesktopRemoteDesktopLinuxClipboard: () => h.linuxClipboard,
  desktopRemoteDesktopLinuxClipboard: { closePublishedWriter: h.closeClipboardWriter }
}));
vi.mock("../src/remote-desktop-linux.js", () => ({ WAYLAND_REMOTE_DESKTOP_DISPLAY_ID: "wayland-portal",
  isDesktopRemoteDesktopWayland: () => h.linuxWayland, supportsDesktopRemoteDesktopLinuxCapture: () => h.linuxNative,
  readDesktopRemoteDesktopLinuxSessionState: vi.fn(async () => h.linuxSession),
  readDesktopRemoteDesktopLinuxLockSessionState: vi.fn(async () => h.linuxSession),
  readDesktopRemoteDesktopLinuxMonitors: vi.fn(async (_signal, _runtime, all) => all ? h.linuxAllMonitors ?? h.linuxMonitors : h.linuxMonitors),
  readDesktopRemoteDesktopLinuxInputSupport: vi.fn(async () => h.linuxInput),
  readDesktopRemoteDesktopLinuxCursorSupport: vi.fn(async () => h.linuxCursor),
  linuxRemoteDesktopDisplay: (monitor: { name: string; width: number; height: number }) => ({
    id: monitor.name, name: monitor.name, width: monitor.width, height: monitor.height }) }));
vi.mock("node:os", () => ({ release: () => h.os }));
vi.mock("../src/remote-desktop-windows-host.js", () => ({ desktopRemoteDesktopWindowsHost: {
  readSupport: vi.fn(async () => h.windowsReady ? "ready" : "missing")
} }));
vi.mock("electron", () => ({
  app: { get isPackaged() { return h.packaged; } },
  nativeTheme: Object.assign(new EventEmitter(), { shouldUseDarkColors: false }),
  BrowserWindow: class {}, dialog: {}, shell: {}, systemPreferences: {}, powerSaveBlocker: {},
  screen: Object.assign(new EventEmitter(), { getAllDisplays: vi.fn(() => [{ id: 1, label: "Desktop", size: { width: 1920, height: 1080 } }]) }),
  powerMonitor: Object.assign(new EventEmitter(), { getSystemIdleState: () => h.idle })
}));
vi.mock("../src/remote-desktop-host.js", () => ({ DesktopRemoteDesktopHost: class {
  constructor(dependencies: DesktopRemoteDesktopHostDependencies) { h.host = dependencies; }
  displayCoverageChanged = h.coverage; stopPrivacyByUser = vi.fn(async () => undefined);
  releaseControl = h.releaseControl;
  managesDisplayGeometry = h.managedGeometry;
  get managedViewerDisplay() { return h.managedViewer; }
} }));
vi.mock("../src/remote-desktop-media.js", () => ({ DesktopRemoteDesktopMedia: class {
  setPrivacyExclusions = h.excluded; clearPrivacyExclusions = h.cleared; preparePrivacy = h.prepare;
  setSessionState = h.resetSource;
} }));
vi.mock("../src/remote-desktop-privacy-screen.js", () => ({ DesktopRemoteDesktopPrivacyScreen: class {
  constructor(dependencies: DesktopRemoteDesktopPrivacyScreenDependencies) { h.privacy = dependencies; }
  get active() { return h.active; } set = vi.fn(); release = vi.fn();
} }));
vi.mock("../src/remote-desktop-clipboard.js", () => ({ DesktopRemoteDesktopClipboard: class {} }));
vi.mock("../src/remote-desktop-clipboard-counter.js", () => ({ DesktopRemoteDesktopClipboardCounter: class {} }));
vi.mock("../src/remote-desktop-credentials-native.js", () => ({ DesktopRemoteCredentialsNative: class {
  request = vi.fn(); close = vi.fn(async () => undefined);
} }));
vi.mock("../src/remote-desktop-input.js", () => ({
  DesktopRemoteDesktopInput: class { pauseForPrivacy = h.pause; }, lockDesktopRemoteDesktopScreen: vi.fn(),
  readDesktopRemoteDesktopDisplayModes: vi.fn(), readDesktopRemoteDesktopInputPermission: vi.fn(),
  readDesktopRemoteDesktopSessionState: vi.fn(), setDesktopRemoteDesktopDisplayMode: vi.fn(),
  restoreDesktopRemoteDesktopDisplayMode: vi.fn()
}));
import { nativeTheme, screen } from "electron";
import { createDesktopRemoteDesktopMainHost, closeDesktopRemoteDesktopClipboardWriter } from "../src/remote-desktop-main.js";
import { restoreDesktopRemoteDesktopDisplayMode, setDesktopRemoteDesktopDisplayMode } from "../src/remote-desktop-input.js";
import { restoreDesktopRemoteDesktopLinuxDisplayMode, setDesktopRemoteDesktopLinuxDisplayMode } from "../src/remote-desktop-linux-display.js";
import { lockDesktopRemoteDesktopLinuxScreen } from "../src/remote-desktop-linux-lock.js";
import { createDesktopRemoteDesktopSettingsStore } from "../src/remote-desktop-settings.js";
import { SystemAudioMuteGuard } from "../src/system-audio-mute.js";
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
const systemVersion = Object.getOwnPropertyDescriptor(process, "getSystemVersion");
beforeEach(() => {
  nativeTheme.removeAllListeners();
  h.host = undefined; h.privacy = undefined; h.active = true; h.os = "10.0.19041"; h.macVersion = "14.0";
  h.excluded.mockReset(); h.cleared.mockReset(); h.prepare.mockClear(); h.coverage.mockReset(); screen.removeAllListeners();
  h.linuxNative = false; h.linuxWayland = true; h.linuxSession = "unlocked"; h.linuxInput = false; h.linuxCursor = false;
  h.linuxMonitors = [{ name: "DP-1", width: 1920, height: 1080, x: -1920, y: 0, scale: 1, transform: 0 }];
  h.releaseControl.mockClear(); h.resetSource.mockClear();
  h.managedGeometry.mockReset(); h.managedGeometry.mockReturnValue(false); h.linuxModes = false;
  h.linuxClipboard = false; h.closeClipboardWriter.mockClear();
  h.linuxAudio = false;
  h.linuxMute = false; h.muteSet.mockClear(); h.muteRelease.mockClear();
  h.linuxPrivacy = false; h.linuxPrivacyPrepare.mockReset(); h.linuxPrivacyPrepare.mockResolvedValue(undefined);
  h.linuxPrivacySet.mockReset(); h.linuxPrivacyRelease.mockReset();
  h.linuxWorkspace = false; h.linuxSystemMenu = false; h.workspaceRequest.mockClear(); h.workspaceStop.mockClear();
  h.linuxViewer = false; h.linuxLock = false; h.managedViewer = undefined; h.linuxAllMonitors = undefined;
  h.packaged = true; h.macViewer = false; h.macProbe.mockReset(); h.macProbe.mockImplementation(async () => h.macViewer); h.macFactory.mockClear();
  Object.defineProperty(process, "getSystemVersion", { configurable: true, value: () => h.macVersion });
});
it.each(["development", "packaged", "windows"] as const)("viewer display Main admits its Mac factory only for %s", async condition => {
  h.packaged = condition === "packaged";
  h.macViewer = true;
  compose(condition === "windows" ? "win32" : "darwin");
  if (condition === "development") {
    expect(h.host!.createViewerDisplay).toBe(h.macFactory);
    const signal = new AbortController().signal;
    expect(await h.host!.viewerDisplaySupported!(signal)).toBe(true);
    expect(h.macProbe).toHaveBeenCalledExactlyOnceWith(signal);
    h.macViewer = false;
    expect(await h.host!.viewerDisplaySupported!(signal)).toBe(false);
  } else {
    expect(h.host!.createViewerDisplay).toBeUndefined();
    expect(h.host!.viewerDisplaySupported).toBeUndefined();
    expect(h.macProbe).not.toHaveBeenCalled();
  }
  expect(h.macFactory).not.toHaveBeenCalled();
});

it("clipboard Main admits Linux only with its native route and actual adapter support and joins app cleanup", async () => {
  h.linuxClipboard = true;
  compose("linux"); expect(h.host?.clipboard).toBeUndefined();
  h.linuxNative = true; compose("linux"); expect(h.host?.clipboard).toBeDefined(); expect(h.host?.clipboardCounter).toBeDefined();
  h.linuxClipboard = false; compose("linux"); expect(h.host?.clipboard).toBeUndefined();
  let complete!: () => void; h.closeClipboardWriter.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
  let closed = false; const pending = closeDesktopRemoteDesktopClipboardWriter().then(() => { closed = true; });
  await Promise.resolve(); expect(closed).toBe(false); complete(); await pending; expect(closed).toBe(true);
});
afterEach(() => {
  Object.defineProperty(process, "platform", platform);
  if (systemVersion === undefined) Reflect.deleteProperty(process, "getSystemVersion");
  else Object.defineProperty(process, "getSystemVersion", systemVersion);
});
function compose(target: NodeJS.Platform, credentialsOwner?: { readonly serverId: string; readonly deviceId: string; readonly profileId: string }) {
  Object.defineProperty(process, "platform", { ...platform, value: target });
  return createDesktopRemoteDesktopMainHost({
    sourceDirectory: "/trusted-app", settings: createDesktopRemoteDesktopSettingsStore("/unused-settings.json"),
    ...(credentialsOwner === undefined ? {} : { credentialsOwner }),
    systemAudioMute: new SystemAudioMuteGuard({ supported: true, getMuted: async () => false, setMuted: async () => undefined }),
    getMainWindow: () => undefined, changed: vi.fn()
  });
}
it("Linux Main passes only native leased actions and joins the same adapter stop", async () => {
  h.linuxWorkspace = true; h.linuxSystemMenu = true;
  compose("linux"); const signal = new AbortController().signal;
  expect(h.host?.workspaceAction).toBeUndefined();
  expect(h.host?.stopWorkspaceActions).toBeUndefined();
  expect(await h.host!.linuxCapabilities!(signal)).toMatchObject({ workspaceNavigation: false, systemMenu: false });
  h.linuxNative = true; compose("linux");
  expect(await h.host!.linuxCapabilities!(signal)).toMatchObject({ workspaceNavigation: true, systemMenu: true });
  const current = () => true;
  await h.host!.workspaceAction!("workspaceRight", "hyprland:DP-1", current, signal);
  expect(h.workspaceRequest).toHaveBeenCalledExactlyOnceWith("workspaceRight", "hyprland:DP-1", current, signal);
  await h.host!.stopWorkspaceActions!();
  expect(h.workspaceStop).toHaveBeenCalledOnce();
  h.linuxSystemMenu = false;
  expect(await h.host!.linuxCapabilities!(signal)).toMatchObject({ workspaceNavigation: true, systemMenu: false });
});
it.each(["darwin", "win32"] as const)("Main excludes Linux system actions on %s", target => {
  h.linuxNative = true; h.linuxWorkspace = true; h.linuxSystemMenu = true;
  compose(target);
  expect(h.host?.workspaceAction).toBeUndefined();
  expect(h.host?.stopWorkspaceActions).toBeUndefined();
  expect(h.workspaceRequest).not.toHaveBeenCalled();
});
it("Windows Main routes locked capture/input only with current service authorization", async () => {
  compose("win32"); const signal = new AbortController().signal;
  h.windowsReady = false; h.idle = "active";
  expect(await h.host!.sessionState(signal)).toBe("unlocked");
  h.idle = "locked"; expect(await h.host!.sessionState(signal)).toBe("unsupported");
  h.windowsReady = true; expect(await h.host!.sessionState(signal)).toBe("locked-logged-in");
  expect(await h.host!.windowsCapabilities!(signal)).toEqual({ canControl: true, cursorOverlay: true });
  h.windowsReady = false; expect(await h.host!.windowsCapabilities!(signal)).toEqual({ canControl: false, cursorOverlay: false });
  h.idle = "active";
});
it("audio Main advertises only the actual native Linux capture and output monitor route", () => {
  h.linuxAudio = true; compose("linux"); expect(h.host?.systemAudio).toBe(false);
  h.linuxNative = true; compose("linux"); expect(h.host?.systemAudio).toBe(true);
  h.linuxAudio = false; compose("linux"); expect(h.host?.systemAudio).toBe(false);
});
it("host mute Main composes the actual Linux output adapter independently of capture and voice", async () => {
  compose("linux"); expect(h.host?.hostMute).toBeUndefined();
  h.linuxMute = true; compose("linux");
  const owner = {}; const current = () => true; const signal = new AbortController().signal;
  await h.host!.hostMute!.set(owner, true, current, signal);
  await h.host!.hostMute!.release(owner);
  expect(h.muteSet).toHaveBeenCalledExactlyOnceWith(owner, true, current, signal);
  expect(h.muteRelease).toHaveBeenCalledExactlyOnceWith(owner);
  compose("darwin"); await h.host!.hostMute!.set(owner, true, current, signal);
  compose("win32"); await h.host!.hostMute!.set(owner, true, current, signal);
  expect(h.muteSet).toHaveBeenCalledOnce();
});
it("lock Main keeps Linux terminal locking independent of capture and ordinary locked viewing", async () => {
  h.linuxLock = true; h.linuxNative = false;
  compose("linux"); const signal = new AbortController().signal;
  expect(await h.host!.linuxCapabilities!(signal)).toMatchObject({ lockOnExit: true, canControl: false });
  expect(h.host!.lockScreen).toBe(lockDesktopRemoteDesktopLinuxScreen);
  h.linuxSession = "locked-logged-in";
  expect(await h.host!.sessionState!(signal)).toBe("unsupported");
  expect(await h.host!.lockSessionState!(signal)).toBe("locked-logged-in");
  h.linuxLock = false;
  expect(await h.host!.linuxCapabilities!(signal)).toMatchObject({ lockOnExit: false });
  compose("win32"); expect(h.host!.lockScreen).toBeUndefined(); expect(h.host!.lockSessionState).toBeUndefined();
});
it.each(["darwin", "win32", "linux"] as const)("native credential Main %s composes only an applicable captured owner", async (target) => {
  const owner = Object.freeze({ serverId: "server", deviceId: "host", profileId: "private-profile" });
  compose(target, owner);
  if (target === "darwin" || target === "linux") {
    expect(h.host?.credentials?.owner).toBe(owner);
    expect(h.host?.credentials?.native.request).toBeTypeOf("function");
    if (target === "linux") expect(await h.host!.credentials!.lockState!(new AbortController().signal)).toBe("locked");
    else expect(h.host?.credentials?.lockState).toBeUndefined();
    const first = h.host?.credentials?.native;
    compose(target, owner);
    expect(h.host?.credentials?.native).not.toBe(first);
    compose(target);
  }
  expect(h.host?.credentials).toBeUndefined();
});
it("native credential Main rejects a Mac below the native package minimum", () => {
  h.macVersion = "11.7";
  compose("darwin", { serverId: "server", deviceId: "host", profileId: "private-profile" });
  expect(h.host?.credentials).toBeUndefined();
});
it.each(["win32", "darwin"] as const)("privacy Main %s routes only its actual capture exclusions and awaits source proof", async (target) => {
  compose(target); expect(h.host?.privacyScreen).toBeDefined(); expect(h.privacy).toBeDefined();
  const owner = Object.freeze({}); const signal = new AbortController().signal;
  h.privacy!.excluded(owner, [1, 2]); await h.privacy!.prepare(owner, "1", () => true, signal); h.privacy!.cleared(owner);
  if (target === "darwin") {
    expect(h.excluded).toHaveBeenCalledExactlyOnceWith(owner, [1, 2]); expect(h.prepare).toHaveBeenCalledExactlyOnceWith(owner, "1", expect.any(Function), signal);
    expect(h.cleared).toHaveBeenCalledExactlyOnceWith(owner);
  } else { expect(h.excluded).not.toHaveBeenCalled(); expect(h.prepare).not.toHaveBeenCalled(); expect(h.cleared).not.toHaveBeenCalled(); }
  const unsubscribe = h.host!.onDisplayChange!(vi.fn()); screen.emit("display-added", {}, { id: 2 });
  expect(h.coverage).toHaveBeenCalledOnce(); h.active = false; screen.emit("display-added", {}, { id: 3 }); expect(h.coverage).toHaveBeenCalledOnce();
  unsubscribe(); expect(screen.listenerCount("display-added")).toBe(0);
});
it.each(["oldMac", "oldWindows"])("privacy Main rejects unsupported admission %s", (target) => {
  if (target === "oldMac") h.macVersion = "13.6"; if (target === "oldWindows") h.os = "10.0.18363";
  compose(target === "oldMac" ? "darwin" : target === "oldWindows" ? "win32" : "linux");
  expect(h.host?.privacyScreen).toBeUndefined(); expect(h.privacy).toBeUndefined();
});
it("privacy Main admits only the actual Linux plugin and prepares before the lease while preserving ordinary view", async () => {
  h.linuxPrivacy = true; compose("linux"); const signal = new AbortController().signal;
  expect((await h.host!.linuxCapabilities!(signal)).privacyScreen).toBe(false);
  await h.host!.prepare!(() => true, signal); expect(h.linuxPrivacyPrepare).not.toHaveBeenCalled();
  h.linuxNative = true; compose("linux");
  expect((await h.host!.linuxCapabilities!(signal)).privacyScreen).toBe(true);
  const current = () => true;
  await h.host!.prepare!(current, signal);
  expect(h.linuxPrivacyPrepare).toHaveBeenCalledExactlyOnceWith(current, signal, true);
  h.linuxPrivacyPrepare.mockRejectedValueOnce(new Error("plugin failed"));
  await expect(h.host!.prepare!(current, signal)).resolves.toBeUndefined();
  h.linuxPrivacyPrepare.mockRejectedValueOnce(new Error("plugin failed"));
  await expect(h.host!.prepare!(() => false, signal)).rejects.toThrow("REMOTE_DESKTOP_PRIVACY_EXPIRED");
  h.linuxPrivacy = false;
  expect((await h.host!.linuxCapabilities!(signal)).privacyScreen).toBe(false);
});

it.each(["darwin", "win32", "linux"] as const)("physical mode Main %s exposes captured restoration only on Mac", async (target) => {
  compose(target);
  if (target === "darwin") {
    expect(h.host?.setDisplayMode).toBe(setDesktopRemoteDesktopDisplayMode);
    expect(h.host?.restoreDisplayMode).toBe(restoreDesktopRemoteDesktopDisplayMode);
    expect(await h.host!.displayPresent!("1")).toBe(true);
    expect(await h.host!.displayPresent!("2")).toBe(false);
  } else {
    expect(h.host?.setDisplayMode).toBeUndefined(); expect(h.host?.restoreDisplayMode).toBeUndefined();
    expect(h.host?.displayPresent).toBeUndefined();
  }
});

it("physical mode Main uses the actual Linux adapter and never offers it on portal viewing", async () => {
  h.linuxModes = true; compose("linux");
  expect(h.host?.setDisplayMode).toBeUndefined();
  expect(await h.host!.linuxCapabilities!(new AbortController().signal)).toMatchObject({ displayModes: false });
  h.linuxNative = true; compose("linux");
  expect(h.host?.setDisplayMode).toBe(setDesktopRemoteDesktopLinuxDisplayMode);
  expect(h.host?.restoreDisplayMode).toBe(restoreDesktopRemoteDesktopLinuxDisplayMode);
  expect(await h.host!.linuxCapabilities!(new AbortController().signal)).toMatchObject({ displayModes: true });
  expect(await h.host!.displayPresent!("DP-1")).toBe(true);
  expect(await h.host!.displayPresent!("missing")).toBe(false);
  h.linuxModes = false;
  expect(await h.host!.linuxCapabilities!(new AbortController().signal)).toMatchObject({ displayModes: false });
});

it("Linux layout polling preserves acknowledged mode geometry and still retires other layout changes", async () => {
  h.linuxNative = true; compose("linux"); const signal = new AbortController().signal;
  await h.host!.displays(signal);
  h.managedGeometry.mockReturnValue(true);
  h.linuxMonitors = [{ ...h.linuxMonitors[0]!, width: 1280, height: 720 }];
  await h.host!.displays(signal);
  expect(h.managedGeometry).toHaveBeenCalledWith("DP-1", 1280, 720);
  expect(h.releaseControl).not.toHaveBeenCalled();
  h.linuxMonitors = [{ ...h.linuxMonitors[0]!, x: 0 }];
  await h.host!.displays(signal);
  expect(h.releaseControl).toHaveBeenCalledOnce();
  h.managedGeometry.mockReturnValue(false);
  h.linuxMonitors = [{ ...h.linuxMonitors[0]!, width: 1920, height: 1080 }];
  await h.host!.displays(signal);
  expect(h.releaseControl).toHaveBeenCalledTimes(2);
});

it("mirror Main admits exact owned source and capture transitions, preserves physical directory and catches unplug with stable active layout", async () => {
  h.linuxNative = true; h.linuxViewer = true; compose("linux");
  const signal = new AbortController().signal, listener = vi.fn(); h.host!.onDisplayChange!(listener);
  await h.host!.displays(signal); const source = h.linuxMonitors[0]!;
  h.managedViewer = { sourceDisplayId: "DP-1", displayId: "JokoRemote-0123456789abcdef" };
  h.linuxMonitors = [{ ...source, name: h.managedViewer.displayId, width: 1920, height: 1440, x: 0 }];
  h.linuxAllMonitors = [source, ...h.linuxMonitors];
  expect(await h.host!.displays(signal)).toEqual([{ id: "DP-1", name: "DP-1", width: 1920, height: 1080 }]);
  expect(h.releaseControl).not.toHaveBeenCalled(); expect(listener).not.toHaveBeenCalled();
  expect(await h.host!.linuxCapabilities!(signal)).toMatchObject({ viewerDisplay: true });
  h.linuxAllMonitors = [...h.linuxMonitors]; await h.host!.displays(signal);
  expect(h.coverage).toHaveBeenCalledOnce();
});

it("mirror Main does not exempt another output from the exact owned transition", async () => {
  h.linuxNative = true; compose("linux"); const signal = new AbortController().signal;
  await h.host!.displays(signal); const source = h.linuxMonitors[0]!;
  h.managedViewer = { sourceDisplayId: "DP-1", displayId: "JokoRemote-0123456789abcdef" };
  h.linuxMonitors = [{ ...source, name: "unowned-output", x: 0 }]; h.linuxAllMonitors = [source, ...h.linuxMonitors];
  await h.host!.displays(signal); expect(h.releaseControl).toHaveBeenCalledOnce();
});

it.each(["darwin", "linux"] as const)("display Main %s carries actual geometry and exact metrics, including workArea, rotation and removal", target => {
  h.linuxWayland = false; compose(target); const listener = vi.fn(); const unsubscribe = h.host!.onDisplayChange!(listener);
  const actual = { id: 1, size: { width: 1024, height: 768 } };
  for (const metric of ["bounds", "workArea", "scaleFactor", "rotation"]) {
    screen.emit("display-metrics-changed", {}, actual, [metric]);
    expect(listener).toHaveBeenLastCalledWith("1", true, { width: 1024, height: 768, metrics: [metric] });
  }
  screen.emit("display-metrics-changed", {}, actual, ["colorSpace"]);
  expect(listener).toHaveBeenLastCalledWith("1", false, { width: 1024, height: 768, metrics: ["colorSpace"] });
  screen.emit("display-removed", {}, actual);
  expect(listener).toHaveBeenLastCalledWith("1", true, { width: 1024, height: 768, metrics: ["removed"] });
  unsubscribe(); expect(screen.listenerCount("display-removed")).toBe(0); expect(screen.listenerCount("display-metrics-changed")).toBe(0);
});

it("Linux Main admits one portal source and reads actual locked state without using Electron display IDs", async () => {
  compose("linux"); const signal = new AbortController().signal;
  expect(await h.host!.displays(signal)).toEqual([{ id: "wayland-portal", name: "Shared screen", width: 1280, height: 720 }]);
  expect(await h.host!.linuxCapabilities!(signal)).toEqual({ canControl: false, cursorOverlay: false, displayModes: false, viewerDisplay: false, lockOnExit: false, privacyScreen: false, workspaceNavigation: false, systemMenu: false });
  h.linuxSession = "unsupported";
  expect(await h.host!.sessionState(signal)).toBe("unsupported");
  h.linuxSession = "locked-logged-in";
  expect(await h.host!.sessionState(signal)).toBe("unsupported");
});

it("Linux X11 Main exposes only fresh physical desktop viewing even with unrelated native tools installed", async () => {
  h.linuxWayland = false; h.linuxMute = true; h.linuxLock = true; h.linuxPrivacy = true;
  h.linuxAudio = true; h.linuxClipboard = true; h.linuxInput = true; h.linuxCursor = true; h.linuxModes = true;
  h.linuxViewer = true; h.linuxWorkspace = true; h.linuxSystemMenu = true;
  compose("linux", { serverId: "server", deviceId: "host", profileId: "profile" });
  const signal = new AbortController().signal;
  expect(await h.host!.sessionState(signal)).toBe("unlocked");
  expect(await h.host!.displays(signal)).toEqual([{ id: "1", name: "Desktop", width: 1920, height: 1080 }]);
  expect(await h.host!.linuxCapabilities!(signal)).toEqual({ canControl: false, cursorOverlay: false,
    displayModes: false, viewerDisplay: false, lockOnExit: false, privacyScreen: false, workspaceNavigation: false, systemMenu: false });
  expect(h.host).toMatchObject({ systemAudio: false });
  for (const capability of ["clipboard", "hostMute", "privacyScreen", "credentials", "lockScreen", "createViewerDisplay"] as const) {
    expect(h.host![capability]).toBeUndefined();
  }
  vi.mocked(screen.getAllDisplays).mockImplementationOnce(() => { h.linuxSession = "unsupported"; return []; });
  await expect(h.host!.displays(signal)).rejects.toThrow("LOCKED_SESSION_UNSUPPORTED");
  expect(await h.host!.sessionState(signal)).toBe("unsupported");
  await expect(h.host!.displays(signal)).rejects.toThrow("LOCKED_SESSION_UNSUPPORTED");
});

it("Linux Main adopts actual native output catalog and independent probes, then revokes control before layout reset", async () => {
  h.linuxNative = true; h.linuxInput = false; h.linuxCursor = true; compose("linux");
  const signal = new AbortController().signal; const listener = vi.fn(); const unsubscribe = h.host!.onDisplayChange!(listener);
  expect(await h.host!.linuxCapabilities!(signal)).toEqual({ canControl: false, cursorOverlay: true, displayModes: false, viewerDisplay: false, lockOnExit: false, privacyScreen: false, workspaceNavigation: false, systemMenu: false });
  expect(await h.host!.displays(signal)).toEqual([{ id: "DP-1", name: "DP-1", width: 1920, height: 1080 }]);
  h.linuxInput = true; expect(await h.host!.linuxCapabilities!(signal)).toMatchObject({ canControl: true });
  h.linuxMonitors = [{ name: "DP-1", width: 1920, height: 1080, x: 0, y: -1080, scale: 1, transform: 0 }];
  await h.host!.displays(signal);
  expect(h.releaseControl).toHaveBeenCalledOnce(); expect(h.resetSource).toHaveBeenCalledExactlyOnceWith(false);
  expect(h.releaseControl.mock.invocationCallOrder[0]).toBeLessThan(h.resetSource.mock.invocationCallOrder[0]!);
  expect(listener).not.toHaveBeenCalled();
  h.linuxMonitors = [];
  await h.host!.displays(signal); expect(listener).toHaveBeenCalledWith("DP-1", true,
    { width: 1920, height: 1080, metrics: ["removed"] });
  unsubscribe();
});
