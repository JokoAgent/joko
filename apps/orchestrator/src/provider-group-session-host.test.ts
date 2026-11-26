import { randomUUID } from "node:crypto";
import { create as message } from "@bufbuild/protobuf";
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
import { ScheduleCoordinator } from "./schedule-coordinator.js";
import { defaultScheduleExtensionSnapshot, withScheduleExtensionSnapshot } from "./schedule-extensions.js";
import { ProviderGroupService } from "./provider-group-service.js";
import { providerGroupQuota } from "./provider-group-quota.js";
import { createClient, createRouterTransport } from "@connectrpc/connect";
import * as contract from "@joko/contracts";
import { createProviderGroupConnectService } from "./provider-group-connect-service.js";
import { isOfficialOpenAiKeyModel, localOpenAiPoolKey, type LocalOpenAiAccountIdentity } from "./local-openai-pool.js";
import type { ProviderDescriptor } from "./credential-manager.js";
import { ProviderGroupRemoteRouter } from "./provider-group-remote.js";
import { toProtoQueueItem } from "./proto-mapper.js";
import { mkdtemp } from "./test-paths.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0)) await close(); });
async function fixture(taskModels = false, openAiAccount?: (backend: string, provider: string, model: string) => LocalOpenAiAccountIdentity | undefined) {
  const root = await mkdtemp(join(tmpdir(), "joko-group-host-")), store = new OperationalStore(join(root, "store.db"));
  const artifacts = new ArtifactStore({ rootDirectory: join(root, "artifacts"), repository: new OperationalArtifactRepository(store), ingestRoots: [root] }); await artifacts.initialize();
  const profile = { ...PI_LIKE_PROFILE, capabilities: PI_LIKE_PROFILE.capabilities.map(capability => capability.key === "permission.modes" ? { ...capability, options: ["ask", "auto", "bypassPermissions"] } : capability) };
  const first = new FakeBackendAdapter({ ...profile, id: "group-first" }), second = new FakeBackendAdapter({ ...profile, id: "group-second" });
  const registry = new BackendInstanceRegistry(store); await registry.provision([first, second].map((adapter, index) => ({
    instanceId: adapter.id, adapterKind: taskModels ? index === 0 ? "codex" : "pi" : "fake", displayName: adapter.id, create: () => adapter
  })));
  const host = new SessionHost(store, artifacts, registry.availableAdapters(), { backendDescriptors: registry.descriptors(), backendDescriptorsAlreadyPublished: true }); await host.initialize();
  const sources = { groupCatalog: () => [], installGroupSwitch: () => {}, installGroupStore: () => {}, sourceKind: () => undefined } as unknown as HostedAgentSources;
  const groups = new ProviderGroupRuntime({ store, registry, sources, nodeId: "group-node", nodeName: () => "This node", ownerGeneration: () => "owner-1",
    now: () => Date.now(), ...(openAiAccount ? { openAiAccount } : {}),
    sessions: host.providerGroupSessionPort(), readAccountUsage: async () => undefined, activeTurns: (backend, provider) => host.activeProviderTurns(backend, provider), assertRemoteAllowed: () => {} }); host.installProviderGroupRuntime(groups);
  await host.registerTarget({ id: "target", backendId: first.id, displayName: "Workspace", workspaceRoot: root, managed: false, trusted: true });
  const connection = store.createConnection({ id: "controller", name: "Owner", authKeyDigest: "digest" });
  cleanups.push(async () => { await host.dispose(); await groups.close(); store.close(); await rm(root, { recursive: true, force: true }); });
  const key = { backendId: first.id, providerId: "test" }, members = groups.sources().filter(row => row.providerId === "test").map(providerGroupDefaultMember);
  const create = (id: string) => host.createSession({ operationId: id, connection, targetId: "target", title: "Grouped task", providerId: "test", modelId: "text", effort: "medium", permissionMode: "ask", planMode: false, fastMode: false });
  const send = (sessionId: string, id: string, text = id) => host.enqueueInput({ operationId: id, connection, sessionId, prompt: prompt(text) }).value;
  return { root, store, host, groups, registry, first, second, key, members, create, send, connection };
}
const prompt = (text: string): PromptInput => ({ text, images: [], files: [], mentions: [], disposition: "prompt" });

