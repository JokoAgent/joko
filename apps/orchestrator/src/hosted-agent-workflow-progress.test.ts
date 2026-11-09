import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { createClient, createRouterTransport } from "@connectrpc/connect";
import { HostedAgentService } from "@joko/contracts";
import type { BackgroundTaskOutputResult, BackgroundWorkflowReadInput } from "@joko/core";
import { HostedAgentStore, OperationalStore, type HostedNativeSessionOwner } from "@joko/store";
import { expect, it, vi } from "vitest";
import type { ConnectionManager } from "./connection-manager.js";
import { HostedAgentRuntime } from "./hosted-agent-runtime.js";
import { HostedAgentConnectClient } from "./hosted-agent-connect-client.js";
import { createHostedAgentConnectService } from "./hosted-agent-connect-service.js";
import type { HostedAgentPrincipal } from "./hosted-agent-host.js";
import type { HostedWorkflowProgressCommand } from "./hosted-agent-workflow-progress.js";
import { decodeHostedWorkflowProgress, boundHostedWorkflowProgress } from "./hosted-agent-workflow-wire.js";

const taskId = `claude-task-${"a".repeat(32)}`;
const output = (): BackgroundTaskOutputResult => ({ status: "available", text: "", totalBytes: 500, truncated: false, capturedAtMs: Date.now(),
  workflow: { runId: "workflow", status: "done", totalTokens: 0, phases: [{ index: 1, title: "Review", detail: "Original evidence" }],
    agents: [{ label: "Reviewer", state: "done", phaseIndex: 1, model: "original-model", attempt: 2, resultPreview: "Original result" }], logs: ["Durable log"] } });

async function fixture(guest = false) {
  const temporary = await realpath(tmpdir()), root = await mkdtemp(join(temporary, "joko-hosted-workflow-")), path = join(root, "operations.sqlite");
  let store = new OperationalStore(path), authorized = true, grantCurrent = true;
  const grantOwner = { shareId: "share", memberId: "member", incarnation: 1, cleanupKey: "b".repeat(64) };
  let principal: HostedAgentPrincipal = { id: "original-authority", deviceId: "source-device", trust: guest ? "guest" : "owner",
    assertCurrent() { if (!authorized) throw new Error("Source route ended"); },
    ...(guest ? { providerGrant: { backendId: "native", providerId: "provider", modelIds: [], cleanupOwner: grantOwner,
      assertCurrent() { if (!grantCurrent) throw new Error("Provider grant ended"); } } } : {}) };
  const owner: HostedNativeSessionOwner = { authorityId: principal.id, deviceId: principal.deviceId, trust: principal.trust,
    backendId: "native", sessionId: "original-task", targetId: "original-target", nativeSessionId: "original-native-alias",
    ...(guest ? { providerGrant: grantOwner } : {}) };
  store.upsertBackend({ id: "native", adapterKind: "claude-agent-sdk-stdio", instanceGeneration: 7, displayName: "Native", version: "1", health: "healthy",
    installationState: "installed", authenticationState: "authenticated", capabilities: new Map(), models: [], tools: [], diagnostics: [] });
  let journal = new HostedAgentStore(store); const record = journal.claim(owner, "original-process", "create");
  const originalBinding = { opaqueRef: "original-owned-sdk-reference", nativeSessionId: "original-sdk-id", generation: 1 };
  journal.bind(record.key, record.leaseId, originalBinding); journal.observeBackgroundTaskBinding(record.key, record.leaseId, taskId, 100, true);
  journal.bind(record.key, record.leaseId, { opaqueRef: "next-owned-sdk-reference", nativeSessionId: "next-sdk-id", generation: 2 });
  journal.close(record.key, record.leaseId);
  await mkdir(join(root, record.key, "native"), { recursive: true }); await mkdir(join(root, record.key, "workspace"));
  const create = vi.fn(() => { throw new Error("A workflow read cannot start an SDK or recover processes"); });
  const read = vi.fn(async (_home: string, input: BackgroundWorkflowReadInput) => { input.assertCurrent(); return output(); });
  const makeRuntime = () => new HostedAgentRuntime({ store, root, connections: {} as ConnectionManager, artifactCapacityBytes: 1024,
    factories: [{ backendId: "native", providerIds: () => ["provider"], models: () => [], isolatedGuests: () => true, create, readWorkflowProgress: read }] });
  let runtime = makeRuntime(), settings = runtime.settings.update({ kind: "remote_control", enabled: true }, 0n);
  runtime.settings.update({ kind: "provider", backendId: "native", providerId: "provider", enabled: true }, settings.revision);
  const makeClient = () => new HostedAgentConnectClient(createClient(HostedAgentService, createRouterTransport(router => router.service(HostedAgentService,
    createHostedAgentConnectService({ ...runtime.connectOptions(), authenticate: () => principal })))), () => principal.assertCurrent());
  let client = makeClient(), reads = 0;
  const command: HostedWorkflowProgressCommand = { kind: "workflow_progress", backendId: "native", providerId: "provider", sessionId: owner.sessionId,
    targetId: owner.targetId, nativeSessionId: owner.nativeSessionId, taskId, maximumBytes: 16_384 };
  return { root, owner, record, originalBinding, create, read, command, get store() { return store; }, get journal() { return journal; }, get runtime() { return runtime; },
    call: (change: Partial<HostedWorkflowProgressCommand> = {}, signal = new AbortController().signal) => client.call("no-active-run", `read-${++reads}`, { ...command, ...change }, signal),
    get principal() { return principal; }, setPrincipal(value: HostedAgentPrincipal) { principal = value; }, revoke: () => { authorized = false; }, revokeGrant: () => { grantCurrent = false; },
    async restart() { await runtime.close(); store.close(); store = new OperationalStore(path); journal = new HostedAgentStore(store); runtime = makeRuntime(); client = makeClient(); },
    async close() { await runtime.close(); store.close(); if (!root.startsWith(temporary + sep)) throw new Error("Unsafe test cleanup."); await rm(root, { recursive: true, force: true }); }
  };
}

