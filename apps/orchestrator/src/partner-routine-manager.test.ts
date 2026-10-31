import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, type HandlerContext } from "@connectrpc/connect";
import * as contract from "@joko/contracts";
import { OperationalStore, PartnerStore, PartnerRoutineStore } from "@joko/store";
import { FakeBackendAdapter, PI_LIKE_PROFILE } from "@joko/testkit";
import type { AdapterContext, PromptInput, Routine } from "@joko/core";
import { projectPiInputSchema } from "@joko/adapter-pi";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OperationalArtifactRepository } from "./artifact-repository.js";
import { ArtifactStore } from "./artifact-store.js";
import { PartnerManager } from "./partner-manager.js";
import { PartnerRoutineManager } from "./partner-routine-manager.js";
import { createPartnerRoutineConnectService } from "./partner-routine-connect-service.js";
import { SessionHost } from "./session-host.js";
import { ScheduleCoordinator } from "./schedule-coordinator.js";
import { PartnerRoutineTools } from "./partner-routine-tools.js";
import { PartnerProfileTools } from "./partner-profile-tools.js";
import { PartnerSessionTaskManager } from "./partner-session-tasks.js";
import { PartnerConnectionsManager, PartnerConnectionPreferences } from "./partner-connections.js";
import { CredentialManager } from "./credential-manager.js";
import { CredentialVault } from "./credential-vault.js";
import { McpRouter } from "./mcp-router.js";
import { ScheduleHookScriptInstaller } from "./schedule-hook-script-installer.js";
import { ScheduleRunNotificationController } from "./schedule-run-notifications.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const profile = { ...PI_LIKE_PROFILE, capabilities: [...PI_LIKE_PROFILE.capabilities.map(capability => capability.key === "permission.modes"
  ? { ...capability, options: ["ask", "auto", "bypassPermissions"] } : capability), { key: "permission.change", supported: true }] };
const definition = { name: "Review changes", prompt: "Review the current home changes.", enabled: true, silentWhenIdle: true,
  triggers: [{ id: "hourly", kind: { case: "interval" as const, value: { intervalMs: 3600000n } } }] };
