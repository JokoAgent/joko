import type { IpcMain, IpcMainInvokeEvent } from "electron";
import { describe, expect, it, vi } from "vitest";
import { DESKTOP_CHANNELS, type DesktopWallpaperSettings, type DesktopWallpaperSettingsChange } from "../src/channels.js";
import { registerDesktopWallpaperIpc, type DesktopWallpaperIpcOptions } from "../src/wallpaper-ipc.js";

type StorePort = ReturnType<DesktopWallpaperIpcOptions["store"]>;
type Handler = (event: IpcMainInvokeEvent, ...parameters: unknown[]) => unknown;
const FAILURE = "Wallpaper settings could not be changed. Read the current state and try again.";
const CHANNELS = [DESKTOP_CHANNELS.wallpaperGet, DESKTOP_CHANNELS.wallpaperSet, DESKTOP_CHANNELS.wallpaperImport,
  DESKTOP_CHANNELS.wallpaperRemove, DESKTOP_CHANNELS.wallpaperReset] as const;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

function fixture() {
  const event = {} as IpcMainInvokeEvent;
  const handlers = new Map<string, Handler>();
  let current = true;
  let value: DesktopWallpaperSettings = { version: 1, revision: 1, mode: "none", maskOpacity: 0.2, customImage: null };
  const assertCurrent = vi.fn(() => { if (!current) throw new Error("private Document authority was retired"); });
  const captureOwner = vi.fn<DesktopWallpaperIpcOptions["captureOwner"]>(() => assertCurrent);
  const pickFile = vi.fn<DesktopWallpaperIpcOptions["pickFile"]>(async () => undefined);
  const commit = (revision: number, patch: Partial<DesktopWallpaperSettings>, assert?: () => void): DesktopWallpaperSettings => {
    assert?.();
    if (revision !== value.revision) throw new Error("private persisted revision changed");
    value = { ...value, ...patch, revision: value.revision + 1 };
    return value;
  };
  const get = vi.fn<StorePort["get"]>(() => value);
  const set = vi.fn<StorePort["set"]>(async (change: DesktopWallpaperSettingsChange, assert) => {
    const { expectedRevision, ...patch } = change;
    return commit(expectedRevision, patch, assert);
  });
  const importImage = vi.fn<StorePort["importFromSelectedFile"]>(async (_path, revision, assert) => commit(revision, {
    mode: "custom", customImage: { id: "a".repeat(64), url: `joko-wallpaper://image/${"a".repeat(64)}.webp`, width: 800, height: 600 }
  }, assert));
  const remove = vi.fn<StorePort["remove"]>(async (revision, assert) => commit(revision, { mode: "none", customImage: null }, assert));
  const reset = vi.fn<StorePort["reset"]>(async (revision, assert) => commit(revision, { mode: "none", maskOpacity: 0.2 }, assert));
  const store: StorePort = { get, set, importFromSelectedFile: importImage, remove, reset };
  const handle: IpcMain["handle"] = (channel, listener) => { handlers.set(channel, listener); };
  registerDesktopWallpaperIpc({ ipc: { handle }, store: () => store, captureOwner, pickFile });
  const invoke = async (channel: string, ...parameters: unknown[]): Promise<unknown> => {
    const handler = handlers.get(channel);
    if (!handler) throw new Error("The requested handler was not registered.");
    return handler(event, ...parameters);
  };
  return { handlers, invoke, event, get, set, importImage, remove, reset, pickFile, captureOwner, assertCurrent,
    retire: () => { current = false; }, value: () => value,
    advanceRevision: () => { value = { ...value, revision: value.revision + 1 }; } };
}