it("admits only authenticated official Responses API keys for the requested wire model", () => {
  const key = { enabled: true, authenticationState: "authenticated", kind: "custom_endpoint", credentialOrigin: "https://api.openai.com",
    provider: { id: "custom", baseUrl: "https://api.openai.com/v1/", api: "openai-responses", apiKeyEnv: "TEST_KEY", models: [{ id: "exact" }] } } as ProviderDescriptor;
  expect(isOfficialOpenAiKeyModel(key, "exact")).toBe(true);
  expect(isOfficialOpenAiKeyModel(key, "alias")).toBe(false);
  for (const baseUrl of ["https://other.test/v1", "https://api.openai.com/v1?override=1", "https://api.openai.com/v2"]) {
    expect(isOfficialOpenAiKeyModel({ ...key, provider: { ...key.provider, baseUrl } }, "exact")).toBe(false);
  }
  expect(isOfficialOpenAiKeyModel({ ...key, provider: { ...key.provider, models: [{ id: "exact", baseUrl: "https://other.test/v1" }] } }, "exact")).toBe(false);
  expect(isOfficialOpenAiKeyModel({ ...key, requestPath: "/chat/completions" }, "exact")).toBe(false);
});

it("opts a local subscription into an exact account pool, switches its owned send and keeps the pool private", async () => {
  let subscriptionReady = true;
  const f = await fixture(false, (backend, provider, model) => provider !== "test" || model !== "text" ? undefined
    : backend === "group-first" ? subscriptionReady ? { kind: "subscription", generation: "original" } : undefined : { kind: "key", generation: "key-1" });
  const client = (management: boolean) => createClient(contract.ProviderGroupService, createRouterTransport(router => router.service(contract.ProviderGroupService,
    createProviderGroupConnectService(f.groups.connectOptions(() => ({ id: "owner", management, trust: "owner", assertCurrent() {} }))))));
  const owner = client(true), peer = client(false), source = { backendId: f.second.id, providerId: "test" };
  expect((await owner.getLocalOpenAiPool({ target: f.key })).accounts.filter(account => account.included)).toHaveLength(1);
  await expect(peer.setLocalOpenAiPoolMember({ target: f.key, source, included: true })).rejects.toThrow(/permission_denied/i);
  await expect(owner.setLocalOpenAiPoolMember({ target: f.key, source: { ...source, providerId: "vision" }, included: true })).rejects.toThrow();
  const saved = await owner.setLocalOpenAiPoolMember({ target: f.key, source, included: true });
  expect(saved.pool?.accounts.filter(row => row.included)).toHaveLength(2);
  await expect(owner.setLocalOpenAiPoolMember({ target: source, source: f.key, included: true })).rejects.toThrow();
  expect((await owner.listProviderGroups({})).groups).toEqual([]);
  await expect(peer.getProviderGroup({ key: localOpenAiPoolKey(f.key) })).rejects.toThrow(/permission_denied/i);
  const sessionId = (await f.create("mixed-account-task")).value.sessionId;
  expect(f.groups.store.binding(sessionId)).toMatchObject({ group: localOpenAiPoolKey(f.key), backendId: f.first.id });
  const original = f.store.getSession(sessionId).descriptor.binding;
  subscriptionReady = false;
  const send = vi.spyOn(f.second, "send"), queued = f.send(sessionId, "send-via-key");
  await until(() => f.store.getQueueItem(queued.queueItemId).state === "completed");
  expect(send).toHaveBeenCalledOnce();
  expect(f.store.getSession(sessionId).descriptor).toMatchObject({ id: sessionId, targetId: "target", backendId: f.second.id, modelId: "text" });
  expect(f.store.getSession(sessionId).descriptor.binding.opaqueRef).not.toBe(original.opaqueRef);
  await owner.setLocalOpenAiPoolMember({ target: f.key, source, included: false, expectedRevision: saved.pool!.revision });
  expect(f.groups.store.bindingRecord(sessionId)?.released).toBe(true);
});
async function until(predicate: () => boolean): Promise<void> { await vi.waitFor(() => expect(predicate()).toBe(true), { timeout: 8000, interval: 10 }); }

function taskModelGroup(f: Awaited<ReturnType<typeof fixture>>, strategy: contract.TaskModelGroupStrategy, firstWeight?: number) {
  const sources = f.groups.taskModels.list().sources;
  const text = sources.find(row => row.source?.backendId === f.first.id && row.source.modelId === "text")!.source!;
  const image = sources.find(row => row.source?.backendId === f.second.id && row.source.modelId === "multimodal")!.source!;
  const group = message(contract.TaskModelGroupSchema, { groupId: "work", name: "Work", strategy,
    preferVisionWithImages: true, effortId: "high", candidates: [{ source: text, weight: firstWeight }, { source: image }] });
  const config = f.groups.taskModels.save(0n, [group]);
  const selection = (hasImages = false) => message(contract.TaskModelGroupSelectionSchema, { groupId: "work", expectedRevision: config.revision, hasImages });
  const preview = (hasImages = false) => f.groups.taskModels.preview(selection(hasImages), new AbortController().signal);
  const create = (operationId: string, hasImages = false) => f.host.createSession({
    operationId, connection: f.connection, targetId: "target", title: "Grouped", taskModelGroup: selection(hasImages),
    providerId: "test", modelId: "text", permissionMode: "ask", planMode: false, fastMode: false
  });
  return { text, image, group, config, selection, preview, create };
}

