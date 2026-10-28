import { mkdtemp, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import type { AdapterContext, BackendDescriptor, NativeSessionBinding } from "@joko/core";
import { expect, it, vi } from "vitest";
import { HostedAgentSourceAdapter, HostedNativeCapacityError, type HostedAgentSourceConnection, type HostedAgentSourceController, type HostedAgentSourceAdapterOptions } from "./adapter.js";
import { HostedAgentConnectionPool } from "./connection-pool.js";

async function fixture(prepareInput?: HostedAgentSourceAdapterOptions["prepareInput"], commands?: HostedAgentSourceAdapterOptions["commands"],
  options: Pick<HostedAgentSourceAdapterOptions, "connectionPool" | "isCapacityError" | "manageDerivation"> = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "joko-source-adapter-")));
  const context: AdapterContext = { sessionId: "task", generation: 1, target: { id: "target", backendId: "source-native", displayName: "Task", workspaceRoot: root,
    managed: true, trusted: true }, operationId: "create-task", modelSelection: { providerId: "provider", modelId: "model" }, signal: new AbortController().signal,
    emit: async () => {}, requestInteraction: async () => ({ kind: "cancelled" }), artifactCapacityBytes: 1024, storeArtifact: async () => { throw new Error("No Artifact in this fixture."); } };
  const capabilities = new Map([["runtime.commands", { key: "runtime.commands", supported: true }]]);
  const descriptor: BackendDescriptor = { id: "source-native", adapterKind: "hosted", instanceGeneration: 1, displayName: "Source", version: "1", health: "healthy",
    installationState: "installed", authenticationState: "authenticated", capabilities, models: [], tools: [], diagnostics: [] };
  const open = vi.fn<HostedAgentSourceConnection["client"]["open"]>(async input => ({ runId: input.runId, virtualRoot: "/provider/private/workspace" }));
  const close = vi.fn(async () => {}), stop = vi.fn(async () => {}), release = vi.fn(async () => {}), forget = vi.fn(async () => {}), owners = new Map<string, AdapterContext>();
  const fences = new Map<string, NonNullable<Parameters<HostedAgentSourceController["registerOperation"]>[2]>>();
  let binding!: () => NativeSessionBinding;
  const controller: HostedAgentSourceController = { start: () => new Promise<void>(() => {}), stop, abortPending: () => {},
    registerOperation: (id, context, fence) => { owners.set(id, context); if (fence) fences.set(id, fence); }, projectResult: value => value,
    projectState: state => ({ ...state, binding: binding() }), projectHistory: history => history };
  const call = vi.fn<HostedAgentSourceConnection["client"]["call"]>(async () => ({ binding: { opaqueRef: "/provider/native.jsonl", generation: 1 }, streaming: false,
    compacting: false, pendingMessages: 0, providerId: "provider", modelId: "model", fastMode: false, permissionMode: "ask" }));
  const adapter = new HostedAgentSourceAdapter({ id: descriptor.id, source: { targetDeviceId: "provider-node", controllerDeviceId: "source-device", backendId: "native" },
    describe: () => descriptor, assertContext: () => {}, readPolicy: () => ({ permissionMode: "ask", fastMode: false }), releaseWorkspace: release, deleteWorkspace: forget,
    ...(prepareInput === undefined ? {} : { prepareInput }),
    ...(commands === undefined ? {} : { commands }),
    workspace: () => ({ platform: process.platform as "win32" | "darwin" | "linux", shell: "bash", isGitRepository: false }),
    capture: () => ({ client: { open, call }, close, assertCurrent: () => {}, createController: input => { binding = input.binding; return controller; } }), ...options });
  return { root, context, descriptor, capabilities, adapter, open, call, close, stop, release, forget, owners, fences, cleanup: async () => {
    await adapter.dispose(); if (!resolve(root).startsWith(resolve(tmpdir()) + sep)) throw new Error("Unsafe test cleanup."); await rm(root, { recursive: true, force: true });
  } };
}

