import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { JokoError, type AdapterContext, type PromptInput } from "@joko/core";
import { FakeBackendAdapter, PI_LIKE_PROFILE } from "@joko/testkit";
import { OperationalStore, SessionRuntimeHandoffStore } from "@joko/store";
import { OperationalArtifactRepository } from "./artifact-repository.js";
import { ArtifactStore } from "./artifact-store.js";
import { BackendInstanceRegistry } from "./backend-instance-registry.js";
import type { HostedAgentSources } from "./hosted-agent-sources.js";
import { ProviderGroupRuntime, providerGroupDefaultMember } from "./provider-group-runtime.js";
import { SessionHost } from "./session-host.js";
import { ProviderGroupService } from "./provider-group-service.js";
import { providerGroupQuota } from "./provider-group-quota.js";
import { createClient, createRouterTransport } from "@connectrpc/connect";
import * as contract from "@joko/contracts";
import { createProviderGroupConnectService } from "./provider-group-connect-service.js";
import { ProviderGroupRemoteRouter } from "./provider-group-remote.js";
import { mkdtemp } from "./test-paths.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0)) await close(); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "joko-group-host-")), store = new OperationalStore(join(root, "store.db"));
  const artifacts = new ArtifactStore({ rootDirectory: join(root, "artifacts"), repository: new OperationalArtifactRepository(store), ingestRoots: [root] }); await artifacts.initialize();
  const profile = { ...PI_LIKE_PROFILE, capabilities: PI_LIKE_PROFILE.capabilities.map(capability => capability.key === "permission.modes" ? { ...capability, options: ["ask", "auto", "bypassPermissions"] } : capability) };
  const first = new FakeBackendAdapter({ ...profile, id: "group-first" }), second = new FakeBackendAdapter({ ...profile, id: "group-second" });
  const registry = new BackendInstanceRegistry(store); await registry.provision([first, second].map(adapter => ({ instanceId: adapter.id, adapterKind: "fake", displayName: adapter.id, create: () => adapter })));
  const host = new SessionHost(store, artifacts, registry.availableAdapters(), { backendDescriptors: registry.descriptors(), backendDescriptorsAlreadyPublished: true }); await host.initialize();
  const sources = { groupCatalog: () => [], installGroupSwitch: () => {}, installGroupStore: () => {}, sourceKind: () => undefined } as unknown as HostedAgentSources;
  const groups = new ProviderGroupRuntime({ store, registry, sources, nodeId: "group-node", nodeName: () => "This node", ownerGeneration: () => "owner-1",
    now: () => Date.now(),
    sessions: host.providerGroupSessionPort(), readAccountUsage: async () => undefined, activeTurns: (backend, provider) => host.activeProviderTurns(backend, provider), assertRemoteAllowed: () => {} }); host.installProviderGroupRuntime(groups);
  await host.registerTarget({ id: "target", backendId: first.id, displayName: "Workspace", workspaceRoot: root, managed: false, trusted: true });
  const connection = store.createConnection({ id: "controller", name: "Owner", authKeyDigest: "digest" });
  cleanups.push(async () => { await host.dispose(); await groups.close(); store.close(); await rm(root, { recursive: true, force: true }); });
  const key = { backendId: first.id, providerId: "test" }, members = groups.sources().filter(row => row.providerId === "test").map(providerGroupDefaultMember);
  const create = (id: string) => host.createSession({ operationId: id, connection, targetId: "target", title: "Grouped task", providerId: "test", modelId: "text", effort: "medium", permissionMode: "ask", planMode: false, fastMode: false });
  const send = (sessionId: string, id: string) => host.enqueueInput({ operationId: id, connection, sessionId, prompt: prompt(id) }).value;
  return { root, store, host, groups, registry, first, second, key, members, create, send, connection };
}
const prompt = (text: string): PromptInput => ({ text, images: [], files: [], mentions: [], disposition: "prompt" });
async function until(predicate: () => boolean): Promise<void> { await vi.waitFor(() => expect(predicate()).toBe(true), { timeout: 8000, interval: 10 }); }

function quotaBoundary(f: Pick<Awaited<ReturnType<typeof fixture>>, "groups" | "registry">, resetAt: number) {
  return vi.spyOn(f.groups.directory, "read").mockImplementation(async member => {
    const limited = Date.now() < resetAt, model = f.registry.get(member.backendId).descriptor.models.find(model => model.providerId === member.providerId)!;
    return { member, available: !limited, reachable: true, model, running: 0, assertCurrent: () => {}, quota: { limited, ...(limited ? { resetAt } : {}) },
      ...(limited ? { reason: "quota" as const } : {}) };
  });
}

