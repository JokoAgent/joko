import type { HostedNativeInferenceRequest } from "@joko/adapter-hosted";
import type { ProviderModel } from "@joko/core";
import { OperationalStore, ProviderGroupStore, type ProviderGroupMember } from "@joko/store";
import { afterEach, expect, it, vi } from "vitest";
import type { HostedAgentHost, HostedAgentPrincipal } from "./hosted-agent-host.js";
import { ProviderGroupDirectory, type ProviderGroupDirectorySource } from "./provider-group-directory.js";
import { ProviderGroupLeases } from "./provider-group-leases.js";
import { ProviderGroupRouter } from "./provider-group-router.js";
import { ProviderGroupHostedEndpoint } from "./provider-group-hosted.js";
import type { ProviderGroupQuotaReader } from "./provider-group-quota.js";
import type { ProviderGroupRuntime } from "./provider-group-runtime.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { await Promise.allSettled(cleanups.splice(0).map(cleanup => cleanup())); });

function fixture() {
  const store = new OperationalStore(":memory:"), groups = new ProviderGroupStore(store, "group-owner"), leases = new ProviderGroupLeases();
  const model: ProviderModel = { providerId: "api", modelId: "model", displayName: "Model", api: "openai-responses",
    contextWindow: 32768, maxOutputTokens: 4096, supportsImages: true, thinkingLevels: [], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  let revision = 1;
  const sources: ProviderGroupDirectorySource[] = [
    { key: "local", kind: "local", backendId: "anchor", nativeBackendId: "native-local", nativeBackendInstanceGeneration: 3,
      providerId: "api", nodeId: "node-local", displayName: "This computer", providerName: "API", agentKind: "pi", available: true,
      remotelyEnabled: true, models: [model], assertCurrent() { if (revision !== 1) throw new Error("Source replaced"); } },
    { key: "remote", kind: "device", backendId: "source-remote", nativeBackendId: "native-remote", nativeBackendInstanceGeneration: 9,
      providerId: "api", nodeId: "node-remote", displayName: "Other computer", providerName: "API", agentKind: "pi", available: true,
      remotelyEnabled: true, models: [{ ...model, modelId: "native-model", logicalId: "model" }], assertCurrent() { if (revision !== 1) throw new Error("Source replaced"); } }
  ];
  const member = (source: ProviderGroupDirectorySource): ProviderGroupMember => ({ key: source.key, kind: source.kind,
    backendId: source.backendId, nativeBackendId: source.nativeBackendId, providerId: source.providerId, nodeId: source.nodeId,
    displayName: source.displayName, capacity: 1, weight: 1, paused: false });
  groups.update({ backendId: "anchor", providerId: "api" }, { strategy: "ordered", autoSwitch: true, members: [member(sources[1]!), member(sources[0]!)] }, 0n);
  const directory = new ProviderGroupDirectory({ sources: () => sources, quotas: { read: async () => ({ limited: false }) } as unknown as ProviderGroupQuotaReader,
    running: () => 0, ownerGeneration: () => "owner" });
  const router = new ProviderGroupRouter(groups, directory, leases);
  const runtime = { store: groups, directory, router, leases } as unknown as ProviderGroupRuntime;
  const local = vi.fn(async (_principal: HostedAgentPrincipal, _request: HostedNativeInferenceRequest, _signal: AbortSignal) => "local reply");
  const remote = vi.fn(async (_request: HostedNativeInferenceRequest, _signal: AbortSignal) => "remote reply");
  const opened = vi.fn(async () => { throw new Error("Pure inference must not open a task"); });
  const base = { infer: local, begin: opened, sweep: async () => {}, activeProviderTurns: () => 0 } as unknown as HostedAgentHost;
  const capture = vi.fn(() => ({ client: { infer: remote, open: opened, call: vi.fn(), poll: vi.fn(), reply: vi.fn(), readArtifact: vi.fn() },
    assertCurrent: () => { if (revision !== 1) throw new Error("Source replaced"); }, close: vi.fn(async () => {}) }));
  const options = { base, runtime, root: "unused-pure-inference", capture,
    assertSelection: (principal: HostedAgentPrincipal) => { const expected = revision; return () => { principal.assertCurrent(); if (expected !== revision) throw new Error("Permission changed"); }; } };
  const endpoint = new ProviderGroupHostedEndpoint(options);
  cleanups.push(async () => { await endpoint.dispose(); store.close(); });
  const principal: HostedAgentPrincipal = { id: "owner", deviceId: "device", trust: "owner", assertCurrent() {} };
  const request: HostedNativeInferenceRequest = { requestId: "inference-one", backendId: "anchor", backendInstanceGeneration: 3,
    providerId: "api", modelId: "model", system: "Private instruction must stay off disk", user: "Public group message", timeoutMs: 10_000,
    images: [{ data: "aW1hZ2U=", mimeType: "image/png" }] };
  return { store, groups, leases, endpoint, options, principal, request, remote, local, opened, capture, sources, revoke: () => { revision++; } };
}

it("selects one exact group member for tool-free text/images, persists identity before dispatch, and reuses only its live result", async () => {
  const f = fixture(), signal = new AbortController().signal;
  f.remote.mockImplementation(async (request, active) => {
    expect(f.store.listSettingsByKeyPrefix("service", "native-group-inference.v1", "").map(row => row.value))
      .toEqual([expect.objectContaining({ state: "started" })]);
    expect(request).toMatchObject({ backendId: "native-remote", backendInstanceGeneration: 9, providerId: "api", modelId: "native-model", images: f.request.images });
    expect(active.aborted).toBe(false); expect(f.leases.count("remote")).toBe(1); return "remote reply";
  });
  await expect(Promise.all([f.endpoint.infer(f.principal, f.request, signal), f.endpoint.infer(f.principal, f.request, signal)]))
    .resolves.toEqual(["remote reply", "remote reply"]);
  expect(f.remote).toHaveBeenCalledOnce(); expect(f.local).not.toHaveBeenCalled(); expect(f.opened).not.toHaveBeenCalled();
  expect(f.leases.active()).toEqual([]); expect(f.store.listSessions()).toEqual([]);
  expect(JSON.stringify(f.store.listSettingsByKeyPrefix("service", "native-group-inference.v1", "").map(row => row.value))).not.toContain(f.request.system);
  await expect(f.endpoint.infer(f.principal, { ...f.request, user: "Changed input" }, signal)).rejects.toMatchObject({ code: "CONFLICT" });
  const restarted = new ProviderGroupHostedEndpoint(f.options);
  try { await expect(restarted.infer(f.principal, f.request, signal)).rejects.toMatchObject({ code: "UNAVAILABLE" }); }
  finally { await restarted.dispose(); }
  expect(f.remote).toHaveBeenCalledOnce();
});

it("uses a compatible local group member when the other computer cannot accept images", async () => {
  const f = fixture(); f.sources[1] = { ...f.sources[1]!, models: f.sources[1]!.models.map(model => ({ ...model, supportsImages: false })) };
  await expect(f.endpoint.infer(f.principal, f.request, new AbortController().signal)).resolves.toBe("local reply");
  expect(f.local).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: f.principal.id }),
    expect.objectContaining({ backendId: "native-local", backendInstanceGeneration: 3, modelId: "model", images: f.request.images }), expect.any(AbortSignal));
  expect(f.remote).not.toHaveBeenCalled(); expect(f.opened).not.toHaveBeenCalled();
});