describe("Desktop wallpaper IPC", () => {
  it("registers only the five request channels and returns the owning Store projections", async () => {
    const f = fixture();
    expect([...f.handlers.keys()].sort()).toEqual([...CHANNELS].sort());
    expect(await f.invoke(DESKTOP_CHANNELS.wallpaperGet)).toEqual(f.value());
    expect(await f.invoke(DESKTOP_CHANNELS.wallpaperSet, { expectedRevision: 1, maskOpacity: 0.3 })).toEqual(f.value());
    expect(f.set).toHaveBeenCalledWith({ expectedRevision: 1, maskOpacity: 0.3 }, f.assertCurrent);
    expect(await f.invoke(DESKTOP_CHANNELS.wallpaperRemove, 2)).toEqual(f.value());
    expect(f.remove).toHaveBeenCalledWith(2, f.assertCurrent);
    expect(await f.invoke(DESKTOP_CHANNELS.wallpaperReset, 3)).toEqual(f.value());
    expect(f.reset).toHaveBeenCalledWith(3, f.assertCurrent);
    expect(f.captureOwner.mock.calls.every(([event]) => event === f.event)).toBe(true);
    expect(f.captureOwner).toHaveBeenCalledTimes(4);
  });

  it("treats native picker cancellation as a confirmed no-effect result", async () => {
    const f = fixture(), before = f.value();
    expect(await f.invoke(DESKTOP_CHANNELS.wallpaperImport, 1)).toEqual({ cancelled: true });
    expect(f.pickFile).toHaveBeenCalledWith(f.event);
    expect(f.importImage).not.toHaveBeenCalled();
    expect(f.value()).toBe(before);
  });

  it("passes the selected private path only to the Store and returns its safe projection", async () => {
    const f = fixture(), path = "D:\\private-photo\\selected.png";
    f.pickFile.mockResolvedValue(path);
    const result = await f.invoke(DESKTOP_CHANNELS.wallpaperImport, 1);
    expect(f.importImage).toHaveBeenCalledWith(path, 1, f.assertCurrent);
    expect(result).toEqual({ cancelled: false, settings: f.value() });
    expect(JSON.stringify(result)).not.toContain(path);
    expect(f.captureOwner).toHaveBeenCalledTimes(1);
  });

  it("keeps native import single-flight across request owners and releases cancellation", async () => {
    const first = fixture(), second = fixture(), chosen = deferred<string | undefined>();
    first.pickFile.mockReturnValue(chosen.promise);
    const pending = first.invoke(DESKTOP_CHANNELS.wallpaperImport, 1);
    await expect(second.invoke(DESKTOP_CHANNELS.wallpaperImport, 1)).rejects.toThrow(FAILURE);
    expect(first.pickFile).toHaveBeenCalledTimes(1);
    expect(second.pickFile).not.toHaveBeenCalled();
    chosen.resolve(undefined);
    await expect(pending).resolves.toEqual({ cancelled: true });
    await expect(second.invoke(DESKTOP_CHANNELS.wallpaperImport, 1)).resolves.toEqual({ cancelled: true });
    expect(second.pickFile).toHaveBeenCalledTimes(1);
  });

  it("rejects stale import revisions before opening a native dialog", async () => {
    const f = fixture();
    f.advanceRevision();
    await expect(f.invoke(DESKTOP_CHANNELS.wallpaperImport, 1)).rejects.toThrow(FAILURE);
    expect(f.pickFile).not.toHaveBeenCalled();
    expect(f.importImage).not.toHaveBeenCalled();
  });

  it("does not import when the Document retires while its native dialog is open", async () => {
    const f = fixture(), chosen = deferred<string | undefined>();
    f.pickFile.mockReturnValue(chosen.promise);
    const pending = f.invoke(DESKTOP_CHANNELS.wallpaperImport, 1);
    f.retire(); chosen.resolve("D:\\private-photo\\selected.png");
    await expect(pending).rejects.toThrow(FAILURE);
    expect(f.importImage).not.toHaveBeenCalled();
    expect(f.value().revision).toBe(1);
  });

  it("does not import when a different window changes the revision during its native dialog", async () => {
    const f = fixture(), chosen = deferred<string | undefined>();
    f.pickFile.mockReturnValue(chosen.promise);
    const pending = f.invoke(DESKTOP_CHANNELS.wallpaperImport, 1);
    await f.invoke(DESKTOP_CHANNELS.wallpaperSet, { expectedRevision: 1, maskOpacity: 0.4 });
    chosen.resolve("D:\\private-photo\\selected.png");
    await expect(pending).rejects.toThrow(FAILURE);
    expect(f.importImage).not.toHaveBeenCalled();
    expect(f.value()).toMatchObject({ revision: 2, maskOpacity: 0.4, customImage: null });
  });

  it("rejects renderer paths, unknown fields, extra arguments and invalid revisions without effects", async () => {
    const f = fixture();
    const invalid: readonly (readonly [string, ...unknown[]])[] = [
      [DESKTOP_CHANNELS.wallpaperGet, "D:\\private-photo\\selected.png"],
      [DESKTOP_CHANNELS.wallpaperSet, { expectedRevision: 1, mode: "none", path: "D:\\private-photo\\selected.png" }],
      [DESKTOP_CHANNELS.wallpaperSet, { expectedRevision: 1, customImage: null }],
      [DESKTOP_CHANNELS.wallpaperSet, { expectedRevision: 1, maskOpacity: 0.21 }],
      [DESKTOP_CHANNELS.wallpaperSet, { expectedRevision: 1, mode: "video" }],
      [DESKTOP_CHANNELS.wallpaperSet],
      [DESKTOP_CHANNELS.wallpaperImport, "D:\\private-photo\\selected.png"],
      [DESKTOP_CHANNELS.wallpaperImport, 1, "D:\\private-photo\\selected.png"],
      [DESKTOP_CHANNELS.wallpaperRemove, { expectedRevision: 1 }],
      [DESKTOP_CHANNELS.wallpaperReset, 0],
      [DESKTOP_CHANNELS.wallpaperReset, 1.5],
      [DESKTOP_CHANNELS.wallpaperReset, Number.MAX_SAFE_INTEGER + 1]
    ];
    for (const [channel, ...parameters] of invalid) await expect(f.invoke(channel, ...parameters)).rejects.toThrow(FAILURE);
    expect(f.set).not.toHaveBeenCalled(); expect(f.remove).not.toHaveBeenCalled(); expect(f.reset).not.toHaveBeenCalled();
    expect(f.pickFile).not.toHaveBeenCalled(); expect(f.importImage).not.toHaveBeenCalled();
    expect(f.value().revision).toBe(1);
  });

  it("rejects every request from a retired Document before reading or performing an effect", async () => {
    const f = fixture(); f.retire();
    for (const [channel, ...parameters] of [
      [DESKTOP_CHANNELS.wallpaperGet], [DESKTOP_CHANNELS.wallpaperSet, { expectedRevision: 1, mode: "none" }],
      [DESKTOP_CHANNELS.wallpaperRemove, 1], [DESKTOP_CHANNELS.wallpaperReset, 1], [DESKTOP_CHANNELS.wallpaperImport, 1]
    ] as const) await expect(f.invoke(channel, ...parameters)).rejects.toThrow(FAILURE);
    expect(f.get).not.toHaveBeenCalled(); expect(f.set).not.toHaveBeenCalled(); expect(f.remove).not.toHaveBeenCalled();
    expect(f.reset).not.toHaveBeenCalled(); expect(f.pickFile).not.toHaveBeenCalled();
  });

  it("passes the original Owner guard through async Store work and suppresses a retired response", async () => {
    const f = fixture(), finished = deferred<DesktopWallpaperSettings>();
    f.set.mockImplementation(async (_change, assert) => {
      assert?.();
      const result = await finished.promise;
      assert?.();
      return result;
    });
    const pending = f.invoke(DESKTOP_CHANNELS.wallpaperSet, { expectedRevision: 1, maskOpacity: 0.3 });
    f.retire(); finished.resolve({ ...f.value(), revision: 2, maskOpacity: 0.3 });
    await expect(pending).rejects.toThrow(FAILURE);
    expect(f.value().revision).toBe(1);
  });

  it("does not adopt a success response after the effect committed and its Document retired", async () => {
    const f = fixture();
    f.set.mockImplementation(async (change, assert) => {
      assert?.(); f.advanceRevision(); f.retire();
      return { ...f.value(), maskOpacity: change.maskOpacity ?? f.value().maskOpacity };
    });
    await expect(f.invoke(DESKTOP_CHANNELS.wallpaperSet, { expectedRevision: 1, maskOpacity: 0.3 })).rejects.toThrow(FAILURE);
    expect(f.value().revision).toBe(2);
  });

  it("sanitizes capture, native picker and async Store failures and releases a failed import", async () => {
    const f = fixture(), raw = "Sharp failed to decode D:\\private-photo\\selected.png: EACCES private stack";
    f.captureOwner.mockImplementationOnce(() => { throw new Error(raw); });
    await expect(f.invoke(DESKTOP_CHANNELS.wallpaperGet)).rejects.toThrow(FAILURE);
    f.pickFile.mockRejectedValueOnce(new Error(raw));
    await expect(f.invoke(DESKTOP_CHANNELS.wallpaperImport, 1)).rejects.toThrow(FAILURE);
    f.pickFile.mockResolvedValue("D:\\private-photo\\selected.png");
    f.importImage.mockRejectedValueOnce(new Error(raw));
    await expect(f.invoke(DESKTOP_CHANNELS.wallpaperImport, 1)).rejects.toThrow(FAILURE);
    const recovered = await f.invoke(DESKTOP_CHANNELS.wallpaperImport, 1);
    expect(recovered).toEqual({ cancelled: false, settings: f.value() });
    expect(f.importImage).toHaveBeenCalledTimes(2);
  });
});
