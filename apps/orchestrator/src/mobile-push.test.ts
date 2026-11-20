import { generateKeyPairSync, verify } from "node:crypto";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import * as contract from "@joko/contracts";
import { OperationalStore } from "@joko/store";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApnsMobilePushPayload } from "./apns-mobile-push-provider.js";
import type { OrchestratorApplication } from "./application.js";
import { createConnectServices } from "./connect-services.js";
import { CredentialVault } from "./credential-vault.js";
import { FcmMobilePushProvider } from "./fcm-mobile-push-provider.js";
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
  it("dispatches Android task attention through FCM and keeps a newer authorized registration after a late receipt", async () => {
    const fixture = await createFixture();
    const { store } = fixture;
    const android = store.createConnection({ id: "android-connection", name: "Android phone", authKeyDigest: "android-digest",
      device: { defaultName: "Android phone", kind: "mobile", platform: "android", appVersion: "1.0.0" } });
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const oauth = "https://oauth2.googleapis.com/token";
    const project = "owned-fixture-project";
    const sends: unknown[] = [];
    let resolveFirst!: (response: Response) => void;
    const firstReply = new Promise<Response>(resolve => { resolveFirst = resolve; });
    const transport: typeof fetch = async (url, options) => {
      expect(options?.redirect).toBe("error");
      if (String(url) === oauth) {
        expect(options?.body).toBeInstanceOf(URLSearchParams);
        const assertion = (options!.body as URLSearchParams).get("assertion")!;
        const [header, claims, signature] = assertion.split(".") as [string, string, string];
        expect(verify("RSA-SHA256", Buffer.from(`${header}.${claims}`), publicKey, Buffer.from(signature, "base64url"))).toBe(true);
        expect(JSON.parse(Buffer.from(claims, "base64url").toString("utf8"))).toMatchObject({
          aud: oauth, scope: "https://www.googleapis.com/auth/firebase.messaging"
        });
        return Response.json({ access_token: "owned-access-token", token_type: "Bearer", expires_in: 3600 });
      }
      expect(url).toBe(`https://fcm.googleapis.com/v1/projects/${project}/messages:send`);
      expect(new Headers(options?.headers).get("authorization")).toBe("Bearer owned-access-token");
      sends.push(JSON.parse(String(options?.body)));
      return sends.length === 1 ? firstReply : Response.json({ name: `projects/${project}/messages/fixture-accepted` });
    };
    const fcmProvider = new FcmMobilePushProvider(JSON.stringify({
      type: "service_account", project_id: project, client_email: "fixture@owned-fixture-project.iam.gserviceaccount.com",
      private_key_id: "f".repeat(40), private_key: privateKey.export({ type: "pkcs8", format: "pem" })
    }), { fetch: transport, now: () => 1_000 });
    const coordinator = new MobilePushCoordinator({ store, vault: fixture.vault, serverId: "server-1", now: () => 1_000, fcmProvider });
    cleanups.push(() => coordinator.close());
    const services = createConnectServices(stubApplication(store, { authenticate: () => android }, coordinator));
    const rpc = services.connection;
    const provider = contract.MobilePushProvider.FCM;
    expect(await invoke(rpc.getMobilePushCapability, { provider }, undefined)).toMatchObject({ capability: { supported: true, provider } });
    const registration = {
      ...registrationRequest({ connectionId: android.id, deviceId: android.deviceId, expectedDeviceRevision: store.getDevice(android.deviceId).revision }),
      provider, environment: contract.MobilePushEnvironment.FCM, previewEnabled: true
    };
    const register = (deviceToken: string) => invoke(rpc.registerMobilePush, { ...registration, deviceToken }, "Bearer fixture");
    expect(await register("first-android-token")).toMatchObject({ registration: { provider, previewEnabled: false } });
    const complete = (id: string) => {
      store.createRun({ id, sessionId: "session-1", source: "user", state: "running", createdAt: 1_000 });
      store.updateRunState({ runId: id, state: "completed", traceId: id });
    };
    coordinator.start();
    complete("initial-fcm-task");
    try {
      await vi.waitFor(() => expect(sends).toHaveLength(1));
      expect(sends[0]).toMatchObject({ message: { token: "first-android-token", notification: { title: "Task finished" },
        data: { intent: "joko://task/session-1?server=server-1" }, android: { notification: { channel_id: "joko-task-attention" } } } });
      expect(await register("rotated-android-token")).toMatchObject({ registration: { provider } });
    } finally {
      resolveFirst(Response.json({ error: { code: 404, status: "NOT_FOUND",
        details: [{ "@type": "type.googleapis.com/google.firebase.fcm.v1.FcmError", errorCode: "UNREGISTERED" }] } }, { status: 404 }));
    }
    await vi.waitFor(() => expect(store.listMobilePushDeliveries()).toContainEqual(expect.objectContaining({
      status: "unknown", outcomeCode: "REGISTRATION_CHANGED"
    })));
    complete("later-fcm-task");
    await vi.waitFor(() => expect(store.listMobilePushDeliveries()).toContainEqual(expect.objectContaining({
      status: "delivered", outcomeCode: "FCM_ACCEPTED"
    })));
    expect(sends).toHaveLength(2);
    expect(sends[1]).toMatchObject({ message: { token: "rotated-android-token" } });
  });

  it("sends only an opted-in current completion preview for the exact registration", async () => {
    const fixture = await createFixture();
    const { store } = fixture;
    const sends: MobilePushDeliveryInput[] = [];
    const secret = "fixture-private-preview-key";
    const coordinator = new MobilePushCoordinator({ store, vault: fixture.vault, serverId: "server-1", now: () => 1_000,
      redactText: value => value.replaceAll(secret, "[REDACTED]"),
      provider: { send: async input => { sends.push(input); return { outcome: "delivered", code: "APNS_200" }; } } });
    cleanups.push(() => coordinator.close());
    const registration = { connectionId: fixture.connection.id, deviceId: fixture.connection.deviceId, expectedDeviceRevision: fixture.deviceRevision,
      environment: "apns_sandbox" as const, locale: "en" as const, deviceToken: "preview-phone", registrationId: "preview-registration", revocationSecret: "a".repeat(43) };
    const other = store.createConnection({ id: "other-ios", name: "Other phone", authKeyDigest: "other-digest",
      device: { defaultName: "Other phone", kind: "mobile", platform: "ios", appVersion: "1.0.0" } });
    coordinator.register({ ...registration, previewEnabled: true });
    coordinator.register({ ...registration, connectionId: other.id, deviceId: other.deviceId,
      expectedDeviceRevision: store.getDevice(other.deviceId).revision, deviceToken: "status-phone", registrationId: "status-registration",
      revocationSecret: "b".repeat(43) });
    const complete = (runId: string, text: string) => store.transaction(transaction => {
      const attemptId = runId + "-attempt";
      transaction.createRun({ id: runId, sessionId: "session-1", source: "user", state: "running", createdAt: 1_000 });
      transaction.createAttempt({ id: attemptId, runId, ordinal: 1, generation: 0, startedAt: 1_000 });
      transaction.appendEvent({ id: runId + "-message", backendId: "pi", targetId: "target-1", sessionId: "session-1",
        runId, attemptId, generation: 0, traceId: runId,
        payload: { type: "message_complete", role: "assistant", blocks: [
          { kind: "thinking", text: "Internal thought", redacted: true },
          { kind: "text", text }
        ] } });
      transaction.finishAttempt(attemptId);
      transaction.updateRunState({ runId, state: "completed", traceId: runId });
    });
    const delivered = (count: number) => vi.waitFor(() => {
      expect(store.listMobilePushDeliveries().filter(item => item.status === "delivered")).toHaveLength(count);
    });
    coordinator.start();
    complete("first", "Final reply\n\nwith " + secret);
    await delivered(2);
    const firstPreview = sends.find(input => input.token === "preview-phone")!;
    expect(JSON.parse(buildApnsMobilePushPayload(firstPreview).toString("utf8"))).toMatchObject({
      aps: { alert: { title: "Session", body: "Final reply with [REDACTED]" } },
      intent: "joko://task/session-1?message=first-message&event=first-message&server=server-1"
    });
    expect(sends.find(input => input.token === "status-phone")?.body).toBeUndefined();
    expect(JSON.stringify(sends)).not.toContain(secret);
    expect(JSON.stringify(sends)).not.toContain("Internal thought");

    complete("before-revocation", "This reply was queued before the preview setting changed.");
    coordinator.register({ ...registration, previewEnabled: false });
    await delivered(4);
    expect(sends.slice(2).every(input => input.title === undefined && input.body === undefined)).toBe(true);

    coordinator.register({ ...registration, previewEnabled: true });
    complete("before-new-turn", "This reply was superseded.");
    store.createRun({ id: "active-new-turn", sessionId: "session-1", source: "user", state: "running", createdAt: 1_000 });
    await delivered(6);
    expect(sends.slice(4).every(input => input.title === undefined && input.body === undefined)).toBe(true);
  });

  it("groups ordinary completions only when their source node and task match", async () => {
    const deliver = async (serverId: string): Promise<readonly MobilePushDeliveryInput[]> => {
      const fixture = await createFixture();
      fixture.store.createSession({ ...fixture.store.getSession("session-1").descriptor,
        id: "session-2", binding: { opaqueRef: "native/second.jsonl", generation: 0 } });
      const sent: MobilePushDeliveryInput[] = [];
      const coordinator = new MobilePushCoordinator({ store: fixture.store, vault: fixture.vault, serverId, now: () => 1_000,
        provider: { send: async input => { sent.push(input); return { outcome: "delivered", code: "APNS_200" }; } } });
      cleanups.push(() => coordinator.close());
      coordinator.register({ connectionId: fixture.connection.id, deviceId: fixture.connection.deviceId, expectedDeviceRevision: fixture.deviceRevision,
        environment: "apns_sandbox", locale: "en", deviceToken: "collapse-test-token", registrationId: "collapse-registration", revocationSecret: "c".repeat(43) });
      coordinator.start();
      for (const [id, sessionId] of [["first", "session-1"], ["second", "session-1"], ["third", "session-2"]] as const) {
        fixture.store.createRun({ id, sessionId, source: "user", state: "running", createdAt: 1_000 });
        fixture.store.updateRunState({ runId: id, state: "completed", traceId: id });
      }
      await vi.waitFor(() => expect(fixture.store.listMobilePushDeliveries().filter(item => item.status === "delivered")).toHaveLength(3));
      return sent;
    };
    const [source, otherSource] = await Promise.all([deliver("server-left"), deliver("server-right")]);
    const firstTask = source.filter(({ intent }) => new URL(intent).pathname === "/session-1");
    expect(firstTask).toHaveLength(2);
    const collapseId = firstTask[0]?.collapseId;
    expect(collapseId).toMatch(/^[0-9a-f]{32}$/u);
    expect(firstTask[1]?.collapseId).toBe(collapseId);
    expect(source.find(({ intent }) => new URL(intent).pathname === "/session-2")?.collapseId).not.toBe(collapseId);
    expect(otherSource.find(({ intent }) => new URL(intent).pathname === "/session-1")?.collapseId).not.toBe(collapseId);
  });

  it("restores the original authorized registration after a terminal APNs rejection without replaying the failed notice", async () => {
    const fixture = await createFixture();
    const sends: MobilePushDeliveryInput[] = [];
    const coordinator = new MobilePushCoordinator({ store: fixture.store, vault: fixture.vault, serverId: "server-1", now: () => 1_000,
      provider: { send: async input => {
        sends.push(input);
        return sends.length === 1 ? { outcome: "invalid_registration", code: "APNS_TOKEN_TOPIC" }
          : { outcome: "delivered", code: "APNS_200" };
      } } });
    cleanups.push(() => coordinator.close());
    const registration = { connectionId: fixture.connection.id, deviceId: fixture.connection.deviceId,
      expectedDeviceRevision: fixture.deviceRevision, environment: "apns_sandbox" as const, locale: "en" as const,
      deviceToken: "retained-device-token", registrationId: "retained-registration", revocationSecret: "r".repeat(43) };
    const complete = (id: string) => {
      fixture.store.createRun({ id, sessionId: "session-1", source: "user", state: "running", createdAt: 1_000 });
      fixture.store.updateRunState({ runId: id, state: "completed", traceId: id });
    };
    coordinator.register(registration);
    coordinator.start();
    complete("original-failed-notice");
    await vi.waitFor(() => expect(fixture.store.findMobilePushRegistration(registration.registrationId)).toBeUndefined());
    expect(fixture.store.listMobilePushDeliveries()).toHaveLength(0);

    const restored = coordinator.register(registration);
    expect(restored.registration.id).toBe(registration.registrationId);
    expect(restored.revocationSecret).toBe(registration.revocationSecret);
    expect(fixture.store.listMobilePushDeliveries()).toHaveLength(0);
    complete("new-notice-after-repair");
    await vi.waitFor(() => expect(fixture.store.listMobilePushDeliveries()[0]?.status).toBe("delivered"));
    expect(sends).toHaveLength(2);
    expect(sends[1]?.intent).toBe("joko://task/session-1?server=server-1");
  });

  it("persists and deduplicates settled group steps through the original worker with a group intent", async () => {
    const fixture = await createFixture(), sends: MobilePushDeliveryInput[] = [];
    const coordinator = new MobilePushCoordinator({ store: fixture.store, vault: fixture.vault, serverId: "server-1", now: () => 1_000,
      provider: { send: async input => { sends.push(input); return { outcome: "delivered", code: "APNS_200" }; } } });
    cleanups.push(() => coordinator.close());
    coordinator.register({ connectionId: fixture.connection.id, deviceId: fixture.connection.deviceId, expectedDeviceRevision: fixture.deviceRevision,
      environment: "apns_sandbox", locale: "zh-CN", deviceToken: "group-device-token", registrationId: "group-registration", revocationSecret: "g".repeat(43) });
    const subject = { groupId: "group-one", groupTitle: "Project group", sourceSessionId: "session-1", subjectSequence: 1n, kind: "awaiting" as const };
    coordinator.notifyGroupStep(subject); coordinator.notifyGroupStep(subject);
    expect(fixture.store.listMobilePushDeliveries()).toHaveLength(1); expect(fixture.store.listMobilePushDeliveries()[0]?.status).toBe("pending");
    coordinator.start(); await vi.waitFor(() => expect(sends).toHaveLength(1));
    expect(sends[0]).toMatchObject({ intent: "joko://partner-group/group-one", title: "Project group", kind: "awaiting" });
    expect(fixture.store.listMobilePushDeliveries()[0]).toMatchObject({ groupId: "group-one", groupTitle: "Project group", status: "delivered" });
    const frozen = JSON.stringify(fixture.store.listEvents().map(event => event.payload)); expect(frozen).not.toContain("group-device-token");
  });
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
      collapseId: expect.stringMatching(/^[0-9a-f]{32}$/u),
      intent: "joko://task/session-1?message=assistant-message&event=assistant-message&server=server-1"
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
      device: { defaultName: "Other iPhone", kind: "mobile", platform: "ios", appVersion: "1.0.0" }
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
      { ...registrationRequest({
        connectionId: fixture.connection.id,
        deviceId: fixture.connection.deviceId,
        expectedDeviceRevision: fixture.deviceRevision
      }), previewEnabled: true },
      "Bearer valid"
    );
    expect(registered.registration).toMatchObject({
      registrationId: "registration-service",
      connectionId: fixture.connection.id,
      deviceId: fixture.connection.deviceId,
      provider: contract.MobilePushProvider.APNS,
      previewEnabled: true
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
    device: { defaultName: "iPhone", kind: "mobile", platform: "ios", appVersion: "1.0.0" }
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