it("rotates across exact accounts and Backends after first input, and binds the picked model to the task", async () => {
  const f = await fixture(true);
  const group = taskModelGroup(f, contract.TaskModelGroupStrategy.ROUND_ROBIN);
  const firstStart = vi.spyOn(f.first, "createSession"), secondStart = vi.spyOn(f.second, "createSession");
  expect((await group.preview()).selected?.source).toEqual(group.text);
  expect((await group.preview(true)).selected?.source).toEqual(group.image);
  const firstId = (await group.create("start-group-first")).value.sessionId;
  expect(firstStart.mock.calls[0]?.[0]).toMatchObject({ providerId: "test", modelId: "text" });
  expect(firstStart.mock.calls[0]?.[0].effort).toBeUndefined();
  expect((await group.preview()).selected?.source).toEqual(group.text);
  const queued = f.send(firstId, "first-group-input");
  await until(() => f.store.getQueueItem(queued.queueItemId).state === "completed");
  expect((await group.preview()).selected?.source).toEqual(group.image);
  const second = await group.create("start-group-second");
  expect(secondStart.mock.calls[0]?.[0]).toMatchObject({ providerId: "vision", modelId: "multimodal", effort: "high" });
  expect(f.store.getSession(second.value.sessionId).descriptor).toMatchObject({
    backendId: f.second.id, providerId: "vision", modelId: "multimodal", targetId: "target"
  });
  expect(f.groups.taskModels.binding(second.value.sessionId)).toMatchObject({
    groupId: "work", source: { backendId: f.second.id, providerId: "vision", modelId: "multimodal" }
  });
  expect((await group.create("start-group-second")).replayed).toBe(true);
  expect(secondStart).toHaveBeenCalledOnce();
  const secondInput = f.send(second.value.sessionId, "second-group-input");
  await until(() => f.store.getQueueItem(secondInput.queueItemId).state === "completed");
  expect((await group.preview()).selected?.source).toEqual(group.text);
  expect((await group.preview(true)).selected?.source).toEqual(group.image);
  const exact = (await f.create("exact-outside-group")).value.sessionId;
  expect(f.groups.taskModels.binding(exact)).toBeUndefined();
  expect(f.store.getSession(exact).descriptor).toMatchObject({ backendId: f.first.id, providerId: "test", modelId: "text" });
});

