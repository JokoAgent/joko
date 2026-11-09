import { createHash } from "node:crypto";
import { createClient, createRouterTransport } from "@connectrpc/connect";
import { HostedAgentService } from "@joko/contracts";
import type { NativeSessionState, ProviderModel } from "@joko/core";
import { OperationalStore, ProviderGroupStore, ProviderGroupUsageStore, type ProviderGroupMember } from "@joko/store";
import { afterEach, expect, it, vi } from "vitest";
import { HostedAgentHost, type HostedAgentOpen, type HostedAgentPrincipal, type HostedAgentPollCursor, type HostedAgentPollRun } from "./hosted-agent-host.js";
import type { HostedAgentCall } from "./hosted-agent-run.js";
import { ProviderGroupDirectory, type ProviderGroupDirectorySource } from "./provider-group-directory.js";
import { ProviderGroupHostedEndpoint, type ProviderGroupNativeCapture } from "./provider-group-hosted.js";
import { ProviderGroupLeases } from "./provider-group-leases.js";
import { ProviderGroupQuotaReader } from "./provider-group-quota.js";
import { ProviderGroupRouter } from "./provider-group-router.js";
import type { ProviderGroupRuntime } from "./provider-group-runtime.js";
import { ProviderGroupUsage } from "./provider-group-usage.js";
import { HostedAgentConnectClient } from "./hosted-agent-connect-client.js";
import { createHostedAgentConnectService } from "./hosted-agent-connect-service.js";
import { decodeHostedWorkflowProgress } from "./hosted-agent-workflow-wire.js";
import type { HostedWorkflowProgressCommand } from "./hosted-agent-workflow-progress.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

