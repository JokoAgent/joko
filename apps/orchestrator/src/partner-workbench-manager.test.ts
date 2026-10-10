import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NativeSessionBinding, NativeSessionCatalogEntry, NativeSessionCatalogResult, NativeSessionPreview } from "@joko/core";
import { OperationalStore, PartnerStore, PartnerWorkbenchStore } from "@joko/store";
import { FakeBackendAdapter, PI_LIKE_PROFILE } from "@joko/testkit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, createClient, type HandlerContext } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import * as contract from "@joko/contracts";
import { ArtifactStore } from "./artifact-store.js";
import { OperationalArtifactRepository } from "./artifact-repository.js";
import { PartnerManager } from "./partner-manager.js";
import { PartnerWorkbenchManager, type PartnerWorkbenchStateView } from "./partner-workbench-manager.js";
import { PartnerWorkbenchToolProvider } from "./partner-workbench-tool-provider.js";
import { createPartnerWorkbenchConnectMethods } from "./partner-workbench-connect-service.js";
import { SessionHost } from "./session-host.js";
import { ConnectionManager } from "./connection-manager.js";
import { createPublicServer } from "./server.js";
import type { OrchestratorApplication } from "./application.js";
import type { BridgeToolCallContext } from "./mcp-router.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const PROFILE = { ...PI_LIKE_PROFILE, capabilities: [...PI_LIKE_PROFILE.capabilities.map((capability) => capability.key === "permission.modes"
  ? { key: "permission.modes", supported: true, options: ["ask", "auto", "bypassPermissions"] } : capability), { key: "permission.change", supported: true },
  { key: "session.preview", supported: true }, { key: "session.catalog", supported: true }] } as const;
class CatalogAdapter extends FakeBackendAdapter {
  entries: NativeSessionCatalogEntry[] = [];
  readonly bind = vi.fn();
  readonly preview = vi.fn();
  materialization: "present" | "absent" | "unknown" = "present";
  failAfterClaim = false;
  previewGate?: Promise<void>;
  async scanNativeSessionCatalog(): Promise<NativeSessionCatalogResult> { return { entries: this.entries, rejectedCount: 0 }; }
  async readNativeSessionPreview(_entry: NativeSessionCatalogEntry): Promise<NativeSessionPreview> {
    this.preview(); await this.previewGate;
    return { messages: [{ role: "user", text: "Original project purpose", at: 1 }, { role: "assistant", text: "Recent source answer", at: 2 }], truncated: false };
  }
  async bindCatalogSession(entry: NativeSessionCatalogEntry, generation: number, claim: (input: { readonly binding: NativeSessionBinding; readonly recoveryReference: string }) => Promise<void>): Promise<NativeSessionBinding> {
    this.bind(); const binding = { opaqueRef: entry.nativeReference, nativeSessionId: entry.nativeSessionId!, generation };
    await claim({ binding, recoveryReference: entry.nativeReference });
    if (this.failAfterClaim) throw new Error("Native acknowledgement unavailable");
    return binding;
  }
  async inspectCatalogSessionMaterialization(): Promise<"present" | "absent" | "unknown"> { return this.materialization; }
}

