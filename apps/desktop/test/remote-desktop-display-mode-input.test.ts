import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RemoteDesktopDisplay } from "@joko/device-peer";

vi.mock("electron", () => ({ app: {}, screen: {} }));
import {
  restoreDesktopRemoteDesktopDisplayMode,
  setDesktopRemoteDesktopDisplayMode,
  type DesktopRemoteDesktopDisplayModeRuntime
} from "../src/remote-desktop-input.js";

const signal = (): AbortSignal => new AbortController().signal;
const display = (width = 1024, height = 768): RemoteDesktopDisplay => ({ id: "1", name: "Display", width, height });
class ModeChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly kill = vi.fn((_signal?: NodeJS.Signals) => true);
  receipt(value = "ready\n", code = 0): void {
    this.stdout.write(value); this.emit("close", code, null);
  }
}
function fixture(platform: NodeJS.Platform = "darwin") {
  const child = new ModeChild();
  const runtime = {
    platform,
    resolveBinary: vi.fn(async () => "trusted-input-helper"),
    readModes: vi.fn(async () => [
      { id: "11", width: 1600, height: 900, current: true, native: true },
      { id: "12", width: 1024, height: 768, current: false, native: false }
    ]),
    spawn: vi.fn(() => child), display: vi.fn((): RemoteDesktopDisplay | undefined => display())
  } satisfies DesktopRemoteDesktopDisplayModeRuntime;
  return { child, runtime };
}
afterEach(() => { vi.useRealTimers(); });

