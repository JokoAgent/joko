import { createClient, createRouterTransport } from "@connectrpc/connect";
import * as contract from "@joko/contracts";
import type { NativeTextInferenceInput, ProviderModel } from "@joko/core";
import type { HostedNativeInferenceRequest } from "@joko/adapter-hosted";
import { OperationalStore, HostedAgentStore } from "@joko/store";
import { afterEach, expect, it, vi } from "vitest";
import type { ConnectionManager } from "./connection-manager.js";
import { HostedAgentRuntime } from "./hosted-agent-runtime.js";
import { HostedAgentConnectClient } from "./hosted-agent-connect-client.js";
import { createHostedAgentConnectService } from "./hosted-agent-connect-service.js";
import { decodeHostedAgentInference, encodeHostedAgentValue, decodeHostedAgentInvocation } from "./hosted-agent-wire.js";
import type { HostedAgentPrincipal } from "./hosted-agent-host.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0)) await close(); });
const request: HostedNativeInferenceRequest = { requestId: "inference-one", backendId: "native", backendInstanceGeneration: 7,
  providerId: "provider", modelId: "model", system: "Reply briefly", user: "Describe the image", timeoutMs: 10_000, maxTokens: 256,
  images: [{ data: "AQIDBA==", mimeType: "image/png" }] };

