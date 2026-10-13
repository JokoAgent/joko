import { accessSync, constants } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs", async original => ({ ...await original<typeof import("node:fs")>(), accessSync: vi.fn() }));
import {
  DesktopRemoteDesktopLinuxMute, supportsDesktopRemoteDesktopLinuxMute
} from "../src/remote-desktop-linux-mute.js";

interface Output { id: number; serial: number; name: string; muted: boolean; mediaClass?: string; }
function fixture() {
  const state = {
    default: "speaker",
    outputs: [
      { id: 10, serial: 100, name: "speaker", muted: false },
      { id: 20, serial: 200, name: "headphones", muted: true },
      { id: 30, serial: 300, name: "microphone", muted: false, mediaClass: "Audio/Source" }
    ] as Output[]
  };
  const writes: { id: number; muted: boolean }[] = [];
  const run = vi.fn(async (tool: string, args: string[]): Promise<string> => {
    if (tool === "pw-dump") return JSON.stringify(state.outputs.map(output => ({ id: output.id,
      info: { props: { "object.serial": String(output.serial), "media.class": output.mediaClass ?? "Audio/Sink", "node.name": output.name },
        params: { Props: [{ softMute: output.muted }] } } })));
    if (tool === "pactl") return `${state.default}\n`;
    if (tool !== "pw-cli" || args[0] !== "set-param" || args[2] !== "Props") throw new Error("Unexpected command");
    const id = Number(args[1]), muted = args[3] === "{ softMute: true }";
    writes.push({ id, muted });
    const output = state.outputs.find(output => output.id === id);
    if (output) output.muted = muted;
    return "";
  });
  const mute = new DesktopRemoteDesktopLinuxMute(run);
  const owner = {}, cancellation = new AbortController();
  let current = true;
  const enabled = () => mute.set(owner, true, () => current, cancellation.signal);
  return { state, writes, run, mute, owner, cancellation, enabled, retire: () => { current = false; } };
}