it("exposes a positive capacity rejection only after the exact failed native owner has closed", async () => {
  const capacity = new Error("Native capacity rejected"), pool = { beforeOpen: vi.fn(async () => {}), releaseForRetry: vi.fn(async () => false), register: vi.fn() } as unknown as HostedAgentConnectionPool;
  const f = await fixture(undefined, undefined, { isCapacityError: error => error === capacity, connectionPool: pool });
  try {
    f.open.mockRejectedValueOnce(capacity);
    const creating = f.adapter.createSession({ target: f.context.target, providerId: "provider", modelId: "model", permissionMode: "ask", fastMode: false }, f.context);
    await expect(creating).rejects.toBeInstanceOf(HostedNativeCapacityError);
    await expect(creating).rejects.toMatchObject({ publicError: { code: "HOSTED_AGENT_CAPACITY_REJECTED", stateMayHaveChanged: false } });
    expect(f.close).toHaveBeenCalledOnce(); expect(pool.releaseForRetry).toHaveBeenCalledOnce(); expect(f.open).toHaveBeenCalledOnce();
  } finally { await f.cleanup(); }
});

it("keeps an unconfirmed capacity cleanup unknown and never asks the pool or another owner to retry", async () => {
  const capacity = new Error("Native capacity rejected"), pool = { beforeOpen: vi.fn(async () => {}), releaseForRetry: vi.fn(async () => true), register: vi.fn() } as unknown as HostedAgentConnectionPool;
  const f = await fixture(undefined, undefined, { isCapacityError: error => error === capacity, connectionPool: pool });
  try {
    f.open.mockRejectedValueOnce(capacity); f.close.mockRejectedValueOnce(new Error("Lost original close receipt"));
    await expect(f.adapter.createSession({ target: f.context.target, providerId: "provider", modelId: "model", permissionMode: "ask", fastMode: false }, f.context)).rejects.toThrow("cleanup could not be confirmed");
    expect(pool.releaseForRetry).not.toHaveBeenCalled(); expect(f.open).toHaveBeenCalledOnce();
  } finally { await f.cleanup(); }
});

it("retains a Source-owned binding, rejects a substituted node, and resumes the same native owner in a new Source generation", async () => {
  const f = await fixture();
  try {
    const binding = await f.adapter.createSession({ target: f.context.target, name: "Original task title", providerId: "provider", modelId: "model", permissionMode: "ask", fastMode: false }, f.context);
    expect(f.open.mock.calls[0]?.[0].name).toBe("Original task title");
    expect(f.call.mock.calls.some(([, , command]) => command.kind === "set_name")).toBe(false);
    expect(binding.opaqueRef).not.toContain("/provider/");
    const foreign = { ...JSON.parse(binding.opaqueRef), source: { ...JSON.parse(binding.opaqueRef).source, targetDeviceId: "other-provider-node" } };
    await expect(f.adapter.resumeSession({ ...binding, opaqueRef: JSON.stringify(foreign) }, { ...f.context, binding })).rejects.toThrow("another source");
    expect(f.open).toHaveBeenCalledTimes(1);
    await f.adapter.closeSession(binding, { ...f.context, binding });
    const restored = await f.adapter.resumeSession(binding, { ...f.context, generation: 2, binding: { ...binding, generation: 2 } });
    expect(restored.binding).toEqual({ ...binding, generation: 2 });
    expect(f.open.mock.calls.map(([input]) => [input.start, input.nativeSessionId])).toEqual([["create", binding.nativeSessionId], ["resume", binding.nativeSessionId]]);
    await f.adapter.send({ text: "Exact occurrence", images: [], files: [], mentions: [], disposition: "prompt" },
      { ...f.context, generation: 2, binding: restored.binding, operationId: "original-queue-operation" });
    expect(f.call.mock.calls.at(-1)?.[1]).toBe("original-queue-operation"); expect(f.owners.get("original-queue-operation")?.generation).toBe(2);
  } finally { await f.cleanup(); }
});

