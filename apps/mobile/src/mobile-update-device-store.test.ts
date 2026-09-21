import { describe, expect, it, vi } from "vitest";
import { MobileUpdateDeviceStore, mobileUpdateDeviceStorageKey } from "./mobile-update-device-store";

describe("MobileUpdateDeviceStore", () => {
  it("hydrates only the exact current device-private record", async () => {
    const storage = driver(JSON.stringify({
      version: 1,
      channel: "beta",
      reloadTargetId: "update-one",
      reloadCount: 1
    }));
    const store = new MobileUpdateDeviceStore(storage);
    await store.hydrate();
    expect(store.snapshot).toEqual({
      status: "ready",
      channel: "beta",
      reloadTargetId: "update-one",
      reloadCount: 1
    });
  });

  it.each([
    "not-json",
    JSON.stringify({ version: 0, channel: "stable", reloadTargetId: null, reloadCount: 0 }),
    JSON.stringify({ version: 1, channel: "canary", reloadTargetId: null, reloadCount: 0 }),
    JSON.stringify({ version: 1, channel: "stable", reloadTargetId: null, reloadCount: 1 }),
    JSON.stringify({ version: 1, channel: "stable", reloadTargetId: "id", reloadCount: 0 }),
    JSON.stringify({ version: 1, channel: "stable", reloadTargetId: null, reloadCount: 0, legacy: true })
  ])("fails explicitly for a non-current record: %s", async (raw) => {
    const store = new MobileUpdateDeviceStore(driver(raw));
    await expect(store.hydrate()).rejects.toThrow("saved mobile update settings");
    expect(store.snapshot).toMatchObject({ status: "error", channel: "stable", reloadCount: 0 });
  });

  it("serializes channel and reload mutations without overwriting either result", async () => {
    const storage = driver();
    const store = new MobileUpdateDeviceStore(storage);
    await store.hydrate();
    await Promise.all([store.setChannel("beta"), store.recordReload("update-one")]);
    expect(JSON.parse(storage.value()!)).toEqual({
      version: 1,
      channel: "beta",
      reloadTargetId: "update-one",
      reloadCount: 1
    });
    await store.recordReload("update-one");
    await store.recordReload("update-one");
    expect(store.isReloadBlocked("update-one")).toBe(true);
    expect(store.snapshot.reloadCount).toBe(2);
    await store.cancelReload("update-one");
    expect(store.snapshot.reloadCount).toBe(1);
    await store.cancelReload("update-one");
    expect(store.snapshot).toEqual({ status: "ready", channel: "beta", reloadCount: 0 });
  });

  it("clears a reload guard only after that exact update actually launches", async () => {
    const storage = driver(JSON.stringify({
      version: 1, channel: "stable", reloadTargetId: "update-one", reloadCount: 2
    }));
    const store = new MobileUpdateDeviceStore(storage);
    await store.hydrate();
    await store.clearReloadIfLaunched("update-two");
    expect(store.snapshot.reloadTargetId).toBe("update-one");
    await store.clearReloadIfLaunched("update-one");
    expect(store.snapshot).toEqual({ status: "ready", channel: "stable", reloadCount: 0 });
  });

  it("can replace an unreadable record with a clean current record", async () => {
    const storage = driver("bad");
    const store = new MobileUpdateDeviceStore(storage);
    await expect(store.hydrate()).rejects.toThrow();
    await store.reset();
    expect(storage.setItem).toHaveBeenCalledWith(mobileUpdateDeviceStorageKey,
      JSON.stringify({ version: 1, channel: "stable", reloadTargetId: null, reloadCount: 0 }));
    expect(store.snapshot).toEqual({ status: "ready", channel: "stable", reloadCount: 0 });
  });
});

function driver(initial: string | null = null) {
  let value = initial;
  return {
    getItem: vi.fn(async () => value),
    setItem: vi.fn(async (_key: string, next: string) => { value = next; }),
    value: () => value
  };
}