describe("Partner workbench service and Queue ownership", () => {
  it("delivers a project handover through production HTTP, authenticated contracts, SQLite and the canonical user Queue", async () => {
    const f = await fixture(); const connections = new ConnectionManager(f.store);
    const challenge = connections.issuePairing("Workbench observer");
    const paired = connections.completePairing({ challengeId: challenge.id, code: challenge.code, connectionName: "Workbench observer" });
    const server = await createPublicServer({ config: { publicOrigin: "http://127.0.0.1", allowInsecureLoopback: true, allowInsecureLan: false, corsOrigins: [], webDirectory: join(f.root, "no-web-build"), dataDirectory: f.managed },
      store: f.store, connections, artifacts: {}, blobTransfers: {}, artifactRepository: {}, workspaces: f.workspace, workspaceChanges: {}, scheduler: {},
      adapters: [f.adapter], browserActivity: [], sessionHost: f.host, partners: f.partners, partnerWorkbenches: f.workbench
    } as unknown as OrchestratorApplication);
    server.log.level = "silent";
    try {
      const baseUrl = await server.listen({ host: "127.0.0.1", port: 0 });
      const transport = createConnectTransport({ baseUrl, httpVersion: "1.1", defaultTimeoutMs: 10_000,
        interceptors: [next => request => { request.header.set("authorization", `Bearer ${paired.authKey}`); return next(request); }] });
      const client = createClient(contract.PartnerService, transport);
      const initial = (await client.getPartnerWorkbench({ partnerId: f.partner.id })).workbench!;
      const handed = (await client.addPartnerWorkbenchProject({ owner: initial.owner, expectedRevision: initial.revision, path: f.project })).workbench!;
      expect(handed.projects).toMatchObject([{ path: f.project, exists: true }]);
      expect(f.host.extraDirectories.listForTarget(f.partner.homeTargetId)).toMatchObject([{ path: f.project }]);
      expect(f.store.listSessions()).toHaveLength(1);
      const canonical = f.store.getSession(f.partner.canonicalSessionId!).descriptor;
      const response = await createClient(contract.OperationService, transport).submitOperation({ operationId: "workbench-human-handover", connectionId: paired.connection.id,
        mutation: { preconditions: [{ entity: { kind: contract.EntityKind.SESSION, id: canonical.id }, expectedGeneration: BigInt(canonical.binding.generation) }],
          payload: { case: "sendInput", value: { sessionId: canonical.id, input: { parts: [{ content: { case: "text", value: `Please take over ongoing work in ${f.project}.` } }] }, deliveryMode: contract.QueueDeliveryMode.PROMPT } } } });
      expect(response.operation?.state).toBe(contract.OperationState.SUCCEEDED);
      const queue = f.store.listQueueItems({ sessionId: canonical.id });
      expect(queue).toHaveLength(1); expect(f.store.getRun(queue[0]!.runId).descriptor.source).toBe("user");
      expect(f.store.getOperation("workbench-human-handover")).toMatchObject({ status: "completed", connectionId: paired.connection.id });
      const detail = await client.getPartnerWorkbench({ partnerId: f.partner.id });
      expect(detail.workbench?.owner?.sessionId).toBe(canonical.id);
      await client.removePartnerWorkbenchProject({ owner: handed.owner, expectedRevision: handed.revision, path: f.project });
      expect(f.host.extraDirectories.listForTarget(f.partner.homeTargetId)).toEqual([]);
      expect(f.store.listQueueItems({ sessionId: canonical.id })).toHaveLength(1);
      const unauthenticated = createClient(contract.PartnerService, createConnectTransport({ baseUrl, httpVersion: "1.1" }));
      await expect(unauthenticated.getPartnerWorkbench({ partnerId: f.partner.id })).rejects.toMatchObject({ code: Code.Unauthenticated });
    } finally { await server.close(); }
  });

  it("authenticates both sides of generated reads and maps project CAS, detail and reference boundaries", async () => {
    const f = await fixture(); const authenticate = vi.fn(() => ({ id: "owner" }));
    const methods = createPartnerWorkbenchConnectMethods(f.workbench, authenticate); const context = {} as HandlerContext;
    const initial = (await methods.getPartnerWorkbench(create(contract.GetPartnerWorkbenchRequestSchema, { partnerId: f.partner.id }), context)).workbench!;
    const added = await methods.addPartnerWorkbenchProject(create(contract.AddPartnerWorkbenchProjectRequestSchema, { owner: initial.owner, expectedRevision: initial.revision, path: f.project }), context);
    expect(added.acceptedProject).toBe(f.project);
    await expect(methods.removePartnerWorkbenchProject(create(contract.RemovePartnerWorkbenchProjectRequestSchema, { owner: initial.owner, expectedRevision: initial.revision, path: f.project }), context)).rejects.toMatchObject({ code: Code.Aborted });
    const judged = (await methods.setPartnerWorkbenchJudgment(create(contract.SetPartnerWorkbenchJudgmentRequestSchema, { owner: added.workbench!.owner, expectedRevision: added.workbench!.revision,
      judgment: { taskId: "item:idea", project: f.project, title: "Idea", verdict: contract.PartnerWorkbenchVerdict.IDEA, next: "Review" } }), context)).workbench!;
    expect((await methods.getPartnerWorkbenchDetail(create(contract.GetPartnerWorkbenchDetailRequestSchema, { owner: judged.owner, taskId: "item:idea" }), context)).detail?.task).toMatchObject({ kind: contract.PartnerWorkbenchTaskKind.ITEM, group: contract.PartnerWorkbenchGroup.TODO });
    writeFileSync(join(f.project, "README.md"), "Project context");
    expect(await methods.readPartnerWorkbenchDocument(create(contract.ReadPartnerWorkbenchDocumentRequestSchema, { owner: judged.owner, path: join(f.project, "README.md") }), context)).toMatchObject({ text: "Project context", truncated: false });
    expect(await methods.resolvePartnerWorkbenchReference(create(contract.ResolvePartnerWorkbenchReferenceRequestSchema, { owner: judged.owner, ref: join(f.project, "README.md") }), context)).toMatchObject({ kind: "file", relativePath: "README.md" });
    expect((await methods.removePartnerWorkbenchProject(create(contract.RemovePartnerWorkbenchProjectRequestSchema, { owner: judged.owner, expectedRevision: judged.revision, path: f.project }), context)).workbench).toMatchObject({ projects: [], judgments: [{ taskId: "item:idea" }] });
    await expect(methods.getPartnerWorkbenchDetail(create(contract.GetPartnerWorkbenchDetailRequestSchema, { owner: { ...judged.owner!, sessionGeneration: 0n }, taskId: "item:idea" }), context)).rejects.toMatchObject({ code: Code.InvalidArgument });
    authenticate.mockClear(); authenticate.mockImplementationOnce(() => ({ id: "owner" })).mockImplementationOnce(() => { throw new ConnectError("Revoked", Code.Unauthenticated); });
    await expect(methods.getPartnerWorkbench(create(contract.GetPartnerWorkbenchRequestSchema, { partnerId: f.partner.id }), context)).rejects.toMatchObject({ code: Code.Unauthenticated });
    expect(authenticate).toHaveBeenCalledTimes(2);
  });

  it("hands over an existing project, derives its runtime grant and withdraws only its workbench projection", async () => {
    const f = await fixture(); const initial = await f.workbench.readState(f.partner.id);
    await expect(f.workbench.addProject(initial.owner, initial.state.revision, f.home)).rejects.toMatchObject({ code: "PROJECT_PATH_INVALID" });
    const added = await f.workbench.addProject(initial.owner, initial.state.revision, f.project);
    expect(added.acceptedProject).toBe(f.project);
    let view: PartnerWorkbenchStateView = added;
    expect(f.host.extraDirectories.listForTarget(f.partner.homeTargetId)).toMatchObject([{ path: f.project, access: "read_write" }]);
    view = await f.workbench.setJudgment(view.owner, view.state.revision, { taskId: "item:proposal", project: f.project, title: "Proposal", verdict: "idea", next: "Review this" });
    writeFileSync(join(f.project, "README.md"), "Project context");
    expect(await f.workbench.readProjectFile(view.owner, join(f.project, "README.md"))).toMatchObject({ text: "Project context", truncated: false });
    view = await f.workbench.removeProject(view.owner, view.state.revision, f.project);
    expect(view.tasks).toEqual([]); expect(view.state.judgments).toHaveLength(1);
    expect(f.host.extraDirectories.listForTarget(f.partner.homeTargetId)).toEqual([]);
    await expect(f.workbench.readProjectFile(view.owner, join(f.project, "README.md"))).rejects.toMatchObject({ code: "WORKBENCH_INVALID" });
    expect(f.workspace.unregister).toHaveBeenCalled();
    await expect(f.workbench.addProject({ ...view.owner, sessionGeneration: view.owner.sessionGeneration + 1 }, view.state.revision, f.project)).rejects.toMatchObject({ code: "WORKBENCH_OWNER_CHANGED" });
  });

  it("creates one owned background task for an item and records its actual Queue result before removing the judgment", async () => {
    const f = await fixture(); let view: PartnerWorkbenchStateView = await grant(f);
    view = await f.workbench.setJudgment(view.owner, view.state.revision, { taskId: "item:proposal", project: f.project, title: "Proposal", verdict: "idea", next: "Write the proposal" });
    const [first, replay] = await Promise.all([f.workbench.continueTask(view.owner, "item:proposal", "Write a draft", "background-effect"), f.workbench.continueTask(view.owner, "item:proposal", "Write a draft", "background-effect")]);
    expect(replay).toEqual(first);
    expect(f.store.listQueueItems({ sessionId: first.sessionId })).toHaveLength(1);
    expect(f.store.getRun(first.runId).descriptor.source).toBe("system");
    const after = await f.workbench.readState(f.partner.id);
    expect(after.state.judgments).toEqual([]);
    expect(after.tasks.find((task) => task.sessionId === first.sessionId)).toMatchObject({ ownedBackground: true, project: f.project });
    expect(await f.workbench.continueTask(after.owner, "item:proposal", "Write a draft", "background-effect")).toMatchObject({ sessionId: first.sessionId, runId: first.runId });
    expect(f.store.listQueueItems({ sessionId: first.sessionId })).toHaveLength(1);
    await expect(f.workbench.continueTask(after.owner, "item:proposal", "Different request", "background-effect")).rejects.toMatchObject({ code: "WORKBENCH_INVALID" });
  });

  it("adopts exactly one native candidate and retains the imported task and judgment as owned work", async () => {
    const f = await fixture(); f.adapter.entries = [entry(f.project)]; let view: PartnerWorkbenchStateView = await grant(f);
    const native = view.candidates.find((task) => task.kind === "external")!;
    view = await f.workbench.setJudgment(view.owner, view.state.revision, { taskId: native.id, project: f.project, title: "Native follow-up", verdict: "unfinished", next: "Finish the draft" });
    const result = await f.workbench.continueTask(view.owner, native.id, "Finish the draft", "native-effect");
    expect(f.adapter.bind).toHaveBeenCalledOnce();
    expect(f.store.getSession(result.sessionId).descriptor.binding.nativeSessionId).toBe("native-source");
    const after = await f.workbench.readState(f.partner.id);
    expect(after.tasks.find((task) => task.sessionId === result.sessionId)).toMatchObject({ ownedBackground: true, judgment: { taskId: `task:${result.sessionId}` } });
    expect(after.candidates.some((task) => task.id === native.id)).toBe(false);
    expect(f.store.listQueueItems({ sessionId: result.sessionId })).toHaveLength(1);
  });

  it("inspects an uncertain native materialization without replaying it or dispatching a new input", async () => {
    const f = await fixture(); f.adapter.entries = [entry(f.project)]; f.adapter.failAfterClaim = true; f.adapter.materialization = "unknown";
    const view = await grant(f); const native = view.candidates.find((task) => task.kind === "external")!;
    await expect(f.workbench.continueTask(view.owner, native.id, "Continue", "uncertain-effect")).rejects.toThrow();
    await expect(f.workbench.continueTask(view.owner, native.id, "Continue", "another-effect")).rejects.toMatchObject({ code: "WORKBENCH_DISPATCH_UNKNOWN" });
    expect(f.adapter.bind).toHaveBeenCalledOnce();
    f.adapter.materialization = "present";
    const after = await f.workbench.readState(f.partner.id);
    const imported = after.tasks.find((task) => task.sessionId !== undefined)!;
    expect(imported).toMatchObject({ state: "stopped", ownedBackground: true });
    expect(f.store.listQueueItems({ sessionId: imported.sessionId! })).toEqual([]);
    const result = await f.workbench.continueTask(after.owner, imported.id, "Now continue", "confirmed-effect");
    expect(f.adapter.bind).toHaveBeenCalledOnce();
    expect(result.sessionId).toBe(imported.sessionId);
  });

  it("retires a native read when its project grant is removed during the await", async () => {
    const f = await fixture(); f.adapter.entries = [entry(f.project)]; const view = await grant(f);
    const native = view.candidates.find((task) => task.kind === "external")!;
    let release!: () => void; f.adapter.preview.mockClear(); f.adapter.previewGate = new Promise<void>((resolve) => { release = resolve; });
    const pending = f.workbench.readDetail(view.owner, native.id);
    await vi.waitFor(() => expect(f.adapter.preview).toHaveBeenCalled());
    await f.workbench.removeProject(view.owner, view.state.revision, f.project);
    release(); await expect(pending).rejects.toMatchObject({ code: "WORKBENCH_OWNER_CHANGED" });
  });

  it("uses the same canonical tool authority and reports each batch judgment independently", async () => {
    const f = await fixture(); const view = await grant(f);
    const provider = new PartnerWorkbenchToolProvider({ store: f.store, partners: f.partners, workbench: f.workbench });
    const context: BridgeToolCallContext = { sessionId: view.owner.sessionId, targetId: view.owner.targetId, generation: view.owner.sessionGeneration, providerGeneration: 1, effectIdentity: "a".repeat(64) };
    const reply = await provider.callTool("set_many_workbench", { items: [
      { task_id: "item:bad", project: f.project, title: "x".repeat(41), verdict: "done" },
      { task_id: "item:good", project: f.project, title: "Good", verdict: "idea", next: "Review" }
    ] }, undefined, context);
    expect(reply.isError).toBe(false);
    expect(JSON.parse((reply.content[0] as { text: string }).text)).toMatchObject({ results: [{ ok: false }, { ok: true }] });
    expect((await f.workbench.readState(f.partner.id)).state.judgments).toMatchObject([{ taskId: "item:good" }]);
    expect((await provider.callTool("get_workbench", {}, undefined, { ...context, generation: context.generation + 1 })).isError).toBe(true);
  });
});

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "joko-workbench-manager-"));
  const managed = join(root, "managed"); const project = join(root, "project"); const home = join(root, "home");
  mkdirSync(managed); mkdirSync(project); mkdirSync(home);
  const store = new OperationalStore(join(managed, "operational.db")); const partnerStore = new PartnerStore(join(managed, "partners.db"));
  const artifacts = new ArtifactStore({ rootDirectory: join(managed, "artifacts"), repository: new OperationalArtifactRepository(store), ingestRoots: [root] }); await artifacts.initialize();
  const adapter = new CatalogAdapter(PROFILE); const host = new SessionHost(store, artifacts, [adapter]); await host.initialize();
  const homesRoot = join(managed, "partner-homes"); const workspace = { register: vi.fn(async (input: { id: string; root: string; displayName: string; trusted: boolean }) => input), unregister: vi.fn() };
  const partners = new PartnerManager({ store: partnerStore, operationalStore: store, sessionHost: host, workspaceService: workspace, homesRoot });
  const partner = await partners.createPartner({ requestId: "creation-request-workbench", expectedDirectoryRevision: partnerStore.directoryState().revision, displayName: "Aster", avatar: "orbit", identitySource: "You help with ongoing projects.", templateId: "general", usesDirectoryDefaults: false,
    capabilities: { modelChain: [{ backendId: adapter.id, providerId: "test", modelId: "text", effort: "medium", fastMode: false }], permissionMode: "ask", planMode: false } });
  const workbench = new PartnerWorkbenchManager({ partners, partnerStore, store, host, workspaces: workspace, workbenches: new PartnerWorkbenchStore(homesRoot), managedDataDirectory: managed, homeDirectory: home,
    briefs: { read: async (path, assertScope) => { assertScope(); return { project: path, docs: [], recent: [], codeHost: { pullRequests: [], issues: [] } }; } } });
  cleanups.push(async () => { await host.dispose(); partnerStore.close(); store.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, managed, home, project, adapter, host, store, partnerStore, partners, partner, workspace, workbench };
}
async function grant(f: Awaited<ReturnType<typeof fixture>>) { const view = await f.workbench.readState(f.partner.id); return f.workbench.addProject(view.owner, view.state.revision, f.project); }
function entry(project: string): NativeSessionCatalogEntry { return { nativeReference: "native:source", nativeSessionId: "native-source", title: "Original native task", workingDirectory: project, projectDirectory: project,
  placement: "project", existingMatch: "binding", archived: false, createdAt: Date.now() - 1_000, modifiedAt: Date.now() }; }
