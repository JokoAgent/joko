import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createClient, createRouterTransport } from "@connectrpc/connect";
import { PartnerHomeService, PartnerHomeBusyAction, PartnerHomeMovePhase, PermissionMode } from "@joko/contracts";
import { FakeBackendAdapter, PI_LIKE_PROFILE } from "@joko/testkit";
import { OperationalStore, PartnerStore, PartnerWorkbenchStore, type PartnerCapabilitiesRecord } from "@joko/store";
import { ArtifactStore } from "./artifact-store.js";
import { OperationalArtifactRepository } from "./artifact-repository.js";
import { CredentialVault } from "./credential-vault.js";
import { PartnerMemoryPreferences } from "./partner-memory-preferences.js";
import { PartnerManager } from "./partner-manager.js";
import { SessionHost } from "./session-host.js";
import { PartnerHomeOwner, PartnerHomeStorage } from "./partner-home-owner.js";
import { PartnerHomeRuntimeAdapter } from "./partner-home-runtime.js";
import { PartnerHomeSnapshots } from "./partner-home-snapshot.js";
import { PartnerRuntimePromptResolver } from "./partner-runtime-prompt.js";
import { PartnerHomeProjects } from "./partner-home-projects.js";
import { PartnerHomeWorkbench } from "./partner-home-workbench.js";
import { PartnerSessionTaskManager } from "./partner-session-tasks.js";
import { createPartnerHomeConnectService } from "./partner-home-connect-service.js";
import type { RemoteExecutionRouter } from "./remote-execution-router.js";
import type { DevicePeerOwner } from "./device-peer-owner.js";
import type { PartnerHomeFiles } from "./partner-home-files.js";
import type { PartnerRoutineManager } from "./partner-routine-manager.js";
import { PiResourceManager } from "./resource-manager.js";
import type { WorkspaceService } from "./workspace-service.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "joko-home-runtime-")), store = new OperationalStore(join(root, "operational.db"));
  const profiles = new PartnerStore(join(root, "partners.db")), storage = new PartnerHomeStorage(store);
  store.createConnection({ id: "phone-connection", deviceId: "phone", device: { defaultName: "Phone", kind: "mobile", platform: "ios" }, name: "Phone", authKeyDigest: "phone-key-digest" });
  store.createConnection({ id: "computer-connection", deviceId: "computer", device: { defaultName: "Laptop", kind: "desktop", platform: "linux" }, name: "Laptop", authKeyDigest: "computer-key-digest" });
  store.setDeviceRemoteControlEnabled("computer", true); store.setDeviceControlRelation({ controllerDeviceId: "phone", targetDeviceId: "computer", outboundEnabled: true, inboundAllowed: true });
  const artifacts = new ArtifactStore({ rootDirectory: join(root, "artifacts"), repository: new OperationalArtifactRepository(store), ingestRoots: [root] }); await artifacts.initialize();
  const adapter = new FakeBackendAdapter({ ...PI_LIKE_PROFILE, capabilities: [...PI_LIKE_PROFILE.capabilities.map(item => item.key === "permission.modes"
    ? { ...item, options: ["ask", "auto", "bypassPermissions"] } : item), { key: "runtime.resources", supported: true, options: ["skill"] }] }); let runtime: PartnerHomeRuntimeAdapter | undefined;
  const host = new SessionHost(store, artifacts, [adapter], { partnerSessionRetiring: id => storage.blocksSession(id),
    partnerTargetRetired: targetId => runtime?.blocksTarget(targetId) === true }); await host.initialize();
  const homesRoot = join(root, "partner-homes");
  const workbenchStore = new PartnerWorkbenchStore(homesRoot), workbench = new PartnerHomeWorkbench(store, workbenchStore);
  const workspaces = { register: vi.fn(async input => input), unregister: vi.fn() } as unknown as WorkspaceService;
  const partners = new PartnerManager({ store: profiles, operationalStore: store, sessionHost: host, workspaceService: workspaces,
    homesRoot, homeChanging: id => storage.changing(id), remoteHomeModelAvailable: targetId => runtime?.executionHome(targetId) !== undefined });
  const memoryPreferences = new PartnerMemoryPreferences(store, await CredentialVault.open(join(root, "vault.key")));
  const resources = new PiResourceManager({ store, managedRoot: join(root, "resources") }); await resources.initialize();
  resources.setPartnerHomeDataRoot(targetId => runtime?.dataRoot(targetId));
  const files = { prepare: vi.fn(async () => undefined), inspectDevice: vi.fn(async () => ({ location: { kind: "device", controllerDeviceId: "phone", deviceId: "computer", name: "Laptop", root: "/home/person/.joko/partner" }, platform: "linux", runtimeVersion: "test", assertCurrent: () => undefined })) } as unknown as PartnerHomeFiles;
  const routines = { engine: { list: () => [] }, suspendPartner: vi.fn(async () => undefined), resumePartner: vi.fn(async () => undefined),
    prepareHomeChange: vi.fn(async () => undefined) } as unknown as PartnerRoutineManager;
  const retireWorkbench = vi.fn(() => undefined);
  runtime = new PartnerHomeRuntimeAdapter({ serverId: "authority", store, profiles, partners, host, workspaces, resources,
    homesRoot, peers: { captureBinding: () => ({ assertCurrent: () => undefined }), list: () => [{ targetDeviceId: "computer", targetDeviceRevision: 1n,
      relationId: "paired-relation", relationRevision: 1n, routeGeneration: 1, displayName: "Laptop", kind: "desktop", platform: "linux" }] } as unknown as DevicePeerOwner, files,
    storage, snapshots: new PartnerHomeSnapshots(join(root, "home-moves")), memoryPreferences, routines, artifacts,
    workbench,
    ownedSessions: () => [], assertOwner: () => undefined, pauseGoal: async () => undefined, readProfileProjection: async () => undefined,
    supportsRemoteCreation: () => true, hasRemoteModelRoute: () => true, retireWorkbench });
  const failures: unknown[] = [];
  for (const name of ["prepare", "activate"] as const) {
    const original = runtime[name].bind(runtime); vi.spyOn(runtime, name).mockImplementation(async (...args) => {
      try { return await original(...args); } catch (error) { failures.push(error); throw error; }
    });
  }
  const owner = new PartnerHomeOwner(storage, runtime);
  const homeRpc = createClient(PartnerHomeService, createRouterTransport(router => router.service(PartnerHomeService,
    createPartnerHomeConnectService(owner, runtime, () => store.getConnection("phone-connection")))));
  host.setPartnerHomeInputGuard(sessionId => { if (runtime!.blocksInput(sessionId)) throw new Error("Partner home changed."); });
  cleanups.push(async () => { await owner.close(); await host.dispose(); profiles.close(); store.close(); await rm(root, { recursive: true, force: true }); });
  const capabilities: PartnerCapabilitiesRecord = { modelChain: [{ backendId: adapter.id, providerId: "test", modelId: "text", effort: "medium", fastMode: false }], permissionMode: "ask", planMode: false };
  const profile = await partners.createPartner({ requestId: "create-home-owner-partner", expectedDirectoryRevision: profiles.directoryState().revision,
    displayName: "Home owner", avatar: "orbit", identitySource: "Help with durable work.", templateId: "general", capabilities, usesDirectoryDefaults: false });
  expect(profile.initializationErrorCode).toBeUndefined(); expect(profile.initializationState).toBe("ready");
  const projects = new PartnerHomeProjects({ execution: { files: async () => ({ files: { realpath: async (path: string) => path,
    stat: async () => ({ kind: "directory", size: 0, modifiedAt: 1 }) }, assertCurrent: () => undefined }) } as unknown as RemoteExecutionRouter,
    home: targetId => runtime?.executionHome(targetId) });
  return { root, store, profiles, storage, artifacts, adapter, host, partners, runtime, owner, capabilities, profile, memoryPreferences, resources, files, routines, failures, workspaces, workbenchStore, workbench, projects, homeRpc, retireWorkbench };
}
describe("Partner home native integration", () => {
  it("moves the same profile to a fresh immutable execution owner with visible history, same-byte user media, memory and context", async () => {
    const f = await fixture(), original = f.store.getSession(f.profile.canonicalSessionId!).descriptor;
    const rebuild = vi.spyOn(f.adapter, "rebuildContext");
    const candidate = join(f.root, "candidate"); await mkdir(candidate); await writeFile(join(candidate, "SKILL.md"), "---\nname: personal\ndescription: Keep a useful personal procedure\n---\nComplete saved instructions.\n");
    const skill = await f.resources.preparePartnerSkill({ partnerId: f.profile.id, backendId: original.backendId, targetId: original.targetId,
      slug: "personal", candidateRoot: candidate, changedByConnectionId: "phone-connection" });
    await f.resources.completePreparedMutation(skill, finalize => f.store.transaction(store => finalize(store)));
    const user = await f.artifacts.ingestBytes(Buffer.from("original user attachment"), { fileName: "notes.txt", mimeType: "text/plain" });
    const missing = await f.artifacts.ingestBytes(Buffer.from("removed attachment"), { fileName: "removed.txt", mimeType: "text/plain" });
    f.store.deleteArtifact(missing.id);
    expect(f.store.getArtifact(user.id).sessionId).toBeUndefined();
    const append = (id: string, payload: Parameters<OperationalStore["appendEvent"]>[0]["payload"], emittedAt: number) => f.store.appendEvent({
      id, sessionId: original.id, targetId: original.targetId, backendId: original.backendId, generation: original.binding.generation, traceId: id, emittedAt, payload });
    const read = append("visible-user", { type: "message_complete", role: "user", blocks: [{ kind: "text", text: "Keep these notes" }, { kind: "artifact", blob: user, label: "notes.txt" }, { kind: "artifact", blob: missing, label: "removed.txt" }] }, 1000);
    append("visible-assistant", { type: "message_complete", role: "assistant", blocks: [{ kind: "text", text: "Saved." }, { kind: "thinking", text: "Private reasoning", redacted: false }] }, 2000);
    append("hidden-continuation", { type: "message_complete", role: "user", automaticContinuation: { recoveryId: "hidden-recovery" }, blocks: [{ kind: "text", text: "Hidden recovery prompt" }] }, 3000);
    f.profiles.markRead(f.profile.id, read.globalCursor);
    const memory = f.store.putMakerMemoryEntry({ targetId: original.targetId, kind: "user", slug: "preference", title: "Preference", description: "Keep a useful preference.", body: "Prefer brief answers." });
    f.memoryPreferences.update(original.targetId, undefined, { enabled: false, userContext: "Work context" });
    await f.workbenchStore.addProject(f.profile.id, 1n, "/work/original-project");
    const catalog = await f.homeRpc.listPartnerHomeTargets({ partnerId: f.profile.id }), destination = catalog.targets[1]!.destination!;
    const inspected = await f.homeRpc.inspectPartnerHomeTarget({ partnerId: f.profile.id, destination });
    expect(inspected.models).toEqual(expect.arrayContaining([expect.objectContaining({ route: expect.objectContaining({ backendId: original.backendId, providerId: "test", modelId: "text" }) })]));
    const moved = (await f.homeRpc.movePartnerHome({ requestId: "move-complete-function", expectedHome: catalog.home!.identity!, expectedPartnerRevision: { value: f.profile.revision },
      destination, capabilities: { modelChain: f.capabilities.modelChain.map(route => ({ ...route })), permissionMode: PermissionMode.ASK, planMode: false },
      busyAction: PartnerHomeBusyAction.WAIT, continueWhenSourceOffline: false })).move!;
    expect(moved.phase).toBe(PartnerHomeMovePhase.WAITING);
    await vi.waitFor(() => expect(["ready", "needs-attention"]).toContain(f.owner.get(moved.requestId)?.phase));
    expect(f.failures).toEqual([]); expect(f.owner.get(moved.requestId)?.phase).toBe("ready");
    const current = f.profiles.getPartner(f.profile.id), session = f.store.getSession(current.canonicalSessionId!).descriptor;
    expect(current.id).toBe(f.profile.id); expect(current.homeTargetId).not.toBe(original.targetId); expect(session.id).not.toBe(original.id);
    expect(session.remoteWorkspace).toEqual({ kind: "device_peer", controllerDeviceId: "phone", targetDeviceId: "computer", workspaceRoot: "/home/person/.joko/partner" });
    expect(f.store.getTarget(original.targetId).descriptor.remoteWorkspace).toBeUndefined();
    const history = f.store.listEvents({ sessionId: session.id }).filter(event => event.payload.type === "message_complete");
    expect(history.map(event => event.emittedAt)).toEqual([1000, 2000]);
    expect(JSON.stringify(history.map(event => event.payload))).not.toContain("Private reasoning");
    expect(JSON.stringify(history.map(event => event.payload))).toContain("[Attachment: removed.txt]");
    expect(JSON.stringify(history.map(event => event.payload))).not.toContain("Hidden recovery prompt");
    const userEvent = history[0]!.payload; if (userEvent.type !== "message_complete") throw new Error("Missing restored user message.");
    const attachment = userEvent.blocks.find(block => block.kind === "artifact"); if (attachment?.kind !== "artifact") throw new Error("Missing restored attachment.");
    expect(attachment.blob.id).not.toBe(user.id); expect(attachment.blob.sha256).toBe(user.sha256);
    expect(f.store.getArtifact(attachment.blob.id).sessionId).toBe(session.id);
    expect((await f.artifacts.readBlob(attachment.blob)).data).toEqual(Buffer.from("original user attachment"));
    expect(f.store.getMakerMemoryEntry(memory.id).targetId).toBe(current.homeTargetId);
    expect(f.store.searchMakerMemory(current.homeTargetId, "brief")).toHaveLength(1);
    expect(f.store.searchMakerMemory(original.targetId, "brief")).toHaveLength(0);
    const carriedSkill = f.resources.listPartnerSkills(current.id, current.homeTargetId)[0]; expect(carriedSkill?.slug).toBe("personal");
    expect(f.resources.listPartnerSkills(current.id, original.targetId)).toEqual([]);
    expect(f.memoryPreferences.read(current.homeTargetId)).toMatchObject({ enabled: false, userContext: "Work context" });
    expect(rebuild).toHaveBeenCalledOnce();
    expect(JSON.stringify(rebuild.mock.calls[0]![0].messages)).toContain("Keep these notes");
    expect(session.binding.generation).toBeGreaterThan(1);
    expect(f.profiles.readState(current.id).throughCursor).toBe(history[0]!.globalCursor);
    expect((await f.workbenchStore.read(current.id)).projects).toEqual([]);
    expect(f.workbench.foreign(current.id, "computer")[0]!.projects[0]!.path).toBe("/work/original-project");
    expect(f.partners.listSessions(current.id).find(view => view.link.sessionId === original.id)).toMatchObject({ readOnly: true, link: { role: "history" } });
    expect(() => f.host.enqueueServiceInput({ operationId: "old-machine-must-not-dispatch", sessionId: original.id,
      prompt: { text: "Do not send", images: [], files: [], mentions: [], disposition: "prompt" }, source: "system" })).toThrow(/fenced|home changed/u);
    expect(f.store.findOperation("old-machine-must-not-dispatch")).toBeUndefined();
    const receipt = await f.owner.retry(moved.requestId); expect(receipt.canonicalSessionId).toBe(session.id);
    expect(f.store.listEvents({ sessionId: session.id }).filter(event => event.payload.type === "message_complete")).toHaveLength(2);
    const updated = await f.partners.updatePartner(current.id, current.revision, { identitySource: "Updated after changing main computer." });
    const prompt = await new PartnerRuntimePromptResolver(f.profiles, f.store, f.memoryPreferences, async () => undefined)
      .resolve(f.store.getSession(updated.canonicalSessionId!).descriptor, () => undefined);
    expect(prompt).toContain("Updated after changing main computer."); expect(prompt).not.toContain("Help with durable work.");
    const tasks = new PartnerSessionTaskManager(f.store, f.partners, f.host, f.workspaces, f.root, Date.now, f.projects);
    cleanups.push(() => tasks.close());
    const task = await tasks.start(session.id, "task:new-main-computer", { instruction: "Continue in the selected new project", workingDir: "/work/new-project" }, () => undefined);
    expect(task.status).not.toBe("failed"); expect(task.sessionId).toBeTruthy();
    expect(f.runtime.executionHome(task.targetId)?.id).toBe(current.homeTargetId);
    expect(f.store.getSession(task.sessionId!).descriptor.remoteWorkspace).toMatchObject({ targetDeviceId: "computer", workspaceRoot: "/work/new-project" });
  });
  it("keeps the original home active after a transient attachment failure and retries without publishing a partial history", async () => {
    const f = await fixture(), original = f.store.getSession(f.profile.canonicalSessionId!).descriptor;
    const blob = await f.artifacts.ingestBytes(Buffer.from("original attachment"), { fileName: "notes.txt", mimeType: "text/plain" });
    f.store.appendEvent({ id: "transient-user", sessionId: original.id, targetId: original.targetId, backendId: original.backendId, generation: original.binding.generation,
      traceId: "transient-user", payload: { type: "message_complete", role: "user", blocks: [{ kind: "artifact", blob, label: "notes.txt" }] } });
    vi.spyOn(f.artifacts, "resolveBlobPath").mockRejectedValueOnce(Object.assign(new Error("Temporary disk read failure"), { code: "EIO" }));
    const input = { requestId: "retry-original-media", partnerId: f.profile.id, expectedGeneration: 1, expectedPartnerRevision: f.profile.revision,
      destination: { kind: "device" as const, controllerDeviceId: "phone", deviceId: "computer", name: "Laptop", root: "/home/person/.joko/partner" }, capabilities: f.capabilities, busyAction: "wait" as const, continueWhenSourceOffline: false };
    await f.owner.move(input); await vi.waitFor(() => expect(f.owner.get(input.requestId)?.phase).toBe("needs-attention"));
    expect(f.owner.current(f.profile.id).generation).toBe(1); expect(f.profiles.getPartner(f.profile.id).canonicalSessionId).toBe(original.id);
    expect(f.storage.freezesInput(original.id)).toBe(false);
    expect((await f.owner.retry(input.requestId)).phase).toBe("ready");
    const current = f.profiles.getPartner(f.profile.id); expect(f.store.listEvents({ sessionId: current.canonicalSessionId! }).filter(event => event.payload.type === "message_complete")).toHaveLength(1);
  });
  it("reuses the durable native context completion after interruption before the Home ready receipt", async () => {
    const f = await fixture(), rebuild = vi.spyOn(f.adapter, "rebuildContext");
    f.retireWorkbench.mockImplementationOnce(() => { throw new Error("Interrupted after native context commit."); });
    const input = { requestId: "context-completed-before-crash", partnerId: f.profile.id, expectedGeneration: 1, expectedPartnerRevision: f.profile.revision,
      destination: { kind: "device" as const, controllerDeviceId: "phone", deviceId: "computer", name: "Laptop", root: "/home/person/.joko/partner" }, capabilities: f.capabilities, busyAction: "wait" as const, continueWhenSourceOffline: false };
    await f.owner.move(input); await vi.waitFor(() => expect(f.owner.get(input.requestId)?.phase).toBe("needs-attention"));
    const session = f.profiles.getPartner(f.profile.id).canonicalSessionId!, binding = f.store.getSession(session).descriptor.binding;
    expect(f.store.getOperation(`partner-home:${input.requestId}:context`).status).toBe("completed");
    expect(f.store.getSessionContextHandoff(session)).toBeUndefined(); expect(rebuild).toHaveBeenCalledOnce();
    expect((await f.owner.retry(input.requestId)).phase).toBe("ready"); expect(rebuild).toHaveBeenCalledOnce();
    expect(f.store.getSession(session).descriptor.binding).toEqual(binding);
  });
  it("does not repeat an unconfirmed native context effect on an explicit Home retry", async () => {
    const f = await fixture(), rebuild = vi.spyOn(f.adapter, "rebuildContext").mockRejectedValueOnce(Object.assign(new Error("Native reply lost."), { stateMayHaveChanged: true }));
    const input = { requestId: "context-outcome-unknown", partnerId: f.profile.id, expectedGeneration: 1, expectedPartnerRevision: f.profile.revision,
      destination: { kind: "device" as const, controllerDeviceId: "phone", deviceId: "computer", name: "Laptop", root: "/home/person/.joko/partner" }, capabilities: f.capabilities, busyAction: "wait" as const, continueWhenSourceOffline: false };
    await f.owner.move(input); await vi.waitFor(() => expect(f.owner.get(input.requestId)?.failure).toBe("outcome-unknown"));
    expect(f.store.getOperation(`partner-home:${input.requestId}:context`).status).toBe("started");
    expect((await f.owner.retry(input.requestId)).failure).toBe("outcome-unknown"); expect(rebuild).toHaveBeenCalledOnce();
    const session = f.profiles.getPartner(f.profile.id).canonicalSessionId!; expect(f.runtime.blocksInput(session)).toBe(true);
  });
  it("drains admitted remote work during Wait while rejecting new input before Run or queue persistence", async () => {
    const f = await fixture();
    await f.owner.move({ requestId: "wait-remote-setup", partnerId: f.profile.id, expectedGeneration: 1, expectedPartnerRevision: f.profile.revision,
      destination: { kind: "device", controllerDeviceId: "phone", deviceId: "computer", name: "Laptop", root: "/home/person/.joko/partner" },
      capabilities: f.capabilities, busyAction: "wait", continueWhenSourceOffline: false });
    await vi.waitFor(() => expect(f.owner.get("wait-remote-setup")?.phase).toBe("ready"));
    const profile = f.profiles.getPartner(f.profile.id), session = f.store.getSession(profile.canonicalSessionId!).descriptor;
    const target = f.store.getTarget(session.targetId).descriptor, originalSend = f.adapter.send.bind(f.adapter);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const send = vi.spyOn(f.adapter, "send").mockImplementation(async (input, context) => {
      await gate;
      await f.projects.validateDirectories(target, [{ id: "selected-project", path: "/work/new-project", access: "read_write" }], () => {
        const current = f.store.getSession(context.sessionId).descriptor;
        if (!f.projects.remote(context.target) || f.runtime.blocksExecution(context.sessionId)
          || current.targetId !== context.target.id || current.binding.generation > context.generation) throw new Error("The Partner execution home changed.");
      });
      await originalSend(input, context);
    });
    const enqueue = (operationId: string) => f.host.enqueueServiceInput({ operationId, sessionId: session.id, source: "system",
      prompt: { text: operationId, images: [], files: [], mentions: [], disposition: "prompt" } });
    try {
      enqueue("admitted-remote-running"); await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
      enqueue("admitted-remote-queued");
      expect(f.store.listQueueItems({ sessionId: session.id, states: ["accepted"] })).toHaveLength(1);
      await f.owner.move({ requestId: "wait-for-admitted-remote-work", partnerId: profile.id, expectedGeneration: 2, expectedPartnerRevision: profile.revision,
        destination: f.runtime.local, capabilities: f.capabilities, busyAction: "wait", continueWhenSourceOffline: false });
      expect(f.owner.get("wait-for-admitted-remote-work")?.phase).toBe("waiting");
      expect(f.runtime.blocksTarget(target.id)).toBe(true); expect(f.runtime.blocksExecution(session.id)).toBe(false);
      expect(f.runtime.blocksInput(session.id)).toBe(true);
      const runs = f.store.listRuns({ sessionId: session.id }), queue = f.store.listQueueItems({ sessionId: session.id });
      expect(() => enqueue("new-input-after-wait")).toThrow(/home changed/u);
      expect(f.store.findOperation("new-input-after-wait")?.status).toBe("failed");
      expect(f.store.listRuns({ sessionId: session.id })).toEqual(runs); expect(f.store.listQueueItems({ sessionId: session.id })).toEqual(queue);
      release();
      await vi.waitFor(() => expect(f.owner.get("wait-for-admitted-remote-work")?.phase).toBe("ready"), { timeout: 10_000 });
      expect(send).toHaveBeenCalledTimes(2);
      expect(f.store.listQueueItems({ sessionId: session.id, states: ["accepted", "dispatching", "backend_accepted", "dispatch_unknown"] })).toEqual([]);
      expect(f.runtime.blocksExecution(session.id)).toBe(true);
    } finally { release(); }
  });
});
