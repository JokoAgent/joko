import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ app: {} }));
import {
  DesktopRemoteDesktopLinuxWorkspace,
  readDesktopRemoteDesktopLinuxWorkspaceSupport,
  type DesktopRemoteDesktopLinuxWorkspaceRuntime
} from "../src/remote-desktop-linux-workspace.js";
import type { DesktopRemoteDesktopSessionState } from "../src/remote-desktop-input.js";

function fixture() {
  const environment = { XDG_SESSION_TYPE: "wayland", XDG_SESSION_ID: "4", WAYLAND_DISPLAY: "wayland-1",
    HYPRLAND_INSTANCE_SIGNATURE: "owned-compositor" };
  const state = { lua: true, uid: 1000, effectiveUid: 1000, grim: true, menu: true,
    session: "unlocked" as DesktopRemoteDesktopSessionState, current: true,
    monitors: [
      { name: "eDP-1", width: 1920, height: 1080, x: 0, y: 0, scale: 1, transform: 0 },
      { name: "DP-2", width: 2560, height: 1440, x: 1920, y: 0, scale: 2, transform: 1 }
    ] };
  const effects: { file: string; arguments_: readonly string[] }[] = [];
  const execute = vi.fn(async (file: string, arguments_: readonly string[], _signal: AbortSignal,
    _maximumBytes: number, _timeout: number): Promise<string> => {
    if (arguments_[0] === "-j") return JSON.stringify(state.monitors);
    if (arguments_[1]?.startsWith("assert(")) return state.lua ? "ok\n" : "unsupported";
    effects.push({ file, arguments_ });
    return "ok\n";
  });
  const runtime = {
    linux: { platform: "linux", environment, uid: () => state.uid, effectiveUid: () => state.effectiveUid,
      executable: () => state.grim,
      trustedExecutable: vi.fn(async (file: string) => file === "/usr/bin/hyprctl" || state.menu), execute },
    session: vi.fn(async () => state.session)
  } satisfies DesktopRemoteDesktopLinuxWorkspaceRuntime;
  const cancellation = new AbortController();
  const workspace = new DesktopRemoteDesktopLinuxWorkspace(runtime);
  const request = (action: "workspaceLeft" | "workspaceRight" | "systemMenu", displayId = "hyprland:DP-2") =>
    workspace.request(action, displayId, () => state.current, cancellation.signal);
  return { environment, state, effects, runtime, execute, cancellation, workspace, request };
}

