import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { AuthorizationError, OperationalStore, StoreError } from "./index.js";

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

describe("mobile push durable boundary", () => {
  it("fences iOS registration, queues each attention subject once, and retires exact authority", () => {
    const { store, filePath } = createFixture();
    const connection = store.createConnection({
      id: "mobile-connection",
      name: "iPhone",
      authKeyDigest: "mobile-auth-digest",
      device: { name: "iPhone", kind: "mobile", platform: "iOS", appVersion: "1.0.0" },
      pairedAt: 10
    });
    const device = store.getDevice(connection.deviceId);
    const registration = store.putMobilePushRegistration({
      id: "push-registration",
      connectionId: connection.id,
      deviceId: device.id,
      expectedDeviceRevision: device.revision,
      environment: "apns_sandbox",
      locale: "zh-CN",
      tokenDigest: digest("a"),
      sealedToken: sealedCredential(1, "encrypted-device-token"),
      revocationSecretDigest: digest("b"),
      sealedRevocationSecret: sealedCredential(2, "encrypted-revocation-secret"),
      expiresAt: 50_000,
      now: 1_000
    });
    expect(registration).toMatchObject({
      connectionId: connection.id,
      deviceId: device.id,
      provider: "apns",
      environment: "apns_sandbox",
      locale: "zh-CN"
    });

    store.createRun({
      id: "push-run",
      sessionId: "session-1",
      source: "user",
      state: "running",
      createdAt: 1_100
    });
    store.appendEvent({
      id: "assistant-message",
      backendId: "pi",
      targetId: "target-1",
      sessionId: "session-1",
      runId: "push-run",
      generation: 0,
      emittedAt: 1_200,
      traceId: "push:message",
      payload: {
        type: "message_complete",
        role: "assistant",
        blocks: [{ kind: "text", text: "Finished" }]
      }
    });
    store.appendEvent({
      id: "done-first",
      backendId: "pi",
      targetId: "target-1",
      sessionId: "session-1",
      runId: "push-run",
      generation: 0,
      emittedAt: 1_300,
      traceId: "push:done:first",
      payload: { type: "done", outcome: "completed" }
    });
    store.appendEvent({
      id: "done-duplicate",
      backendId: "pi",
      targetId: "target-1",
      sessionId: "session-1",
      runId: "push-run",
      generation: 0,
      emittedAt: 1_301,
      traceId: "push:done:duplicate",
      payload: { type: "done", outcome: "completed" }
    });

    expect(store.listMobilePushDeliveries()).toHaveLength(1);
    expect(store.listMobilePushDeliveries()[0]).toMatchObject({
      registrationId: registration.id,
      sessionId: "session-1",
      kind: "done",
      messageId: "assistant-message",
      messageEventId: "assistant-message",
      status: "pending",
      attempts: 0
    });
    const claimed = store.claimNextMobilePushDelivery(1_400);
    expect(claimed).toBeDefined();
    expect(store.finishMobilePushDelivery({
      deliveryId: claimed!.delivery.id,
      claimToken: claimed!.delivery.claimToken!,
      outcome: "retry",
      outcomeCode: "apns_503",
      retryAt: 2_000,
      now: 1_500
    })).toMatchObject({ status: "pending", outcomeCode: "APNS_503", attempts: 1 });
    const retried = store.claimNextMobilePushDelivery(2_000);
    expect(store.finishMobilePushDelivery({
      deliveryId: retried!.delivery.id,
      claimToken: retried!.delivery.claimToken!,
      outcome: "delivered",
      outcomeCode: "apns_200",
      now: 2_100
    })).toMatchObject({ status: "delivered", outcomeCode: "APNS_200", attempts: 2 });

    store.appendEvent({
      id: "terminal-error",
      backendId: "pi",
      targetId: "target-1",
      sessionId: "session-1",
      generation: 0,
      emittedAt: 2_200,
      traceId: "push:error",
      payload: {
        type: "error",
        terminal: true,
        error: {
          code: "provider_error",
          message: "Provider failed",
          phase: "stream",
          retryable: false,
          stateMayHaveChanged: false,
          recovery: "Inspect the task."
        }
      }
    });
    const interrupted = store.claimNextMobilePushDelivery(2_300);
    expect(interrupted?.delivery.kind).toBe("error");
    expect(store.recoverInterruptedMobilePushDeliveries(2_400)).toBe(1);
    expect(store.listMobilePushDeliveries().find((item) => item.id === interrupted!.delivery.id))
      .toMatchObject({ status: "unknown", outcomeCode: "INTERRUPTED_UNKNOWN" });

    expect(store.removeMobilePushRegistrationWithSecret({
      registrationId: registration.id,
      revocationSecretDigest: digest("c")
    })).toBe(false);
    expect(store.getMobilePushRegistration(registration.id)).toBeDefined();
    expect(store.removeMobilePushRegistrationWithSecret({
      registrationId: registration.id,
      revocationSecretDigest: digest("b")
    })).toBe(true);
    expect(store.listMobilePushDeliveries()).toEqual([]);

    const currentDevice = store.getDevice(device.id);
    store.putMobilePushRegistration({
      id: "push-registration-reconnected",
      connectionId: connection.id,
      deviceId: device.id,
      expectedDeviceRevision: currentDevice.revision,
      environment: "apns_production",
      locale: "en",
      tokenDigest: digest("d"),
      sealedToken: sealedCredential(3, "replacement-token"),
      revocationSecretDigest: digest("e"),
      sealedRevocationSecret: sealedCredential(4, "replacement-secret"),
      expiresAt: 50_000,
      now: 2_500
    });
    store.revokeDevice(device.id, currentDevice.revision, 2_600);
    expect(store.listMobilePushRegistrations()).toEqual([]);

    store.close();
    const reopened = new OperationalStore(filePath, { now: () => 3_000 });
    cleanups.push(() => reopened.close());
    expect(reopened.listMobilePushRegistrations()).toEqual([]);
    expect(reopened.listMobilePushDeliveries()).toEqual([]);
  });

  it("rejects unsupported or stale Device registration authority", () => {
    const { store } = createFixture();
    const android = store.createConnection({
      id: "android-connection",
      name: "Android",
      authKeyDigest: "android-auth-digest",
      device: { name: "Android", kind: "mobile", platform: "android", appVersion: "1.0.0" }
    });
    const androidDevice = store.getDevice(android.deviceId);
    expect(() => store.putMobilePushRegistration({
      id: "android-registration",
      connectionId: android.id,
      deviceId: androidDevice.id,
      expectedDeviceRevision: androidDevice.revision,
      environment: "apns_sandbox",
      locale: "en",
      tokenDigest: digest("1"),
      sealedToken: sealedCredential(5, "android-token"),
      revocationSecretDigest: digest("2"),
      sealedRevocationSecret: sealedCredential(6, "android-secret"),
      expiresAt: 50_000
    })).toThrow(AuthorizationError);

    const ios = store.createConnection({
      id: "ios-connection",
      name: "iPhone",
      authKeyDigest: "ios-auth-digest",
      device: { name: "iPhone", kind: "mobile", platform: "ios", appVersion: "1.0.0" }
    });
    const iosDevice = store.getDevice(ios.deviceId);
    expect(() => store.putMobilePushRegistration({
      id: "stale-registration",
      connectionId: ios.id,
      deviceId: iosDevice.id,
      expectedDeviceRevision: iosDevice.revision + 1n,
      environment: "apns_sandbox",
      locale: "en",
      tokenDigest: digest("3"),
      sealedToken: sealedCredential(7, "ios-token"),
      revocationSecretDigest: digest("4"),
      sealedRevocationSecret: sealedCredential(8, "ios-secret"),
      expiresAt: 50_000
    })).toThrow(StoreError);
  });
});