it("resolves a saved Partner route and a persistent Schedule on their owner, retaining the adopted occurrence route", async () => {
  const f = await fixture(true);
  const group = taskModelGroup(f, contract.TaskModelGroupStrategy.ROUND_ROBIN);
  const partner = { operationId: "partner-group-first", serviceKind: "partner" as const, targetId: "target", title: "Partner",
    savedModelGroupId: "work", providerId: "test", modelId: "text", fastMode: false, planMode: false, permissionMode: "ask" as const };
  const first = await f.host.createServiceSession(partner);
  expect(f.groups.taskModels.binding(first.value.sessionId)?.source.backendId).toBe(f.first.id);
  expect((await f.host.createServiceSession(partner)).replayed).toBe(true);
  expect((await group.preview()).selected?.source).toEqual(group.image);
  f.store.upsertSchedule({ id: "grouped-schedule", backendId: f.first.id, targetId: "target", sessionMode: "persistent",
    name: "Grouped job", kind: "manual", timezone: "UTC", enabled: true, prompt: prompt("Run once"),
    executionSnapshot: withScheduleExtensionSnapshot({ taskModelGroupId: "work", providerId: "test", modelId: "text", permissionMode: "ask",
      useWorktree: false, refreshWorktreeRemote: false }, defaultScheduleExtensionSnapshot()),
    overlapPolicy: "queue", misfirePolicy: "run_once" });
  const scheduler = new ScheduleCoordinator(f.store, f.host);
  try {
    const result = await scheduler.runNowWithResult("grouped-schedule", "group-fire");
    expect(result.status, JSON.stringify(f.store.findScheduleRunByRunId(result.runId)?.detail)).toBe("queued");
    const session = f.store.getSession(result.sessionId!).descriptor;
    expect(session).toMatchObject({ targetId: "target", backendId: f.second.id, modelId: "multimodal", automationOrigin: { scheduleId: "grouped-schedule" } });
    expect(f.store.getSchedule("grouped-schedule").sessionId).toBe(session.id);
    expect((await group.preview()).selected?.source).toEqual(group.text);
    await until(() => f.store.findQueueItemByRunId(session.id, result.runId, { includeCleared: true })?.state === "completed");
    const next = await scheduler.runNowWithResult("grouped-schedule", "group-fire-next");
    expect(next).toMatchObject({ status: "queued", sessionId: session.id });
    expect(f.store.findQueueItemByRunId(session.id, next.runId, { includeCleared: true })?.executionOverrides).toMatchObject({ modelId: "multimodal" });
    expect((await group.preview()).selected?.source).toEqual(group.text);
    await until(() => f.store.findQueueItemByRunId(session.id, next.runId, { includeCleared: true })?.state === "completed");
    f.groups.taskModels.save(group.config.revision, []);
    const plain = await f.host.createServiceSession({ ...partner, operationId: "deleted-group-partner" });
    expect(f.store.getSession(plain.value.sessionId).descriptor).toMatchObject({ backendId: f.first.id, modelId: "text" });
    expect(f.groups.taskModels.binding(plain.value.sessionId)).toBeUndefined();
  } finally { scheduler.stop(); }
});

it("applies smooth task-model weights once per adopted input and never advances them on previews", async () => {
  const f = await fixture(true), group = taskModelGroup(f, contract.TaskModelGroupStrategy.WEIGHTED, 3);
  for (const [index, source] of [group.text, group.text, group.image, group.text].entries()) {
    expect((await group.preview()).selected?.source).toEqual(source);
    const id = (await group.create(`weighted-create-${index}`)).value.sessionId;
    expect((await group.preview()).selected?.source).toEqual(source);
    const queued = f.send(id, `weighted-input-${index}`);
    await until(() => f.store.getQueueItem(queued.queueItemId).state === "completed");
    f.groups.taskModels.commitBoundRotation(id);
  }
});

it("retains the last usable drain member after an earlier account recovers", async () => {
  const f = await fixture(true), group = taskModelGroup(f, contract.TaskModelGroupStrategy.DRAIN);
  const read = f.groups.directory.read.bind(f.groups.directory);
  let firstLimited = true;
  vi.spyOn(f.groups.directory, "read").mockImplementation(async (...args) => {
    const status = await read(...args);
    return firstLimited && args[0].backendId === f.first.id ? { ...status, available: false, quota: { limited: true } } : status;
  });
  const id = (await group.create("drain-create")).value.sessionId, queued = f.send(id, "drain-input");
  await until(() => f.store.getQueueItem(queued.queueItemId).state === "completed");
  firstLimited = false;
  expect((await group.preview()).selected?.source).toEqual(group.image);
});

it("uses the tightest live long window for headroom, keeping group order on ties", async () => {
  const f = await fixture(true), group = taskModelGroup(f, contract.TaskModelGroupStrategy.HEADROOM);
  let firstUsed: number | undefined;
  vi.spyOn(f.groups.directory.options.quotas.options, "readLocal").mockImplementation(async member => {
    const used = member.backendId === f.first.id ? firstUsed : 30;
    return used === undefined ? undefined : { providerId: member.providerId, observedAt: Date.now(),
      primaryWindow: { windowMinutes: 300, usedPercent: 96 }, secondaryWindow: { windowMinutes: 10_080, usedPercent: used } };
  });
  expect((await group.preview()).selected?.source).toEqual(group.image);
  firstUsed = 30;
  expect((await group.preview()).selected?.source).toEqual(group.text);
  firstUsed = 31;
  expect((await group.preview()).selected?.source).toEqual(group.image);
});