function fixture(infer: (input: NativeTextInferenceInput) => Promise<string> = async () => "isolated reply") {
  const store = new OperationalStore(":memory:");
  const model: ProviderModel = { providerId: "provider", modelId: "model", displayName: "Model", api: "native", contextWindow: 32768,
    maxOutputTokens: 4096, supportsImages: true, thinkingLevels: [], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  store.upsertBackend({ id: "native", adapterKind: "native", instanceGeneration: 7, displayName: "Native", version: "1", health: "healthy",
    installationState: "installed", authenticationState: "authenticated", capabilities: new Map(), models: [model], tools: [], diagnostics: [] });
  const inferNativeText = vi.fn(async (_backendId: string, input: NativeTextInferenceInput) => infer(input));
  const create = vi.fn(() => { throw new Error("Isolated inference cannot create a hosted run"); });
  const runtime = new HostedAgentRuntime({ store, root: "unused-inference-directory", artifactCapacityBytes: 1024,
    connections: {} as ConnectionManager, inferNativeText, factories: [{ backendId: "native", isolatedGuests: () => true,
      providerIds: () => ["provider"], models: () => [model], create }] });
  let settings = runtime.settings.update({ kind: "remote_control", enabled: true }, 0n);
  runtime.settings.update({ kind: "provider", backendId: "native", providerId: "provider", enabled: true }, settings.revision);
  let authorized = true;
  const principal: HostedAgentPrincipal = { id: "owner", deviceId: "source-device", trust: "owner", assertCurrent() { if (!authorized) throw new Error("Source route ended"); } };
  const client = new HostedAgentConnectClient(createClient(contract.HostedAgentService, createRouterTransport(router => router.service(contract.HostedAgentService,
    createHostedAgentConnectService({ ...runtime.connectOptions(), authenticate: () => principal })))), principal.assertCurrent);
  cleanups.push(async () => { await runtime.close(); store.close(); });
  return { store, runtime, client, create, inferNativeText, principal, revoke: () => { authorized = false; } };
}

it("roundtrips isolated text and immutable image bytes without opening a task, and coalesces the same inference identity", async () => {
  const f = fixture(async input => { input.assertCurrent(); input.assertModelAllowed("provider", "model"); return "image reply"; });
  expect(await f.client.infer(request, new AbortController().signal)).toBe("image reply");
  expect(await f.client.infer(request, new AbortController().signal)).toBe("image reply");
  expect(f.inferNativeText).toHaveBeenCalledOnce();
  expect(f.inferNativeText.mock.calls[0]![1]).toMatchObject({ system: request.system, user: request.user, maxTokens: 256,
    backendInstanceGeneration: 7, images: [{ mimeType: "image/png" }] });
  expect(Array.from(f.inferNativeText.mock.calls[0]![1].images![0]!.data)).toEqual([1, 2, 3, 4]);
  expect(f.create).not.toHaveBeenCalled(); expect(new HostedAgentStore(f.store).list()).toEqual([]); expect(f.store.listSessions()).toEqual([]);
  expect(f.runtime.slots.summary().total).toBe(0);
  expect((await f.client.catalog(new AbortController().signal)).backends[0]?.instanceGeneration).toBe(7n);
  await expect(f.client.infer({ ...request, user: "Different input" }, new AbortController().signal)).rejects.toBeDefined();
  f.runtime.settings.update({ kind: "provider", backendId: "native", providerId: "provider", enabled: false }, f.runtime.settings.snapshot().revision);
  await expect(f.client.infer(request, new AbortController().signal)).rejects.toBeDefined();
});

it("rejects stale native generations, unavailable models and ungranted guest selections before inference", async () => {
  const f = fixture();
  await expect(f.client.infer({ ...request, backendInstanceGeneration: 6 }, new AbortController().signal)).rejects.toBeDefined();
  await expect(f.client.infer({ ...request, requestId: "wrong-model", modelId: "foreign" }, new AbortController().signal)).rejects.toBeDefined();
  const guest: HostedAgentPrincipal = { ...f.principal, id: "guest", trust: "guest",
    providerGrant: { backendId: "native", providerId: "provider", modelIds: ["other-model"], assertCurrent() {} } };
  await expect(f.runtime.host.infer(guest, request, new AbortController().signal)).rejects.toBeDefined();
  expect(f.inferNativeText).not.toHaveBeenCalled(); expect(f.create).not.toHaveBeenCalled();
});

it.each(["computer", "model", "instance"])("fences a completed inference cache when its %s authority changes", async kind => {
  const f = fixture(); await f.client.infer(request, new AbortController().signal);
  if (kind === "computer") f.runtime.settings.update({ kind: "remote_control", enabled: false }, f.runtime.settings.snapshot().revision);
  else {
    const backend = f.store.getBackend("native").descriptor;
    if (kind === "model") f.store.upsertBackend({ ...backend, models: [] });
    else {
      const reservation = f.store.reserveBackendInstanceGeneration({ backendId: backend.id, adapterKind: backend.adapterKind });
      f.store.publishBackendInstanceDescriptor({ descriptor: { ...backend, instanceGeneration: reservation.generation }, expectedCurrentGeneration: backend.instanceGeneration });
    }
  }
  await expect(f.client.infer(request, new AbortController().signal)).rejects.toBeDefined();
  expect(f.inferNativeText).toHaveBeenCalledOnce();
});

it.each(["cancel", "provider", "route"])("cancels isolated inference when its %s authority ends", async kind => {
  let active: AbortSignal | undefined;
  const f = fixture(async input => { active = input.signal; return new Promise<string>((_resolve, reject) => {
    input.signal.addEventListener("abort", () => reject(input.signal.reason), { once: true });
  }); });
  const controller = new AbortController();
  const pending = f.client.infer(request, controller.signal); void pending.catch(() => {});
  await vi.waitFor(() => expect(active).toBeDefined());
  if (kind === "cancel") controller.abort();
  else if (kind === "route") f.revoke();
  else f.runtime.settings.update({ kind: "provider", backendId: "native", providerId: "provider", enabled: false }, f.runtime.settings.snapshot().revision);
  await expect(pending).rejects.toBeDefined(); expect(active?.aborted).toBe(true); expect(f.create).not.toHaveBeenCalled();
});

it("bounds native inference wire images and admits no workspace, tools or credential fields", () => {
  expect(() => decodeHostedAgentInference({ ...request, workspace: { root: "private" } })).toThrow();
  expect(() => decodeHostedAgentInference({ ...request, backendInstanceGeneration: 0 })).toThrow();
  expect(() => decodeHostedAgentInference({ ...request, images: [{ data: "%%%", mimeType: "image/png" }] })).toThrow();
  expect(() => decodeHostedAgentInference({ ...request, images: [{ data: "AAAA", mimeType: "text/plain" }] })).toThrow();
  expect(() => decodeHostedAgentInvocation(encodeHostedAgentValue({ kind: "infer", request, trust: "owner" }))).toThrow();
});