it("cancels a group inference when its original authorization changes and never switches on an unknown outcome", async () => {
  const f = fixture(); let dispatched!: () => void;
  const started = new Promise<void>(resolve => { dispatched = resolve; });
  f.remote.mockImplementation(async (_request, signal) => { dispatched(); return new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(new Error("Original inference cancelled")), { once: true });
  }); });
  const pending = f.endpoint.infer(f.principal, f.request, new AbortController().signal);
  const observed = pending.catch(error => error); await started; f.revoke(); await f.endpoint.sweep();
  expect(await observed).toBeInstanceOf(Error); expect(f.local).not.toHaveBeenCalled(); expect(f.remote).toHaveBeenCalledOnce();
  expect(f.leases.active()).toEqual([]);
  await expect(f.endpoint.infer(f.principal, f.request, new AbortController().signal)).rejects.toBeDefined();
  expect(f.remote).toHaveBeenCalledOnce();
});

it("does not return an old inference to a renewed grant or a replaced backend incarnation", async () => {
  const f = fixture(), signal = new AbortController().signal;
  await expect(f.endpoint.infer(f.principal, { ...f.request, backendInstanceGeneration: 4 }, signal)).rejects.toBeDefined();
  expect(f.remote).not.toHaveBeenCalled(); expect(f.local).not.toHaveBeenCalled();
  const next = { ...f.request, requestId: "inference-two" };
  await f.endpoint.infer(f.principal, next, signal); f.revoke();
  await expect(f.endpoint.infer({ ...f.principal }, next, signal)).rejects.toBeDefined();
  expect(f.remote).toHaveBeenCalledOnce();
});