function fixture(localMember = false) {
  const store = new OperationalStore(":memory:"), groups = new ProviderGroupStore(store, "local-node"), leases = new ProviderGroupLeases();
  const model: ProviderModel = { providerId: "provider", modelId: "model", displayName: "Model", api: "openai-completions",
    contextWindow: 32768, maxOutputTokens: 4096, supportsImages: false, thinkingLevels: [],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  const sources: ProviderGroupDirectorySource[] = [
    { key: "local", kind: "local", backendId: "anchor", nativeBackendId: "native-local", nativeBackendInstanceGeneration: 1,
      providerId: "provider", nodeId: "local-node", displayName: "This computer", providerName: "Provider", agentKind: "pi", available: true,
      remotelyEnabled: true, models: [model], assertCurrent() {} },
    { key: "remote", kind: "device", backendId: "remote", nativeBackendId: "native-remote", nativeBackendInstanceGeneration: 1,
      providerId: "provider", nodeId: "remote-node", displayName: "Other computer", providerName: "Provider", agentKind: "pi", available: true,
      remotelyEnabled: true, models: [model], assertCurrent() {} }
  ];
  const member = (source: ProviderGroupDirectorySource): ProviderGroupMember => ({ key: source.key, kind: source.kind,
    backendId: source.backendId, nativeBackendId: source.nativeBackendId, providerId: source.providerId, nodeId: source.nodeId,
    displayName: source.displayName, capacity: 1, weight: 1, paused: false });
  groups.update({ backendId: "anchor", providerId: "provider" }, { strategy: "ordered", autoSwitch: true,
    members: localMember ? [member(sources[0]!), member(sources[1]!)] : [member(sources[1]!), member(sources[0]!)] }, 0n);
  const staged = vi.spyOn(groups, "stageHostedBinding");
  const quotas = new ProviderGroupQuotaReader({ readLocal: async () => undefined, readRemote: async () => undefined });
  const directory = new ProviderGroupDirectory({ sources: () => sources, quotas, running: () => 0, ownerGeneration: () => "original-owner" });
  const runtime = { store: groups, directory, leases, router: new ProviderGroupRouter(groups, directory, leases),
    usage: new ProviderGroupUsage(groups, new ProviderGroupUsageStore(store, "local-node")), nodeName: () => "This computer" } as unknown as ProviderGroupRuntime;
  const base = new HostedAgentHost({ authorize: () => { throw new Error("This original route must stay on its selected remote member."); } });
  let live = true, closeUnknown = false, nativeAlive = false, nativeClosures = 0;
  const principal: HostedAgentPrincipal = { id: "approved-guest", deviceId: "source-device", trust: "guest", assertCurrent: () => {
    if (!live) throw new Error("The original authorization was retired.");
  }, providerGrant: { backendId: "anchor", providerId: "provider", modelIds: ["model"], cleanupKey: "a".repeat(64),
    cleanupOwner: { shareId: "group-share", memberId: "original-person", incarnation: 1, cleanupKey: "a".repeat(64) },
    assertCurrent: () => { if (!live) throw new Error("The original authorization was retired."); } } };
  let resolvePollStarted!: () => void;
  const pollStarted = new Promise<void>(resolve => { resolvePollStarted = resolve; });
  let completePoll!: (error?: Error) => void;
  const opened = vi.fn(async (_input: HostedAgentOpen, _signal: AbortSignal) => { nativeAlive = true; return { virtualRoot: "/native/workspace" }; });
  const close = vi.fn(async (_runId: string, signal: AbortSignal) => {
    signal.throwIfAborted();
    if (closeUnknown) throw new Error("The original native close is unconfirmed.");
    if (nativeAlive) { nativeAlive = false; nativeClosures++; }
  });
  const nativeState: NativeSessionState = { binding: { opaqueRef: "native-reference", nativeSessionId: "native-task", generation: 1 },
    streaming: false, compacting: false, pendingMessages: 0, providerId: "provider", modelId: "model", fastMode: false, permissionMode: "ask" };
  const workflow = { output: { status: "available", text: "", totalBytes: 321, truncated: false, capturedAtMs: 100,
    workflow: { runId: "original-workflow", status: "done", phases: [], agents: [{ label: "Original worker", state: "done", model: "past-model" }], logs: ["Original durable log"] } }, virtualRoot: "/native/workspace" };
  const called = vi.fn(async (_runId: string, _callId: string, command: HostedAgentCall, _signal: AbortSignal): Promise<unknown> => {
    if (command.kind === "state") return nativeState;
    if (command.kind === "send") return null;
    if (command.kind === "workflow_progress") return workflow;
    throw new Error("This native fixture permits only the original state and turn calls.");
  });
  const client: ProviderGroupNativeCapture["client"] = { open: opened, call: called,
    poll: vi.fn(async (cursors: readonly HostedAgentPollCursor[], signal: AbortSignal) => new Promise<readonly HostedAgentPollRun[]>((resolve, reject) => {
      const abort = () => { signal.removeEventListener("abort", abort); reject(new Error("The original native poll was cancelled.")); };
      completePoll = error => {
        signal.removeEventListener("abort", abort);
        if (error) reject(error);
        else resolve(cursors.map(cursor => ({ runId: cursor.runId, cursor: cursor.after + 1, finished: false,
          frames: [{ sequence: cursor.after + 1, payload: { kind: "event", event: { type: "done", outcome: "completed" } } }] })));
      };
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      resolvePollStarted();
    })), reply: async () => {}, readArtifact: async () => ({ data: "" }) };
  const localPrincipals: HostedAgentPrincipal[] = [];
  if (localMember) {
    vi.spyOn(base, "begin").mockImplementation(async (current, input) => { localPrincipals.push(current); return { workspaceRoot: (await client.open(input, new AbortController().signal)).virtualRoot }; });
    vi.spyOn(base, "call").mockImplementation(async (current, run, call, command, signal) => { current.assertCurrent(); localPrincipals.push(current); return client.call(run, call, command, signal ?? new AbortController().signal); });
    vi.spyOn(base, "poll").mockImplementation((...args) => client.poll(args[1], args[2]));
    vi.spyOn(base, "closePrincipal").mockImplementation(async () => close("original-run", new AbortController().signal));
  }
  const capture = vi.fn((_member: ProviderGroupMember, _principal: HostedAgentPrincipal, _models: readonly string[], assertCurrent: () => void) => ({ client, assertCurrent, close }));
  const options = { base, runtime, root: "/group-host", capture,
    assertSelection: (current: HostedAgentPrincipal) => current.assertCurrent(),
    captureWorkflowReadAccess: (current: HostedAgentPrincipal) => () => current.assertCurrent() };
  const endpoint = new ProviderGroupHostedEndpoint(options);
  const input: HostedAgentOpen = { runId: "original-run", nativeSessionId: "original-alias", start: "create", sessionId: "source-task", targetId: "source-target",
    generation: 1, backendId: "anchor", providerId: "provider", modelId: "model", permissionMode: "ask", fastMode: false,
    workspace: { platform: "linux", shell: "native", isGitRepository: false } };
  cleanups.push(async () => { closeUnknown = false; await endpoint.dispose(); await base.dispose(); store.close(); });
  const start = async () => {
    await endpoint.begin(principal, input);
    await endpoint.call(principal, input.runId, "original-state", { kind: "state" });
    await pollStarted;
    await endpoint.call(principal, input.runId, "original-send", { kind: "send", durableFence: false,
      input: { text: "One original turn", images: [], files: [], mentions: [], disposition: "prompt" } });
    expect(leases.count(localMember ? "local" : "remote")).toBe(1);
  };
  const command: HostedWorkflowProgressCommand = { kind: "workflow_progress", backendId: input.backendId, providerId: input.providerId,
    sessionId: input.sessionId, targetId: input.targetId, nativeSessionId: input.nativeSessionId, taskId: `claude-task-${"b".repeat(32)}`, maximumBytes: 16_384 };
  return { endpoint, leases, principal, input, opened, called, close, start, groups, sources, capture, command, workflow, localPrincipals, nativeAlive: () => nativeAlive, nativeClosures: () => nativeClosures,
    restart() { const cold = new ProviderGroupHostedEndpoint(options); cleanups.push(() => cold.dispose()); return cold; },
    read(current = principal, target = endpoint, change: Partial<HostedWorkflowProgressCommand> = {}, signal = new AbortController().signal) {
      const connection = new HostedAgentConnectClient(createClient(HostedAgentService, createRouterTransport(router => router.service(HostedAgentService,
        createHostedAgentConnectService({ host: target, authenticate: () => current })))), current.assertCurrent);
      return connection.call("no-active-workflow-run", "original-workflow-read", { ...command, ...change }, signal);
    },
    binding: () => { const original = staged.mock.calls[0]?.[0]; return original === undefined ? undefined : groups.hostedBinding(original.id); },
    revoke: () => { live = false; }, closeUnknown: (value: boolean) => { closeUnknown = value; }, completePoll: (error?: Error) => completePoll(error) };
}

it("retires a revoked grant before a late native result and retains its original cleanup until closure is confirmed", async () => {
  const f = fixture(); await f.start(); f.closeUnknown(true); f.revoke(); f.completePoll();
  await vi.waitFor(() => expect(f.close).toHaveBeenCalled());
  await expect(f.endpoint.poll(f.principal, [{ runId: f.input.runId, after: 0 }], new AbortController().signal, 0)).rejects.toBeDefined();
  await expect(f.endpoint.poll({ ...f.principal, assertCurrent() {}, providerGrant: { ...f.principal.providerGrant!, assertCurrent() {} } },
    [{ runId: f.input.runId, after: 0 }], new AbortController().signal, 0)).rejects.toBeDefined();
  await expect(f.endpoint.closeProviderGrant("a".repeat(64), f.input.runId)).rejects.toMatchObject({ code: "UNAVAILABLE" });
  expect(f.nativeAlive()).toBe(true); expect(f.nativeClosures()).toBe(0); expect(f.leases.count("remote")).toBe(1);
  expect(f.binding()).toMatchObject({ phase: "ready", member: { key: "remote" } });
  f.closeUnknown(false);
  await f.endpoint.closeProviderGrant("a".repeat(64), f.input.runId);
  expect(f.nativeAlive()).toBe(false); expect(f.nativeClosures()).toBe(1); expect(f.leases.count("remote")).toBe(0);
  expect(f.binding()).toMatchObject({ phase: "closed", member: { key: "remote" } });
  await f.endpoint.closeProviderGrant("a".repeat(64), f.input.runId);
  expect(f.nativeClosures()).toBe(1); expect(f.opened).toHaveBeenCalledOnce();
  expect(f.called.mock.calls.filter(call => call[2].kind === "send")).toHaveLength(1);
});

it("still reports an active member transport failure to its original guest without replaying the native turn", async () => {
  const f = fixture(); await f.start(); f.completePoll(new Error("The original member transport failed."));
  const result = await vi.waitFor(async () => {
    const batch = await f.endpoint.poll(f.principal, [{ runId: f.input.runId, after: 0 }], new AbortController().signal, 0);
    expect(batch[0]?.frames.some(frame => frame.payload.kind === "event" && frame.payload.event.type === "error")).toBe(true);
    return batch[0]!;
  });
  const events = result.frames.flatMap(frame => frame.payload.kind === "event" ? [frame.payload.event] : []);
  expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ type: "error", terminal: true,
    error: expect.objectContaining({ code: "HOSTED_SOURCE_DISCONNECTED" }) }), { type: "done", outcome: "failed" }]));
  expect(events.filter(event => event.type === "error")).toHaveLength(1);
  expect(events.filter(event => event.type === "done")).toHaveLength(1);
  expect(f.nativeAlive()).toBe(true); expect(f.leases.count("remote")).toBe(1);
  await f.endpoint.closeProviderGrant("a".repeat(64), f.input.runId);
  expect(f.nativeClosures()).toBe(1); expect(f.leases.count("remote")).toBe(0); expect(f.opened).toHaveBeenCalledOnce();
  expect(f.called.mock.calls.filter(call => call[2].kind === "send")).toHaveLength(1);
});

