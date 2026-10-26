import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import { createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as contract from "@joko/contracts";
import type { AdapterContext, NativeTextInferenceInput, PromptInput } from "@joko/core";
import { OperationalStore, PartnerGroupStore, PartnerNetworkStore, PartnerStore } from "@joko/store";
import { FakeBackendAdapter, PI_LIKE_PROFILE } from "@joko/testkit";
import { ArtifactStore } from "./artifact-store.js";
import { OperationalArtifactRepository } from "./artifact-repository.js";
import { CredentialVault } from "./credential-vault.js";
import { PartnerNetworkHost } from "./partner-network-host.js";
import { PartnerNetworkHome } from "./partner-network-home.js";
import { PartnerNetworkRuntime } from "./partner-network-runtime.js";
import { PartnerNetworkPlanWorkspaces } from "./partner-network-plan-workspaces.js";
import { PartnerGroupWorkspaces } from "./partner-group-workspaces.js";
import { PartnerGroupSessionRuntime } from "./partner-group-runtime.js";
import { PartnerManager } from "./partner-manager.js";
import { SessionHost } from "./session-host.js";
import { ConnectionManager } from "./connection-manager.js";
import { createPublicServer } from "./server.js";
import type { OrchestratorApplication } from "./application.js";
import { createIdentity } from "@jokoagent/linkspan-noise";
import { attachTestLinkspanTransport } from "./test-linkspan-transport.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.restoreAllMocks(); });
const profile = { ...PI_LIKE_PROFILE, capabilities: [...PI_LIKE_PROFILE.capabilities.map(capability => capability.key === "permission.modes" ? { ...capability, options: ["ask", "auto", "bypassPermissions"] } : capability),
  { key: "input.file", supported: true }] };
class PlanAdapter extends FakeBackendAdapter {
  readonly inputs: { input: PromptInput; context: AdapterContext }[] = [];
  readonly infer = vi.fn(async (_input: NativeTextInferenceInput) => "Public review completed.");
  beforeSend?: (context: AdapterContext) => Promise<void>;
  constructor(readonly profiles: PartnerStore) { super(profile); }
  inferNativeText(input: NativeTextInferenceInput) { return this.infer(input); }
  override async send(input: PromptInput, context: AdapterContext) {
    if (this.profiles.getSessionLink(context.sessionId)?.role === "group") {
      this.inputs.push({ input, context });
      if (this.beforeSend) await this.beforeSend(context);
      await writeFile(join(context.target.workspaceRoot, "result.txt"), "ACTUAL_DELIVERED_PLAN_RESULT");
      return super.send({ ...input, text: "Plan step completed." }, context);
    }
    return super.send(input, context);
  }
}
const auth = () => ({ deviceId: "foreign-owner", signal: new AbortController().signal, assertCurrent() {} });
async function fixture() {
  const endpointIdentity = await createIdentity();
  const root = await mkdtemp(join(tmpdir(), "joko-network-plan-")), store = new OperationalStore(join(root, "operations.db")), profiles = new PartnerStore(join(root, "profiles.db"));
  const artifacts = new ArtifactStore({ rootDirectory: join(root, "artifacts"), repository: new OperationalArtifactRepository(store), ingestRoots: [root] }); await artifacts.initialize();
  const vault = await CredentialVault.open(join(root, "master.key")), adapter = new PlanAdapter(profiles), laneStore = new PartnerGroupStore(join(root, "lanes.db"));
  const workspaces = { register: vi.fn(async (input: Parameters<import("./workspace-service.js").WorkspaceService["register"]>[0]) => input), unregister: vi.fn() };
  let lanes: PartnerGroupSessionRuntime;
  const sessions = new SessionHost(store, artifacts, [adapter], { partnerSessionPaused: id => profiles.isPartnerSessionPaused(id) || lanes?.isHeld(id) === true,
    partnerSessionRetiring: id => profiles.isPartnerSessionRetiring(id) || lanes?.isRetiring(id) === true, partnerTargetRetired: id => profiles.isPartnerTargetRetired(id) });
  lanes = new PartnerGroupSessionRuntime(laneStore, profiles, store, sessions, workspaces); await sessions.initialize();
  const partners = new PartnerManager({ store: profiles, operationalStore: store, sessionHost: sessions, workspaceService: workspaces, homesRoot: join(root, "homes"), ownedIndependentSessions: id => lanes.ownedSessions(id) });
  const members = [];
  for (const displayName of ["Writer", "Reviewer"]) members.push(await partners.createPartner({ requestId: `network-plan-create-${displayName}`, expectedDirectoryRevision: profiles.directoryState().revision,
    displayName, avatar: "orbit", templateId: "general", identitySource: `PRIVATE_${displayName}_IDENTITY`, description: `Public ${displayName}`, usesDirectoryDefaults: false,
    capabilities: { modelChain: [{ backendId: profile.id, providerId: profile.models[0]!.providerId, modelId: profile.models[0]!.modelId, effort: "medium", fastMode: false }], permissionMode: "ask", planMode: false } }));
  expect(members.map(member => member.initializationState)).toEqual(["ready", "ready"]);
  const partner = (id: string) => { const p = profiles.getPartner(id); return { id, name: p.displayName, description: p.description }; };
  const host = new PartnerNetworkHost({ storage: new PartnerNetworkStore(store), serverId: "authority", origin: "http://127.0.0.1", endpointPublicKey: endpointIdentity.publicKey, mediaDirectory: join(root, "media"), partner, artifacts });
  const home = new PartnerNetworkHome({ directory: join(root, "home"), serverId: "authority", vault, partner }); await home.initialize();
  const work = new PartnerGroupWorkspaces(store, root); await work.initialize();
  const planWorkspaces = new PartnerNetworkPlanWorkspaces(store, laneStore, work), decidePlan = vi.fn(async (input: import("./partner-group-division.js").PlanDecisionInput) => ({ needsPlan: true as const,
    steps: [{ partnerId: input.members[0]!.partnerId, task: "Write result" }, { partnerId: input.members[1]!.partnerId, task: "Review result" }] }));
  const network = new PartnerNetworkRuntime({ host, home, profiles, store, laneStore, lanes, routes: { list: () => [], resolve: () => undefined }, adapters: () => [adapter], artifacts, planWorkspaces, decidePlan });
  sessions.setExtensionNativeToolAuthorization(id => network.nativeToolAuthorization(id));
  const connections = new ConnectionManager(store), pairing = connections.issuePairing("Owner"), paired = connections.completePairing({ challengeId: pairing.id, code: pairing.code, connectionName: "Owner" });
  const config = { publicOrigin: host.options.origin, allowInsecureLoopback: true, allowInsecureLan: false, corsOrigins: [], webDirectory: join(root, "no-web"), dataDirectory: root };
  const server = await createPublicServer({ serverId: "authority", config, store, connections, artifacts, blobTransfers: {}, artifactRepository: {}, workspaces, workspaceChanges: {}, scheduler: {},
    adapters: [adapter], browserActivity: [], sessionHost: sessions, partners, partnerNetwork: network } as unknown as OrchestratorApplication);
  server.log.level = "silent"; const origin = await server.listen({ host: "127.0.0.1", port: 0 }); host.options.origin = origin; config.publicOrigin = origin;
  const retireTransport = attachTestLinkspanTransport(server.server, origin, endpointIdentity);
  const owner = createClient(contract.PartnerNetworkService, createConnectTransport({ baseUrl: origin, httpVersion: "1.1", interceptors: [next => request => { request.header.set("authorization", `Bearer ${paired.authKey}`); return next(request); }] }));
  const room = (await owner.createPartnerNetwork({ operationId: "create-room", name: "Plan room", displayName: "Owner", partnerIds: members.map(member => member.id) })).room!;
  cleanups.push(async () => { await retireTransport(); await server.close(); await network.close(); work.dispose(); await sessions.dispose(); profiles.close(); store.close(); await rm(root, { recursive: true, force: true }); });
  const current = () => host.storage.plans.current(room.id)!;
  const act = (action: string) => owner.planPartnerNetwork({ roomId: room.id, operationId: crypto.randomUUID(), planId: current().id, expectedRevision: BigInt(current().revision), action });
  const propose = async () => { await owner.sendPartnerNetwork({ roomId: room.id, operationId: "original-request", text: "Produce the deliverable and review it", forcePlan: true }); await network.tick();
    await vi.waitFor(() => expect(current()?.status).toBe("proposed")); return current(); };
  return { root, store, profiles, artifacts, adapter, lanes, laneStore, sessions, network, host, home, owner, room, members, current, act, propose, decidePlan, vault, partner, planWorkspaces };
}

describe("network work-plan integration", () => {
  it("rejects delayed tools and owner tasks from a previous actor or previous execution while reusing the correct plan session", async () => {
    const f = await fixture(); f.decidePlan.mockImplementationOnce(async input => ({ needsPlan: true,
      steps: [{ partnerId: input.members[0]!.partnerId, task: "Write" }, { partnerId: input.members[1]!.partnerId, task: "Review" }, { partnerId: input.members[0]!.partnerId, task: "Revise" }] }));
    let first: AdapterContext | undefined, revision: string | undefined;
    f.adapter.beforeSend = async context => {
      if (!first) { first = context; revision = context.nativeToolAuthorization!.capture(); }
      else {
        expect(() => first!.nativeToolAuthorization!.assertCurrent(revision!)).toThrow();
        if (context.sessionId !== first.sessionId) {
          expect(f.network.ownerTaskScope(first.sessionId)).toBeUndefined();
          expect(() => f.network.nativeToolAuthorization(first!.sessionId)!.capture()).toThrow();
        }
        expect(f.network.ownerTaskScope(context.sessionId)?.profile.id).toBe(f.profiles.getSessionLink(context.sessionId)?.partnerId);
      }
    };
    const plan = await f.propose(); await f.act("start"); await f.network.tick(); await vi.waitFor(() => expect(f.current().status).toBe("waiting"), { timeout: 8_000 });
    await f.act("continue"); await f.network.tick(); await vi.waitFor(() => expect(f.current().currentStep === 1 && f.current().status === "waiting").toBe(true), { timeout: 8_000 });
    await f.act("continue"); await f.network.tick(); await vi.waitFor(() => expect(f.host.storage.plans.get(f.room.id, plan.id).status).toBe("completed"), { timeout: 8_000 });
    expect(f.adapter.inputs).toHaveLength(3); expect(f.adapter.inputs[2]?.context.sessionId).toBe(first!.sessionId);
  }, 30_000);
  it("keeps one exact Git worktree for every local member of an approved plan and retains it when the project setting changes", async () => {
    const project = await mkdtemp(join(tmpdir(), "joko-network-plan-project-")); cleanups.push(() => rm(project, { recursive: true, force: true }));
    const git = (args: string[], cwd = project) => promisify(execFile)("git", args, { cwd, windowsHide: true });
    await git(["init"]); await writeFile(join(project, "initial.txt"), "Original project"); await git(["add", "."]);
    await git(["-c", "user.name=Work Plan Test", "-c", "user.email=plan@invalid.example", "commit", "-m", "Initial"]);
    const f = await fixture();
    expect((await f.owner.configurePartnerNetworkProject({ roomId: f.room.id, replace: true, directory: project })).directory).toContain("joko-network-plan-project-");
    await f.propose(); await f.act("start"); await f.network.tick(); await vi.waitFor(() => expect(f.current().status).toBe("waiting"), { timeout: 8_000 });
    const location = f.adapter.inputs[0]!.context.target.workspaceRoot; expect(location).not.toBe(project);
    await f.owner.configurePartnerNetworkProject({ roomId: f.room.id, replace: true, directory: "" });
    const prepare = vi.spyOn(f.planWorkspaces, "prepare"), ensure = vi.spyOn(f.lanes, "ensureLane");
    await f.act("continue"); await f.network.tick(); await vi.waitFor(() => expect(f.host.storage.plans.list(f.room.id).at(-1)?.status).not.toBe("running"), { timeout: 8_000 });
    for (const result of [...prepare.mock.results, ...ensure.mock.results]) if (result.type === "return") await result.value;
    expect({ status: f.host.storage.plans.list(f.room.id).at(-1)?.status, failures: f.host.storage.plans.list(f.room.id).at(-1)?.steps.map(step => step.failureCode), nativeCalls: f.adapter.inputs.length,
      prepareCalls: prepare.mock.calls.length, ensureCalls: ensure.mock.calls.length })
      .toEqual({ status: "completed", failures: ["", ""], nativeCalls: 2, prepareCalls: 1, ensureCalls: 1 });
    expect(f.adapter.inputs).toHaveLength(2); expect(f.adapter.inputs[1]?.context.target.workspaceRoot).toBe(location);
    expect(f.adapter.inputs[1]?.context.sessionId).not.toBe(f.adapter.inputs[0]?.context.sessionId);
    expect((await git(["status", "--porcelain"])).stdout).toBe(""); expect(await readFile(join(location, "result.txt"), "utf8")).toBe("ACTUAL_DELIVERED_PLAN_RESULT");
  }, 30_000);
  it("uses the generated approval action, a real isolated work folder and byte handoff, then runs a chat-only step without opening the existing private plan lane", async () => {
    const f = await fixture(); const plan = await f.propose(); expect(f.adapter.inputs).toEqual([]); expect(f.adapter.infer).not.toHaveBeenCalled();
    await f.act("start"); await f.network.tick(); await vi.waitFor(() => expect(f.current().status).toBe("waiting"), { timeout: 8_000 });
    expect(f.adapter.inputs).toHaveLength(1); const first = f.adapter.inputs[0]!, corePlan = f.laneStore.getPlan(f.laneStore.lanes()[0]!.planId!);
    expect(first.context.target.workspaceRoot).toBe(corePlan.workDir); expect(first.context.target.workspaceRoot).not.toBe(f.profiles.getPartner(f.members[0]!.id).homeTargetId);
    const handoff = f.host.storage.message(f.room.id, f.current().steps[0]!.resultMessageId); expect(handoff.attachments).toHaveLength(1);
    expect(handoff.attachments[0]?.name).toBe("result.txt"); expect(await readFile(join(corePlan.workDir!, "result.txt"), "utf8")).toBe("ACTUAL_DELIVERED_PLAN_RESULT");
    const invitation = (await f.owner.invitePartnerNetwork({ roomId: f.room.id, operationId: "invite", expectedRevision: BigInt(f.host.storage.get(f.room.id).revision), lifetimeMs: 60_000n })).invitation;
    const foreign = new PartnerNetworkHome({ directory: join(f.root, "foreign"), serverId: "foreign", vault: f.vault, partner: f.partner }); await foreign.initialize(); cleanups.push(() => foreign.close());
    const joined = await foreign.join(create(contract.JoinPartnerNetworkRequestSchema, { invitation, operationId: "join", displayName: "Guest" }), auth());
    await foreign.plan(create(contract.PlanPartnerNetworkRequestSchema, { roomId: f.room.id, joinId: joined.joinId, operationId: "continue", action: "continue", planId: plan.id,
      expectedRevision: BigInt(f.current().revision) }), auth());
    await f.network.tick(); await vi.waitFor(() => expect(f.host.storage.plans.get(f.room.id, plan.id).status).toBe("completed"), { timeout: 8_000 });
    expect(f.adapter.inputs).toHaveLength(1); expect(f.adapter.infer).toHaveBeenCalledOnce(); const inferred = f.adapter.infer.mock.calls[0]![0];
    expect(inferred.user).toContain("ACTUAL_DELIVERED_PLAN_RESULT"); expect(inferred.user).toContain("Write result");
    expect(`${inferred.system}${inferred.user}`).not.toContain("PRIVATE_"); expect(`${inferred.system}${inferred.user}`).not.toContain(corePlan.workDir);
    expect(f.laneStore.lanes()).toHaveLength(1); expect(JSON.stringify(f.host.storage.plans.get(f.room.id, plan.id))).not.toContain(f.root);
  }, 30_000);

  it("finishes running notes in the same hidden session and publishes one final handoff with all produced files", async () => {
    const f = await fixture(); await f.propose(); let release!: () => void;
    f.adapter.beforeSend = async () => { if (f.adapter.inputs.length === 1) await new Promise<void>(resolve => { release = resolve; }); };
    await f.act("start"); await f.network.tick(); await vi.waitFor(() => expect(release).toBeDefined(), { timeout: 8_000 });
    const note = await f.owner.sendPartnerNetwork({ roomId: f.room.id, operationId: "running-note", text: "Include this additional requirement" }); release();
    await vi.waitFor(() => expect(f.current().status).toBe("waiting"), { timeout: 8_000 }); expect(f.adapter.inputs).toHaveLength(2);
    expect(f.adapter.inputs[1]?.context.sessionId).toBe(f.adapter.inputs[0]?.context.sessionId); expect(f.adapter.inputs[1]?.input.text).toContain("Include this additional requirement");
    expect(f.current().noteMessageIds).toEqual([note.message!.id]);
    const handoffs = f.host.storage.messages(f.room.id).filter(message => message.planId === f.current().id && message.kind !== "plan");
    expect(handoffs).toHaveLength(1); expect(handoffs[0]?.attachments[0]?.name).toBe("result.txt");
    const receipts = f.store.listSettingsByKeyPrefix("service", "partner-network-completions", "completion:");
    expect(receipts.filter(row => (row.value as { request: string }).request.includes("completionId"))).toHaveLength(3);
    expect(receipts.every(row => (row.value as { status: string }).status === "acknowledged")).toBe(true);
  }, 30_000);
});
