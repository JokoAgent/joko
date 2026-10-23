import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";

import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ app: {}, screen: {} }));

import {
  DesktopRemoteDesktopInput,
  lockDesktopRemoteDesktopScreen,
  type DesktopRemoteDesktopInputRuntime,
  type DesktopRemoteDesktopLockRuntime
} from "../src/remote-desktop-input.js";

describe("Desktop Remote Desktop terminal lock helper", () => {
  it("confines the helper and waits for Source human admission and native ACK before completing input", async () => {
    const child = inputChild(), complete = vi.fn(async () => {}), closed = vi.fn(async () => {});
    let admit!: () => void; const admitted = new Promise<void>(resolve => { admit = resolve; });
    const ownership = { begin: vi.fn(async () => { await admitted; return complete; }), close: closed };
    const runtime: DesktopRemoteDesktopInputRuntime = { platform: "darwin", resolveBinary: async () => "helper", spawn: vi.fn(() => child as unknown as ChildProcessWithoutNullStreams),
      display: () => ({ id: "1", name: "Display", width: 100, height: 100, x: 400, y: 500 }), toPhysicalPoint: point => point };
    const input = new DesktopRemoteDesktopInput(vi.fn(), runtime), window = { windowId: 71, pid: 80 };
    const starting = input.start("1", new AbortController().signal, window, ownership); await vi.waitFor(() => expect(runtime.spawn).toHaveBeenCalledOnce()); child.stdout.write("ready\n"); await starting;
    expect(runtime.spawn).toHaveBeenCalledWith("helper", ["--window", "71", "80"]);
    input.send([{ kind: "button", button: 0, down: true, x: .2, y: .7 }]);
    await vi.waitFor(() => expect(ownership.begin).toHaveBeenCalledOnce()); expect(child.stdin.read()).toBeNull();
    admit(); await vi.waitFor(() => expect(child.stdin.read()?.toString()).toContain('"x":0.2,"y":0.7'));
    expect(complete).not.toHaveBeenCalled(); child.stdout.write("ok\n"); await vi.waitFor(() => expect(complete).toHaveBeenCalledOnce());
    const stopping = input.release(); expect(closed).not.toHaveBeenCalled(); child.emit("close", 0, null); await stopping; expect(closed).toHaveBeenCalled();
  });
  it("keeps each complete pointer batch hidden until its native ACK and samples wheel position when dispatched", async () => {
    const child = inputChild(), completions: ReturnType<typeof vi.fn>[] = [], points: { x: number; y: number }[][] = [];
    const pointer = vi.fn((batch: { x: number; y: number }[]) => { points.push(batch); const completed = vi.fn(); completions.push(completed); return completed; });
    const runtime: DesktopRemoteDesktopInputRuntime = {
      platform: "darwin", resolveBinary: async () => "helper", spawn: () => child as unknown as ChildProcessWithoutNullStreams,
      display: () => ({ id: "1", name: "Display", width: 100, height: 100, x: -100, y: 20 }),
      toPhysicalPoint: point => ({ x: point.x * 2, y: point.y * 2 }), cursorScreenPoint: () => ({ x: 17, y: 18 })
    };
    const input = new DesktopRemoteDesktopInput(vi.fn(), runtime, pointer);
    const started = input.start("1", new AbortController().signal); await vi.waitFor(() => expect(child.stdin.listenerCount("error")).toBeGreaterThan(0));
    child.stdout.write("ready\n"); await started;
    input.send([{ kind: "button", button: 0, down: true, x: .5, y: .5 }, { kind: "move", x: .9, y: .9 }]);
    input.send([{ kind: "scroll", dx: 0, dy: 1 }]);
    await vi.waitFor(() => expect(pointer).toHaveBeenCalledOnce());
    expect(points[0]).toEqual([{ x: -50, y: 70 }, { x: -11, y: 109 }]); expect(completions[0]).not.toHaveBeenCalled();
    child.stdout.write("ok\n"); await vi.waitFor(() => expect(pointer).toHaveBeenCalledTimes(2));
    expect(completions[0]).toHaveBeenCalledOnce(); expect(points[1]).toEqual([{ x: 17, y: 18 }]); expect(completions[1]).not.toHaveBeenCalled();
    child.stdout.write("ok\n"); await vi.waitFor(() => expect(completions[1]).toHaveBeenCalledOnce());
    const stopped = input.release(); child.emit("close", 0, null); await stopped;
  });
  it.each(["win32", "linux"] as const)("keeps %s lock unavailable without preparing a helper", async (platform) => {
    const runtime = lockRuntime(platform);
    await expect(lockDesktopRemoteDesktopScreen(() => true, new AbortController().signal, runtime))
      .rejects.toThrowError("REMOTE_DESKTOP_LOCK_UNAVAILABLE");
    expect(runtime.resolveBinary).not.toHaveBeenCalled();
    expect(runtime.execute).not.toHaveBeenCalled();
  });

  it("uses only the authenticated input helper fixed command and confirmed locked output", async () => {
    const runtime = lockRuntime();
    const signal = new AbortController().signal;
    await expect(lockDesktopRemoteDesktopScreen(() => true, signal, runtime)).resolves.toBeUndefined();
    expect(runtime.execute).toHaveBeenCalledWith("trusted-input-helper", ["--lock-screen"], signal);
  });

  it("rechecks ending authority after helper preparation before dispatch", async () => {
    const runtime = lockRuntime();
    let current = true;
    vi.mocked(runtime.resolveBinary).mockImplementationOnce(async () => {
      current = false;
      return "trusted-input-helper";
    });
    await expect(lockDesktopRemoteDesktopScreen(() => current, new AbortController().signal, runtime))
      .rejects.toThrowError("REMOTE_DESKTOP_LOCK_EXPIRED");
    expect(runtime.execute).not.toHaveBeenCalled();
  });

  it.each(["ready", "unsupported", "locked-logged-in", ""])("refuses unconfirmed native output %s", async (stdout) => {
    const runtime = lockRuntime();
    vi.mocked(runtime.execute).mockResolvedValueOnce({ stdout });
    await expect(lockDesktopRemoteDesktopScreen(() => true, new AbortController().signal, runtime))
      .rejects.toThrowError("REMOTE_DESKTOP_LOCK_FAILED");
  });

  it("keeps process errors private and refuses a cancelled confirmed return", async () => {
    const runtime = lockRuntime();
    vi.mocked(runtime.execute).mockRejectedValueOnce(new Error("private native stdout/stderr"));
    await expect(lockDesktopRemoteDesktopScreen(() => true, new AbortController().signal, runtime))
      .rejects.toThrowError(/^REMOTE_DESKTOP_LOCK_FAILED$/u);
    const command = new AbortController();
    vi.mocked(runtime.execute).mockImplementationOnce(async (_binary, _args, signal) => {
      expect(signal).toBe(command.signal);
      command.abort();
      return { stdout: "locked" };
    });
    await expect(lockDesktopRemoteDesktopScreen(() => true, command.signal, runtime))
      .rejects.toThrowError("REMOTE_DESKTOP_LOCK_EXPIRED");
  });

  it("waits for the captured input helper to close before releasing and can start a fresh occurrence", async () => {
    const first = inputChild();
    const second = inputChild();
    const children = [first, second];
    const runtime: DesktopRemoteDesktopInputRuntime = {
      platform: "darwin",
      resolveBinary: vi.fn(async () => "trusted-input-helper"),
      spawn: vi.fn(() => children.shift()! as unknown as ChildProcessWithoutNullStreams),
      display: () => ({ id: "1", name: "Display", width: 100, height: 100, x: 0, y: 0 }),
      toPhysicalPoint: (point) => point
    };
    const input = new DesktopRemoteDesktopInput(vi.fn(), runtime);
    const starting = input.start("1", new AbortController().signal);
    await vi.waitFor(() => expect(runtime.spawn).toHaveBeenCalledOnce());
    first.stdout.write("ready\n");
    await starting;
    let released = false;
    const release = input.release().then(() => { released = true; });
    expect(first.stdin.read()?.toString()).toBe('[{"kind":"release"}]\n');
    await Promise.resolve();
    expect(released).toBe(false);
    first.emit("close", 0, null);
    await release;
    const restarting = input.start("1", new AbortController().signal);
    await vi.waitFor(() => expect(runtime.spawn).toHaveBeenCalledTimes(2));
    second.stdout.write("ready\n");
    await restarting;
    const ending = input.release();
    second.emit("close", 0, null);
    await ending;
    await input.retire();
  });

  it("refuses release after a kill request until every older helper has confirmed its exit", async () => {
    vi.useFakeTimers();
    try {
      const first = inputChild();
      const second = inputChild();
      const children = [first, second];
      const runtime: DesktopRemoteDesktopInputRuntime = {
        platform: "darwin",
        resolveBinary: vi.fn(async () => "trusted-input-helper"),
        spawn: vi.fn(() => children.shift()! as unknown as ChildProcessWithoutNullStreams),
        display: () => ({ id: "1", name: "Display", width: 100, height: 100, x: 0, y: 0 }),
        toPhysicalPoint: (point) => point
      };
      const input = new DesktopRemoteDesktopInput(vi.fn(), runtime);
      const starting = input.start("1", new AbortController().signal);
      await vi.advanceTimersByTimeAsync(0);
      first.stdout.write("ready\n");
      await starting;
      input.stop();
      await vi.advanceTimersByTimeAsync(1_500);
      expect(first.kill).toHaveBeenCalledOnce();
      await expect(input.release()).rejects.toThrowError("REMOTE_DESKTOP_LOCK_FAILED");

      const restarting = input.start("1", new AbortController().signal);
      await vi.advanceTimersByTimeAsync(0);
      second.stdout.write("ready\n");
      await restarting;
      const release = expect(input.release()).rejects.toThrowError("REMOTE_DESKTOP_LOCK_FAILED");
      second.emit("exit", 0, null);
      second.emit("close", 0, null);
      await release;
      first.emit("close", 0, null);
      await expect(input.release()).resolves.toBeUndefined();
      await input.retire();
    } finally {
      vi.useRealTimers();
    }
  });
});

