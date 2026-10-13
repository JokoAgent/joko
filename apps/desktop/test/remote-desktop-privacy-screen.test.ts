import { EventEmitter } from "node:events";
import { beforeEach, expect, it, vi } from "vitest";
import type { BrowserWindowConstructorOptions } from "electron";

interface TestMask extends EventEmitter {
  id: number; destroyed: boolean; options: BrowserWindowConstructorOptions;
  bounds: { x: number; y: number; width: number; height: number };
  webContents: EventEmitter & { setWindowOpenHandler: ReturnType<typeof vi.fn> };
  setContentProtection: ReturnType<typeof vi.fn>; setIgnoreMouseEvents: ReturnType<typeof vi.fn>;
  setFocusable: ReturnType<typeof vi.fn>; focus: ReturnType<typeof vi.fn>; showInactive: ReturnType<typeof vi.fn>;
  destroy(): void;
}
const state = vi.hoisted(() => ({
  windows: [] as TestMask[], displays: [] as { id: number; bounds: TestMask["bounds"] }[],
  confirm: vi.fn<(window: unknown, options: unknown) => Promise<{ response: number }>>(),
  permissionCheck: vi.fn(), permissionRequest: vi.fn(), beforeRequest: vi.fn()
}));
vi.mock("electron", () => ({
  app: { focus: vi.fn(), getLocale: () => "en" }, dialog: { showMessageBox: state.confirm },
  BrowserWindow: class extends EventEmitter {
    id = state.windows.length + 1; destroyed = false; bounds = { x: 0, y: 0, width: 0, height: 0 };
    webContents = Object.assign(new EventEmitter(), { setWindowOpenHandler: vi.fn() });
    constructor(readonly options: BrowserWindowConstructorOptions) { super(); state.windows.push(this); }
    setMenuBarVisibility() {} async loadURL() {}
    setContentProtection = vi.fn(); setIgnoreMouseEvents = vi.fn(); setFocusable = vi.fn(); focus = vi.fn(); showInactive = vi.fn();
    setVisibleOnAllWorkspaces() {} setAlwaysOnTop() {}
    getMediaSourceId() { return `window:${this.id}:0`; }
    setBounds(bounds: TestMask["bounds"]) { this.bounds = bounds; }
    isDestroyed() { return this.destroyed; }
    destroy() { this.destroyed = true; this.emit("closed"); }
  },
  screen: Object.assign(new EventEmitter(), { getAllDisplays: () => state.displays }),
  session: { fromPartition: () => ({
    setPermissionCheckHandler: state.permissionCheck, setPermissionRequestHandler: state.permissionRequest,
    webRequest: { onBeforeRequest: state.beforeRequest }
  }) }
}));
vi.mock("../src/remote-desktop-privacy-input.js", () => ({ watchDesktopRemoteDesktopPrivacyInput: vi.fn() }));
import { screen } from "electron";
import { DesktopRemoteDesktopPrivacyScreen } from "../src/remote-desktop-privacy-screen.js";

beforeEach(() => {
  screen.removeAllListeners(); state.windows.length = 0;
  state.displays = [{ id: 1, bounds: { x: 0, y: 0, width: 1440, height: 900 } }, { id: 2, bounds: { x: -900, y: -100, width: 900, height: 1200 } }];
  state.confirm.mockReset().mockResolvedValue({ response: 1 });
  state.permissionCheck.mockReset(); state.permissionRequest.mockReset(); state.beforeRequest.mockReset();
});
function fixture() {
  const token = Object.freeze({}); const command = new AbortController(); let current = true;
  const monitor = { confirm: vi.fn(async (): Promise<void> => undefined), resume: vi.fn(async (): Promise<void> => undefined), stop: vi.fn(async (): Promise<void> => undefined) };
  const resume = vi.fn(async (): Promise<void> => undefined); const suspend = vi.fn(async () => resume);
  const stopped = vi.fn(async (_owner: object): Promise<void> => undefined), excluded = vi.fn(), cleared = vi.fn();
  const prepare = vi.fn(async (_owner: object, _display: string, _current: () => boolean, _signal: AbortSignal): Promise<void> => undefined);
  let local!: () => void; let failed!: () => void;
  const watchInput = vi.fn(async (onLocal: () => void, onFailed: () => void, _signal: AbortSignal) => { local = onLocal; failed = onFailed; return monitor; });
  const masks = new DesktopRemoteDesktopPrivacyScreen({ excluded, cleared, prepare, stopped, suspendInput: suspend, watchInput });
  return { masks, token, command, monitor, resume, suspend, stopped, excluded, cleared, prepare, watchInput,
    local: () => local(), failed: () => failed(), retire: () => { current = false; },
    start: (owner = token) => masks.set(owner, "1", () => current, command.signal) };
}
const settle = async () => { for (let count = 0; count < 30; count++) await Promise.resolve(); };