it("selects a model group on an existing task and holds a new input until the chosen Backend owns it", async () => {
  const f = await fixture(true);
  const group = taskModelGroup(f, contract.TaskModelGroupStrategy.ROUND_ROBIN);
  const sessionId = (await f.create("existing-ordinary-task")).value.sessionId;
  const generation = BigInt(f.store.getSession(sessionId).descriptor.binding.generation);
  const initial = f.host.getSessionRuntimeControl(sessionId).generation;
  const pick = (expectedGeneration: number) => f.host.selectTaskModelGroup({
    sessionId, sessionGeneration: generation, expectedGeneration, selection: group.selection(), assertOwner: () => undefined
  });
  expect(f.host.taskModelGroupSelectionState(sessionId)).toEqual({ taskModelGroupSelectionAvailable: true });
  await pick(initial);
  expect(f.host.taskModelGroupSelectionState(sessionId)).toMatchObject({ taskModelGroupId: "work" });
  expect(f.store.getSession(sessionId).descriptor.binding.generation).toBe(Number(generation));
  await expect(pick(initial)).rejects.toThrow(/changed/u);
  expect((await group.preview()).selected?.source).toEqual(group.image);

  let release!: () => void;
  let reading = false;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const read = f.groups.directory.read.bind(f.groups.directory);
  const waitForSelection = vi.spyOn(f.groups.directory, "read").mockImplementation(async (...args) => {
    reading = true;
    await gate;
    return read(...args);
  });
  const oldBackend = vi.spyOn(f.first, "send"), chosenBackend = vi.spyOn(f.second, "send");
  const choosing = pick(f.host.getSessionRuntimeControl(sessionId).generation);
  let queued: ReturnType<typeof f.send>;
  try {
    await until(() => reading);
    queued = f.send(sessionId, "input-while-choosing-group", "input while choosing the next group source");
    expect(f.store.getQueueItem(queued.queueItemId).state).toBe("accepted");
    expect(oldBackend).not.toHaveBeenCalled();
  } finally {
    release();
    try { await choosing; }
    finally { waitForSelection.mockRestore(); }
  }
  await until(() => f.store.getQueueItem(queued.queueItemId).state === "completed");
  expect(oldBackend).not.toHaveBeenCalled();
  expect(chosenBackend).toHaveBeenCalledOnce();
  expect(f.store.getSession(sessionId).descriptor).toMatchObject({ backendId: f.second.id, modelId: "multimodal", targetId: "target" });
  expect(f.groups.taskModels.binding(sessionId)?.source).toEqual({ sourceKey: group.image.sourceKey,
    backendId: f.second.id, providerId: "vision", modelId: "multimodal" });
});

it("retains the earliest eligible quota-limited route and its original input through queue admission", async () => {
  const f = await fixture(true);
  const group = taskModelGroup(f, contract.TaskModelGroupStrategy.ORDERED);
  const resetAt = Date.now() + 60_000;
  const ready = new Set<string>();
  vi.spyOn(f.groups.directory, "read").mockImplementation(async (member, request) => {
    const model = f.registry.get(member.backendId).descriptor.models.find(model => model.modelId === request.modelId && model.providerId === member.providerId);
    const limited = !ready.has(member.backendId);
    return { member, available: !limited, reachable: true, model, running: 0, assertCurrent: () => {},
      quota: { limited, ...(limited ? { resetAt: resetAt + (member.backendId === f.first.id ? 10_000 : 0) } : {}) } };
  });
  expect(await group.preview()).toMatchObject({ selected: { source: group.image }, quotaLimited: true, availableAtMs: BigInt(resetAt) });
  const session = (await group.create("wait-on-group")).value.sessionId;
  const send = vi.spyOn(f.second, "send");
  const queued = f.send(session, "exact-group-waiting-input");
  await until(() => f.store.getQueueItem(queued.queueItemId).error?.retryAt === resetAt);
  expect(send).not.toHaveBeenCalled();
  ready.add(f.second.id);
  const clock = vi.spyOn(Date, "now").mockReturnValue(resetAt + 1);
  try {
    f.host.requestQueueDrain(session);
    await until(() => f.store.getQueueItem(queued.queueItemId).state === "completed");
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0]?.[0].text).toContain("exact-group-waiting-input");
    expect(f.store.listRuns({ sessionId: session })).toHaveLength(1);
  } finally { clock.mockRestore(); }
});