it("reads an ended group workflow through the persisted member after the relay closes and the preferred member changes", async () => {
  const f = fixture(); await f.start();
  expect(decodeHostedWorkflowProgress(await f.read()).output.workflow?.logs).toEqual(["Original durable log"]);
  await f.endpoint.closeProviderGrant("a".repeat(64), f.input.runId);
  const cold = f.restart(), pick = vi.spyOn(cold.options.runtime.router, "pick");
  const local = f.groups.snapshot({ backendId: "anchor", providerId: "provider" }).config!.members.find(member => member.key === "local")!;
  f.groups.update({ backendId: "anchor", providerId: "provider" }, { strategy: "ordered", autoSwitch: true, members: [local] }, 1n);
  for (const source of f.sources) (source as { models: readonly ProviderModel[] }).models = [];
  const current = { ...f.principal, providerGrant: { ...f.principal.providerGrant!, modelIds: [] } };
  expect(decodeHostedWorkflowProgress(await f.read(current, cold))).toEqual(f.workflow);
  expect(f.capture.mock.calls.at(-1)!.slice(0, 3)).toEqual([expect.objectContaining({ key: "remote", nativeBackendId: "native-remote" }), current, []]);
  const forwarded = f.called.mock.calls.at(-1)!;
  expect(forwarded[2]).toEqual({ ...f.command, backendId: "native-remote",
    nativeSessionId: createHash("sha256").update(JSON.stringify([f.input.nativeSessionId, "remote"])).digest("hex") });
  expect(forwarded[3].aborted).toBe(false); expect(pick).not.toHaveBeenCalled();
  expect(f.opened).toHaveBeenCalledOnce(); expect(f.nativeClosures()).toBe(1); expect(f.leases.count("remote")).toBe(0);
  expect(f.binding()).toMatchObject({ phase: "closed", member: { key: "remote" } });
});