async function reopenGroupHost(f: Awaited<ReturnType<typeof fixture>>, resetAt: number) {
  await f.host.dispose(); await f.groups.close(); f.store.close();
  const store = new OperationalStore(join(f.root, "store.db"));
  const artifacts = new ArtifactStore({ rootDirectory: join(f.root, "restarted-artifacts"), repository: new OperationalArtifactRepository(store), ingestRoots: [f.root] }); await artifacts.initialize();
  const first = new FakeBackendAdapter({ ...PI_LIKE_PROFILE, id: f.first.id }), second = new FakeBackendAdapter({ ...PI_LIKE_PROFILE, id: f.second.id });
  const registry = new BackendInstanceRegistry(store); await registry.provision([first, second].map(adapter => ({ instanceId: adapter.id, adapterKind: "fake", displayName: adapter.id, create: () => adapter })));
  const host = new SessionHost(store, artifacts, registry.availableAdapters(), { backendDescriptors: registry.descriptors(), backendDescriptorsAlreadyPublished: true });
  await host.initialize();
  const sources = { groupCatalog: () => [], installGroupSwitch: () => {}, installGroupStore: () => {}, sourceKind: () => undefined } as unknown as HostedAgentSources;
  const groups = new ProviderGroupRuntime({ store, registry, sources, nodeId: "group-node", nodeName: () => "This node", ownerGeneration: () => "owner-1",
    now: () => Date.now(),
    sessions: host.providerGroupSessionPort(), readAccountUsage: async () => undefined, activeTurns: (backend, provider) => host.activeProviderTurns(backend, provider), assertRemoteAllowed: () => {} });
  quotaBoundary({ groups, registry }, resetAt);
  host.installProviderGroupRuntime(groups);
  cleanups.unshift(async () => { await host.dispose(); await groups.close(); store.close(); });
  return { store, host, groups, first, second, registry };
}

it("durably wakes the same undispatched input after a quota reset and a real Store reopen", async () => {
  const f = await fixture(); f.groups.store.update(f.key, { strategy: "ordered", autoSwitch: true, members: f.members }, 0n);
  const sessionId = (await f.create("quota-wait-source")).value.sessionId, resetAt = Date.now() + 60_000;
  quotaBoundary(f, resetAt); const send = vi.spyOn(f.first, "send"), queued = f.send(sessionId, "quota-wait-original");
  await until(() => f.store.findSetting("session", sessionId, `provider.group-error:${queued.runId}`)?.value !== undefined);
  expect(f.store.getQueueItem(queued.queueItemId).state).toBe("accepted"); expect(send).not.toHaveBeenCalled();
  const restored = await reopenGroupHost(f, resetAt), resumedSend = vi.spyOn(restored.first, "send");
  expect(restored.store.getSetting("session", sessionId, `provider.group-error:${queued.runId}`).value).toMatchObject({ kind: "queue-head", queueItemId: queued.queueItemId, operationId: "quota-wait-original", resumeAt: resetAt });
  expect(resumedSend).not.toHaveBeenCalled();
  const clock = vi.spyOn(Date, "now").mockReturnValue(resetAt + 1);
  try {
    restored.host.requestQueueDrain(sessionId); await until(() => restored.store.getQueueItem(queued.queueItemId).state === "completed");
    restored.host.requestQueueDrain(sessionId); expect(resumedSend).toHaveBeenCalledOnce();
    expect(restored.store.listRuns({ sessionId })).toHaveLength(1); expect(restored.store.getOperation("quota-wait-original").status).toBe("completed");
    expect(restored.store.findSetting("session", sessionId, `provider.group-error:${queued.runId}`)).toBeUndefined();
  } finally { clock.mockRestore(); }
});

it("restores a positively settled failed turn once without replaying completed assistant work", async () => {
  const f = await fixture(); f.groups.store.update(f.key, { strategy: "ordered", autoSwitch: true, members: f.members }, 0n);
  const sessionId = (await f.create("quota-failed-source")).value.sessionId, resetAt = Date.now() + 60_000;
  vi.spyOn(f.first, "send").mockImplementationOnce(async (_input: PromptInput, context: AdapterContext) => {
    await context.emit({ type: "message_complete", role: "assistant", blocks: [{ kind: "text", text: "Already completed work" }] });
    quotaBoundary(f, resetAt);
    await context.emit({ type: "error", terminal: true, error: { code: "USAGE_LIMIT", message: "Account quota exhausted", phase: "turn", retryable: true, stateMayHaveChanged: false, recovery: "Wait for quota." } });
    await context.emit({ type: "done", outcome: "failed" });
  });
  const queued = f.send(sessionId, "quota-interrupted-original");
  await until(() => Boolean((f.store.findSetting("session", sessionId, `provider.group-error:${queued.runId}`)?.value as { resumeAt?: number } | undefined)?.resumeAt));
  expect(f.store.getRun(queued.runId).descriptor.state).toBe("failed");
  const restored = await reopenGroupHost(f, resetAt), resumedSend = vi.spyOn(restored.first, "send");
  const clock = vi.spyOn(Date, "now").mockReturnValue(resetAt + 1);
  try {
    expect(restored.groups.router.now()).toBe(resetAt + 1);
    restored.host.requestQueueDrain(sessionId);
    await until(() => restored.store.listRuns({ sessionId }).some(run => run.descriptor.parentRunId === queued.runId && run.descriptor.state === "completed"));
    restored.host.requestQueueDrain(sessionId); expect(resumedSend).toHaveBeenCalledOnce();
    expect(resumedSend.mock.calls[0]![0].text).toContain("Do not repeat completed work");
    expect(restored.store.listRuns({ sessionId })).toHaveLength(2);
    expect(restored.store.listEvents({ sessionId }).filter(event => event.payload.type === "error" && event.payload.terminal)).toEqual([]);
    expect(restored.store.listEvents({ sessionId }).some(event => event.runId === queued.runId && event.payload.type === "done" && event.payload.outcome === "failed")).toBe(true);
  } finally { clock.mockRestore(); }
});

