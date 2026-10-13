import { describe, expect, it, vi } from "vitest";
import { createMobileRemoteDesktopHostMutePreferenceStore } from "./mobile-remote-desktop-host-mute-preference";

const identity = { profileId: "profile-1", serverId: "server-1", controllerDeviceId: "phone-1", targetDeviceId: "desk-1" };

describe("Mobile Remote Desktop host mute preferences", () => {
  it("defaults off, reloads disk, and isolates profile, server, controller and target", async () => {
    const disk = new Map<string, string>();
    const storage = { getItem: async (key: string) => disk.get(key) ?? null,
      setItem: async (key: string, value: string) => { disk.set(key, value); } };
    const store = createMobileRemoteDesktopHostMutePreferenceStore(storage);
    expect(await store.load(identity)).toBe(false);
    await store.save(identity, true);
    expect(await createMobileRemoteDesktopHostMutePreferenceStore(storage).load(identity)).toBe(true);
    for (const field of ["profileId", "serverId", "controllerDeviceId", "targetDeviceId"] as const) {
      expect(await store.load({ ...identity, [field]: "other" })).toBe(false);
    }
    expect([...disk.values()]).toEqual([JSON.stringify({ version: 1, enabled: true })]);
  });

  it("rejects incomplete, old and extra-field shapes without rewriting storage", async () => {
    const setItem = vi.fn(async () => undefined);
    for (const raw of ['true', '{"enabled":true}', '{"version":0,"enabled":true}',
      '{"version":1,"enabled":true,"routeGeneration":"1"}', '{"version":1,"enabled":1}']) {
      const store = createMobileRemoteDesktopHostMutePreferenceStore({ getItem: async () => raw, setItem });
      await expect(store.load(identity)).rejects.toThrow();
    }
    expect(setItem).not.toHaveBeenCalled();
    expect(() => createMobileRemoteDesktopHostMutePreferenceStore({ getItem: async () => null, setItem })
      .load({ ...identity, targetDeviceId: "" })).toThrow("identity");
  });

  it("serializes writes and reads after them, and permits explicit retry after failure", async () => {
    let disk: string | null = null;
    let finish!: () => void;
    const setItem = vi.fn(async (_key: string, value: string) => {
      await new Promise<void>(resolve => { finish = resolve; }); disk = value;
    });
    const store = createMobileRemoteDesktopHostMutePreferenceStore({ getItem: async () => disk, setItem });
    const first = store.save(identity, true);
    const second = store.save(identity, false);
    const read = store.load(identity);
    await Promise.resolve();
    expect(setItem).toHaveBeenCalledTimes(1);
    finish(); await first; await Promise.resolve(); await Promise.resolve();
    expect(setItem).toHaveBeenCalledTimes(2);
    finish(); await second;
    expect(await read).toBe(false);
    setItem.mockRejectedValueOnce(new Error("disk full"));
    await expect(store.save(identity, true)).rejects.toThrow("disk full");
    expect(await store.load(identity)).toBe(false);
  });
});
