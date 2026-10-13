import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { RemoteDesktopViewerDisplayHandle } from "@joko/device-peer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DesktopRemoteDesktopMacViewerDisplayRuntime } from "../src/remote-desktop-macos-viewer-display.js";

vi.mock("electron", () => ({ app: {}, screen: {} }));
let adapter: typeof import("../src/remote-desktop-macos-viewer-display.js");
const cleanup: RemoteDesktopViewerDisplayHandle[] = [];
const original = { id: 12, label: "Physical display", size: { width: 1920, height: 1080 } };
class MirrorChild extends EventEmitter {
  readonly stdin = new PassThrough(); readonly stdout = new PassThrough(); readonly stderr = new PassThrough();
  readonly kill = vi.fn((_signal?: NodeJS.Signals) => true);
}
function fixture() {
  const child = new MirrorChild(), signal = new AbortController();
  const state = { source: Buffer.from("owned Objective-C source"), displays: [{ ...original, size: { ...original.size } }] };
  const runtime = {
    platform: "darwin", packaged: false as boolean, arch: "arm64", appPath: "/app", userData: "/private/profile",
    readFile: vi.fn(async (_path: string) => state.source), exists: vi.fn(async (_path: string) => false),
    mkdir: vi.fn(async (_path: string) => undefined), rename: vi.fn(async (_from: string, _to: string) => undefined),
    remove: vi.fn(async (_path: string) => undefined),
    exec: vi.fn(async (file: string, _args: readonly string[], _timeout: number): Promise<string> => file === "clang" ? "" : '{"available":true}\n'),
    spawn: vi.fn((_file: string) => child as unknown as ChildProcessWithoutNullStreams),
    displays: vi.fn(() => state.displays), delay: vi.fn((milliseconds: number) => new Promise<void>(resolve => setTimeout(resolve, milliseconds)))
  } satisfies DesktopRemoteDesktopMacViewerDisplayRuntime;
  return { child, signal, state, runtime };
}
async function create(f = fixture(), current: () => boolean = () => true, onFailure = vi.fn()) {
  const handle = await adapter.createDesktopRemoteDesktopMacViewerDisplay("12", current, onFailure, f.signal.signal, f.runtime);
  cleanup.push(handle); return { ...f, handle, onFailure };
}
function receipt(f: Awaited<ReturnType<typeof create>>, width = 800, height = 600, logicalWidth = width, logicalHeight = height) {
  f.state.displays = [{ ...original, size: { width: logicalWidth, height: logicalHeight } },
    { id: 67, label: "", size: { width: logicalWidth, height: logicalHeight } }];
  f.child.stdout.write(`${JSON.stringify({ id: 67, width, height, logicalWidth, logicalHeight })}\n`);
}
async function restored(f: Awaited<ReturnType<typeof create>>) {
  f.state.displays = [{ ...original, size: { ...original.size } }]; f.child.emit("exit", 0, null);
  await expect(f.handle.restore(() => true)).resolves.toEqual({ id: "12", name: original.label, ...original.size });
}
beforeEach(async () => { vi.resetModules(); vi.useFakeTimers(); adapter = await import("../src/remote-desktop-macos-viewer-display.js"); });
afterEach(() => { for (const handle of cleanup.splice(0)) handle.dispose(); vi.clearAllTimers(); vi.useRealTimers(); });

