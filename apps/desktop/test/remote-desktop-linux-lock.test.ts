import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ app: {} }));
import {
  lockDesktopRemoteDesktopLinuxScreen, supportsDesktopRemoteDesktopLinuxLock,
  type DesktopRemoteDesktopLinuxLockRuntime
} from "../src/remote-desktop-linux-lock.js";
import { readDesktopRemoteDesktopLinuxLockSessionState } from "../src/remote-desktop-linux.js";

const signal = (): AbortSignal => new AbortController().signal;
class LockChild extends EventEmitter {
  readonly stdout = new PassThrough(); readonly stderr = new PassThrough();
  readonly kill = vi.fn((_signal?: NodeJS.Signals) => true);
  receipt(value: string | Buffer = "ok\n", code = 0): void { this.stdout.write(value); this.emit("close", code, null); }
}
function fixture(portal = false) {
  const child = new LockChild();
  const environment: Record<string, string | undefined> = { XDG_SESSION_TYPE: "wayland", XDG_SESSION_ID: "4",
    WAYLAND_DISPLAY: "wayland-1", XDG_RUNTIME_DIR: "/run/user/1000", HYPRLAND_INSTANCE_SIGNATURE: portal ? undefined : "owned" };
  const state = { locked: false, hint: false, secure: false, passwordPam: true, shell: true, user: 1000 };
  const linux = {
    platform: "linux" as NodeJS.Platform, environment, uid: () => 1000, effectiveUid: () => 1000,
    executable: () => false,
    trustedExecutable: vi.fn(async (file: string) => file !== "/usr/bin/omarchy-shell" || state.shell),
    execute: vi.fn(async (file: string) => file === "/usr/bin/loginctl"
      ? `User=${state.user}\nActive=yes\nRemote=no\nType=wayland\nLockedHint=${state.hint ? "yes" : "no"}\n`
      : file === "/usr/bin/hyprctl" ? JSON.stringify([{ solitaryBlockedBy: state.locked ? ["LOCK"] : [] }])
        : JSON.stringify({ secure: state.secure, passwordPam: state.passwordPam, requested: true, locked: true }))
  };
  const runtime = { linux, session: vi.fn((signal: AbortSignal) => readDesktopRemoteDesktopLinuxLockSessionState(signal, linux)),
    spawn: vi.fn((_file: string, _arguments: readonly string[]) => child) } satisfies DesktopRemoteDesktopLinuxLockRuntime;
  const locked = (): void => { state.locked = true; state.hint = true; state.secure = true; };
  return { child, environment, state, runtime, locked };
}
beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe("Linux owned terminal screen lock", () => {
  it.each([false, true])("probes lock independently of capture, input and credentials: portal=%s", async portal => {
    const { runtime } = fixture(portal);
    await expect(supportsDesktopRemoteDesktopLinuxLock(signal(), runtime)).resolves.toBe(true);
    expect(runtime.spawn).not.toHaveBeenCalled();
    expect(runtime.linux.execute.mock.calls.every(([file]) => ["/usr/bin/loginctl", "/usr/bin/hyprctl", "/usr/bin/omarchy-shell"].includes(file)))
      .toBe(true);
    expect(runtime.linux.execute.mock.calls.some(([file]) => file === "/usr/bin/omarchy-shell")).toBe(!portal);
  });

  it.each(["darwin", "win32"] as const)("does not admit %s into the Linux writer", async platform => {
    const { runtime } = fixture(); runtime.linux.platform = platform;
    await expect(supportsDesktopRemoteDesktopLinuxLock(signal(), runtime)).resolves.toBe(false);
    await expect(lockDesktopRemoteDesktopLinuxScreen(() => true, signal(), runtime)).rejects.toThrow("REMOTE_DESKTOP_LOCK_UNAVAILABLE");
    expect(runtime.spawn).not.toHaveBeenCalled(); expect(runtime.linux.execute).not.toHaveBeenCalled();
  });

  it("rejects unowned sessions and untrusted commands before requesting a lock", async () => {
    const first = fixture(); first.state.user = 2000;
    await expect(supportsDesktopRemoteDesktopLinuxLock(signal(), first.runtime)).resolves.toBe(false);
    await expect(lockDesktopRemoteDesktopLinuxScreen(() => true, signal(), first.runtime)).rejects.toThrow("REMOTE_DESKTOP_LOCK_UNAVAILABLE");
    expect(first.runtime.spawn).not.toHaveBeenCalled();
    const second = fixture(); second.runtime.linux.trustedExecutable.mockResolvedValue(false);
    await expect(supportsDesktopRemoteDesktopLinuxLock(signal(), second.runtime)).resolves.toBe(false);
    expect(second.runtime.linux.execute).not.toHaveBeenCalled();
    const third = fixture(); third.runtime.linux.effectiveUid = () => 0;
    await expect(lockDesktopRemoteDesktopLinuxScreen(() => true, signal(), third.runtime)).rejects.toThrow("REMOTE_DESKTOP_LOCK_UNAVAILABLE");
    expect(third.runtime.spawn).not.toHaveBeenCalled();
  });

  it("waits for both secure status and actual compositor LOCK after the single shell request", async () => {
    const value = fixture(); let settled = false;
    const operation = lockDesktopRemoteDesktopLinuxScreen(() => true, signal(), value.runtime).then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(value.runtime.spawn).toHaveBeenCalledExactlyOnceWith("/usr/bin/omarchy-shell", ["lock", "lock"]);
    value.child.stdout.write("ok\n"); await vi.advanceTimersByTimeAsync(0); expect(settled).toBe(false);
    value.child.emit("close", 0, null); await vi.advanceTimersByTimeAsync(0); expect(settled).toBe(false);
    value.state.secure = true; value.state.hint = true;
    await vi.advanceTimersByTimeAsync(100); expect(settled).toBe(false);
    value.state.locked = true; await vi.advanceTimersByTimeAsync(100); await operation;
    expect(value.runtime.spawn).toHaveBeenCalledOnce();
  });

  it("accepts an already secure owned compositor without requiring password PAM or another write", async () => {
    const value = fixture(); value.locked(); value.state.passwordPam = false;
    await expect(supportsDesktopRemoteDesktopLinuxLock(signal(), value.runtime)).resolves.toBe(true);
    await lockDesktopRemoteDesktopLinuxScreen(() => true, signal(), value.runtime);
    expect(value.runtime.spawn).not.toHaveBeenCalled();
  });

  it("does not bypass an affirmative missing password PAM status with logind", async () => {
    const value = fixture(); value.state.passwordPam = false;
    await expect(supportsDesktopRemoteDesktopLinuxLock(signal(), value.runtime)).resolves.toBe(false);
    await expect(lockDesktopRemoteDesktopLinuxScreen(() => true, signal(), value.runtime)).rejects.toThrow("REMOTE_DESKTOP_LOCK_UNAVAILABLE");
    expect(value.runtime.spawn).not.toHaveBeenCalled();
  });

  it.each(["missing", "unreadable", "malformed"] as const)("uses logind only when the optional shell is %s", async condition => {
    const value = fixture(); const execute = value.runtime.linux.execute.getMockImplementation()!;
    if (condition === "missing") value.state.shell = false;
    value.runtime.linux.execute.mockImplementation(async file => {
      if (file === "/usr/bin/omarchy-shell" && condition !== "missing") {
        if (condition === "unreadable") throw new Error("private command diagnostic");
        return '{"secure":true}';
      }
      return execute(file);
    });
    const operation = lockDesktopRemoteDesktopLinuxScreen(() => true, signal(), value.runtime);
    await vi.advanceTimersByTimeAsync(0);
    expect(value.runtime.spawn).toHaveBeenCalledExactlyOnceWith("/usr/bin/loginctl", ["lock-session", "4"]);
    value.locked(); value.child.receipt(""); await operation;
  });

  it("confirms the fixed logind terminal receipt on portal Wayland without compositor or capture", async () => {
    const value = fixture(true); const operation = lockDesktopRemoteDesktopLinuxScreen(() => true, signal(), value.runtime);
    await vi.advanceTimersByTimeAsync(0);
    expect(value.runtime.spawn).toHaveBeenCalledExactlyOnceWith("/usr/bin/loginctl", ["lock-session", "4"]);
    value.state.hint = true; value.child.receipt(""); await operation;
    expect(value.runtime.linux.execute.mock.calls.every(([file]) => file === "/usr/bin/loginctl")).toBe(true);
  });

  it.each([false, true])("does not equate a successful request with a locked session: portal=%s", async portal => {
    const value = fixture(portal);
    const failure = expect(lockDesktopRemoteDesktopLinuxScreen(() => true, signal(), value.runtime)).rejects.toThrow("REMOTE_DESKTOP_LOCK_FAILED");
    await vi.advanceTimersByTimeAsync(0); value.child.receipt(portal ? "" : "ok\n");
    await vi.runAllTimersAsync(); await failure; expect(value.runtime.spawn).toHaveBeenCalledOnce();
  });

  it.each(["current", "abort", "session"] as const)("does not dispatch after %s retires during the optional probe", async retirement => {
    const value = fixture(); let current = true; const cancellation = new AbortController();
    const execute = value.runtime.linux.execute.getMockImplementation()!;
    value.runtime.linux.execute.mockImplementation(async file => {
      const raw = await execute(file);
      if (file === "/usr/bin/omarchy-shell") {
        if (retirement === "current") current = false;
        if (retirement === "abort") cancellation.abort(new Error("private cancellation reason"));
        if (retirement === "session") value.environment["XDG_SESSION_ID"] = "5";
      }
      return raw;
    });
    await expect(lockDesktopRemoteDesktopLinuxScreen(() => current, cancellation.signal, value.runtime)).rejects.toThrow("REMOTE_DESKTOP_LOCK_EXPIRED");
    expect(value.runtime.spawn).not.toHaveBeenCalled();
  });

  it("rechecks exact current after the final fresh session proof before spawn", async () => {
    const value = fixture(true); let current = true, proofs = 0;
    const session = value.runtime.session.getMockImplementation()!;
    value.runtime.session.mockImplementation(async signal => {
      const state = await session(signal); if (++proofs === 3) current = false; return state;
    });
    await expect(lockDesktopRemoteDesktopLinuxScreen(() => current, signal(), value.runtime)).rejects.toThrow("REMOTE_DESKTOP_LOCK_EXPIRED");
    expect(value.runtime.spawn).not.toHaveBeenCalled();
  });

  it.each(["abort", "timeout", "error"] as const)("retains the dispatched %s command through exit until actual close", async retirement => {
    const value = fixture(true), cancellation = new AbortController(); let settled = false;
    const failure = expect(lockDesktopRemoteDesktopLinuxScreen(() => true, cancellation.signal, value.runtime))
      .rejects.toThrow(retirement === "abort" ? "REMOTE_DESKTOP_LOCK_EXPIRED" : "REMOTE_DESKTOP_LOCK_FAILED")
      .then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(0);
    if (retirement === "abort") cancellation.abort();
    if (retirement === "timeout") await vi.advanceTimersByTimeAsync(3_000);
    if (retirement === "error") value.child.emit("error", new Error("private native stderr"));
    value.child.emit("exit", 0, null); await vi.advanceTimersByTimeAsync(0);
    expect(value.child.kill).toHaveBeenCalledExactlyOnceWith("SIGTERM"); expect(settled).toBe(false);
    const replacement = fixture(true);
    await expect(lockDesktopRemoteDesktopLinuxScreen(() => true, signal(), replacement.runtime)).rejects.toThrow("REMOTE_DESKTOP_LOCK_UNAVAILABLE");
    expect(replacement.runtime.spawn).not.toHaveBeenCalled();
    value.child.emit("close", 0, null); await failure;
    const next = lockDesktopRemoteDesktopLinuxScreen(() => true, signal(), replacement.runtime);
    await vi.advanceTimersByTimeAsync(0); replacement.state.hint = true; replacement.child.receipt(""); await next;
  });

  it.each(["missing-pam", "bad-utf8", "failed-close"] as const)("returns typed failure for %s and does not replay via logind", async receipt => {
    const value = fixture();
    const failure = expect(lockDesktopRemoteDesktopLinuxScreen(() => true, signal(), value.runtime)).rejects.toThrow("REMOTE_DESKTOP_LOCK_FAILED");
    await vi.advanceTimersByTimeAsync(0);
    value.child.receipt(receipt === "bad-utf8" ? Buffer.from([0xff]) : receipt === "missing-pam" ? "missing-pam" : "ok\n",
      receipt === "failed-close" ? 1 : 0);
    await failure; expect(value.runtime.spawn).toHaveBeenCalledOnce();
  });

  it("rejects cancellation during the actual lock acknowledgement even when its receipt becomes secure", async () => {
    const value = fixture(), cancellation = new AbortController();
    const failure = expect(lockDesktopRemoteDesktopLinuxScreen(() => true, cancellation.signal, value.runtime)).rejects.toThrow("REMOTE_DESKTOP_LOCK_EXPIRED");
    await vi.advanceTimersByTimeAsync(0); value.child.receipt(); await vi.advanceTimersByTimeAsync(0);
    const execute = value.runtime.linux.execute.getMockImplementation()!;
    value.runtime.linux.execute.mockImplementation(async file => {
      const raw = await execute(file); if (file === "/usr/bin/omarchy-shell") cancellation.abort(); return raw;
    });
    value.locked(); await vi.advanceTimersByTimeAsync(100); await failure;
    expect(value.runtime.spawn).toHaveBeenCalledOnce();
  });
});
