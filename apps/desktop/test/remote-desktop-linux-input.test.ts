import { ChildProcess } from "node:child_process";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
vi.mock("electron", () => ({ app: {}, screen: {} }));
import { DesktopRemoteDesktopInput, type DesktopRemoteDesktopInputRuntime } from "../src/remote-desktop-input.js";

function child() {
  const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough();
  const stdio: [PassThrough, PassThrough, PassThrough] = [stdin, stdout, stderr];
  return { stdin, stdout, process: Object.assign(new ChildProcess(), { stdin, stdout, stderr, stdio, kill: vi.fn(() => true) }) };
}
const monitor = { name: "DP-1", width: 1920, height: 1080, x: -960, y: 0, scale: 2, transform: 0 };
function runtime(native = child()): DesktopRemoteDesktopInputRuntime {
  return { platform: "linux", resolveBinary: vi.fn(async () => "/trusted/input"), spawn: vi.fn(() => native.process),
    display: () => undefined, toPhysicalPoint: point => point,
    linuxSupport: vi.fn(async () => true), linuxSession: vi.fn(async () => "unlocked" as const),
    linuxMonitors: vi.fn(async () => [monitor, { ...monitor, name: "DP-2", x: 0 }]) };
}
async function start(input: DesktopRemoteDesktopInput, native: ReturnType<typeof child>, deps: DesktopRemoteDesktopInputRuntime) {
  const pending = input.start("hyprland:DP-2", new AbortController().signal);
  await vi.waitFor(() => expect(deps.spawn).toHaveBeenCalledOnce()); native.stdout.write("ready\n"); await pending;
}
describe("Linux actual input receipt and held-state release", () => {
  it("keeps a failed registry probe or locked session view-only without spawning devices", async () => {
    const deps = runtime(); const input = new DesktopRemoteDesktopInput(vi.fn(), deps);
    vi.mocked(deps.linuxSupport!).mockResolvedValue(false);
    await expect(input.start("hyprland:DP-1", new AbortController().signal)).rejects.toThrow("INPUT_UNAVAILABLE");
    vi.mocked(deps.linuxSupport!).mockResolvedValue(true); vi.mocked(deps.linuxSession!).mockResolvedValue("locked-logged-in");
    await expect(input.start("hyprland:DP-1", new AbortController().signal)).rejects.toThrow("INPUT_UNAVAILABLE");
    expect(deps.spawn).not.toHaveBeenCalled();
  });
  it("maps the chosen output over the full layout and serializes writes by actual ok receipt", async () => {
    const native = child(), deps = runtime(native), input = new DesktopRemoteDesktopInput(vi.fn(), deps); await start(input, native, deps);
    const written: string[] = []; native.stdin.on("data", bytes => written.push(bytes.toString()));
    input.send([{ kind: "move", x: 0, y: 0 }]); input.send([{ kind: "key", code: "KeyJ", down: true }]);
    await vi.waitFor(() => expect(written).toHaveLength(1));
    expect(JSON.parse(written[0]!)).toEqual([{ kind: "move", x: 0.5, y: 0 }]);
    native.stdout.write("ok\n"); await vi.waitFor(() => expect(written).toHaveLength(2));
    expect(written[1]).toContain("KeyJ"); native.stdout.write("ok\n");
    const ending = input.release(); native.process.emit("close", 0, null); await ending;
  });
  it("splits text by Unicode scalars without truncating surrogate pairs", async () => {
    const native = child(), deps = runtime(native), input = new DesktopRemoteDesktopInput(vi.fn(), deps); await start(input, native, deps);
    let written = ""; native.stdin.on("data", bytes => { written += bytes.toString(); });
    input.send([{ kind: "text", text: "😀".repeat(300) }]); await vi.waitFor(() => expect(written).not.toBe(""));
    const events: { kind: string; text: string }[] = JSON.parse(written);
    expect(events.map(event => Array.from(event.text).length)).toEqual([256, 44]);
    expect(events.map(event => event.text).join("")).toBe("😀".repeat(300));
    native.stdout.write("ok\n"); const ending = input.release(); native.process.emit("close", 0, null); await ending;
  });
  it.each(["lock", "layout"] as const)("rechecks %s before dispatch and releases held input on failure", async condition => {
    const native = child(), deps = runtime(native), failure = vi.fn(), input = new DesktopRemoteDesktopInput(failure, deps); await start(input, native, deps);
    if (condition === "lock") vi.mocked(deps.linuxSession!).mockResolvedValue("locked-logged-in");
    else vi.mocked(deps.linuxMonitors!).mockResolvedValue([{ ...monitor, x: 1 }]);
    let written = ""; native.stdin.on("data", bytes => { written += bytes.toString(); });
    input.send([{ kind: "key", code: "KeyJ", down: true }]); await vi.waitFor(() => expect(failure).toHaveBeenCalledOnce());
    expect(written).toBe('[{"kind":"release"}]\n');
    native.process.emit("close", 0, null); await input.release();
  });
  it("does not dispatch keys when actual LOCK arrives during a delayed directory receipt", async () => {
    const native = child(), deps = runtime(native), failure = vi.fn(), input = new DesktopRemoteDesktopInput(failure, deps); await start(input, native, deps);
    let directory!: () => void;
    vi.mocked(deps.linuxMonitors!).mockImplementationOnce(() => new Promise(resolve => {
      directory = () => resolve([monitor, { ...monitor, name: "DP-2", x: 0 }]);
    }));
    let written = ""; native.stdin.on("data", bytes => { written += bytes.toString(); });
    input.send([{ kind: "key", code: "KeyJ", down: true }]);
    await vi.waitFor(() => expect(directory).toBeTypeOf("function"));
    vi.mocked(deps.linuxSession!).mockResolvedValue("locked-logged-in"); directory();
    await vi.waitFor(() => expect(failure).toHaveBeenCalledOnce()); expect(written).toBe('[{"kind":"release"}]\n');
    native.process.emit("close", 0, null); await input.release();
  });
  it("does not let an obsolete start directory overwrite the replacement layout", async () => {
    const native = child(), deps = runtime(native), input = new DesktopRemoteDesktopInput(vi.fn(), deps);
    let directory!: () => void;
    vi.mocked(deps.linuxMonitors!).mockImplementationOnce(() => new Promise(resolve => {
      directory = () => resolve([monitor, { ...monitor, name: "DP-2", x: 500 }]);
    }));
    const previous = expect(input.start("hyprland:DP-2", new AbortController().signal)).rejects.toThrow("LEASE_EXPIRED");
    await vi.waitFor(() => expect(directory).toBeTypeOf("function")); await start(input, native, deps);
    directory(); await previous;
    let written = ""; native.stdin.on("data", bytes => { written += bytes.toString(); });
    input.send([{ kind: "move", x: 0, y: 0 }]); await vi.waitFor(() => expect(written).not.toBe(""));
    expect(JSON.parse(written)).toEqual([{ kind: "move", x: 0.5, y: 0 }]);
    native.stdout.write("ok\n"); const ending = input.release(); native.process.emit("close", 0, null); await ending;
  });
  it("does not release or spawn a replacement after kill or exit until exact actual close", async () => {
    const first = child(), second = child(), deps = runtime(first); vi.mocked(deps.spawn).mockReturnValueOnce(first.process).mockReturnValueOnce(second.process);
    const input = new DesktopRemoteDesktopInput(vi.fn(), deps); await start(input, first, deps);
    vi.useFakeTimers();
    try {
      let released = false; const release = input.release().then(() => { released = true; });
      await vi.advanceTimersByTimeAsync(1500); expect(first.process.kill).toHaveBeenCalledOnce();
      first.process.emit("exit", 0, null); await Promise.resolve(); expect(released).toBe(false);
      const replacement = input.start("hyprland:DP-2", new AbortController().signal); await vi.advanceTimersByTimeAsync(0);
      expect(deps.spawn).toHaveBeenCalledOnce(); first.stdout.write("ok\n"); first.process.emit("close", 0, null);
      await release; await vi.advanceTimersByTimeAsync(0); expect(deps.spawn).toHaveBeenCalledTimes(2);
      second.stdout.write("ready\n"); await replacement;
      const ending = input.release(); second.process.emit("close", 0, null); await ending;
    } finally { vi.useRealTimers(); }
  });
  it("bounds queued input while an actual receipt is outstanding", async () => {
    const native = child(), deps = runtime(native), failure = vi.fn(), input = new DesktopRemoteDesktopInput(failure, deps); await start(input, native, deps);
    input.send([{ kind: "key", code: "KeyJ", down: true }]);
    await vi.waitFor(() => expect(native.stdin.read()?.toString()).toContain("KeyJ"));
    expect(() => input.send([{ kind: "text", text: "😀".repeat(10000) }])).toThrow("INPUT_UNAVAILABLE");
    expect(failure).toHaveBeenCalledOnce(); native.process.emit("close", 0, null); await input.release();
  });

  it("restores a paused helper for remote privacy off only after actual close and skips an unpaused restart", async () => {
    const first = child(), second = child(), deps = runtime(first), failure = vi.fn();
    vi.mocked(deps.spawn).mockReturnValueOnce(first.process).mockReturnValueOnce(second.process);
    const input = new DesktopRemoteDesktopInput(failure, deps); await start(input, first, deps);
    const signal = new AbortController().signal; let privacyCurrent = true;
    const pause = expect(input.pauseForPrivacy(() => privacyCurrent, signal)).rejects.toThrow("PRIVACY_EXPIRED");
    privacyCurrent = false;
    const resumed = input.resumeAfterPrivacy("hyprland:DP-2", () => true, signal);
    first.process.emit("exit", 0, null); await Promise.resolve();
    expect(deps.spawn).toHaveBeenCalledOnce();
    first.process.emit("close", 0, null); await pause;
    await vi.waitFor(() => expect(deps.spawn).toHaveBeenCalledTimes(2)); second.stdout.write("ready\n"); await resumed;
    await input.resumeAfterPrivacy("hyprland:DP-2", () => false, signal);
    expect(deps.spawn).toHaveBeenCalledTimes(2);
    input.send([{ kind: "key", code: "KeyJ", down: true }]);
    await vi.waitFor(() => expect(second.stdin.read()?.toString()).toContain("KeyJ"));
    second.stdout.write("ok\n");
    expect(failure).not.toHaveBeenCalled();
    const ending = input.release(); second.process.emit("close", 0, null); await ending;
  });

  it.each(["current", "abort"] as const)("refuses privacy input recovery before native work when %s retires", async retirement => {
    const native = child(), deps = runtime(native), failure = vi.fn(), input = new DesktopRemoteDesktopInput(failure, deps);
    await start(input, native, deps);
    const pause = input.pauseForPrivacy(() => true, new AbortController().signal);
    native.process.emit("close", 0, null); await pause;
    const cancellation = new AbortController(); if (retirement === "abort") cancellation.abort();
    await expect(input.resumeAfterPrivacy("hyprland:DP-2", () => retirement !== "current", cancellation.signal))
      .rejects.toThrow("PRIVACY_EXPIRED");
    expect(deps.spawn).toHaveBeenCalledOnce(); expect(deps.resolveBinary).toHaveBeenCalledOnce();
    expect(failure).not.toHaveBeenCalled(); await input.release();
  });

  it("joins its own late recovery close after current retires without keeping injected input alive", async () => {
    const first = child(), second = child(), deps = runtime(first), failure = vi.fn();
    vi.mocked(deps.spawn).mockReturnValueOnce(first.process).mockReturnValueOnce(second.process);
    const input = new DesktopRemoteDesktopInput(failure, deps); await start(input, first, deps);
    const pause = input.pauseForPrivacy(() => true, new AbortController().signal);
    first.process.emit("close", 0, null); await pause;
    let current = true, settled = false;
    const failureReceipt = expect(input.resumeAfterPrivacy("hyprland:DP-2", () => current, new AbortController().signal))
      .rejects.toThrow("PRIVACY_EXPIRED").then(() => { settled = true; });
    await vi.waitFor(() => expect(deps.spawn).toHaveBeenCalledTimes(2)); current = false; second.stdout.write("ready\n");
    await vi.waitFor(() => expect(second.stdin.read()?.toString()).toBe('[{"kind":"release"}]\n'));
    expect(settled).toBe(false); second.process.emit("close", 0, null); await failureReceipt;
    expect(failure).not.toHaveBeenCalled(); await input.release();
  });

  it("does not stop a replacement when the retired privacy recovery's directory arrives late", async () => {
    const first = child(), second = child(), deps = runtime(first), failure = vi.fn();
    vi.mocked(deps.spawn).mockReturnValueOnce(first.process).mockReturnValueOnce(second.process);
    const input = new DesktopRemoteDesktopInput(failure, deps); await start(input, first, deps);
    const pause = input.pauseForPrivacy(() => true, new AbortController().signal);
    first.process.emit("close", 0, null); await pause;
    let directory!: () => void, current = true;
    vi.mocked(deps.resolveBinary).mockImplementationOnce(() => new Promise(resolve => { directory = () => resolve("/trusted/input"); }));
    const expired = expect(input.resumeAfterPrivacy("hyprland:DP-2", () => current, new AbortController().signal)).rejects.toThrow("LEASE_EXPIRED");
    await vi.waitFor(() => expect(directory).toBeTypeOf("function"));
    const replacing = input.start("hyprland:DP-2", new AbortController().signal);
    await vi.waitFor(() => expect(deps.spawn).toHaveBeenCalledTimes(2)); second.stdout.write("ready\n"); await replacing;
    current = false; directory(); await expired;
    expect(second.stdin.read()).toBeNull(); expect(failure).not.toHaveBeenCalled();
    const ending = input.release(); second.process.emit("close", 0, null); await ending;
  });

  it("uses the existing input failure path when privacy recovery cannot resolve the helper", async () => {
    const native = child(), deps = runtime(native), failure = vi.fn(), input = new DesktopRemoteDesktopInput(failure, deps);
    await start(input, native, deps);
    const pause = input.pauseForPrivacy(() => true, new AbortController().signal);
    native.process.emit("close", 0, null); await pause;
    vi.mocked(deps.resolveBinary).mockRejectedValueOnce(new Error("REMOTE_DESKTOP_INPUT_UNAVAILABLE"));
    await expect(input.resumeAfterPrivacy("hyprland:DP-2", () => true, new AbortController().signal)).rejects.toThrow("INPUT_UNAVAILABLE");
    expect(failure).toHaveBeenCalledOnce(); expect(deps.spawn).toHaveBeenCalledOnce();
    await input.resumeAfterPrivacy("hyprland:DP-2", () => true, new AbortController().signal);
    expect(deps.spawn).toHaveBeenCalledOnce(); await input.release();
  });

  it("keeps a rejected privacy recovery ready receipt retired until actual helper close", async () => {
    const first = child(), second = child(), deps = runtime(first), failure = vi.fn();
    vi.mocked(deps.spawn).mockReturnValueOnce(first.process).mockReturnValueOnce(second.process);
    const input = new DesktopRemoteDesktopInput(failure, deps); await start(input, first, deps);
    const pause = input.pauseForPrivacy(() => true, new AbortController().signal);
    first.process.emit("close", 0, null); await pause;
    const unavailable = expect(input.resumeAfterPrivacy("hyprland:DP-2", () => true, new AbortController().signal))
      .rejects.toThrow("INPUT_UNAVAILABLE");
    await vi.waitFor(() => expect(deps.spawn).toHaveBeenCalledTimes(2)); second.stdout.write("unsupported\n"); await unavailable;
    expect(failure).not.toHaveBeenCalled(); expect(second.stdin.read()?.toString()).toBe('[{"kind":"release"}]\n');
    let released = false; const ending = input.release().then(() => { released = true; });
    await Promise.resolve(); expect(released).toBe(false);
    second.process.emit("close", 0, null); await ending;
  });
});
