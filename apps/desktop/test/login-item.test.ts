import { runInNewContext } from "node:vm";
import type { IpcMainInvokeEvent } from "electron";
import { describe, expect, it, vi } from "vitest";
import { DESKTOP_CHANNELS, type DesktopLoginItemState } from "../src/channels.js";
import { createDesktopLoginItemSettings, registerDesktopLoginItemIpc } from "../src/login-item.js";
import { compiledPreloadSource } from "./support/preload-source.js";

function fixture(platform = "win32", isPackaged = true) {
  const state = { openAtLogin: false, status: "not-registered", launchItems: [] as { name: string; scope: string; args: string[]; enabled: boolean }[] };
  const app = { isPackaged, getLoginItemSettings: vi.fn(() => structuredClone(state)), setLoginItemSettings: vi.fn((value: { openAtLogin: boolean }) => {
    state.openAtLogin = value.openAtLogin;
    state.launchItems = value.openAtLogin ? [{ name: "Joko", scope: "user", args: [], enabled: true }] : [];
    state.status = value.openAtLogin ? "enabled" : "not-registered";
  }) };
  return { state, app, options: { app, platform, executable: "C:\\Program Files\\Joko\\Joko.exe" },
    settings: createDesktopLoginItemSettings({ app, platform, executable: "C:\\Program Files\\Joko\\Joko.exe" }) };
}

describe("OS-owned login startup", () => {
  it("does not register by default and matches only this executable's own Windows user item", () => {
    const f = fixture();
    expect(f.settings.read()).toEqual({ available: true, enabled: false, requiresApproval: false });
    expect(f.app.setLoginItemSettings).not.toHaveBeenCalled();
    expect(f.app.getLoginItemSettings).toHaveBeenCalledWith({ path: '"C:\\Program Files\\Joko\\Joko.exe"', args: [] });
    f.state.openAtLogin = true;
    f.state.launchItems = [
      { name: "Another app", scope: "user", args: [], enabled: true },
      { name: "Joko", scope: "machine", args: [], enabled: true },
      { name: "Joko", scope: "user", args: ["--unrelated"], enabled: true },
      { name: "Joko", scope: "user", args: [], enabled: false }
    ];
    expect(f.settings.read().enabled).toBe(false);
    expect(f.settings.set(true).enabled).toBe(true);
    expect(f.app.setLoginItemSettings).toHaveBeenCalledWith({ openAtLogin: true,
      path: "C:\\Program Files\\Joko\\Joko.exe", args: [], name: "Joko", enabled: true });
    f.state.launchItems = [];
    expect(f.settings.read().enabled).toBe(false);
    expect(f.app.setLoginItemSettings).toHaveBeenCalledOnce();
    expect(f.settings.set(false).enabled).toBe(false);
  });

  it("keeps macOS approval visible and verifies both registration and removal against the OS", () => {
    const f = fixture("darwin");
    f.app.setLoginItemSettings.mockImplementation(() => { f.state.status = "requires-approval"; });
    expect(f.settings.set(true)).toEqual({ available: true, enabled: false, requiresApproval: true });
    expect(f.app.setLoginItemSettings).toHaveBeenCalledWith({ openAtLogin: true });
    expect(() => f.settings.set(false)).toThrow("did not apply");
    f.app.setLoginItemSettings.mockImplementation(() => { f.state.status = "not-registered"; f.state.openAtLogin = false; });
    expect(f.settings.set(false)).toEqual({ available: true, enabled: false, requiresApproval: false });
    f.app.setLoginItemSettings.mockImplementation(() => undefined);
    expect(() => f.settings.set(true)).toThrow("did not apply");
  });

  it.each([["win32", false, "development"], ["darwin", false, "development"], ["linux", true, "platform"]] as const)(
    "never registers on unavailable %s packaged=%s", (platform, packaged, reason) => {
      const f = fixture(platform, packaged);
      expect(f.settings.read()).toEqual({ available: false, enabled: false, requiresApproval: false, unavailableReason: reason });
      expect(() => f.settings.set(true)).toThrow("installed");
      expect(f.app.getLoginItemSettings).not.toHaveBeenCalled(); expect(f.app.setLoginItemSettings).not.toHaveBeenCalled();
    });

  it("requires a trusted application sender and exact get/set payloads before native reads or writes", () => {
    const f = fixture(), trusted = {} as IpcMainInvokeEvent, untrusted = {} as IpcMainInvokeEvent;
    const handlers = new Map<string, (event: IpcMainInvokeEvent, ...parameters: unknown[]) => unknown>();
    registerDesktopLoginItemIpc({ ...f.options, ipc: { handle: (name, handler) => { handlers.set(name, handler); } },
      assertSource: event => { if (event !== trusted) throw new Error("untrusted"); } });
    const read = handlers.get(DESKTOP_CHANNELS.loginItemGet)!, set = handlers.get(DESKTOP_CHANNELS.loginItemSet)!;
    expect(() => read(untrusted)).toThrow("untrusted"); expect(() => set(untrusted, true)).toThrow("untrusted");
    expect(() => read(trusted, "path")).toThrow();
    for (const values of [[], [true, "path"], ["true"], [{ enabled: true, path: "other.exe" }]]) expect(() => set(trusted, ...values)).toThrow();
    expect(f.app.getLoginItemSettings).not.toHaveBeenCalled(); expect(f.app.setLoginItemSettings).not.toHaveBeenCalled();
    expect(set(trusted, true)).toEqual({ available: true, enabled: true, requiresApproval: false });
    f.app.getLoginItemSettings.mockImplementation(() => { throw new Error("private OS failure"); });
    expect(() => read(trusted)).toThrow("Could not read");
  });
});

