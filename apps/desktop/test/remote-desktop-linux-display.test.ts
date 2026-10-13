import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ app: {} }));
import {
  readDesktopRemoteDesktopLinuxDisplayModes, restoreDesktopRemoteDesktopLinuxDisplayMode,
  setDesktopRemoteDesktopLinuxDisplayMode, supportsDesktopRemoteDesktopLinuxDisplayModes,
  type DesktopRemoteDesktopLinuxDisplayRuntime
} from "../src/remote-desktop-linux-display.js";
import type { DesktopRemoteDesktopSessionState } from "../src/remote-desktop-input.js";

const signal = (): AbortSignal => new AbortController().signal;
const geometry = (mode: { readonly width: number; readonly height: number }) => ({ width: mode.width, height: mode.height });
const original = { name: "DP-1", width: 1920, height: 1080, refreshRate: 60, x: -540, y: 0, scale: 2, transform: 1,
  availableModes: ["1920x1080@60Hz", "1920x1080@59.99Hz", "1280x720@60Hz"] };
class ModeChild extends EventEmitter {
  readonly stdout = new PassThrough(); readonly stderr = new PassThrough();
  readonly kill = vi.fn((_signal?: NodeJS.Signals) => true);
  receipt(value = "ok\n", code = 0): void { this.stdout.write(value); this.emit("close", code, null); }
}
function fixture() {
  const child = new ModeChild();
  const environment = { XDG_SESSION_TYPE: "wayland", XDG_SESSION_ID: "4", HYPRLAND_INSTANCE_SIGNATURE: "owned" };
  const state = { monitors: [{ ...original }], lua: true };
  const runtime = {
    linux: {
      platform: "linux", environment, uid: () => 1000, effectiveUid: () => 1000,
      executable: () => true, trustedExecutable: vi.fn(async () => true),
      execute: vi.fn(async (_file: string, args: readonly string[]) => args[0] === "-j"
        ? JSON.stringify(state.monitors) : state.lua ? "ok\n" : "unsupported")
    },
    session: vi.fn(async (): Promise<DesktopRemoteDesktopSessionState> => "unlocked"),
    spawn: vi.fn((_file: string, _arguments: readonly string[]) => child)
  } satisfies DesktopRemoteDesktopLinuxDisplayRuntime;
  return { child, environment, state, runtime };
}
async function modes(runtime: DesktopRemoteDesktopLinuxDisplayRuntime) {
  return readDesktopRemoteDesktopLinuxDisplayModes("hyprland:DP-1", signal(), runtime);
}
afterEach(() => { vi.useRealTimers(); });