describe("development macOS temporary viewer mirror", () => {
  it.each([["darwin", true], ["win32", false], ["linux", false]])("does not read, compile or spawn outside the exact development gate (%s, %s)", async (platform, packaged) => {
    const f = fixture(); f.runtime.platform = platform; f.runtime.packaged = packaged;
    await expect(adapter.supportsDesktopRemoteDesktopMacViewerDisplay(f.signal.signal, f.runtime)).resolves.toBe(false);
    await expect(adapter.createDesktopRemoteDesktopMacViewerDisplay("12", () => true, vi.fn(), f.signal.signal, f.runtime)).rejects.toThrow("REMOTE_DESKTOP_VIEWER_DISPLAY_UNAVAILABLE");
    expect(f.runtime.readFile).not.toHaveBeenCalled(); expect(f.runtime.exec).not.toHaveBeenCalled(); expect(f.runtime.spawn).not.toHaveBeenCalled();
  });

  it("caches only the same source and architecture after bounded compilation and a successful SPI probe", async () => {
    const f = fixture();
    await expect(adapter.supportsDesktopRemoteDesktopMacViewerDisplay(undefined, f.runtime)).resolves.toBe(true);
    expect(f.runtime.exec.mock.calls[0]).toEqual(["clang", ["-fobjc-arc", "-framework", "Foundation", "-framework", "CoreGraphics",
      expect.stringMatching(/native[\\/]remote-desktop[\\/]macos-viewer-display\.m$/u), "-o", expect.stringMatching(/joko-viewer-display\.[0-9]+\.tmp$/u)], 60_000]);
    expect(f.runtime.exec.mock.calls[1]).toEqual([expect.stringMatching(/native[\\/][a-f0-9]{64}[\\/]joko-viewer-display$/u), ["--probe"], 5_000]);
    await expect(adapter.supportsDesktopRemoteDesktopMacViewerDisplay(undefined, f.runtime)).resolves.toBe(true);
    expect(f.runtime.exec).toHaveBeenCalledTimes(2);
    f.state.source = Buffer.from("a new owned source"); await adapter.supportsDesktopRemoteDesktopMacViewerDisplay(undefined, f.runtime);
    f.runtime.arch = "x64"; await adapter.supportsDesktopRemoteDesktopMacViewerDisplay(undefined, f.runtime);
    expect(new Set(f.runtime.exec.mock.calls.filter(([file]) => file !== "clang").map(([file]) => file)).size).toBe(3);
    expect(f.runtime.spawn).not.toHaveBeenCalled();
  });

  it("does not advertise a failed probe and retries the original build after a compile failure", async () => {
    const f = fixture(); f.runtime.exec.mockRejectedValueOnce(new Error("compiler unavailable"));
    await expect(adapter.supportsDesktopRemoteDesktopMacViewerDisplay(undefined, f.runtime)).resolves.toBe(false);
    expect(f.runtime.remove).toHaveBeenCalledOnce();
    await expect(adapter.supportsDesktopRemoteDesktopMacViewerDisplay(undefined, f.runtime)).resolves.toBe(true);
    const failed = fixture(); failed.runtime.exists.mockResolvedValue(true); failed.runtime.exec.mockResolvedValue('{"available":false}\n');
    await expect(adapter.supportsDesktopRemoteDesktopMacViewerDisplay(undefined, failed.runtime)).resolves.toBe(false);
    expect(failed.runtime.exec).toHaveBeenCalledExactlyOnceWith(expect.any(String), ["--probe"], 5_000);
    expect(failed.runtime.spawn).not.toHaveBeenCalled();
  });

  it("retires one aborted build observer without cancelling the shared source cache", async () => {
    const f = fixture(); let finishCompile: (() => void) | undefined;
    f.runtime.exec.mockImplementation(async file => file === "clang" ? new Promise<string>(resolve => { finishCompile = () => resolve(""); }) : '{"available":true}\n');
    const aborted = adapter.supportsDesktopRemoteDesktopMacViewerDisplay(f.signal.signal, f.runtime);
    const rejection = expect(aborted).rejects.toThrow("retired build observation");
    await vi.advanceTimersByTimeAsync(0); f.signal.abort(new Error("retired build observation")); await rejection;
    const current = adapter.supportsDesktopRemoteDesktopMacViewerDisplay(undefined, f.runtime);
    await vi.advanceTimersByTimeAsync(0); finishCompile!(); await expect(current).resolves.toBe(true);
    expect(f.runtime.exec).toHaveBeenCalledTimes(2);
  });

  it("does not spawn a late owner or an absent source after asynchronous preparation", async () => {
    const f = fixture(); let current = true;
    f.runtime.exec.mockImplementation(async file => { if (file !== "clang") current = false; return file === "clang" ? "" : '{"available":true}\n'; });
    await expect(adapter.createDesktopRemoteDesktopMacViewerDisplay("12", () => current, vi.fn(), undefined, f.runtime)).rejects.toThrow("REMOTE_DESKTOP_LEASE_EXPIRED");
    expect(f.runtime.spawn).not.toHaveBeenCalled();
    const missing = fixture(); missing.state.displays = [];
    await expect(adapter.createDesktopRemoteDesktopMacViewerDisplay("12", () => true, vi.fn(), undefined, missing.runtime)).rejects.toThrow("REMOTE_DESKTOP_VIEWER_DISPLAY_UNAVAILABLE");
    expect(missing.runtime.spawn).not.toHaveBeenCalled();
  });

  it("owns one helper and source, bounds requests, and adopts adjusted logical geometry only from Electron", async () => {
    const f = await create(); expect(f.handle.displayId).toBeUndefined();
    for (const [width, height] of [[319, 600], [2561, 600], [800, 319], [800, 2561], [800.5, 600]]) {
      await expect(f.handle.resize(width!, height!, () => true)).rejects.toThrow("REMOTE_DESKTOP_VIEWER_DISPLAY_UNAVAILABLE");
    }
    expect(f.child.stdin.readableLength).toBe(0);
    const resizing = f.handle.resize(800, 600, () => true);
    expect(String(f.child.stdin.read())).toBe('{"sourceDisplayId":"12","width":800,"height":600}\n');
    await expect(f.handle.resize(800, 600, () => true)).rejects.toThrow("REMOTE_DESKTOP_DISPLAY_BUSY");
    f.child.stdout.write('{"id":67,"width":800,"height":600,"logicalWidth":1000,"logicalHeight":750}\n');
    await vi.advanceTimersByTimeAsync(0);
    let adopted = false; void resizing.then(() => { adopted = true; }); expect(adopted).toBe(false);
    f.state.displays = [{ ...original, size: { width: 1000, height: 750 } }, { id: 67, label: "", size: { width: 1000, height: 750 } }];
    await vi.advanceTimersByTimeAsync(50);
    await expect(resizing).resolves.toEqual({ id: "67", name: "Joko Remote Desktop", width: 1000, height: 750 });
    const resized = f.handle.resize(600, 800, () => true); receipt(f, 600, 800, 750, 1000);
    await expect(resized).resolves.toMatchObject({ id: "67", width: 750, height: 1000 }); expect(f.runtime.spawn).toHaveBeenCalledOnce();
    await expect(adapter.createDesktopRemoteDesktopMacViewerDisplay("12", () => true, vi.fn(), undefined, f.runtime)).rejects.toThrow("REMOTE_DESKTOP_DISPLAY_BUSY");
    f.handle.dispose(); await restored(f);
  });

  it.each([
    { logicalWidth: 1000, logicalHeight: 752 }, { logicalWidth: 4097, logicalHeight: 600 },
    { logicalWidth: 800.5, logicalHeight: 600 }, { logicalWidth: 800, logicalHeight: 0 }, { width: 801 }, { id: 12 }
  ])("rejects an invalid receipt and retains release responsibility (%j)", async change => {
    const f = await create(); const resizing = f.handle.resize(800, 600, () => true);
    const rejection = expect(resizing).rejects.toThrow("REMOTE_DESKTOP_VIEWER_DISPLAY_UNAVAILABLE");
    f.child.stdout.write(`${JSON.stringify({ id: 67, width: 800, height: 600, logicalWidth: 800, logicalHeight: 600, ...change })}\n`);
    await rejection; expect(f.onFailure).toHaveBeenCalledOnce();
    await expect(adapter.createDesktopRemoteDesktopMacViewerDisplay("12", () => true, vi.fn(), undefined, f.runtime)).rejects.toThrow("REMOTE_DESKTOP_DISPLAY_BUSY");
    if (f.handle.displayId !== undefined) await restored(f);
  });

  it.each(["oversize", "timeout"])("bounds helper output and waiting, preserving unknown cleanup (%s)", async kind => {
    const f = await create(); const resizing = f.handle.resize(800, 600, () => true);
    const rejection = expect(resizing).rejects.toThrow("REMOTE_DESKTOP_VIEWER_DISPLAY_UNAVAILABLE");
    if (kind === "oversize") f.child.stdout.write(Buffer.alloc(4097, 32)); else await vi.advanceTimersByTimeAsync(8_000);
    await rejection; await vi.advanceTimersByTimeAsync(1_500); expect(f.child.kill).toHaveBeenCalledExactlyOnceWith("SIGTERM");
    const restoring = f.handle.restore(() => true), failed = expect(restoring).rejects.toThrow("REMOTE_DESKTOP_VIEWER_DISPLAY_UNAVAILABLE");
    await vi.advanceTimersByTimeAsync(5_000); await failed;
    await expect(adapter.createDesktopRemoteDesktopMacViewerDisplay("12", () => true, vi.fn(), undefined, f.runtime)).rejects.toThrow("REMOTE_DESKTOP_DISPLAY_BUSY");
    await restored(f);
  });

  it("does not adopt a late receipt or geometry after current owner retirement", async () => {
    const f = await create(); let current = true;
    const resizing = f.handle.resize(800, 600, () => current), failed = expect(resizing).rejects.toThrow("REMOTE_DESKTOP_LEASE_EXPIRED");
    current = false; receipt(f); await failed; expect(f.handle.displayId).toBe("67"); expect(f.onFailure).toHaveBeenCalledOnce(); await restored(f);
  });

  it("rejects an unobserved Electron geometry after its bounded observation window", async () => {
    const f = await create(); const resizing = f.handle.resize(800, 600, () => true);
    const failed = expect(resizing).rejects.toThrow("REMOTE_DESKTOP_VIEWER_DISPLAY_UNAVAILABLE");
    f.child.stdout.write('{"id":67,"width":800,"height":600,"logicalWidth":1000,"logicalHeight":750}\n');
    f.state.displays.push({ id: 67, label: "wrong geometry", size: { width: 800, height: 600 } });
    await vi.advanceTimersByTimeAsync(2_000); await failed; expect(f.onFailure).toHaveBeenCalledOnce(); expect(f.handle.displayId).toBe("67");
    await restored(f);
  });

  it("waits for actual exit, exact mirror disappearance and the first physical geometry despite an aborted request", async () => {
    const f = await create(); const resizing = f.handle.resize(800, 600, () => true); receipt(f); await resizing;
    f.signal.abort(new Error("request retired")); let released = false;
    const restoring = f.handle.restore(() => true).then(value => { released = true; return value; });
    f.state.displays = [{ ...original, size: { ...original.size } }];
    await vi.advanceTimersByTimeAsync(1_500); expect(released).toBe(false); expect(f.child.kill).toHaveBeenCalledExactlyOnceWith("SIGTERM");
    f.child.emit("exit", 0, null); f.state.displays.push({ id: 67, label: "mirror", size: { width: 800, height: 600 } });
    await vi.advanceTimersByTimeAsync(50); expect(released).toBe(false);
    f.state.displays = [{ ...original, size: { width: 800, height: 600 } }]; await vi.advanceTimersByTimeAsync(50); expect(released).toBe(false);
    f.state.displays = [{ ...original, size: { ...original.size } }]; await vi.advanceTimersByTimeAsync(50);
    await expect(restoring).resolves.toEqual({ id: "12", name: original.label, ...original.size }); expect(f.handle.displayId).toBeUndefined();
    await create(fixture());
  });

  it("keeps failed cleanup owned for a later exact restore, and accepts physical unplug only after its mirror is gone", async () => {
    const f = await create(); const resizing = f.handle.resize(800, 600, () => true); receipt(f); await resizing;
    const restoring = f.handle.restore(() => true), failed = expect(restoring).rejects.toThrow("REMOTE_DESKTOP_VIEWER_DISPLAY_UNAVAILABLE");
    f.child.emit("exit", 0, null); await vi.advanceTimersByTimeAsync(5_000); await failed; expect(f.handle.displayId).toBe("67");
    await expect(adapter.createDesktopRemoteDesktopMacViewerDisplay("12", () => true, vi.fn(), undefined, f.runtime)).rejects.toThrow("REMOTE_DESKTOP_DISPLAY_BUSY");
    f.state.displays = []; await expect(f.handle.restore(() => true)).resolves.toEqual({ id: "12", name: original.label, ...original.size });
  });

  it("retires streaming failures once and never publishes restore through a retired observer", async () => {
    const f = await create(); const resizing = f.handle.resize(800, 600, () => true); receipt(f); await resizing;
    f.child.stdin.emit("error", new Error("pipe failed")); f.child.emit("error", new Error("helper failed")); expect(f.onFailure).toHaveBeenCalledOnce();
    let current = true; const restoring = f.handle.restore(() => current), failed = expect(restoring).rejects.toThrow("REMOTE_DESKTOP_LEASE_EXPIRED");
    current = false; await vi.advanceTimersByTimeAsync(50); await failed;
    await expect(adapter.createDesktopRemoteDesktopMacViewerDisplay("12", () => true, vi.fn(), undefined, f.runtime)).rejects.toThrow("REMOTE_DESKTOP_DISPLAY_BUSY");
    await restored(f);
  });
});
