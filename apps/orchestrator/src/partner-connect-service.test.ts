import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdir, readFile, readdir, lstat, writeFile } from "node:fs/promises";

import { create } from "@bufbuild/protobuf";
import { createClient, Code, ConnectError, type HandlerContext } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import * as contract from "@joko/contracts";
import { FakeBackendAdapter, PI_LIKE_PROFILE } from "@joko/testkit";
import { OperationalStore, PartnerStore } from "@joko/store";
import { afterEach, describe, expect, it, vi } from "vitest";

import { OperationalArtifactRepository } from "./artifact-repository.js";
import { ArtifactStore } from "./artifact-store.js";
import { createPartnerConnectService } from "./partner-connect-service.js";
import { PartnerManager } from "./partner-manager.js";
import { SessionHost } from "./session-host.js";
import { MakerMemoryController, MakerMemoryBridgeProvider } from "./maker-memory.js";
import { PartnerMemoryManager } from "./partner-memory.js";
import { PartnerMemoryPreferences } from "./partner-memory-preferences.js";
import { CredentialVault } from "./credential-vault.js";
import type { BridgeToolCallContext } from "./mcp-router.js";
import { PartnerRuntimePromptResolver } from "./partner-runtime-prompt.js";
import { PartnerConnectionPreferences, PartnerConnectionsManager } from "./partner-connections.js";
import { PartnerCapabilityTools } from "./partner-capability-tools.js";
import { PartnerProfileTools } from "./partner-profile-tools.js";
import { AppDefaultModelCoordinator } from "./app-default-model.js";
import { AppDefaultModelTools } from "./app-default-model-tools.js";
import { PartnerSessionTaskManager } from "./partner-session-tasks.js";
import { McpRouter } from "./mcp-router.js";
import { CredentialManager } from "./credential-manager.js";
import { PiResourceManager } from "./resource-manager.js";
import { PartnerSkillsManager, PartnerSkillsToolProvider } from "./partner-skills.js";
import { SkillMutationCoordinator } from "./skill-mutation-coordinator.js";
import { renderSkillFile } from "./skill-file.js";
import { snapshotNativeSkills, type AdapterContext, type PromptInput } from "@joko/core";
import { PartnerTaskOutputProjection, PartnerTaskOutputChangedError, type PartnerTaskOutputRow } from "./partner-task-outputs.js";
import { DurableWorkspaceRunCapture } from "./workspace-run-capture.js";
import { WorkspaceChangeSetService } from "./workspace-change-set.js";
import { OperationalWorkspaceSnapshotRepository } from "./operational-workspace-snapshots.js";
import { ConnectionManager } from "./connection-manager.js";
import { createPublicServer } from "./server.js";
import type { OrchestratorApplication } from "./application.js";