describe("physical display mode input adapter", () => {
  it.each(["win32", "linux"] as const)("does not prepare mode effects on %s", async (platform) => {
    const { runtime } = fixture(platform);
    await expect(setDesktopRemoteDesktopDisplayMode("1", "12", vi.fn(), signal(), undefined, runtime))
      .rejects.toThrowError("REMOTE_DESKTOP_DISPLAY_MODES_UNAVAILABLE");
    expect(runtime.resolveBinary).not.toHaveBeenCalled(); expect(runtime.spawn).not.toHaveBeenCalled();
  });

  it("rejects a missing selected mode before retiring authority or dispatching", async () => {
    const { runtime } = fixture(); const before = vi.fn();
    await expect(setDesktopRemoteDesktopDisplayMode("1", "99", before, signal(), undefined, runtime))
      .rejects.toThrowError("REMOTE_DESKTOP_DISPLAY_MODE_MISSING");
    expect(before).not.toHaveBeenCalled(); expect(runtime.spawn).not.toHaveBeenCalled();
  });

  it("awaits exact input drain and actual close, then returns only observed target geometry", async () => {
    vi.useFakeTimers(); const { child, runtime } = fixture();
    let releaseInput!: () => void;
    const before = vi.fn(() => new Promise<void>((resolve) => { releaseInput = resolve; }));
    runtime.display.mockReturnValue(display(1600, 900));
    let settled = false;
    const writing = setDesktopRemoteDesktopDisplayMode("1", "12", before, signal(), { width: 1024, height: 768 }, runtime)
      .then((value) => { settled = true; return value; });
    await vi.advanceTimersByTimeAsync(0); expect(before).toHaveBeenCalledOnce(); expect(runtime.spawn).not.toHaveBeenCalled();
    releaseInput(); await vi.advanceTimersByTimeAsync(0);
    expect(runtime.spawn).toHaveBeenCalledExactlyOnceWith("trusted-input-helper", ["--display-mode", "1", "12"]);
    child.stdout.write("ready\n"); await vi.advanceTimersByTimeAsync(0); expect(settled).toBe(false);
    child.emit("close", 0, null); await vi.advanceTimersByTimeAsync(0); expect(settled).toBe(false);
    runtime.display.mockReturnValue(display()); await vi.advanceTimersByTimeAsync(50);
    await expect(writing).resolves.toEqual(display());
  });

  it("rechecks cancellation after asynchronous input drain without starting a native effect", async () => {
    const { runtime } = fixture(); const abort = new AbortController();
    await expect(setDesktopRemoteDesktopDisplayMode("1", "12", async () => {
      abort.abort(new Error("REMOTE_DESKTOP_LEASE_EXPIRED"));
    }, abort.signal, undefined, runtime)).rejects.toThrowError("REMOTE_DESKTOP_LEASE_EXPIRED");
    expect(runtime.spawn).not.toHaveBeenCalled();
  });

  it("restores an original ID absent from the deduplicated UI catalog using native full validation", async () => {
    const { child, runtime } = fixture(); runtime.display.mockReturnValue(display(1600, 900));
    const restoring = restoreDesktopRemoteDesktopDisplayMode("1", "99", () => true,
      { width: 1600, height: 900 }, signal(), runtime);
    await vi.waitFor(() => expect(runtime.spawn).toHaveBeenCalledOnce()); child.receipt();
    await expect(restoring).resolves.toEqual(display(1600, 900));
    expect(runtime.readModes).not.toHaveBeenCalled();
    expect(runtime.spawn).toHaveBeenCalledWith("trusted-input-helper", ["--restore-display-mode", "1", "99"]);
  });

  it("checks captured restoration authority again after helper preparation", async () => {
    const { runtime } = fixture(); let current = true;
    runtime.resolveBinary.mockImplementationOnce(async () => { current = false; return "trusted-input-helper"; });
    await expect(restoreDesktopRemoteDesktopDisplayMode("1", "99", () => current,
      { width: 1600, height: 900 }, signal(), runtime)).rejects.toThrowError("REMOTE_DESKTOP_DISPLAY_RESTORE_UNAVAILABLE");
    expect(runtime.spawn).not.toHaveBeenCalled();
  });

  it("keeps a cancelled dispatched write occupied until actual close and never adopts its late receipt", async () => {
    vi.useFakeTimers(); const { child, runtime } = fixture(); const abort = new AbortController();
    let settled = false;
    const writing = setDesktopRemoteDesktopDisplayMode("1", "12", vi.fn(), abort.signal, undefined, runtime);
    const failure = expect(writing).rejects.toThrowError("REMOTE_DESKTOP_LEASE_EXPIRED").then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(0); abort.abort(new Error("REMOTE_DESKTOP_LEASE_EXPIRED"));
    await vi.advanceTimersByTimeAsync(0); expect(child.kill).toHaveBeenCalledWith("SIGKILL"); expect(settled).toBe(false);
    await expect(restoreDesktopRemoteDesktopDisplayMode("1", "11", () => true,
      { width: 1600, height: 900 }, signal(), runtime)).rejects.toThrowError("REMOTE_DESKTOP_DISPLAY_BUSY");
    child.receipt(); await failure; expect(runtime.display).not.toHaveBeenCalled();
  });

  it("keeps a timed out effect occupied after exit until actual close, then preserves explicit failure", async () => {
    vi.useFakeTimers(); const { child, runtime } = fixture(); let settled = false;
    const writing = setDesktopRemoteDesktopDisplayMode("1", "12", vi.fn(), signal(), undefined, runtime);
    const failure = expect(writing).rejects.toThrowError("REMOTE_DESKTOP_DISPLAY_MODES_UNAVAILABLE").then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(5000); expect(child.kill).toHaveBeenCalledOnce();
    child.emit("exit", 0, null); await vi.advanceTimersByTimeAsync(0); expect(settled).toBe(false);
    await expect(setDesktopRemoteDesktopDisplayMode("1", "12", vi.fn(), signal(), undefined, runtime))
      .rejects.toThrowError("REMOTE_DESKTOP_DISPLAY_BUSY");
    child.receipt(); await failure;
  });

  it("refuses missing or unsettled actual geometry despite a confirmed native ready receipt", async () => {
    vi.useFakeTimers(); const { child, runtime } = fixture(); runtime.display.mockReturnValue(display(1600, 900));
    const writing = setDesktopRemoteDesktopDisplayMode("1", "12", vi.fn(), signal(), undefined, runtime);
    const failure = expect(writing).rejects.toThrowError("REMOTE_DESKTOP_DISPLAY_MODES_UNAVAILABLE");
    await vi.advanceTimersByTimeAsync(0); child.receipt(); await vi.advanceTimersByTimeAsync(3000); await failure;
    const next = fixture(); next.runtime.display.mockReturnValue(undefined);
    const restoring = restoreDesktopRemoteDesktopDisplayMode("1", "99", () => true,
      { width: 1600, height: 900 }, signal(), next.runtime);
    const restoreFailure = expect(restoring).rejects.toThrowError("REMOTE_DESKTOP_DISPLAY_RESTORE_UNAVAILABLE");
    await vi.advanceTimersByTimeAsync(0); next.child.receipt(); await restoreFailure;
  });

  it("does not publish success for failed native full-mode validation", async () => {
    const { child, runtime } = fixture();
    const restoring = restoreDesktopRemoteDesktopDisplayMode("1", "99", () => true,
      { width: 1600, height: 900 }, signal(), runtime);
    const failure = expect(restoring).rejects.toThrowError("REMOTE_DESKTOP_DISPLAY_RESTORE_UNAVAILABLE");
    await vi.waitFor(() => expect(runtime.spawn).toHaveBeenCalledOnce()); child.receipt("", 2); await failure;
    expect(runtime.display).not.toHaveBeenCalled();
  });
});