class RecordingAdapter extends FakeBackendAdapter {
  readonly sent: Array<{ sessionId: string; input: PromptInput }> = [];
  override async send(input: PromptInput, context: AdapterContext): Promise<void> { this.sent.push({ sessionId: context.sessionId, input }); await super.send(input, context); }
}
async function fixture(streamDelayMs = 0) {
  const root = await mkdtemp(join(tmpdir(), "joko-partner-routine-")); const store = new OperationalStore(join(root, "operational.db")); const profiles = new PartnerStore(join(root, "partners.db"));
  let partners: PartnerManager;
  const artifacts = new ArtifactStore({ rootDirectory: join(root, "artifacts"), repository: new OperationalArtifactRepository(store), ingestRoots: [root] }); await artifacts.initialize();
  const adapter = new RecordingAdapter({ ...profile, streamDelayMs }); const host = new SessionHost(store, artifacts, [adapter], {
    partnerSessionRetiring: id => profiles.isPartnerSessionRetiring(id) || partners?.isRoutineSessionRetiring(id) === true || profiles.isPartnerTargetRetiring(store.getSession(id).descriptor.targetId),
    partnerTargetRetired: id => profiles.isPartnerTargetRetired(id), partnerSessionRestarting: id => profiles.isPartnerSessionRestarting(id),
    partnerSessionPaused: id => profiles.isPartnerSessionPaused(id) }); await host.initialize();
  let routines: PartnerRoutineManager;
  partners = new PartnerManager({ store: profiles, operationalStore: store, sessionHost: host, homesRoot: join(root, "homes"),
    routineModel: (partnerId, key) => routines?.engine.list(partnerId).find(item => key === `routine:${item.id}` || key.startsWith(`routine:${item.id}:`))?.modelOverride ?? undefined,
    workspaceService: { register: async input => input, unregister: () => undefined }, onRoutineLifecycle: (id, state) => routines.lifecycle(id, state) });
  const scheduler = new ScheduleCoordinator(store, host); const storage = new PartnerRoutineStore(join(root, "routines"));
  routines = new PartnerRoutineManager({ partners, store, scheduler, storage }); await routines.start(); scheduler.start();
  const created = await partners.createPartner({ requestId: "partner-routine-owner", expectedDirectoryRevision: profiles.directoryState().revision, displayName: "Reviewer", avatar: "orbit",
    identitySource: "You review work in this home.", templateId: "general", usesDirectoryDefaults: false,
    capabilities: { modelChain: [{ backendId: profile.id, providerId: "test", modelId: "text", effort: "medium", fastMode: false }], permissionMode: "ask", planMode: false } });
  cleanups.push(async () => { await routines.stop(); await scheduler.stop(); await host.dispose(); profiles.close(); store.close(); await rm(root, { recursive: true, force: true }); });
  await vi.waitFor(() => expect(partners.getPartner(created.id).initializationState).toBe("ready"), { timeout: 5000 });
  const partner = partners.getPartner(created.id);
  adapter.sent.length = 0;
  return { root, store, profiles, host, partners, partner, routines, storage, adapter, scheduler };
}
function context(): HandlerContext { return { signal: new AbortController().signal } as HandlerContext; }
async function toolsFixture(f: Awaited<ReturnType<typeof fixture>>) {
  const vault = await CredentialVault.open(join(f.root, "tools.key"));
  const credentials = new CredentialManager({ vault, storagePath: join(f.root, "tools-credentials.json") }); await credentials.initialize();
  const router = new McpRouter({ store: f.store, credentials }); await router.initialize();
  const tasks = new PartnerSessionTaskManager(f.store, f.partners, f.host, { register: async input => input }, f.root);
  const connections = new PartnerConnectionsManager(f.partners, f.profiles, f.store, new PartnerConnectionPreferences(f.store), router);
  const profiles = new PartnerProfileTools(f.partners, tasks, connections, { enabled: () => true });
  const notifications = new ScheduleRunNotificationController(f.store);
  const tools = new PartnerRoutineTools(f.routines, profiles, new ScheduleHookScriptInstaller(), notifications);
  router.registerBridgeToolProvider(tools);
  cleanups.push(async () => { await router.dispose(); await tasks.close(); });
  const session = f.store.getSession(f.partner.canonicalSessionId!).descriptor;
  const caller = { sessionId: session.id, targetId: session.targetId, generation: session.binding.generation, providerGeneration: 1, effectIdentity: "a".repeat(64) };
  return { tools, router, caller, notifications };
}
describe("Partner routine authority and independent execution", () => {
  it.each(['persistent', 'fresh'] as const)('runs %s routines with their own model, history and Partner identity', async sessionMode => {
    const f = await fixture(), canonical = f.store.getSession(f.partner.canonicalSessionId!).descriptor;
    const modelOverride = { backendId: profile.id, providerId: 'vision', modelId: 'multimodal', effort: 'high', fastMode: false } as const;
    const saved = await f.routines.save({ partnerId: f.partner.id, partnerRevision: f.partner.revision, requestId: `routine-model-${sessionMode}-creation`,
      definition: { name: 'Independent review', prompt: 'Review this home.', enabled: false, silentWhenIdle: true,
        triggers: [], sessionMode, modelOverride } });
    for (let index = 0; index < 2; index++) {
      await f.routines.run({ partnerId: f.partner.id, partnerRevision: f.partner.revision, routineId: saved.id,
        revision: saved.revision, requestId: `routine-model-${sessionMode}-run-${index}` });
      await vi.waitFor(() => expect(f.routines.history(f.partner.id, saved.id).runs.filter(run => run.status === 'success')).toHaveLength(index + 1));
    }
    const runs = f.routines.history(f.partner.id, saved.id).runs;
    const sessions = runs.map(run => f.store.getSession(run.sessionId!).descriptor);
    expect(new Set(sessions.map(session => session.id)).size).toBe(sessionMode === 'fresh' ? 2 : 1);
    for (const session of sessions) {
      expect(session.id).not.toBe(canonical.id);
      expect(session).toMatchObject({ providerId: 'vision', modelId: 'multimodal', effort: 'high',
        permissionMode: canonical.permissionMode, planMode: canonical.planMode, targetId: canonical.targetId, archived: sessionMode === 'fresh' });
      expect(f.profiles.getSessionLink(session.id)).toMatchObject({ role: 'routine', partnerId: f.partner.id, profileVersion: f.partner.profileVersion });
      expect(() => f.partners.canonicalCaller(session.id)).toThrow();
      if (sessionMode === 'persistent') {
        expect(f.partners.runtimeCaller(session.id).id).toBe(f.partner.id);
        expect(f.partners.routineFallback({ sessionId: session.id, current: modelOverride, currentHop: 0, visitedRoutes: [] })).toEqual({ owned: true });
      }
    }
    expect(f.store.getSession(canonical.id).descriptor).toEqual(canonical);
    expect(f.store.listQueueItems({ sessionId: canonical.id })).toEqual([]);
    expect((await f.storage.load())?.runs.filter(run => run.routineId === saved.id).map(run => run.sessionId).sort()).toEqual(runs.map(run => run.sessionId).sort());
    expect(f.adapter.sent).toHaveLength(2);
  });

  it('retains the original reserved routine identity after an unknown native creation', async () => {
    const f = await fixture();
    const create = vi.spyOn(f.host, 'createServiceSession').mockImplementation(async input => {
      await input.preparePrivateSession?.('routine-unknown-native', f.store.getTarget(f.partner.homeTargetId).descriptor);
      throw new Error('Native creation acknowledgement was lost.');
    });
    const input = { partnerId: f.partner.id, key: 'routine:unknown', title: 'Unknown creation', assertCurrent: () => undefined };
    await expect(f.partners.ensureRoutineSession(input)).rejects.toThrow();
    await expect(f.partners.ensureRoutineSession(input)).rejects.toThrow('original routine task');
    expect(create).toHaveBeenCalledOnce();
    expect(f.profiles.getSessionLink('routine-unknown-native')).toMatchObject({ role: 'routine', routineKey: input.key, partnerId: f.partner.id });
  });

  it("settles the exact routine after its own native runtime activation renews the Queue attempt", async () => {
    const f = await fixture();
    const saved = await f.routines.save({ partnerId: f.partner.id, partnerRevision: f.partner.revision,
      requestId: "routine-resume-creation", definition: { ...definition, enabled: false,
        triggers: [{ id: "timer", kind: "interval", intervalMs: 3600000 }] } });
    const { id: sessionId } = await f.partners.ensureRoutineSession({ partnerId: f.partner.id, key: `routine:${saved.id}`, title: saved.name, assertCurrent: () => undefined });
    await f.host.closeIfActive(sessionId);
    const before = f.store.getSession(sessionId).descriptor.binding;
    await f.routines.run({ partnerId: f.partner.id, partnerRevision: f.partner.revision, routineId: saved.id,
      revision: saved.revision, requestId: "routine-resume-explicit-run" });
    await vi.waitFor(() => expect(f.routines.history(f.partner.id, saved.id).runs[0]?.status).toBe("success"));
    const receipt = f.routines.history(f.partner.id, saved.id).runs[0]!;
    const after = f.store.getSession(sessionId).descriptor.binding;
    expect(after).toEqual({ ...before, generation: before.generation + 1 });
    const queue = f.store.findQueueItemByRunId(sessionId, receipt.scheduleRunId!)!;
    expect(f.store.getRun(receipt.scheduleRunId!).descriptor.activeAttemptId).toBe(queue.attemptId);
    expect(f.store.listAttempts(receipt.scheduleRunId!).map(attempt => attempt.descriptor.generation))
      .toEqual(expect.arrayContaining([before.generation, after.generation]));
    expect(f.adapter.sent).toHaveLength(1);
  });
  it.each(["binding-replacement", "generation-reset"] as const)("rejects an external %s after native routine completion", async change => {
    const f = await fixture();
    const dispatch = f.scheduler.runNowWithResult.bind(f.scheduler);
    vi.spyOn(f.scheduler, "runNowWithResult").mockImplementation(async (...args) => {
      const result = await dispatch(...args);
      await vi.waitFor(() => expect(f.store.getRun(result.runId).descriptor.state).toBe("completed"));
      const sessionId = f.store.getRun(result.runId).descriptor.sessionId;
      const current = f.store.getSession(sessionId);
      f.store.updateSession(sessionId, { binding: change === "binding-replacement"
        ? { ...current.descriptor.binding, opaqueRef: "external-native-replacement", nativeSessionId: "external-native-replacement" }
        : { ...current.descriptor.binding, generation: current.descriptor.binding.generation + 1 } }, current.revision);
      return result;
    });
    const saved = await f.routines.save({ partnerId: f.partner.id, partnerRevision: f.partner.revision,
      requestId: "routine-fenced-creation", definition: { ...definition, enabled: false,
        triggers: [{ id: "timer", kind: "interval", intervalMs: 3600000 }] } });
    await f.routines.run({ partnerId: f.partner.id, partnerRevision: f.partner.revision, routineId: saved.id,
      revision: saved.revision, requestId: "routine-fenced-explicit-run" });
    await vi.waitFor(() => expect(f.routines.history(f.partner.id, saved.id).runs[0]?.status).toBe("failed"));
    expect(f.adapter.sent).toHaveLength(1);
  });
  it("manages own routines through the frozen tool catalog and shared UI owner with stable execution receipts", async () => {
    const f = await fixture(200), t = await toolsFixture(f);
    const snapshot = t.router.createPiBridgeSnapshot({ endpoint: "http://127.0.0.1:4318/internal/mcp", sessionId: t.caller.sessionId,
      targetId: t.caller.targetId, expectedPiGeneration: t.caller.generation, includeToolPolicy: () => false });
    expect(snapshot.mcpBridge.tools.filter(tool => tool.serverId === t.tools.id).map(tool => tool.name)).toEqual(t.tools.tools.map(tool => tool.name).sort());
    const saveTool = t.tools.tools.find(tool => tool.name === "routine_save")!;
    expect(projectPiInputSchema(saveTool.inputSchema, saveTool.name).fields).toContainEqual(expect.objectContaining({
      fieldPath: "triggers[]", type: "object", required: true
    }));
    expect(saveTool.inputSchema).toMatchObject({ properties: { triggers: { items: { type: "object", oneOf: [
      { properties: { kind: { const: "cron" } } }, { properties: { kind: { const: "interval" } } },
      { properties: { kind: { const: "once" } } }, { properties: { kind: { const: "event" } } }
    ] } } } });
    const listed = await t.router.executeBridgeCall({ authorization: `Bearer ${snapshot.mcpBridge.token}`, requestId: "routine-tool-list", generation: t.caller.generation,
      sessionId: t.caller.sessionId, targetId: t.caller.targetId, serverId: t.tools.id, toolName: "routine_list", arguments: {} });
    expect(listed).toMatchObject({ isError: false, content: [{ type: "text", text: JSON.stringify({ ok: true, result: [] }) }] });
    expect((await t.tools.callTool("routine_sources", {}, undefined, t.caller)).structuredContent?.result).toEqual(f.routines.sources(f.partner.id));
    const installed = await t.tools.callTool("schedule_set_pre_run_hook", { script: "process.exit(2)", scheduleName: "Own check" }, undefined, t.caller);
    expect(installed.isError, JSON.stringify(installed)).toBe(false);
    const hook = installed.structuredContent!.result as { command: string; attached: boolean; test: { decision: string } };
    expect(hook).toMatchObject({ attached: false, test: { decision: "skip" } });
    const future = Date.now() + 86_400_000;
    const input = { name: "Own review", prompt: "Review current work.", enabled: false, silentWhenIdle: true, preRunHook: { command: hook.command }, triggers: [
      { id: "tick", kind: "interval", intervalMs: 3600000, anchorMs: future },
      { id: "once", kind: "once", at: future }, { id: "cron", kind: "cron", expression: "0 10 * * *", timezone: "Asia/Taipei" },
      { id: "event", kind: "event", sourceId: "plugin:review", eventType: "changed", filters: [{ field: "subject", operator: "contains", value: "work" }] }
    ] };
    const saved = await t.tools.callTool("routine_save", input, undefined, t.caller);
    expect(saved.isError, JSON.stringify(saved)).toBe(false);
    const routine = saved.structuredContent!.result as Routine;
    expect((await t.tools.callTool("routine_save", input, undefined, t.caller)).structuredContent!.result).toEqual(routine);
    const renamed = await t.tools.callTool("routine_save", { name: "Renamed", prompt: input.prompt, enabled: false, triggers: input.triggers,
      id: routine.id, expectedRevision: routine.revision }, undefined, t.caller);
    expect(renamed.isError, JSON.stringify(renamed)).toBe(false);
    const current = renamed.structuredContent!.result as Routine;
    expect(current).toMatchObject({ name: "Renamed", silentWhenIdle: true, preRunHook: { command: hook.command }, triggers: input.triggers });
    const service = createPartnerRoutineConnectService(f.routines, () => undefined);
    const visible = await service.listPartnerRoutines(create(contract.ListPartnerRoutinesRequestSchema, { partnerId: f.partner.id }), context());
    expect(visible.routines).toEqual([expect.objectContaining({ id: current.id, revision: expect.objectContaining({ value: BigInt(current.revision) }), definition: expect.objectContaining({ silentWhenIdle: true }) })]);
    const run = { id: current.id, expectedRevision: current.revision };
    expect((await t.tools.callTool("routine_run_now", run, undefined, { ...t.caller, effectIdentity: "b".repeat(64) })).isError).toBe(false);
    await vi.waitFor(() => expect(f.routines.history(f.partner.id, current.id).runs[0]?.status).toBe("skipped"));
    expect(f.adapter.sent).toEqual([]);
    const cleared = await t.tools.callTool("routine_save", { ...input, id: current.id, expectedRevision: current.revision,
      silentWhenIdle: false, preRunHook: null }, undefined, t.caller);
    expect(cleared.isError, JSON.stringify(cleared)).toBe(false);
    const ready = cleared.structuredContent!.result as Routine;
    expect(ready).not.toHaveProperty("preRunHook"); expect(ready.silentWhenIdle).toBe(false);
    const runCaller = { ...t.caller, effectIdentity: "c".repeat(64) };
    expect((await t.tools.callTool("routine_run_now", { id: ready.id, expectedRevision: ready.revision }, undefined, runCaller)).isError).toBe(false);
    await vi.waitFor(() => expect(f.adapter.sent).toHaveLength(1));
    const routineSession = f.store.getSession(f.adapter.sent[0]!.sessionId).descriptor;
    const notified = await t.tools.callTool("schedule_notify_current_run", {}, undefined, {
      ...t.caller, sessionId: routineSession.id, targetId: routineSession.targetId, generation: routineSession.binding.generation });
    expect(notified.isError, JSON.stringify(notified)).toBe(false);
    expect(t.notifications.hasOverride((notified.structuredContent!.result as { runId: string }).runId)).toBe(true);
    await vi.waitFor(() => expect(f.routines.history(f.partner.id, ready.id).runs[0]?.status).toBe("success"), { timeout: 5000 });
    expect((await t.tools.callTool("routine_run_now", { id: ready.id, expectedRevision: ready.revision }, undefined, runCaller)).isError).toBe(false);
    expect(f.adapter.sent).toHaveLength(1); expect(f.adapter.sent[0]?.sessionId).not.toBe(t.caller.sessionId);
    const history = await t.tools.callTool("routine_history", { id: ready.id }, undefined, t.caller);
    expect(history.structuredContent!.result).toMatchObject({ runs: [expect.objectContaining({ status: "success" }), expect.objectContaining({ status: "skipped" })] });
    expect((await t.tools.callTool("routine_delete", { id: ready.id, expectedRevision: ready.revision }, undefined, t.caller)).isError).toBe(false);
    expect(f.routines.list(f.partner.id)).toEqual([]); expect(f.store.findSchedule(`partner-routine-${ready.id}`)).toBeUndefined();
    expect((await t.tools.callTool("routine_save", input, undefined, t.caller)).isError).toBe(true);
  });
  it("rejects foreign or stale routine callers and cancelled management before committing a definition", async () => {
    const f = await fixture(), t = await toolsFixture(f);
    const raw = { ...definition, triggers: [{ id: "tick", kind: "interval" as const, intervalMs: 3600000 }], enabled: false };
    const other = await f.partners.createPartner({ requestId: "routine-other-owner", expectedDirectoryRevision: f.profiles.directoryState().revision,
      displayName: "Other", avatar: "orbit", identitySource: "Own other work.", templateId: "general", usesDirectoryDefaults: false, capabilities: f.partner.capabilities });
    await vi.waitFor(() => expect(f.partners.getPartner(other.id).initializationState).toBe("ready"));
    const foreign = await f.routines.save({ partnerId: other.id, partnerRevision: f.partners.getPartner(other.id).revision, requestId: "other-routine-definition", definition: raw });
    const invalid = [
      ["routine_list", { partnerId: other.id }, t.caller],
      ["routine_history", { id: foreign.id }, t.caller],
      ["routine_delete", { id: foreign.id, expectedRevision: foreign.revision }, t.caller],
      ["routine_save", raw, { ...t.caller, effectIdentity: undefined }],
      ["routine_save", { ...raw, silentWhenIdle: null }, t.caller],
      ["routine_save", { ...raw, triggers: [{ ...raw.triggers[0], sourceId: "spoof" }] }, t.caller],
      ["routine_list", {}, { ...t.caller, generation: t.caller.generation + 1 }],
      ["routine_list", {}, { ...t.caller, sessionId: other.canonicalSessionId! }],
      ["schedule_set_pre_run_hook", { script: "process.exit(0)", workingDir: f.root }, t.caller],
      ["schedule_notify_current_run", { runId: "selected-run" }, t.caller]
    ] as const;
    for (const [name, input, caller] of invalid) expect((await t.tools.callTool(name, input, undefined, caller)).isError, name).toBe(true);
    const signal = new AbortController(); let release!: () => void;
    const admission = vi.spyOn(f.partners, "runOwnedManagement");
    const occupied = f.partners.runOwnedManagement(f.partner.id, f.partner.revision, () => new Promise<void>(resolve => { release = resolve; }));
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    const pending = t.tools.callTool("routine_save", raw, signal.signal, t.caller);
    expect(admission).toHaveBeenCalledTimes(2);
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    signal.abort(); release(); await occupied; await rejected;
    expect(f.routines.list(f.partner.id)).toEqual([]); expect(f.routines.list(other.id)).toEqual([foreign]);
    const saved = await t.tools.callTool("routine_save", raw, undefined, t.caller);
    const routine = saved.structuredContent!.result as Routine;
    expect((await t.tools.callTool("routine_save", { ...raw, id: routine.id, expectedRevision: routine.revision + 1 }, undefined, t.caller)).isError).toBe(true);
    const paused = await f.partners.setLifecycle(f.partner.id, f.partner.revision, "paused");
    expect(t.tools.includeForTarget(paused.homeTargetId)).toBe(false);
    expect((await t.tools.callTool("routine_list", {}, undefined, t.caller)).isError).toBe(true);
    expect(f.routines.list(paused.id)).toEqual([routine]);
  });
  it("suspends owned routines while paused and restores only definitions the user left enabled", async () => {
    const f = await fixture();
    const enabled = await f.routines.save({ partnerId: f.partner.id, partnerRevision: f.partner.revision, requestId: "pause-enabled-creation",
      definition: { ...definition, triggers: [{ id: "timer", kind: "interval", intervalMs: 3600000 }] } });
    const disabled = await f.routines.save({ partnerId: f.partner.id, partnerRevision: f.partner.revision, requestId: "pause-disabled-creation",
      definition: { ...definition, enabled: false, triggers: [{ id: "timer", kind: "interval", intervalMs: 3600000 }] } });
    const paused = await f.partners.setLifecycle(f.partner.id, f.partner.revision, "paused");
    expect(f.routines.catalog(paused.id).writable).toBe(false);
    expect((await f.storage.load())?.pausedPartnerIds).toContain(paused.id);
    expect(f.routines.list(paused.id).find(routine => routine.id === enabled.id)?.enabled).toBe(true);
    expect(f.routines.list(paused.id).find(routine => routine.id === disabled.id)?.enabled).toBe(false);
    await expect(f.routines.run({ partnerId: paused.id, partnerRevision: paused.revision, routineId: enabled.id, revision: enabled.revision, requestId: "pause-denied-run-intent" })).rejects.toThrow();
    await f.partners.setLifecycle(paused.id, paused.revision, "active");
    expect((await f.storage.load())?.pausedPartnerIds).not.toContain(paused.id);
    expect(f.routines.list(paused.id).find(routine => routine.id === enabled.id)?.enabled).toBe(true);
    expect(f.routines.list(paused.id).find(routine => routine.id === disabled.id)?.enabled).toBe(false); expect(f.adapter.sent).toEqual([]);
  });
  it("authenticates generated writes, recovers creation receipts, fences stale edits and dispatches one independent Queue input", async () => {
    const f = await fixture(); let authorized = true;
    const service = createPartnerRoutineConnectService(f.routines, () => { if (!authorized) throw new ConnectError("Revoked", Code.Unauthenticated); });
    const input = create(contract.SavePartnerRoutineRequestSchema, { partnerId: f.partner.id, expectedPartnerRevision: { value: f.partner.revision }, definition,
      intent: { case: "creationRequestId", value: "routine-stable-creation" } });
    authorized = false; await expect(service.savePartnerRoutine(input, context())).rejects.toMatchObject({ code: Code.Unauthenticated }); expect(f.routines.list(f.partner.id)).toEqual([]);
    authorized = true; const saved = create(contract.SavePartnerRoutineResponseSchema, await service.savePartnerRoutine(input, context())).routine!;
    expect((await service.savePartnerRoutine(input, context())).routine?.id).toBe(saved.id);
    expect((await service.getPartnerRoutineCreation(create(contract.GetPartnerRoutineCreationRequestSchema, { partnerId: f.partner.id, requestId: "routine-stable-creation" }), context())).routine?.id).toBe(saved.id);
    await expect(service.savePartnerRoutine(create(contract.SavePartnerRoutineRequestSchema, { ...input, expectedRevision: create(contract.RevisionSchema, { value: 99n }), intent: { case: "routineId", value: saved.id } }), context())).rejects.toMatchObject({ code: Code.FailedPrecondition });
    const run = create(contract.RunPartnerRoutineRequestSchema, { partnerId: f.partner.id, expectedPartnerRevision: { value: f.partner.revision }, routineId: saved.id, expectedRevision: saved.revision, requestId: "routine-stable-manual" });
    await service.runPartnerRoutine(run, context());
    await vi.waitFor(() => expect(f.routines.history(f.partner.id, saved.id).runs[0]?.status).toBe("success"), { timeout: 5000 });
    await service.runPartnerRoutine(run, context()); await new Promise(resolve => setTimeout(resolve, 25)); expect(f.adapter.sent).toHaveLength(1);
    const executionSessionId = f.adapter.sent[0]!.sessionId;
    expect(executionSessionId).not.toBe(f.partner.canonicalSessionId); expect(f.adapter.sent[0]?.input.text).toContain(definition.prompt);
    expect(f.store.listQueueItems({ sessionId: executionSessionId }).some(item => item.body.text.includes(definition.prompt))).toBe(true);
    expect(f.store.listQueueItems({ sessionId: f.partner.canonicalSessionId })).toEqual([]);
    const history = create(contract.ListPartnerRoutineRunsResponseSchema, await service.listPartnerRoutineRuns(create(contract.ListPartnerRoutineRunsRequestSchema, { partnerId: f.partner.id, routineId: saved.id }), context()));
    expect(history.runs[0]?.status).toBe(contract.RoutineRunStatus.SUCCESS); expect(history.runs[0]?.scheduleRunId).toBeTruthy();
    const archived = await f.partners.setLifecycle(f.partner.id, f.partner.revision, "archived"); expect(f.routines.catalog(archived.id).writable).toBe(false);
    await expect(service.runPartnerRoutine({ ...run, expectedPartnerRevision: { $typeName: "joko.v1.Revision", value: archived.revision, etag: "" } }, context())).rejects.toMatchObject({ code: Code.FailedPrecondition });
    const restored = await f.partners.setLifecycle(f.partner.id, archived.revision, "active");
    await f.routines.remove({ partnerId: restored.id, partnerRevision: restored.revision, routineId: saved.id, revision: Number(saved.revision!.value) });
    expect(f.store.findSchedule(`partner-routine-${saved.id}`)).toBeUndefined(); expect((await f.storage.load())?.retiredRoutineIds).toContain(saved.id);
  });
  it("skips a pre-run check without dispatching and cleans routine resources during durable Partner deletion", async () => {
    const f = await fixture();
    const routine = await f.routines.save({ partnerId: f.partner.id, partnerRevision: f.partner.revision, requestId: "routine-check-creation", definition: {
      ...definition, triggers: [{ id: "time", kind: "interval", intervalMs: 3600000 }], preRunHook: { command: 'node -e "process.exit(2)"' } } });
    await f.routines.run({ partnerId: f.partner.id, partnerRevision: f.partner.revision, routineId: routine.id, revision: routine.revision, requestId: "routine-check-request" });
    await vi.waitFor(() => expect(f.routines.history(f.partner.id, routine.id).runs[0]?.status).toBe("skipped"), { timeout: 5000 }); expect(f.adapter.sent).toEqual([]);
    const deletion = await f.partners.deletePartner({ partnerId: f.partner.id, expectedRevision: f.partner.revision, requestId: "partner-routine-delete", confirmName: f.partner.displayName });
    expect(deletion.phase).toBe("completed"); expect(f.routines.engine.list(f.partner.id)).toEqual([]); expect((await f.storage.load())?.retiredRoutineIds).toContain(routine.id);
  });
});
