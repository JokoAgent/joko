import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";
import { describe, expect, it, vi } from "vitest";
import { DESKTOP_CHANNELS, type DesktopWallpaperSettings } from "../src/channels.js";

interface WallpaperBridge {
  get(): Promise<DesktopWallpaperSettings>;
  set(change: unknown): Promise<DesktopWallpaperSettings>;
  import(revision: unknown): Promise<unknown>;
  remove(revision: unknown): Promise<DesktopWallpaperSettings>;
  reset(revision: unknown): Promise<DesktopWallpaperSettings>;
  onChanged(listener: unknown): () => void;
}
const image = { id: "a".repeat(64), url: `joko-wallpaper://image/${"a".repeat(64)}.webp`, width: 1920, height: 1080 };
const settings: DesktopWallpaperSettings = { version: 1, revision: 3, mode: "custom", maskOpacity: 0.2, customImage: image };

/** Execute the actual sandboxed preload source; only Electron's host transport is controlled. */
function loadPreload() {
  const source = readFileSync(new URL("../src/preload.cts", import.meta.url), "utf8");
  const output = transpileModule(source, { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 } }).outputText;
  const listeners = new Map<string, Set<(...parameters: unknown[]) => void>>();
  const invoke = vi.fn(async (channel: string, ..._parameters: unknown[]): Promise<unknown> =>
    channel === DESKTOP_CHANNELS.wallpaperImport ? { cancelled: true } : settings);
  const removeListener = vi.fn((channel: string, listener: (...parameters: unknown[]) => void): void => {
    listeners.get(channel)?.delete(listener);
  });
  let exposed!: Readonly<Record<string, unknown>>;
  const electron = {
    contextBridge: { exposeInMainWorld: (_name: string, value: Readonly<Record<string, unknown>>): void => { exposed = value; } },
    ipcRenderer: {
      invoke, send: vi.fn(), removeListener,
      sendSync: (channel: string): unknown => channel === DESKTOP_CHANNELS.mainDocumentOccurrenceGet ? "wallpaper-document"
        : channel === DESKTOP_CHANNELS.preferredSystemLocaleGet ? "en" : false,
      on: (channel: string, listener: (...parameters: unknown[]) => void): void => {
        const registered = listeners.get(channel) ?? new Set(); registered.add(listener); listeners.set(channel, registered);
      }
    }
  };
  const commonJsModule = { exports: {} };
  runInNewContext(output, {
    module: commonJsModule, exports: commonJsModule.exports,
    require: (specifier: string): unknown => {
      if (specifier !== "electron") throw new Error(`Unexpected preload dependency: ${specifier}`);
      return electron;
    },
    process: { platform: "win32" }, crypto: { randomUUID: () => "00000000-0000-4000-8000-000000000001" },
    console, Object, Promise, Set, Map, WeakMap, BigInt, Number, String, Boolean, TypeError, RangeError, RegExp,
    URL, URLSearchParams, TextEncoder, Uint8Array, ArrayBuffer, structuredClone
  });
  return {
    exposed, api: exposed["wallpaper"] as WallpaperBridge, invoke, listeners, removeListener,
    emit: (value: unknown) => { for (const listener of listeners.get(DESKTOP_CHANNELS.wallpaperChanged) ?? []) listener({}, value); }
  };
}

