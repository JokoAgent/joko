import { EventEmitter } from 'node:events';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { afterEach, expect, it, vi } from 'vitest';
import { watchDesktopRemoteDesktopPrivacyInput } from "../src/remote-desktop-privacy-input.js";

vi.mock("../src/remote-desktop-input.js", () => ({ resolveDesktopRemoteDesktopInputBinary: vi.fn() }));
afterEach(() => vi.useRealTimers());
function fixture() {
  const child = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: { resume() {} },
    stdin: Object.assign(new EventEmitter(), { write: vi.fn(), end: vi.fn(), writableLength: 0 }),
    kill: vi.fn(),
  });
  const local = vi.fn();
  const failed = vi.fn();
  const runtime = {
    resolveBinary: async () => '/helper',
    spawn: () => child as unknown as ChildProcessWithoutNullStreams,
  };
  const line = (text: string) => child.stdout.emit('data', Buffer.from(text));
  return { child, local, failed, runtime, line };
}

it('requires native acknowledgement and parses split status words without exposing event data', async () => {
  const f = fixture();
  const starting = watchDesktopRemoteDesktopPrivacyInput(f.local, f.failed, new AbortController().signal, f.runtime);
  await Promise.resolve();
  f.line('rea');
  f.line('dy\n');
  const monitor = await starting;
  f.line('local-in');
  f.line('put\n');
  expect(f.local).toHaveBeenCalledExactlyOnceWith();
  let confirmed = false;
  const confirming = monitor.confirm().then(() => {
    confirmed = true;
  });
  await Promise.resolve();
  expect(confirmed).toBe(false);
  expect(f.child.stdin.write).toHaveBeenLastCalledWith('confirm\n');
  f.line('confirmed\n');
  await confirming;
  const resuming = monitor.resume();
  f.line('ready\n');
  await resuming;
  monitor.stop();
  f.child.emit('exit');
  f.line('local-input\n');
  expect(f.local).toHaveBeenCalledOnce();
  expect(f.failed).not.toHaveBeenCalled();
});

it.each(['exit', 'timeout', 'oversized'])(
  'fails closed on %s during confirmation',
  async (mode) => {
    vi.useFakeTimers();
    const f = fixture();
    const starting = watchDesktopRemoteDesktopPrivacyInput(f.local, f.failed, new AbortController().signal, f.runtime);
    await Promise.resolve();
    f.line('ready\n');
    const monitor = await starting;
    const checking = expect(monitor.confirm()).rejects.toThrow('REMOTE_DESKTOP_PRIVACY_FAILED');
    if (mode === 'exit') f.child.emit('exit');
    else if (mode === 'oversized') f.line('a'.repeat(1025));
    else await vi.advanceTimersByTimeAsync(5000);
    await checking;
    expect(f.failed).toHaveBeenCalledOnce();
    expect(f.child.stdin.end).toHaveBeenCalledOnce();
    monitor.stop();
  },
);

it('waits for actual process close after EOF or fallback kill, including repeated stop', async () => {
  vi.useFakeTimers();
  const f = fixture();
  const starting = watchDesktopRemoteDesktopPrivacyInput(f.local, f.failed, new AbortController().signal, f.runtime);
  await Promise.resolve();
  f.line('ready\n');
  const monitor = await starting;
  let closed = false;
  const stopping = monitor.stop();
  expect(monitor.stop()).toBe(stopping);
  void stopping.then(() => {
    closed = true;
  });
  expect(f.child.stdin.end).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(1000);
  expect(f.child.kill).toHaveBeenCalledOnce();
  expect(closed).toBe(false);
  f.child.emit('exit');
  await Promise.resolve();
  expect(closed).toBe(false);
  f.child.emit('close');
  await stopping;
  expect(closed).toBe(true);
  expect(f.failed).not.toHaveBeenCalled();
});

it("privacy cancellation before preparation prevents any native spawn", async () => {
  const f = fixture(); const command = new AbortController(); command.abort();
  const spawn = vi.fn(f.runtime.spawn);
  await expect(watchDesktopRemoteDesktopPrivacyInput(f.local, f.failed, command.signal, { ...f.runtime, spawn }))
    .rejects.toThrowError("REMOTE_DESKTOP_PRIVACY_EXPIRED");
  expect(spawn).not.toHaveBeenCalled();
});

it("privacy cancellation after preparation rechecks authority before native spawn", async () => {
  const f = fixture(); const command = new AbortController(); const spawn = vi.fn(f.runtime.spawn);
  await expect(watchDesktopRemoteDesktopPrivacyInput(f.local, f.failed, command.signal, {
    ...f.runtime, spawn, resolveBinary: async () => { command.abort(); return "/helper"; }
  })).rejects.toThrowError("REMOTE_DESKTOP_PRIVACY_EXPIRED");
  expect(spawn).not.toHaveBeenCalled();
});

it("privacy aborted initialization retains the unknown hook until actual process close", async () => {
  const f = fixture(); const command = new AbortController(); let settled = false;
  const ending = expect(watchDesktopRemoteDesktopPrivacyInput(f.local, f.failed, command.signal, f.runtime)
    .finally(() => { settled = true; })).rejects.toThrowError("REMOTE_DESKTOP_PRIVACY_EXPIRED");
  await Promise.resolve(); command.abort(); await Promise.resolve();
  expect(f.child.stdin.end).toHaveBeenCalledOnce(); expect(settled).toBe(false);
  f.child.emit("exit"); await Promise.resolve(); expect(settled).toBe(false);
  f.child.emit("close"); await ending; expect(f.failed).not.toHaveBeenCalled();
});