it("rejects another group grant incarnation and drops reads whose saved route or caller retires in flight", async () => {
  const f = fixture(); await f.start(); await f.endpoint.closeProviderGrant("a".repeat(64), f.input.runId); const cold = f.restart();
  const nextGrant = { ...f.principal, providerGrant: { ...f.principal.providerGrant!, cleanupOwner: { ...f.principal.providerGrant!.cleanupOwner!, incarnation: 2 } } };
  const calls = f.called.mock.calls.length;
  await expect(f.read(nextGrant, cold)).rejects.toBeDefined(); expect(f.called).toHaveBeenCalledTimes(calls);
  const abort = new AbortController(); let release!: (value: unknown) => void;
  f.called.mockImplementationOnce(async () => new Promise(resolve => { release = resolve; }));
  const pending = f.read(f.principal, cold, {}, abort.signal);
  await vi.waitFor(() => expect(release).toBeTypeOf("function")); abort.abort(); release(f.workflow);
  await expect(pending).rejects.toBeDefined();
  let releaseRoute!: (value: unknown) => void;
  f.called.mockImplementationOnce(async () => new Promise(resolve => { releaseRoute = resolve; }));
  const staleRoute = f.read(f.principal, cold); await vi.waitFor(() => expect(releaseRoute).toBeTypeOf("function"));
  const original = f.binding()!; f.groups.stageHostedBinding({ ...original, member: { ...original.member, key: "replacement" } });
  f.groups.settleHostedBinding(original.id, "closed"); releaseRoute(f.workflow); await expect(staleRoute).rejects.toBeDefined();
  expect(f.opened).toHaveBeenCalledOnce(); expect(f.leases.count("remote")).toBe(0);
});

it("keeps the original local member principal and alias when reading a closed group workflow", async () => {
  const f = fixture(true); await f.start(); await f.endpoint.closeProviderGrant("a".repeat(64), f.input.runId);
  const cold = f.restart(); expect(decodeHostedWorkflowProgress(await f.read(f.principal, cold))).toEqual(f.workflow);
  const original = f.localPrincipals[0]!, reader = f.localPrincipals.at(-1)!;
  expect(reader.id).toBe(original.id); expect(reader.id).toBe("group-native:" + createHash("sha256").update(JSON.stringify([f.principal.id, "local"])).digest("hex"));
  expect(reader.deviceId).toBe(f.principal.deviceId); expect(reader.trust).toBe("guest");
  expect(reader.providerGrant).toMatchObject({ backendId: "native-local", providerId: "provider", modelIds: [], groupMember: true, cleanupOwner: f.principal.providerGrant!.cleanupOwner });
  expect(f.called.mock.calls.at(-1)![2]).toEqual({ ...f.command, backendId: "native-local",
    nativeSessionId: createHash("sha256").update(JSON.stringify([f.input.nativeSessionId, "local"])).digest("hex") });
  expect(f.capture).not.toHaveBeenCalled(); expect(f.opened).toHaveBeenCalledOnce(); expect(f.leases.count("local")).toBe(0);
});