it("merges loaded native extension commands with approved Source commands and keeps Provider paths private", async () => {
  const f = await fixture(undefined, () => [{ name: "advice", description: "Approved Source advice", source: "prompt", inputMode: "resource_mention", resourceId: "source-advice", loaded: true }]);
  try {
    const binding = await f.adapter.createSession({ target: f.context.target, providerId: "provider", modelId: "model", permissionMode: "ask", fastMode: false }, f.context);
    const native = f.call.getMockImplementation()!;
    f.call.mockImplementation(async (...args) => args[2].kind === "commands" ? [
      { name: "subagents", description: "Manage delegated work", source: "extension", inputMode: "text", loaded: true, path: "/provider/private/extension.ts" },
      { name: "advice", description: "Provider collision", source: "extension", inputMode: "text", loaded: true },
      { name: "private", description: "Provider skill", source: "skill", inputMode: "text", loaded: true, path: "/provider/private/SKILL.md" }
    ] : args[2].kind === "dispatch_during_compaction" ? "steer" : native(...args));
    expect(await f.adapter.getCommands({ ...f.context, binding })).toEqual([
      { name: "advice", description: "Approved Source advice", source: "prompt", inputMode: "resource_mention", resourceId: "source-advice", loaded: true },
      { name: "subagents", description: "Manage delegated work", source: "extension", inputMode: "text", loaded: true }
    ]);
    expect(await f.adapter.dispatchDuringCompaction({ text: "/subagents", images: [], files: [], mentions: [], disposition: "prompt" }, { ...f.context, binding })).toBe("steer");
    expect(f.owners.size).toBe(1);
  } finally { await f.cleanup(); }
});

it("forwards exact native rewind and child controls while retaining its Source alias", async () => {
  const f = await fixture();
  try {
    const binding = await f.adapter.createSession({ target: f.context.target, providerId: "provider", modelId: "model", permissionMode: "ask", fastMode: false }, f.context);
    const recordBinding = vi.fn();
    expect(await f.adapter.navigateTree({ kind: "native_entry", entryId: "exact-entry" }, false, { ...f.context, binding, operationId: "rewind" }, undefined, { recordBinding })).toEqual({ kind: "in_place" });
    expect(f.call.mock.calls.at(-1)?.[2]).toEqual({ kind: "navigate", target: { kind: "native_entry", entryId: "exact-entry" }, summarize: false });
    expect(recordBinding).not.toHaveBeenCalled();
    await f.adapter.controlSubagent({ runId: "native-child", childId: "exact-child", action: "resume", message: "Continue the child." }, { ...f.context, binding, operationId: "resume-child" });
    expect(f.call.mock.calls.at(-1)?.[2]).toEqual({ kind: "control_subagent", input: { runId: "native-child", childId: "exact-child", action: "resume", message: "Continue the child." } });
    expect((await f.adapter.inspectSession(binding, { ...f.context, binding })).binding).toEqual(binding);
  } finally { await f.cleanup(); }
});

it("prepares input against its actual native shadow and rechecks the original Source reference at the durable dispatch boundary", async () => {
  let current = true;
  const prepare = vi.fn<NonNullable<HostedAgentSourceAdapterOptions["prepareInput"]>>(async (input, _context, shadow) => ({
    input: { ...input, text: `${input.text}\nPath: ${shadow}/proof.txt` }, assertCurrent: () => { if (!current) throw new Error("Original file reference changed."); }
  }));
  const f = await fixture(prepare), persist = vi.fn(async () => {});
  try {
    const binding = await f.adapter.createSession({ target: f.context.target, providerId: "provider", modelId: "model", permissionMode: "ask", fastMode: false }, f.context);
    const input = { text: "Original file", images: [], files: [], mentions: [], disposition: "prompt" as const };
    await f.adapter.send(input, { ...f.context, binding, operationId: "prepared-source" });
    expect(prepare.mock.calls[0]?.[2]).toBe("/provider/private/workspace");
    expect(f.call.mock.calls.at(-1)?.[2]).toMatchObject({ kind: "send", input: { text: "Original file\nPath: /provider/private/workspace/proof.txt" } });
    const nativeCall = f.call.getMockImplementation()!;
    f.call.mockImplementation(async (...args) => {
      if (args[2].kind === "send" && args[2].durableFence) {
        current = false;
        await f.fences.get(args[1])!({ inputFingerprint: "a".repeat(64), nativeHistory: { events: [], activeLineage: [] } });
      }
      return nativeCall(...args);
    });
    await expect(f.adapter.sendWithDurableNativeDispatchFence(input, { ...f.context, binding, operationId: "retired-file-source" }, persist)).rejects.toThrow(/file reference changed/u);
    expect(persist).not.toHaveBeenCalled();
  } finally { await f.cleanup(); }
});