it("does not promote a held error into a cold retry without a settled original native turn", async () => {
  const f = await fixture(); f.groups.store.update(f.key, { strategy: "ordered", autoSwitch: true, members: f.members }, 0n);
  const sessionId = (await f.create("quota-unknown-source")).value.sessionId, resetAt = Date.now() + 60_000;
  vi.spyOn(f.first, "send").mockImplementationOnce(async (_input: PromptInput, context: AdapterContext) => {
    quotaBoundary(f, resetAt);
    await context.emit({ type: "error", terminal: true, error: { code: "USAGE_LIMIT", message: "Account quota exhausted", phase: "turn", retryable: true, stateMayHaveChanged: false, recovery: "Inspect native state." } });
    throw new JokoError({ code: "DISPATCH_UNKNOWN", message: "Lost the native completion receipt", phase: "dispatch", retryable: false, stateMayHaveChanged: true, recovery: "Inspect the original native turn." });
  });
  const queued = f.send(sessionId, "quota-unknown-original"); await until(() => f.store.getRun(queued.runId).descriptor.state === "dispatch_unknown");
  const restored = await reopenGroupHost(f, resetAt), send = vi.spyOn(restored.first, "send"), second = vi.spyOn(restored.second, "send");
  const clock = vi.spyOn(Date, "now").mockReturnValue(resetAt + 1);
  try {
    restored.host.requestQueueDrain(sessionId); await new Promise(resolve => setTimeout(resolve, 30));
    expect(send).not.toHaveBeenCalled(); expect(second).not.toHaveBeenCalled(); expect(restored.store.listRuns({ sessionId })).toHaveLength(1);
    expect(restored.store.getRun(queued.runId).descriptor.state).toBe("dispatch_unknown");
  } finally { clock.mockRestore(); }
});

it("continues one authenticated guest offer after its exact native handoff commits", async () => {
  const f = await fixture(), sessionId = (await f.create("guest-offer-source")).value.sessionId;
  const original = f.store.getSession(sessionId).descriptor.binding, nativeSend = f.first.send.bind(f.first);
  const send = vi.spyOn(f.first, "send").mockImplementationOnce(async (_input, context) => {
    f.groups.guestSwitch.offer(sessionId, f.first.id, context.generation, "a".repeat(64));
    await context.emit({ type: "message_complete", role: "assistant", blocks: [{ kind: "text", text: "Retained completed work" }] });
    await context.emit({ type: "error", terminal: true, error: { code: "UPSTREAM_OVERLOAD", message: "Provider member overloaded", phase: "turn", retryable: true,
      stateMayHaveChanged: false, recovery: "Use the original authenticated offer." } });
    await context.emit({ type: "done", outcome: "failed" });
  });
  send.mockImplementation(nativeSend);
  const queued = f.send(sessionId, "guest-offer-original");
  await until(() => f.store.listRuns({ sessionId }).some(run => run.descriptor.parentRunId === queued.runId && run.descriptor.state === "completed"));
  expect(send).toHaveBeenCalledTimes(2); expect(send.mock.calls[1]![0].text).toContain("Do not repeat completed work");
  expect(f.store.getSession(sessionId).descriptor.binding.nativeSessionId).not.toBe(original.nativeSessionId);
  expect(f.store.listEvents({ sessionId }).filter(event => event.payload.type === "runtime_handoff")).toHaveLength(1);
  expect(f.store.getOperation("guest-offer-original").status).toBe("completed"); expect(f.store.listRuns({ sessionId })).toHaveLength(2);
  expect(f.store.findSetting("session", sessionId, `provider.group-error:${queued.runId}`)).toBeUndefined();
});