it("privacy covers every physical display in isolated passive masks and waits actual filtered capture before receipt", async () => {
  const f = fixture(); let captured!: () => void;
  f.prepare.mockImplementationOnce(async () => new Promise<void>((resolve) => { captured = resolve; }));
  let acknowledged = false; const starting = f.start().then(() => { acknowledged = true; });
  await vi.waitFor(() => expect(f.prepare).toHaveBeenCalledOnce());
  expect(acknowledged).toBe(false); expect(state.windows).toHaveLength(2);
  for (const [index, mask] of state.windows.entries()) {
    expect(mask.bounds).toEqual(state.displays[index]!.bounds);
    expect(mask.options).toMatchObject({ focusable: false, frame: false, roundedCorners: false,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, plugins: false, devTools: false } });
    expect(mask.options.webPreferences?.preload).toBeUndefined();
    expect(mask.setContentProtection).toHaveBeenCalledWith(true);
    expect(mask.setIgnoreMouseEvents).toHaveBeenLastCalledWith(true);
    expect(mask.focus).not.toHaveBeenCalled(); expect(mask.showInactive).toHaveBeenCalledOnce();
  }
  expect(f.excluded).toHaveBeenCalledWith(f.token, [1, 2]);
  expect(state.permissionCheck.mock.calls[0]![0]()).toBe(false);
  const permission = vi.fn(); state.permissionRequest.mock.calls[0]![0]({}, "media", permission);
  expect(permission).toHaveBeenCalledWith(false);
  const request = vi.fn(); state.beforeRequest.mock.calls[0]![0]({ url: "https://remote.invalid" }, request);
  expect(request).toHaveBeenCalledWith({ cancel: true });
  captured(); await starting;
  const bounds = { x: 2000, y: 100, width: 1000, height: 800 };
  screen.emit("display-metrics-changed", {}, { id: 2, bounds }); expect(state.windows[1]!.bounds).toEqual(bounds);
  await f.masks.release(f.token); expect(f.cleared).toHaveBeenCalledExactlyOnceWith(f.token);
  expect(screen.listenerCount("display-metrics-changed")).toBe(0);
});

it("privacy drains the remote helper before native fence and resumes it before rearming on Cancel", async () => {
  const f = fixture(); let drained!: () => void;
  f.suspend.mockImplementationOnce(async () => new Promise<typeof f.resume>((resolve) => { drained = () => resolve(f.resume); }));
  state.confirm.mockResolvedValueOnce({ response: 0 }); await f.start();
  f.local(); f.local(); expect(f.suspend).toHaveBeenCalledOnce(); expect(f.monitor.confirm).not.toHaveBeenCalled();
  drained(); await settle();
  expect(f.monitor.confirm.mock.invocationCallOrder[0]).toBeLessThan(state.confirm.mock.invocationCallOrder[0]!);
  expect(f.resume.mock.invocationCallOrder[0]).toBeLessThan(f.monitor.resume.mock.invocationCallOrder[0]!);
  expect(f.stopped).not.toHaveBeenCalled(); expect(state.windows[0]!.setFocusable).toHaveBeenLastCalledWith(false);
  expect(state.windows[0]!.setIgnoreMouseEvents).toHaveBeenLastCalledWith(true); await f.masks.release(f.token);
});