it("roundtrips a terminal workflow through the original native service after SDK identity change and a cold runtime restart", async () => {
  const f = await fixture();
  try {
    const reserve = vi.spyOn(f.runtime.slots, "reserve");
    const result = decodeHostedWorkflowProgress(await f.call());
    expect(result.output.workflow).toMatchObject({ status: "done", totalTokens: 0, agents: [{ model: "original-model", attempt: 2 }], logs: ["Durable log"] });
    expect(f.read.mock.calls[0]![0]).toBe(join(f.root, f.record.key, "native"));
    expect(f.read.mock.calls[0]![1]).toMatchObject({ sessionId: `hosted-session:${f.record.key}`, bindings: [f.originalBinding],
      target: { workspaceRoot: join(f.root, f.record.key, "workspace") }, taskId });
    expect(f.create).not.toHaveBeenCalled(); expect(reserve).not.toHaveBeenCalled(); expect(f.store.listSessions()).toEqual([]);
    f.runtime.settings.update({ kind: "model_access", backendId: "native", providerId: "provider", modelIds: [] }, f.runtime.settings.snapshot().revision);
    await f.restart();
    expect(decodeHostedWorkflowProgress(await f.call()).output.workflow?.logs).toEqual(["Durable log"]);
    expect(f.read.mock.calls[1]![1].bindings).toEqual([f.originalBinding]); expect(f.create).not.toHaveBeenCalled();
    const calls = f.read.mock.calls.length;
    expect(decodeHostedWorkflowProgress(await f.call({ sessionId: "foreign-task" })).output.status).toBe("unavailable"); expect(f.read).toHaveBeenCalledTimes(calls);
    const injected = { ...f.command, home: "foreign-profile" };
    await expect(f.call(injected)).rejects.toThrow(); expect(f.read).toHaveBeenCalledTimes(calls);
  } finally { await f.close(); }
});

it.each(["device", "provider", "backend", "native lease", "task binding", "caller abort"] as const)("rejects a workflow reply when %s retires during the read", async change => {
  const f = await fixture(), abort = new AbortController();
  try {
    if (change === "task binding") f.journal.claim(f.owner, "active-process", "resume");
    f.read.mockImplementationOnce(async (_home, input) => {
      if (change === "device") f.revoke();
      if (change === "provider") f.runtime.settings.update({ kind: "provider", backendId: "native", providerId: "provider", enabled: false }, f.runtime.settings.snapshot().revision);
      if (change === "backend") f.store.upsertBackend({ ...f.store.getBackend("native").descriptor, instanceGeneration: 8 });
      if (change === "native lease") f.journal.claim(f.owner, "replacement-process", "resume");
      if (change === "task binding") { const row = f.journal.find(f.record.key)!;
        f.journal.bind(row.key, row.leaseId, { opaqueRef: "third-native-reference", nativeSessionId: "third-sdk-id", generation: 3 });
        f.journal.observeBackgroundTaskBinding(row.key, row.leaseId, taskId, 200, true); }
      if (change === "caller abort") abort.abort();
      input.assertCurrent(); return output();
    });
    await expect(f.call({}, abort.signal)).rejects.toThrow(); expect(f.create).not.toHaveBeenCalled();
  } finally { await f.close(); }
});

it("keeps workflow history on the exact Provider grant incarnation and fences a grant revoked in flight", async () => {
  const f = await fixture(true);
  try {
    const grant = f.principal.providerGrant!;
    f.setPrincipal({ ...f.principal, providerGrant: { ...grant, cleanupOwner: { cleanupKey: grant.cleanupOwner!.cleanupKey,
      incarnation: 1, memberId: "member", shareId: "share" } } });
    expect(decodeHostedWorkflowProgress(await f.call()).output.status).toBe("available");
    f.setPrincipal({ ...f.principal, providerGrant: { ...grant, cleanupOwner: { ...grant.cleanupOwner!, incarnation: 2 } } });
    await expect(f.call()).rejects.toThrow(); expect(f.read).toHaveBeenCalledOnce();
    f.setPrincipal({ ...f.principal, providerGrant: grant });
    f.read.mockImplementationOnce(async (_home, input) => { f.revokeGrant(); input.assertCurrent(); return output(); });
    await expect(f.call()).rejects.toThrow(); expect(f.create).not.toHaveBeenCalled();
  } finally { await f.close(); }
});

it("validates the closed remote workflow shape and bounds text again after Source path restoration", () => {
  const value = { virtualRoot: "/owned/provider/workspace", output: output() };
  expect(decodeHostedWorkflowProgress(value).output.workflow?.totalTokens).toBe(0);
  for (const invalid of [{ ...value, virtualRoot: "relative" }, { ...value, home: "/arbitrary-profile" },
    { ...value, output: { ...value.output, workflow: { ...value.output.workflow, totalTokens: -1 } } }]) expect(() => decodeHostedWorkflowProgress(invalid)).toThrow();
  const expanded = { ...output(), workflow: { ...output().workflow!, logs: ["old", "x".repeat(900)],
    agents: [{ label: "Reviewer", state: "done", resultPreview: "path/".repeat(180) }] } };
  const bounded = boundHostedWorkflowProgress(expanded, 450);
  expect(bounded.truncated).toBe(true); expect(Buffer.byteLength(JSON.stringify(bounded.workflow))).toBeLessThanOrEqual(450);
  expect(expanded.workflow.logs[1]).toHaveLength(900);
});