it("retains an unknown guest-offer native journal through Store reopen without another creation or send", async () => {
  const f = await fixture(), sessionId = (await f.create("guest-unknown-source")).value.sessionId;
  const create = vi.spyOn(f.first, "createSession").mockRejectedValueOnce(new JokoError({ code: "NATIVE_START_UNKNOWN", message: "The native startup response was lost.",
    phase: "session_start", retryable: false, stateMayHaveChanged: true, recovery: "Inspect the original native creation." }));
  vi.spyOn(f.first, "send").mockImplementationOnce(async (_input, context) => {
    f.groups.guestSwitch.offer(sessionId, f.first.id, context.generation, "b".repeat(64));
    await context.emit({ type: "error", terminal: true, error: { code: "UPSTREAM_OVERLOAD", message: "Provider member overloaded", phase: "turn", retryable: true,
      stateMayHaveChanged: false, recovery: "Use the original authenticated offer." } });
    await context.emit({ type: "done", outcome: "failed" });
  });
  const queued = f.send(sessionId, "guest-unknown-original");
  await until(() => new SessionRuntimeHandoffStore(f.store).read(sessionId)?.pending?.phase === "unknown");
  const journal = new SessionRuntimeHandoffStore(f.store).read(sessionId)!;
  expect(create).toHaveBeenCalledOnce();
  expect(f.store.getSetting("session", sessionId, `provider.group-error:${queued.runId}`).value)
    .toMatchObject({ runId: queued.runId, operationId: "guest-unknown-original", guestHandoff: { generation: journal.generation } });
  const restored = await reopenGroupHost(f, Date.now()), creation = vi.spyOn(restored.first, "createSession"), send = vi.spyOn(restored.first, "send");
  restored.host.requestQueueDrain(sessionId); await new Promise(resolve => setTimeout(resolve, 30));
  expect(creation).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled(); expect(restored.store.listRuns({ sessionId })).toHaveLength(1);
  expect(new SessionRuntimeHandoffStore(restored.store).read(sessionId)?.pending).toEqual(journal.pending);
  expect(restored.store.getSetting("session", sessionId, `provider.group-error:${queued.runId}`).value)
    .toMatchObject({ runId: queued.runId, guestHandoff: { generation: journal.generation } });
});

it("carries an exact quota wait through the generated owner RPC without inventing a new selection", async () => {
  const f = await fixture(), resetAt = Date.now() + 60_000;
  f.groups.store.update(f.key, { strategy: "ordered", autoSwitch: true, members: f.members }, 0n); quotaBoundary(f, resetAt);
  const transport = createRouterTransport(router => router.service(contract.ProviderGroupService, createProviderGroupConnectService({ service: f.groups.service, usage: f.groups.usage,
    schedulingState: async () => ({ activeTurns: 0 }), authenticate: async () => ({ id: "peer-owner", trust: "owner", management: false, assertCurrent: () => {} }), assertRemoteAllowed: () => {} })));
  const peer = { captureGroupPeer: () => ({ transport, nativeBackendId: f.first.id, ownerNodeId: "group-node", assertCurrent: () => {} }) } as unknown as HostedAgentSources;
  const remote = new ProviderGroupRemoteRouter({ store: f.groups.store, sources: peer, directory: f.groups.directory, leases: f.groups.leases, localNodeId: "receiver", ownerGeneration: () => "receiver-owner" });
  await expect(remote.pick({ sessionId: "original-remote-task", group: f.key, agentKind: "pi", modelId: "text", ownTask: true,
    profile: { backendId: f.first.id, providerId: "test", modelId: "text", effort: "medium", fastMode: false } }, new AbortController().signal))
    .rejects.toMatchObject({ code: "PROVIDER_GROUP_UNAVAILABLE", retryAt: expect.any(Number) });
  const client = createClient(contract.ProviderGroupService, transport);
  await expect(client.pickProviderGroupMember({ key: f.key, sessionId: "original-remote-task", agentKind: "pi", modelId: "text" })).rejects.toMatchObject({ code: 14 });
});

