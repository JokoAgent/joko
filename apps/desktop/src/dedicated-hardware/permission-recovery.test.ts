import { describe, expect, it, vi } from "vitest";
import { createDedicatedHardwarePermissionRecovery } from "./permission-recovery.js";

describe("dedicated hardware permission recovery", () => {
  it("retries once after returning from macOS Settings and once per screen unlock", async () => {
    const retry = vi.fn();
    const recovery = createDedicatedHardwarePermissionRecovery({ platform: "darwin", retry,
      openSettings: async () => true });
    recovery.applicationFocused();
    expect(retry).not.toHaveBeenCalled();
    expect(await recovery.openSettings()).toBe(true);
    recovery.applicationFocused();
    recovery.applicationFocused();
    expect(retry).toHaveBeenCalledOnce();
    recovery.screenUnlocked();
    expect(retry).toHaveBeenCalledTimes(2);
  });

  it("does not retain a failed settings launch or apply macOS recovery to another platform", async () => {
    const retry = vi.fn();
    const openSettings = vi.fn(async () => { throw new Error("unavailable"); });
    const recovery = createDedicatedHardwarePermissionRecovery({ platform: "darwin", retry, openSettings });
    expect(await recovery.openSettings()).toBe(false);
    recovery.applicationFocused();
    expect(retry).not.toHaveBeenCalled();
    const other = createDedicatedHardwarePermissionRecovery({ platform: "win32", retry, openSettings });
    expect(await other.openSettings()).toBe(false);
    other.screenUnlocked();
    other.applicationFocused();
    expect(openSettings).toHaveBeenCalledOnce();
    expect(retry).not.toHaveBeenCalled();
  });
});
