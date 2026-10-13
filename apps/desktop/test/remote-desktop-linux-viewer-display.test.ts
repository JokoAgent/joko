import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("electron", () => ({ app: {} }));
import { createDesktopRemoteDesktopLinuxViewerDisplay, supportsDesktopRemoteDesktopLinuxViewerDisplay,
  type DesktopRemoteDesktopLinuxViewerDisplayHandle, type DesktopRemoteDesktopLinuxViewerDisplayRuntime
} from "../src/remote-desktop-linux-viewer-display.js";
import type { DesktopRemoteDesktopSessionState } from "../src/remote-desktop-input.js";

const original = { name: "DP-1", width: 1920, height: 1080, x: -960, y: 0, scale: 2, transform: 0 };
const cleanup: { fixture: ReturnType<typeof fixture>; handle: DesktopRemoteDesktopLinuxViewerDisplayHandle }[] = [];
class MirrorChild extends EventEmitter {
  readonly stdin = new PassThrough(); readonly stdout = new PassThrough(); readonly stderr = new PassThrough();
  readonly kill = vi.fn((_signal?: NodeJS.Signals) => true);
}
function fixture() {
  const child = new MirrorChild(); const signal = new AbortController();
  const state = { monitors: [original], source: original, closed: false };
  const environment = { XDG_SESSION_TYPE: "wayland", XDG_SESSION_ID: "4", HYPRLAND_INSTANCE_SIGNATURE: "owned" };
  const runtime = {
    linux: { platform: "linux", environment, uid: () => 1000, effectiveUid: () => 1000,
      executable: () => true, trustedExecutable: vi.fn(async (_file: string) => true), execute: vi.fn(async () => "") },
    session: vi.fn(async (): Promise<DesktopRemoteDesktopSessionState> => "unlocked"),
    monitors: vi.fn(async (_signal: AbortSignal, _all?: boolean) => state.monitors),
    script: vi.fn(async () => "/app/linux-viewer-display.py"),
    spawn: vi.fn((_file: string, _args: readonly string[]) => child as unknown as ChildProcessWithoutNullStreams)
  } satisfies DesktopRemoteDesktopLinuxViewerDisplayRuntime;
  return { runtime, signal, child, environment, state,
    close: () => { if (!state.closed) { state.closed = true; child.emit("close", 0, null); } } };
}
async function create(f = fixture(), current: () => boolean = () => true, onFailure = vi.fn()) {
  const handle = await createDesktopRemoteDesktopLinuxViewerDisplay("hyprland:DP-1", current, onFailure, f.signal.signal, f.runtime);
  cleanup.push({ fixture: f, handle }); return { ...f, handle, onFailure };
}
function receipt(f: Awaited<ReturnType<typeof create>>, width = 800, height = 600, id = f.handle.displayId!) {
  f.state.monitors = [{ name: id.slice(9), width, height, x: 0, y: 0, scale: 1, transform: 0 }];
  f.child.stdout.write(`${JSON.stringify({ id, name: id.slice(9), width, height })}\n`);
}
afterEach(async () => {
  for (const entry of cleanup.splice(0)) {
    entry.fixture.state.monitors = [entry.fixture.state.source]; entry.fixture.runtime.session.mockResolvedValue("unlocked");
    entry.fixture.environment.XDG_SESSION_ID = "4";
    entry.handle.dispose(); entry.fixture.close(); await entry.handle.restore(() => true);
  }
  vi.useRealTimers();
});

