import { describe, expect, it, vi } from "vitest";
import { createMobileRemoteDesktopClipboardSyncPreferenceStore } from "./mobile-remote-desktop-clipboard-sync-preference";
import { createMobileRemoteDesktopHostMutePreferenceStore } from "./mobile-remote-desktop-host-mute-preference";

describe("Mobile Remote Desktop clipboard sync preferences", () => {
  const identity = { profileId: "profile-1", serverId: "server-1", controllerDeviceId: "phone-1", targetDeviceId: "desktop-1" };
  it("keeps clipboard sync default off and isolated from host mute, profile, server, controller and target", async () => {
    const disk = new Map<string, string>();
    const storage = { getItem: async (key: string) => disk.get(key) ?? null,
      setItem: async (key: string, raw: string) => { disk.set(key, raw); } };
    const store = createMobileRemoteDesktopClipboardSyncPreferenceStore(storage);
    expect(await store.load(identity)).toBe(false);
    await createMobileRemoteDesktopHostMutePreferenceStore(storage).save(identity, true);
    expect(await store.load(identity)).toBe(false);
    await store.save(identity, true);
    expect(await createMobileRemoteDesktopClipboardSyncPreferenceStore(storage).load(identity)).toBe(true);
    for (const field of ["profileId", "serverId", "controllerDeviceId", "targetDeviceId"] as const) {
      expect(await store.load({ ...identity, [field]: "other" })).toBe(false);
    }
  });
  it("rejects incompatible private data and surfaces persistence failures without adopting another shape", async () => {
    const setItem = vi.fn(async () => { throw new Error("disk full"); });
    for (const raw of ['true', '{"version":1,"enabled":true,"password":"invalid"}', '{"version":0,"enabled":true}']) {
      const store = createMobileRemoteDesktopClipboardSyncPreferenceStore({ getItem: async () => raw, setItem });
      await expect(store.load(identity)).rejects.toThrow();
    }
    expect(setItem).not.toHaveBeenCalled();
    const store = createMobileRemoteDesktopClipboardSyncPreferenceStore({ getItem: async () => null, setItem });
    await expect(store.save(identity, true)).rejects.toThrow("disk full");
    expect(await store.load(identity)).toBe(false);
  });
});