function lockRuntime(platform: NodeJS.Platform = "darwin"): DesktopRemoteDesktopLockRuntime {
  return {
    platform,
    resolveBinary: vi.fn(async () => "trusted-input-helper"),
    execute: vi.fn(async () => ({ stdout: "locked\n" }))
  };
}

it("privacy pause drains the actual helper and drops remote input until exact Cancel recovery", async () => {
  const first = inputChild(); const second = inputChild(); const children = [first, second];
  const runtime: DesktopRemoteDesktopInputRuntime = {
    platform: "darwin", resolveBinary: vi.fn(async () => "trusted-input-helper"),
    spawn: vi.fn(() => children.shift()! as unknown as ChildProcessWithoutNullStreams),
    display: () => ({ id: "1", name: "Display", width: 100, height: 100, x: 0, y: 0 }), toPhysicalPoint: (point) => point
  };
  const input = new DesktopRemoteDesktopInput(vi.fn(), runtime); const signal = new AbortController().signal;
  const starting = input.start("1", signal); await vi.waitFor(() => expect(runtime.spawn).toHaveBeenCalledOnce()); first.stdout.write("ready\n"); await starting;
  let paused = false; const pausing = input.pauseForPrivacy(() => true, signal).then((resume) => { paused = true; return resume; });
  input.send([{ kind: "key", code: "KeyJ", down: true }]);
  expect(first.stdin.read()?.toString()).toBe('[{"kind":"release"}]\n'); await Promise.resolve(); expect(paused).toBe(false);
  first.emit("close", 0, null); const resume = await pausing;
  const resuming = resume(); await vi.waitFor(() => expect(runtime.spawn).toHaveBeenCalledTimes(2)); second.stdout.write("ready\n"); await resuming;
  input.send([{ kind: "key", code: "KeyJ", down: true }]);
  await vi.waitFor(() => expect(second.stdin.read()?.toString()).toContain("KeyJ"));
  second.stdout.write("ok\n");
  const released = input.release(); second.emit("close", 0, null); await released;
});

