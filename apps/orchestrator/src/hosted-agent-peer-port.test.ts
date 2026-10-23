import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import type { BackendAdapter, ProviderModel } from "@joko/core";
import * as contract from "@joko/contracts";
import { OperationalStore } from "@joko/store";
import { expect, it, vi } from "vitest";
import type { ConnectionManager } from "./connection-manager.js";
import { HostedAgentRuntime } from "./hosted-agent-runtime.js";
import { createHostedAgentPeerPort } from "./hosted-agent-peer-port.js";
import { encodeHostedAgentValue } from "./hosted-agent-wire.js";

it("pins native route trust to the configured controller and retiring an old route cannot close the replacement route's runs", async () => {
  const root = await mkdtemp(join(tmpdir(), "joko-hosted-peer-scope-")), database = new OperationalStore(":memory:");
  let created = 0, disposed = 0;
  const model: ProviderModel = { providerId: "provider", modelId: "model", displayName: "Model", api: "openai-completions", contextWindow: 32768,
    maxOutputTokens: 1024, supportsImages: false, thinkingLevels: [], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  database.upsertBackend({ id: "native", adapterKind: "native", instanceGeneration: 1, displayName: "Native", version: "1", health: "healthy",
    installationState: "installed", authenticationState: "not_required", capabilities: new Map(), models: [model], tools: [], diagnostics: [] });
  const runtime = new HostedAgentRuntime({ store: database, root, artifactCapacityBytes: 1024,
    connections: { authenticate: () => { throw new Error("Device commands must not borrow an HTTP owner credential."); } } as unknown as ConnectionManager,
    factories: [{ backendId: "native", providerIds: () => ["provider"], models: () => [model], create: () => ({ id: "native",
      hostedExecutionCapabilities: { toolsOnSource: true, isolatedGuests: true },
      createSession: async () => ({ opaqueRef: `native-context-${++created}`, nativeSessionId: `sdk-${created}`, generation: 1 }),
      dispose: async () => { disposed++; } } as unknown as BackendAdapter) }] });
  const old = createHostedAgentPeerPort(runtime, "pinned-controller"), replacement = createHostedAgentPeerPort(runtime, "pinned-controller"), signal = new AbortController().signal;
  const authority = { controllerDeviceId: "original-task-device" }, otherDevice = { controllerDeviceId: "another-task-device" };
  try {
    expect(() => runtime.connectOptions().catalog?.({ id: "task-share", deviceId: "guest-device", trust: "guest", assertCurrent: () => {} }))
      .toThrow("could not be completed");
    let snapshot = runtime.settings.update({ kind: "remote_control", enabled: true }, 0n);
    snapshot = runtime.settings.update({ kind: "provider", backendId: "native", providerId: "provider", enabled: true }, snapshot.revision);
    snapshot = runtime.settings.update({ kind: "limits", value: { perDevice: 2, total: 3 } }, snapshot.revision);
    const request = toBinary(contract.GetHostedAgentSettingsRequestSchema, create(contract.GetHostedAgentSettingsRequestSchema));
    const observed = fromBinary(contract.GetHostedAgentSettingsResponseSchema, await old.invoke(contract.HostedAgentPeerMethod.GET_SETTINGS, request, signal, authority));
    expect(observed.settings?.remoteControlEnabled).toBe(true);
    const catalogRequest = toBinary(contract.GetHostedAgentCatalogRequestSchema, create(contract.GetHostedAgentCatalogRequestSchema, { format: 1 }));
    const catalog = fromBinary(contract.GetHostedAgentCatalogResponseSchema, await old.invoke(contract.HostedAgentPeerMethod.GET_CATALOG, catalogRequest, signal, authority));
    expect(catalog).toMatchObject({ format: 1, remoteControlEnabled: true, backends: [{ backendId: "native",
      providers: [{ providerId: "provider", connected: true, remoteInvocationEnabled: true, models: [{ key: { modelId: "model" } }] }] }] });
    const input = { runId: "first-route", nativeSessionId: "native-first", start: "create", sessionId: "task", targetId: "workspace", generation: 1,
      backendId: "native", providerId: "provider", modelId: "model", permissionMode: "ask", fastMode: false,
      workspace: { platform: process.platform, shell: "bash", isGitRepository: false } };
    const open = (value: typeof input) => toBinary(contract.OpenHostedAgentRequestSchema, create(contract.OpenHostedAgentRequestSchema, { format: 1, openJson: encodeHostedAgentValue(value) }));
    await old.invoke(contract.HostedAgentPeerMethod.OPEN, open(input), signal, authority);
    await replacement.invoke(contract.HostedAgentPeerMethod.OPEN, open({ ...input, runId: "replacement-route", nativeSessionId: "native-second" }), signal, authority);
    expect(runtime.slots.usage(authority.controllerDeviceId).device).toBe(2);
    await expect(old.invoke(contract.HostedAgentPeerMethod.OPEN, open({ ...input, runId: "over-device-limit", nativeSessionId: "excess-native" }), signal, authority)).rejects.toBeDefined();
    await old.invoke(contract.HostedAgentPeerMethod.OPEN, open({ ...input, runId: "other-device", nativeSessionId: "other-native" }), signal, otherDevice);
    await vi.waitFor(() => expect(created).toBe(3));
    expect(runtime.slots.usage(otherDevice.controllerDeviceId).device).toBe(1); expect(runtime.slots.summary()).toEqual({ total: 3, devices: 2, maximumDevice: 2 });
    const privateCall = toBinary(contract.CallHostedAgentRequestSchema, create(contract.CallHostedAgentRequestSchema,
      { format: 1, runId: input.runId, callId: "wrong-device", commandJson: encodeHostedAgentValue({ kind: "state" }) }));
    await expect(old.invoke(contract.HostedAgentPeerMethod.CALL, privateCall, signal, otherDevice)).rejects.toBeDefined();
    await old.retire(); expect(disposed).toBe(2); expect(runtime.slots.usage(authority.controllerDeviceId).device).toBe(1);
    expect(runtime.slots.usage(otherDevice.controllerDeviceId).device).toBe(0);
    await old.retire(); expect(disposed).toBe(2);
    await expect(old.invoke(contract.HostedAgentPeerMethod.GET_SETTINGS, request, signal, authority)).rejects.toBeDefined();
    const after = fromBinary(contract.GetHostedAgentSettingsResponseSchema, await replacement.invoke(contract.HostedAgentPeerMethod.GET_SETTINGS, request, signal, authority));
    expect(after.settings?.usage?.total).toBe(1);
    await expect(replacement.invoke(999 as contract.HostedAgentPeerMethod, request, signal, authority)).rejects.toThrow("invalid");
    await expect(replacement.invoke(contract.HostedAgentPeerMethod.OPEN, open({ ...input, trust: "owner" } as typeof input), signal, authority)).rejects.toBeDefined();
  } finally {
    await old.retire(); await replacement.retire(); await runtime.close(); expect(disposed).toBe(created); database.close();
    if (!resolve(root).startsWith(resolve(tmpdir()) + sep)) throw new Error("Unsafe test cleanup."); await rm(root, { recursive: true, force: true });
  }
});
