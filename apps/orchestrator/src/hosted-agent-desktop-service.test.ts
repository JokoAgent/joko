import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { createClient, createRouterTransport } from "@connectrpc/connect";
import Fastify from "fastify";
import type { BackendAdapter, ProviderModel } from "@joko/core";
import * as contract from "@joko/contracts";
import { DESKTOP_HOST_AUTHORIZATION_HEADER } from "@joko/contracts/desktop-bootstrap";
import { OperationalStore } from "@joko/store";
import { expect, it, vi } from "vitest";
import { ConnectionManager } from "./connection-manager.js";
import { HostedAgentDesktopDelegates, registerHostedAgentDesktopService } from "./hosted-agent-desktop-service.js";
import { HostedAgentRuntime } from "./hosted-agent-runtime.js";
import { encodeHostedAgentValue } from "./hosted-agent-wire.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "joko-desktop-native-")), store = new OperationalStore(":memory:");
  const connections = new ConnectionManager(store);
  const desktop = connections.issueTrustedDesktopConnection({ desktopInstanceId: randomUUID(), desktopDeviceId: randomUUID(),
    defaultDeviceName: "Desktop", platform: process.platform, appVersion: "0.1.0", desktopHostAuthKey: "h".repeat(43) });
  const headers = { authorization: `Bearer ${desktop.authKey}`, [DESKTOP_HOST_AUTHORIZATION_HEADER]: `Bearer ${"h".repeat(43)}` };
  let created = 0, disposed = 0, failDispose = false;
  const createNativeSession = vi.fn(async () => ({ opaqueRef: `context-${++created}`, nativeSessionId: `native-${created}`, generation: 1 }));
  const model: ProviderModel = { providerId: "provider", modelId: "model", displayName: "Model", api: "openai-completions", contextWindow: 32768,
    maxOutputTokens: 1024, supportsImages: false, thinkingLevels: [], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  const runtime = new HostedAgentRuntime({ store, root, connections, artifactCapacityBytes: 1024,
    factories: [{ backendId: "native", providerIds: () => ["provider"], models: () => [model], create: () => ({ id: "native",
      hostedExecutionCapabilities: { toolsOnSource: true, isolatedGuests: true },
      createSession: createNativeSession,
      dispose: async () => { if (failDispose) { failDispose = false; throw new Error("Native process cleanup is pending."); } disposed++; }
    } as unknown as BackendAdapter) }] });
  let settings = runtime.settings.update({ kind: "remote_control", enabled: true }, 0n);
  settings = runtime.settings.update({ kind: "provider", backendId: "native", providerId: "provider", enabled: true }, settings.revision);
  const delegates = new HostedAgentDesktopDelegates({ runtime, connections, serverId: "managed-hub" });
  const client = createClient(contract.DesktopHostedAgentService, createRouterTransport(({ service }) => {
    service(contract.DesktopHostedAgentService, delegates.service());
  }));
  const openDelegate = async () => (await client.openDesktopHostedAgentDelegate({ format: 1, routeInstanceId: randomUUID() }, { headers })).delegateId;
  const invoke = (delegateId: string, controllerDeviceId: string, method: contract.HostedAgentPeerMethod, requestBytes: Uint8Array) =>
    client.invokeDesktopHostedAgentDelegate({ format: 1, delegateId, controllerDeviceId, method, requestBytes }, { headers });
  const nativeOpen = (runId: string) => toBinary(contract.OpenHostedAgentRequestSchema, create(contract.OpenHostedAgentRequestSchema, { format: 1,
    openJson: encodeHostedAgentValue({ runId, nativeSessionId: `source-${runId}`, start: "create", sessionId: "source-task", targetId: "source-workspace", generation: 1,
      backendId: "native", providerId: "provider", modelId: "model", permissionMode: "ask", fastMode: false,
      workspace: { platform: process.platform, shell: "bash", isGitRepository: false } }) }));
  return { root, store, runtime, delegates, connections, desktop, client, headers, openDelegate, invoke, nativeOpen, createNativeSession,
    created: () => created, disposed: () => disposed, failDispose: () => { failDispose = true; }, commit: () => connections.confirmTrustedDesktopConnection(desktop.connection.id, desktop.authKey),
    async close() { await delegates.close(); await runtime.close(); expect(disposed).toBe(created); store.close();
      if (!resolve(root).startsWith(resolve(tmpdir()) + sep)) throw new Error("Unsafe test cleanup."); await rm(root, { recursive: true, force: true }); } };
}

