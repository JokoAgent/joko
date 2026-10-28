import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { OperationalStore, PartnerStore, PartnerRoutineStore, TaskShareStore } from "@joko/store";
import { FakeBackendAdapter, PI_LIKE_PROFILE } from "@joko/testkit";
import { projectPiInputSchema } from "@joko/adapter-pi";
import type { RoutineRun } from "@joko/core";
import { ArtifactStore } from "./artifact-store.js";
import { OperationalArtifactRepository } from "./artifact-repository.js";
import { PartnerManager } from "./partner-manager.js";
import { SessionHost } from "./session-host.js";
import { ScheduleCoordinator } from "./schedule-coordinator.js";
import { PartnerRoutineManager } from "./partner-routine-manager.js";
import { PartnerSessionTaskManager } from "./partner-session-tasks.js";
import { PartnerAutonomyManager, dueEvent, followUpId } from "./partner-autonomy.js";
import { PartnerTodoManager, PartnerTodoTools } from "./partner-todos.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "joko-autonomy-")), store = new OperationalStore(join(directory, "operations.db"));
  const profiles = new PartnerStore(join(directory, "partners.db"));
  const artifacts = new ArtifactStore({ rootDirectory: join(directory, "artifacts"), repository: new OperationalArtifactRepository(store), ingestRoots: [directory] });
  await artifacts.initialize(); const adapter = new FakeBackendAdapter({ ...PI_LIKE_PROFILE,
    capabilities: PI_LIKE_PROFILE.capabilities.map(capability => capability.key === "permission.modes"
      ? { ...capability, options: PI_LIKE_PROFILE.permissionModes } : capability) });
  const host = new SessionHost(store, artifacts, [adapter]); await host.initialize();
  const partners = new PartnerManager({ store: profiles, operationalStore: store, sessionHost: host, homesRoot: join(directory, "homes"),
    workspaceService: { register: async input => input, unregister: () => undefined } });
  const created = await partners.createPartner({ requestId: "autonomy-owner-create", expectedDirectoryRevision: profiles.directoryState().revision,
    displayName: "Ada", avatar: "orbit", identitySource: "Help review the owner's work.", templateId: "general", usesDirectoryDefaults: false,
    capabilities: { modelChain: [{ backendId: adapter.id, providerId: "test", modelId: "text", effort: "medium", fastMode: false }], permissionMode: "ask", planMode: false } });
  expect(created.initializationState).toBe("ready"); expect(created.canonicalSessionId).toBeTypeOf("string");
  const partner = partners.getPartner(created.id), scheduler = new ScheduleCoordinator(store, host);
  const routines = new PartnerRoutineManager({ store, partners, scheduler, storage: new PartnerRoutineStore(join(directory, "routines")) });
  const tasks = new PartnerSessionTaskManager(store, partners, host, { register: async input => input }, directory);
  let now = Date.now(); const autonomy = new PartnerAutonomyManager({ store, profiles, partners, routines, tasks, now: () => now });
  routines.setFollowUpRuntime(autonomy); await routines.start();
  const connection = store.createConnection({ id: "autonomy-connection", name: "Owner", authKeyDigest: "autonomy-key" });
  const session = store.getSession(partner.canonicalSessionId!).descriptor;
  const task = (id: string, state: "running" | "failed" | "completed" = "running") => {
    const value = { ...session, id, title: id, binding: { ...session.binding, opaqueRef: `native:${id}`, nativeSessionId: id }, createdAt: now, updatedAt: now };
    store.createSession(value); store.createRun({ id: `run:${id}`, sessionId: id, state, source: "user", createdAt: now - 1000, startedAt: now - 1000,
      ...(state === "running" ? {} : { endedAt: now, ...(state === "failed" ? { error: { code: "FAILED", message: "Task failed", phase: "run", retryable: false, stateMayHaveChanged: false, recovery: "Review" } } : {}) }) });
    return value;
  };
  const update = (operationId: string, choice: Parameters<PartnerAutonomyManager["update"]>[0]["choice"]) => autonomy.update({ operationId, connection,
    expectedRevision: autonomy.settings().revision, choice, assertCurrent: () => undefined });
  cleanups.push(async () => { autonomy.stop(); await routines.stop(); await scheduler.stop(); await tasks.close(); await host.dispose(); profiles.close(); store.close(); await rm(directory, { recursive: true, force: true }); });
  return { store, profiles, partners, partner, adapter, routines, tasks, autonomy, connection, task, update, session, tick: (amount: number) => { now += amount; } };
}