describe("Linux temporary viewer mirror", () => {
  it("requires actual trusted native capture, interpreter and owned session before advertising", async () => {
    const f = fixture(); await expect(supportsDesktopRemoteDesktopLinuxViewerDisplay(f.signal.signal, f.runtime)).resolves.toBe(true);
    expect(f.runtime.script).toHaveBeenCalledOnce(); expect(f.runtime.spawn).not.toHaveBeenCalled();
    f.runtime.linux.trustedExecutable.mockImplementation(async file => file !== "/usr/bin/python3");
    await expect(supportsDesktopRemoteDesktopLinuxViewerDisplay(f.signal.signal, f.runtime)).resolves.toBe(false);
    f.runtime.linux.trustedExecutable.mockResolvedValue(true); f.runtime.session.mockResolvedValue("unsupported");
    await expect(createDesktopRemoteDesktopLinuxViewerDisplay("hyprland:DP-1", () => true, vi.fn(), f.signal.signal, f.runtime))
      .rejects.toThrowError("REMOTE_DESKTOP_VIEWER_DISPLAY_UNAVAILABLE");
    expect(f.runtime.spawn).not.toHaveBeenCalled();
  });

  it("preallocates the exact private output identity before any resize and uses isolated fixed interpreter", async () => {
    const f = await create(); expect(f.handle.displayId).toMatch(/^hyprland:JokoRemote-[a-f0-9]{16}$/u);
    expect(f.runtime.spawn).toHaveBeenCalledExactlyOnceWith("/usr/bin/python3", ["-I", "-u", "/app/linux-viewer-display.py", "DP-1",
      f.handle.displayId!.slice(9)]);
    expect(f.child.stdin.readableLength).toBe(0);
  });

  it("rejects an ownership change during asynchronous script resolution without spawning", async () => {
    const f = fixture(); let current = true;
    f.runtime.script.mockImplementation(async () => { current = false; return "/app/linux-viewer-display.py"; });
    await expect(createDesktopRemoteDesktopLinuxViewerDisplay("hyprland:DP-1", () => current, vi.fn(), f.signal.signal, f.runtime))
      .rejects.toThrowError("REMOTE_DESKTOP_LEASE_EXPIRED");
    expect(f.runtime.spawn).not.toHaveBeenCalled();
  });

  it("accepts only bounded integer public sizes and proves the same output through repeated actual geometry", async () => {
    const f = await create();
    for (const [width, height] of [[319, 600], [2561, 600], [600, 319], [600.5, 800]]) {
      await expect(f.handle.resize(width!, height!, () => true)).rejects.toThrowError("REMOTE_DESKTOP_VIEWER_DISPLAY_UNAVAILABLE");
    }
    expect(f.child.stdin.readableLength).toBe(0);
    for (const [width, height] of [[800, 600], [600, 800]]) {
      const resizing = f.handle.resize(width!, height!, () => true);
      await vi.waitFor(() => expect(f.child.stdin.readableLength).toBeGreaterThan(0)); f.child.stdin.read(); receipt(f, width, height);
      await expect(resizing).resolves.toEqual({ id: f.handle.displayId, name: f.handle.displayId!.slice(9), width, height });
    }
    expect(f.runtime.spawn).toHaveBeenCalledOnce();
  });

  it("rejects a mismatched receipt and keeps restoration owed until actual close", async () => {
    const f = await create();
    const resizing = f.handle.resize(800, 600, () => true); const failure = expect(resizing).rejects.toThrowError("REMOTE_DESKTOP_VIEWER_DISPLAY_UNAVAILABLE");
    await vi.waitFor(() => expect(f.child.stdin.readableLength).toBeGreaterThan(0)); receipt(f, 800, 600, "hyprland:JokoRemote-0000000000000000");
    await failure;
    await expect(createDesktopRemoteDesktopLinuxViewerDisplay("hyprland:DP-1", () => true, vi.fn(), f.signal.signal, f.runtime))
      .rejects.toThrowError("REMOTE_DESKTOP_DISPLAY_BUSY");
    expect(f.child.kill).not.toHaveBeenCalled();
  });

  it("snapshots the fresh source before first resize after a local layout change and restores that exact layout", async () => {
    const f = await create();
    f.state.source = { ...original, width: 1600, height: 1000, x: -800 };
    f.state.monitors = [f.state.source];
    const resizing = f.handle.resize(800, 600, () => true);
    await vi.waitFor(() => expect(f.child.stdin.readableLength).toBeGreaterThan(0)); receipt(f);
    await expect(resizing).resolves.toMatchObject({ width: 800, height: 600 });
    const restoring = f.handle.restore(() => true);
    f.state.monitors = [f.state.source]; f.close();
    await expect(restoring).resolves.toEqual({ id: "hyprland:DP-1", name: "DP-1", width: 800, height: 500 });
  });

  it("does not adopt a late receipt or async geometry after exact control has retired", async () => {
    const f = await create(); let current = true;
    const resizing = f.handle.resize(800, 600, () => current); const failure = expect(resizing).rejects.toThrowError("REMOTE_DESKTOP_LEASE_EXPIRED");
    await vi.waitFor(() => expect(f.child.stdin.readableLength).toBeGreaterThan(0)); current = false; receipt(f);
    await failure; expect(f.handle.displayId).toBeDefined();
  });

  it("joins restoration through actual close, permits owned lock and ignores retired request cancellation", async () => {
    vi.useFakeTimers(); const f = await create(); const id = f.handle.displayId;
    f.signal.abort(new Error("REMOTE_DESKTOP_LEASE_EXPIRED")); f.runtime.session.mockResolvedValue("locked-logged-in");
    let restored = false;
    const restoring = f.handle.restore(() => true).then(display => { restored = true; return display; });
    f.child.emit("exit", 0, null); await vi.advanceTimersByTimeAsync(0); expect(restored).toBe(false);
    await expect(createDesktopRemoteDesktopLinuxViewerDisplay("hyprland:DP-1", () => true, vi.fn(), undefined, f.runtime))
      .rejects.toThrowError("REMOTE_DESKTOP_DISPLAY_BUSY");
    f.close(); await expect(restoring).resolves.toEqual({ id: "hyprland:DP-1", name: "DP-1", width: 960, height: 540 });
    expect(f.handle.displayId).toBeUndefined(); expect(id).toBeDefined(); expect(f.runtime.monitors).toHaveBeenLastCalledWith(expect.any(AbortSignal), true);
    expect(f.child.kill).not.toHaveBeenCalled();
  });

  it("keeps failed or timed-out cleanup owed and uses only SIGTERM until exact restoration succeeds", async () => {
    vi.useFakeTimers(); const f = await create();
    const restoring = f.handle.restore(() => true); const failure = expect(restoring).rejects.toThrowError("REMOTE_DESKTOP_VIEWER_DISPLAY_UNAVAILABLE");
    await vi.advanceTimersByTimeAsync(12_000); await failure; expect(f.child.kill).toHaveBeenCalledExactlyOnceWith("SIGTERM");
    await expect(createDesktopRemoteDesktopLinuxViewerDisplay("hyprland:DP-1", () => true, vi.fn(), undefined, f.runtime))
      .rejects.toThrowError("REMOTE_DESKTOP_DISPLAY_BUSY");
    f.state.monitors = [{ ...original, width: 1280 }]; f.close();
    await expect(f.handle.restore(() => true)).rejects.toThrowError("REMOTE_DESKTOP_VIEWER_DISPLAY_UNAVAILABLE");
    expect(f.handle.displayId).toBeDefined();
    f.state.monitors = [original]; await expect(f.handle.restore(() => true)).resolves.toMatchObject({ width: 960, height: 540 });
  });

  it("signals only this occurrence on child failure and retains its exact output until confirmed cleanup", async () => {
    const f = await create(); f.child.emit("error", new Error("process failure")); expect(f.onFailure).toHaveBeenCalledOnce();
    f.child.emit("exit", 1, null); expect(f.onFailure).toHaveBeenCalledOnce();
    await expect(createDesktopRemoteDesktopLinuxViewerDisplay("hyprland:DP-1", () => true, vi.fn(), undefined, f.runtime))
      .rejects.toThrowError("REMOTE_DESKTOP_DISPLAY_BUSY");
  });
});
