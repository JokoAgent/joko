import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as contract from "@joko/contracts";
import type { AdapterContext, NativeTextInferenceInput, PromptInput } from "@joko/core";
import { OperationalStore, PartnerGroupStore, PartnerNetworkStore, PartnerStore, networkHumanId } from "@joko/store";
import { FakeBackendAdapter, PI_LIKE_PROFILE } from "@joko/testkit";
import { ArtifactStore } from "./artifact-store.js";
import { OperationalArtifactRepository } from "./artifact-repository.js";
import { CredentialVault } from "./credential-vault.js";
import { PartnerNetworkHost, parsePartnerNetworkInvitation } from "./partner-network-host.js";
import { PartnerNetworkHome, createPartnerNetworkRemote, partnerNetworkOrigin, type PartnerNetworkRemoteOptions } from "./partner-network-home.js";
import { PartnerNetworkRuntime } from "./partner-network-runtime.js";
import { PartnerGroupSessionRuntime } from "./partner-group-runtime.js";
import { PartnerManager } from "./partner-manager.js";
import { SessionHost } from "./session-host.js";
import { ConnectionManager } from "./connection-manager.js";
import { createPublicServer } from "./server.js";
import type { OrchestratorApplication } from "./application.js";
import type { ModelRouteCatalog } from "./personalization-inference.js";
import { createIdentity } from "@jokoagent/linkspan-noise";
import { attachTestLinkspanTransport } from "./test-linkspan-transport.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.restoreAllMocks(); });
const profile = { ...PI_LIKE_PROFILE, models: PI_LIKE_PROFILE.models.map(model => ({ ...model, supportsImages: true })), capabilities: PI_LIKE_PROFILE.capabilities.map(capability => capability.key === "permission.modes" ? { ...capability, options: ["ask", "auto", "bypassPermissions"] } : capability) };
class ConversationAdapter extends FakeBackendAdapter {
  readonly infer = vi.fn(async (_input: NativeTextInferenceInput) => "A public group answer.");
  readonly groupContexts: AdapterContext[] = [];
  beforeGroupSend?: (context: AdapterContext) => Promise<void>;
  groupReply?: (context: AdapterContext) => Promise<void>;
  constructor(readonly profiles: PartnerStore) { super(profile); }
  inferNativeText(input: NativeTextInferenceInput): Promise<string> { return this.infer(input); }
  override async send(input: PromptInput, context: AdapterContext) {
    if (this.profiles.getSessionLink(context.sessionId)?.role === "group") {
      this.groupContexts.push(context);
      if (this.groupReply) { queueMicrotask(() => void this.groupReply!(context).catch(() => {})); return; }
      if (this.beforeGroupSend) { void this.beforeGroupSend(context).then(() => super.send(input, context)).catch(() => {}); return; }
    }
    return super.send(input, context);
  }
}
const authority = () => ({ signal: new AbortController().signal, deviceId: "foreign-browser", assertCurrent() {} });
async function fixture() {
  const endpointIdentity = await createIdentity();
  const root = await mkdtemp(join(tmpdir(), "joko-network-runtime-")), serverId = "room-authority";
  const store = new OperationalStore(join(root, "operations.db")), profiles = new PartnerStore(join(root, "profiles.db"));
  const artifacts = new ArtifactStore({ rootDirectory: join(root, "artifacts"), repository: new OperationalArtifactRepository(store), ingestRoots: [root] }); await artifacts.initialize();
  const vault = await CredentialVault.open(join(root, "master.key"));
  const adapter = new ConversationAdapter(profiles), workspaces = { register: vi.fn(async (input: Parameters<import("./workspace-service.js").WorkspaceService["register"]>[0]) => input), unregister: vi.fn() };
  let lanes: PartnerGroupSessionRuntime;
  const sessions = new SessionHost(store, artifacts, [adapter], { partnerSessionPaused: id => profiles.isPartnerSessionPaused(id) || lanes?.isHeld(id) === true,
    partnerSessionRetiring: id => profiles.isPartnerSessionRetiring(id) || lanes?.isRetiring(id) === true, partnerTargetRetired: id => profiles.isPartnerTargetRetired(id) });
  const lanePath = join(root, "lanes.db"), laneStore = new PartnerGroupStore(lanePath); lanes = new PartnerGroupSessionRuntime(laneStore, profiles, store, sessions, workspaces); await sessions.initialize();
  const partners = new PartnerManager({ store: profiles, operationalStore: store, sessionHost: sessions, workspaceService: workspaces, homesRoot: join(root, "homes"), ownedIndependentSessions: id => lanes.ownedSessions(id) });
  const partner = await partners.createPartner({ requestId: "network-private-partner", expectedDirectoryRevision: profiles.directoryState().revision, displayName: "Nova", avatar: "orbit", templateId: "general",
    identitySource: "PRIVATE_OWNER_IDENTITY_DO_NOT_SHARE", description: "A public companion description.", usesDirectoryDefaults: false,
    capabilities: { modelChain: [{ backendId: profile.id, providerId: profile.models[0]!.providerId, modelId: profile.models[0]!.modelId, effort: "medium", fastMode: false }], permissionMode: "ask", planMode: false } });
  expect({ state: partner.initializationState, error: partner.initializationErrorCode }).toEqual({ state: "ready", error: undefined });
  const publicPartner = (id: string) => { const current = profiles.getPartner(id); if (current.lifecycle !== "active") throw new Error(); return { id: current.id, name: current.displayName, description: current.description }; };
  const host = new PartnerNetworkHost({ storage: new PartnerNetworkStore(store), serverId, origin: "http://127.0.0.1", endpointPublicKey: endpointIdentity.publicKey, mediaDirectory: join(root, "media"), partner: publicPartner, artifacts });
  const home = new PartnerNetworkHome({ directory: join(root, "home"), serverId, vault, partner: publicPartner }); await home.initialize();
  const routes: ModelRouteCatalog = { list: () => [], resolve: () => undefined };
  const f = { root, store, profiles, artifacts, vault, adapter, sessions, lanes, lanePath, laneStore, partner, host, home, partners, workspaces,
    network: new PartnerNetworkRuntime({ host, home, profiles, store, laneStore, lanes, routes, adapters: () => [adapter], artifacts }),
    server: undefined as Awaited<ReturnType<typeof createPublicServer>> | undefined };
  sessions.setExtensionNativeToolAuthorization(id => f.network.nativeToolAuthorization(id));
  cleanups.push(async () => { await f.server?.close(); await f.network.close(); await sessions.dispose(); profiles.close(); store.close(); await rm(root, { recursive: true, force: true }); });
  const connections = new ConnectionManager(store), challenge = connections.issuePairing("Room owner"), paired = connections.completePairing({ challengeId: challenge.id, code: challenge.code, connectionName: "Room owner" });
  const config = { publicOrigin: host.options.origin, allowInsecureLoopback: true, allowInsecureLan: false, corsOrigins: [], webDirectory: join(root, "no-web"), dataDirectory: root };
  f.server = await createPublicServer({ serverId, config, store, connections, artifacts, blobTransfers: {}, artifactRepository: {}, workspaces,
    workspaceChanges: {}, scheduler: {}, adapters: [adapter], browserActivity: [], sessionHost: sessions, partners, partnerNetwork: f.network } as unknown as OrchestratorApplication);
  f.server.log.level = "silent";
  const baseUrl = await f.server.listen({ host: "127.0.0.1", port: 0 }); host.options.origin = baseUrl; config.publicOrigin = baseUrl;
  const retireTransport = attachTestLinkspanTransport(f.server.server, baseUrl, endpointIdentity);
  cleanups.push(retireTransport);
  const owner = createClient(contract.PartnerNetworkService, createConnectTransport({ baseUrl, httpVersion: "1.1", interceptors: [next => request => { request.header.set("authorization", `Bearer ${paired.authKey}`); return next(request); }] }));
  const room = (await owner.createPartnerNetwork({ operationId: "room-create", name: "Shared room", displayName: "Owner", partnerIds: [partner.id] })).room!;
  const invitation = (await owner.invitePartnerNetwork({ operationId: "invitation", roomId: room.id, expectedRevision: room.revision, lifetimeMs: 86400_000n })).invitation;
  const foreignDirectory = join(root, "foreign-home"), foreignOptions = { directory: foreignDirectory, serverId: "foreign-home", vault, partner: publicPartner };
  const foreign = new PartnerNetworkHome(foreignOptions); await foreign.initialize(); cleanups.push(() => foreign.close());
  const joined = await foreign.join(create(contract.JoinPartnerNetworkRequestSchema, { operationId: "join-original", invitation, displayName: "Guest" }), authority());
  const foreignSend = (text: string, attachments: readonly contract.PartnerNetworkAttachment[] = []) => foreign.send(create(contract.SendPartnerNetworkRequestSchema,
    { operationId: `send-${crypto.randomUUID()}`, roomId: room.id, joinId: joined.joinId, text, mentions: [room.members.find(member => member.kind === "partner")!.id], attachments: [...attachments] }), authority());
  const manage = (action: string, actorId = "", value = "") => owner.managePartnerNetwork({ operationId: crypto.randomUUID(), roomId: room.id, expectedRevision: BigInt(host.storage.get(room.id).revision), action, actorId, value });
  return { ...f, f, owner, room, invitation, foreign, foreignOptions, joined, foreignSend, manage, baseUrl, connections, paired };
}
async function upload(f: Awaited<ReturnType<typeof fixture>>, data: Uint8Array, mediaType: string, name: string) {
  const target = { roomId: f.room.id, joinId: f.joined.joinId }, started = await f.foreign.media(create(contract.MediaPartnerNetworkRequestSchema, { ...target, operationId: crypto.randomUUID(), action: "begin", name, mediaType, sizeBytes: BigInt(data.length) }), authority());
  for (let offset = 0; offset < data.length; offset += 256 * 1024) await f.foreign.media(create(contract.MediaPartnerNetworkRequestSchema, { ...target, action: "write", mediaId: started.attachment!.id, offset: BigInt(offset), data: data.slice(offset, offset + 256 * 1024) }), authority());
  return started.attachment!;
}
async function finished(f: Awaited<ReturnType<typeof fixture>>) { await vi.waitFor(() => expect(f.host.storage.executions(f.room.id).every(job => !["queued", "running"].includes(job.status))).toBe(true), { timeout: 6_000 }); }

