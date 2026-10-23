import { Code, ConnectError } from "@connectrpc/connect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMobileDirectoryReadRecovery, isRecoverableMobileDirectoryRead, readMobileDirectory } from "./mobile-directory-read-recovery";

afterEach(() => vi.useRealTimers());

describe("foreground directory read recovery", () => {
  it("settles a stalled read at ten seconds and retires a transport that ignores cancellation", async () => {
    vi.useFakeTimers();
    let complete!: (value: string) => void;
    const abort = new AbortController();
    const read = readMobileDirectory(abort.signal, () => new Promise<string>(resolve => { complete = resolve; }));
    const failed = expect(read).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(9_999);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1); await failed;
    complete("late"); await Promise.resolve();
    expect(vi.getTimerCount()).toBe(0);
    const pending = new AbortController();
    const cancelled = readMobileDirectory(pending.signal, () => new Promise(() => {}));
    const rejection = expect(cancelled).rejects.toThrow(); pending.abort(); await rejection;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("backs off only transient reads, resets after success and cancels on owner retirement", async () => {
    vi.useFakeTimers();
    let current = true;
    const retry = vi.fn(), recovery = createMobileDirectoryReadRecovery(retry, () => current);
    recovery.failed(new ConnectError("Not authorized", Code.PermissionDenied));
    recovery.failed(new ConnectError("Revoked", Code.Unauthenticated));
    recovery.failed(new Error("The source identity changed."));
    expect(vi.getTimerCount()).toBe(0);
    recovery.failed(new TypeError("Failed to fetch")); recovery.failed(new Error("Network offline"));
    await vi.advanceTimersByTimeAsync(899); expect(retry).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); expect(retry).toHaveBeenCalledTimes(1);
    recovery.failed(new ConnectError("Disconnected", Code.Unavailable));
    await vi.advanceTimersByTimeAsync(1_799); expect(retry).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); expect(retry).toHaveBeenCalledTimes(2);
    recovery.succeeded(); recovery.failed(new Error("Network offline"));
    await vi.advanceTimersByTimeAsync(900); expect(retry).toHaveBeenCalledTimes(3);
    recovery.failed(new Error("Network offline")); current = false;
    await vi.advanceTimersByTimeAsync(30_000); expect(retry).toHaveBeenCalledTimes(3);
    current = true; recovery.failed(new Error("Network offline")); recovery.dispose();
    expect(vi.getTimerCount()).toBe(0);
    expect(isRecoverableMobileDirectoryRead(new ConnectError("Wait", Code.DeadlineExceeded))).toBe(true);
  });
});