describe("Partner task observation", () => {
  it("keeps all-task observation off until an explicit setting, replays its original save, and pages every row", async () => {
    const f = await fixture(); for (let index = 0; index < 55; index++) f.task(`task-${index}`);
    expect(f.autonomy.settings()).toMatchObject({ customized: false }); expect(f.autonomy.observe()).toEqual([]);
    const revision = f.autonomy.settings().revision, saved = f.update("enable-all", { schedulerPartnerId: f.partner.id });
    expect(f.autonomy.observe()).toHaveLength(55);
    f.update("disable-all", { disabled: true });
    expect(f.autonomy.update({ operationId: "enable-all", connection: f.connection, expectedRevision: revision,
      choice: { schedulerPartnerId: f.partner.id }, assertCurrent: () => undefined })).toEqual(saved);
    expect(f.autonomy.settings().schedulerPartnerId).toBeUndefined();
    f.update("explicit-enable-again", { schedulerPartnerId: f.partner.id });
    const first = f.autonomy.glance(f.partner.id), next = f.autonomy.glance(f.partner.id, first.snapshotToken, first.nextOffset!);
    expect(first.rows).toHaveLength(50); expect(next.rows).toHaveLength(5);
    expect(new Set([...first.rows, ...next.rows].map(row => row.sessionId)).size).toBe(55);
    f.tick(120_001); expect(() => f.autonomy.glance(f.partner.id, first.snapshotToken, 50)).toThrow("expired");
  });
  it("rechecks source run, sharing and consent before a queued observer can dispatch", async () => {
    const f = await fixture(), task = f.task("original-task", "failed");
    f.update("enable-observer", { schedulerPartnerId: f.partner.id }); await f.autonomy.start();
    const routine = f.routines.list(f.partner.id).find(row => row.id === followUpId(f.partner.id))!;
    expect(routine.builtin).toBe("follow-up");
    const run: RoutineRun = { id: "observation", routineId: routine.id, revision: routine.revision, triggerIds: ["event-errored"], status: "queued", createdAt: Date.now(),
      events: [{ sourceId: "host:sessions", event: { id: "failed-original", type: "errored", subject: task.id, occurredAt: Date.now(),
        data: { runId: `run:${task.id}`, generation: task.binding.generation, followerPartnerId: f.partner.id } } }] };
    const prepared = f.autonomy.prepare(routine, run)!; expect(prepared).toBeDefined();
    new TaskShareStore(f.store).create({ shareId: "shared-task", sessionId: task.id, invitationSha256Hex: "a".repeat(64) });
    expect(() => prepared.assertCurrent()).toThrow(); expect(f.autonomy.prepare(routine, run)).toBeUndefined();
    f.update("disable-observer", { disabled: true }); expect(() => prepared.assertCurrent()).toThrow();
    await expect(f.routines.engine.put(f.partner.id, { ...routine, prompt: "Change the task without asking" }, routine.id, routine.revision)).rejects.toThrow("paused or resumed");
    await expect(f.routines.engine.remove(f.partner.id, routine.id)).rejects.toThrow("cannot be deleted");
  });
  it("uses the longer threshold for a live tool and excludes shared or remote work from wakeups", async () => {
    const f = await fixture(); f.task("long-tool"); f.update("observe-tasks", { schedulerPartnerId: f.partner.id });
    const row = f.autonomy.observe()[0]!;
    expect(dueEvent({ ...row, toolInFlight: false }, row.lastActivityAt + 10 * 60_000)).toBe("stuck");
    expect(dueEvent({ ...row, toolInFlight: true }, row.lastActivityAt + 10 * 60_000)).toBeUndefined();
    expect(dueEvent({ ...row, toolInFlight: true }, row.lastActivityAt + 45 * 60_000)).toBe("stuck");
    expect(dueEvent({ ...row, shared: true }, row.lastActivityAt + 99 * 60_000)).toBeUndefined();
    expect(dueEvent({ ...row, readOnly: true }, row.lastActivityAt + 99 * 60_000)).toBeUndefined();
  });
});