describe("Built-in conversation authority and execution", () => {
  it("delivers the completed native task's generated image through the existing room media owner without forwarding private tool observations", async () => {
    const f = await fixture(), actor = f.room.members.find(member => member.kind === "partner")!, bytes = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);
    f.adapter.groupReply = async context => {
      const path = join(context.target.workspaceRoot, "generated.png"); await writeFile(path, bytes);
      const generated = await context.storeArtifact(path, { fileName: "generated.png", mimeType: "image/png" });
      const privatePath = join(context.target.workspaceRoot, "private-screen.png"); await writeFile(privatePath, new Uint8Array([4, 5, 6]));
      const privateImage = await context.storeArtifact(privatePath, { fileName: "private-screen.png", mimeType: "image/png" });
      await context.emit({ type: "tool_result", callId: "private-screen", name: "screenshot", output: "Private observation", isError: false, parts: [{ kind: "image", blob: privateImage }] });
      await context.emit({ type: "tool_result", callId: "generated", name: "image_generate", output: "Generated", isError: false, parts: [{ kind: "image", blob: generated }, { kind: "image", blob: generated }] });
      await context.emit({ type: "message_complete", role: "assistant", blocks: [{ kind: "text", text: "The generated image is ready." }, { kind: "image", blob: generated }] });
      await context.emit({ type: "done", outcome: "completed" });
    };
    await f.owner.sendPartnerNetwork({ operationId: "generated-owner-reply", roomId: f.room.id, text: "Make an image", mentions: [actor.id] });
    await f.network.tick(); await finished(f);
    const reply = f.host.storage.messages(f.room.id).find(message => message.authorId === actor.id && message.text === "The generated image is ready.")!;
    expect(reply.attachments).toHaveLength(1); expect(reply.attachments[0]?.name).toBe("generated.png");
    const read = await f.foreign.media(create(contract.MediaPartnerNetworkRequestSchema, { roomId: f.room.id, joinId: f.joined.joinId, action: "read", mediaId: reply.attachments[0]!.id }), authority());
    expect(read.data).toEqual(bytes); await f.network.tick(); expect(f.host.storage.messages(f.room.id).filter(message => message.id === reply.id)).toHaveLength(1);
  }, 15_000);
  it("keeps two live Threads of the same companion in distinct native Sessions and stops only the selected conversation", async () => {
    const f = await fixture(), actor = f.room.members.find(member => member.kind === "partner")!;
    const rootA = (await f.owner.sendPartnerNetwork({ operationId: "native-root-a", roomId: f.room.id, text: "Topic A", mentions: [actor.id] })).message!;
    await f.network.tick(); await finished(f);
    const rootB = (await f.owner.sendPartnerNetwork({ operationId: "native-root-b", roomId: f.room.id, text: "Topic B", mentions: [actor.id] })).message!;
    await f.network.tick(); await finished(f);
    const contexts: AdapterContext[] = [], release: (() => void)[] = [];
    f.adapter.beforeGroupSend = async context => { contexts.push(context); await new Promise<void>(resolve => { release.push(resolve); context.signal.addEventListener("abort", () => resolve(), { once: true }); }); };
    await f.owner.sendPartnerNetwork({ operationId: "native-thread-a", roomId: f.room.id, threadRootId: rootA.id, text: "Work in A", mentions: [actor.id] });
    await f.network.tick(); await vi.waitFor(() => expect(contexts).toHaveLength(1));
    await f.owner.sendPartnerNetwork({ operationId: "native-thread-b", roomId: f.room.id, threadRootId: rootB.id, text: "Work in B", mentions: [actor.id] });
    await f.network.tick(); await vi.waitFor(() => expect(contexts).toHaveLength(2));
    const a = contexts[0]!, b = contexts[1]!;
    expect(a.sessionId).not.toBe(b.sessionId); expect(f.store.getSession(a.sessionId).descriptor.binding.opaqueRef).not.toBe(f.store.getSession(b.sessionId).descriptor.binding.opaqueRef);
    expect(f.network.ownerTaskScope(a.sessionId)?.sourceMessageId).not.toBe(f.network.ownerTaskScope(b.sessionId)?.sourceMessageId);
    await f.owner.managePartnerNetwork({ operationId: "stop-only-a", roomId: f.room.id, expectedRevision: BigInt(f.host.storage.get(f.room.id).revision), action: "stop", threadRootId: rootA.id });
    expect(f.network.ownerTaskScope(a.sessionId)).toBeUndefined(); expect(() => f.network.ownerTaskScope(b.sessionId)!.assertCurrent()).not.toThrow();
    for (const done of release) done(); await finished(f);
    const replies = f.host.storage.messages(f.room.id).filter(message => message.authorId === actor.id && message.threadRootId);
    expect(replies.every(message => message.threadRootId === rootB.id)).toBe(true);
  }, 20_000);
  it("reads and follows a Thread as the original human across paired readers without changing the main read position", async () => {
    const f = await fixture(), actor = f.room.members.find(member => member.kind === "partner")!;
    const root = (await f.owner.sendPartnerNetwork({ operationId: "read-root", roomId: f.room.id, text: "Read source", mentions: [actor.id] })).message!;
    const reply = (await f.owner.sendPartnerNetwork({ operationId: "read-reply", roomId: f.room.id, text: "Mention guest", mentions: [f.joined.selfId], threadRootId: root.id })).message!;
    const target = { roomId: f.room.id, joinId: f.joined.joinId };
    const before = await f.foreign.snapshot(create(contract.GetPartnerNetworkRequestSchema, { ...target, threadRootId: root.id }), authority());
    expect(before.readerStateSupported).toBe(true); expect(before.threads[0]).toMatchObject({ rootId: root.id, mentioned: true, unreadCount: 1n, following: false });
    await f.foreign.manage(create(contract.ManagePartnerNetworkRequestSchema, { ...target, operationId: "follow-once", action: "follow-thread", threadRootId: root.id, throughSequence: reply.sequence, following: true }), authority());
    const pairedAgain = new PartnerNetworkHome(f.foreignOptions); await pairedAgain.initialize(); cleanups.push(() => pairedAgain.close());
    const followed = await pairedAgain.snapshot(create(contract.GetPartnerNetworkRequestSchema, { ...target, threadRootId: root.id }), authority());
    expect(followed.threadReadSequence).toBe(0n); expect(followed.threadFollowing).toBe(true);
    await pairedAgain.manage(create(contract.ManagePartnerNetworkRequestSchema, { ...target, operationId: "read-thread", action: "mark-read", threadRootId: root.id, throughSequence: reply.sequence }), authority());
    const after = await f.foreign.snapshot(create(contract.GetPartnerNetworkRequestSchema, target), authority());
    expect(after.threads[0]?.unreadCount).toBe(0n); expect(after.room?.readSequence).toBe(before.room?.readSequence);
    await f.manage("remove-member", f.joined.selfId);
    await expect(pairedAgain.snapshot(create(contract.GetPartnerNetworkRequestSchema, { ...target, threadRootId: root.id }), authority())).rejects.toMatchObject({ code: Code.PermissionDenied });
  });
  it("keeps a sealed foreign membership on its original pinned locator when the authority publishes a new entrance", async () => {
    const f = await fixture();
    f.host.options.origin = () => "https://current.trycloudflare.com";
    const request = create(contract.GetPartnerNetworkRequestSchema, { roomId: f.room.id, joinId: f.joined.joinId });
    expect((await f.foreign.snapshot(request, authority())).room?.hostOrigin).toBe(f.baseUrl);
    const restored = new PartnerNetworkHome(f.foreignOptions); await restored.initialize(); cleanups.push(() => restored.close());
    expect(restored.directory()[0]?.hostOrigin).toBe(f.baseUrl);
    expect((await restored.snapshot(request, authority())).room?.hostOrigin).toBe(f.baseUrl);
    expect(f.host.snapshot(create(contract.GetPartnerNetworkRequestSchema, { roomId: f.room.id }), f.host.selfId).room?.hostOrigin)
      .toBe("https://current.trycloudflare.com");
  });
  it("classifies a structured execution failure, retries only its durable terminal and exposes no diagnostic message or model input", async () => {
    const f = await fixture(), before = f.host.storage.messages(f.room.id).length;
    f.adapter.infer.mockRejectedValueOnce(Object.assign(new Error("PRIVATE_PROMPT /home/private access_token=secret"), { codexErrorInfo: "usageLimitExceeded", errorStatus: 429 }));
    const settle = f.host.settle.bind(f.host); let lost = false;
    vi.spyOn(f.host, "settle").mockImplementation((request, ownerId) => { const result = settle(request, ownerId); if (request.action === "fail" && !lost) { lost = true; throw new ConnectError("Lost terminal receipt", Code.Unavailable); } return result; });
    const source = await f.foreignSend("Fail this exact input"); await f.network.tick(); await finished(f);
    expect(f.adapter.infer).toHaveBeenCalledOnce(); expect(f.host.storage.messages(f.room.id)).toHaveLength(before + 1);
    expect(f.store.listSettings("service", "partner-network-completions").some(row => (row.value as { status: string }).status === "ready")).toBe(true);
    await f.network.tick(); expect(f.adapter.infer).toHaveBeenCalledOnce();
    const response = await f.foreign.failures(create(contract.ReadPartnerNetworkFailuresRequestSchema, { roomId: f.room.id, joinId: f.joined.joinId, sourceMessageIds: [source.id] }), authority());
    expect(response.executions).toHaveLength(1); expect(response.executions[0]).toMatchObject({ sourceMessageId: source.id, status: "failed", failureCode: "QUOTA_EXCEEDED" });
    const json = (value: unknown) => JSON.stringify(value, (_key, item: unknown) => typeof item === "bigint" ? item.toString() : item);
    expect(json(response)).not.toContain("PRIVATE_PROMPT"); expect(json(f.store.listSettings("service", "partner-network-completions"))).not.toContain("PRIVATE_PROMPT");
    expect((await f.owner.readPartnerNetworkFailures({ roomId: f.room.id, sourceMessageIds: [source.id] })).executions[0]?.id).toBe(response.executions[0]?.id);
  });
  it("reads loaded old-page and Thread failures through the authoritative RPC and clears replaced rounds, tombstones and revoked readers", async () => {
    const f = await fixture(), actor = f.room.members.find(member => member.kind === "partner")!, sources: contract.PartnerNetworkMessage[] = [];
    f.store.setSetting("service", "partner-network.v1:host", `room:${f.room.id}`, { ...f.host.storage.get(f.room.id), singleSpeaker: false });
    const fail = () => { const job = f.host.claim(create(contract.ClaimPartnerNetworkRequestSchema, { roomId: f.room.id, actorId: actor.id }), actor.ownerId).execution!;
      f.host.settle(create(contract.SettlePartnerNetworkRequestSchema, { roomId: f.room.id, executionId: job.id, lease: job.lease, action: "fail", failureCode: "AUTH_REQUIRED" }), actor.ownerId); return job; };
    for (let index = 0; index < 105; index++) { sources.push(f.host.send(create(contract.SendPartnerNetworkRequestSchema, { operationId: `history-${index}`, roomId: f.room.id, text: `Loaded ${index}`, mentions: [actor.id] }), actor.ownerId)); fail(); }
    const root = sources[0]!, thread = f.host.send(create(contract.SendPartnerNetworkRequestSchema, { operationId: "old-thread", roomId: f.room.id, threadRootId: root.id, text: "Old thread input", mentions: [actor.id] }), actor.ownerId); fail();
    const page = (await f.owner.getPartnerNetwork({ roomId: f.room.id })).snapshot!; expect(page.messages.some(message => message.id === root.id)).toBe(false);
    const read = (ids: readonly string[]) => f.foreign.failures(create(contract.ReadPartnerNetworkFailuresRequestSchema, { roomId: f.room.id, joinId: f.joined.joinId, sourceMessageIds: [...ids] }), authority());
    expect((await read([root.id, thread.id])).executions.map(job => job.sourceMessageId).sort()).toEqual([root.id, thread.id].sort());
    await expect(read(sources.slice(0, 101).map(source => source.id))).rejects.toMatchObject({ code: Code.InvalidArgument });
    f.host.manage(create(contract.ManagePartnerNetworkRequestSchema, { operationId: "continue-thread", roomId: f.room.id, expectedRevision: BigInt(f.host.storage.get(f.room.id).revision), action: "continue", value: root.id }), actor.ownerId, true);
    expect((await read([thread.id])).executions).toEqual([]);
    const current = f.host.claim(create(contract.ClaimPartnerNetworkRequestSchema, { roomId: f.room.id, actorId: actor.id }), actor.ownerId).execution!;
    f.host.settle(create(contract.SettlePartnerNetworkRequestSchema, { roomId: f.room.id, executionId: current.id, lease: current.lease, action: "complete", text: "Recovered" }), actor.ownerId);
    expect((await read([thread.id])).executions).toEqual([]);
    f.store.setSetting("service", `partner-network.v1:${f.room.id}`, `message:${root.id}`, { ...f.host.storage.message(f.room.id, root.id), deleted: true });
    expect((await read([root.id, thread.id])).executions).toEqual([]);
    await f.foreign.manage(create(contract.ManagePartnerNetworkRequestSchema, { operationId: "reader-leave", roomId: f.room.id, joinId: f.joined.joinId, expectedRevision: BigInt(f.host.storage.get(f.room.id).revision), action: "leave" }), authority());
    await expect(read([sources[1]!.id])).rejects.toMatchObject({ code: Code.PermissionDenied });
  }, 20_000);
  it("reads only the exact current failed plan step and decision head after retries or plan stop", async () => {
    const f = await fixture(), actor = f.room.members.find(member => member.kind === "partner")!;
    f.store.setSetting("service", "partner-network.v1:host", `room:${f.room.id}`, { ...f.host.storage.get(f.room.id), singleSpeaker: false });
    const source = f.host.send(create(contract.SendPartnerNetworkRequestSchema, { operationId: "planned-source", roomId: f.room.id, text: "Plan this work", forcePlan: true }), actor.ownerId);
    const claim = () => f.host.claim(create(contract.ClaimPartnerNetworkRequestSchema, { roomId: f.room.id, actorId: actor.id }), actor.ownerId).execution!;
    const decision = claim(); f.host.settle(create(contract.SettlePartnerNetworkRequestSchema, { roomId: f.room.id, executionId: decision.id, lease: decision.lease, action: "complete",
      decision: { needsPlan: true, steps: [{ actorId: actor.id, task: "Prepare report" }] } }), actor.ownerId);
    const act = (action: string) => { const plan = f.host.storage.plans.current(f.room.id)!; return f.host.plan(create(contract.PlanPartnerNetworkRequestSchema, { operationId: crypto.randomUUID(), roomId: f.room.id, planId: plan.id, expectedRevision: BigInt(plan.revision), action }), actor.ownerId); };
    const read = async () => (await f.owner.readPartnerNetworkFailures({ roomId: f.room.id, sourceMessageIds: [source.id] })).executions;
    act("start"); const first = claim(); f.host.settle(create(contract.SettlePartnerNetworkRequestSchema, { roomId: f.room.id, executionId: first.id, lease: first.lease, action: "fail", failureCode: "NETWORK_ERROR" }), actor.ownerId);
    expect((await read()).map(job => job.id)).toEqual([first.id]); act("retry"); expect(await read()).toEqual([]);
    const second = claim(); f.host.settle(create(contract.SettlePartnerNetworkRequestSchema, { roomId: f.room.id, executionId: second.id, lease: second.lease, action: "fail", failureCode: "UPSTREAM_OVERLOADED" }), actor.ownerId);
    expect((await read()).map(job => job.id)).toEqual([second.id]); act("stop"); expect(await read()).toEqual([]);
    const failedSource = f.host.send(create(contract.SendPartnerNetworkRequestSchema, { operationId: "decision-failure", roomId: f.room.id, text: "Try a new plan", forcePlan: true }), actor.ownerId), failed = claim();
    f.host.settle(create(contract.SettlePartnerNetworkRequestSchema, { roomId: f.room.id, executionId: failed.id, lease: failed.lease, action: "fail", failureCode: "MODEL_UNAVAILABLE" }), actor.ownerId);
    expect((await f.owner.readPartnerNetworkFailures({ roomId: f.room.id, sourceMessageIds: [failedSource.id] })).executions.map(job => job.id)).toEqual([failed.id]);
    f.host.plan(create(contract.PlanPartnerNetworkRequestSchema, { operationId: "decision-retry", roomId: f.room.id, sourceMessageId: failedSource.id, action: "retry-decision" }), actor.ownerId);
    expect((await f.owner.readPartnerNetworkFailures({ roomId: f.room.id, sourceMessageIds: [failedSource.id] })).executions).toEqual([]);
  });
  it("uses the generated HTTP owner/Home/guest path, keeps public chat images and file text, and never opens a private lane", async () => {
    const f = await fixture(), png = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lN8AAAAASUVORK5CYII=", "base64"));
    const image = await upload(f, png, "image/png", "pixel.png"), text = await upload(f, new TextEncoder().encode("The answer in this document is 42."), "text/plain", "note.txt");
    const source = await f.foreignSend("Read the image and document", [image, text]); await f.network.tick(); await finished(f);
    expect(f.adapter.infer).toHaveBeenCalledTimes(1); const input = f.adapter.infer.mock.calls[0]![0];
    expect(input.system).toContain("Nova"); expect(input.system).toContain("public companion description"); expect(input.user).toContain(source.id);
    expect(input.user).toContain("answer in this document is 42"); expect(input.images?.[0]?.mimeType).toBe("image/png"); expect(Array.from(input.images![0]!.data)).toEqual(Array.from(png));
    expect(`${input.system}${input.user}`).not.toContain("PRIVATE_OWNER_IDENTITY"); expect(f.laneStore.lanes()).toEqual([]);
    expect(f.host.storage.messages(f.room.id).filter(message => message.authorId.startsWith("partner:"))).toHaveLength(1);
    const unauthenticated = createClient(contract.PartnerNetworkService, createConnectTransport({ baseUrl: f.baseUrl, httpVersion: "1.1" }));
    await expect(unauthenticated.listPartnerNetwork({})).rejects.toMatchObject({ code: Code.Unauthenticated });
    expect(f.host.storage.get(f.room.id).members.filter(actor => actor.id === networkHumanId("foreign-home"))).toHaveLength(1);
  });

  it("recovers an accepted join with its original request and sealed credential after an HTTP reply is lost", async () => {
    const f = await fixture(); await f.manage("leave").catch(() => {});
    const invitation = (await f.owner.invitePartnerNetwork({ operationId: "lost-invite", roomId: f.room.id, expectedRevision: BigInt(f.host.storage.get(f.room.id).revision), reusable: false, lifetimeMs: 86400_000n })).invitation;
    let lose = true; const requests: string[] = [], digests: string[] = [];
    const connect = (options: PartnerNetworkRemoteOptions) => { const remote = createPartnerNetworkRemote(options); return { ...remote, client: { ...remote.client,
      acceptPartnerNetwork: async (...args: Parameters<typeof remote.client.acceptPartnerNetwork>) => { requests.push(args[0].operationId!); digests.push(args[0].credentialSha256!); const result = await remote.client.acceptPartnerNetwork(...args); if (lose) { lose = false; throw new ConnectError("reply lost", Code.Unavailable); } return result; } } }; };
    const options = { ...f.foreignOptions, directory: join(f.root, "lost-home"), serverId: "lost-home", connect }, first = new PartnerNetworkHome(options); await first.initialize();
    const request = create(contract.JoinPartnerNetworkRequestSchema, { operationId: "join-same-after-restart", invitation, displayName: "Lost reply" });
    await expect(first.join(request, authority())).rejects.toMatchObject({ code: Code.Unavailable }); expect(first.directory()[0]?.availability).toBe("joining"); await first.close();
    const disk = await readFile(join(options.directory, "memberships.json"), "utf8"); expect(disk).not.toContain(invitation); expect(disk).not.toContain(parsePartnerNetworkInvitation(invitation).secret); expect(disk).not.toContain("joko-conversation-");
    const restarted = new PartnerNetworkHome(options); await restarted.initialize(); cleanups.push(() => restarted.close());
    const recovered = await restarted.join(request, authority()); expect(recovered.availability).toBe("available"); expect(requests).toEqual([request.operationId, request.operationId]); expect(new Set(digests).size).toBe(1);
    expect(f.host.storage.get(f.room.id).members.filter(actor => actor.homeServerId === "lost-home")).toHaveLength(1);
    await expect(restarted.join({ ...request, displayName: "Changed" }, authority())).rejects.toMatchObject({ code: Code.AlreadyExists });
  });

  it("retains an immutable completion across restart and never changes a lost complete reply into fail or repeats inference", async () => {
    const f = await fixture(), settle = f.host.settle.bind(f.host); let lose = true; const actions: string[] = [];
    vi.spyOn(f.host, "settle").mockImplementation((request, actor) => { actions.push(request.action); const value = settle(request, actor); if (request.action === "complete" && lose) { lose = false; throw new ConnectError("reply lost", Code.Unavailable); } return value; });
    await f.foreignSend("Answer once"); await f.network.tick(); await finished(f);
    await vi.waitFor(() => expect(f.store.listSettingsByKeyPrefix("service", "partner-network-completions", "completion:")[0]?.value).toMatchObject({ status: "ready" }));
    await f.network.close();
    const laneStore = new PartnerGroupStore(f.lanePath), lanes = new PartnerGroupSessionRuntime(laneStore, f.profiles, f.store, f.sessions, f.workspaces);
    const home = new PartnerNetworkHome(f.home.options); await home.initialize();
    const recovered = new PartnerNetworkRuntime({ ...f.network.options, home, laneStore, lanes }); f.f.network = recovered;
    await recovered.tick();
    expect(actions.filter(action => action === "fail")).toEqual([]); expect(actions.filter(action => action === "complete")).toHaveLength(2);
    expect(f.store.listSettingsByKeyPrefix("service", "partner-network-completions", "completion:")[0]?.value).toMatchObject({ status: "acknowledged" });
    expect(f.adapter.infer).toHaveBeenCalledTimes(1); expect(f.host.storage.messages(f.room.id).filter(message => message.authorId.startsWith("partner:"))).toHaveLength(1);
  });

  it("withdraws an in-flight public chat lease without publishing the old reply", async () => {
    const f = await fixture(); let answer!: (value: string) => void;
    f.adapter.infer.mockImplementationOnce(() => new Promise<string>(resolve => { answer = resolve; }));
    await f.foreignSend("Wait for permission change"); await f.network.tick(); await vi.waitFor(() => expect(f.adapter.infer).toHaveBeenCalledOnce());
    await f.manage("set-access", f.host.storage.get(f.room.id).members.find(actor => actor.kind === "partner")!.id, "none"); answer("Old unauthorized output");
    await finished(f); await new Promise(resolve => setTimeout(resolve, 50));
    expect(f.host.storage.messages(f.room.id).some(message => message.text === "Old unauthorized output")).toBe(false);
    expect(f.host.storage.executions(f.room.id)[0]?.status).toBe("cancelled");
  });

  it("uses a real private lane for tools, preserves the original tool approval, and rejects approval after owner revocation", async () => {
    const f = await fixture(), actor = f.host.storage.get(f.room.id).members.find(member => member.kind === "partner")!; await f.manage("set-access", actor.id, "tools");
    let captured: AdapterContext | undefined, release!: () => void;
    f.adapter.beforeGroupSend = async context => { captured = context; void context.requestInteraction({ id: "guest-tools-approval", kind: "permission", title: "Execute command", toolName: "command", summary: "Confirm the group command", risk: "low", choices: ["allow_once", "deny_once"] }).catch(() => {});
      await new Promise<void>(resolve => { release = resolve; context.signal.addEventListener("abort", () => resolve(), { once: true }); }); };
    await f.foreignSend("An explicitly authorized tool turn"); await f.network.tick(); await vi.waitFor(() => expect(captured).toBeDefined(), { timeout: 5_000 });
    const authorization = captured!.nativeToolAuthorization!; expect(authorization.required).toBe(true); const revision = authorization.capture();
    expect(f.network.ownerTaskScope(captured!.sessionId)).toBeUndefined();
    await vi.waitFor(() => expect(f.store.getRun(f.store.listQueueItems({ sessionId: captured!.sessionId })[0]!.runId).descriptor.state).toBe("running"));
    const request = { toolName: "Read", input: { path: "notes.txt" }, signal: new AbortController().signal };
    await expect(authorization.review(request)).resolves.toMatchObject({ verdict: "default", authorizationRevision: revision });
    const lane = f.laneStore.lanes()[0]!; expect(f.profiles.getSessionLink(lane.sessionId!)?.partnerId).toBe(f.partner.id);
    expect(f.store.getSession(lane.sessionId!).descriptor.appendSystemPrompt).toContain("PRIVATE_OWNER_IDENTITY");
    expect(f.store.getSession(f.partner.canonicalSessionId!).descriptor.archived).toBe(false);
    await vi.waitFor(() => expect(f.store.listInteractions({ status: "open" })).toHaveLength(1));
    const control = (await f.owner.getPartnerNetworkOwnerControls({ roomId: f.room.id })).controls[0]!, pending = control.interactions[0]!;
    await f.manage("set-access", actor.id, "none"); await expect(authorization.review(request)).resolves.toMatchObject({ verdict: "block" }); expect(() => authorization.assertCurrent(revision)).toThrow();
    expect((await f.owner.getPartnerNetworkOwnerControls({ roomId: f.room.id })).controls).toEqual([]);
    const rejected = await f.owner.respondPartnerNetworkOwnerInteraction({ roomId: f.room.id, executionId: control.executionId, lease: control.lease, interactionId: pending.interactionId, generation: pending.generation, operationId: "revoked-approval", resolution: { decision: { case: "permission", value: { decision: contract.PermissionDecisionKind.ALLOW_ONCE } } } }).then(() => undefined, (error: unknown) => error);
    expect(rejected).toBeInstanceOf(ConnectError); expect([Code.PermissionDenied, Code.FailedPrecondition]).toContain((rejected as ConnectError).code); release();
    await finished(f); expect(f.host.storage.messages(f.room.id).filter(message => message.authorId === actor.id)).toEqual([]);
    expect(f.adapter.infer).not.toHaveBeenCalled();
  });

  it("rejects unsupported or oversized current input before download and makes old over-budget context explicit", async () => {
    const f = await fixture(), unsupported = await upload(f, new Uint8Array([1, 2, 3]), "application/octet-stream", "unsupported.bin"), media = vi.spyOn(f.host, "media");
    const source = await f.foreignSend("Use this file", [unsupported]); await f.network.tick(); await finished(f);
    expect(f.adapter.infer).not.toHaveBeenCalled(); expect(media.mock.calls.some(call => call[0].action === "read")).toBe(false);
    expect(f.host.storage.executions(f.room.id).find(job => job.sourceMessageId === source.id)?.failureCode).toBe("input-unavailable");
    await f.foreignSend("Now just use text"); await f.network.tick(); await finished(f);
    expect(f.adapter.infer.mock.calls.at(-1)?.[0].user).toContain("unavailable-in-turn-budget");
  });
  it("rejects the current total attachment budget before reading any media bytes", async () => {
    const f = await fixture(), media = vi.spyOn(f.host, "media"), files = Array.from({ length: 5 }, (_, index) => ({ id: `media:budget-${index}`, name: `page-${index}.png`, mediaType: "image/png", sizeBytes: 5 * 1024 * 1024 }));
    for (const attachment of files) f.host.storage.saveMedia(f.room.id, { actorId: f.joined.selfId, attachment, complete: true, offset: attachment.sizeBytes });
    const source = await f.foreignSend("Read all images", files.map(attachment => create(contract.PartnerNetworkAttachmentSchema, { ...attachment, sizeBytes: BigInt(attachment.sizeBytes) })));
    await f.network.tick(); await finished(f); expect(media.mock.calls.some(call => call[0].action === "read")).toBe(false); expect(f.adapter.infer).not.toHaveBeenCalled();
    expect(f.host.storage.executions(f.room.id).find(job => job.sourceMessageId === source.id)?.failureCode).toBe("input-unavailable");
  });
  it("exposes pending group approvals and independent-task scope only to the exact active owner execution", async () => {
    const f = await fixture(), actor = f.host.storage.get(f.room.id).members.find(member => member.kind === "partner")!;
    let captured: AdapterContext | undefined, release!: () => void;
    f.adapter.beforeGroupSend = async context => { captured = context; await context.requestInteraction({ id: "owner-group-approval", kind: "permission", title: "Execute command", toolName: "command", summary: "Run the required command", risk: "low", choices: ["allow_once", "deny_once"] });
      await new Promise<void>(resolve => { release = resolve; context.signal.addEventListener("abort", () => resolve(), { once: true }); }); };
    const source = (await f.owner.sendPartnerNetwork({ roomId: f.room.id, operationId: "owner-native", text: "Owner work", mentions: [actor.id] })).message!;
    await f.network.tick(); await vi.waitFor(() => expect(f.store.listInteractions({ status: "open" })).toHaveLength(1));
    const scope = f.network.ownerTaskScope(captured!.sessionId)!; expect(scope).toMatchObject({ roomId: f.room.id, actorId: actor.id, sourceMessageId: source.id, accessRevision: actor.accessRevision.toString() });
    const controls = await f.owner.getPartnerNetworkOwnerControls({ roomId: f.room.id }); expect(controls.controls).toHaveLength(1); const control = controls.controls[0]!, pending = control.interactions[0]!;
    const unauthenticated = createClient(contract.PartnerNetworkService, createConnectTransport({ baseUrl: f.baseUrl, httpVersion: "1.1" }));
    await expect(unauthenticated.getPartnerNetworkOwnerControls({ roomId: f.room.id })).rejects.toMatchObject({ code: Code.Unauthenticated });
    await f.owner.respondPartnerNetworkOwnerInteraction({ roomId: f.room.id, executionId: control.executionId, lease: control.lease, interactionId: pending.interactionId, generation: pending.generation, operationId: "approval-once", resolution: { decision: { case: "permission", value: { decision: contract.PermissionDecisionKind.ALLOW_ONCE } } } });
    await vi.waitFor(() => expect(release).toBeDefined()); expect(f.store.listInteractions({ status: "open" })).toHaveLength(0); release(); await finished(f);
    expect(() => scope.assertCurrent()).toThrow(); expect(f.network.ownerTaskScope(captured!.sessionId)).toBeUndefined();
    await expect(f.owner.respondPartnerNetworkOwnerInteraction({ roomId: f.room.id, executionId: control.executionId, lease: control.lease, interactionId: pending.interactionId, generation: pending.generation, operationId: "approval-once", resolution: { decision: { case: "permission", value: { decision: contract.PermissionDecisionKind.ALLOW_ONCE } } } })).rejects.toMatchObject({ code: Code.FailedPrecondition });
  });

  it("scopes media to exact membership, writes replayed bytes once, and returns only ordinary short-lived download tickets", async () => {
    const f = await fixture(), bytes = new Uint8Array(256 * 1024 + 3).fill(17), attachment = await upload(f, bytes, "application/octet-stream", "shared.bin"), key = { roomId: f.room.id, joinId: f.joined.joinId, mediaId: attachment.id };
    await f.foreign.media(create(contract.MediaPartnerNetworkRequestSchema, { ...key, action: "write", offset: 0n, data: bytes.slice(0, 256 * 1024) }), authority());
    await expect(f.foreign.media(create(contract.MediaPartnerNetworkRequestSchema, { ...key, action: "read" }), authority())).rejects.toMatchObject({ code: Code.PermissionDenied });
    await f.foreignSend("A shared file", [attachment]);
    const read = await f.foreign.media(create(contract.MediaPartnerNetworkRequestSchema, { ...key, action: "read", offset: 256n * 1024n }), authority()); expect(read.data).toEqual(bytes.slice(256 * 1024)); expect(read.complete).toBe(true);
    const ticket = await f.foreign.media(create(contract.MediaPartnerNetworkRequestSchema, { ...key, action: "authorize" }), authority());
    expect(ticket.downloadUrl).toMatch(new RegExp(`^${f.baseUrl}/v1/blobs/download/`)); expect(ticket.downloadUrl).not.toContain("joko-conversation-");
    await f.manage("remove-member", f.joined.selfId); await expect(f.foreign.media(create(contract.MediaPartnerNetworkRequestSchema, { ...key, action: "read" }), authority())).rejects.toMatchObject({ code: Code.PermissionDenied });
    await expect(f.foreign.send(create(contract.SendPartnerNetworkRequestSchema, { roomId: f.room.id, joinId: f.joined.joinId, operationId: "revoked-send", text: "No" }), authority())).rejects.toMatchObject({ code: Code.PermissionDenied });
  });

  it("requires TLS except loopback or explicitly enabled private LAN", () => {
    expect(partnerNetworkOrigin("http://127.0.0.1:4000")).toBe("http://127.0.0.1:4000"); expect(partnerNetworkOrigin("https://example.test")).toBe("https://example.test");
    expect(() => partnerNetworkOrigin("http://example.test", true)).toThrow(); expect(() => partnerNetworkOrigin("http://192.168.1.2")).toThrow(); expect(partnerNetworkOrigin("http://192.168.1.2", true)).toBe("http://192.168.1.2");
  });
  it("executes a genuine persisted member join only once and does not continue a welcome as an ordinary request", async () => {
    const f = await fixture(); await f.network.tick(); await finished(f);
    expect(f.adapter.infer).toHaveBeenCalledOnce(); expect(f.adapter.infer.mock.calls[0]![0].user).toContain("real human member-joined event");
    const event = f.host.storage.messages(f.room.id).find(message => message.kind === "member-joined")!;
    expect(event.eventActorId).toBe(f.joined.selfId); expect(f.host.storage.executions(f.room.id).filter(job => job.sourceMessageId === event.id)).toHaveLength(1);
    await f.network.tick(); expect(f.adapter.infer).toHaveBeenCalledOnce();
    await expect(f.manage("continue")).rejects.toMatchObject({ code: Code.NotFound });
  });
  it("projects live thread previews and shared replies from the same authority without waking another round", async () => {
    const f = await fixture(), root = await f.foreignSend("Start a topic");
    const reply = await f.foreign.send(create(contract.SendPartnerNetworkRequestSchema, { operationId: "thread-reply", roomId: f.room.id, joinId: f.joined.joinId, text: "The original reply", threadRootId: root.id }), authority());
    const before = f.host.storage.executions(f.room.id).length;
    await f.foreign.manage(create(contract.ManagePartnerNetworkRequestSchema, { operationId: "share-reply", roomId: f.room.id, joinId: f.joined.joinId, action: "share-thread", value: reply.id }), authority());
    expect(f.host.storage.executions(f.room.id)).toHaveLength(before);
    const read = await f.foreign.snapshot(create(contract.GetPartnerNetworkRequestSchema, { roomId: f.room.id, joinId: f.joined.joinId }), authority());
    expect(read.messages.find(message => message.id === root.id)?.threadPreview).toMatchObject({ latestReplyId: reply.id, replyCount: 1n, text: "The original reply" });
    expect(read.messages.find(message => message.kind === "thread-share")?.sharedReply?.text).toBe("The original reply");
    f.store.setSetting("service", `partner-network.v1:${f.room.id}`, `message:${reply.id}`, { ...f.host.storage.message(f.room.id, reply.id), deleted: true });
    const refreshed = await f.foreign.snapshot(create(contract.GetPartnerNetworkRequestSchema, { roomId: f.room.id, joinId: f.joined.joinId }), authority());
    expect(refreshed.messages.find(message => message.kind === "thread-share")?.sharedReply).toBeUndefined(); expect(refreshed.messages.find(message => message.id === root.id)?.threadPreview).toBeUndefined();
    await f.manage("remove-member", f.joined.selfId);
    await expect(f.foreign.manage(create(contract.ManagePartnerNetworkRequestSchema, { operationId: "share-reply", roomId: f.room.id, joinId: f.joined.joinId, action: "share-thread", value: reply.id }), authority())).rejects.toMatchObject({ code: Code.PermissionDenied });
  });
  it("keeps private task navigation IDs on the owner read surface and outside public chat prompts", async () => {
    const f = await fixture(), actor = f.host.storage.get(f.room.id).members.find(member => member.kind === "partner")!;
    f.host.publish(create(contract.PublishPartnerNetworkActorRequestSchema, { roomId: f.room.id, actorId: actor.id, operationId: "task-result", text: "A complete public result", task: {
      taskId: "independent-task", homeServerId: f.host.options.serverId, ownerId: f.host.selfId, actorId: actor.id, title: "Independent work", status: "completed", revision: 1n, execution: 1n, sessionId: "PRIVATE_NATIVE_TASK_NAVIGATION_ID" } }), f.host.selfId);
    const owner = await f.owner.getPartnerNetwork({ roomId: f.room.id }), foreign = await f.foreign.snapshot(create(contract.GetPartnerNetworkRequestSchema, { roomId: f.room.id, joinId: f.joined.joinId }), authority());
    expect(owner.snapshot!.messages.find(message => message.task)?.task?.sessionId).toBe("PRIVATE_NATIVE_TASK_NAVIGATION_ID"); expect(foreign.messages.find(message => message.task)?.task?.sessionId).toBe("");
    await f.foreignSend("Use the public result"); await f.network.tick(); await finished(f); const prompt = f.adapter.infer.mock.calls[0]![0].user;
    expect(prompt).toContain("A complete public result"); expect(prompt).not.toContain("PRIVATE_NATIVE_TASK_NAVIGATION_ID");
  });
  it("uses the managed model route for the same isolated public chat with native image input", async () => {
    const f = await fixture(), route = f.partner.capabilities.modelChain[0]!;
    vi.spyOn(f.network.options.routes, "resolve").mockReturnValue({ ...route, generationId: "managed-generation", api: "openai-completions", baseUrl: "https://managed-model.test/v1", headers: {}, supportsImages: true });
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: "Managed public answer" } }] }), { headers: { "content-type": "application/json" } }));
    const image = await upload(f, new Uint8Array([137, 80, 78, 71]), "image/png", "image.png"); await f.foreignSend("Use the managed model", [image]); await f.network.tick(); await finished(f);
    expect(fetch).toHaveBeenCalledOnce(); const body = JSON.parse(fetch.mock.calls[0]![1]!.body as string) as Record<string, unknown>;
    expect(body["tools"]).toBeUndefined(); expect(JSON.stringify(body)).toContain("data:image/png;base64,"); expect(JSON.stringify(body)).not.toContain("PRIVATE_OWNER_IDENTITY");
    expect(f.laneStore.lanes()).toEqual([]); expect(f.adapter.infer).not.toHaveBeenCalled(); expect(f.host.storage.messages(f.room.id).some(message => message.text === "Managed public answer")).toBe(true);
  });
});
