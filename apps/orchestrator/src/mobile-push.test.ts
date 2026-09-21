import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import * as contract from "@joko/contracts";
import { OperationalStore } from "@joko/store";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { OrchestratorApplication } from "./application.js";
import { createConnectServices } from "./connect-services.js";
import { CredentialVault } from "./credential-vault.js";
import {
  MobilePushCoordinator,
  type MobilePushDeliveryInput,
  type MobilePushProviderPort
} from "./mobile-push.js";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("mobile push Orchestrator boundary", () => {
  it("recovers idempotent registration and dispatches only a generic public task intent", async () => {
    const fixture = await createFixture();
    let now = 1_000;
    const sends: MobilePushDeliveryInput[] = [];
    const provider: MobilePushProviderPort = {
      send: async (input) => {
        sends.push(input);
        return { outcome: "delivered", code: "APNS_200" };
      }
    };
    const coordinator = new MobilePushCoordinator({
      store: fixture.store,
      vault: fixture.vault,
      serverId: "server-1",
      provider,
      now: () => now
    });
    cleanups.push(() => coordinator.close());
    const first = coordinator.register({
      connectionId: fixture.connection.id,
      deviceId: fixture.connection.deviceId,
      expectedDeviceRevision: fixture.deviceRevision,
      environment: "apns_sandbox",
      locale: "ja",
      deviceToken: "raw-device-token-first",
      registrationId: "registration-1",
      revocationSecret: "s".repeat(43)
    });
    const replay = coordinator.register({
      connectionId: fixture.connection.id,
      deviceId: fixture.connection.deviceId,
      expectedDeviceRevision: fixture.deviceRevision,
      environment: "apns_production",
      locale: "ja",
      deviceToken: "raw-device-token-current",
      registrationId: "registration-1",
      revocationSecret: "s".repeat(43)
    });
    expect(replay.registration.id).toBe(first.registration.id);
    expect(replay.revocationSecret).toBe(first.revocationSecret);

    coordinator.start();
    fixture.store.createRun({
      id: "push-run",
      sessionId: "session-1",
      source: "user",
      state: "running",
      createdAt: now
    });
    fixture.store.appendEvent({
      id: "assistant-message",
      backendId: "pi",
      targetId: "target-1",
      sessionId: "session-1",
      runId: "push-run",
      generation: 0,
      traceId: "push:message",
      payload: {
        type: "message_complete",
        role: "assistant",
        blocks: [{ kind: "text", text: "Private task response content" }]
      }
    });
    fixture.store.appendEvent({
      id: "done-event",
      backendId: "pi",
      targetId: "target-1",
      sessionId: "session-1",
      runId: "push-run",
      generation: 0,
      traceId: "push:done",
      payload: { type: "done", outcome: "completed" }
    });
    await vi.waitFor(() => expect(sends).toHaveLength(1));
    await vi.waitFor(() => expect(fixture.store.listMobilePushDeliveries()[0]?.status).toBe("delivered"));
    expect(sends[0]).toEqual({
      environment: "apns_production",
      token: "raw-device-token-current",
      locale: "ja",
      kind: "done",
      intent: "joko://task/session-1?message=assistant-message&event=assistant-message"
    });
    expect(JSON.stringify(sends[0])).not.toContain("Private task response content");

    coordinator.unregisterWithTicket("server-1", replay.registration.id, replay.revocationSecret);
    expect(fixture.store.listMobilePushRegistrations()).toEqual([]);
    await coordinator.close();
    fixture.store.close();
    const durable = readFileSync(fixture.filePath).toString("latin1");
    expect(durable).not.toContain("raw-device-token-first");
    expect(durable).not.toContain("raw-device-token-current");
    expect(durable).not.toContain(replay.revocationSecret);
  });

  it("exposes capability and fences registration/unregistration to exact Connection authority", async () => {
    const fixture = await createFixture();
    const coordinator = new MobilePushCoordinator({
      store: fixture.store,
      vault: fixture.vault,
      serverId: "server-1",
      provider: { send: async () => ({ outcome: "delivered", code: "APNS_200" }) },
      now: () => 1_000
    });
    cleanups.push(() => coordinator.close());
    const foreign = fixture.store.createConnection({
      id: "foreign-connection",
      name: "Other iPhone",
      authKeyDigest: "foreign-digest",
      device: { name: "Other iPhone", kind: "mobile", platform: "ios", appVersion: "1.0.0" }
    });
    let authenticated = fixture.connection;
    const connections = {
      authenticate: (authorization: string | undefined) => {
        if (authorization !== "Bearer valid") throw new Error("invalid auth");
        return authenticated;
      },
      pairingEnabled: false,
      onRevoked: () => () => undefined
    };
    const services = createConnectServices(stubApplication(fixture.store, connections, coordinator));
    const capability = await invoke<contract.GetMobilePushCapabilityResponse>(
      services.connection.getMobilePushCapability,
      {},
      undefined
    );
    expect(capability.capability).toMatchObject({
      supported: true,
      provider: contract.MobilePushProvider.APNS,
      unavailableReasonCode: ""
    });

    await expect(invoke(
      services.connection.registerMobilePush,
      registrationRequest({ connectionId: foreign.id, deviceId: foreign.deviceId }),
      "Bearer valid"
    )).rejects.toThrow(/authenticated Connection/u);
    const registered = await invoke<contract.RegisterMobilePushResponse>(
      services.connection.registerMobilePush,
      registrationRequest({
        connectionId: fixture.connection.id,
        deviceId: fixture.connection.deviceId,
        expectedDeviceRevision: fixture.deviceRevision
      }),
      "Bearer valid"
    );
    expect(registered.registration).toMatchObject({
      registrationId: "registration-service",
      connectionId: fixture.connection.id,
      deviceId: fixture.connection.deviceId,
      provider: contract.MobilePushProvider.APNS
    });
    expect(registered.revocationTicket).toMatchObject({
      serverId: "server-1",
      registrationId: "registration-service",
      secret: "t".repeat(43)
    });
    expect(JSON.stringify(fixture.store.listEvents({ limit: 10_000 }))).not.toContain("service-device-token");

    authenticated = foreign;
    await expect(invoke(
      services.connection.unregisterMobilePush,
      { serverId: "server-1", registrationId: "registration-service", revocationSecret: "" },
      "Bearer valid"
    )).rejects.toThrow(/another Connection/u);
    await invoke(
      services.connection.unregisterMobilePush,
      {
        serverId: "server-1",
        registrationId: "registration-service",
        revocationSecret: registered.revocationTicket!.secret
      },
      "Bearer stale"
    );
    expect(fixture.store.listMobilePushRegistrations()).toEqual([]);
  });
});