describe("Linux leased workspace actions", () => {
  it("reads exact capabilities without dispatch, focus, or menu effects", async () => {
    const value = fixture();
    expect(await readDesktopRemoteDesktopLinuxWorkspaceSupport(value.cancellation.signal, value.runtime))
      .toEqual({ workspaceNavigation: true, systemMenu: true });
    expect(value.effects).toEqual([]);
    expect(value.execute.mock.calls.every(([, arguments_]) => arguments_[0] === "-j")).toBe(true);
    value.state.menu = false;
    expect(await readDesktopRemoteDesktopLinuxWorkspaceSupport(value.cancellation.signal, value.runtime))
      .toEqual({ workspaceNavigation: true, systemMenu: false });
  });

  it.each(["platform", "portal", "no capture", "uid", "locked", "untrusted"] as const)
    ("rejects %s support before any effect", async (condition) => {
      const value = fixture();
      if (condition === "platform") Object.assign(value.runtime.linux, { platform: "darwin" });
      if (condition === "portal") value.environment.HYPRLAND_INSTANCE_SIGNATURE = "";
      if (condition === "no capture") value.state.grim = false;
      if (condition === "uid") value.state.effectiveUid = 0;
      if (condition === "locked") value.state.session = "locked-logged-in";
      if (condition === "untrusted") value.runtime.linux.trustedExecutable.mockResolvedValue(false);
      expect(await readDesktopRemoteDesktopLinuxWorkspaceSupport(value.cancellation.signal, value.runtime))
        .toEqual({ workspaceNavigation: false, systemMenu: false });
      expect(value.effects).toEqual([]);
    });

  it.each([
    { lua: true, action: "workspaceLeft" as const, relative: "r-1" },
    { lua: true, action: "workspaceRight" as const, relative: "r+1" },
    { lua: false, action: "workspaceLeft" as const, relative: "r-1" },
    { lua: false, action: "workspaceRight" as const, relative: "r+1" }
  ])("focuses the exact leased output before $action with Lua=$lua", async ({ lua, action, relative }) => {
    const value = fixture(); value.state.lua = lua;
    await value.request(action);
    expect(value.effects).toEqual(lua ? [
      { file: "/usr/bin/hyprctl", arguments_: ["eval", 'hl.dispatch(hl.dsp.focus({monitor="DP-2"}))'] },
      { file: "/usr/bin/hyprctl", arguments_: ["eval", `hl.dispatch(hl.dsp.focus({workspace="${relative}"}))`] }
    ] : [
      { file: "/usr/bin/hyprctl", arguments_: ["dispatch", "focusmonitor", "DP-2"] },
      { file: "/usr/bin/hyprctl", arguments_: ["dispatch", "workspace", relative] }
    ]);
    expect(value.execute.mock.calls.filter(([, arguments_]) => arguments_[0] === "-j")
      .every(([, arguments_]) => arguments_.join(" ") === "-j monitors all")).toBe(true);
  });

  it("focuses the selected monitor then toggles only the installed system menu", async () => {
    const value = fixture();
    await value.request("systemMenu");
    expect(value.effects).toEqual([
      { file: "/usr/bin/hyprctl", arguments_: ["eval", 'hl.dispatch(hl.dsp.focus({monitor="DP-2"}))'] },
      { file: "/usr/bin/omarchy", arguments_: ["menu", "toggle"] }
    ]);
    expect(value.execute).toHaveBeenCalledWith("/usr/bin/omarchy", ["menu", "toggle"], value.cancellation.signal, 16384, 2000);
    const missing = fixture(); missing.state.menu = false;
    await expect(missing.request("systemMenu")).rejects.toThrow(/^REMOTE_DESKTOP_SYSTEM_ACTION_UNAVAILABLE$/u);
    expect(missing.effects).toEqual([]);
  });

  it.each(["wayland-portal", "hyprland:missing", "hyprland:DP-2,workspace+1"])
    ("never substitutes an arbitrary monitor for %s", async displayId => {
      const value = fixture();
      await expect(value.request("workspaceLeft", displayId)).rejects.toThrow(/^REMOTE_DESKTOP_SYSTEM_ACTION_UNAVAILABLE$/u);
      expect(value.effects).toEqual([]);
    });

  it("never repeats a failed issued effect with another dispatch syntax or leaks diagnostics", async () => {
    const value = fixture(), execute = value.execute.getMockImplementation()!;
    value.execute.mockImplementation(async (...arguments_) => {
      if (arguments_[1][1]?.startsWith("hl.dispatch(")) {
        value.effects.push({ file: arguments_[0], arguments_: arguments_[1] });
        throw new Error("private compositor diagnostic");
      }
      return execute(...arguments_);
    });
    await expect(value.request("workspaceLeft")).rejects.toThrow(/^REMOTE_DESKTOP_SYSTEM_ACTION_UNAVAILABLE$/u);
    expect(value.effects).toHaveLength(1);
    expect(value.effects[0]!.arguments_[0]).toBe("eval");
  });

  it.each(["lock", "monitor removed", "monitor changed", "identity", "current", "abort"] as const)
    ("fences %s between focus and workspace", async condition => {
      const value = fixture(), execute = value.execute.getMockImplementation()!;
      value.execute.mockImplementation(async (...arguments_) => {
        const result = await execute(...arguments_);
        if (arguments_[1][1]?.includes('{monitor="')) {
          if (condition === "lock") value.state.session = "locked-logged-in";
          if (condition === "monitor removed") value.state.monitors.pop();
          if (condition === "monitor changed") value.state.monitors[1]!.x += 1;
          if (condition === "identity") value.environment.HYPRLAND_INSTANCE_SIGNATURE = "replacement";
          if (condition === "current") value.state.current = false;
          if (condition === "abort") value.cancellation.abort();
        }
        return result;
      });
      await expect(value.request("workspaceRight")).rejects.toThrow(condition === "identity" || condition === "current" || condition === "abort"
        ? /^REMOTE_DESKTOP_SYSTEM_ACTION_EXPIRED$/u : /^REMOTE_DESKTOP_SYSTEM_ACTION_UNAVAILABLE$/u);
      expect(value.effects).toHaveLength(1);
    });

  it("serializes effects and waits for actual in-flight completion while retiring queued work", async () => {
    const value = fixture(), execute = value.execute.getMockImplementation()!;
    let complete!: () => void;
    value.execute.mockImplementation(async (...arguments_) => {
      const result = await execute(...arguments_);
      if (arguments_[1][1]?.includes('{workspace="r-1"')) await new Promise<void>(resolve => { complete = resolve; });
      return result;
    });
    const first = value.request("workspaceLeft");
    const firstOutcome = expect(first).rejects.toThrow(/^REMOTE_DESKTOP_SYSTEM_ACTION_EXPIRED$/u);
    await vi.waitFor(() => expect(value.effects).toHaveLength(2));
    const second = value.request("workspaceRight");
    const secondOutcome = expect(second).rejects.toThrow(/^REMOTE_DESKTOP_SYSTEM_ACTION_EXPIRED$/u);
    let stopped = false;
    const stopping = value.workspace.stop().then(() => { stopped = true; });
    await Promise.resolve();
    expect(stopped).toBe(false);
    expect(value.effects).toHaveLength(2);
    await expect(value.request("systemMenu")).rejects.toThrow(/^REMOTE_DESKTOP_SYSTEM_ACTION_EXPIRED$/u);
    complete();
    await Promise.all([firstOutcome, secondOutcome, stopping]);
    expect(stopped).toBe(true);
    expect(value.effects).toHaveLength(2);
    await value.request("workspaceRight");
    expect(value.effects).toHaveLength(4);
  });
});
