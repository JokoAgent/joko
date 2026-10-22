import { mkdtemp, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import type { AdapterContext, BackendDescriptor, NativeSessionBinding } from "@joko/core";
import { expect, it, vi } from "vitest";
import { HostedAgentSourceAdapter, type HostedAgentSourceConnection, type HostedAgentSourceController, type HostedAgentSourceAdapterOptions } from "./adapter.js";

async function fixture(prepareInput?: HostedAgentSourceAdapterOptions["prepareInput"]) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "joko-source-adapter-")));
  const context: AdapterContext = { sessionId: "task", generation: 1, target: { id: "target", backendId: "source-native", displayName: "Task", workspaceRoot: root,
    managed: true, trusted: true }, operationId: "create-task", modelSelection: { providerId: "provider", modelId: "model" }, signal: new AbortController().signal,
    emit: async () => {}, requestInteraction: async () => ({ kind: "cancelled" }), artifactCapacityBytes: 1024, storeArtifact: async () => { throw new Error("No Artifact in this fixture."); } };
  const descriptor: BackendDescriptor = { id: "source-native", adapterKind: "hosted", instanceGeneration: 1, displayName: "Source", version: "1", health: "healthy",
    installationState: "installed", authenticationState: "authenticated", capabilities: new Map(), models: [], tools: [], diagnostics: [] };
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
    workspace: () => ({ platform: process.platform as "win32" | "darwin" | "linux", shell: "bash", isGitRepository: false }),
    capture: () => ({ client: { open, call }, close, assertCurrent: () => {}, createController: input => { binding = input.binding; return controller; } }) });
  return { root, context, adapter, open, call, close, stop, release, forget, owners, fences, cleanup: async () => {
    await adapter.dispose(); if (!resolve(root).startsWith(resolve(tmpdir()) + sep)) throw new Error("Unsafe test cleanup."); await rm(root, { recursive: true, force: true });
  } };
}

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
