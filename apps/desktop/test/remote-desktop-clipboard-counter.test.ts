import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ app: {}, screen: {} }));
import { DesktopRemoteDesktopClipboardCounter } from "../src/remote-desktop-clipboard-counter.js";

describe("Desktop Remote Desktop counter-only owner", () => {
  afterEach(() => vi.useRealTimers());

  it("reuses a bounded pipe for counter reads and rejects unsupported content without exposing bytes", async () => {
    const value = fixture();
    const first = value.counter.read(false, value.signal);
    await flush();
    expect(value.children[0]!.stdin.read()?.toString()).toBe("1 0\n");
    value.children[0]!.stdout.write("1 18\n");
    await expect(first).resolves.toBe("18");
    const rich = value.counter.read(true, value.signal);
    await flush();
    expect(value.children[0]!.stdin.read()?.toString()).toBe("2 1\n");
    value.children[0]!.stdout.write("2 unsupported\n");
    await expect(rich).rejects.toThrowError("REMOTE_DESKTOP_CLIPBOARD_UNSUPPORTED");
    expect(value.spawn).toHaveBeenCalledOnce();
    value.counter.stop();
  });

  it("stop during preparation never spawns and a late old exit cannot retire a replacement", async () => {
    let prepared!: (binary: string) => void;
    const value = fixture();
    value.binary.mockImplementationOnce(() => new Promise((resolve) => { prepared = resolve; }));
    const pending = expect(value.counter.read(false, value.signal)).rejects.toThrowError("REMOTE_DESKTOP_CLIPBOARD_UNAVAILABLE");
    value.counter.stop();
    prepared("trusted-input-helper");
    await pending;
    expect(value.spawn).not.toHaveBeenCalled();
    const old = value.counter.read(false, value.signal);
    const oldOutcome = expect(old).rejects.toThrowError("REMOTE_DESKTOP_CLIPBOARD_UNAVAILABLE");
    await flush();
    value.counter.stop();
    await oldOutcome;
    const next = value.counter.read(false, value.signal);
    await flush();
    value.children[0]!.emit("exit", 0, null);
    value.children[1]!.stdout.write("3 29\n");
    await expect(next).resolves.toBe("29");
    expect(value.children[1]!.kill).not.toHaveBeenCalled();
    value.counter.stop();
  });

  it.each(["1 private-content\n", "9 22\n", "x".repeat(4_097)])("fails closed on malformed or unmatched output", async (output) => {
    const value = fixture();
    const outcome = expect(value.counter.read(false, value.signal)).rejects.toThrowError(/^REMOTE_DESKTOP_CLIPBOARD_UNAVAILABLE$/u);
    await flush();
    value.children[0]!.stdout.write(output);
    await outcome;
    expect(value.children[0]!.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("retires the captured pipe on cancellation and bounds pending queries, deadline and idle", async () => {
    vi.useFakeTimers();
    const value = fixture();
    const outcomes = Array.from({ length: 32 }, () => expect(value.counter.read(false, value.signal))
      .rejects.toThrowError("REMOTE_DESKTOP_CLIPBOARD_UNAVAILABLE"));
    await expect(value.counter.read(false, value.signal)).rejects.toThrowError("REMOTE_DESKTOP_CLIPBOARD_UNAVAILABLE");
    await vi.advanceTimersByTimeAsync(2_000);
    await Promise.all(outcomes);
    const command = new AbortController();
    const cancelled = expect(value.counter.read(false, command.signal)).rejects.toThrowError("REMOTE_DESKTOP_CLIPBOARD_UNAVAILABLE");
    await flush();
    command.abort();
    await cancelled;
    const idle = value.counter.read(false, value.signal);
    await flush();
    value.children[2]!.stdout.write("34 9\n");
    await idle;
    await vi.advanceTimersByTimeAsync(4_000);
    expect(value.children[2]!.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("keeps unsupported platforms and already aborted reads unavailable without preparation", async () => {
    const value = fixture("linux");
    await expect(value.counter.read(false, value.signal)).rejects.toThrowError("REMOTE_DESKTOP_CLIPBOARD_UNAVAILABLE");
    const command = new AbortController(); command.abort();
    await expect(value.counter.read(false, command.signal)).rejects.toThrowError("REMOTE_DESKTOP_CLIPBOARD_EXPIRED");
    expect(value.binary).not.toHaveBeenCalled();
  });

  it("Linux reads bounded system fingerprints and stop only retires the captured read occurrence", async () => {
    let complete!: (value: string) => void;
    const lower = { supports: () => true,
      version: vi.fn(async (_current: () => boolean, _signal: AbortSignal) => new Promise<string>(resolve => { complete = resolve; })),
      closePublishedWriter: vi.fn() };
    const counter = new DesktopRemoteDesktopClipboardCounter({ platform: "linux", resolveBinary: vi.fn(), spawn: vi.fn() }, lower);
    const signal = new AbortController().signal;
    const old = counter.read(true, signal);
    const outcome = expect(old).rejects.toThrowError("REMOTE_DESKTOP_CLIPBOARD_EXPIRED");
    expect(lower.version.mock.calls[0]![0]()).toBe(true);
    counter.stop();
    expect(lower.version.mock.calls[0]![1].aborted).toBe(true);
    expect(lower.version.mock.calls[0]![0]()).toBe(false);
    complete("a".repeat(64)); await outcome;
    lower.version.mockResolvedValueOnce("b".repeat(64));
    await expect(counter.read(false, signal)).resolves.toBe("b".repeat(64));
    expect(lower.closePublishedWriter).not.toHaveBeenCalled();
    lower.version.mockResolvedValueOnce("B".repeat(64));
    await expect(counter.read(true, signal)).rejects.toThrowError("REMOTE_DESKTOP_CLIPBOARD_UNAVAILABLE");
    counter.stop();
  });
});

function fixture(platform: NodeJS.Platform = "darwin") {
  const children: ReturnType<typeof child>[] = [];
  const binary = vi.fn(async () => "trusted-input-helper");
  const launch = vi.fn(() => { const value = child(); children.push(value); return value as unknown as ChildProcessWithoutNullStreams; });
  return { children, binary, spawn: launch, signal: new AbortController().signal,
    counter: new DesktopRemoteDesktopClipboardCounter({ platform, resolveBinary: binary, spawn: launch }) };
}
function child() {
  return Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });
}
async function flush(): Promise<void> { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); }