it("privacy stale Cancel closure cannot start or stop a replacement helper", async () => {
  const first = inputChild(); const second = inputChild(); const children = [first, second];
  const runtime: DesktopRemoteDesktopInputRuntime = {
    platform: "darwin", resolveBinary: vi.fn(async () => "trusted-input-helper"),
    spawn: vi.fn(() => children.shift()! as unknown as ChildProcessWithoutNullStreams),
    display: () => ({ id: "1", name: "Display", width: 100, height: 100, x: 0, y: 0 }), toPhysicalPoint: (point) => point
  };
  const input = new DesktopRemoteDesktopInput(vi.fn(), runtime); const signal = new AbortController().signal;
  const starting = input.start("1", signal); await vi.waitFor(() => expect(runtime.spawn).toHaveBeenCalledOnce()); first.stdout.write("ready\n"); await starting;
  const pausing = input.pauseForPrivacy(() => true, signal); first.emit("close", 0, null); const oldResume = await pausing;
  const replacing = input.start("1", signal); await vi.waitFor(() => expect(runtime.spawn).toHaveBeenCalledTimes(2)); second.stdout.write("ready\n"); await replacing;
  await oldResume(); expect(runtime.spawn).toHaveBeenCalledTimes(2); expect(second.stdin.read()).toBeNull();
  const release = input.release(); second.emit("close", 0, null); await release;
});

it("privacy pause fails closed when fallback kill did not confirm actual helper release", async () => {
  vi.useFakeTimers();
  try {
    const child = inputChild(); const runtime: DesktopRemoteDesktopInputRuntime = {
      platform: "darwin", resolveBinary: vi.fn(async () => "trusted-input-helper"), spawn: () => child as unknown as ChildProcessWithoutNullStreams,
      display: () => ({ id: "1", name: "Display", width: 100, height: 100, x: 0, y: 0 }), toPhysicalPoint: (point) => point
    };
    const input = new DesktopRemoteDesktopInput(vi.fn(), runtime); const signal = new AbortController().signal;
    const starting = input.start("1", signal); await vi.advanceTimersByTimeAsync(0); child.stdout.write("ready\n"); await starting;
    const pausing = expect(input.pauseForPrivacy(() => true, signal)).rejects.toThrowError("REMOTE_DESKTOP_PRIVACY_FAILED");
    await vi.advanceTimersByTimeAsync(1500); await pausing; expect(child.kill).toHaveBeenCalledOnce();
    child.emit("close", 0, null); await input.retire();
  } finally { vi.useRealTimers(); }
});

function inputChild() {
  return Object.assign(new EventEmitter(), {
    pid: 77, exitCode: null, signalCode: null,
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    kill: vi.fn(() => true)
  });
}