it("offers a same-computer group source for the exact settled quota error and rebinds through the ordinary runtime control", async () => {
  const f = await fixture(true);
  const group = taskModelGroup(f, contract.TaskModelGroupStrategy.ORDERED);
  const sessionId = (await group.create("start-group-quota-switch")).value.sessionId;
  vi.spyOn(f.first, "send").mockImplementationOnce(async (_input, context) => {
    await context.emit({ type: "error", terminal: true, error: { code: "USAGE_LIMIT", message: "Account quota exhausted",
      phase: "turn", retryable: true, stateMayHaveChanged: false, recovery: "Wait for quota." } });
    await context.emit({ type: "done", outcome: "failed" });
  });
  const queue = f.send(sessionId, "failing-model-group-input");
  await until(() => f.store.getRun(queue.runId).descriptor.state === "failed" && f.store.getQueueItem(queue.queueItemId).state === "failed");
  const sessionGeneration = BigInt(f.store.getSession(sessionId).descriptor.binding.generation);
  const request = message(contract.GetTaskModelGroupSwitchRequestSchema, { sessionId, sessionGeneration, failedRunId: queue.runId });
  const offer = await f.host.getTaskModelGroupSwitch(request, new AbortController().signal);
  const exact = message(contract.TaskModelGroupSwitchSchema, offer!);
  expect(exact).toMatchObject({ sessionId, failedRunId: queue.runId, selected: { source: group.image } });
  await expect(f.host.applyTaskModelGroupSwitch({ ...exact, expectedRuntimeGeneration: exact.expectedRuntimeGeneration + 1n }, () => undefined)).rejects.toThrow("offer expired");
  await f.host.applyTaskModelGroupSwitch(exact, () => undefined);
  expect(f.host.getSessionRuntimeControl(sessionId).pending?.profile).toMatchObject({ backendId: f.second.id, providerId: "vision", modelId: "multimodal" });
  expect(f.groups.taskModels.binding(sessionId)?.source).toEqual({
    sourceKey: group.image.sourceKey, backendId: group.image.backendId, providerId: group.image.providerId, modelId: group.image.modelId
  });
  expect(f.store.listRuns({ sessionId })).toHaveLength(1);
  expect(await f.host.getTaskModelGroupSwitch(request, new AbortController().signal)).toBeUndefined();
});

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
  const wire = (store: OperationalStore) => toProtoQueueItem(store.getQueueItem(queued.queueItemId), {
    backendId: f.first.id, targetId: "target", source: "user", generation: store.getSession(sessionId).descriptor.binding.generation
  });
  expect(contract.queueQuotaRetryAt(wire(f.store))).toBe(resetAt);
  expect(f.store.listEvents({ sessionId }).some(event => event.payload.type === "queue_update"
    && event.payload.itemId === queued.queueItemId && event.traceId.endsWith(`:quota:${resetAt}`))).toBe(true);
  const restored = await reopenGroupHost(f, resetAt), resumedSend = vi.spyOn(restored.first, "send");
  expect(restored.store.getSetting("session", sessionId, `provider.group-error:${queued.runId}`).value).toMatchObject({ kind: "queue-head", queueItemId: queued.queueItemId, operationId: "quota-wait-original", resumeAt: resetAt });
  expect(contract.queueQuotaRetryAt(wire(restored.store))).toBe(resetAt);
  expect(resumedSend).not.toHaveBeenCalled();
  const clock = vi.spyOn(Date, "now").mockReturnValue(resetAt + 1);
  try {
    restored.host.requestQueueDrain(sessionId); await until(() => restored.store.getQueueItem(queued.queueItemId).state === "completed");
    restored.host.requestQueueDrain(sessionId); expect(resumedSend).toHaveBeenCalledOnce();
    expect(restored.store.listRuns({ sessionId })).toHaveLength(1); expect(restored.store.getOperation("quota-wait-original").status).toBe("completed");
    expect(restored.store.findSetting("session", sessionId, `provider.group-error:${queued.runId}`)).toBeUndefined();
    expect(contract.queueQuotaRetryAt(wire(restored.store))).toBeUndefined();
  } finally { clock.mockRestore(); }
});

