import { describe, expect, it, vi } from "vitest";
import { createMobileRemoteDesktopPrivacyPreferenceStore } from "./mobile-remote-desktop-privacy-preference";
import { createMobileRemoteDesktopHostMutePreferenceStore } from "./mobile-remote-desktop-host-mute-preference";

describe("Mobile Remote Desktop privacy preferences", () => {
  const identity = { profileId: "profile", serverId: "node", controllerDeviceId: "phone", targetDeviceId: "desktop" };
  it("defaults off, serializes saves and isolates exact target and owner fields from other settings", async () => {
    const disk = new Map<string, string>();
    const storage = { getItem: async (key: string) => disk.get(key) ?? null, setItem: async (key: string, raw: string) => { disk.set(key, raw); } };
    const store = createMobileRemoteDesktopPrivacyPreferenceStore(storage);
    expect(await store.load(identity)).toBe(false);
    await createMobileRemoteDesktopHostMutePreferenceStore(storage).save(identity, true);
    expect(await store.load(identity)).toBe(false);
    await Promise.all([store.save(identity, true), store.save(identity, false), store.save(identity, true)]);
    expect(await createMobileRemoteDesktopPrivacyPreferenceStore(storage).load(identity)).toBe(true);
    for (const field of ["profileId", "serverId", "controllerDeviceId", "targetDeviceId"] as const) {
      expect(await store.load({ ...identity, [field]: "other" })).toBe(false);
    }
  });
  it("preserves incompatible data on load and adopts only an explicit successful save", async () => {
    let raw = '{"version":0,"enabled":true}';
    const setItem = vi.fn(async (_key: string, next: string) => { raw = next; });
    const store = createMobileRemoteDesktopPrivacyPreferenceStore({ getItem: async () => raw, setItem });
    await expect(store.load(identity)).rejects.toThrow(); expect(setItem).not.toHaveBeenCalled();
    setItem.mockRejectedValueOnce(new Error("disk full")); await expect(store.save(identity, true)).rejects.toThrow("disk full");
    expect(raw).toBe('{"version":0,"enabled":true}');
    await store.save(identity, false); expect(await store.load(identity)).toBe(false);
  });
});