it("retains uncertain startup cleanup until the exact captured native connection confirms closure", async () => {
  const f = await fixture(); f.open.mockRejectedValueOnce(new Error("The original delivery outcome is unknown."));
  f.close.mockRejectedValueOnce(new Error("Native cleanup is unconfirmed."));
  try {
    await expect(f.adapter.createSession({ target: f.context.target, providerId: "provider", modelId: "model", permissionMode: "ask", fastMode: false }, f.context))
      .rejects.toThrow("cleanup could not be confirmed");
    expect(f.open).toHaveBeenCalledTimes(1); expect(f.close).toHaveBeenCalledTimes(1);
    expect(f.release).not.toHaveBeenCalled();
    await f.adapter.dispose(); expect(f.close).toHaveBeenCalledTimes(2); expect(f.open).toHaveBeenCalledTimes(1);
    expect(f.release).toHaveBeenCalledOnce(); expect(f.release).toHaveBeenCalledWith(f.context);
  } finally { await f.cleanup(); }
});

it("admits file snapshots only after the original durable fence and before native input consumption", async () => {
  const order: string[] = [], commit = vi.fn(async () => { order.push("receipt"); });
  const f = await fixture(async input => ({ input, assertCurrent: () => {}, commit }));
  try {
    const binding = await f.adapter.createSession({ target: f.context.target, providerId: "provider", modelId: "model", permissionMode: "ask", fastMode: false }, f.context);
    const input = { text: "File input", images: [], files: [], mentions: [], disposition: "prompt" as const }, nativeCall = f.call.getMockImplementation()!;
    f.call.mockImplementation(async (...args) => {
      if (args[2].kind === "send" && args[2].durableFence) {
        await f.fences.get(args[1])!({ inputFingerprint: "b".repeat(64), nativeHistory: { events: [], activeLineage: [] } }); order.push("native");
      }
      return nativeCall(...args);
    });
    await expect(f.adapter.send(input, { ...f.context, binding, operationId: "unfenced" })).rejects.toThrow(/durable/u);
    await expect(f.adapter.sendWithDurableNativeDispatchFence(input, { ...f.context, binding, operationId: "failed-fence" }, async () => { throw new Error("Persistence failed."); })).rejects.toThrow("Persistence failed");
    expect(commit).not.toHaveBeenCalled();
    await f.adapter.sendWithDurableNativeDispatchFence(input, { ...f.context, binding, operationId: "accepted" }, async () => { order.push("persist"); });
    expect(order).toEqual(["persist", "receipt", "native"]);
  } finally { await f.cleanup(); }
});

it("forgets task input copies only after the exact native deletion and connection close succeed", async () => {
  const f = await fixture();
  try {
    const binding = await f.adapter.createSession({ target: f.context.target, providerId: "provider", modelId: "model", permissionMode: "ask", fastMode: false }, f.context);
    f.close.mockRejectedValueOnce(new Error("Closure is uncertain."));
    await expect(f.adapter.deleteSession(binding, { ...f.context, binding })).rejects.toThrow("Closure is uncertain"); expect(f.forget).not.toHaveBeenCalled();
    await f.adapter.closeSession(binding, { ...f.context, binding }); expect(f.forget).not.toHaveBeenCalled();
    await f.adapter.deleteSession(binding, { ...f.context, binding });
    expect(f.forget).toHaveBeenCalledOnce(); expect(f.close.mock.invocationCallOrder.at(-1)!).toBeLessThan(f.forget.mock.invocationCallOrder[0]!);
  } finally { await f.cleanup(); }
});

it("keeps an uncertain idle release occupied and reconciles its exact receipt before resuming the retained native identity", async () => {
  let now = 0; const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
  const pool = new HostedAgentConnectionPool({ idleMinutes: () => 1, maxRuns: () => 5 });
  const f = await fixture(undefined, undefined, { connectionPool: pool });
  try {
    const binding = await f.adapter.createSession({ target: f.context.target, providerId: "provider", modelId: "model", permissionMode: "ask", fastMode: false }, f.context);
    const native = f.call.getMockImplementation()!; let releaseId = "";
    f.call.mockImplementation(async (...args) => {
      if (args[2].kind === "idle_release") { releaseId = args[1]; throw new Error("The close response was lost."); }
      if (args[2].kind === "idle_release_status") { expect(args[2].releaseCallId).toBe(releaseId); return "released"; }
      return native(...args);
    });
    now = 120_000; expect(await pool.releaseForRetry()).toBe(false); expect(pool.occupied()).toBe(1); expect(f.close).not.toHaveBeenCalled();
    await f.adapter.send({ text: "Continue retained history", images: [], files: [], mentions: [], disposition: "prompt" }, { ...f.context, binding, operationId: "after-idle" });
    expect(f.open.mock.calls.map(([input]) => [input.start, input.nativeSessionId])).toEqual([["create", binding.nativeSessionId], ["resume", binding.nativeSessionId]]);
    expect(f.call.mock.calls.filter(([, , command]) => command.kind === "idle_release")).toHaveLength(1);
    expect(f.close).toHaveBeenCalledOnce(); expect(f.release).toHaveBeenCalledOnce(); expect(pool.occupied()).toBe(1);
  } finally { await f.cleanup(); pool.close(); clock.mockRestore(); }
});