describe("Linux physical display modes", () => {
  it("enumerates stable compositor IDs, one current refresh and rotated HiDPI logical sizes", async () => {
    const { runtime } = fixture();
    await expect(supportsDesktopRemoteDesktopLinuxDisplayModes(signal(), runtime)).resolves.toBe(true);
    const first = await modes(runtime);
    expect(first).toEqual([
      { id: expect.stringMatching(/^\d{1,10}$/u), width: 540, height: 960, current: true, native: false },
      { id: expect.any(String), width: 540, height: 960, current: false, native: false },
      { id: expect.any(String), width: 360, height: 640, current: false, native: false }
    ]);
    expect(await modes(runtime)).toEqual(first);
    expect(new Set(first.map(mode => mode.id)).size).toBe(3);
    expect(runtime.linux.execute).toHaveBeenCalledWith("/usr/bin/hyprctl", ["-j", "monitors", "all"], expect.any(AbortSignal), 128000, 2000);
  });

  it("rejects an untrusted executable or unowned session before compositor access", async () => {
    const first = fixture(); first.runtime.linux.trustedExecutable.mockResolvedValue(false);
    await expect(supportsDesktopRemoteDesktopLinuxDisplayModes(signal(), first.runtime)).resolves.toBe(false);
    expect(first.runtime.linux.execute).not.toHaveBeenCalled();
    const second = fixture(); second.runtime.session.mockResolvedValue("unsupported");
    await expect(modes(second.runtime)).rejects.toThrowError("REMOTE_DESKTOP_DISPLAY_MODES_UNAVAILABLE");
    expect(second.runtime.linux.execute).not.toHaveBeenCalled();
  });

  it.each([
    { refreshRate: 0 }, { scale: 0 }, { name: "DP-1,disable" }, { availableModes: ["99999x720@60Hz"] },
    { availableModes: ["1280x720@60Hz"] }, { availableModes: ["1920x1080@60Hz", "1920x1080@60Hz"] }
  ])("rejects malformed or ambiguous physical catalogs %j", async changed => {
    const { runtime, state } = fixture(); state.monitors = [{ ...original, ...changed }];
    await expect(modes(runtime)).rejects.toThrowError("REMOTE_DESKTOP_DISPLAY_MODES_UNAVAILABLE");
    expect(runtime.spawn).not.toHaveBeenCalled();
  });

  it("requires the selected output and a host-enumerated ID before draining input", async () => {
    const { runtime } = fixture(); const before = vi.fn();
    await expect(setDesktopRemoteDesktopLinuxDisplayMode("hyprland:DP-1", "9999999999", before, signal(), undefined, runtime))
      .rejects.toThrowError("REMOTE_DESKTOP_DISPLAY_MODE_MISSING");
    await expect(readDesktopRemoteDesktopLinuxDisplayModes("hyprland:DP-2", signal(), runtime))
      .rejects.toThrowError("REMOTE_DESKTOP_DISPLAY_MODES_UNAVAILABLE");
    expect(before).not.toHaveBeenCalled(); expect(runtime.spawn).not.toHaveBeenCalled();
  });

  it.each([true, false])("drains input then dispatches one %s Lua write and waits for actual logical geometry", async lua => {
    vi.useFakeTimers(); const { child, runtime, state } = fixture(); state.lua = lua;
    const selected = (await modes(runtime))[2]!;
    let release!: () => void; const before = vi.fn(() => new Promise<void>(resolve => { release = resolve; }));
    let settled = false;
    const writing = setDesktopRemoteDesktopLinuxDisplayMode("hyprland:DP-1", selected.id, before, signal(), geometry(selected), runtime)
      .then(value => { settled = true; return value; });
    await vi.advanceTimersByTimeAsync(0); expect(before).toHaveBeenCalledOnce(); expect(runtime.spawn).not.toHaveBeenCalled();
    release(); await vi.advanceTimersByTimeAsync(0);
    expect(runtime.spawn).toHaveBeenCalledExactlyOnceWith("/usr/bin/hyprctl", lua ? ["eval",
      'hl.monitor({output="DP-1",mode="1280x720@60",position="-540x0",scale=2,transform=1})']
      : ["keyword", "monitor", "DP-1,1280x720@60,-540x0,2,transform,1"]);
    child.stdout.write("ok\n"); await vi.advanceTimersByTimeAsync(0); expect(settled).toBe(false);
    child.emit("close", 0, null); await vi.advanceTimersByTimeAsync(0); expect(settled).toBe(false);
    state.monitors = [{ ...original, width: 1280, height: 720 }]; await vi.advanceTimersByTimeAsync(50);
    await expect(writing).resolves.toEqual({ id: "hyprland:DP-1", name: "DP-1", width: 360, height: 640 });
  });

  it("rechecks abort, local session and the enumerated mode after asynchronous input drain", async () => {
    for (const changed of ["abort", "session", "catalog"] as const) {
      const { runtime, state, environment } = fixture(); const selected = (await modes(runtime))[2]!;
      const cancellation = new AbortController();
      const writing = setDesktopRemoteDesktopLinuxDisplayMode("hyprland:DP-1", selected.id, async () => {
        if (changed === "abort") cancellation.abort(new Error("REMOTE_DESKTOP_LEASE_EXPIRED"));
        if (changed === "session") environment.XDG_SESSION_ID = "5";
        if (changed === "catalog") state.monitors = [{ ...original, availableModes: [original.availableModes[0]!] }];
      }, cancellation.signal, geometry(selected), runtime);
      await expect(writing).rejects.toThrowError(changed === "catalog" ? "REMOTE_DESKTOP_DISPLAY_MODE_MISSING" : "REMOTE_DESKTOP_LEASE_EXPIRED");
      expect(runtime.spawn).not.toHaveBeenCalled();
    }
  });

  it("rejects retired exact control after asynchronous compositor re-enumeration before dispatch", async () => {
    const { runtime } = fixture(); const selected = (await modes(runtime))[2]!;
    let current = true; let drained = false;
    const execute = runtime.linux.execute.getMockImplementation()!;
    runtime.linux.execute.mockImplementation(async (file, arguments_) => {
      const raw = await execute(file, arguments_);
      if (drained && arguments_[0] === "-j") current = false;
      return raw;
    });
    await expect(setDesktopRemoteDesktopLinuxDisplayMode("hyprland:DP-1", selected.id, () => { drained = true; },
      signal(), { ...selected, current: () => current }, runtime)).rejects.toThrowError("REMOTE_DESKTOP_LEASE_EXPIRED");
    expect(runtime.spawn).not.toHaveBeenCalled();
  });

  it("reads owned locked modes but permits only captured restoration to write while locked", async () => {
    const { runtime, child, state } = fixture(); runtime.session.mockResolvedValue("locked-logged-in");
    const originalMode = (await modes(runtime))[0]!;
    await expect(setDesktopRemoteDesktopLinuxDisplayMode("hyprland:DP-1", originalMode.id, vi.fn(), signal(), undefined, runtime))
      .rejects.toThrowError("REMOTE_DESKTOP_LOCKED_SESSION_UNSUPPORTED");
    state.monitors = [{ ...original, width: 1280, height: 720 }];
    const restoring = restoreDesktopRemoteDesktopLinuxDisplayMode("hyprland:DP-1", originalMode.id, () => true,
      originalMode, signal(), runtime);
    await vi.waitFor(() => expect(runtime.spawn).toHaveBeenCalledOnce()); state.monitors = [{ ...original }]; child.receipt();
    await expect(restoring).resolves.toEqual({ id: "hyprland:DP-1", name: "DP-1", width: 540, height: 960 });
  });

  it("restores a same-size refresh ID from full enumeration and fences retired restoration after probe", async () => {
    const { runtime, child } = fixture(); const omittedFromSizePicker = (await modes(runtime))[1]!;
    const restoring = restoreDesktopRemoteDesktopLinuxDisplayMode("hyprland:DP-1", omittedFromSizePicker.id, () => true,
      omittedFromSizePicker, signal(), runtime);
    await vi.waitFor(() => expect(runtime.spawn).toHaveBeenCalledOnce()); child.receipt(); await restoring;
    expect(runtime.spawn.mock.calls[0]![1]).toEqual(["eval", expect.stringContaining('mode="1920x1080@59.99"')]);
    const next = fixture(); let current = true;
    next.runtime.linux.execute.mockImplementation(async (_file, args) => {
      if (args[0] === "eval") { current = false; return "ok"; }
      return JSON.stringify(next.state.monitors);
    });
    await expect(restoreDesktopRemoteDesktopLinuxDisplayMode("hyprland:DP-1", omittedFromSizePicker.id, () => current,
      omittedFromSizePicker, signal(), next.runtime)).rejects.toThrowError("REMOTE_DESKTOP_DISPLAY_RESTORE_UNAVAILABLE");
    expect(next.runtime.spawn).not.toHaveBeenCalled();
  });

  it.each(["abort", "timeout"] as const)("keeps a dispatched %s write occupied through exit/error until actual close", async reason => {
    vi.useFakeTimers(); const { child, runtime } = fixture(); const selected = (await modes(runtime))[2]!;
    const cancellation = new AbortController(); let settled = false;
    const writing = setDesktopRemoteDesktopLinuxDisplayMode("hyprland:DP-1", selected.id, vi.fn(), cancellation.signal, geometry(selected), runtime);
    const failure = expect(writing).rejects.toThrowError(reason === "abort" ? "REMOTE_DESKTOP_LEASE_EXPIRED" : "REMOTE_DESKTOP_DISPLAY_MODES_UNAVAILABLE")
      .then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(0);
    if (reason === "abort") cancellation.abort(new Error("REMOTE_DESKTOP_LEASE_EXPIRED"));
    else await vi.advanceTimersByTimeAsync(3_000);
    child.emit("exit", 0, null); child.emit("error", new Error("late process error"));
    await vi.advanceTimersByTimeAsync(0); expect(settled).toBe(false); expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    await expect(restoreDesktopRemoteDesktopLinuxDisplayMode("hyprland:DP-1", selected.id, () => true, selected, signal(), runtime))
      .rejects.toThrowError("REMOTE_DESKTOP_DISPLAY_BUSY");
    child.receipt(); await failure;
  });

  it("rejects late ownership loss and an unobserved geometry despite a successful write receipt", async () => {
    vi.useFakeTimers(); const { runtime, child } = fixture(); const selected = (await modes(runtime))[2]!;
    const writing = setDesktopRemoteDesktopLinuxDisplayMode("hyprland:DP-1", selected.id, vi.fn(), signal(), geometry(selected), runtime);
    const failure = expect(writing).rejects.toThrowError("REMOTE_DESKTOP_DISPLAY_MODES_UNAVAILABLE");
    await vi.advanceTimersByTimeAsync(0); child.receipt(); await vi.advanceTimersByTimeAsync(2_000); await failure;
    const next = fixture(); const originalMode = (await modes(next.runtime))[0]!; let current = true;
    const restoring = restoreDesktopRemoteDesktopLinuxDisplayMode("hyprland:DP-1", originalMode.id, () => current,
      originalMode, signal(), next.runtime);
    const restoreFailure = expect(restoring).rejects.toThrowError("REMOTE_DESKTOP_DISPLAY_RESTORE_UNAVAILABLE");
    await vi.advanceTimersByTimeAsync(0); current = false; next.child.receipt(); await restoreFailure;
  });
});
