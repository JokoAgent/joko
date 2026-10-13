import { ChildProcess } from "node:child_process";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("electron", () => ({ app: {} }));
import { DesktopRemoteDesktopLinuxAudio, type DesktopRemoteDesktopLinuxAudioRuntime } from "../src/remote-desktop-linux-audio.js";
import type { DesktopRemoteDesktopSessionState } from "../src/remote-desktop-input.js";

function child() {
  const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough();
  const stdio: [PassThrough, PassThrough, PassThrough] = [stdin, stdout, stderr];
  return { stdout, process: Object.assign(new ChildProcess(), { stdin, stdout, stderr, stdio, kill: vi.fn(() => true) }) };
}
function fixture() {
  const state: { session: DesktopRemoteDesktopSessionState; supported: boolean } = { session: "unlocked", supported: true };
  const children: ReturnType<typeof child>[] = [];
  const runtime: DesktopRemoteDesktopLinuxAudioRuntime = {
    supported: vi.fn(() => state.supported), session: vi.fn(async () => state.session), now: () => Date.now(),
    spawn: vi.fn(() => { const native = child(); children.push(native); return native.process; })
  };
  const owner = {}, abort = new AbortController();
  return { runtime, children, state, owner, abort, audio: new DesktopRemoteDesktopLinuxAudio(runtime) };
}
const current = () => true;
const signal = new AbortController().signal;
async function start(f: ReturnType<typeof fixture>) { await f.audio.start(f.owner, current, f.abort.signal); return f.children[0]!; }
async function close(f: ReturnType<typeof fixture>) {
  const pending = f.audio.stop(); for (const native of f.children) native.process.emit("close", 0, null); await pending;
}
afterEach(() => vi.useRealTimers());

describe("Linux default-output monitor PCM", () => {
  it("launches only the fixed sink monitor with f32 stereo 48k and no device, microphone or file", async () => {
    const f = fixture(); await start(f);
    expect(f.runtime.spawn).toHaveBeenCalledExactlyOnceWith("/usr/bin/pw-record", [
      "--raw", "--format", "f32", "--rate", "48000", "--channels", "2", "--latency", "20ms",
      "--properties", "{ stream.capture.sink=true node.name=joko-desktop-audio media.role=Screen }", "-"
    ]);
    expect(f.runtime.session).toHaveBeenCalledTimes(2); await close(f);
  });
  it.each(["locked-logged-in", "unknown", "unsupported"] as const)("requires an actual unlocked owned session rather than %s", async session => {
    const f = fixture(); f.state.session = session;
    await expect(f.audio.start(f.owner, current, signal)).rejects.toThrow(/^DESKTOP_AUDIO_UNAVAILABLE$/u);
    expect(f.runtime.spawn).not.toHaveBeenCalled();
  });
  it("contains an unavailable runtime and synchronous spawn failure without retaining native details", async () => {
    const f = fixture(); f.state.supported = false; expect(f.audio.supports()).toBe(false);
    await expect(f.audio.start({}, current, signal)).rejects.toThrow(/^DESKTOP_AUDIO_UNAVAILABLE$/u);
    expect(f.runtime.spawn).not.toHaveBeenCalled(); f.state.supported = true;
    vi.mocked(f.runtime.spawn).mockImplementationOnce(() => { throw new Error("private PipeWire diagnostics"); });
    await expect(f.audio.start({}, current, signal)).rejects.toThrow(/^DESKTOP_AUDIO_UNAVAILABLE$/u);
    await start(f); await close(f);
  });
  it("preserves partial frame alignment, drains complete frames and keeps only the newest 100ms", async () => {
    const f = fixture(), native = await start(f);
    native.stdout.write(Buffer.from([1, 2, 3])); expect(await f.audio.read(f.owner, current, signal)).toHaveLength(0);
    native.stdout.write(Buffer.from([4, 5, 6, 7, 8, 9]));
    expect([...await f.audio.read(f.owner, current, signal)]).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    native.stdout.write(Buffer.alloc(80_000, 42)); expect(await f.audio.read(f.owner, current, signal)).toHaveLength(38_392);
    native.stdout.write(Buffer.alloc(7, 43)); expect([...await f.audio.read(f.owner, current, signal)]).toEqual([42, 43, 43, 43, 43, 43, 43, 43]);
    expect(await f.audio.read(f.owner, current, signal)).toHaveLength(0); await close(f);
  });
  it("bounds a single oversized data callback without retaining its old PCM", async () => {
    const f = fixture(), native = await start(f); const chunk = Buffer.alloc(1_000_000); chunk.fill(42, chunk.length - 38_400);
    native.stdout.write(chunk); const bytes = await f.audio.read(f.owner, current, signal);
    expect(bytes).toHaveLength(38_400); expect(bytes.every(value => value === 42)).toBe(true); await close(f);
  });
  it("retires after more than three seconds without a reader and settles only on close", async () => {
    vi.useFakeTimers(); const f = fixture(), native = await start(f);
    await vi.advanceTimersByTimeAsync(3_000); expect(native.process.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000); expect(native.process.kill).toHaveBeenCalledOnce();
    const failure = expect(f.audio.read(f.owner, current, signal)).rejects.toThrow(/^DESKTOP_AUDIO_UNAVAILABLE$/u);
    native.process.emit("exit", 0, null); await Promise.resolve(); native.process.emit("close", 0, null); await failure;
  });
  it("retires after more than five seconds without data even while the renderer keeps reading", async () => {
    vi.useFakeTimers(); const f = fixture(), native = await start(f);
    for (let i = 0; i < 5; i++) { await f.audio.read(f.owner, current, signal); await vi.advanceTimersByTimeAsync(1_000); }
    expect(native.process.kill).not.toHaveBeenCalled(); await f.audio.read(f.owner, current, signal);
    native.stdout.write(Buffer.alloc(0)); await vi.advanceTimersByTimeAsync(1_000); expect(native.process.kill).toHaveBeenCalledOnce();
    native.process.emit("close", 0, null); await f.audio.stop();
  });
  it("does not count an empty chunk as data but refreshes the watchdog on real output", async () => {
    vi.useFakeTimers(); const f = fixture(), native = await start(f);
    for (let i = 0; i < 6; i++) {
      native.stdout.write(Buffer.alloc(8, 42)); expect(await f.audio.read(f.owner, current, signal)).toHaveLength(8);
      await vi.advanceTimersByTimeAsync(1_000);
    }
    expect(native.process.kill).not.toHaveBeenCalled(); await close(f);
  });
});