it.each(["reorder", "withdraw"] as const)("retires the quota wait when the owner changes its queue head by %s", async action => {
  const f = await fixture();
  f.groups.store.update(f.key, { strategy: "ordered", autoSwitch: true, members: f.members }, 0n);
  const sessionId = (await f.create("quota-owner-change")).value.sessionId;
  const resetAt = Date.now() + 60_000;
  let secondAvailable = false;
  vi.spyOn(f.groups.directory, "read").mockImplementation(async member => {
    const limited = member.backendId === f.first.id;
    const model = f.registry.get(member.backendId).descriptor.models.find(model => model.providerId === member.providerId)!;
    return { member, available: !limited && secondAvailable, reachable: limited || secondAvailable, model, running: 0,
      assertCurrent: () => {}, quota: { limited, ...(limited ? { resetAt } : {}) },
      ...(limited ? { reason: "quota" as const } : !secondAvailable ? { reason: "offline" as const } : {}) };
  });
  const first = f.send(sessionId, "waiting-first"), second = f.send(sessionId, "new-queue-head");
  const firstSend = vi.spyOn(f.first, "send"), secondSend = vi.spyOn(f.second, "send");
  const key = `provider.group-error:${first.runId}`;
  await until(() => (f.store.findSetting("session", sessionId, key)?.value as { resumeAt?: number } | undefined)?.resumeAt === resetAt);
  expect(f.store.getQueueItem(second.queueItemId).state).toBe("accepted");
  expect(firstSend).not.toHaveBeenCalled();
  expect(secondSend).not.toHaveBeenCalled();
  secondAvailable = true;
  if (action === "withdraw") f.store.cancelQueueItem({ queueItemId: first.queueItemId, connectionId: f.connection.id, traceId: "withdraw-old-head" });
  else {
    const lock = { sessionId, connectionId: f.connection.id, lockToken: randomUUID(), ttlMs: 5000 };
    f.store.setQueueInteractionLock({ ...lock, locked: true, traceId: "lock-reorder" });
    f.store.reorderQueueItem({ queueItemId: second.queueItemId, placement: { beforeQueueItemId: first.queueItemId },
      connectionId: f.connection.id, lockToken: lock.lockToken, traceId: "move-new-head" });
    f.store.setQueueInteractionLock({ ...lock, locked: false, traceId: "unlock-reorder" });
  }
  f.host.requestQueueDrain(sessionId);
  await until(() => f.store.getQueueItem(second.queueItemId).state === "completed");
  expect(Date.now()).toBeLessThan(resetAt);
  expect(f.store.findSetting("session", sessionId, key)).toBeUndefined();
  expect(f.store.getQueueItem(first.queueItemId).error?.retryAt).toBeUndefined();
  expect(secondSend.mock.calls[0]?.[0].text).toContain("new-queue-head");
  if (action === "withdraw") expect(f.store.getQueueItem(first.queueItemId).state).toBe("cancelled");
});