async function rebalanceFixture() {
  const f = await fixture(), members = [f.members[0]!, { ...f.members[1]!, nodeId: "other-execution-node", displayName: "Other computer" }];
  const percentages = [70, 70];
  vi.spyOn(f.groups.directory, "read").mockImplementation(async member => {
    const index = members.findIndex(candidate => candidate.key === member.key), now = Date.now();
    const model = f.registry.get(member.backendId).descriptor.models.find(model => model.providerId === member.providerId)!;
    return { member, available: true, reachable: true, model, running: 0, assertCurrent: () => {}, quota: providerGroupQuota({ providerId: "test", observedAt: now,
      primaryWindow: { usedPercent: 10, windowMinutes: 300, resetAt: now + 3_600_000 },
      secondaryWindow: { usedPercent: percentages[index]!, windowMinutes: 10_080, resetAt: now + 7 * 86_400_000 } }, "test", "text", now) };
  });
  f.groups.store.update(f.key, { strategy: "ordered", autoSwitch: false, members }, 0n);
  const sessionId = (await f.create("rebalance-original-source")).value.sessionId;
  percentages[1] = 20;
  const source = f.store.getSession(sessionId).descriptor;
  const suggestion = await f.groups.service.rebalanceSuggestion(sessionId, BigInt(source.binding.generation), new AbortController().signal);
  expect(suggestion?.toMemberKey).toBe(members[1]!.key);
  const enqueue = () => f.host.enqueueInput({ operationId: "rebalance-original-send", connection: f.connection, sessionId, prompt: prompt("Exact queued owner input"),
    providerGroupRebalance: { suggestionKey: suggestion!.suggestionKey, remember: true } }).value;
  return { ...f, sessionId, source, suggestion: suggestion!, members, percentages, enqueue };
}

it("recovers quota consent from the original queued send after the service restarts and switches only once", async () => {
  const f = await rebalanceFixture(), send = vi.spyOn(f.second, "send");
  f.store.setQueuePaused({ sessionId: f.sessionId, paused: true, traceId: "hold-original" }); const queued = f.enqueue();
  expect(f.store.getSetting("service", queued.queueItemId, "provider.group-rebalance-choice.v1").value).toMatchObject({ phase: "accepted", operationId: "rebalance-original-send", to: f.members[1]!.key });
  expect(f.store.getSetting("service", f.sessionId, "provider.group-rebalance-auto.v1").value).toBe(true);
  const restarted = new ProviderGroupService({ router: f.groups.router, sessions: f.host.providerGroupSessionPort() });
  f.store.setQueuePaused({ sessionId: f.sessionId, paused: false, traceId: "resume-original" });
  await restarted.beforeSend(f.sessionId, new AbortController().signal, queued.queueItemId);
  expect(f.store.getSession(f.sessionId).descriptor.backendId).toBe(f.second.id);
  expect(f.groups.store.binding(f.sessionId)?.memberKey).toBe(f.members[1]!.key);
  await restarted.beforeSend(f.sessionId, new AbortController().signal, queued.queueItemId);
  f.host.requestQueueDrain(f.sessionId); await until(() => f.store.getQueueItem(queued.queueItemId).state === "completed");
  expect(send).toHaveBeenCalledOnce(); expect(f.store.getOperation("rebalance-original-send").status).toBe("completed"); await restarted.close();
});

it("restores the original native account and backs off after a positively failed balancing handoff", async () => {
  const f = await rebalanceFixture(), originalSend = vi.spyOn(f.first, "send");
  vi.spyOn(f.second, "createSession").mockRejectedValueOnce(new JokoError({ code: "START_FAILED", message: "Native process exited before creation", phase: "session_start",
    retryable: true, stateMayHaveChanged: false, recovery: "Use the original account." }));
  const queued = f.enqueue(); await until(() => f.store.getQueueItem(queued.queueItemId).state === "completed");
  expect(f.store.getSession(f.sessionId).descriptor.backendId).toBe(f.first.id); expect(originalSend).toHaveBeenCalledOnce();
  expect(f.groups.store.binding(f.sessionId)?.memberKey).toBe(f.members[0]!.key);
  expect(await f.groups.service.rebalanceSuggestion(f.sessionId, BigInt(f.store.getSession(f.sessionId).descriptor.binding.generation), new AbortController().signal)).toBeUndefined();
});

it("retains the original balancing handoff after a native outcome is unknown without trying another effect", async () => {
  const f = await rebalanceFixture(), create = vi.spyOn(f.second, "createSession").mockRejectedValueOnce(new JokoError({ code: "START_UNKNOWN", message: "Lost the original native response",
    phase: "session_start", retryable: false, stateMayHaveChanged: true, recovery: "Inspect the original handoff." }));
  const queued = f.enqueue(); await until(() => new SessionRuntimeHandoffStore(f.store).read(f.sessionId)?.pending?.phase === "unknown");
  f.host.requestQueueDrain(f.sessionId); await new Promise(resolve => setTimeout(resolve, 25));
  expect(create).toHaveBeenCalledOnce(); expect(f.store.getQueueItem(queued.queueItemId)).toMatchObject({ state: "accepted", body: { text: "Exact queued owner input" } });
  expect(f.store.getSetting("service", queued.queueItemId, "provider.group-rebalance-choice.v1").value).toMatchObject({ phase: "started", operationId: "rebalance-original-send" });
});

