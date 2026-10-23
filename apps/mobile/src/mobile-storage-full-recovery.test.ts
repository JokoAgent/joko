import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";
import { createMobileStorageFullRecovery } from "./mobile-storage-full-recovery";

describe("local message storage capacity", () => {
  it("reclaims only after SQLite reports full, retries the same local bytes once and retains other failures", async () => {
    const full = new Error("database or disk is full (SQLITE_FULL)"), reclaim = vi.fn(async () => undefined);
    const write = vi.fn().mockRejectedValueOnce(full).mockResolvedValueOnce(undefined);
    const save = createMobileStorageFullRecovery(write, reclaim, () => "Local storage is full.");
    await save("draft-owner", "unchanged input");
    expect(reclaim).toHaveBeenCalledOnce(); expect(write.mock.calls).toEqual([["draft-owner", "unchanged input"], ["draft-owner", "unchanged input"]]);
    write.mockRejectedValue(full);
    await expect(save("pending-receipt", "same operation")).rejects.toThrow("Local storage is full.");
    expect(write).toHaveBeenCalledTimes(4);
    const failure = new Error("storage unavailable"); write.mockRejectedValueOnce(failure);
    await expect(save("draft-owner", "still retained")).rejects.toBe(failure);
    expect(reclaim).toHaveBeenCalledTimes(2);
  });

  it("shares concurrent cache reclamation without combining different draft writes", async () => {
    let done!: () => void;
    const reclaim = vi.fn(() => new Promise<void>(resolve => { done = resolve; }));
    const attempts = new Map<string, number>();
    const write = vi.fn(async (key: string) => { attempts.set(key, (attempts.get(key) ?? 0) + 1); if (attempts.get(key) === 1) throw new Error("SQLITE_FULL"); });
    const save = createMobileStorageFullRecovery(write, reclaim, () => "Full");
    const first = save("one", "first input"), second = save("two", "second input");
    await vi.waitFor(() => expect(reclaim).toHaveBeenCalledOnce()); done(); await Promise.all([first, second]);
    expect(write.mock.calls).toEqual([["one", "first input"], ["two", "second input"], ["one", "first input"], ["two", "second input"]]);
  });

  it("applies the 64 MiB Android budget to the native Expo Gradle property without duplicating it", async () => {
    const require = createRequire(import.meta.url);
    const plugin = require("../with-joko-storage-budget.cjs");
    const config = plugin({ name: "Joko", slug: "joko" });
    const properties = [{ type: "property", key: "AsyncStorage_db_size_in_MB", value: "6" }, { type: "property", key: "unrelated", value: "keep" }];
    const result = await config.mods.android.gradleProperties({ modResults: properties });
    expect(result.modResults).toEqual([{ type: "property", key: "AsyncStorage_db_size_in_MB", value: "64" }, { type: "property", key: "unrelated", value: "keep" }]);
    expect(plugin.setMobileStorageBudget(result.modResults)).toHaveLength(2);
  });
});
