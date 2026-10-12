import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createClient, Code } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import * as contract from "@joko/contracts";
import { FakeBackendAdapter, PI_LIKE_PROFILE } from "@joko/testkit";
import { OperationalStore, PartnerGroupStore, PartnerStore, type PartnerProfileRecord } from "@joko/store";
import type { AdapterContext } from "@joko/core";
import { ArtifactStore } from "./artifact-store.js";
import { OperationalArtifactRepository } from "./artifact-repository.js";
import { PartnerManager } from "./partner-manager.js";
import { PartnerGroupSessionRuntime } from "./partner-group-runtime.js";
import { SessionHost } from "./session-host.js";
import { PartnerGroupManager } from "./partner-group-manager.js";
import { PartnerGroupAttachments } from "./partner-group-attachments.js";
import { PartnerGroupWorkspaces } from "./partner-group-workspaces.js";
import { ConnectionManager } from "./connection-manager.js";
import { createPublicServer } from "./server.js";
import type { OrchestratorApplication } from "./application.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const profile = { ...PI_LIKE_PROFILE, capabilities: [...PI_LIKE_PROFILE.capabilities.map(capability => capability.key === "permission.modes"
  ? { key: "permission.modes", supported: true, options: ["ask", "auto", "bypassPermissions"] } : capability), { key: "permission.change", supported: true }] } as const;