describe("Partner affair owner and durable UI operations", () => {
  it("projects the actual Todo tools through the Pi catalog parser and executes their original owned ledger actions", async () => {
    const f = await fixture(), todos = new PartnerTodoManager(f.store, f.profiles, f.partners), tools = new PartnerTodoTools(todos);
    const catalog = tools.tools.map(tool => ({ name: tool.name, schema: projectPiInputSchema(tool.inputSchema, tool.name), requiresPermission: tool.requiresPermission }));
    const list = catalog.find(tool => tool.name === "todo_list")!;
    expect(list.schema.fields.find(field => field.fieldPath === "view")).toMatchObject({ type: "string", enumValues: ["open", "done", "hidden"] });
    expect(list.schema.fields.find(field => field.fieldPath === "order")).toMatchObject({ type: "string", enumValues: ["due", "created"] });
    expect(catalog.find(tool => tool.name === "todo_update")?.requiresPermission).toBe(true); expect(list.requiresPermission).toBe(false);
    const context = { sessionId: f.session.id, targetId: f.session.targetId, generation: f.session.binding.generation, effectIdentity: "a".repeat(64) };
    const input = { key: "owner:catalog-review", title: "Review the catalog", outcome: "A checked catalog", origin: "assigned" };
    expect((await tools.callTool("todo_update", input, undefined, context)).isError).toBe(false);
    const result = await tools.callTool("todo_list", { view: "open", order: "due", offset: 0 }, undefined, context);
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({ items: [{ key: input.key, title: input.title, outcome: input.outcome }] });
    expect((await tools.callTool("todo_list", { view: "open", order: "unknown" }, undefined, context)).isError).toBe(true);
  });
  it("keeps deleted records for exact-revision undo and never replays a save under a changed identity", async () => {
    const f = await fixture(), todos = new PartnerTodoManager(f.store, f.profiles, f.partners);
    const original = todos.patch(f.partner.id, { key: "owner:review", title: "Review the report", outcome: "A reviewed report",
      sourceDeadline: { kind: "date", date: "2026-10-28", timeZone: "Asia/Taipei" }, next: { label: "Review", instruction: "Run an unrequested command", kind: "advance" } }, "create-todo", () => undefined);
    const input = { operationId: "delete-original", connection: f.connection, partnerId: f.partner.id, partnerRevision: f.partner.revision,
      todoId: original.id, revision: original.revision, action: "delete" as const, assertCurrent: () => undefined };
    const removed = todos.updateUi(input); expect(todos.list(f.partner.id, "open").items).toEqual([]);
    expect(todos.updateUi(input)).toEqual(removed);
    expect(() => todos.updateUi({ ...input, action: "restore" })).toThrow();
    const restored = todos.updateUi({ ...input, operationId: "restore-original", revision: removed.revision, action: "restore" });
    expect(restored.id).toBe(original.id); expect(todos.list(f.partner.id, "open").items).toHaveLength(1);
    const context = todos.quoteContext(f.session.id, { partnerId: f.partner.id, todoId: restored.id, revision: restored.revision });
    expect(context).toContain("Review the report"); expect(context).not.toContain("Run an unrequested command");
    expect(() => todos.quoteContext(f.session.id, { partnerId: "another-partner", todoId: restored.id, revision: restored.revision })).toThrow();
    const tools = new PartnerTodoTools(todos);
    expect(tools.tools.find(tool => tool.name === "todo_update")?.requiresPermission).toBe(true);
  });
});