it("keeps an admitted ask-only permission override while switching an unavailable group member", async () => {
  const f = await fixture(); f.groups.store.update(f.key, { strategy: "ordered", autoSwitch: true, members: f.members }, 0n);
  const sessionId = (await f.create("ask-only-route")).value.sessionId;
  f.groups.store.cool(f.key, { memberKey: f.members[0]!.key, cause: "usage-limit", until: Date.now() + 60_000 }, Date.now());
  const queued = f.host.enqueueInput({ operationId: "ask-only-send", connection: f.connection, sessionId, prompt: prompt("Original ask-only input"), overrides: { permissionMode: "ask" } }).value;
  await until(() => f.store.getQueueItem(queued.queueItemId).state === "completed");
  expect(f.store.getSession(sessionId).descriptor.backendId).toBe(f.second.id);
  expect(f.store.getQueueItem(queued.queueItemId).executionOverrides?.permissionMode).toBe("ask");
});

it("selects members by the exact requested speed without substituting ordinary Fast for Ultrafast", async () => {
  const f = await fixture(); f.groups.store.update(f.key, { strategy: "ordered", autoSwitch: true, members: f.members }, 0n);
  const model = f.registry.get(f.first.id).descriptor.models.find(model => model.modelId === "text")!;
  const statuses = f.members.map((member, index) => ({ member, available: true, reachable: true, running: 0, quota: { limited: false },
    model: { ...model, supportsFastMode: index === 0, supportsUltrafastMode: index === 1 }, assertCurrent: () => {} }));
  vi.spyOn(f.groups.directory, "members").mockResolvedValue(statuses);
  const input = { sessionId: "exact-speed", group: f.key, agentKind: "pi", modelId: "text", ownTask: true,
    profile: { backendId: f.first.id, providerId: "test", modelId: "text", fastMode: "ultrafast" as const } };
  const ultra = await f.groups.router.pick(input, new AbortController().signal);
  expect(ultra.member.key).toBe(f.members[1]!.key); expect(ultra.profile.fastMode).toBe("ultrafast"); ultra.release();
  const fast = await f.groups.router.pick({ ...input, profile: { ...input.profile, fastMode: true } }, new AbortController().signal);
  expect(fast.member.key).toBe(f.members[0]!.key); expect(fast.profile.fastMode).toBe(true); fast.release();
  statuses[1]!.model.supportsUltrafastMode = false;
  await expect(f.groups.router.pick(input, new AbortController().signal)).rejects.toThrow();
});