class OwnerProbeAdapter extends FakeBackendAdapter {
  constructor(readonly profiles: PartnerStore) { super(profile); }
  readonly privateOwners: string[] = [];
  override async createSession(input: Parameters<FakeBackendAdapter["createSession"]>[0], context: AdapterContext) {
    const link = this.profiles.getSessionLink(context.sessionId);
    if (link?.role === "group") this.privateOwners.push(link.partnerId);
    return super.createSession(input, context);
  }
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "joko-group-runtime-"));
  const store = new OperationalStore(join(root, "operations.db")), profiles = new PartnerStore(join(root, "profiles.db")), groups = new PartnerGroupStore(join(root, "groups.db"));
  const artifacts = new ArtifactStore({ rootDirectory: join(root, "artifacts"), repository: new OperationalArtifactRepository(store), ingestRoots: [root] }); await artifacts.initialize();
  const adapter = new OwnerProbeAdapter(profiles), workspaces = { register: vi.fn(async (input: Parameters<import("./workspace-service.js").WorkspaceService["register"]>[0]) => input), unregister: vi.fn() };
  let runtime: PartnerGroupSessionRuntime;
  const host = new SessionHost(store, artifacts, [adapter], { partnerSessionPaused: id => profiles.isPartnerSessionPaused(id) || runtime?.isHeld(id) === true,
    partnerSessionRetiring: id => profiles.isPartnerSessionRetiring(id) || runtime?.isRetiring(id) === true,
    partnerTargetRetired: id => profiles.isPartnerTargetRetired(id) });
  runtime = new PartnerGroupSessionRuntime(groups, profiles, store, host, workspaces); await host.initialize();
  const partners = new PartnerManager({ store: profiles, operationalStore: store, sessionHost: host, workspaceService: workspaces, homesRoot: join(root, "homes"),
    ownedIndependentSessions: id => runtime.ownedSessions(id) });
  cleanups.push(async () => { await host.dispose(); profiles.close(); groups.close(); store.close(); await rm(root, { recursive: true, force: true }); });
  const members: PartnerProfileRecord[] = [];
  for (const name of ["Author", "Editor"]) members.push(await partners.createPartner({ requestId: `group-profile-${name}`, expectedDirectoryRevision: profiles.directoryState().revision,
    displayName: name, avatar: "orbit", templateId: "general", identitySource: `You are ${name}.`, usesDirectoryDefaults: false,
    capabilities: { modelChain: [{ backendId: profile.id, providerId: profile.models[0]!.providerId, modelId: profile.models[0]!.modelId, effort: "medium", fastMode: false }], permissionMode: "ask", planMode: false } }));
  expect(members.map(member => ({ state: member.initializationState, error: member.initializationErrorCode }))).toEqual([{ state: "ready", error: undefined }, { state: "ready", error: undefined }]);
  const group = groups.create({ requestId: "runtime-group-create", expectedDirectoryRevision: groups.directoryRevision(), name: "Review", memberIds: members.map(member => member.id) });
  const ensure = () => runtime.ensureLane({ group: groups.get(group.id), partner: profiles.getPartner(members[0]!.id), signal: new AbortController().signal, assertCurrent: () => undefined });
  return { root, store, profiles, groups, artifacts, adapter, workspaces, host, runtime, partners, members, group, ensure };
}
describe("Hidden Partner group native execution", () => {
  it("retires a persisted private preparation only after its original native owner proves no Session was created", async () => {
    const f = await fixture();
    await expect(f.runtime.ensureLane({ group: f.groups.get(f.group.id), partner: f.profiles.getPartner(f.members[0]!.id), signal: new AbortController().signal,
      assertCurrent: () => { if (f.groups.lanes(f.group.id).some(lane => lane.sessionId !== null)) throw new Error("Prepared owner retired"); } })).rejects.toThrow();
    const prepared = f.groups.lanes(f.group.id)[0]!; expect(prepared.phase).toBe("unknown"); expect(prepared.sessionId).toBeTruthy(); expect(f.adapter.privateOwners).toEqual([]);
    expect(f.host.isPrivateSessionCreationClosed(prepared.operationId, prepared.sessionId!)).toBe(true);
    const ready = await f.ensure(); expect(ready.sessionId).not.toBe(prepared.sessionId); expect(f.profiles.getSessionLink(prepared.sessionId!)).toBeUndefined();
    expect(f.groups.lanes(f.group.id)[0]!.phase).toBe("ready"); expect(f.adapter.privateOwners).toEqual([f.members[0]!.id]);
  });
  it("retries a creation that failed before the private callback without reusing an unknown native effect", async () => {
    const f = await fixture(); const createSession = vi.spyOn(f.host, "createServiceSession"); createSession.mockRejectedValueOnce(new Error("Pre-creation validation failed"));
    await expect(f.ensure()).rejects.toThrow("Pre-creation validation failed");
    const original = f.groups.lanes(f.group.id)[0]!; expect(original).toMatchObject({ phase: "unknown", sessionId: null }); expect(f.adapter.privateOwners).toEqual([]);
    const resumed = await f.ensure(), current = f.groups.lanes(f.group.id)[0]!;
    expect(current.operationId).not.toBe(original.operationId); expect(current).toMatchObject({ phase: "ready", sessionId: resumed.sessionId }); expect(f.adapter.privateOwners).toEqual([f.members[0]!.id]);
  });
  it("authenticates the generated group HTTP service and controls its real Host conversation independently of ordinary sessions", async () => {
    const f = await fixture(), directories = new PartnerGroupWorkspaces(f.store, f.root); await directories.initialize();
    const groups = new PartnerGroupManager({ storage: f.groups, partners: f.partners, runtime: f.runtime, work: directories,
      attachments: new PartnerGroupAttachments(f.artifacts), decidePlan: async () => ({ needsPlan: false }),
      changed: (groupId, change) => { f.groups.appendChange(groupId, change); }, notifyStep: async () => undefined }); await groups.start();
    const connections = new ConnectionManager(f.store), challenge = connections.issuePairing("Group observer"), paired = connections.completePairing({ challengeId: challenge.id, code: challenge.code, connectionName: "Group observer" });
    const server = await createPublicServer({ config: { publicOrigin: "http://127.0.0.1", allowInsecureLoopback: true, allowInsecureLan: false,
      corsOrigins: [], webDirectory: join(f.root, "no-web"), dataDirectory: f.root }, store: f.store, connections, artifacts: f.artifacts, blobTransfers: {},
      artifactRepository: {}, workspaces: f.workspaces, workspaceChanges: {}, scheduler: {}, adapters: [f.adapter], browserActivity: [], sessionHost: f.host,
      partners: f.partners, partnerGroupRuntime: f.runtime, partnerGroups: groups } as unknown as OrchestratorApplication); server.log.level = "silent";
    try {
      const baseUrl = await server.listen({ host: "127.0.0.1", port: 0 }), transport = createConnectTransport({ baseUrl, httpVersion: "1.1",
        interceptors: [next => request => { request.header.set("authorization", `Bearer ${paired.authKey}`); return next(request); }] });
      const client = createClient(contract.PartnerGroupService, transport), catalog = await client.listPartnerGroups({});
      const created = await client.createPartnerGroup({ requestId: "formal-group-create", expectedDirectoryRevision: catalog.revision, name: "Working group", memberIds: f.members.map(member => member.id) });
      expect(created.group?.members).toHaveLength(2); const groupId = created.group!.id;
      await client.sendPartnerGroupMessage({ groupId, expectedRevision: created.group!.revision, clientId: "formal-group-message", text: "Inspect the result" });
      await vi.waitFor(() => expect(groups.detail(groupId, paired.connection.deviceId).round.canContinue).toBe(true), { timeout: 5_000 });
      const detail = await client.getPartnerGroup({ groupId }); expect(detail.detail?.messages.filter(message => message.authorKind === contract.PartnerGroupAuthorKind.PARTNER).length).toBeGreaterThan(0);
      await client.markPartnerGroupRead({ groupId, throughSequence: detail.detail!.messages.at(-1)!.sequence }); expect((await client.listPartnerGroups({})).groups.find(group => group.id === groupId)?.unread).toBe(false);
      await client.continuePartnerGroup({ groupId }); await client.stopPartnerGroup({ groupId });
      const current = await client.getPartnerGroup({ groupId }); await client.deletePartnerGroup({ groupId, expectedRevision: current.detail!.group!.revision });
      expect((await client.getPartnerGroupCreation({ requestId: "formal-group-create" })).retired).toBe(true);
      expect(f.store.getSession(f.members[0]!.canonicalSessionId!).descriptor.archived).toBe(false);
      await expect(createClient(contract.PartnerGroupService, createConnectTransport({ baseUrl, httpVersion: "1.1" })).listPartnerGroups({})).rejects.toMatchObject({ code: Code.Unauthenticated });
    } finally { await server.close(); await groups.close(); directories.dispose(); }
  });
  it("primes the private owner before native creation, admits through the real Queue and keeps canonical activity separate", async () => {
    const f = await fixture(), lane = await f.ensure();
    expect(f.adapter.privateOwners).toEqual([f.members[0]!.id]);
    expect(f.profiles.getSessionLink(lane.sessionId)?.role).toBe("group");
    expect(f.partners.listSessions(f.members[0]!.id).some(item => item.link.sessionId === lane.sessionId)).toBe(false);
    const accepted = vi.fn();
    const result = await f.runtime.execute({ lane, clientId: "real-turn", prompt: "Inspect the result", attachments: [], signal: new AbortController().signal, onAccepted: accepted });
    expect(result).toMatchObject({ status: "completed" }); expect(result.text).toContain("Inspect the result"); expect(accepted).toHaveBeenCalledTimes(1);
    const item = f.store.listQueueItems({ sessionId: lane.sessionId })[0]!;
    expect(item.backendAcceptedAt).toBeDefined(); expect(f.store.getRun(item.runId).descriptor.source).toBe("system");
    expect(f.partners.activity(f.members[0]!.id).unreadReplyCount).toBe(0);
    expect(await f.runtime.stop(lane.sessionId)).toBe(true);
    expect(f.runtime.isHeld(lane.sessionId)).toBe(true);
    const resumed = await f.ensure(); expect(resumed.sessionId).toBe(lane.sessionId); expect(f.runtime.isHeld(lane.sessionId)).toBe(false);
    const member = f.profiles.getPartner(f.members[0]!.id);
    const paused = await f.partners.setLifecycle(member.id, member.revision, "paused");
    expect(paused.lifecycle).toBe("paused"); expect(f.profiles.isPartnerSessionPaused(lane.sessionId)).toBe(true);
    await expect(f.ensure()).rejects.toThrow();
    const active = await f.partners.setLifecycle(member.id, paused.revision, "active");
    expect(f.profiles.isPartnerSessionPaused(lane.sessionId)).toBe(false);
    expect((await f.ensure()).sessionId).toBe(lane.sessionId);
    await f.runtime.archive(f.groups.lanes(f.group.id)[0]!);
    expect(f.store.getSession(lane.sessionId).descriptor.archived).toBe(true);
    expect(f.store.getSession(f.members[0]!.canonicalSessionId!).descriptor.archived).toBe(false);
    const deleted = await f.partners.deletePartner({ requestId: "group-member-deletion", partnerId: member.id, expectedRevision: active.revision, confirmName: active.displayName });
    expect(deleted.phase).toBe("completed"); expect(f.groups.get(f.group.id).memberIds).toContain(member.id);
    expect(f.store.getSession(f.members[1]!.canonicalSessionId!).descriptor.archived).toBe(false);
  });
  it("holds and cancels a recovered accepted group input before the next explicit turn", async () => {
    const f = await fixture(), lane = await f.ensure();
    f.store.setQueuePaused({ sessionId: lane.sessionId, paused: true, traceId: "test-user-held" });
    const old = f.host.enqueueServiceInput({ operationId: "old-group-input", sessionId: lane.sessionId, source: "system",
      prompt: { text: "Interrupted request", disposition: "prompt", images: [], files: [], mentions: [] } });
    const restarted = new PartnerGroupSessionRuntime(f.groups, f.profiles, f.store, f.host, f.workspaces);
    expect(restarted.isHeld(lane.sessionId)).toBe(true);
    await f.runtime.recover(f.groups.lanes());
    expect(f.store.getQueueItem(old.value.queueItemId).state).toBe("cancelled");
    expect(f.runtime.isHeld(lane.sessionId)).toBe(true);
    expect(f.store.getQueueControl(lane.sessionId).paused).toBe(true);
    expect(f.store.listEvents({ sessionId: lane.sessionId }).some(event => event.payload.type === "message_complete" && event.payload.role === "assistant")).toBe(false);
  });
});