const cleanups: Array<() => Promise<void> | void> = [];
const PROFILE = {
  ...PI_LIKE_PROFILE,
  permissionModes: ["ask", "auto", "bypassPermissions"],
  capabilities: [
    ...PI_LIKE_PROFILE.capabilities.map((capability) => capability.key === "permission.modes"
      ? { key: "permission.modes", supported: true, options: ["ask", "auto", "bypassPermissions"] }
      : capability),
    { key: "permission.change", supported: true }
  ]
} as const;

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("PartnerService", () => {
  it("round-trips the three exact permission modes through defaults, create and profile updates", async () => {
    const f = await createFixture(), service = createPartnerConnectService(f.manager, () => undefined);
    const defaults = await service.updatePartnerDefaults(create(contract.UpdatePartnerDefaultsRequestSchema, {
      expectedDirectoryRevision: revision(f.partnerStore.directoryState().revision),
      capabilities: create(contract.PartnerCapabilitiesSchema, { ...protoCapabilities(), permissionMode: contract.PermissionMode.BYPASS_PERMISSIONS })
    }), context());
    expect(defaults.directory?.defaultCapabilities?.permissionMode).toBe(contract.PermissionMode.BYPASS_PERMISSIONS);
    const created = await service.createPartner(create(contract.CreatePartnerRequestSchema, {
      requestId: "full-permission-create", expectedDirectoryRevision: defaults.directory!.revision,
      draft: { displayName: "Full permission owner", avatar: { value: { case: "presetId", value: "orbit" } }, identitySource: "Owned permission profile",
        templateId: "general", usesDirectoryDefaults: true }
    }), context());
    let row = created.partner!;
    expect(row.capabilities?.permissionMode).toBe(contract.PermissionMode.BYPASS_PERMISSIONS);
    for (const permissionMode of [contract.PermissionMode.ASK, contract.PermissionMode.AUTO, contract.PermissionMode.BYPASS_PERMISSIONS]) {
      const result = await service.updatePartner(create(contract.UpdatePartnerRequestSchema, { partnerId: row.partnerId, expectedRevision: row.revision,
        patch: { usesDirectoryDefaults: false, permissionMode } }), context());
      row = result.partner!; expect(row.capabilities?.permissionMode).toBe(permissionMode);
    }
    await expect(service.updatePartner(create(contract.UpdatePartnerRequestSchema, { partnerId: row.partnerId, expectedRevision: created.partner!.revision,
      patch: { permissionMode: contract.PermissionMode.ASK } }), context())).rejects.toMatchObject({ code: Code.Aborted });
    for (const permissionMode of [contract.PermissionMode.UNSPECIFIED, 999 as contract.PermissionMode]) {
      await expect(service.updatePartner(create(contract.UpdatePartnerRequestSchema, { partnerId: row.partnerId, expectedRevision: row.revision,
        patch: { permissionMode } }), context())).rejects.toMatchObject({ code: Code.InvalidArgument });
    }
  });

  it.each(["abort", "revoke"] as const)("rejects a privileged profile mutation after actual serialization waits and late %s", async retirement => {
    const f = await createFixture(); const profile = await f.manager.createPartner(partnerInput(f.partnerStore, "Awaiting permission owner"));
    let release!: () => void, entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const blocker = f.manager.runOwnedManagement(profile.id, profile.revision, async () => {
      entered(); await new Promise<void>(resolve => { release = resolve; });
    });
    await started;
    let revoked = false;
    const authorize = () => { if (revoked) throw new ConnectError("The connection was revoked.", Code.Unauthenticated); };
    const controller = new AbortController();
    const service = createPartnerConnectService(f.manager, authorize);
    const pending = service.updatePartner(create(contract.UpdatePartnerRequestSchema, { partnerId: profile.id,
      expectedRevision: revision(profile.revision), patch: { permissionMode: contract.PermissionMode.BYPASS_PERMISSIONS } }),
      { ...context(), signal: controller.signal });
    if (retirement === "abort") controller.abort(); else revoked = true;
    release(); await blocker;
    await expect(pending).rejects.toMatchObject({ code: retirement === "revoke" ? Code.Unauthenticated : Code.Canceled });
    expect(f.manager.getPartner(profile.id)).toEqual(profile);
    expect(f.operationalStore.getSession(profile.canonicalSessionId!).descriptor.permissionMode).toBe("ask");
  });

  it.each(["abort", "revoke"] as const)("rejects a Full access create after its asynchronous avatar validation and late %s", async retirement => {
    const f = await createFixture(); let revoked = false;
    const service = createPartnerConnectService(f.manager, () => {
      if (revoked) throw new ConnectError("The connection was revoked.", Code.Unauthenticated);
    });
    const controller = new AbortController();
    const pending = service.createPartner(create(contract.CreatePartnerRequestSchema, { requestId: "retired-permission-create",
      expectedDirectoryRevision: revision(f.partnerStore.directoryState().revision), draft: {
        displayName: "Not committed", avatar: { value: { case: "presetId", value: "orbit" } }, identitySource: "No effect", templateId: "general",
        capabilities: { ...protoCapabilities(), permissionMode: contract.PermissionMode.BYPASS_PERMISSIONS }
      } }), { ...context(), signal: controller.signal });
    if (retirement === "abort") controller.abort(); else revoked = true;
    await expect(pending).rejects.toMatchObject({ code: retirement === "revoke" ? Code.Unauthenticated : Code.Canceled });
    expect(f.partnerStore.listPartners()).toEqual([]); expect(f.partnerStore.directoryState().revision).toBe(1n);
  });

  it("maps bounded task output metadata and authenticates again after the asynchronous projection", async () => {
    const row: PartnerTaskOutputRow = { kind: "task", id: "task-output", partnerId: "requester", parentSessionId: "parent",
      sessionId: "source", title: "Deliverables", execution: 2, revision: 7n, runIds: ["run-a", "run-b"],
      readiness: "ready", files: [{ path: "reports/result.txt", status: "added" }], truncated: true };
    const outputs = { list: vi.fn(async () => Array.from({ length: 201 }, (_, index) => ({ ...row, id: `task-${index}` }))) };
    const authenticate = vi.fn();
    const service = createPartnerConnectService(undefined, authenticate, undefined, undefined, undefined, undefined, undefined, undefined,
      outputs as unknown as PartnerTaskOutputProjection);
    const response = await service.listPartnerTaskOutputs(create(contract.ListPartnerTaskOutputsRequestSchema, { partnerId: row.partnerId }), context());
    expect(outputs.list).toHaveBeenCalledWith(row.partnerId); expect(authenticate).toHaveBeenCalledTimes(2);
    expect(response.outputs).toHaveLength(200); expect(response.truncated).toBe(true);
    expect(response.outputs?.[0]).toMatchObject({ sourceKind: contract.PartnerTaskOutputSourceKind.SESSION_TASK, sourceId: "task-0",
      parentSessionId: "parent", sessionId: "source", execution: 2n, runIds: ["run-a", "run-b"], sourceRevision: { value: 7n },
      readiness: contract.PartnerTaskOutputReadiness.READY, files: [{ path: "reports/result.txt", status: contract.PartnerTaskOutputFileStatus.ADDED }], truncated: true });
    const drift = createPartnerConnectService(undefined, authenticate, undefined, undefined, undefined, undefined, undefined, undefined,
      { list: async () => { throw new PartnerTaskOutputChangedError(); } } as unknown as PartnerTaskOutputProjection);
    await expect(drift.listPartnerTaskOutputs(create(contract.ListPartnerTaskOutputsRequestSchema, { partnerId: row.partnerId }), context()))
      .rejects.toMatchObject({ code: Code.Aborted });
    await expect(createPartnerConnectService(undefined, authenticate).listPartnerTaskOutputs(create(contract.ListPartnerTaskOutputsRequestSchema,
      { partnerId: row.partnerId }), context())).rejects.toMatchObject({ code: Code.Unimplemented });
  });

  it.each(["abort", "revoke"] as const)("does not publish task output metadata after a late %s", async retirement => {
    let release!: (value: readonly PartnerTaskOutputRow[]) => void;
    const list = vi.fn(() => new Promise<readonly PartnerTaskOutputRow[]>(resolve => { release = resolve; }));
    let revoked = false;
    const authenticate = () => { if (revoked) throw new ConnectError("The connection was revoked.", Code.Unauthenticated); };
    const signal = new AbortController();
    const service = createPartnerConnectService(undefined, authenticate, undefined, undefined, undefined, undefined, undefined, undefined,
      { list } as unknown as PartnerTaskOutputProjection);
    const pending = service.listPartnerTaskOutputs(create(contract.ListPartnerTaskOutputsRequestSchema, { partnerId: "requester" }),
      { signal: signal.signal } as HandlerContext);
    if (retirement === "abort") signal.abort(); else revoked = true;
    release([]);
    await expect(pending).rejects.toMatchObject({ code: retirement === "revoke" ? Code.Unauthenticated : Code.Canceled });
  });

  it("serves an accepted sealed Task output over generated authenticated HTTP and preserves it across SQLite reopen", async () => {
    const boundary = { phase: "create-fixture", observations: 0, taskState: "not-created", taskRunCount: 0,
      outputCount: 0, outputReadiness: "unobserved", hasExpectedFile: false };
    try {
      const f = await createFixture(0, false, [], true);
      boundary.phase = "create-partner";
      const partner = await f.manager.createPartner(partnerInput(f.partnerStore, "Output requester"));
      boundary.phase = "initialize-tasks";
      const tasks = new PartnerSessionTaskManager(f.operationalStore, f.manager, f.sessionHost,
        { register: async input => input }, f.directory); await tasks.initialize(); cleanups.push(() => tasks.close());
      const outputs = new PartnerTaskOutputProjection(f.operationalStore, tasks, f.partnerStore, f.workspaceCapture!);
      boundary.phase = "start-task";
      const task = await tasks.start(partner.canonicalSessionId!, "output-http-task", { instruction: "Produce the report", title: "Report" }, () => undefined);
      expect(task.sessionId).toBeDefined();
      boundary.phase = "await-sealed-output";
      // The committed capture follows the terminal Run; subscribe before checking
      // persisted events so an already completed capture cannot race this wait.
      await new Promise<void>(resolve => {
        const unsubscribe = f.operationalStore.subscribe(event => {
          if (event.sessionId === task.sessionId && event.payload.type === "workspace_diff") { unsubscribe(); resolve(); }
        });
        cleanups.push(unsubscribe);
        if (f.operationalStore.listEvents({ sessionId: task.sessionId! }).some(event => event.payload.type === "workspace_diff")) {
          unsubscribe(); resolve();
        }
      });
      await tasks.check(partner.canonicalSessionId!, task.id);
      const current = tasks.list(partner.id).find(row => row.id === task.id);
      const rows = await outputs.list(partner.id), output = rows.find(row => row.id === task.id);
      boundary.observations += 1;
      boundary.taskState = current?.status ?? "missing";
      boundary.taskRunCount = current?.executionRunIds.length ?? 0;
      boundary.outputCount = rows.length;
      boundary.outputReadiness = output?.readiness ?? "missing";
      boundary.hasExpectedFile = output?.files.some(file => file.path === "task-report.txt" && file.status === "added") ?? false;
      expect(output).toMatchObject({ readiness: "ready", files: [{ path: "task-report.txt", status: "added" }] });
      boundary.phase = "pair-reader";
      const connections = new ConnectionManager(f.operationalStore), challenge = connections.issuePairing("Output reader");
      const paired = connections.completePairing({ challengeId: challenge.id, code: challenge.code, connectionName: "Output reader" });
      boundary.phase = "create-http-server";
      const server = await createPublicServer({ config: { publicOrigin: "http://127.0.0.1", allowInsecureLoopback: true, allowInsecureLan: false, corsOrigins: [],
        webDirectory: join(f.directory, "no-web"), dataDirectory: f.directory }, store: f.operationalStore, connections, artifacts: {}, blobTransfers: {},
        artifactRepository: {}, workspaces: {}, workspaceChanges: {}, scheduler: {}, adapters: [], browserActivity: [], sessionHost: f.sessionHost,
        partners: f.manager, partnerSessionTasks: tasks, partnerTaskOutputs: outputs } as unknown as OrchestratorApplication); server.log.level = "silent";
      try {
        boundary.phase = "listen-http";
        const baseUrl = await server.listen({ host: "127.0.0.1", port: 0 });
        const client = createClient(contract.PartnerService, createConnectTransport({ baseUrl, httpVersion: "1.1", interceptors: [next => request => {
          request.header.set("authorization", `Bearer ${paired.authKey}`); return next(request);
        }] }));
        boundary.phase = "authenticated-http";
        const response = await client.listPartnerTaskOutputs({ partnerId: partner.id });
        boundary.phase = "assert-http-output";
        expect(response.partnerId).toBe(partner.id);
        expect(response.outputs).toMatchObject([{ sourceId: task.id, sessionId: task.sessionId, execution: 1n,
          readiness: contract.PartnerTaskOutputReadiness.READY, files: [{ path: "task-report.txt", status: contract.PartnerTaskOutputFileStatus.ADDED }] }]);
        expect(JSON.stringify(response, (_, value) => typeof value === "bigint" ? value.toString() : value)).not.toContain("Private report contents");
        const unauthenticated = createClient(contract.PartnerService, createConnectTransport({ baseUrl, httpVersion: "1.1" }));
        boundary.phase = "assert-unauthenticated-rejection";
        await expect(unauthenticated.listPartnerTaskOutputs({ partnerId: partner.id })).rejects.toMatchObject({ code: Code.Unauthenticated });
      } finally {
        const precedingPhase = boundary.phase;
        boundary.phase = "close-http";
        await server.close();
        boundary.phase = precedingPhase;
      }
      boundary.phase = "close-stores";
      await tasks.close(); await f.close();
      boundary.phase = "reopen-stores";
      const reopened = new OperationalStore(join(f.directory, "operational.db")), reopenedPartners = new PartnerStore(join(f.directory, "partners.db"));
      try {
        const changes = new WorkspaceChangeSetService({ snapshotDirectory: join(f.directory, "snapshots"), repository: new OperationalWorkspaceSnapshotRepository(reopened) });
        await changes.initialize();
        const capture = new DurableWorkspaceRunCapture(reopened, changes);
        const stored = reopened.findSetting("service", "partner.session-tasks", task.id)!.value as typeof task;
        const restored = new PartnerTaskOutputProjection(reopened, { list: () => [stored] }, reopenedPartners, capture);
        boundary.phase = "assert-reopened-output";
        expect((await restored.list(partner.id))[0]).toMatchObject({ id: task.id, readiness: "ready", runIds: stored.executionRunIds,
          files: [{ path: "task-report.txt", status: "added" }] });
      } finally {
        const precedingPhase = boundary.phase;
        boundary.phase = "close-reopened-stores";
        reopenedPartners.close(); reopened.close();
        boundary.phase = precedingPhase;
      }
    } catch (error) {
      console.error("[sealed-output-boundary]", JSON.stringify(boundary));
      throw error;
    }
  });

  it("reads and patches the caller's own profile and full mixed model chain with private authority", async () => {
    const secondary = new FakeBackendAdapter({ ...PROFILE, id: "profile-secondary", streamDelayMs: 0 });
    const f = await createFixture(0, false, [secondary]), profile = await f.manager.createPartner({ ...partnerInput(f.partnerStore, "Own profile"), description: "Initial introduction" });
    const other = await f.manager.createPartner(partnerInput(f.partnerStore, "Other profile"));
    const router = await connectionRouter(f), connections = new PartnerConnectionsManager(f.manager, f.partnerStore, f.operationalStore,
      new PartnerConnectionPreferences(f.operationalStore), router);
    const tasks = new PartnerSessionTaskManager(f.operationalStore, f.manager, f.sessionHost,
      { register: vi.fn(async (input: { id: string; root: string; displayName: string; trusted: boolean }) => input) }, f.directory);
    cleanups.push(() => tasks.close());
    const memory = new PartnerMemoryPreferences(f.operationalStore, await CredentialVault.open(join(f.directory, "profile-memory.key")));
    memory.update(profile.homeTargetId, undefined, { enabled: false, userContext: "Private retained context" });
    const tools = new PartnerProfileTools(f.manager, tasks, connections, memory), session = f.operationalStore.getSession(profile.canonicalSessionId!).descriptor;
    const caller = { sessionId: session.id, targetId: session.targetId, generation: session.binding.generation, providerGeneration: 1 };
    const state = await tools.callTool("get_partner_state", {}, undefined, caller);
    expect(state.isError).toBe(false); expect(state.structuredContent).toMatchObject({ state: {
      profile: { name: profile.displayName, description: "Initial introduction", identity_source: profile.identitySource, version: profile.profileVersion },
      memory: { enabled: false, scope: "self" }, model: { source: "override" }, references: { skills: [] } } });
    expect(JSON.stringify(state)).not.toContain("Private retained context");
    const defaults = new AppDefaultModelCoordinator(f.operationalStore, () => f.sessionHost.appDefaultModelChoices(), async () => undefined);
    const appTools = new AppDefaultModelTools(defaults, tools), defaultState = await appTools.callTool("get_app_default_model", {}, undefined, caller);
    expect(defaultState.structuredContent).toMatchObject({ current: null, available: expect.any(Array) });
    const preferred = defaults.read().available.find(item => item.backendId === secondary.id)!;
    const stopDefaults = defaults.watch("own-profile-connection", "own-profile-default-picker", message => {
      if (message.requestId) queueMicrotask(() => {
        const claim = defaults.claim("own-profile-connection", "own-profile-default-picker", message.requestId);
        defaults.sync("own-profile-connection", "own-profile-default-picker", claim.requested, [], [], message.requestId);
      });
    }, () => undefined);
    defaults.sync("own-profile-connection", "own-profile-default-picker", { ...profile.capabilities.modelChain[0]!, effort: "medium" }, [], []);
    expect((await appTools.callTool("set_app_default_model", { id: preferred.id }, undefined, caller)).isError).toBe(false);
    expect(f.partnerStore.getPartner(profile.id)).toEqual(profile);
    expect((await appTools.callTool("get_app_default_model", {}, undefined, { ...caller, generation: caller.generation + 1 })).isError).toBe(true);
    stopDefaults();
    const saved = await tools.callTool("update_partner_profile", { expected_version: profile.profileVersion, description: "Changed introduction" }, undefined, caller);
    expect(saved.isError).toBe(false); let current = f.partnerStore.getPartner(profile.id);
    expect(current).toMatchObject({ description: "Changed introduction", identitySource: profile.identitySource, capabilities: profile.capabilities });
    expect((await tools.callTool("update_partner_profile", { expected_version: profile.profileVersion, name: "Stale" }, undefined, caller)).isError).toBe(true);
    const routes = tasks.models(session.id).available.filter(route => route.modelId === "text");
    expect(routes).toHaveLength(2);
    const changed = await tools.callTool("update_partner_profile", { expected_version: current.profileVersion,
      model_chain: [routes.find(route => route.backendId === secondary.id)!, routes.find(route => route.backendId === PROFILE.id)!].map(route => ({ id: route.id })) }, undefined, caller);
    expect(changed.isError).toBe(false); current = f.partnerStore.getPartner(profile.id);
    expect(current.capabilities.modelChain.map(route => route.backendId)).toEqual([secondary.id, PROFILE.id]);
    expect(f.sessionHost.getSessionRuntimeControl(session.id).pending?.profile.backendId).toBe(secondary.id);
    expect(f.operationalStore.getSession(session.id).descriptor.backendId).toBe(PROFILE.id);
    expect((await tools.callTool("update_partner_profile", { expected_version: current.profileVersion, model_chain: [{ id: routes[0]!.id }, { id: routes[0]!.id }] }, undefined, caller)).isError).toBe(true);
    expect((await tools.callTool("update_partner_profile", { expected_version: current.profileVersion, model_chain: [{ id: "not-enabled" }] }, undefined, caller)).isError).toBe(true);
    current = await f.manager.updatePartner(profile.id, current.revision, { capabilities: { ...current.capabilities, permissionMode: "auto" } });
    expect(current.initializationState, current.initializationErrorCode).toBe("ready");
    f.partnerStore.setDirectoryDefaults(f.partnerStore.directoryState().revision, profile.capabilities);
    const inherited = await tools.callTool("update_partner_profile", { expected_version: current.profileVersion, model_chain: null, name: "Own renamed profile" }, undefined, caller);
    expect(inherited.isError, JSON.stringify(inherited)).toBe(false);
    current = f.partnerStore.getPartner(profile.id); expect(current).toMatchObject({ usesDirectoryDefaults: true, displayName: "Own renamed profile", description: "Changed introduction" });
    expect(current.capabilities.permissionMode).toBe("auto");
    expect(f.operationalStore.getSession(session.id).descriptor.permissionMode).toBe("auto");
    expect(f.sessionHost.getSessionRuntimeControl(session.id).pending).toBeUndefined();
    expect(f.partnerStore.getPartner(other.id)).toEqual(other); expect(memory.read(profile.homeTargetId).userContext).toBe("Private retained context");
    expect((await tools.callTool("get_partner_state", {}, undefined, { ...caller, generation: caller.generation + 1 })).isError).toBe(true);
    expect((await tools.callTool("get_partner_state", {}, undefined, { ...caller, sessionId: other.canonicalSessionId! })).isError).toBe(true);
  });

  it("round-trips an introduction through authenticated generated profile patches with stale protection", async () => {
    const f = await createFixture(), profile = await f.manager.createPartner(partnerInput(f.partnerStore, "Wire introduction"));
    const service = createPartnerConnectService(f.manager, () => ({ connectionId: "connection-1" }));
    const saved = await service.updatePartner(create(contract.UpdatePartnerRequestSchema, { partnerId: profile.id,
      expectedRevision: revision(profile.revision), patch: { description: "Independent wire introduction" } }), context());
    expect(saved.partner).toMatchObject({ description: "Independent wire introduction", identitySource: profile.identitySource });
    const read = await service.getPartner(create(contract.GetPartnerRequestSchema, { partnerId: profile.id }), context());
    expect(read.partner?.description).toBe("Independent wire introduction");
    await expect(service.updatePartner(create(contract.UpdatePartnerRequestSchema, { partnerId: profile.id,
      expectedRevision: revision(profile.revision), patch: { description: "Stale" } }), context())).rejects.toMatchObject({ code: Code.Aborted });
  });

  it("round-trips a single task preference through authenticated generated patches and rejects stale or false inheritance", async () => {
    const f = await createFixture(), profile = await f.manager.createPartner(partnerInput(f.partnerStore, "Task preference"));
    const service = createPartnerConnectService(f.manager, () => ({ connectionId: "connection-1" }));
    const task = create(contract.PartnerModelRouteSchema, profile.capabilities.modelChain[0]!);
    const selected = await service.updatePartner(create(contract.UpdatePartnerRequestSchema, { partnerId: profile.id,
      expectedRevision: { value: profile.revision }, patch: { taskModelPreference: { case: "taskModelOverride", value: task } } }), context());
    expect(selected.partner!.taskModelOverride).toMatchObject(task); expect(selected.partner!.capabilities!.modelChain).toHaveLength(1);
    expect((await service.getPartner(create(contract.GetPartnerRequestSchema, { partnerId: profile.id }), context())).partner!.taskModelOverride).toMatchObject(task);
    await expect(service.updatePartner(create(contract.UpdatePartnerRequestSchema, { partnerId: profile.id, expectedRevision: { value: profile.revision },
      patch: { taskModelPreference: { case: "inheritTaskModel", value: true } } }), context())).rejects.toMatchObject({ code: Code.Aborted });
    await expect(service.updatePartner(create(contract.UpdatePartnerRequestSchema, { partnerId: profile.id, expectedRevision: selected.partner!.revision,
      patch: { taskModelPreference: { case: "inheritTaskModel", value: false } } }), context())).rejects.toMatchObject({ code: Code.InvalidArgument });
    const cleared = await service.updatePartner(create(contract.UpdatePartnerRequestSchema, { partnerId: profile.id, expectedRevision: selected.partner!.revision,
      patch: { taskModelPreference: { case: "inheritTaskModel", value: true } } }), context());
    expect(cleared.partner!.taskModelOverride).toBeUndefined();
    expect(f.operationalStore.getSession(profile.canonicalSessionId!).descriptor.modelId).toBe(profile.capabilities.modelChain[0]!.modelId);
  });

  it("loads approved personal skills through the durable native handoff admission and keeps the same private owners afterwards", async () => {
    const secondary = new FakeBackendAdapter({ ...PROFILE, id: "skill-handoff", capabilities: [...PROFILE.capabilities, {
      key: "runtime.resources", supported: true, options: ["skill"] }] });
    const f = await createFixture(0, true, [secondary]);
    const partner = await f.manager.createPartner(partnerInput(f.partnerStore, "Handoff skills"));
    const sessionId = partner.canonicalSessionId!, original = f.operationalStore.getSession(sessionId).descriptor;
    const resources = new PiResourceManager({ store: f.operationalStore, managedRoot: resourcesRoot(f) }); await resources.initialize();
    const skills = new PartnerSkillsManager(f.manager, f.partnerStore, f.operationalStore, resources, new SkillMutationCoordinator());
    const own = (await skills.saveForCaller({ sessionId, targetId: original.targetId, generation: original.binding.generation, providerGeneration: 1 }, {
      name: "Retained learning", description: "Continue on another engine", body: "Full retained instructions.\n".repeat(1000)
    })).skill.summary!;
    const connections = new PartnerConnectionsManager(f.manager, f.partnerStore, f.operationalStore,
      new PartnerConnectionPreferences(f.operationalStore), await connectionRouter(f), undefined, resources,
      (id, signal, backendId) => skills.referenceMetadata(id, signal, backendId));
    let preparedContext: AdapterContext | undefined;
    const create = secondary.createSession.bind(secondary);
    vi.spyOn(secondary, "createSession").mockImplementation(async (input, context) => {
      preparedContext = context;
      const ids = connections.targetSkillReferences(context.target.id);
      const seeds = await resources.runtimeSkillSnapshot(secondary.id, context.target.id, context.signal, ids, context);
      expect(seeds.map(seed => seed.resource.id)).toEqual([own.id]);
      expect(await connections.nativeSkillPolicy(context)).toMatchObject({ mode: "explicit", overrides: { "retained-learning": "on" } });
      const snapshot = await snapshotNativeSkills(seeds, context.signal);
      try { expect(await readFile(snapshot.skills[0]!.filePath, "utf8")).toContain("Full retained instructions.\n".repeat(1000)); }
      finally { await snapshot.dispose(); }
      return create(input, context);
    });
    await f.manager.updatePartner(partner.id, partner.revision, { capabilities: { ...partner.capabilities,
      modelChain: [{ ...partner.capabilities.modelChain[0]!, backendId: secondary.id }] } });
    const queued = f.sessionHost.enqueueServiceInput({ operationId: "skill-handoff-input", sessionId, source: "system",
      prompt: { text: "Continue the retained work", disposition: "prompt", images: [], files: [], mentions: [] } }).value;
    await vi.waitFor(() => expect(f.operationalStore.getRun(queued.runId).descriptor.state).toBe("completed"));
    expect(preparedContext).toBeDefined();
    const current = f.operationalStore.getSession(sessionId).descriptor;
    expect(current.backendId).toBe(secondary.id); expect(f.operationalStore.getTarget(current.targetId).descriptor.backendId).toBe(original.backendId);
    expect((await skills.list(partner.id)).skills.map(item => item.id)).toContain(own.id);
    expect(connections.read(partner.id).entries.find(item => item.id === own.id)).toMatchObject({ available: true, personal: true });
    const context = { ...preparedContext!, generation: current.binding.generation, binding: current.binding };
    const ids = connections.targetSkillReferences(current.targetId);
    expect((await resources.runtimeTextSnapshot(secondary.id, current.targetId, context.signal, ids, context)).map(seed => seed.id)).toEqual([own.id]);
    await expect(resources.runtimeSkillSnapshot(secondary.id, current.targetId, context.signal, ids, { ...context, sessionId: "foreign-task" }))
      .rejects.toThrow(/runtime owner/u);
  });

  it("uses opaque explicit skill grants while personal skills, native policy and canonical capability tools keep their owners", async () => {
    const f = await createFixture(0, true), partner = await f.manager.createPartner(partnerInput(f.partnerStore, "Skill references"));
    const task = f.operationalStore.getSession(partner.canonicalSessionId!).descriptor, target = f.operationalStore.getTarget(task.targetId).descriptor;
    const resources = new PiResourceManager({ store: f.operationalStore, managedRoot: resourcesRoot(f) }); await resources.initialize();
    const personal = new PartnerSkillsManager(f.manager, f.partnerStore, f.operationalStore, resources, new SkillMutationCoordinator());
    const caller = { sessionId: task.id, targetId: task.targetId, generation: task.binding.generation, providerGeneration: 1 };
    const own = (await personal.saveForCaller(caller, { name: "Personal report", description: "Own learning", body: "Own instructions." })).skill.summary!;
    const shared: string[] = [];
    for (const suffix of ["a", "b"]) {
      const path = suffix === "a" ? join(target.workspaceRoot, ".agents", "skills", "shared-a") : join(f.directory, "global-shared-b"); await mkdir(join(path, "assets"), { recursive: true });
      await writeFile(join(path, "SKILL.md"), renderSkillFile({ slug: "report", name: "Shared report", description: `${"Long metadata ".repeat(100)}needle-${suffix}`, body: `Full ${suffix} instructions.`, updatedAt: "2026-10-12" }));
      await writeFile(join(path, "assets", "template.bin"), Buffer.from([0, 255, 17]));
      const item = await resources.discover({ id: `shared-${suffix}`, backendId: task.backendId, ...(suffix === "a" ? { targetId: task.targetId, scope: "project" as const, workspaceRoot: target.workspaceRoot } : { scope: "managed" as const }), kind: "skill", name: "Shared report", source: { kind: "local", path } });
      await resources.approve(item.id, item.discoveredRevision, "test"); if (suffix === "b") await resources.install(item.id); await resources.setEnabled(item.id, true); shared.push(item.id);
    }
    const preferences = new PartnerConnectionPreferences(f.operationalStore), router = await connectionRouter(f);
    const manager = new PartnerConnectionsManager(f.manager, f.partnerStore, f.operationalStore, preferences, router, undefined, resources,
      (id, signal) => personal.referenceMetadata(id, signal));
    const signal = new AbortController().signal, initial = await manager.readForClient(partner.id, signal);
    expect(initial.skills).toMatchObject({ mode: contract.PartnerConnectionMode.ALLOWLIST, ids: [] });
    expect(initial.entries.filter(item => item.kind === contract.PartnerConnectionKind.SKILL)).toHaveLength(3);
    expect(initial.entries.find(item => item.id === own.id)).toMatchObject({ personal: true, available: true, name: "Personal report" });
    expect(initial.entries.filter(item => item.name === "Shared report").map(item => item.id)).toEqual(shared);
    expect((await resources.runtimeSkillSnapshot(task.backendId, task.targetId, signal, manager.targetSkillReferences(task.targetId))).map(item => item.resource.id)).toEqual([own.id]);
    const request = create(contract.UpdatePartnerConnectionsRequestSchema, { partnerId: partner.id, expectedPartnerRevision: revision(partner.revision), expectedCatalogRevision: initial.catalogRevision,
      mcp: initial.mcp, toolsets: initial.toolsets, skills: { mode: contract.PartnerConnectionMode.ALLOWLIST, ids: [shared[0]!] } });
    const service = createPartnerConnectService(f.manager, () => ({ kind: "device" }), undefined, undefined, undefined, manager);
    await service.updatePartnerConnections(request, context());
    const ids = manager.targetSkillReferences(task.targetId)!;
    const seeds = await resources.runtimeSkillSnapshot(task.backendId, task.targetId, signal, ids);
    expect(new Set(seeds.map(item => item.resource.id))).toEqual(new Set([own.id, shared[0]]));
    expect((await resources.runtimeTextSnapshot(task.backendId, task.targetId, signal, ids)).map(item => item.id).sort()).toEqual([...ids].sort());
    const backend = f.operationalStore.getBackend(task.backendId).descriptor;
    const policy = (await manager.nativeSkillPolicy({ sessionId: "not-published-yet", target, generation: task.binding.generation + 1,
      backendInstanceGeneration: backend.instanceGeneration, signal, emit: async () => undefined,
      artifactCapacityBytes: 1024, requestInteraction: async () => { throw Error("No interaction expected"); },
      storeArtifact: async () => { throw Error("No artifact expected"); } }))!;
    expect(policy.mode).toBe("explicit"); expect(policy.overrides).toMatchObject({ "personal-report": "on", report: "on" });
    const snapshot = await snapshotNativeSkills(seeds, signal, undefined, policy);
    try { expect(snapshot.restrictImplicit).toBe(true); const mount = snapshot.skills.find(item => item.seed.resource.id === shared[0])!;
      expect(await readFile(join(mount.path, "assets", "template.bin"))).toEqual(Buffer.from([0, 255, 17])); } finally { await snapshot.dispose(); }
    const refresh = vi.fn(() => true), tools = new PartnerCapabilityTools(manager, refresh);
    const found = await tools.callTool("find_partner_capabilities", { kind: "skill", query: "needle-a" }, signal, caller);
    expect(found.structuredContent).toMatchObject({ capabilities: [{ id: shared[0], joined: true, available: true }] });
    expect(JSON.stringify(found)).not.toContain(target.workspaceRoot); expect(JSON.stringify(found)).not.toContain("Full a instructions");
    expect((await tools.callTool("select_partner_capability", { kind: "skill", id: own.id, joined: false }, signal, caller)).isError).toBe(true);
    expect((await tools.callTool("select_partner_capability", { kind: "skill", id: shared[1], joined: true }, signal, { ...caller, generation: caller.generation + 1 })).isError).toBe(true);
    expect((await tools.callTool("select_partner_capability", { kind: "skill", id: shared[1], joined: true }, signal, caller)).structuredContent).toMatchObject({ joined: true, effective: "next-turn" });
    expect(refresh).toHaveBeenCalledWith(task.id);
    const current = manager.read(partner.id); await resources.setEnabled(shared[1]!, false);
    expect(() => manager.update(create(contract.UpdatePartnerConnectionsRequestSchema, { ...request, expectedRevision: current.revision, expectedCatalogRevision: current.catalogRevision }))).toThrow("catalog changed");
    expect((await tools.callTool("find_partner_capabilities", { kind: "skill", query: shared[1] }, signal, caller)).structuredContent).toMatchObject({ capabilities: [{ id: shared[1], available: false, joined: true }] });
    expect((await tools.callTool("select_partner_capability", { kind: "skill", id: shared[1], joined: false }, signal, caller)).isError).toBe(false);
    expect((await tools.callTool("select_partner_capability", { kind: "mcp", id: "connected", joined: false }, signal, caller)).isError).toBe(false);
    expect((await tools.callTool("select_partner_capability", { kind: "toolset", id: "optional", joined: false }, signal, caller)).isError).toBe(false);
    expect(preferences.read(task.targetId).toolsets).toEqual({ mode: "allowlist", ids: [] });
    expect(preferences.read(task.targetId).skills.ids).toEqual([shared[0]]); expect(resources.get(shared[0]!).enabled).toBe(true);
    expect(manager.targetSkillReferences("ordinary-target")).toBeUndefined(); expect(() => manager.update(create(contract.UpdatePartnerConnectionsRequestSchema,
      { ...request, expectedRevision: manager.read(partner.id).revision, expectedCatalogRevision: manager.read(partner.id).catalogRevision, skills: create(contract.PartnerConnectionSelectionSchema, { mode: contract.PartnerConnectionMode.INHERIT }) }))).toThrow("explicit");
    const reloaded = new PiResourceManager({ store: f.operationalStore, managedRoot: resourcesRoot(f) }); await reloaded.initialize();
    expect(new PartnerConnectionPreferences(f.operationalStore).read(task.targetId).skills.ids).toEqual([shared[0]]);
    expect((await reloaded.runtimeSkillSnapshot(task.backendId, task.targetId, signal, manager.targetSkillReferences(task.targetId))).map(item => item.resource.id).sort()).toEqual([...manager.targetSkillReferences(task.targetId)!].sort());
    f.operationalStore.setSetting("target", task.targetId, "partner-connections.preferences", { format: 1, mcp: { mode: "inherit", ids: [] }, toolsets: { mode: "inherit", ids: [] } });
    expect(() => preferences.read(task.targetId)).toThrow("invalid");
  });
  it("pages the complete personal skill catalog by bytes and accepts the full 1024 character metadata query", async () => {
    const f = await createFixture(0, true), partner = await f.manager.createPartner(partnerInput(f.partnerStore, "Paged personal skills"));
    const resources = new PiResourceManager({ store: f.operationalStore, managedRoot: resourcesRoot(f) }); await resources.initialize();
    const owner = new PartnerSkillsManager(f.manager, f.partnerStore, f.operationalStore, resources, new SkillMutationCoordinator());
    const tools = new PartnerSkillsToolProvider(owner), task = f.operationalStore.getSession(partner.canonicalSessionId!).descriptor;
    const caller = { sessionId: task.id, targetId: task.targetId, generation: task.binding.generation };
    for (let index = 0; index < 40; index++) await owner.saveForCaller(caller,
      { name: `Skill ${index}`, description: `${"报告".repeat(132)} needle`, body: "Reusable instructions." });
    const seen = new Set<string>(); let offset = 0, pages = 0;
    do {
      const result = await tools.callTool("list_partner_skills", { query: `${" ".repeat(1_010)}needle`, offset, limit: 50 }, undefined, caller);
      expect(result.isError).toBe(false); const page = result.structuredContent as { skills: { slug: string }[]; total: number; nextOffset?: number };
      expect(page.total).toBe(40); expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(16 * 1024);
      for (const skill of page.skills) { expect(seen.has(skill.slug)).toBe(false); seen.add(skill.slug); }
      pages++; if (page.nextOffset === undefined) break; expect(page.nextOffset).toBeGreaterThan(offset); offset = page.nextOffset;
    } while (pages < 10);
    expect(pages).toBeGreaterThan(1); expect(seen.size).toBe(40);
  });

  it("saves personal skills through the current caller and authenticates full file editing with CAS, assets and reopen", async () => {
    const f = await createFixture(0, true), partner = await f.manager.createPartner(partnerInput(f.partnerStore, "Personal skills"));
    const resources = new PiResourceManager({ store: f.operationalStore, managedRoot: join(f.directory, "resources") }); await resources.initialize();
    const refresh = vi.fn(() => true), owner = new PartnerSkillsManager(f.manager, f.partnerStore, f.operationalStore, resources, new SkillMutationCoordinator(), refresh);
    const tools = new PartnerSkillsToolProvider(owner), task = f.operationalStore.getSession(partner.canonicalSessionId!).descriptor;
    const caller = { sessionId: task.id, targetId: task.targetId, generation: task.binding.generation, providerGeneration: 1 };
    expect((await tools.callTool("save_partner_skill", { name: "报告", slug: "report", description: "Create reports", body: "Read assets/template.bin." }, undefined, caller)).structuredContent)
      .toMatchObject({ created: true, effective: "next-turn", skill: { slug: "report", name: "报告" } });
    const root = f.operationalStore.getTarget(partner.homeTargetId).descriptor.workspaceRoot;
    const entry = (await owner.list(partner.id)).skills[0]!;
    const draft = join(f.directory, "asset-draft"); await mkdir(draft);
    const lease = await resources.acquireSkillContent({ resourceId: entry.id, expectedResourceVersion: entry.revision!.value });
    await lease.snapshotTo(draft); await lease.release(); await mkdir(join(draft, "assets"));
    const binary = Buffer.from([0, 255, 6, 42]); await writeFile(join(draft, "assets", "template.bin"), binary);
    const prepared = await resources.prepareReplaceSkillContent({ resourceId: entry.id, expectedResourceVersion: entry.revision!.value,
      expectedObservedRevision: entry.contentRevision, candidateRoot: draft, changedByConnectionId: "test", name: "report" });
    await resources.completePreparedMutation(prepared, finalize => f.operationalStore.transaction(store => finalize(store)));
    const auth = vi.fn(), service = createPartnerConnectService(f.manager, auth, undefined, undefined, undefined, undefined, owner);
    auth.mockImplementationOnce(() => { throw new ConnectError("Unauthorized", Code.Unauthenticated); });
    await expect(service.listPartnerSkills(create(contract.ListPartnerSkillsRequestSchema, { partnerId: partner.id }), context())).rejects.toMatchObject({ code: Code.Unauthenticated });
    const base = (await owner.read(partner.id, entry.id)).skill;
    const request = create(contract.UpdatePartnerSkillRequestSchema, { partnerId: partner.id, skillId: entry.id,
      expectedPartnerRevision: revision(partner.revision), expectedRevision: base.summary!.revision,
      expectedContentRevision: base.summary!.contentRevision, name: "Report", description: "Updated metadata", body: "Keep the full template." });
    const saved = create(contract.UpdatePartnerSkillResponseSchema, await service.updatePartnerSkill(request, context())).skill!;
    expect(saved.body).toBe("Keep the full template."); expect(await readFile(join(root, ".agents", "skills", "report", "assets", "template.bin"))).toEqual(binary);
    await expect(owner.update(request)).rejects.toMatchObject({ code: Code.Aborted });
    const listed = await tools.callTool("list_partner_skills", { query: "updated metadata" }, undefined, caller);
    expect(listed.structuredContent).toMatchObject({ total: 1, skills: [{ filePath: ".agents/skills/report/SKILL.md", bodyStartLine: 8 }] });
    expect(JSON.stringify(listed)).not.toContain(root); expect(refresh).toHaveBeenCalledWith(task.id);
    const reopened = new PiResourceManager({ store: f.operationalStore, managedRoot: join(f.directory, "resources") }); await reopened.initialize();
    const next = new PartnerSkillsManager(f.manager, f.partnerStore, f.operationalStore, reopened, new SkillMutationCoordinator());
    expect((await next.read(partner.id, entry.id)).skill.body).toBe(saved.body);
    await next.remove(create(contract.DeletePartnerSkillRequestSchema, { partnerId: partner.id, skillId: entry.id,
      expectedPartnerRevision: revision(partner.revision), expectedRevision: saved.summary!.revision, expectedContentRevision: saved.summary!.contentRevision }));
    expect((await next.list(partner.id)).total).toBe(0); await expect(lstat(join(root, ".agents", "skills", "report"))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await new PartnerSkillsToolProvider(next).callTool("save_partner_skill", { name: "Report", description: "New incarnation", body: "New content." }, undefined, caller)).isError).toBe(false);
  });

  it("keeps personal skill files unchanged for stale, archived or foreign callers and credential input", async () => {
    const f = await createFixture(0, true), partner = await f.manager.createPartner(partnerInput(f.partnerStore, "Private skill owner"));
    const resources = new PiResourceManager({ store: f.operationalStore, managedRoot: join(f.directory, "resources") }); await resources.initialize();
    const owner = new PartnerSkillsManager(f.manager, f.partnerStore, f.operationalStore, resources, new SkillMutationCoordinator());
    const tools = new PartnerSkillsToolProvider(owner), task = f.operationalStore.getSession(partner.canonicalSessionId!).descriptor;
    const caller = { sessionId: task.id, targetId: task.targetId, generation: task.binding.generation, providerGeneration: 1 };
    const input = { name: "Report", description: "Private", body: "Write reports." };
    expect((await tools.callTool("save_partner_skill", input, undefined, { ...caller, generation: caller.generation + 1 })).isError).toBe(true);
    expect((await tools.callTool("save_partner_skill", input, undefined, { ...caller, targetId: "foreign" })).isError).toBe(true);
    expect((await tools.callTool("save_partner_skill", { ...input, body: "Authorization: Bearer sk-test-should-never-enter-files" }, undefined, caller)).isError).toBe(true);
    expect((await owner.list(partner.id)).total).toBe(0);
    await f.manager.setLifecycle(partner.id, partner.revision, "paused");
    expect((await tools.callTool("save_partner_skill", input, undefined, caller)).isError).toBe(true);
    expect(owner.owner(partner.id).readOnly).toBe(false);
    const archived = await f.manager.createPartner(partnerInput(f.partnerStore, "Archived skill owner"));
    await f.manager.setLifecycle(archived.id, archived.revision, "archived"); expect(owner.owner(archived.id).readOnly).toBe(true);
    expect((await tools.callTool("list_partner_skills", {}, undefined, caller)).isError).toBe(true);
    expect((await readdir(join(resourcesRoot(f), ".skill-transactions"))).length).toBe(0);
  });

  it("searches complete personal metadata and projects a large skill through discovery without clipping original resources", async () => {
    const f = await createFixture(0, true), partner = await f.manager.createPartner(partnerInput(f.partnerStore, "Large personal skill"));
    const resources = new PiResourceManager({ store: f.operationalStore, managedRoot: resourcesRoot(f) }); await resources.initialize();
    const owner = new PartnerSkillsManager(f.manager, f.partnerStore, f.operationalStore, resources, new SkillMutationCoordinator());
    const task = f.operationalStore.getSession(partner.canonicalSessionId!).descriptor;
    await owner.saveForCaller({ sessionId: task.id, targetId: task.targetId, generation: task.binding.generation }, { name: "Large", description: "Start", body: "Initial." });
    const initial = (await owner.list(partner.id)).skills[0]!;
    const boundary = await owner.update(create(contract.UpdatePartnerSkillRequestSchema, { partnerId: partner.id, skillId: initial.id,
      expectedPartnerRevision: revision(partner.revision), expectedRevision: initial.revision,
      expectedContentRevision: initial.contentRevision, name: "Large", description: "Start", body: "a".repeat(54_000) }));
    expect(boundary.skill.readOnly).toBe(true); expect(boundary.skill.bodyBytes).toBe(54000n); expect(boundary.skill.body.length).toBe(12_002);
    const entry = boundary.skill.summary!, draft = join(f.directory, "large-draft"); await mkdir(draft);
    const lease = await resources.acquireSkillContent({ resourceId: entry.id, expectedResourceVersion: entry.revision!.value }); await lease.snapshotTo(draft); await lease.release();
    const body = "full instruction\n".repeat(5_000), description = `${"Detailed metadata ".repeat(1_200)}deep-metadata-match`;
    await writeFile(join(draft, "SKILL.md"), renderSkillFile({ slug: "large", name: "Large", description, updatedAt: "2026-10-12T00:00:00Z", body }));
    await writeFile(join(draft, "asset.bin"), Buffer.from([0, 255, 13]));
    const prepared = await resources.prepareReplaceSkillContent({ resourceId: entry.id, expectedResourceVersion: entry.revision!.value,
      expectedObservedRevision: entry.contentRevision, candidateRoot: draft, changedByConnectionId: "test", name: "large" });
    await resources.completePreparedMutation(prepared, finalize => f.operationalStore.transaction(store => finalize(store)));
    expect((await owner.list(partner.id, "deep-metadata-match")).total).toBe(1);
    const value = await owner.read(partner.id, entry.id); expect(value.skill.readOnly).toBe(true); expect(value.skill.body.length).toBe(12_002);
    const seeds = await resources.runtimeSkillSnapshot(task.backendId, task.targetId, new AbortController().signal);
    const native = await snapshotNativeSkills(seeds, new AbortController().signal);
    try {
      expect(native.skills).toHaveLength(1); expect(native.skills[0]!.discovery).toBe(true); expect(native.indexedResourceIds).toEqual([entry.id]);
      const row = JSON.parse((await readFile(join(native.pluginRoot, "catalog.jsonl"), "utf8")).trim()) as { filePath: string };
      expect(await readFile(row.filePath, "utf8")).toContain(body.trim()); expect(await readFile(join(row.filePath, "..", "asset.bin"))).toEqual(Buffer.from([0, 255, 13]));
    } finally { await native.dispose(); }
    await expect(owner.update(create(contract.UpdatePartnerSkillRequestSchema, { partnerId: partner.id, skillId: entry.id,
      expectedPartnerRevision: revision(partner.revision), expectedRevision: value.skill.summary!.revision,
      expectedContentRevision: value.skill.summary!.contentRevision, name: "Large", description: "Clipped", body: value.skill.body }))).rejects.toMatchObject({ code: Code.FailedPrecondition });
    const path = join(f.operationalStore.getTarget(task.targetId).descriptor.workspaceRoot, ".agents", "skills", "large", "SKILL.md");
    expect(await readFile(path, "utf8")).toContain(description);
  });

  it("recovers uncommitted personal creation and rolls back a failed Store adoption before another save", async () => {
    const f = await createFixture(0, true), partner = await f.manager.createPartner(partnerInput(f.partnerStore, "Recovered personal skill"));
    const resources = new PiResourceManager({ store: f.operationalStore, managedRoot: resourcesRoot(f) }); await resources.initialize();
    const owner = new PartnerSkillsManager(f.manager, f.partnerStore, f.operationalStore, resources, new SkillMutationCoordinator());
    const task = f.operationalStore.getSession(partner.canonicalSessionId!).descriptor;
    const caller = { sessionId: task.id, targetId: task.targetId, generation: task.binding.generation };
    const transaction = f.operationalStore.transaction.bind(f.operationalStore);
    const failure = vi.spyOn(f.operationalStore, "transaction").mockImplementationOnce(operation => transaction(store => {
      operation(store); throw new Error("Store adoption failed");
    }));
    await expect(owner.saveForCaller(caller, { name: "First", description: "Rollback", body: "Uncommitted." })).rejects.toThrow("Store adoption failed"); failure.mockRestore();
    expect((await owner.list(partner.id)).total).toBe(0);
    const root = f.operationalStore.getTarget(task.targetId).descriptor.workspaceRoot;
    await expect(lstat(join(root, ".agents", "skills", "first"))).rejects.toMatchObject({ code: "ENOENT" });
    const draft = join(f.directory, "crash-draft"); await mkdir(draft); await writeFile(join(draft, "SKILL.md"), renderSkillFile({ slug: "crash", name: "Crash", description: "Recovery", updatedAt: "2026-10-12", body: "Uncommitted crash." }));
    await resources.preparePartnerSkill({ partnerId: partner.id, backendId: task.backendId, targetId: task.targetId, slug: "crash", candidateRoot: draft, changedByConnectionId: "test" });
    expect(await readFile(join(root, ".agents", "skills", "crash", "SKILL.md"), "utf8")).toContain("Uncommitted crash");
    const reopened = new PiResourceManager({ store: f.operationalStore, managedRoot: resourcesRoot(f) }); await reopened.initialize();
    await expect(lstat(join(root, ".agents", "skills", "crash"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(join(resourcesRoot(f), ".skill-transactions"))).toEqual([]);
    const next = new PartnerSkillsManager(f.manager, f.partnerStore, f.operationalStore, reopened, new SkillMutationCoordinator());
    expect((await next.saveForCaller(caller, { name: "Recovered", description: "Safe", body: "Recovered content." })).created).toBe(true);
  });

  it("saves authenticated Partner connections with profile, preference and catalog fences and retains unavailable selections", async () => {
    const f = await createFixture(), partner = await f.manager.createPartner(partnerInput(f.partnerStore, "Connections"));
    const preferences = new PartnerConnectionPreferences(f.operationalStore), router = await connectionRouter(f);
    const manager = new PartnerConnectionsManager(f.manager, f.partnerStore, f.operationalStore, preferences, router);
    const auth = vi.fn(), service = createPartnerConnectService(f.manager, auth, undefined, undefined, undefined, manager);
    auth.mockImplementationOnce(() => { throw new ConnectError("Unauthorized", Code.Unauthenticated); });
    expect(() => service.getPartnerConnections(create(contract.GetPartnerConnectionsRequestSchema, { partnerId: partner.id }), context())).toThrow("Unauthorized");
    const initial = manager.read(partner.id); expect(initial.mcp?.mode).toBe(contract.PartnerConnectionMode.INHERIT);
    expect(initial.entries.map(entry => entry.id)).toEqual(["connected", "optional"]);
    const request = create(contract.UpdatePartnerConnectionsRequestSchema, { partnerId: partner.id, expectedPartnerRevision: revision(partner.revision), expectedCatalogRevision: initial.catalogRevision,
      mcp: { mode: contract.PartnerConnectionMode.ALLOWLIST, ids: ["connected"] }, toolsets: { mode: contract.PartnerConnectionMode.ALLOWLIST, ids: [] }, skills: { mode: contract.PartnerConnectionMode.ALLOWLIST, ids: [] } });
    const saved = create(contract.UpdatePartnerConnectionsResponseSchema, await service.updatePartnerConnections(request, context())).connections!;
    expect(saved.revision).toBeTruthy(); expect(manager.targetReferences(partner.homeTargetId)?.mcpIds).toEqual(new Set(["connected"]));
    expect(() => manager.update(request)).toThrow("Connection preferences");
    const server = router.get("connected"); await router.upsert({ id: "connected", displayName: "Connected", enabled: false, transport: "streamable_http", endpoint: "http://127.0.0.1:4321/mcp", credentialBindings: [] }, server.version);
    expect(() => manager.update(create(contract.UpdatePartnerConnectionsRequestSchema, { ...request, expectedRevision: saved.revision }))).toThrow("catalog changed");
    const unavailable = manager.read(partner.id); expect(unavailable.entries[0]?.available).toBe(false);
    expect(manager.update(create(contract.UpdatePartnerConnectionsRequestSchema, { ...request, expectedRevision: saved.revision, expectedCatalogRevision: unavailable.catalogRevision })).mcp?.ids).toEqual(["connected"]);
    const removed = manager.update(create(contract.UpdatePartnerConnectionsRequestSchema, { ...request, expectedRevision: saved.revision, expectedCatalogRevision: unavailable.catalogRevision, mcp: create(contract.PartnerConnectionSelectionSchema, { mode: contract.PartnerConnectionMode.ALLOWLIST, ids: [] }) }));
    expect(() => manager.update(create(contract.UpdatePartnerConnectionsRequestSchema, { ...request, expectedRevision: removed.revision, expectedCatalogRevision: unavailable.catalogRevision }))).toThrow("unavailable connection");
    const other = await f.manager.createPartner(partnerInput(f.partnerStore, "Other connections")); expect(preferences.read(other.homeTargetId).mcp.mode).toBe("inherit");
    expect(manager.runtimeIdentity(f.operationalStore.getSession(partner.canonicalSessionId!).descriptor)).toMatch(/^[0-9a-f]{64}$/u);
  });
  it("persists current connection preferences across SQLite reopen and removes only the selected home", async () => {
    const f = await createFixture(); const preferences = new PartnerConnectionPreferences(f.operationalStore);
    const first = await f.manager.createPartner(partnerInput(f.partnerStore, "First connections"));
    const other = await f.manager.createPartner(partnerInput(f.partnerStore, "Other persisted connections"));
    const saved = preferences.update(first.homeTargetId, undefined, { mcp: { mode: "allowlist", ids: ["server"] }, toolsets: { mode: "allowlist", ids: [] }, skills: { mode: "allowlist", ids: [] } });
    preferences.update(other.homeTargetId, undefined, { mcp: { mode: "allowlist", ids: [] }, toolsets: { mode: "inherit", ids: [] }, skills: { mode: "allowlist", ids: [] } });
    expect(() => preferences.update(first.homeTargetId, undefined, { mcp: { mode: "inherit", ids: [] }, toolsets: { mode: "inherit", ids: [] }, skills: { mode: "allowlist", ids: [] } })).toThrow("Connection preferences");
    await f.close(); const reopened = new OperationalStore(join(f.directory, "operational.db")); cleanups.push(() => reopened.close());
    const next = new PartnerConnectionPreferences(reopened); expect(next.read(first.homeTargetId)).toEqual(saved);
    next.remove(first.homeTargetId); expect(next.read(first.homeTargetId).revision).toBeUndefined(); expect(next.read(other.homeTargetId).mcp.mode).toBe("allowlist");
  });
  it("uses current private user context at runtime boundaries, retains imported instructions and rejects retired owners", async () => {
    const f = await createFixture(); const partner = await f.manager.createPartner(partnerInput(f.partnerStore, "Runtime context"));
    const preferences = new PartnerMemoryPreferences(f.operationalStore, await CredentialVault.open(join(f.directory, "master.key")));
    const session = f.operationalStore.getSession(partner.canonicalSessionId!).descriptor;
    const read = vi.fn(async (_id: string, assertCurrent: () => void) => { assertCurrent(); return undefined as { profileProjection: { identity: string; user: string; instructions: string } } | undefined; });
    const memory = new MakerMemoryController({ store: f.operationalStore, targetPreferences: preferences }); cleanups.push(() => memory.dispose());
    const resolver = new PartnerRuntimePromptResolver(f.partnerStore, f.operationalStore, preferences, read, memory);
    const before = f.operationalStore.getSession(session.id);
    expect(await resolver.resolve(session, () => undefined)).toContain(partner.identitySource);
    expect(await resolver.resolve(session, () => undefined)).toContain("Current index");
    let saved = preferences.update(partner.homeTargetId, undefined, { enabled: false, userContext: "User profile stays independent of memory." });
    expect(await resolver.resolve(session, () => undefined)).toContain("User profile stays independent of memory.");
    expect(await resolver.resolve(session, () => undefined)).not.toContain("Current index");
    read.mockResolvedValue({ profileProjection: { identity: partner.identitySource, user: "Imported profile.", instructions: "Complete imported instructions." } });
    const overridden = await resolver.resolve(session, () => undefined);
    expect(overridden).toContain("Complete imported instructions."); expect(overridden).not.toContain("Imported profile.");
    saved = preferences.update(partner.homeTargetId, saved.revision, { userContext: "" });
    expect(await resolver.resolve(session, () => undefined)).not.toContain("User context");
    expect(f.operationalStore.getSession(session.id)).toEqual(before);
    let finish!: () => void; const gate = new Promise<void>(resolve => { finish = resolve; });
    read.mockImplementation(async () => { await gate; return undefined; });
    const pending = resolver.resolve(session, () => undefined); await f.manager.setLifecycle(partner.id, partner.revision, "paused"); finish();
    await expect(pending).rejects.toThrow("owner changed"); expect(await resolver.resolve(session, () => undefined)).toBeUndefined();
  });
  it("keeps memory preferences private across reopen, fences concurrent updates and disables only the owned target", async () => {
    const f = await createFixture(); const partner = await f.manager.createPartner(partnerInput(f.partnerStore, "Private preferences"));
    const other = await f.manager.createPartner(partnerInput(f.partnerStore, "Other preferences"));
    const keyPath = join(f.directory, "master.key"); const vault = await CredentialVault.open(keyPath);
    const preferences = new PartnerMemoryPreferences(f.operationalStore, vault, async (_id, assertCurrent) => { assertCurrent(); return "Inherited complete user context."; });
    const memory = new MakerMemoryController({ store: f.operationalStore, targetPreferences: preferences }); cleanups.push(() => memory.dispose());
    const manager = new PartnerMemoryManager(f.manager, f.operationalStore, memory, preferences);
    const auth = vi.fn(); const service = createPartnerConnectService(f.manager, auth, undefined, undefined, manager);
    auth.mockImplementationOnce(() => { throw new ConnectError("Unauthorized", Code.Unauthenticated); });
    await expect(service.getPartnerMemoryPreferences(create(contract.GetPartnerMemoryPreferencesRequestSchema, { partnerId: partner.id }), context())).rejects.toMatchObject({ code: Code.Unauthenticated });
    const initial = create(contract.GetPartnerMemoryPreferencesResponseSchema, await service.getPartnerMemoryPreferences(create(contract.GetPartnerMemoryPreferencesRequestSchema, { partnerId: partner.id }), context())).preferences!;
    expect(initial).toMatchObject({ enabled: true, userContext: "Inherited complete user context." }); expect(initial.revision).toBeUndefined();
    const request = create(contract.UpdatePartnerMemoryPreferencesRequestSchema, { partnerId: partner.id, expectedPartnerRevision: revision(partner.revision), enabled: false, userContext: "Complete private preferences. 中文。" });
    const saved = create(contract.UpdatePartnerMemoryPreferencesResponseSchema, await service.updatePartnerMemoryPreferences(request, context())).preferences!;
    expect(saved.owner?.memoryEnabled).toBe(false); expect(saved.revision).toBeTruthy();
    await expect(service.updatePartnerMemoryPreferences(request, context())).rejects.toMatchObject({ code: Code.Aborted });
    await expect(service.updatePartnerMemoryPreferences(create(contract.UpdatePartnerMemoryPreferencesRequestSchema, { ...request, expectedRevision: saved.revision,
      userContext: `api_key=sk-${"a".repeat(36)}` }), context())).rejects.toMatchObject({ code: Code.InvalidArgument });
    await expect(service.updatePartnerMemoryPreferences(create(contract.UpdatePartnerMemoryPreferencesRequestSchema, { ...request, expectedRevision: saved.revision,
      userContext: "x".repeat(12_001) }), context())).rejects.toMatchObject({ code: Code.InvalidArgument });
    expect(memory.runtimePrompt(partner.homeTargetId)).toBeUndefined(); expect(memory.runtimePrompt(other.homeTargetId)).toContain("Current index");
    expect(memory.writeCompactionDigest({ targetId: partner.homeTargetId, backendId: PROFILE.id, sessionId: partner.canonicalSessionId!, summary: "No new memory.", reason: "auto" })).toBe(false);
    const bridge = new MakerMemoryBridgeProvider(memory);
    expect(bridge.includeForTarget(partner.homeTargetId)).toBe(false); expect(bridge.includeForTarget(other.homeTargetId)).toBe(true);
    await expect(bridge.callTool("memory_list", {}, undefined, { targetId: partner.homeTargetId } as BridgeToolCallContext)).rejects.toThrow("disabled");
    const stored = f.operationalStore.getSetting("target", partner.homeTargetId, "partner-memory.preferences");
    expect(JSON.stringify(stored.value)).not.toContain("private preferences");
    expect(f.operationalStore.listEvents({ sessionId: partner.canonicalSessionId! }).some(event => JSON.stringify(event, (_key, value: unknown) => typeof value === "bigint" ? value.toString() : value).includes("private preferences"))).toBe(false);
    const next = await manager.updatePreferences(create(contract.UpdatePartnerMemoryPreferencesRequestSchema, { partnerId: partner.id, expectedPartnerRevision: revision(partner.revision), expectedRevision: saved.revision, userContext: "" }));
    expect(next.preferences?.userContext).toBe(""); expect(next.preferences?.enabled).toBe(false); expect(auth).toHaveBeenCalledTimes(8);
    const restored = await manager.updatePreferences(create(contract.UpdatePartnerMemoryPreferencesRequestSchema, { partnerId: partner.id, expectedPartnerRevision: revision(partner.revision), expectedRevision: next.preferences!.revision, userContext: request.userContext }));
    memory.dispose(); await f.close();
    const reopenedStore = new OperationalStore(join(f.directory, "operational.db"));
    try { const reopened = new PartnerMemoryPreferences(reopenedStore, await CredentialVault.open(keyPath));
      expect(reopened.read(partner.homeTargetId)).toEqual({ enabled: false, userContext: request.userContext, revision: restored.preferences!.revision!.value });
      reopenedStore.setSetting("target", other.homeTargetId, "partner-memory.preferences", stored.value);
      expect(() => reopened.read(other.homeTargetId)).toThrow("unavailable"); reopened.remove(other.homeTargetId);
    } finally { reopenedStore.close(); }
  });
  it("edits only current owned curated memories and atomically refreshes the same private FTS entry", async () => {
    const f = await createFixture(); const partner = await f.manager.createPartner(partnerInput(f.partnerStore, "Memory partner"));
    const other = await f.manager.createPartner(partnerInput(f.partnerStore, "Other memory partner"));
    const memory = new MakerMemoryController({ store: f.operationalStore }); cleanups.push(() => memory.dispose());
    const refresh = vi.spyOn(memory, "requestEntriesRefresh");
    const authenticate = vi.fn(); const service = createPartnerConnectService(f.manager, authenticate, undefined, undefined,
      new PartnerMemoryManager(f.manager, f.operationalStore, memory));
    const write = (targetId: string, kind: "user" | "project" | "digest", slug: string) => f.operationalStore.putMakerMemoryEntry({ targetId, kind, slug,
      ...(kind === "digest" ? { backendId: PROFILE.id } : {}), title: slug, description: "Original description", body: "Original release policy." });
    const entry = write(partner.homeTargetId, "project", "release"); const digest = write(partner.homeTargetId, "digest", "digest-release");
    const foreign = write(other.homeTargetId, "user", "foreign");
    authenticate.mockImplementationOnce(() => { throw new ConnectError("Unauthorized", Code.Unauthenticated); });
    expect(() => service.listPartnerMemories(create(contract.ListPartnerMemoriesRequestSchema, { partnerId: partner.id }), context())).toThrow(ConnectError);
    const list = create(contract.ListPartnerMemoriesResponseSchema, await service.listPartnerMemories(create(contract.ListPartnerMemoriesRequestSchema, { partnerId: partner.id, query: "release" }), context()));
    expect(list.groups.flatMap(group => group.entries).map(item => item.entryId)).toEqual([entry.id]);
    for (const entryId of [digest.id, foreign.id]) expect(() => service.readPartnerMemory(create(contract.ReadPartnerMemoryRequestSchema,
      { partnerId: partner.id, entryId }), context())).toThrow(ConnectError);
    const request = create(contract.UpdatePartnerMemoryRequestSchema, { partnerId: partner.id, entryId: entry.id,
      expectedPartnerRevision: revision(partner.revision), expectedRevision: revision(entry.revision), title: "记".repeat(100), body: "# New policy\n- Deploy after review! Then continue." });
    const saved = create(contract.UpdatePartnerMemoryResponseSchema, await service.updatePartnerMemory(request, context()));
    expect(saved.entry!.summary!.title).toBe("记".repeat(100)); expect(saved.entry!.summary!.entryId).toBe(entry.id);
    expect(f.operationalStore.getMakerMemoryEntry(entry.id).description).toBe("New policy Deploy after review!");
    expect(f.operationalStore.searchMakerMemory(partner.homeTargetId, "deploy", { kind: "project" }).map(item => item.id)).toEqual([entry.id]);
    expect(refresh).toHaveBeenCalledOnce();
    expect(() => service.updatePartnerMemory(request, context())).toThrow(ConnectError);
    const currentRevision = saved.entry!.summary!.revision!;
    expect(() => service.updatePartnerMemory(create(contract.UpdatePartnerMemoryRequestSchema, { ...request, expectedRevision: currentRevision,
      body: `api_key=sk-${"a".repeat(36)}` }), context())).toThrow(ConnectError);
    expect(f.operationalStore.getMakerMemoryEntry(entry.id).body).toBe(request.body);
    const removed = await service.deletePartnerMemory(create(contract.DeletePartnerMemoryRequestSchema, { partnerId: partner.id,
      entryId: entry.id, expectedPartnerRevision: revision(partner.revision), expectedRevision: currentRevision }), context());
    expect(removed.entryId).toBe(entry.id); expect(refresh).toHaveBeenCalledTimes(2);
    expect((await service.readPartnerMemory(create(contract.ReadPartnerMemoryRequestSchema, { partnerId: partner.id, entryId: entry.id }), context())).entry).toBeUndefined();
    expect(f.operationalStore.searchMakerMemory(partner.homeTargetId, "deploy")).toEqual([]);
    expect(f.operationalStore.getMakerMemoryEntry(digest.id)).toBeTruthy(); expect(f.operationalStore.getMakerMemoryEntry(foreign.id)).toBeTruthy();
  });

  it("keeps stopped memory readable, fences profile revisions and coalesces refresh failures without undoing saves", async () => {
    const f = await createFixture(); const partner = await f.manager.createPartner(partnerInput(f.partnerStore, "Stored memory"));
    const refresh = vi.fn(async () => { throw new Error("Runtime unavailable"); });
    const memory = new MakerMemoryController({ store: f.operationalStore, onSettingsChanged: refresh }); cleanups.push(() => memory.dispose());
    const manager = new PartnerMemoryManager(f.manager, f.operationalStore, memory);
    const entry = f.operationalStore.putMakerMemoryEntry({ targetId: partner.homeTargetId, kind: "user", slug: "working", title: "Working", description: "Working preference", body: "Use plain words." });
    const paused = await f.manager.setLifecycle(partner.id, partner.revision, "paused");
    const request = create(contract.UpdatePartnerMemoryRequestSchema, { partnerId: partner.id, entryId: entry.id, expectedPartnerRevision: revision(partner.revision),
      expectedRevision: revision(entry.revision), title: entry.title, body: "Use clear words." });
    expect(() => manager.update(request)).toThrow(ConnectError);
    vi.useFakeTimers();
    try {
      const result = manager.update(create(contract.UpdatePartnerMemoryRequestSchema, { ...request, expectedPartnerRevision: revision(paused.revision) }));
      expect(result.entry?.body).toBe("Use clear words.");
      manager.update(create(contract.UpdatePartnerMemoryRequestSchema, { ...request, expectedPartnerRevision: revision(paused.revision),
        expectedRevision: result.entry!.summary!.revision, body: "Use concise words." }));
      await vi.advanceTimersByTimeAsync(3000); expect(refresh).toHaveBeenCalledOnce();
      expect(manager.read(partner.id, entry.id).entry?.body).toBe("Use concise words.");
    } finally { vi.useRealTimers(); }
  });
  it("authenticates paused lifecycle changes, exposes cleanup status and resumes only the current revision", async () => {
    const f = await createFixture(); const partner = await f.manager.createPartner(partnerInput(f.partnerStore, "Paused API"));
    const authorize = vi.fn(() => ({ connectionId: "connection-1" })); const service = createPartnerConnectService(f.manager, authorize);
    const pause = create(contract.SetPartnerLifecycleRequestSchema, { partnerId: partner.id, expectedRevision: revision(partner.revision), lifecycle: contract.PartnerLifecycle.PAUSED });
    authorize.mockImplementationOnce(() => { throw new ConnectError("Unauthorized", Code.Unauthenticated); });
    await expect(service.setPartnerLifecycle(pause, context())).rejects.toMatchObject({ code: Code.Unauthenticated });
    expect(f.manager.getPartner(partner.id).lifecycle).toBe("active");
    const paused = (await service.setPartnerLifecycle(pause, context())).partner!;
    expect(paused).toMatchObject({ lifecycle: contract.PartnerLifecycle.PAUSED, pauseCleanupPending: false, canonicalSessionId: partner.canonicalSessionId });
    expect((await service.listPartners(create(contract.ListPartnersRequestSchema, { lifecycle: contract.PartnerLifecycle.PAUSED }), context())).partners).toHaveLength(1);
    await expect(service.setPartnerLifecycle(create(contract.SetPartnerLifecycleRequestSchema, { ...pause, lifecycle: contract.PartnerLifecycle.ACTIVE }), context())).rejects.toMatchObject({ code: Code.Aborted });
    const resume = create(contract.SetPartnerLifecycleRequestSchema, { ...pause, expectedRevision: create(contract.RevisionSchema, paused.revision), lifecycle: contract.PartnerLifecycle.ACTIVE });
    authorize.mockImplementationOnce(() => ({ connectionId: "connection-1" })).mockImplementationOnce(() => { throw new ConnectError("Revoked", Code.Unauthenticated); });
    await expect(service.setPartnerLifecycle(resume, context())).rejects.toMatchObject({ code: Code.Unauthenticated });
    const fresh = (await service.getPartner(create(contract.GetPartnerRequestSchema, { partnerId: partner.id }), context())).partner!;
    expect(fresh.lifecycle).toBe(contract.PartnerLifecycle.ACTIVE); expect(fresh.pauseCleanupPending).toBeUndefined();
    expect(fresh.canonicalSessionId).toBe(partner.canonicalSessionId);
  });
  it("authenticates restart controls and returns only a durable body-free shutdown receipt", async () => {
    const f = await createFixture(); const partner = await f.manager.createPartner(partnerInput(f.partnerStore, "Restart API"));
    const authorize = vi.fn(() => ({ connectionId: "connection-1" })); const service = createPartnerConnectService(f.manager, authorize);
    expect(await service.getPartnerRestartControls(create(contract.GetPartnerRestartControlsRequestSchema, { partnerId: partner.id }), context()))
      .toMatchObject({ available: true, revision: { value: partner.revision } });
    const input = { requestId: "restart-service-intent", partnerId: partner.id, expectedRevision: revision(partner.revision) };
    authorize.mockImplementationOnce(() => { throw new ConnectError("Unauthorized", Code.Unauthenticated); });
    await expect(service.restartPartner(create(contract.RestartPartnerRequestSchema, input), context())).rejects.toMatchObject({ code: Code.Unauthenticated });
    expect(f.manager.getRestart(input.requestId)).toBeUndefined();
    const result = await service.restartPartner(create(contract.RestartPartnerRequestSchema, input), context());
    expect(result.restart).toMatchObject({ requestId: input.requestId, partnerId: partner.id, phase: contract.PartnerRestartPhase.READY, runtimeClosePending: false });
    expect((await service.getPartnerRestart(create(contract.GetPartnerRestartRequestSchema, { requestId: input.requestId }), context())).restart).toEqual(result.restart);
    expect((await service.retryPartnerRestart(create(contract.RetryPartnerRestartRequestSchema, { requestId: input.requestId }), context())).restart).toEqual(result.restart);
    expect(JSON.stringify(result, (_key, value: unknown) => typeof value === "bigint" ? String(value) : value)).not.toContain(partner.displayName);
    expect((await service.listPartners(create(contract.ListPartnersRequestSchema), context())).partners).toHaveLength(1);
    const requestId = "restart-service-retired";
    expect((await service.retirePartnerRestart(create(contract.RetirePartnerRestartRequestSchema, { requestId }), context())).retired).toBe(true);
    await expect(service.restartPartner(create(contract.RestartPartnerRequestSchema, { ...input, requestId }), context())).rejects.toMatchObject({ code: Code.InvalidArgument });
  });
  it("authenticates confirmed deletion, exposes only body-free recovery and prevents setter or retired-intent bypass", async () => {
    const fixture = await createFixture(); const partner = await fixture.manager.createPartner(partnerInput(fixture.partnerStore, "Delete through API"));
    const authorize = vi.fn(() => ({ connectionId: "connection-1" })); const service = createPartnerConnectService(fixture.manager, authorize);
    await expect(service.setPartnerLifecycle(create(contract.SetPartnerLifecycleRequestSchema, { partnerId: partner.id,
      expectedRevision: revision(partner.revision), lifecycle: contract.PartnerLifecycle.DELETED }), context())).rejects.toMatchObject({ code: Code.InvalidArgument });
    const input = { requestId: "deletion-service-intent", partnerId: partner.id, expectedRevision: revision(partner.revision), confirmName: partner.displayName };
    await expect(service.deletePartner(create(contract.DeletePartnerRequestSchema, { ...input, confirmName: "Wrong" }), context())).rejects.toMatchObject({ code: Code.InvalidArgument });
    expect(fixture.manager.getPartner(partner.id).lifecycle).toBe("active");
    const result = await service.deletePartner(create(contract.DeletePartnerRequestSchema, input), context());
    expect(result.deletion).toMatchObject({ requestId: input.requestId, partnerId: partner.id, phase: contract.PartnerDeletionPhase.COMPLETED });
    const recovered = await service.getPartnerDeletion(create(contract.GetPartnerDeletionRequestSchema, { requestId: input.requestId }), context());
    expect(recovered.deletion).toEqual(result.deletion); expect(recovered.retired).toBe(false);
    expect(JSON.stringify(result, (_key, value: unknown) => typeof value === "bigint" ? String(value) : value)).not.toContain(partner.displayName);
    expect((await service.listPartners(create(contract.ListPartnersRequestSchema), context())).partners).toHaveLength(0);
    const absent = "deletion-service-retired";
    expect((await service.retirePartnerDeletion(create(contract.RetirePartnerDeletionRequestSchema, { requestId: absent }), context())).retired).toBe(true);
    expect((await service.getPartnerDeletion(create(contract.GetPartnerDeletionRequestSchema, { requestId: absent }), context())).retired).toBe(true);
    expect(authorize).toHaveBeenCalled();
  });
  it("owns decoded user images privately and authorizes only an exact live avatar read", async () => {
    const fixture = await createFixture();
    const { default: sharp } = await import("sharp");
    const photo = await sharp({ create: { width: 256, height: 256, channels: 3, background: "#ff9800" } }).jpeg().toBuffer();
    const service = createPartnerConnectService(fixture.manager, () => ({ connectionId: "connection-1" }));
    const request = create(contract.CreatePartnerRequestSchema, {
      requestId: "creation-request-image-rpc", expectedDirectoryRevision: revision(1n),
      draft: { displayName: "A".repeat(200), avatar: { value: { case: "imageBase64", value: photo.toString("base64") } },
        identitySource: "Product work", templateId: "general", capabilities: protoCapabilities() }
    });
    const created = await service.createPartner(request, context());
    expect(created.partner?.avatar?.value?.case).toBe("image");
    const image = created.partner?.avatar?.value;
    if (image?.case !== "image" || !image.value?.sha256) throw new Error("The image descriptor is required.");
    expect(image.value).toMatchObject({ mimeType: "image/jpeg", byteLength: BigInt(photo.length) });
    const read = create(contract.ReadPartnerAvatarRequestSchema, { partnerId: created.partner!.partnerId,
      expectedRevision: create(contract.RevisionSchema, created.partner!.revision), sha256: image.value.sha256 });
    expect((await service.readPartnerAvatar(read, context())).content).toEqual(new Uint8Array(photo));
    expect(() => service.readPartnerAvatar(create(contract.ReadPartnerAvatarRequestSchema, { ...read, sha256: "a".repeat(64) }), context()))
      .toThrow(expect.objectContaining({ code: Code.NotFound }));
    const denied = createPartnerConnectService(fixture.manager, () => { throw new ConnectError("Denied", Code.Unauthenticated); });
    expect(() => denied.readPartnerAvatar(read, context())).toThrow(expect.objectContaining({ code: Code.Unauthenticated }));
    await expect(service.createPartner(create(contract.CreatePartnerRequestSchema, { ...request, requestId: "creation-request-image-invalid",
      draft: { ...request.draft!, avatar: create(contract.PartnerAvatarInputSchema, { value: { case: "imageBase64", value: "/9j/2w==" } }) } }), context()))
      .rejects.toMatchObject({ code: Code.InvalidArgument });
    const updated = await service.updatePartner(create(contract.UpdatePartnerRequestSchema, {
      partnerId: read.partnerId, expectedRevision: read.expectedRevision, patch: { avatar: { value: { case: "presetId", value: "spark" } } }
    }), context());
    expect(updated.partner?.avatar?.value).toEqual({ case: "presetId", value: "spark" });
    expect(() => service.readPartnerAvatar(read, context())).toThrow(expect.objectContaining({ code: Code.Aborted }));
    expect(fixture.partnerStore.listPartners()).toHaveLength(1);
  });

  it("authenticates stable creation lookup and atomically retires absent intents against late creates", async () => {
    const fixture = await createFixture();
    const authenticate = vi.fn(() => ({ connectionId: "connection-1" }));
    const service = createPartnerConnectService(fixture.manager, authenticate);
    const callContext = context();
    const expectAuthentication = (...boundaries: string[]): void => {
      expect(authenticate.mock.calls, boundaries.join(" → ")).toEqual(boundaries.map(() => [callContext]));
      authenticate.mockClear();
    };
    const request = create(contract.CreatePartnerRequestSchema, {
      requestId: "creation-request-rpc",
      expectedDirectoryRevision: revision(1n),
      draft: { displayName: "Aster", avatar: { value: { case: "presetId" as const, value: "orbit" } }, identitySource: "You help with ongoing work.", templateId: "general", capabilities: protoCapabilities() }
    });
    const created = await service.createPartner(request, callContext);
    expectAuthentication("request", "after avatar validation, before create commit", "before response");
    const found = await service.getPartnerCreation(create(contract.GetPartnerCreationRequestSchema, { requestId: request.requestId }), callContext);
    expectAuthentication("request");
    expect(found.partner).toEqual(created.partner);
    expect((await service.createPartner(request, callContext)).partner).toEqual(created.partner);
    expectAuthentication("request", "after avatar validation, before replay lookup", "before response");
    await expect(service.createPartner(create(contract.CreatePartnerRequestSchema, { ...request, draft: { ...request.draft!, displayName: "Changed intent" } }), callContext))
      .rejects.toMatchObject({ code: Code.Aborted });
    expectAuthentication("request", "after avatar validation, before conflicting create");
    await expect(service.createPartner(create(contract.CreatePartnerRequestSchema, { ...request, requestId: "", expectedDirectoryRevision: create(contract.RevisionSchema, created.directory!.revision) }), callContext))
      .rejects.toMatchObject({ code: Code.InvalidArgument });
    expectAuthentication("request", "after avatar validation, before invalid request ID");
    await expect(service.createPartner(create(contract.CreatePartnerRequestSchema, { ...request, draft: { ...request.draft!, usesDirectoryDefaults: true } }), callContext))
      .rejects.toMatchObject({ code: Code.InvalidArgument });
    expectAuthentication("request, before invalid capability combination");
    const absent = "creation-request-absent-rpc";
    expect(() => service.getPartnerCreation(create(contract.GetPartnerCreationRequestSchema, { requestId: absent }), callContext))
      .toThrow(expect.objectContaining({ code: Code.NotFound }));
    expectAuthentication("request");
    const retired = await service.retirePartnerCreation(create(contract.RetirePartnerCreationRequestSchema, { requestId: absent }), callContext);
    expectAuthentication("request");
    expect(retired.retired).toBe(true);
    expect(retired.partner).toBeUndefined();
    await expect(service.createPartner(create(contract.CreatePartnerRequestSchema, { ...request, requestId: absent, expectedDirectoryRevision: create(contract.RevisionSchema, created.directory!.revision) }), callContext))
      .rejects.toMatchObject({ code: Code.FailedPrecondition });
    expectAuthentication("request", "after avatar validation, before retired intent lookup");
    expect(await service.retirePartnerCreation(create(contract.RetirePartnerCreationRequestSchema, { requestId: request.requestId }), callContext))
      .toMatchObject({ retired: false, partner: created.partner });
    expectAuthentication("request");
    const denied = createPartnerConnectService(fixture.manager, () => { throw new ConnectError("Denied", Code.Unauthenticated); });
    expect(() => denied.getPartnerCreation(create(contract.GetPartnerCreationRequestSchema, { requestId: request.requestId }), callContext))
      .toThrow(expect.objectContaining({ code: Code.Unauthenticated }));
    expect(() => denied.retirePartnerCreation(create(contract.RetirePartnerCreationRequestSchema, { requestId: absent }), callContext))
      .toThrow(expect.objectContaining({ code: Code.Unauthenticated }));
    expect(fixture.partnerStore.listPartners()).toHaveLength(1);
  });

  it("authenticates and maps defaults, creation, autosave fencing, and lifecycle", async () => {
    const fixture = await createFixture();
    const authenticate = vi.fn(() => ({ connectionId: "connection-1" }));
    const service = createPartnerConnectService(fixture.manager, authenticate);
    const callContext = context();
    const expectAuthentication = (...boundaries: string[]): void => {
      expect(authenticate.mock.calls, boundaries.join(" → ")).toEqual(boundaries.map(() => [callContext]));
      authenticate.mockClear();
    };

    const initial = await service.getPartnerDirectory(
      create(contract.GetPartnerDirectoryRequestSchema), callContext
    );
    expectAuthentication("request");
    expect(initial.directory).toMatchObject({
      revision: { value: 1n },
      activeCount: 0,
      archivedCount: 0,
      errorCount: 0,
      templates: expect.arrayContaining([expect.objectContaining({ templateId: "general" })]),
      avatarPresets: ["orbit", "spark", "leaf", "wave"]
    });

    const defaults = await service.updatePartnerDefaults(create(contract.UpdatePartnerDefaultsRequestSchema, {
      expectedDirectoryRevision: initial.directory!.revision,
      capabilities: protoCapabilities()
    }), callContext);
    expectAuthentication("request", "after updating defaults, before response");
    expect(defaults.directory).toMatchObject({ defaultCapabilities: protoCapabilities() });

    const created = await service.createPartner(create(contract.CreatePartnerRequestSchema, {
      requestId: "creation-request-first",
      expectedDirectoryRevision: defaults.directory!.revision,
      draft: create(contract.PartnerDraftSchema, {
        displayName: "Aster",
        avatar: { value: { case: "presetId" as const, value: "orbit" } },
        identitySource: "You are Aster, a long-lived work partner.",
        templateId: "general",
        usesDirectoryDefaults: true
      })
    }), callContext);
    expectAuthentication("request", "after avatar validation, before create commit", "before response");
    expect(created.partner).toMatchObject({
      displayName: "Aster",
      lifecycle: contract.PartnerLifecycle.ACTIVE,
      initializationState: contract.PartnerInitializationState.READY,
      invitationStage: contract.PartnerInvitationStage.READY,
      usesDirectoryDefaults: true,
      canonicalSessionId: expect.any(String)
    });
    const createdRevision = created.partner!.revision!;

    const updated = await service.updatePartner(create(contract.UpdatePartnerRequestSchema, {
      partnerId: created.partner!.partnerId,
      expectedRevision: createdRevision,
      patch: create(contract.PartnerPatchSchema, {
        displayName: "Aster Prime",
        usesDirectoryDefaults: false
      })
    }), callContext);
    expectAuthentication("request", "after serialization, before profile commit", "before response");
    expect(updated.partner).toMatchObject({
      displayName: "Aster Prime",
      usesDirectoryDefaults: false,
      initializationState: contract.PartnerInitializationState.READY
    });
    await expect(service.updatePartner(create(contract.UpdatePartnerRequestSchema, {
      partnerId: created.partner!.partnerId,
      expectedRevision: createdRevision,
      patch: create(contract.PartnerPatchSchema, { displayName: "Stale" })
    }), callContext)).rejects.toMatchObject({ code: Code.Aborted });
    expectAuthentication("request, before stale profile revision rejection");

    const archived = await service.setPartnerLifecycle(create(contract.SetPartnerLifecycleRequestSchema, {
      partnerId: updated.partner!.partnerId,
      expectedRevision: updated.partner!.revision,
      lifecycle: contract.PartnerLifecycle.ARCHIVED
    }), callContext);
    expectAuthentication("request", "after lifecycle update, before response");
    expect(archived.partner?.lifecycle).toBe(contract.PartnerLifecycle.ARCHIVED);
    const listed = await service.listPartners(create(contract.ListPartnersRequestSchema, {
      lifecycle: contract.PartnerLifecycle.ARCHIVED
    }), callContext);
    expectAuthentication("request");
    expect(listed.partners?.map((partner) => partner.partnerId) ?? []).toEqual([created.partner!.partnerId]);
    const restored = await service.setPartnerLifecycle(create(contract.SetPartnerLifecycleRequestSchema, {
      partnerId: archived.partner!.partnerId,
      expectedRevision: archived.partner!.revision,
      lifecycle: contract.PartnerLifecycle.ACTIVE
    }), callContext);
    expectAuthentication("request", "after lifecycle update, before response");
    expect(restored.partner?.lifecycle).toBe(contract.PartnerLifecycle.ACTIVE);
  });

  it("fails closed for unavailable ownership and invalid public enums", async () => {
    const unavailable = createPartnerConnectService(undefined, () => ({ connectionId: "connection-1" }));
    expect(() => unavailable.getPartnerDirectory(
      create(contract.GetPartnerDirectoryRequestSchema), context()
    )).toThrow(expect.objectContaining({ code: Code.Unimplemented }));

    const fixture = await createFixture();
    const service = createPartnerConnectService(fixture.manager, () => ({ connectionId: "connection-1" }));
    await expect(service.updatePartnerDefaults(create(contract.UpdatePartnerDefaultsRequestSchema, {
      expectedDirectoryRevision: revision(1n),
      capabilities: create(contract.PartnerCapabilitiesSchema, {
        ...protoCapabilities(),
        permissionMode: 999 as contract.PermissionMode
      })
    }), context())).rejects.toMatchObject({ code: Code.InvalidArgument });
  });

  it("maps activity, history, private threads, and revision-fenced delegation control", async () => {
    const fixture = await createFixture(2_000);
    const service = createPartnerConnectService(fixture.manager, () => ({ connectionId: "connection-1" }));
    const first = await fixture.manager.createPartner(partnerInput(fixture.partnerStore, "Aster"));
    const second = await fixture.manager.createPartner(partnerInput(fixture.partnerStore, "Beryl"));
    const delivery = await fixture.manager.sendPrivateMessage({
      callerSessionId: first.canonicalSessionId!,
      targetPartnerId: second.id,
      content: "Please inspect the recovery boundary."
    });

    const sessions = await service.listPartnerSessions(create(contract.ListPartnerSessionsRequestSchema, {
      partnerId: second.id
    }), context());
    expect(sessions.sessions).toEqual([
      expect.objectContaining({
        sessionId: second.canonicalSessionId,
        role: contract.PartnerSessionRole.CANONICAL,
        available: true,
        readOnly: false
      })
    ]);
    const threads = await service.listPartnerPrivateThreads(create(
      contract.ListPartnerPrivateThreadsRequestSchema,
      { partnerId: second.id }
    ), context());
    expect(threads.threads).toEqual([
      expect.objectContaining({ threadId: delivery.reservation.thread.id, messageCount: 1 })
    ]);
    const thread = await service.getPartnerPrivateThread(create(contract.GetPartnerPrivateThreadRequestSchema, {
      partnerId: second.id,
      threadId: delivery.reservation.thread.id
    }), context());
    expect(thread.messages).toEqual([
      expect.objectContaining({ content: "Please inspect the recovery boundary.", sequence: 1n })
    ]);
    const read = await service.markPartnerPrivateThreadRead(create(
      contract.MarkPartnerPrivateThreadReadRequestSchema,
      { partnerId: second.id, threadId: delivery.reservation.thread.id, throughSequence: 1n }
    ), context());
    expect(read.readState?.throughSequence).toBe(1n);

    expect(fixture.manager.activity(second.id).latestReplyCursor).toBeUndefined();
    expect(fixture.manager.activity(second.id).unreadReplyCount).toBe(0);
    fixture.sessionHost.enqueueServiceInput({ operationId: "public-canonical-rpc-input", sessionId: second.canonicalSessionId!, source: "system",
      prompt: { text: "A public canonical question", images: [], files: [], mentions: [], disposition: "prompt" } });
    await vi.waitFor(
      () => expect(fixture.manager.activity(second.id).latestReplyCursor).toBeDefined(),
      { timeout: 5_000 }
    );
    const beforeRead = await service.getPartner(create(contract.GetPartnerRequestSchema, {
      partnerId: second.id
    }), context());
    expect(beforeRead.partner?.activity?.unreadReplyCount).toBe(1n);
    expect(beforeRead.partner?.activity?.latestReplyPreview).toBe(fixture.manager.activity(second.id).latestReplyPreview);
    expect(beforeRead.partner?.activity?.latestReplyPreview).not.toContain("Please inspect the recovery boundary.");
    const marked = await service.markPartnerRead(create(contract.MarkPartnerReadRequestSchema, {
      partnerId: second.id,
      throughCursor: beforeRead.partner!.activity!.latestReplyCursor
    }), context());
    expect(marked.activity?.unreadReplyCount).toBe(0n);

    const delegation = await fixture.manager.startDelegation({
      callerSessionId: first.canonicalSessionId!,
      targetPartnerId: second.id,
      title: "Recovery audit",
      objective: "Audit the recovery boundary."
    });
    const listed = await service.listPartnerDelegations(create(contract.ListPartnerDelegationsRequestSchema, {
      partnerId: first.id
    }), context());
    expect(listed.delegations).toEqual([
      expect.objectContaining({
        delegationId: delegation.delegation.id,
        targetPartnerId: second.id,
        childSessionId: expect.any(String)
      })
    ]);
    await expect(service.cancelPartnerDelegation(create(contract.CancelPartnerDelegationRequestSchema, {
      partnerId: first.id,
      delegationId: delegation.delegation.id,
      expectedRevision: revision(999n)
    }), context())).rejects.toMatchObject({ code: Code.Aborted });
    const current = await service.getPartnerDelegation(create(contract.GetPartnerDelegationRequestSchema, {
      partnerId: first.id,
      delegationId: delegation.delegation.id
    }), context());
    const cancelled = await service.cancelPartnerDelegation(create(contract.CancelPartnerDelegationRequestSchema, {
      partnerId: first.id,
      delegationId: delegation.delegation.id,
      expectedRevision: current.delegation!.revision
    }), context());
    expect(cancelled.delegation?.status).toBe(contract.PartnerDelegationStatus.CANCELLED);
  });
});

async function createFixture(streamDelayMs = 0, skillResources = false, additionalAdapters: readonly FakeBackendAdapter[] = [], captureRuns = false) {
  const directory = mkdtempSync(join(tmpdir(), "joko-partner-service-"));
  const operationalStore = new OperationalStore(join(directory, "operational.db"));
  const partnerStore = new PartnerStore(join(directory, "partners.db"));
  const repository = new OperationalArtifactRepository(operationalStore);
  const artifacts = new ArtifactStore({ rootDirectory: join(directory, "artifacts"), repository, ingestRoots: [directory] });
  await artifacts.initialize();
  const changes = new WorkspaceChangeSetService({ snapshotDirectory: join(directory, "snapshots"), repository: new OperationalWorkspaceSnapshotRepository(operationalStore) });
  if (captureRuns) await changes.initialize();
  const workspaceCapture = captureRuns ? new DurableWorkspaceRunCapture(operationalStore, changes) : undefined;
  class OutputAdapter extends FakeBackendAdapter {
    override async send(input: PromptInput, adapterContext: AdapterContext): Promise<void> {
      if (captureRuns && adapterContext.target.id.startsWith("partner-task-target:"))
        await writeFile(join(adapterContext.target.workspaceRoot, "task-report.txt"), "Private report contents");
      return super.send(input, adapterContext);
    }
  }
  const sessionHost = new SessionHost(operationalStore, artifacts, [new OutputAdapter({
    ...PROFILE,
    ...(skillResources ? { capabilities: [...PROFILE.capabilities.filter(item => item.key !== "runtime.resources"), { key: "runtime.resources", supported: true, options: ["skill"] }] } : {}),
    streamDelayMs
    }), ...additionalAdapters], { ...(workspaceCapture === undefined ? {} : { workspaceCapture }), partnerSessionRetiring: (id) => partnerStore.isPartnerSessionRetiring(id)
    || partnerStore.isPartnerTargetRetiring(operationalStore.getSession(id).descriptor.targetId),
    partnerTargetRetired: (id) => partnerStore.isPartnerTargetRetired(id),
    partnerSessionRestarting: (id) => partnerStore.isPartnerSessionRestarting(id),
    partnerSessionPaused: (id) => partnerStore.isPartnerSessionPaused(id) });
  await sessionHost.initialize();
  const manager = new PartnerManager({
    store: partnerStore,
    operationalStore,
    sessionHost,
    workspaceService: { register: async (input) => input, unregister: () => undefined },
    homesRoot: join(directory, "partner-homes")
  });
  let closed = false;
  const close = async () => {
    if (closed) return;
    await sessionHost.dispose();
    partnerStore.close();
    operationalStore.close();
    closed = true;
  };
  cleanups.push(async () => {
    await close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { manager, partnerStore, sessionHost, operationalStore, directory, workspaceCapture, close };
}

function resourcesRoot(f: { directory: string }) { return join(f.directory, "resources"); }

function partnerInput(store: PartnerStore, displayName: string) {
  return {
    requestId: `creation-request-${store.directoryState().revision}`,
    expectedDirectoryRevision: store.directoryState().revision,
    displayName,
    avatar: "orbit",
    identitySource: `You are ${displayName}, a long-lived work partner.`,
    templateId: "general",
    capabilities: {
      modelChain: [{
        backendId: PROFILE.id,
        providerId: "test",
        modelId: "text",
        effort: "medium",
        fastMode: false
      }],
      permissionMode: "ask",
      planMode: false
    },
    usesDirectoryDefaults: false
  } as const;
}

function protoCapabilities(): contract.PartnerCapabilities {
  return create(contract.PartnerCapabilitiesSchema, {
    modelChain: [create(contract.PartnerModelRouteSchema, {
      backendId: PROFILE.id,
      providerId: "test",
      modelId: "text",
      effort: "medium",
      fastMode: false
    })],
    permissionMode: contract.PermissionMode.ASK,
    planMode: false
  });
}

function revision(value: bigint): contract.Revision {
  return create(contract.RevisionSchema, { value, etag: `W/"rev-${value.toString()}"` });
}

function context(): HandlerContext {
  return { signal: new AbortController().signal } as HandlerContext;
}

async function connectionRouter(f: Awaited<ReturnType<typeof createFixture>>): Promise<McpRouter> {
  const vault = await CredentialVault.open(join(f.directory, "connections.key"));
  const credentials = new CredentialManager({ vault, storagePath: join(f.directory, "connections-credentials.json") }); await credentials.initialize();
  const router = new McpRouter({ store: f.operationalStore, credentials, clientFactory: { connect: async () => ({
    listTools: async () => ({ tools: [{ name: "probe", description: "Probe", inputSchema: { type: "object" } }] }),
    callTool: async () => ({ content: [], isError: false }), readResource: async () => ({ contents: [] }), close: async () => undefined }) } });
  await router.initialize(); cleanups.push(() => router.dispose());
  await router.upsert({ id: "connected", displayName: "Connected", enabled: true, transport: "streamable_http", endpoint: "http://127.0.0.1:4321/mcp", credentialBindings: [] });
  for (const id of ["optional", "essential"]) router.registerBridgeToolProvider({ id, generation: 1, available: true,
    ...(id === "optional" ? { configurablePolicy: { id, displayName: "Optional", description: "Optional", productDefaultEnabled: true } } : {}), tools: [], callTool: async () => ({ content: [], isError: false }) });
  return router;
}
