import { describe, expect, it } from "vitest";

import {
  MobilePushDeviceStore,
  mobilePushDeviceStoreTesting,
  type MobilePushStoredRegistration
} from "./mobile-push-device-store";

function memoryStore(initial: Readonly<Record<string, string>> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    driver: {
      getItem: async (key: string) => values.get(key) ?? null,
      setItem: async (key: string, value: string) => { values.set(key, value); }
    }
  };
}

function registration(patch: Partial<MobilePushStoredRegistration> = {}): MobilePushStoredRegistration {
  return {
    profileId: "profile-1",
    origin: "https://node.example.test",
    serverId: "server-1",
    connectionId: "connection-1",
    deviceId: "device-1",
    registrationId: "registration-1",
    secret: "s".repeat(43),
    environment: "sandbox",
    locale: "en",
    tokenDigest: "a".repeat(64),
    confirmed: false,
    expiresAt: 0,
    ...patch
  };
}

describe("MobilePushDeviceStore", () => {
  it("defaults off and keeps revocation credentials only in secure storage", async () => {
    const plain = memoryStore();
    const secure = memoryStore();
    const store = new MobilePushDeviceStore(plain.driver, {
      isAvailable: async () => true,
      ...secure.driver
    });
    expect(await store.hydrate()).toEqual({ enabled: false, registrations: [] });
    await store.setEnabled(true);
    await store.putRegistration(registration());
    expect(plain.values.get(mobilePushDeviceStoreTesting.enabledKey)).toBe("1");
    expect(JSON.stringify([...plain.values.values()])).not.toContain("registration-1");
    expect(secure.values.get(mobilePushDeviceStoreTesting.registrationsKey)).toContain("registration-1");
    expect(store.snapshot.registrations[0]).toMatchObject({ confirmed: false, expiresAt: 0 });
  });

  it("fails closed on malformed or non-current records instead of dropping a ticket", async () => {
    for (const raw of [
      "not-json",
      JSON.stringify({ version: 2, registrations: [] }),
      JSON.stringify({ version: 1, registrations: [{ ...registration(), extra: true }] }),
      JSON.stringify({ version: 1, registrations: [{ ...registration(), origin: "https://user@node.example.test" }] })
    ]) {
      const plain = memoryStore({ [mobilePushDeviceStoreTesting.enabledKey]: "1" });
      const secure = memoryStore({ [mobilePushDeviceStoreTesting.registrationsKey]: raw });
      const store = new MobilePushDeviceStore(plain.driver, { isAvailable: async () => true, ...secure.driver });
      await expect(store.hydrate()).rejects.toThrow(/notification/u);
    }
  });

  it("durably replaces only the same profile and removes one exact ticket", async () => {
    const plain = memoryStore();
    const secure = memoryStore();
    const store = new MobilePushDeviceStore(plain.driver, { isAvailable: async () => true, ...secure.driver });
    await store.hydrate();
    await store.putRegistration(registration());
    await store.putRegistration(registration({ tokenDigest: "b".repeat(64), confirmed: true, expiresAt: 99 }));
    await store.putRegistration(registration({
      profileId: "profile-2",
      serverId: "server-2",
      connectionId: "connection-2",
      deviceId: "device-2",
      registrationId: "registration-2",
      secret: "t".repeat(43)
    }));
    expect(store.snapshot.registrations).toHaveLength(2);
    expect(store.snapshot.registrations[0]).toMatchObject({ tokenDigest: "b".repeat(64), confirmed: true });
    await store.removeRegistration("server-1", "registration-1");
    expect(store.snapshot.registrations.map((item) => item.registrationId)).toEqual(["registration-2"]);
  });

  it("does not read or publish state when secure storage is unavailable", async () => {
    const plain = memoryStore();
    const secure = memoryStore();
    const store = new MobilePushDeviceStore(plain.driver, { isAvailable: async () => false, ...secure.driver });
    await expect(store.hydrate()).rejects.toThrow(/Secure/u);
    expect(() => store.snapshot).toThrow(/not been loaded/u);
  });
});
