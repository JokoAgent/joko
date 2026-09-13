import { rmSync } from "node:fs";
import { mkdtempSync } from "./test-paths.js";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { OperationalStore } from "@joko/store";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ConnectionAuthenticationError, ConnectionManager, PairingRequestError } from "./connection-manager.js";

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

describe("ConnectionManager", () => {
  it("announces out-of-band pairing codes, consumes them once, and enforces revocation", () => {
    const directory = mkdtempSync(join(tmpdir(), "joko-connection-manager-"));
    const store = new OperationalStore(join(directory, "orchestrator.db"), { now: () => 1_000 });
    cleanups.push(() => {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    });
    const manager = new ConnectionManager(store, { now: () => 1_000, pairingTtlMs: 60_000 });
    const announcements: string[] = [];
    const unsubscribe = manager.onPairingIssued((challenge) => announcements.push(challenge.code));

    const consoleChallenge = manager.issuePairing("console");
    const remoteChallenge = manager.issuePairing("web");
    expect(announcements).toEqual([consoleChallenge.code, remoteChallenge.code]);

    const paired = manager.completePairing({
      challengeId: remoteChallenge.id,
      code: consoleChallenge.code,
      connectionName: "Browser"
    });
    expect(manager.authenticate(`Bearer ${paired.authKey}`).id).toBe(paired.connection.id);
    expect(() => manager.completePairing({
      challengeId: consoleChallenge.id,
      code: consoleChallenge.code,
      connectionName: "Replay"
    })).toThrowError(ConnectionAuthenticationError);

    manager.revoke(paired.connection.id);
    expect(() => manager.authenticate(`Bearer ${paired.authKey}`)).toThrowError(ConnectionAuthenticationError);
    unsubscribe();
    manager.issuePairing("silent");
    expect(announcements).toHaveLength(2);
  });

  it("requires an owner window and bounds unauthenticated pairing persistence", () => {
    const directory = mkdtempSync(join(tmpdir(), "joko-pairing-window-"));
    let now = 1_000;
    const store = new OperationalStore(join(directory, "orchestrator.db"), { now: () => now });
    cleanups.push(() => {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    });
    const manager = new ConnectionManager(store, {
      now: () => now,
      pairingTtlMs: 2_000,
      pairingWindowMs: 10_000,
      pairingRateWindowMs: 1_000,
      maxPairingRequests: 2,
      maxOutstandingPairings: 2,
      consumedRetentionMs: 1_000
    });

    expect(() => manager.requestPairing("closed")).toThrowError(PairingRequestError);
    manager.openPairingWindow();
    manager.requestPairing("one");
    manager.requestPairing("two");
    expect(() => manager.requestPairing("rate limited")).toThrow(/rate/u);

    now += 1_001;
    expect(() => manager.requestPairing("at capacity")).toThrow(/outstanding/u);
    now += 1_000;
    manager.requestPairing("after prune");
    expect(store.listPairings()).toHaveLength(1);

    manager.closePairingWindow();
    expect(() => manager.requestPairing("closed again")).toThrow(/not currently enabled/u);
  });

  it("applies the same rate and outstanding limits to trusted local pairing issuance", () => {
    const directory = mkdtempSync(join(tmpdir(), "joko-trusted-pairing-limit-"));
    const store = new OperationalStore(join(directory, "orchestrator.db"), { now: () => 1_000 });
    cleanups.push(() => {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    });
    const manager = new ConnectionManager(store, {
      now: () => 1_000,
      maxPairingRequests: 1,
      maxOutstandingPairings: 1
    });

    const challenge = manager.issuePairing("Trusted local owner");
    expect(challenge.expiresAt).toBeGreaterThan(1_000);
    const restartedManager = new ConnectionManager(store, {
      now: () => 1_000,
      maxPairingRequests: 1,
      maxOutstandingPairings: 1
    });
    expect(() => restartedManager.issuePairing("Trusted local owner again"))
      .toThrowError(PairingRequestError);
    expect(store.listDiagnostics({ component: "connection" })).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "TRUSTED_LOCAL_PAIRING_ISSUED",
        details: expect.objectContaining({ challengeId: challenge.id })
      })
    ]));
    expect(JSON.stringify(store.listDiagnostics().map((item) => ({ message: item.message, details: item.details }))))
      .not.toContain(challenge.code);
  });

  it("rate limits CompletePairing attempts in bounded memory without disclosing the limiter", () => {
    const directory = mkdtempSync(join(tmpdir(), "joko-pairing-attempt-limit-"));
    let now = 1_000;
    const store = new OperationalStore(join(directory, "orchestrator.db"), { now: () => now });
    cleanups.push(() => {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    });
    const manager = new ConnectionManager(store, {
      now: () => now,
      pairingTtlMs: 60_000,
      pairingAttemptWindowMs: 1_000,
      maxPairingAttempts: 2
    });
    const challenge = manager.issuePairing("Orchestrator local CLI");
    const attempt = (code: string): unknown => {
      try {
        manager.completePairing({ challengeId: "", code, connectionName: "Browser" });
      } catch (error) {
        return error;
      }
      return undefined;
    };

    const firstInvalid = attempt("not-a-pairing-code");
    const secondInvalid = attempt("still-not-a-pairing-code");
    // Even a correct code is rejected after the bounded window fills, and the
    // caller cannot distinguish that state from an invalid/expired/used code.
    const rateLimited = attempt(challenge.code);
    for (const error of [firstInvalid, secondInvalid, rateLimited]) {
      expect(error).toMatchObject({
        name: "ConnectionAuthenticationError",
        code: "PAIRING_INVALID",
        message: "The pairing code is invalid, expired, or already used."
      });
    }

    now += 1_001;
    const paired = manager.completePairing({
      challengeId: "",
      code: challenge.code,
      connectionName: "Browser"
    });
    expect(manager.authenticate(`Bearer ${paired.authKey}`).id).toBe(paired.connection.id);
  });

  it("completes a CLI-issued challenge without a BeginPairing challenge ID as a new normal Device", () => {
    const directory = mkdtempSync(join(tmpdir(), "joko-cli-pairing-recovery-"));
    const store = new OperationalStore(join(directory, "orchestrator.db"), { now: () => 5_000 });
    cleanups.push(() => {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    });
    const manager = new ConnectionManager(store, { now: () => 5_000 });
    const challenge = manager.issuePairing("Orchestrator local CLI");

    const paired = manager.completePairing({
      challengeId: "",
      code: challenge.code,
      connectionName: "Recovered browser",
      device: {
        name: "Recovered browser",
        kind: "web",
        platform: "test",
        appVersion: "0.1.0"
      }
    });

    expect(paired.connection).toMatchObject({
      name: "Recovered browser",
      state: "active"
    });
    expect(store.getDevice(paired.connection.deviceId)).toMatchObject({
      name: "Recovered browser",
      kind: "web",
      platform: "test",
      appVersion: "0.1.0",
      state: "active"
    });
    expect(store.listDevices()).toHaveLength(1);
    expect(manager.authenticate(`Bearer ${paired.authKey}`).id).toBe(paired.connection.id);
  });

  it("fences streams without touching activity and closes every connection revoked with a device", () => {
    const directory = mkdtempSync(join(tmpdir(), "joko-connection-device-fence-"));
    let now = 1_000;
    const store = new OperationalStore(join(directory, "orchestrator.db"), { now: () => now });
    cleanups.push(() => {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    });
    const manager = new ConnectionManager(store, { now: () => now });
    const firstChallenge = manager.issuePairing("Desktop", {
      id: "device-shared",
      name: "Desktop",
      kind: "desktop",
      platform: "windows",
      appVersion: "1"
    });
    const first = manager.completePairing({
      challengeId: firstChallenge.id,
      code: firstChallenge.code,
      connectionName: "First"
    });
    const secondChallenge = manager.issuePairing("Desktop secondary", {
      id: "device-shared",
      name: "Desktop",
      kind: "desktop",
      platform: "windows",
      appVersion: "1"
    });
    const second = manager.completePairing({
      challengeId: secondChallenge.id,
      code: secondChallenge.code,
      connectionName: "Second"
    });
    const revoked: string[] = [];
    manager.onRevoked(first.connection.id, () => revoked.push(first.connection.id));
    manager.onRevoked(second.connection.id, () => revoked.push(second.connection.id));

    now = 2_000;
    const authenticated = manager.authenticate(`Bearer ${first.authKey}`);
    expect(authenticated.lastSeenAt).toBe(2_000);
    const revision = authenticated.revision;
    now = 3_000;
    expect(manager.fence(authenticated).revision).toBe(revision);
    expect(store.getConnection(authenticated.id).lastSeenAt).toBe(2_000);

    manager.revokeDevice("device-shared");
    expect(revoked.sort()).toEqual([first.connection.id, second.connection.id].sort());
    expect(() => manager.fence(authenticated)).toThrowError(ConnectionAuthenticationError);
    expect(() => manager.authenticate(`Bearer ${second.authKey}`)).toThrowError(ConnectionAuthenticationError);
  });

  it("issues a normal revocable credential only after a trusted Desktop bootstrap", () => {
    const directory = mkdtempSync(join(tmpdir(), "joko-trusted-desktop-"));
    const store = new OperationalStore(join(directory, "orchestrator.db"), { now: () => 5_000 });
    cleanups.push(() => {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    });
    const manager = new ConnectionManager(store, { now: () => 5_000 });
    const instanceId = "4e56f4d8-c6ee-4a17-9a89-56e059b7e592";
    const nextInstanceId = "10f42a3c-9fa4-4941-a419-6fa47a128597";
    const deviceId = "d6a365ef-ef33-4fb7-a0f1-a02eb57fef75";

    const issued = manager.issueTrustedDesktopConnection({
      desktopInstanceId: instanceId,
      desktopDeviceId: deviceId,
      deviceName: "Joko Desktop",
      platform: "win32",
      appVersion: "0.1.0"
    });

    expect(issued.connection.id).toBe(`desktop-connection_${instanceId}`);
    expect(issued.connection.deviceId).toBe(deviceId);
    expect(store.getDevice(issued.connection.deviceId)).toMatchObject({
      name: "Joko Desktop",
      kind: "desktop",
      platform: "win32",
      appVersion: "0.1.0"
    });
    expect(store.listPairings()).toEqual([]);
    expect(manager.confirmTrustedDesktopConnection(issued.connection.id, issued.authKey).id).toBe(issued.connection.id);
    expect(store.listConnections().every((connection) => connection.authKeyDigest !== issued.authKey)).toBe(true);

    expect(() => manager.issueTrustedDesktopConnection({
      desktopInstanceId: "a482cafa-4d69-48dc-9203-57e41f72d6fc",
      desktopDeviceId: deviceId,
      deviceName: "Joko Desktop",
      platform: "win32",
      appVersion: "0.1.0",
      previousConnectionId: issued.connection.id,
      previousAuthKey: Buffer.alloc(32, 3).toString("base64url")
    })).toThrowError(ConnectionAuthenticationError);
    expect(manager.authenticate(`Bearer ${issued.authKey}`).id).toBe(issued.connection.id);

    const createFailure = vi.spyOn(store, "createConnection").mockImplementationOnce(() => {
      throw new Error("injected create failure");
    });
    expect(() => manager.issueTrustedDesktopConnection({
      desktopInstanceId: "ec5aed18-78df-4f0b-a1db-cff4bb8f9e30",
      desktopDeviceId: deviceId,
      deviceName: "Joko Desktop",
      platform: "win32",
      appVersion: "0.1.0",
      previousConnectionId: issued.connection.id,
      previousAuthKey: issued.authKey
    })).toThrow(/injected create failure/u);
    createFailure.mockRestore();
    expect(manager.authenticate(`Bearer ${issued.authKey}`).id).toBe(issued.connection.id);

    const replacement = manager.issueTrustedDesktopConnection({
      desktopInstanceId: nextInstanceId,
      desktopDeviceId: deviceId,
      deviceName: "Joko Desktop",
      platform: "win32",
      appVersion: "0.1.0",
      previousConnectionId: issued.connection.id,
      previousAuthKey: issued.authKey
    });
    expect(store.getDevice(deviceId).state).toBe("active");
    expect(store.listDeviceConnections(deviceId)).toHaveLength(2);
    expect(() => manager.authenticate(`Bearer ${issued.authKey}`)).toThrowError(ConnectionAuthenticationError);
    expect(manager.authenticate(`Bearer ${replacement.authKey}`).id).toBe(replacement.connection.id);
    expect(manager.confirmTrustedDesktopConnection(replacement.connection.id, replacement.authKey).id)
      .toBe(replacement.connection.id);
    expect(() => manager.issueTrustedDesktopConnection({
      desktopInstanceId: nextInstanceId,
      desktopDeviceId: deviceId,
      deviceName: "Joko Desktop",
      platform: "win32",
      appVersion: "0.1.0"
    })).toThrow(/already used/u);
    expect(manager.authenticate(`Bearer ${replacement.authKey}`).id).toBe(replacement.connection.id);

    // Losing Desktop's local proof while the committed Connection remains
    // active is not an explicit logout and must stay behind the recovery fence.
    expect(() => manager.issueTrustedDesktopConnection({
      desktopInstanceId: "9050c5c7-8919-4f76-b9ef-eac0a8e6ecb1",
      desktopDeviceId: deviceId,
      deviceName: "Joko Desktop",
      platform: "win32",
      appVersion: "0.1.0"
    })).toThrowError(ConnectionAuthenticationError);

    manager.revoke(replacement.connection.id);
    expect(() => manager.authenticate(`Bearer ${replacement.authKey}`)).toThrowError(ConnectionAuthenticationError);
    expect(() => manager.issueTrustedDesktopConnection({
      desktopInstanceId: "a482cafa-4d69-48dc-9203-57e41f72d6fc",
      desktopDeviceId: deviceId,
      deviceName: "Joko Desktop",
      platform: "win32",
      appVersion: "0.1.0"
    })).toThrowError(ConnectionAuthenticationError);
    expect(store.listDeviceConnections(deviceId)).toHaveLength(2);
  });

  it("durably authorizes one fresh bootstrap after the current managed connection logs itself out", () => {
    const directory = mkdtempSync(join(tmpdir(), "joko-trusted-desktop-logout-"));
    let store = new OperationalStore(join(directory, "orchestrator.db"), { now: () => 5_000 });
    cleanups.push(() => {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    });
    let manager = new ConnectionManager(store, { now: () => 5_000 });
    const deviceId = "880e157f-49e4-4799-97e6-d95a2351af30";
    const issued = manager.issueTrustedDesktopConnection({
      desktopInstanceId: "11da880c-d0a8-43ec-b3e2-2fd4ee4d7e49",
      desktopDeviceId: deviceId,
      deviceName: "Joko Desktop",
      platform: "win32",
      appVersion: "0.1.0"
    });
    manager.confirmTrustedDesktopConnection(issued.connection.id, issued.authKey);
    manager.logout(issued.connection.id, issued.connection.id);
    expect(() => manager.authenticate(`Bearer ${issued.authKey}`)).toThrowError(ConnectionAuthenticationError);
    expect(store.getDevice(deviceId).state).toBe("active");

    store.close();
    store = new OperationalStore(join(directory, "orchestrator.db"), { now: () => 6_000 });
    manager = new ConnectionManager(store, { now: () => 6_000 });
    const restarted = manager.issueTrustedDesktopConnection({
      desktopInstanceId: "1cf292f2-85bb-4708-812d-9c2279e3838a",
      desktopDeviceId: deviceId,
      deviceName: "Joko Desktop",
      platform: "win32",
      appVersion: "0.1.0"
    });
    expect(restarted.connection.deviceId).toBe(deviceId);
    manager.confirmTrustedDesktopConnection(restarted.connection.id, restarted.authKey);
    expect(manager.authenticate(`Bearer ${restarted.authKey}`).id).toBe(restarted.connection.id);
    expect(() => manager.issueTrustedDesktopConnection({
      desktopInstanceId: "f56a38b8-51f6-4179-9329-d99a4f95584f",
      desktopDeviceId: deviceId,
      deviceName: "Joko Desktop",
      platform: "win32",
      appVersion: "0.1.0"
    })).toThrowError(ConnectionAuthenticationError);
  });

  it("does not authorize rebootstrap when another connection logs out the managed connection", () => {
    const directory = mkdtempSync(join(tmpdir(), "joko-trusted-desktop-remote-logout-"));
    const store = new OperationalStore(join(directory, "orchestrator.db"), { now: () => 5_000 });
    cleanups.push(() => {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    });
    const manager = new ConnectionManager(store, { now: () => 5_000 });
    const deviceId = "59907abc-618f-432d-aa97-c05bf571fe62";
    const managed = manager.issueTrustedDesktopConnection({
      desktopInstanceId: "bcb236a1-6703-4adc-a651-c5f50b95b4eb",
      desktopDeviceId: deviceId,
      deviceName: "Joko Desktop",
      platform: "win32",
      appVersion: "0.1.0"
    });
    manager.confirmTrustedDesktopConnection(managed.connection.id, managed.authKey);
    const challenge = manager.issuePairing("Other owner");
    const other = manager.completePairing({
      challengeId: challenge.id,
      code: challenge.code,
      connectionName: "Other owner"
    });

    manager.logout(managed.connection.id, other.connection.id);
    expect(() => manager.issueTrustedDesktopConnection({
      desktopInstanceId: "ff8ebebf-6922-47e7-a22e-347775a1dca5",
      desktopDeviceId: deviceId,
      deviceName: "Joko Desktop",
      platform: "win32",
      appVersion: "0.1.0"
    })).toThrowError(ConnectionAuthenticationError);
  });

  it("does not authorize rebootstrap after the managed Device is revoked", () => {
    const directory = mkdtempSync(join(tmpdir(), "joko-trusted-desktop-device-revoked-"));
    const store = new OperationalStore(join(directory, "orchestrator.db"), { now: () => 5_000 });
    cleanups.push(() => {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    });
    const manager = new ConnectionManager(store, { now: () => 5_000 });
    const deviceId = "cc7cc51f-649c-4985-9956-c8a6515d5a0d";
    const managed = manager.issueTrustedDesktopConnection({
      desktopInstanceId: "20f57ccb-ea16-48f0-98c2-f1ec25d8bd15",
      desktopDeviceId: deviceId,
      deviceName: "Joko Desktop",
      platform: "win32",
      appVersion: "0.1.0"
    });
    manager.confirmTrustedDesktopConnection(managed.connection.id, managed.authKey);
    manager.revokeDevice(deviceId);

    expect(() => manager.issueTrustedDesktopConnection({
      desktopInstanceId: "342321cb-e5c7-4870-aebf-7bbf103f053b",
      desktopDeviceId: deviceId,
      deviceName: "Joko Desktop",
      platform: "win32",
      appVersion: "0.1.0"
    })).toThrowError(ConnectionAuthenticationError);
  });

  it("does not turn prior generic Connection revocation into a logout authorization", () => {
    const directory = mkdtempSync(join(tmpdir(), "joko-trusted-desktop-revoked-then-logout-"));
    const store = new OperationalStore(join(directory, "orchestrator.db"), { now: () => 5_000 });
    cleanups.push(() => {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    });
    const manager = new ConnectionManager(store, { now: () => 5_000 });
    const deviceId = "bf53133e-95cd-40e6-816e-64a03f33c225";
    const managed = manager.issueTrustedDesktopConnection({
      desktopInstanceId: "2b594bd8-fe96-4494-a647-8117475c7e23",
      desktopDeviceId: deviceId,
      deviceName: "Joko Desktop",
      platform: "win32",
      appVersion: "0.1.0"
    });
    manager.confirmTrustedDesktopConnection(managed.connection.id, managed.authKey);
    manager.revoke(managed.connection.id);
    manager.logout(managed.connection.id, managed.connection.id);

    expect(() => manager.issueTrustedDesktopConnection({
      desktopInstanceId: "ca050098-840e-41ca-ae4a-888054380ea8",
      desktopDeviceId: deviceId,
      deviceName: "Joko Desktop",
      platform: "win32",
      appVersion: "0.1.0"
    })).toThrowError(ConnectionAuthenticationError);
  });

  it("adopts an owner-paired active Device only with exact proof, then survives managed respawn", () => {
    const directory = mkdtempSync(join(tmpdir(), "joko-trusted-desktop-adopt-"));
    const store = new OperationalStore(join(directory, "orchestrator.db"), { now: () => 6_000 });
    cleanups.push(() => {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    });
    const manager = new ConnectionManager(store, { now: () => 6_000 });
    const challenge = manager.issuePairing("Owner recovery");
    const paired = manager.completePairing({
      challengeId: challenge.id,
      code: challenge.code,
      connectionName: "Recovered Desktop",
      device: { name: "Recovered Desktop", kind: "desktop", platform: "win32", appVersion: "0.1.0" }
    });
    const base = {
      desktopDeviceId: paired.connection.deviceId,
      deviceName: "Joko Desktop",
      platform: "win32",
      appVersion: "0.1.0"
    } as const;

    expect(() => manager.issueTrustedDesktopConnection({
      ...base,
      desktopInstanceId: "b9d20cc3-07aa-47e3-ab5e-af33a5d0ea0d"
    })).toThrowError(ConnectionAuthenticationError);
    expect(() => manager.issueTrustedDesktopConnection({
      ...base,
      desktopInstanceId: "4b711033-0f9f-4b8e-873d-ad55cf44eec9",
      previousConnectionId: paired.connection.id,
      previousAuthKey: Buffer.alloc(32, 4).toString("base64url")
    })).toThrowError(ConnectionAuthenticationError);
    expect(manager.authenticate(`Bearer ${paired.authKey}`).id).toBe(paired.connection.id);

    const adopted = manager.issueTrustedDesktopConnection({
      ...base,
      desktopInstanceId: "d19b669f-dda4-4a5f-87a7-904ce61a952a",
      previousConnectionId: paired.connection.id,
      previousAuthKey: paired.authKey
    });
    manager.confirmTrustedDesktopConnection(adopted.connection.id, adopted.authKey);
    expect(() => manager.authenticate(`Bearer ${paired.authKey}`)).toThrowError(ConnectionAuthenticationError);

    const respawned = manager.issueTrustedDesktopConnection({
      ...base,
      desktopInstanceId: "5c1b49c6-9875-4553-a1fb-42c9cf797d75",
      previousConnectionId: adopted.connection.id,
      previousAuthKey: adopted.authKey
    });
    manager.confirmTrustedDesktopConnection(respawned.connection.id, respawned.authKey);
    expect(manager.authenticate(`Bearer ${respawned.authKey}`).deviceId).toBe(paired.connection.deviceId);

    manager.revoke(respawned.connection.id);
    expect(() => manager.issueTrustedDesktopConnection({
      ...base,
      desktopInstanceId: "6bcbf6c0-e15d-42ca-a547-0a8eb7dc7051",
      previousConnectionId: respawned.connection.id,
      previousAuthKey: respawned.authKey
    })).toThrowError(ConnectionAuthenticationError);
  });

  it("allows one proofless restart after an adopted authority immediately logs itself out", () => {
    const directory = mkdtempSync(join(tmpdir(), "joko-trusted-desktop-adopt-logout-"));
    let store = new OperationalStore(join(directory, "orchestrator.db"), { now: () => 6_500 });
    cleanups.push(() => {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    });
    let manager = new ConnectionManager(store, { now: () => 6_500 });
    const challenge = manager.issuePairing("Owner recovery");
    const paired = manager.completePairing({
      challengeId: challenge.id,
      code: challenge.code,
      connectionName: "Recovered Desktop",
      device: { name: "Recovered Desktop", kind: "desktop", platform: "win32", appVersion: "0.1.0" }
    });
    const base = {
      desktopDeviceId: paired.connection.deviceId,
      deviceName: "Joko Desktop",
      platform: "win32",
      appVersion: "0.1.0"
    } as const;
    const adopted = manager.issueTrustedDesktopConnection({
      ...base,
      desktopInstanceId: "11a77f25-39bd-469f-993d-0a26ea28841c",
      previousConnectionId: paired.connection.id,
      previousAuthKey: paired.authKey
    });
    manager.confirmTrustedDesktopConnection(adopted.connection.id, adopted.authKey);
    manager.logout(adopted.connection.id, adopted.connection.id);
    expect(() => manager.authenticate(`Bearer ${adopted.authKey}`)).toThrowError(ConnectionAuthenticationError);

    store.close();
    store = new OperationalStore(join(directory, "orchestrator.db"), { now: () => 7_500 });
    manager = new ConnectionManager(store, { now: () => 7_500 });
    const restarted = manager.issueTrustedDesktopConnection({
      ...base,
      desktopInstanceId: "290a0e7b-e347-4acd-b8dc-e2498d99d4bc"
    });
    manager.confirmTrustedDesktopConnection(restarted.connection.id, restarted.authKey);
    expect(manager.authenticate(`Bearer ${restarted.authKey}`).id).toBe(restarted.connection.id);
    expect(() => manager.issueTrustedDesktopConnection({
      ...base,
      desktopInstanceId: "90c6f190-3110-4b6b-806d-879d0d8d3465"
    })).toThrowError(ConnectionAuthenticationError);
  });

  it("recovers an ACK-aborted provisional rotation using the durable predecessor proof", () => {
    const directory = mkdtempSync(join(tmpdir(), "joko-trusted-desktop-crash-"));
    const store = new OperationalStore(join(directory, "orchestrator.db"), { now: () => 7_000 });
    cleanups.push(() => {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    });
    const manager = new ConnectionManager(store, { now: () => 7_000 });
    const deviceId = "68f07a88-9e9d-4aeb-a1f1-801ca9f0ca41";
    const committed = manager.issueTrustedDesktopConnection({
      desktopInstanceId: "9a2c1984-9c8e-4cba-90a8-400bf17dce31",
      desktopDeviceId: deviceId,
      deviceName: "Joko Desktop",
      platform: "win32",
      appVersion: "0.1.0"
    });
    manager.confirmTrustedDesktopConnection(committed.connection.id, committed.authKey);

    const orphan = manager.issueTrustedDesktopConnection({
      desktopInstanceId: "ccf2f981-d61d-436d-8ef3-dc4e47f5bb37",
      desktopDeviceId: deviceId,
      deviceName: "Joko Desktop",
      platform: "win32",
      appVersion: "0.1.0",
      previousConnectionId: committed.connection.id,
      previousAuthKey: committed.authKey
    });
    expect(store.getConnection(orphan.connection.id).state).toBe("active");
    expect(store.getConnection(committed.connection.id).state).toBe("revoked");

    const recovered = manager.issueTrustedDesktopConnection({
      desktopInstanceId: "fa92ac3f-f42e-43f2-95cb-e80509cff7e4",
      desktopDeviceId: deviceId,
      deviceName: "Joko Desktop",
      platform: "win32",
      appVersion: "0.1.0",
      // Desktop crashed before replacing its durable C0 metadata, so it still
      // proves the revoked predecessor rather than orphan C1.
      previousConnectionId: committed.connection.id,
      previousAuthKey: committed.authKey
    });
    expect(store.getConnection(orphan.connection.id).state).toBe("revoked");
    expect(manager.confirmTrustedDesktopConnection(recovered.connection.id, recovered.authKey).id)
      .toBe(recovered.connection.id);
  });

  it("recovers a first-install crash before any managed metadata could exist", () => {
    const directory = mkdtempSync(join(tmpdir(), "joko-trusted-desktop-first-crash-"));
    const store = new OperationalStore(join(directory, "orchestrator.db"), { now: () => 8_000 });
    cleanups.push(() => {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    });
    const manager = new ConnectionManager(store, { now: () => 8_000 });
    const deviceId = "885860ce-143a-47a9-8730-7cb57d3d3fd1";
    const orphan = manager.issueTrustedDesktopConnection({
      desktopInstanceId: "1870865f-014e-4b3e-a63f-6a26dfa611b7",
      desktopDeviceId: deviceId,
      deviceName: "Joko Desktop",
      platform: "win32",
      appVersion: "0.1.0"
    });
    const recovered = manager.issueTrustedDesktopConnection({
      desktopInstanceId: "eaff9190-c967-46b1-8826-3c87eac5aadc",
      desktopDeviceId: deviceId,
      deviceName: "Joko Desktop",
      platform: "win32",
      appVersion: "0.1.0"
    });
    expect(store.getConnection(orphan.connection.id).state).toBe("revoked");
    expect(manager.confirmTrustedDesktopConnection(recovered.connection.id, recovered.authKey).id)
      .toBe(recovered.connection.id);
  });
});