describe("Linux PCM exact owner and actual-close retirement", () => {
  it("clears old PCM and waits through kill and exit before a replacement can spawn", async () => {
    const f = fixture(), old = await start(f); old.stdout.write(Buffer.alloc(80, 42));
    let stopped = false; const stopping = f.audio.stop(f.owner).then(() => { stopped = true; });
    const replacement = {}; const starting = f.audio.start(replacement, current, signal);
    old.process.emit("exit", 0, null); await Promise.resolve(); expect(stopped).toBe(false); expect(f.runtime.spawn).toHaveBeenCalledOnce();
    old.stdout.write(Buffer.alloc(80, 42)); old.process.emit("close", 0, null); await stopping; await starting;
    const next = f.children[1]!; old.process.emit("error", new Error("late private diagnostics")); old.process.emit("exit", 0, null);
    next.stdout.write(Buffer.alloc(8, 43)); expect([...await f.audio.read(replacement, current, signal)]).toEqual(Array(8).fill(43));
    await f.audio.stop(f.owner); expect(next.process.kill).not.toHaveBeenCalled(); await close(f);
  });
  it("contains producer errors until actual close without exposing diagnostics or stopping a new owner", async () => {
    const f = fixture(), native = await start(f); native.stdout.write(Buffer.alloc(80, 42));
    native.process.emit("error", new Error("private native diagnostics"));
    const failure = expect(f.audio.read(f.owner, current, signal)).rejects.toThrow(/^DESKTOP_AUDIO_UNAVAILABLE$/u);
    expect(native.process.kill).toHaveBeenCalledOnce(); native.process.emit("close", 0, null); await failure;
    await f.audio.start({}, current, signal); await close(f);
  });
  it("does not spawn after an asynchronous session proof loses its owner", async () => {
    const f = fixture(); let owned = true, finish!: (state: DesktopRemoteDesktopSessionState) => void;
    vi.mocked(f.runtime.session).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const failure = expect(f.audio.start(f.owner, () => owned, signal)).rejects.toThrow(/^DESKTOP_AUDIO_UNAVAILABLE$/u);
    await vi.waitFor(() => expect(finish).toBeTypeOf("function")); owned = false; finish("unlocked"); await failure;
    expect(f.runtime.spawn).not.toHaveBeenCalled();
  });
  it("drops an old delayed startup proof without stopping the fresh replacement", async () => {
    const f = fixture(); let finish!: (state: DesktopRemoteDesktopSessionState) => void;
    vi.mocked(f.runtime.session).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const failure = expect(f.audio.start(f.owner, current, signal)).rejects.toThrow(/^DESKTOP_AUDIO_UNAVAILABLE$/u);
    await vi.waitFor(() => expect(finish).toBeTypeOf("function")); const replacement = {};
    await f.audio.start(replacement, current, signal); finish("unlocked"); await failure;
    expect(f.children[0]!.process.kill).not.toHaveBeenCalled(); await close(f);
  });
  it("checks actual session after spawn and preserves the native slot through LOCK until close", async () => {
    const f = fixture(); vi.mocked(f.runtime.session).mockResolvedValueOnce("unlocked").mockResolvedValueOnce("locked-logged-in");
    const failure = expect(f.audio.start(f.owner, current, signal)).rejects.toThrow(/^DESKTOP_AUDIO_UNAVAILABLE$/u);
    await vi.waitFor(() => expect(f.children).toHaveLength(1)); const native = f.children[0]!;
    await vi.waitFor(() => expect(native.process.kill).toHaveBeenCalledOnce()); native.process.emit("exit", 0, null);
    const starting = f.audio.start({}, current, signal); await Promise.resolve(); expect(f.runtime.spawn).toHaveBeenCalledOnce();
    native.process.emit("close", 0, null); await failure; await starting; await close(f);
  });
  it("drops PCM when the post-read fresh proof observes LOCK", async () => {
    const f = fixture(), native = await start(f); native.stdout.write(Buffer.alloc(80, 42));
    let finish!: (state: DesktopRemoteDesktopSessionState) => void;
    vi.mocked(f.runtime.session).mockResolvedValueOnce("unlocked").mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const failure = expect(f.audio.read(f.owner, current, signal)).rejects.toThrow(/^DESKTOP_AUDIO_UNAVAILABLE$/u);
    await vi.waitFor(() => expect(finish).toBeTypeOf("function")); finish("locked-logged-in");
    await vi.waitFor(() => expect(native.process.kill).toHaveBeenCalledOnce()); native.process.emit("close", 0, null); await failure;
  });
  it("does not deliver PCM after a read callback is revoked during its session receipt", async () => {
    const f = fixture(), native = await start(f); native.stdout.write(Buffer.alloc(80, 42));
    let owned = true, finish!: (state: DesktopRemoteDesktopSessionState) => void;
    vi.mocked(f.runtime.session).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const failure = expect(f.audio.read(f.owner, () => owned, signal)).rejects.toThrow(/^DESKTOP_AUDIO_UNAVAILABLE$/u);
    await vi.waitFor(() => expect(finish).toBeTypeOf("function")); owned = false; finish("unlocked");
    await vi.waitFor(() => expect(native.process.kill).toHaveBeenCalledOnce()); native.process.emit("close", 0, null); await failure;
  });
  it("retires on abort, joins complete-exit cleanup and permits a new occurrence after actual close", async () => {
    const f = fixture(), native = await start(f); native.stdout.write(Buffer.alloc(80, 42)); f.abort.abort();
    let stopped = false; const stopping = f.audio.stop().then(() => { stopped = true; });
    expect(native.process.kill).toHaveBeenCalledOnce(); await Promise.resolve(); expect(stopped).toBe(false);
    native.process.emit("close", 0, null); await stopping; const replacement = {};
    await f.audio.start(replacement, current, signal); expect(await f.audio.read(replacement, current, signal)).toHaveLength(0); await close(f);
  });
  it("retiring a replacement while it awaits old close cannot later launch it", async () => {
    const f = fixture(), old = await start(f), replacement = {};
    const failure = expect(f.audio.start(replacement, current, signal)).rejects.toThrow(/^DESKTOP_AUDIO_UNAVAILABLE$/u);
    await f.audio.stop(replacement); old.process.emit("close", 0, null); await failure;
    expect(f.runtime.spawn).toHaveBeenCalledOnce(); await f.audio.stop();
  });
  it("rejects unknown or reused owner identities without reading or retiring the active source", async () => {
    const f = fixture(), native = await start(f);
    await expect(f.audio.read({}, current, signal)).rejects.toThrow(/^DESKTOP_AUDIO_UNAVAILABLE$/u);
    await expect(f.audio.start(f.owner, current, signal)).rejects.toThrow(/^DESKTOP_AUDIO_UNAVAILABLE$/u);
    await f.audio.stop({}); expect(native.process.kill).not.toHaveBeenCalled(); await close(f);
  });
});
