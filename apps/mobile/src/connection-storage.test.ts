import { describe, expect, it } from "vitest";
import {
  createMobileStorage,
  type MobilePlainStorageDriver,
  type MobileSecureStorageDriver
} from "./connection-storage";
import type { PairedCredential } from "./network";

const first: PairedCredential = {
  profileId: "profile-one",
  origin: "http://192.168.1.20:4318",
  serverId: "node-one",
  connectionId: "connection-one",
  deviceId: "device-one",
  displayName: "Phone one",
  authKey: "credential-one"
};

const second: PairedCredential = {
  profileId: "profile-two",
  origin: "https://node.home.arpa:4318",
  serverId: "node-two",
  connectionId: "connection-two",
  deviceId: "device-two",
  displayName: "Phone two",
  authKey: "credential-two"
};

function drivers() {
  const plainValues = new Map<string, string>();
  const secureValues = new Map<string, string>();
  let available = true;
  let failProfileWrite = false;
  const plain: MobilePlainStorageDriver = {
    async getItem(key) { return plainValues.get(key) ?? null; },
    async setItem(key, value) {
      if (failProfileWrite && key === "joko.mobile.connection-profiles.v1") {
        failProfileWrite = false;
        throw new Error("plain storage interrupted");
      }
      plainValues.set(key, value);
    },
    async removeItem(key) { plainValues.delete(key); }
  };
  const secure: MobileSecureStorageDriver = {
    async isAvailable() { return available; },
    async getItem(key) {
      if (!available) throw new Error("secure storage unavailable");
      return secureValues.get(key) ?? null;
    },
    async setItem(key, value) {
      if (!available) throw new Error("secure storage unavailable");
      secureValues.set(key, value);
    },
    async removeItem(key) {
      if (!available) throw new Error("secure storage unavailable");
      secureValues.delete(key);
    }
  };
  return {
    plain,
    secure,
    plainValues,
    secureValues,
    setAvailable(value: boolean) { available = value; },
    interruptNextProfileWrite() { failProfileWrite = true; }
  };
}