beforeEach(() => { vi.useFakeTimers(); vi.mocked(accessSync).mockReset(); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("Linux remote desktop playback mute", () => {
  it("admits only Linux with all three fixed executable tools", () => {
    for (const platform of ["win32", "darwin"]) {
      vi.stubGlobal("process", { ...process, platform });
      expect(supportsDesktopRemoteDesktopLinuxMute()).toBe(false);
    }
    expect(accessSync).not.toHaveBeenCalled();
    vi.stubGlobal("process", { ...process, platform: "linux" });
    expect(supportsDesktopRemoteDesktopLinuxMute()).toBe(true);
    expect(vi.mocked(accessSync).mock.calls).toEqual(["pactl", "pw-dump", "pw-cli"].map(tool => [`/usr/bin/${tool}`, constants.X_OK]));
    vi.mocked(accessSync).mockImplementation(file => { if (file === "/usr/bin/pw-cli") throw new Error("private diagnostic"); });
    expect(supportsDesktopRemoteDesktopLinuxMute()).toBe(false);
  });

  it("tracks default playback each second and restores exact originals without touching monitor or a reused ID", async () => {
    const value = fixture();
    await value.enabled();
    expect(value.writes).toEqual([{ id: 10, muted: true }]);
    expect(value.run.mock.calls.some(([tool]) => tool !== "pw-dump" && tool !== "pactl" && tool !== "pw-cli")).toBe(false);
    value.state.default = "headphones";
    await vi.advanceTimersByTimeAsync(1_000);
    expect(value.writes.slice(-2)).toEqual([{ id: 10, muted: true }, { id: 20, muted: true }]);
    value.state.outputs[0]!.serial = 101;
    value.state.outputs[0]!.muted = false;
    value.state.outputs.push({ id: 40, serial: 400, name: "external", muted: false });
    value.state.default = "external";
    await vi.advanceTimersByTimeAsync(1_000);
    const beforeRelease = value.writes.length;
    await value.mute.release(value.owner);
    expect(value.writes.slice(beforeRelease)).toEqual([{ id: 20, muted: true }, { id: 40, muted: false }]);
    expect(value.state.outputs[0]!.muted).toBe(false);
    expect(value.state.outputs[2]!.muted).toBe(false);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(value.writes).toHaveLength(beforeRelease + 2);
  });

  it.each(["shape", "missing sink", "tool failure"] as const)("maps %s to the finite unavailable result before any playback write", async failure => {
    const value = fixture(), native = value.run.getMockImplementation()!;
    value.run.mockImplementation(async (tool, args) => {
      if (failure === "shape" && tool === "pw-dump") return '{"private":"diagnostic"}';
      if (failure === "tool failure") throw new Error("private native diagnostic");
      if (failure === "missing sink") value.state.default = "absent";
      return native(tool, args);
    });
    await expect(value.enabled()).rejects.toThrow(/^REMOTE_DESKTOP_HOST_MUTE_UNAVAILABLE$/);
    expect(value.writes).toEqual([]);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(value.writes).toEqual([]);
  });

  it("retains uncertain native effects through five bounded restore retries and an explicit releaseAll retry", async () => {
    const value = fixture(), native = value.run.getMockImplementation()!;
    let failRestore = true;
    value.run.mockImplementation(async (tool, args) => {
      const receipt = await native(tool, args);
      if (tool === "pw-cli" && (args[3] === "{ softMute: true }" || failRestore)) throw new Error("private outcome unknown");
      return receipt;
    });
    await expect(value.enabled()).rejects.toThrow(/^REMOTE_DESKTOP_HOST_MUTE_UNAVAILABLE$/);
    expect(value.writes).toEqual([{ id: 10, muted: true }, { id: 10, muted: false }]);
    await value.mute.release({});
    await vi.advanceTimersByTimeAsync(250 + 500 + 1_000 + 2_000 + 4_000);
    expect(value.writes.filter(write => !write.muted)).toHaveLength(6);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(value.writes).toHaveLength(7);
    failRestore = false;
    await value.mute.releaseAll();
    expect(value.writes.at(-1)).toEqual({ id: 10, muted: false });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(value.writes).toHaveLength(8);
  });

  it.each(["current", "abort"] as const)("does not write mute when %s retires after the default-sink lookup", async retirement => {
    const value = fixture(), native = value.run.getMockImplementation()!;
    value.run.mockImplementation(async (tool, args) => {
      const receipt = await native(tool, args);
      if (tool === "pactl") {
        if (retirement === "current") value.retire(); else value.cancellation.abort(new Error("private abort reason"));
      }
      return receipt;
    });
    await expect(value.enabled()).rejects.toThrow(/^REMOTE_DESKTOP_HOST_MUTE_UNAVAILABLE$/);
    expect(value.writes).toEqual([]);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(value.writes).toEqual([]);
  });

  it.each(["current", "abort"] as const)("restores a late native mute after %s retires and stops future watch writes", async retirement => {
    const value = fixture(), native = value.run.getMockImplementation()!;
    let finish!: () => void;
    const wait = new Promise<void>(resolve => { finish = resolve; });
    value.run.mockImplementation(async (tool, args) => {
      const receipt = await native(tool, args);
      if (tool === "pw-cli" && args[3] === "{ softMute: true }") await wait;
      return receipt;
    });
    const rejected = expect(value.enabled()).rejects.toThrow(/^REMOTE_DESKTOP_HOST_MUTE_UNAVAILABLE$/);
    await vi.advanceTimersByTimeAsync(0);
    expect(value.state.outputs[0]!.muted).toBe(true);
    if (retirement === "current") value.retire(); else value.cancellation.abort();
    finish(); await rejected;
    expect(value.writes).toEqual([{ id: 10, muted: true }, { id: 10, muted: false }]);
    value.state.default = "headphones";
    await vi.advanceTimersByTimeAsync(2_000);
    expect(value.writes).toHaveLength(2);
  });

  it("checks watch ownership after awaited discovery before muting a changed default", async () => {
    const value = fixture(); await value.enabled();
    const native = value.run.getMockImplementation()!;
    value.state.default = "headphones";
    value.run.mockImplementation(async (tool, args) => {
      const receipt = await native(tool, args); if (tool === "pactl") value.retire(); return receipt;
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(value.writes).toEqual([{ id: 10, muted: true }, { id: 10, muted: false }]);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(value.writes).toHaveLength(2);
  });

  it("serializes replacement behind actual restoration and keeps its watch after an old owner cleanup", async () => {
    const value = fixture(), native = value.run.getMockImplementation()!;
    let finish!: () => void, hold = true;
    const wait = new Promise<void>(resolve => { finish = resolve; });
    value.run.mockImplementation(async (tool, args) => {
      const receipt = await native(tool, args);
      if (hold && tool === "pw-cli" && args[3] === "{ softMute: true }") { hold = false; await wait; }
      return receipt;
    });
    const rejected = expect(value.enabled()).rejects.toThrow(/^REMOTE_DESKTOP_HOST_MUTE_UNAVAILABLE$/);
    await vi.advanceTimersByTimeAsync(0);
    const next = {}, nextCancellation = new AbortController();
    const replacement = value.mute.set(next, true, () => true, nextCancellation.signal);
    const oldCleanup = value.mute.release(value.owner);
    expect(value.writes).toEqual([{ id: 10, muted: true }]);
    finish(); await rejected; await replacement; await oldCleanup;
    expect(value.writes).toEqual([{ id: 10, muted: true }, { id: 10, muted: false }, { id: 10, muted: true }]);
    value.state.default = "headphones";
    await vi.advanceTimersByTimeAsync(1_000);
    expect(value.writes.slice(-2)).toEqual([{ id: 10, muted: true }, { id: 20, muted: true }]);
    await value.mute.set(value.owner, false, () => true, value.cancellation.signal);
    expect(value.state.outputs[0]!.muted).toBe(true);
    await value.mute.set(next, false, () => true, nextCancellation.signal);
    expect(value.writes.slice(-2)).toEqual([{ id: 10, muted: false }, { id: 20, muted: true }]);
  });
});