it("requires the exact committed Desktop proof in addition to an owner bearer, including across repeated open requests", async () => {
  const f = await fixture();
  try {
    const input = { format: 1, routeInstanceId: randomUUID() };
    await expect(f.client.openDesktopHostedAgentDelegate(input, { headers: f.headers })).rejects.toBeDefined();
    f.commit();
    await expect(f.client.openDesktopHostedAgentDelegate(input, { headers: { authorization: f.headers.authorization } })).rejects.toBeDefined();
    await expect(f.client.openDesktopHostedAgentDelegate(input, { headers: { ...f.headers, [DESKTOP_HOST_AUTHORIZATION_HEADER]: `Bearer ${"x".repeat(43)}` } })).rejects.toBeDefined();
    const first = await f.client.openDesktopHostedAgentDelegate(input, { headers: f.headers });
    expect(first).toMatchObject({ format: 1, serverId: "managed-hub" });
    expect(await f.client.openDesktopHostedAgentDelegate(input, { headers: f.headers })).toEqual(first);
    expect(f.created()).toBe(0);
    const catalog = await f.invoke(first.delegateId, "original-device", contract.HostedAgentPeerMethod.GET_CATALOG,
      toBinary(contract.GetHostedAgentCatalogRequestSchema, create(contract.GetHostedAgentCatalogRequestSchema, { format: 1 })));
    expect(fromBinary(contract.GetHostedAgentCatalogResponseSchema, catalog.responseBytes).backends[0]?.backendId).toBe("native");
    const other = f.connections.issueTrustedDesktopConnection({ desktopInstanceId: randomUUID(), desktopDeviceId: randomUUID(),
      defaultDeviceName: "Another Desktop", platform: process.platform, appVersion: "0.1.0", desktopHostAuthKey: "j".repeat(43) });
    f.connections.confirmTrustedDesktopConnection(other.connection.id, other.authKey);
    await expect(f.client.closeDesktopHostedAgentDelegate({ format: 1, delegateId: first.delegateId }, { headers: {
      authorization: `Bearer ${other.authKey}`, [DESKTOP_HOST_AUTHORIZATION_HEADER]: `Bearer ${"j".repeat(43)}` } })).rejects.toBeDefined();
  } finally { await f.close(); }
});

it("attributes native factories and quotas to the original task Device and only retires the captured old route", async () => {
  const f = await fixture(); f.commit();
  try {
    const old = await f.openDelegate(), replacement = await f.openDelegate();
    const opened = await f.invoke(old, "original-device", contract.HostedAgentPeerMethod.OPEN, f.nativeOpen("old"));
    expect(fromBinary(contract.OpenHostedAgentResponseSchema, opened.responseBytes).runId).toBe("old");
    expect(f.runtime.slots.summary()).toEqual({ total: 1, devices: 1, maximumDevice: 1 });
    await vi.waitFor(() => expect(f.createNativeSession).toHaveBeenCalledTimes(1));
    await f.invoke(replacement, "original-device", contract.HostedAgentPeerMethod.OPEN, f.nativeOpen("new"));
    await f.invoke(old, "another-device", contract.HostedAgentPeerMethod.OPEN, f.nativeOpen("other"));
    await vi.waitFor(() => expect(f.createNativeSession).toHaveBeenCalledTimes(3));
    expect(f.created()).toBe(3);
    expect(f.runtime.slots.usage("original-device").device).toBe(2); expect(f.runtime.slots.usage(f.desktop.connection.deviceId).device).toBe(0);
    await expect(f.invoke(replacement, "another-device", contract.HostedAgentPeerMethod.CALL, toBinary(contract.CallHostedAgentRequestSchema,
      create(contract.CallHostedAgentRequestSchema, { format: 1, runId: "new", callId: "wrong-device", commandJson: encodeHostedAgentValue({ kind: "state" }) })))).rejects.toBeDefined();
    f.failDispose();
    await expect(f.client.closeDesktopHostedAgentDelegate({ format: 1, delegateId: old }, { headers: f.headers })).rejects.toBeDefined();
    expect(f.runtime.slots.usage("original-device").device).toBe(2);
    await f.client.closeDesktopHostedAgentDelegate({ format: 1, delegateId: old }, { headers: f.headers });
    await f.client.closeDesktopHostedAgentDelegate({ format: 1, delegateId: old }, { headers: f.headers });
    expect(f.runtime.slots.summary()).toEqual({ total: 1, devices: 1, maximumDevice: 1 });
    expect(f.disposed()).toBe(2);
    await expect(f.invoke(old, "original-device", contract.HostedAgentPeerMethod.GET_CATALOG,
      toBinary(contract.GetHostedAgentCatalogRequestSchema, create(contract.GetHostedAgentCatalogRequestSchema, { format: 1 })))).rejects.toBeDefined();
    await expect(f.invoke(replacement, "original-device", 999 as contract.HostedAgentPeerMethod, new Uint8Array())).rejects.toBeDefined();
    expect(f.created()).toBe(3);
    f.connections.revoke(f.desktop.connection.id);
    await vi.waitFor(() => expect(f.disposed()).toBe(3));
    expect(f.runtime.slots.summary().total).toBe(0);
  } finally { await f.close(); }
});

it("registers the private service only on loopback sockets even when the listener accepts LAN clients", async () => {
  const f = await fixture(); f.commit(); const server = Fastify();
  try {
    await registerHostedAgentDesktopService(server, { runtime: f.runtime, connections: f.connections, serverId: "managed-hub" });
    const request = { method: "POST" as const, url: "/joko.v1.DesktopHostedAgentService/OpenDesktopHostedAgentDelegate",
      headers: { ...f.headers, "content-type": "application/json", "connect-protocol-version": "1" }, payload: { format: 1, routeInstanceId: randomUUID() } };
    const lan = await server.inject({ ...request, remoteAddress: "192.168.1.21" }); expect(lan.statusCode).toBe(403);
    const local = await server.inject({ ...request, remoteAddress: "127.0.0.1" }); expect(local.statusCode).toBe(200);
    expect(local.json()).toMatchObject({ format: 1, serverId: "managed-hub" });
  } finally { await server.close(); await f.close(); }
});
