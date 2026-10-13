import { expect, it, vi } from "vitest";
vi.mock("electron", () => ({ app: {} }));
import { readDesktopRemoteDesktopLinuxCredentialLockState,
  type DesktopRemoteDesktopLinuxCredentialsRuntime } from "../src/remote-desktop-linux-credentials.js";

function fixture(platform: NodeJS.Platform = "linux") {
  const execute = vi.fn<DesktopRemoteDesktopLinuxCredentialsRuntime["linux"]["execute"]>()
    .mockResolvedValueOnce("supported\n").mockResolvedValueOnce("locked\n");
  const trusted = vi.fn(async () => true); const script = vi.fn(async () => "/owned/main.py");
  const runtime: DesktopRemoteDesktopLinuxCredentialsRuntime = { script, linux: { platform, environment: {},
    uid: () => 1000, effectiveUid: () => 1000, executable: () => true, trustedExecutable: trusted, execute } };
  return { runtime, execute, trusted, script };
}
it("probes exact isolated dependencies and locker state without a credential helper or vault", async () => {
  const value = fixture(); const signal = new AbortController().signal;
  expect(await readDesktopRemoteDesktopLinuxCredentialLockState(signal, value.runtime)).toBe("locked");
  expect(value.trusted).toHaveBeenCalledExactlyOnceWith("/usr/bin/python3");
  expect(value.execute.mock.calls).toEqual([
    ["/usr/bin/python3", ["-I", "-B", "-u", "/owned/main.py", "--support"], signal, 1024, 6000],
    ["/usr/bin/python3", ["-I", "-B", "-u", "/owned/main.py", "--lock-state"], signal, 1024, 6000]
  ]);
});
it("keeps missing dependencies, unknown locker, untrusted interpreter and other platforms unavailable", async () => {
  for (const state of ["unavailable", "unexpected", "unlocked"]) {
    const value = fixture(); value.execute.mockReset().mockResolvedValueOnce("supported").mockResolvedValueOnce(state);
    expect(await readDesktopRemoteDesktopLinuxCredentialLockState(new AbortController().signal, value.runtime))
      .toBe(state === "unlocked" ? "unlocked" : "unavailable");
  }
  const missing = fixture(); missing.execute.mockReset().mockResolvedValue("unavailable");
  expect(await readDesktopRemoteDesktopLinuxCredentialLockState(new AbortController().signal, missing.runtime)).toBe("unavailable");
  expect(missing.execute).toHaveBeenCalledOnce();
  const untrusted = fixture(); untrusted.trusted.mockResolvedValue(false);
  expect(await readDesktopRemoteDesktopLinuxCredentialLockState(new AbortController().signal, untrusted.runtime)).toBe("unavailable");
  expect(untrusted.script).not.toHaveBeenCalled(); expect(untrusted.execute).not.toHaveBeenCalled();
  const other = fixture("win32");
  expect(await readDesktopRemoteDesktopLinuxCredentialLockState(new AbortController().signal, other.runtime)).toBe("unavailable");
  expect(other.trusted).not.toHaveBeenCalled();
});
it("does not consume a stale dependency or locker receipt after cancellation", async () => {
  const value = fixture(), abort = new AbortController(); const reason = new Error("retired");
  value.execute.mockReset().mockImplementation(async () => { abort.abort(reason); return "supported"; });
  await expect(readDesktopRemoteDesktopLinuxCredentialLockState(abort.signal, value.runtime)).rejects.toBe(reason);
  expect(value.execute).toHaveBeenCalledOnce();
});