it.each(["confirmed", "watcher", "renderer"])("privacy retains masks until actual hook close and captured terminal completes: %s", async (cause) => {
  const f = fixture(); let unhook!: () => void; let terminal!: () => void;
  const closing = new Promise<void>((resolve) => { unhook = resolve; }); f.monitor.stop.mockReturnValue(closing);
  f.stopped.mockImplementationOnce(async () => new Promise<void>((resolve) => { terminal = resolve; }));
  await f.start();
  if (cause === "confirmed") f.local(); else if (cause === "watcher") f.failed(); else state.windows[0]!.webContents.emit("render-process-gone");
  await settle(); expect(f.monitor.stop).toHaveBeenCalledOnce(); expect(f.stopped).not.toHaveBeenCalled();
  expect(state.windows.every((window) => !window.destroyed)).toBe(true); expect(f.cleared).not.toHaveBeenCalled();
  unhook(); await settle(); expect(f.stopped).toHaveBeenCalledExactlyOnceWith(f.token);
  expect(state.windows.every((window) => !window.destroyed)).toBe(true); expect(f.cleared).not.toHaveBeenCalled();
  f.failed(); expect(f.stopped).toHaveBeenCalledOnce(); terminal(); await settle();
  expect(state.windows.every((window) => window.destroyed)).toBe(true); expect(f.cleared).toHaveBeenCalledExactlyOnceWith(f.token);
});

it("privacy ignores a delayed old dialog after a replacement mask occurrence", async () => {
  const f = fixture(); let finish!: (response: { response: number }) => void;
  state.confirm.mockImplementationOnce(async () => new Promise((resolve) => { finish = resolve; }));
  await f.start(); f.local(); await settle(); await f.masks.release(f.token);
  const next = Object.freeze({}); await f.start(next); finish({ response: 1 }); await settle();
  expect(f.stopped).not.toHaveBeenCalled(); expect(state.windows[2]!.destroyed).toBe(false);
  expect(f.excluded).toHaveBeenLastCalledWith(next, [3, 4]); expect(f.monitor.resume).not.toHaveBeenCalled();
  await f.masks.release(next);
});

it("privacy retirement during native preparation keeps the occupied slot until the old watcher actually closes", async () => {
  const f = fixture(); let ready!: (monitor: typeof f.monitor) => void; let closed!: () => void;
  f.watchInput.mockImplementationOnce(async () => new Promise((resolve) => { ready = resolve; }));
  f.monitor.stop.mockReturnValueOnce(new Promise<void>((resolve) => { closed = resolve; }));
  const starting = expect(f.start()).rejects.toThrowError("REMOTE_DESKTOP_PRIVACY_EXPIRED");
  await vi.waitFor(() => expect(f.watchInput).toHaveBeenCalledOnce());
  const release = f.masks.release(f.token); const next = Object.freeze({}); const replacing = f.start(next);
  await settle(); expect(f.watchInput).toHaveBeenCalledOnce(); expect(state.windows[0]!.destroyed).toBe(false);
  ready(f.monitor); await settle(); expect(f.cleared).not.toHaveBeenCalled(); expect(f.watchInput).toHaveBeenCalledOnce();
  closed(); await release; await starting; await replacing;
  expect(f.cleared).toHaveBeenCalledWith(f.token); expect(f.prepare).toHaveBeenCalledExactlyOnceWith(next, "1", expect.any(Function), f.command.signal);
  await f.masks.release(next);
});

it("privacy filtered preparation failure restores its exact masks without issuing terminal lock", async () => {
  const f = fixture(); f.prepare.mockRejectedValueOnce(new Error("REMOTE_DESKTOP_PRIVACY_FAILED"));
  await expect(f.start()).rejects.toThrowError("REMOTE_DESKTOP_PRIVACY_FAILED");
  expect(f.monitor.stop).toHaveBeenCalledOnce(); expect(f.cleared).toHaveBeenCalledExactlyOnceWith(f.token);
  expect(f.stopped).not.toHaveBeenCalled(); expect(f.masks.active).toBe(false);
});