it("retains a busy original Agent when a lost idle response resolves to a rejected release", async () => {
  let now = 0; const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
  const pool = new HostedAgentConnectionPool({ idleMinutes: () => 1, maxRuns: () => 5 });
  const f = await fixture(undefined, undefined, { connectionPool: pool });
  try {
    const binding = await f.adapter.createSession({ target: f.context.target, providerId: "provider", modelId: "model", permissionMode: "ask", fastMode: false }, f.context);
    const native = f.call.getMockImplementation()!;
    f.call.mockImplementation(async (...args) => args[2].kind === "idle_release" ? Promise.reject(new Error("Lost busy response"))
      : args[2].kind === "idle_release_status" ? "busy" : native(...args));
    now = 120_000; expect(await pool.releaseForRetry()).toBe(false);
    await f.adapter.inspectSession(binding, { ...f.context, binding });
    expect(f.open).toHaveBeenCalledOnce(); expect(f.close).not.toHaveBeenCalled(); expect(pool.occupied()).toBe(1);
  } finally { await f.cleanup(); pool.close(); clock.mockRestore(); }
});

it("registers an exact child alias before the only native fork call and recovers cleanup without replaying that fork", async () => {
  const manageDerivation = vi.fn<NonNullable<HostedAgentSourceAdapterOptions["manageDerivation"]>>(async () => {});
  const f = await fixture(undefined, undefined, { manageDerivation });
  try {
    f.capabilities.set("session.fork", { key: "session.fork", supported: true });
    const binding = await f.adapter.createSession({ target: f.context.target, providerId: "provider", modelId: "model", permissionMode: "ask", fastMode: false }, f.context);
    let child: NativeSessionBinding | undefined;
    const native = f.call.getMockImplementation()!;
    f.call.mockImplementation(async (...args) => {
      if (args[2].kind === "derive") { expect(child?.nativeSessionId).toBe(args[2].nativeSessionId); throw new Error("Native reply lost."); }
      return native(...args);
    });
    await expect(f.adapter.fork("exact-native-entry", { ...f.context, binding, operationId: "fork-once" }, {
      sessionId: "derived-task", target: f.context.target, recordBinding: value => { child = value; }
    })).rejects.toThrow("reply lost");
    expect(child).toBeDefined(); expect(child!.opaqueRef).not.toContain("/provider/"); expect(child!.nativeSessionId).not.toBe(binding.nativeSessionId);
    await f.adapter.cleanupNativeSessionDerivation({ operationId: "fork-once", kind: "fork", sourceSessionId: f.context.sessionId,
      sourceBinding: binding, sourceTarget: f.context.target, sessionId: "derived-task", target: f.context.target, binding: child! }, new AbortController().signal);
    expect(manageDerivation.mock.calls[0]?.[0]).toMatchObject({ kind: "derivation_lifecycle", action: "cleanup", sourceNativeSessionId: binding.nativeSessionId, nativeSessionId: child!.nativeSessionId });
    expect(manageDerivation.mock.calls[0]?.[0].operationId).toBe(f.call.mock.calls.find(([, , command]) => command.kind === "derive")?.[1]);
    expect(f.call.mock.calls.filter(([, , command]) => command.kind === "derive")).toHaveLength(1);
    await expect(f.adapter.cleanupNativeSessionDerivation({ operationId: "different-operation", kind: "fork", sourceSessionId: f.context.sessionId,
      sourceBinding: binding, sourceTarget: f.context.target, sessionId: "derived-task", target: f.context.target, binding: child! }, new AbortController().signal)).rejects.toThrow("identity conflicts");
  } finally { await f.cleanup(); }
});