describe("actual Desktop wallpaper preload bridge", () => {
  it("exposes a frozen device-local API and invokes all five exact request channels", async () => {
    const f = loadPreload();
    expect(f.exposed["capabilities"]).toContain("appearance.wallpaper");
    expect(Object.isFrozen(f.api)).toBe(true);
    const read = await f.api.get();
    expect(read).toEqual(settings); expect(read).not.toBe(settings);
    expect(Object.isFrozen(read)).toBe(true); expect(Object.isFrozen(read.customImage)).toBe(true);
    await expect(f.api.set({ expectedRevision: 3, mode: "none", maskOpacity: 0.3 })).resolves.toEqual(settings);
    await expect(f.api.import(3)).resolves.toEqual({ cancelled: true });
    await expect(f.api.remove(3)).resolves.toEqual(settings);
    await expect(f.api.reset(3)).resolves.toEqual(settings);
    expect(f.invoke.mock.calls).toEqual([
      [DESKTOP_CHANNELS.wallpaperGet],
      [DESKTOP_CHANNELS.wallpaperSet, { expectedRevision: 3, mode: "none", maskOpacity: 0.3 }],
      [DESKTOP_CHANNELS.wallpaperImport, 3], [DESKTOP_CHANNELS.wallpaperRemove, 3], [DESKTOP_CHANNELS.wallpaperReset, 3]
    ]);
  });

  it("rejects renderer paths, unknown fields, mask steps and invalid revisions before host invocation", () => {
    const f = loadPreload();
    for (const change of [
      { expectedRevision: 3, path: "D:\\private-photo\\selected.png" }, { expectedRevision: 3, customImage: image },
      { expectedRevision: 3, maskOpacity: 0.21 }, { expectedRevision: 3, maskOpacity: Number.NaN },
      { expectedRevision: 3, maskOpacity: 0.65 }, { expectedRevision: 3, mode: "video" },
      { expectedRevision: "3", mode: "none" }, { mode: "none" }
    ]) expect(() => f.api.set(change)).toThrow();
    for (const revision of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "3", "D:\\private-photo\\selected.png", { expectedRevision: 3 }]) {
      expect(() => f.api.import(revision)).toThrow();
      expect(() => f.api.remove(revision)).toThrow();
      expect(() => f.api.reset(revision)).toThrow();
    }
    expect(f.invoke).not.toHaveBeenCalled();
  });

  it("rejects unsafe host image locations and malformed settings instead of exposing them", async () => {
    const f = loadPreload();
    for (const malformed of [
      { ...settings, sourcePath: "D:\\private-photo\\selected.png" }, { ...settings, revision: 0 },
      { ...settings, maskOpacity: 0.21 }, { ...settings, customImage: null },
      { ...settings, customImage: { ...image, url: "file:///D:/private-photo/selected.png" } },
      { ...settings, customImage: { ...image, url: `joko-wallpaper://image/${"b".repeat(64)}.webp` } },
      { ...settings, customImage: { ...image, path: "D:\\private-photo\\selected.png" } },
      { ...settings, customImage: { ...image, width: 3841 } }
    ]) {
      f.invoke.mockResolvedValue(malformed);
      await expect(f.api.get()).rejects.toThrow();
    }
    f.invoke.mockResolvedValue({ ...settings, privateSource: true });
    await expect(f.api.set({ expectedRevision: 3, mode: "none" })).rejects.toThrow();
    await expect(f.api.remove(3)).rejects.toThrow();
    await expect(f.api.reset(3)).rejects.toThrow();
  });

  it("separates exact native cancellation from a strictly validated successful import result", async () => {
    const f = loadPreload();
    await expect(f.api.import(3)).resolves.toEqual({ cancelled: true });
    f.invoke.mockResolvedValue({ cancelled: false, settings });
    const imported = await f.api.import(3);
    expect(imported).toEqual({ cancelled: false, settings }); expect(Object.isFrozen(imported)).toBe(true);
    for (const malformed of [
      { cancelled: true, settings }, { cancelled: true, path: "D:\\private-photo\\selected.png" },
      { cancelled: "false", settings }, { cancelled: false },
      { cancelled: false, settings: { ...settings, sourcePath: "D:\\private-photo\\selected.png" } }
    ]) {
      f.invoke.mockResolvedValue(malformed);
      await expect(f.api.import(3)).rejects.toThrow();
    }
  });

  it("delivers only safe confirmed broadcasts and unsubscribes the exact wrapped listener", () => {
    const f = loadPreload(), listener = vi.fn();
    const unsubscribe = f.api.onChanged(listener);
    const wrapped = [...f.listeners.get(DESKTOP_CHANNELS.wallpaperChanged)!][0]!;
    f.emit(settings);
    expect(listener).toHaveBeenCalledExactlyOnceWith(settings);
    const delivered = listener.mock.calls[0]![0] as DesktopWallpaperSettings;
    expect(delivered).not.toBe(settings); expect(Object.isFrozen(delivered.customImage)).toBe(true);
    f.emit({ ...settings, revision: 0 }); f.emit({ ...settings, sourcePath: "D:\\private-photo\\selected.png" });
    f.emit({ ...settings, customImage: { ...image, url: "https://remote.example/image.webp" } });
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    expect(f.removeListener).toHaveBeenCalledExactlyOnceWith(DESKTOP_CHANNELS.wallpaperChanged, wrapped);
    f.emit(settings);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("keeps independent observers alive when another observer throws or unsubscribes", () => {
    const f = loadPreload(), broken = vi.fn(() => { throw new Error("renderer listener failed"); }), healthy = vi.fn();
    const unsubscribeBroken = f.api.onChanged(broken), unsubscribeHealthy = f.api.onChanged(healthy);
    expect(() => f.emit(settings)).not.toThrow();
    expect(healthy).toHaveBeenCalledTimes(1);
    unsubscribeBroken(); f.emit(settings);
    expect(broken).toHaveBeenCalledTimes(1); expect(healthy).toHaveBeenCalledTimes(2);
    unsubscribeHealthy(); f.emit(settings);
    expect(healthy).toHaveBeenCalledTimes(2);
  });

  it("rejects invalid observer registration before creating an IPC subscription", () => {
    const f = loadPreload();
    for (const listener of [null, undefined, "listener", {}]) expect(() => f.api.onChanged(listener)).toThrow(/must be a function/u);
    expect(f.listeners.has(DESKTOP_CHANNELS.wallpaperChanged)).toBe(false);
    expect(f.invoke).not.toHaveBeenCalled();
  });
});