describe("current-v1 mobile connection storage", () => {
  it("does not read the retired single-credential or boolean automatic-entry shapes", async () => {
    const memory = drivers();
    memory.secureValues.set("joko.mobile.credential.v1", JSON.stringify(first));
    memory.plainValues.set("joko.mobile.automatic-entry.v1", "true");
    memory.plainValues.set("joko.mobile.selection.v1", "session-old");
    const storage = createMobileStorage(memory.plain, memory.secure);

    await expect(storage.loadConnectionIndex()).resolves.toEqual({ profiles: [] });
    await expect(storage.loadCredential(first.profileId)).resolves.toBeUndefined();
    await expect(storage.loadSelection(first.profileId)).resolves.toBeUndefined();
  });

  it("keeps multiple exact profiles, credentials, selections, and one exact automatic target", async () => {
    const memory = drivers();
    const storage = createMobileStorage(memory.plain, memory.secure);

    await storage.saveConnection(first);
    await storage.saveConnection(second);
    await storage.saveSelection(first.profileId, "session-one");
    await storage.saveSelection(second.profileId, "session-two");
    await storage.saveAutomaticProfile(second.profileId);

    await expect(storage.loadConnectionIndex()).resolves.toMatchObject({
      profiles: [
        { profileId: first.profileId, connectionId: first.connectionId },
        { profileId: second.profileId, connectionId: second.connectionId }
      ],
      automaticProfileId: second.profileId
    });
    await expect(storage.loadCredential(first.profileId)).resolves.toEqual(first);
    await expect(storage.loadCredential(second.profileId)).resolves.toEqual(second);
    await expect(storage.loadSelection(first.profileId)).resolves.toBe("session-one");
    await expect(storage.loadSelection(second.profileId)).resolves.toBe("session-two");

    await storage.deleteConnection(second.profileId);
    await expect(storage.loadConnectionIndex()).resolves.toEqual({ profiles: [expect.objectContaining({ profileId: first.profileId })] });
    await expect(storage.loadCredential(first.profileId)).resolves.toEqual(first);
    await expect(storage.loadCredential(second.profileId)).resolves.toBeUndefined();
  });

  it("preserves the public profile and automatic target when protected storage is unavailable", async () => {
    const memory = drivers();
    const storage = createMobileStorage(memory.plain, memory.secure);
    await storage.saveConnection(first);
    await storage.saveAutomaticProfile(first.profileId);
    memory.setAvailable(false);

    await expect(storage.loadConnectionIndex()).resolves.toMatchObject({
      profiles: [expect.objectContaining({ profileId: first.profileId })],
      automaticProfileId: first.profileId
    });
    await expect(storage.loadCredential(first.profileId)).rejects.toMatchObject({
      name: "MobileCredentialStorageError",
      failure: "unavailable"
    });
    await expect(storage.deleteConnection(first.profileId)).rejects.toMatchObject({
      name: "MobileCredentialStorageError",
      failure: "unavailable"
    });
    await expect(storage.loadConnectionIndex()).resolves.toMatchObject({
      profiles: [expect.objectContaining({ profileId: first.profileId })],
      automaticProfileId: first.profileId
    });
  });

  it("reports a damaged credential without deleting its profile or automatic target", async () => {
    const memory = drivers();
    const storage = createMobileStorage(memory.plain, memory.secure);
    await storage.saveConnection(first);
    await storage.saveAutomaticProfile(first.profileId);
    memory.secureValues.set(`joko.mobile.connection-credential.v1.${first.profileId}`, "{damaged");

    await expect(storage.loadCredential(first.profileId)).rejects.toMatchObject({
      failure: "unreadable"
    });
    await expect(storage.loadConnectionIndex()).resolves.toMatchObject({
      profiles: [expect.objectContaining({ profileId: first.profileId })],
      automaticProfileId: first.profileId
    });
  });

  it("recovers an interrupted credential-to-profile commit from its current-v1 write intent", async () => {
    const memory = drivers();
    const storage = createMobileStorage(memory.plain, memory.secure);
    memory.interruptNextProfileWrite();

    await expect(storage.saveConnection(first)).rejects.toThrow("plain storage interrupted");
    expect(memory.secureValues.has(`joko.mobile.connection-credential.v1.${first.profileId}`)).toBe(true);
    expect(memory.plainValues.has("joko.mobile.connection-mutation-intent.v1")).toBe(true);

    await expect(storage.loadConnectionIndex()).resolves.toEqual({
      profiles: [expect.objectContaining({ profileId: first.profileId, connectionId: first.connectionId })]
    });
    expect(memory.plainValues.has("joko.mobile.connection-mutation-intent.v1")).toBe(false);
  });

  it("finishes an interrupted exact deletion before exposing its public index", async () => {
    const memory = drivers();
    const storage = createMobileStorage(memory.plain, memory.secure);
    await storage.saveConnection(first);
    await storage.saveAutomaticProfile(first.profileId);
    memory.interruptNextProfileWrite();

    await expect(storage.deleteConnection(first.profileId)).rejects.toThrow("plain storage interrupted");
    expect(memory.secureValues.has(`joko.mobile.connection-credential.v1.${first.profileId}`)).toBe(false);
    expect(memory.plainValues.has("joko.mobile.connection-mutation-intent.v1")).toBe(true);

    await expect(storage.loadConnectionIndex()).resolves.toEqual({ profiles: [] });
    expect(memory.plainValues.has("joko.mobile.connection-mutation-intent.v1")).toBe(false);
  });

  it("refuses to write an automatic target that is not an exact saved profile", async () => {
    const memory = drivers();
    const storage = createMobileStorage(memory.plain, memory.secure);
    await expect(storage.saveAutomaticProfile("missing-profile")).rejects.toThrow(/not saved/);
    await expect(storage.loadConnectionIndex()).resolves.toEqual({ profiles: [] });
  });
});