it("the actual sandboxed preload rejects non-boolean writes and malformed OS projections", async () => {
  let bridge!: { loginItem: { get(): Promise<DesktopLoginItemState>; set(value: unknown): Promise<DesktopLoginItemState> }; capabilities: readonly string[] };
  const invoke = vi.fn(async (_channel: string, ..._parameters: unknown[]): Promise<unknown> => ({ available: true, enabled: false, requiresApproval: false }));
  runInNewContext(compiledPreloadSource(), {
    module: { exports: {} }, exports: {}, require: () => ({
      contextBridge: { exposeInMainWorld: (_name: string, value: typeof bridge) => { bridge = value; } },
      ipcRenderer: { invoke, send: vi.fn(), sendSync: (channel: string) => channel === DESKTOP_CHANNELS.preferredSystemLocaleGet ? "en" : false,
        on: vi.fn(), removeListener: vi.fn() }
    }), process: { platform: "win32" }, crypto: { randomUUID: () => "00000000-0000-4000-8000-000000000001" },
    console, Object, Promise, Set, Map, WeakMap, BigInt, Number, String, Boolean, TypeError, RangeError, RegExp, URL, URLSearchParams,
    TextEncoder, Uint8Array, ArrayBuffer, structuredClone
  });
  expect(bridge.capabilities).toContain("window.loginItem"); expect(Object.isFrozen(bridge.loginItem)).toBe(true);
  await bridge.loginItem.get(); await bridge.loginItem.set(true);
  expect(invoke.mock.calls).toEqual([[DESKTOP_CHANNELS.loginItemGet], [DESKTOP_CHANNELS.loginItemSet, true]]);
  await expect(bridge.loginItem.set({ path: "other.exe" })).rejects.toThrow(); expect(invoke).toHaveBeenCalledTimes(2);
  for (const malformed of [null, {}, { available: true, enabled: "true", requiresApproval: false },
    { available: true, enabled: false, requiresApproval: false, path: "other.exe" },
    { available: false, enabled: true, requiresApproval: false, unavailableReason: "development" },
    { available: false, enabled: false, requiresApproval: false },
    { available: false, enabled: false, requiresApproval: false, unavailableReason: "missing" }]) {
    invoke.mockResolvedValue(malformed); await expect(bridge.loginItem.get()).rejects.toThrow();
  }
  invoke.mockResolvedValue({ available: false, enabled: false, requiresApproval: false, unavailableReason: "development" });
  await expect(bridge.loginItem.get()).resolves.toMatchObject({ unavailableReason: "development" });
});