it("selects the actual initial native Backend while preserving the original Target and durable operation", async () => {
  const f = await fixture(), createFirst = vi.spyOn(f.first, "createSession"), createSecond = vi.spyOn(f.second, "createSession");
  f.groups.store.update(f.key, { strategy: "ordered", autoSwitch: true, members: [f.members[1]!, f.members[0]!] }, 0n);
  const created = await f.create("group-create"); const session = f.store.getSession(created.value.sessionId).descriptor;
  expect(session).toMatchObject({ backendId: f.second.id, targetId: "target", providerId: "test", modelId: "text" });
  expect(f.store.getTarget("target").descriptor.backendId).toBe(f.first.id); expect(createFirst).not.toHaveBeenCalled(); expect(createSecond).toHaveBeenCalledOnce();
  expect(f.groups.store.binding(session.id)?.memberKey).toBe(f.members[1]!.key);
  expect((await f.create("group-create")).replayed).toBe(true); expect(createSecond).toHaveBeenCalledOnce();
  const queued = f.send(session.id, "first-send"); await until(() => f.store.getRun(queued.runId).descriptor.state === "completed");
});
it("hands off through the native journal before an accepted send and commits its member only after adoption", async () => {
  const f = await fixture(); f.groups.store.update(f.key, { strategy: "ordered", autoSwitch: true, members: f.members }, 0n);
  const sessionId = (await f.create("group-before-send")).value.sessionId;
  const firstRun = f.send(sessionId, "existing-history"); await until(() => f.store.getRun(firstRun.runId).descriptor.state === "completed");
  const send = vi.spyOn(f.second, "send"), close = vi.spyOn(f.first, "closeSession");
  f.groups.store.cool(f.key, { memberKey: f.members[0]!.key, cause: "usage-limit", until: Date.now() + 60_000 }, Date.now());
  const queued = f.send(sessionId, "after-quota"); await until(() => f.store.getRun(queued.runId).descriptor.state === "completed");
  expect(close).toHaveBeenCalledOnce(); expect(f.store.getSession(sessionId).descriptor.backendId).toBe(f.second.id);
  expect(send.mock.calls[0]![0].text).toContain("This conversation was previously driven"); expect(send.mock.calls[0]![0].text).toContain("existing-history");
  expect(f.store.getQueueItem(queued.queueItemId).body.text).toBe("after-quota"); expect(f.groups.store.binding(sessionId)?.memberKey).toBe(f.members[1]!.key);
  expect(new SessionRuntimeHandoffStore(f.store).read(sessionId)?.pending).toBeUndefined();
});
it("uses the same failure policy after native terminal failure and continues once without an intermediate terminal error", async () => {
  const f = await fixture(); f.groups.store.update(f.key, { strategy: "ordered", autoSwitch: true, members: f.members }, 0n);
  const sessionId = (await f.create("group-run-failure")).value.sessionId, next = vi.spyOn(f.second, "send");
  vi.spyOn(f.first, "send").mockImplementationOnce(async (_input: PromptInput, context: AdapterContext) => {
    await context.emit({ type: "error", terminal: true, error: { code: "PROVIDER_OVERLOADED", message: "Provider at capacity", phase: "turn", retryable: true, stateMayHaveChanged: false, recovery: "Try another member." } });
    await context.emit({ type: "done", outcome: "failed" });
  });
  f.send(sessionId, "continue-original"); await until(() => next.mock.calls.length === 1 && f.store.listRuns({ sessionId }).some(run => run.descriptor.state === "completed"));
  expect(f.store.getSession(sessionId).descriptor.backendId).toBe(f.second.id); expect(f.groups.store.cooling(f.key, Date.now())).toMatchObject([{ memberKey: f.members[0]!.key, cause: "overload" }]);
  expect(f.store.listEvents({ sessionId }).filter(event => event.payload.type === "error" && event.payload.terminal)).toEqual([]);
  expect(next.mock.calls[0]![0].text).toContain("continue-original");
});
it("never picks another member after a native dispatch outcome becomes unknown", async () => {
  const f = await fixture(); f.groups.store.update(f.key, { strategy: "ordered", autoSwitch: true, members: f.members }, 0n);
  const sessionId = (await f.create("group-unknown")).value.sessionId, next = vi.spyOn(f.second, "createSession"); f.first.injectFault(sessionId, "dispatch_unknown");
  const queued = f.send(sessionId, "do-once"); await until(() => f.store.getRun(queued.runId).descriptor.state === "dispatch_unknown");
  f.host.requestQueueDrain(sessionId); await new Promise(resolve => setTimeout(resolve, 40));
  expect(next).not.toHaveBeenCalled(); expect(f.store.getSession(sessionId).descriptor.backendId).toBe(f.first.id);
});
it("switches only after an explicitly closed startup failure and retains uncertain native creation", async () => {
  const f = await fixture(); f.groups.store.update(f.key, { strategy: "ordered", autoSwitch: true, members: f.members }, 0n);
  vi.spyOn(f.first, "createSession").mockRejectedValueOnce(new JokoError({ code: "NATIVE_START_FAILED", message: "Process exited", phase: "session_start", retryable: true, stateMayHaveChanged: false, recovery: "Use another member." }));
  const sessionId = (await f.create("group-start-failure")).value.sessionId; expect(f.store.getSession(sessionId).descriptor.backendId).toBe(f.second.id);
  const next = vi.spyOn(f.second, "createSession"); f.groups.router.clearTurn("unused");
  vi.spyOn(f.first, "createSession").mockRejectedValueOnce(new JokoError({ code: "NATIVE_START_UNKNOWN", message: "Lost response", phase: "session_start", retryable: false, stateMayHaveChanged: true, recovery: "Inspect." }));
  await expect(f.create("group-start-unknown")).rejects.toThrow(); expect(next).not.toHaveBeenCalled();
  expect(new SessionRuntimeHandoffStore(f.store).creation("group-start-unknown")?.phase).toBe("unknown");
});
it("enqueues hidden owner input completion once and strips its marker before native dispatch", async () => {
  const f = await fixture(), sessionId = (await f.create("input-completion")).value.sessionId, session = f.store.getSession(sessionId).descriptor;
  const scope = { sessionId, targetId: session.targetId, generation: session.binding.generation, assertCurrent: () => {} }, nativeSend = f.first.send.bind(f.first);
  const send = vi.spyOn(f.first, "send").mockImplementation(async (input, context) => {
    await context.emit({ type: "message_complete", role: "user", blocks: [{ kind: "text", text: input.text }] }); await nativeSend(input, context);
  });
  const metadata = "[Input handoff ended]\nStatus: finished\nSteps: 2";
  const first = f.host.enqueueInputHandoffCompletion(scope, "request", metadata), replay = f.host.enqueueInputHandoffCompletion(scope, "request", metadata);
  expect(replay.replayed).toBe(true); expect(replay.value.queueItemId).toBe(first.value.queueItemId);
  await until(() => f.store.getRun(first.value.runId).descriptor.state === "completed"); expect(send).toHaveBeenCalledOnce();
  expect(send.mock.calls[0]![0].inputHandoffContinuation).toBeUndefined();
  expect(f.store.getQueueItem(first.value.queueItemId).body).toMatchObject({ inputHandoffContinuation: { requestId: "request" } });
  // The durable event keeps its server-owned marker; public consumers hide it.
  expect(f.store.listEvents({ sessionId }).find(event => event.payload.type === "message_complete" && event.payload.role === "user")?.payload)
    .toMatchObject({ inputHandoffContinuation: { requestId: "request" } });
  expect(() => f.host.enqueueServiceInput({ operationId: "forged", sessionId, source: "system", prompt: { ...prompt("fake"), inputHandoffContinuation: { requestId: "fake" } } })).toThrow("original");
});
it("fails a queued hidden completion if its original owner scope expires before dispatch", async () => {
  const f = await fixture(), sessionId = (await f.create("expired-completion")).value.sessionId, session = f.store.getSession(sessionId).descriptor;
  f.store.setQueuePaused({ sessionId, paused: true, traceId: "pause" }); let live = true;
  const queued = f.host.enqueueInputHandoffCompletion({ sessionId, targetId: session.targetId, generation: session.binding.generation,
    assertCurrent: () => { if (!live) throw new Error("Original scope expired"); } }, "request", "[Input handoff ended]\nStatus: cancelled");
  live = false; const send = vi.spyOn(f.first, "send"); f.store.setQueuePaused({ sessionId, paused: false, traceId: "resume" }); f.host.requestQueueDrain(sessionId);
  await until(() => f.store.getQueueItem(queued.value.queueItemId).state === "failed"); expect(send).not.toHaveBeenCalled();
});
it("retains an unknown hidden-completion dispatch without repeating it", async () => {
  const f = await fixture(), sessionId = (await f.create("unknown-completion")).value.sessionId, session = f.store.getSession(sessionId).descriptor;
  f.first.injectFault(sessionId, "dispatch_unknown"); const send = vi.spyOn(f.first, "send");
  const queued = f.host.enqueueInputHandoffCompletion({ sessionId, targetId: session.targetId, generation: session.binding.generation, assertCurrent: () => {} }, "request", "[Input handoff ended]\nStatus: finished");
  await until(() => f.store.getQueueItem(queued.value.queueItemId).state === "dispatch_unknown");
  f.host.enqueueInputHandoffCompletion({ sessionId, targetId: session.targetId, generation: session.binding.generation, assertCurrent: () => {} }, "request", "[Input handoff ended]\nStatus: finished");
  f.host.requestQueueDrain(sessionId); await new Promise(resolve => setTimeout(resolve, 30)); expect(send).toHaveBeenCalledOnce();
});
it("rejects an SDK-forged hidden marker on an ordinary user message", async () => {
  const f = await fixture(), sessionId = (await f.create("fake-native-marker")).value.sessionId, originalSend = f.first.send.bind(f.first);
  vi.spyOn(f.first, "send").mockImplementationOnce(async (input, context) => {
    await context.emit({ type: "message_complete", role: "user", blocks: [{ kind: "text", text: input.text }], inputHandoffContinuation: { requestId: "sdk-forgery" } }); await originalSend(input, context);
  });
  const queued = f.send(sessionId, "ordinary-input"); await until(() => f.store.getQueueItem(queued.queueItemId).state === "completed");
  const user = f.store.listEvents({ sessionId }).find(event => event.payload.type === "message_complete" && event.payload.role === "user");
  expect(user?.payload).toMatchObject({ type: "message_complete", role: "user" }); expect(user?.payload.type === "message_complete" && user.payload.inputHandoffContinuation).toBeUndefined();
});
it("does not recreate a coordinator scope for a queued hidden completion after Host restart", async () => {
  const f = await fixture(), sessionId = (await f.create("restart-completion")).value.sessionId, session = f.store.getSession(sessionId).descriptor;
  f.store.setQueuePaused({ sessionId, paused: true, traceId: "pause" });
  const queued = f.host.enqueueInputHandoffCompletion({ sessionId, targetId: session.targetId, generation: session.binding.generation, assertCurrent: () => {} }, "request", "[Input handoff ended]\nStatus: finished");
  await f.host.dispose();
  const artifacts = new ArtifactStore({ rootDirectory: join(f.root, "restarted-artifacts"), repository: new OperationalArtifactRepository(f.store), ingestRoots: [f.root] }); await artifacts.initialize();
  const adapter = new FakeBackendAdapter({ ...PI_LIKE_PROFILE, id: f.first.id }), restarted = new SessionHost(f.store, artifacts, [adapter], {
    backendDescriptors: f.registry.descriptors().filter(backend => backend.id === f.first.id), backendDescriptorsAlreadyPublished: true
  }); await restarted.initialize();
  cleanups.unshift(() => restarted.dispose()); const send = vi.spyOn(adapter, "send");
  f.store.setQueuePaused({ sessionId, paused: false, traceId: "resume" }); restarted.requestQueueDrain(sessionId);
  await until(() => f.store.getQueueItem(queued.value.queueItemId).state === "failed"); expect(send).not.toHaveBeenCalled();
});