function createFixture(): { readonly store: OperationalStore; readonly filePath: string } {
  const directory = mkdtempSync(path.join(tmpdir(), "joko-mobile-push-store-"));
  const filePath = path.join(directory, "operational.sqlite");
  let nextId = 0;
  const store = new OperationalStore(filePath, {
    idFactory: () => `generated-${++nextId}`,
    now: () => 1_000
  });
  cleanups.push(() => {
    try {
      store.close();
    } catch {
      // The persistence assertion closes the original handle before reopening.
    }
    rmSync(directory, { recursive: true, force: true });
  });
  store.upsertBackend({
    id: "pi",
    displayName: "Pi",
    version: "test",
    health: "healthy",
    adapterKind: "fixture",
    instanceGeneration: 0,
    installationState: "installed",
    authenticationState: "not_required",
    capabilities: new Map(),
    models: [],
    tools: [],
    diagnostics: []
  });
  store.upsertTarget({
    id: "target-1",
    backendId: "pi",
    displayName: "Workspace",
    workspaceRoot: "D:/workspace",
    managed: false,
    trusted: true
  });
  store.createSession({
    id: "session-1",
    backendId: "pi",
    targetId: "target-1",
    title: "Session",
    binding: { opaqueRef: "native/session.jsonl", generation: 0 },
    pinned: false,
    archived: false,
    permissionMode: "ask",
    planMode: false,
    fastMode: false,
    createdAt: 1,
    updatedAt: 1
  });
  return { store, filePath };
}

function digest(character: string): string {
  return `sha256:${character.repeat(64)}`;
}

function sealedCredential(seed: number, ciphertext: string) {
  return {
    algorithm: "aes-256-gcm" as const,
    nonce: Buffer.alloc(12, seed).toString("base64"),
    ciphertext: Buffer.from(ciphertext, "utf8").toString("base64"),
    tag: Buffer.alloc(16, seed).toString("base64")
  };
}