it("discards a healthy Provider candidate read after the original accepted input is withdrawn", async () => {
  const f = await fixture();
  f.groups.store.update(f.key, { strategy: "ordered", autoSwitch: true, members: f.members }, 0n);
  const sessionId = (await f.create("withdraw-inflight-provider-preflight")).value.sessionId;
  const originalBinding = f.store.getSession(sessionId).descriptor.binding;
  const originalMember = f.groups.store.binding(sessionId)?.memberKey;
  let finishRead!: () => void;
  const pendingRead = new Promise<void>(resolve => { finishRead = resolve; });
  let readingCandidate = false;
  vi.spyOn(f.groups.directory, "read").mockImplementation(async member => {
    const limited = member.backendId === f.first.id;
    if (!limited) { readingCandidate = true; await pendingRead; }
    const model = f.registry.get(member.backendId).descriptor.models.find(model => model.providerId === member.providerId)!;
    return { member, available: !limited, reachable: true, model, running: 0, assertCurrent: () => {}, quota: { limited },
      ...(limited ? { reason: "quota" as const } : {}) };
  });
  const preflight = vi.spyOn(f.groups.service, "beforeSend");
  const createSecond = vi.spyOn(f.second, "createSession"), originalSend = vi.spyOn(f.first, "send");
  const input = f.send(sessionId, "original-withdrawn-input");
  try {
    await until(() => readingCandidate);
    f.store.cancelQueueItem({ queueItemId: input.queueItemId, connectionId: f.connection.id, traceId: "withdraw-inflight-head" });
    f.host.requestQueueDrain(sessionId);
    finishRead();
    await expect(preflight.mock.results[0]?.value).rejects.toThrow(/superseded/iu);
    expect(f.store.getQueueItem(input.queueItemId).state).toBe("cancelled");
    expect(f.store.getSession(sessionId).descriptor.binding).toEqual(originalBinding);
    expect(f.groups.store.binding(sessionId)?.memberKey).toBe(originalMember);
    expect(createSecond).not.toHaveBeenCalled();
    expect(originalSend).not.toHaveBeenCalled();
    expect(new SessionRuntimeHandoffStore(f.store).read(sessionId)?.pending).toBeUndefined();
  } finally { finishRead(); }
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

it("reserves only open computer slots and reports saturation through the owner route until release", async () => {
  const f = await fixture(), members = f.members.map(member => ({ ...member, capacity: 1 }));
  f.groups.store.update(f.key, { strategy: "ordered", autoSwitch: true, members }, 0n);
  const [a, b] = members.map(member => member.key) as [string, string];
  const signal = new AbortController().signal;
  const pick = (sessionId: string, exclude?: ReadonlySet<string>) => f.groups.router.pick({
    sessionId, group: f.key, agentKind: "fake", modelId: "text", ownTask: true,
    profile: { ...f.key, modelId: "text", fastMode: false }, ...(exclude ? { exclude } : {})
  }, signal);
  const [first, second] = await Promise.all([pick("first"), pick("second")]);
  expect(new Set([first.member.key, second.member.key])).toEqual(new Set([a, b]));
  const counts = () => members.map(member => f.groups.leases.count(member.key));
  expect(counts()).toEqual([1, 1]);
  await expect(pick("full")).rejects.toMatchObject({ full: true, code: "PROVIDER_GROUP_FULL", retryAt: undefined });
  await expect(pick("excluded", new Set([a, b]))).rejects.toMatchObject({ full: false });
  const transport = createRouterTransport(router => router.service(contract.ProviderGroupService, createProviderGroupConnectService({
    service: f.groups.service, usage: f.groups.usage, schedulingState: async () => ({ activeTurns: 0 }),
    authenticate: () => ({ id: "peer-owner", trust: "owner", management: false, assertCurrent: () => {} }), assertRemoteAllowed: () => {}
  })));
  const peer = { captureGroupPeer: () => ({ transport, nativeBackendId: f.first.id, ownerNodeId: "group-node", assertCurrent: () => {} }) } as unknown as HostedAgentSources;
  const remote = new ProviderGroupRemoteRouter({ store: f.groups.store, sources: peer, directory: f.groups.directory,
    leases: f.groups.leases, localNodeId: "receiver", ownerGeneration: () => "receiver-owner" });
  await expect(remote.pick({ sessionId: "remote-full", group: f.key, agentKind: "fake", modelId: "text", ownTask: false,
    profile: { ...f.key, modelId: "text", fastMode: false } }, signal)).rejects.toMatchObject({ code: "PROVIDER_GROUP_FULL", retryAt: undefined });
  expect(counts()).toEqual([1, 1]);
  second.release();
  const reopened = await pick("after-release");
  expect(reopened.member.key).toBe(second.member.key);
  first.release(); reopened.release();
  expect(counts()).toEqual([0, 0]);

  // An independently running turn and a provisional group pick consume separate slots.
  f.groups.store.update(f.key, { strategy: "ordered", autoSwitch: true, members: [{ ...members[0]!, capacity: 2 }, members[1]!] }, 1n);
  vi.spyOn(f.groups.directory.options, "running").mockImplementation(source => source.key === a ? 1 : 0);
  const remaining = await pick("remaining", new Set([b]));
  await expect(pick("no-spare", new Set([b]))).rejects.toMatchObject({ full: true });
  remaining.release();
});

it("keeps unknown computer quotas in order and filters measured pace, tight windows and exclusions before reserving", async () => {
  const f = await fixture(), [a, b] = f.members.map(member => member.key) as [string, string];
  f.groups.store.update(f.key, { strategy: "ordered", autoSwitch: true, members: f.members }, 0n);
  const now = Date.now(), signal = new AbortController().signal;
  let firstUsed: number | undefined, fiveHourUsed = 0;
  vi.spyOn(f.groups.directory.options.quotas.options, "readLocal").mockImplementation(async member => {
    const usedPercent = member.key === a ? firstUsed : 0;
    return usedPercent === undefined ? undefined : { providerId: member.providerId, observedAt: now,
      primaryWindow: { usedPercent: member.key === a ? fiveHourUsed : 0, windowMinutes: 300, resetAt: now + 2 * 3_600_000 },
      secondaryWindow: { usedPercent, windowMinutes: 10_080, resetAt: now + 8 * 86_400_000 } };
  });
  const pick = async (exclude?: ReadonlySet<string>) => {
    const assignment = await f.groups.router.pick({ sessionId: "ordered", group: f.key, agentKind: "fake", modelId: "text", ownTask: true,
      profile: { ...f.key, modelId: "text", fastMode: false }, ...(exclude ? { exclude } : {}) }, signal);
    assignment.release(); return assignment.member.key;
  };
  expect(await pick()).toBe(a);
  expect(await pick(new Set([a]))).toBe(b);
  firstUsed = 10;
  expect(await pick()).toBe(a);
  firstUsed = 10.01;
  expect(await pick()).toBe(b);
  firstUsed = 0; fiveHourUsed = 85;
  expect(await pick()).toBe(b);
  f.groups.router.markTried("ordered", b);
  expect(await pick()).toBe(a);
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