async function createFixture(): Promise<{
  readonly store: OperationalStore;
  readonly vault: CredentialVault;
  readonly filePath: string;
  readonly connection: ReturnType<OperationalStore["getConnection"]>;
  readonly deviceRevision: bigint;
}> {
  const directory = mkdtempSync(path.join(tmpdir(), "joko-mobile-push-orchestrator-"));
  const filePath = path.join(directory, "operational.sqlite");
  const store = new OperationalStore(filePath, { now: () => 1_000 });
  cleanups.push(() => {
    try { store.close(); } catch { /* A test may close before inspecting the database. */ }
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
  const connection = store.createConnection({
    id: "mobile-connection",
    name: "iPhone",
    authKeyDigest: "mobile-digest",
    device: { name: "iPhone", kind: "mobile", platform: "ios", appVersion: "1.0.0" }
  });
  return {
    store,
    vault: await CredentialVault.open(path.join(directory, "vault.key")),
    filePath,
    connection,
    deviceRevision: store.getDevice(connection.deviceId).revision
  };
}

function stubApplication(
  store: OperationalStore,
  connections: object,
  mobilePush: MobilePushCoordinator
): OrchestratorApplication {
  return {
    config: { publicOrigin: "https://orchestrator.example.test" },
    store,
    connections,
    serverId: "server-1",
    artifacts: {},
    blobTransfers: {},
    artifactRepository: {},
    workspaces: {},
    workspaceChanges: {},
    sessionHost: { isSessionTerminalMutationBlocked: () => false },
    scheduler: {},
    adapters: [],
    browserActivity: [],
    mobilePush,
    close: async () => undefined
  } as unknown as OrchestratorApplication;
}

function registrationRequest(input: {
  readonly connectionId: string;
  readonly deviceId: string;
  readonly expectedDeviceRevision?: bigint;
}) {
  return {
    connectionId: input.connectionId,
    deviceId: input.deviceId,
    expectedDeviceRevision: input.expectedDeviceRevision ?? 1n,
    provider: contract.MobilePushProvider.APNS,
    environment: contract.MobilePushEnvironment.APNS_SANDBOX,
    locale: contract.MobilePushLocale.EN,
    deviceToken: "service-device-token",
    registrationId: "registration-service",
    revocationSecret: "t".repeat(43)
  };
}

async function invoke<T>(handler: unknown, request: unknown, authorization: string | undefined): Promise<T> {
  if (typeof handler !== "function") throw new Error("RPC handler is missing.");
  return await (handler as (request: unknown, context: unknown) => Promise<T> | T)(request, {
    requestHeader: new Headers(authorization === undefined ? {} : { authorization }),
    signal: new AbortController().signal
  });
}
