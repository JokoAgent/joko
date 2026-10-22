import { mkdtemp, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import type { AdapterContext, BackendDescriptor, NativeSessionBinding } from "@joko/core";
import { expect, it, vi } from "vitest";
import { HostedAgentSourceAdapter, type HostedAgentSourceConnection, type HostedAgentSourceController } from "./adapter.js";

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "joko-source-adapter-")));
  const context: AdapterContext = { sessionId: "task", generation: 1, target: { id: "target", backendId: "source-native", displayName: "Task", workspaceRoot: root,
    managed: true, trusted: true }, operationId: "create-task", modelSelection: { providerId: "provider", modelId: "model" }, signal: new AbortController().signal,
    emit: async () => {}, requestInteraction: async () => ({ kind: "cancelled" }), artifactCapacityBytes: 1024, storeArtifact: async () => { throw new Error("No Artifact in this fixture."); } };
  const descriptor: BackendDescriptor = { id: "source-native", adapterKind: "hosted", instanceGeneration: 1, displayName: "Source", version: "1", health: "healthy",
    installationState: "installed", authenticationState: "authenticated", capabilities: new Map(), models: [], tools: [], diagnostics: [] };
  const open = vi.fn<HostedAgentSourceConnection["client"]["open"]>(async input => ({ runId: input.runId, virtualRoot: "/provider/private/workspace" }));
  const close = vi.fn(async () => {}), stop = vi.fn(async () => {}), owners = new Map<string, AdapterContext>();
  let binding!: () => NativeSessionBinding;
  const controller: HostedAgentSourceController = { start: () => new Promise<void>(() => {}), stop, abortPending: () => {},
    registerOperation: (id, context) => { owners.set(id, context); }, projectResult: value => value,
    projectState: state => ({ ...state, binding: binding() }), projectHistory: history => history };
  const call = vi.fn<HostedAgentSourceConnection["client"]["call"]>(async () => ({ binding: { opaqueRef: "/provider/native.jsonl", generation: 1 }, streaming: false,
    compacting: false, pendingMessages: 0, providerId: "provider", modelId: "model", fastMode: false, permissionMode: "ask" }));
  const adapter = new HostedAgentSourceAdapter({ id: descriptor.id, source: { targetDeviceId: "provider-node", controllerDeviceId: "source-device", backendId: "native" },
    describe: () => descriptor, assertContext: () => {}, readPolicy: () => ({ permissionMode: "ask", fastMode: false }),
    workspace: () => ({ platform: process.platform as "win32" | "darwin" | "linux", shell: "bash", isGitRepository: false }),
    capture: () => ({ client: { open, call }, close, assertCurrent: () => {}, createController: input => { binding = input.binding; return controller; } }) });
  return { root, context, adapter, open, call, close, stop, owners, cleanup: async () => {
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

it("retains uncertain startup cleanup until the exact captured native connection confirms closure", async () => {
  const f = await fixture(); f.open.mockRejectedValueOnce(new Error("The original delivery outcome is unknown."));
  f.close.mockRejectedValueOnce(new Error("Native cleanup is unconfirmed."));
  try {
    await expect(f.adapter.createSession({ target: f.context.target, providerId: "provider", modelId: "model", permissionMode: "ask", fastMode: false }, f.context))
      .rejects.toThrow("cleanup could not be confirmed");
    expect(f.open).toHaveBeenCalledTimes(1); expect(f.close).toHaveBeenCalledTimes(1);
    await f.adapter.dispose(); expect(f.close).toHaveBeenCalledTimes(2); expect(f.open).toHaveBeenCalledTimes(1);
  } finally { await f.cleanup(); }
});
