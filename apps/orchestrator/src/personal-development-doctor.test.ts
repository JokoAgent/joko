import type { DevelopmentState, PersonalDevelopmentOwner } from "@joko/personal-development";
import { PersonalDevelopmentError } from "@joko/personal-development";
import { OperationalStore } from "@joko/store";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PersonalDevelopmentDoctor } from "./personal-development-doctor.js";
import type { PersonalDevelopmentCoordinator, PersonalTaskIntent } from "./personal-development-coordinator.js";
import type { DevelopmentDoctorCheck, DevelopmentDoctorStartInput } from "./personal-development-doctor-types.js";
import type { CreateServiceSessionInput, SessionHost } from "./session-host.js";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const start = (operationId = "doctor-start"): DevelopmentDoctorStartInput => ({ operationId, title: "Rendering request", request: "render", mode: "prepare",
  targetId: "local", fastMode: false, permissionMode: "ask", planMode: false });
async function eventually(test: () => boolean) { await vi.waitFor(() => { expect(test()).toBe(true); }, { timeout: 5_000, interval: 5 }); }
function fixture() {
  const store = new OperationalStore(":memory:"); cleanups.push(() => store.close());
  store.upsertBackend({ id: "backend", displayName: "Local", version: "1", health: "healthy", adapterKind: "fixture", instanceGeneration: 0,
    installationState: "installed", authenticationState: "not_required", capabilities: new Map(), models: [], tools: [], diagnostics: [] });
  store.upsertTarget({ id: "local", backendId: "backend", displayName: "Local", workspaceRoot: "D:/local", managed: false, trusted: true });
  const createSession = (id: string) => store.createSession({ id, targetId: "local", backendId: "backend", title: "Doctor", binding: { opaqueRef: id, generation: 0 },
    pinned: false, archived: false, permissionMode: "ask", planMode: false, fastMode: false, createdAt: 1, updatedAt: 1 });
  const effective = { backendId: "backend", providerId: "provider", modelId: "model", effort: "medium", fastMode: false };
  const createServiceSession = vi.fn(async (_input: CreateServiceSessionInput) => { createSession("container"); return { value: { sessionId: "container" } }; });
  const host = { createServiceSession, getSessionRuntimeControl: () => ({ effective }) } as unknown as Pick<SessionHost, "createServiceSession" | "getSessionRuntimeControl">;
  let state: DevelopmentState = { format: 1, generation: 1, environment: { status: "unchecked", checks: [] }, source: { status: "missing" }, tasks: {}, history: [],
    versions: { selected: "original", switching: false }, operations: {} };
  const listeners = new Set<(state: DevelopmentState) => void>(), coordinatorListeners = new Set<() => void>();
  const publish = () => { for (const listener of listeners) listener(state); };
  const tools = ["git", "gitLfs", "node", "pnpm", "python"] as const;
  const environment = vi.fn(async ({ operationId }: { operationId: string }) => {
    state = { ...state, environment: { status: "ready", checks: tools.map(id => ({ id, status: "ready", executable: "D:/private/tool.exe", version: "1.0.0" })) },
      operations: { ...state.operations, [operationId]: { id: operationId, kind: "environment-check", inputHash: "hash", status: "succeeded", stage: "completed", startedAt: 1 } } };
    publish(); return { operationId, value: state.environment.checks, replayed: false };
  });
  let releaseSource: (() => void) | undefined, rejectSource: ((error: Error) => void) | undefined;
  let blockSource = false;
  const prepareSource = vi.fn(async ({ operationId }: { operationId: string }) => {
    state = { ...state, source: { status: "preparing" } }; publish();
    if (blockSource) await new Promise<void>((resolve, reject) => { releaseSource = resolve; rejectSource = reject; });
    state = { ...state, source: { status: "ready", channel: "dev", version: "0.1.0", commit: "a".repeat(40) } }; publish();
    return { operationId, value: state.source, replayed: false };
  });
  const cancel = vi.fn(() => { rejectSource?.(new PersonalDevelopmentError("CANCELLED")); return true; });
  const owner = { rootDirectory: "D:/private/personal", snapshot: () => state, checkEnvironment: environment, prepareEnvironment: environment,
    prepareSource, cancel, subscribe: (listener: (state: DevelopmentState) => void) => { listeners.add(listener); listener(state); return () => listeners.delete(listener); } } as unknown as PersonalDevelopmentOwner;
  const tasks: PersonalTaskIntent[] = [];
  const startTask = vi.fn(async (input: { operationId: string }) => {
    const task = { operationId: input.operationId, taskId: "personal-task", sessionId: "code-session" } as PersonalTaskIntent; tasks.push(task);
    for (const listener of coordinatorListeners) listener(); return task;
  });
  const coordinator = { ownerId: "owner", availability: () => ({ available: true, reason: "" }), sourceTarget: async () => ({ channel: "dev", version: "0.1.0" }), startTask,
    snapshot: () => ({ preparations: tasks }), subscribe: (listener: () => void) => { coordinatorListeners.add(listener); listener(); return () => coordinatorListeners.delete(listener); } } as unknown as PersonalDevelopmentCoordinator;
  const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify({ items: [], incomplete_results: false, total_count: 0 })));
  let nativeReady = true;
  const options = { store, owner, host, coordinator, fetch, runtime: () => ({ channel: "dev" as const, version: "0.1.0", confidence: "unknown" as const }),
    prerequisites: { platform: () => ({ id: "platform", status: "ready" as const }), native: async (): Promise<DevelopmentDoctorCheck> => ({ id: "native", status: nativeReady ? "ready" : "missing" }),
      storage: async () => ({ id: "storage", status: "ready" as const, freeGiB: 100 }) } };
  const doctor = new PersonalDevelopmentDoctor(options); doctor.initialize(); cleanups.push(() => doctor.dispose());
  return { doctor, options, owner, store, createServiceSession, createSession, startTask, prepareSource, fetch, environment,
    blockSource: () => { blockSource = true; }, unblockSource: () => { blockSource = false; releaseSource?.(); }, setNativeReady: (value: boolean) => { nativeReady = value; }, tasks };
}

describe("durable personal-development doctor workflow", () => {
  it("creates one ordinary container without a turn, publishes durable preparation, then searches and persists wait", async () => {
    const f = fixture(); f.blockSource(); const report = await f.doctor.start(start());
    await eventually(() => f.prepareSource.mock.calls.length === 1); expect(f.fetch).not.toHaveBeenCalled();
    expect(f.store.listRuns({ sessionId: report.sessionId })).toEqual([]); expect(f.store.listQueueItems({ sessionId: report.sessionId })).toEqual([]);
    expect(await f.doctor.start(start())).toMatchObject({ runId: report.runId, sessionId: report.sessionId }); expect(f.createServiceSession).toHaveBeenCalledOnce();
    expect(f.createServiceSession.mock.calls[0]?.[0]).not.toHaveProperty("worktree");
    f.unblockSource(); await eventually(() => f.doctor.snapshot()[0]?.status === "completed");
    expect(f.doctor.snapshot()[0]).toMatchObject({ stage: "completed", upstream: { status: "notFound" }, checks: expect.arrayContaining([{ id: "storage", status: "ready", freeGiB: 100 }]) });
    const waiting = await f.doctor.control({ operationId: "choose-wait", runId: report.runId, action: "wait" }); expect(waiting.decision).toBe("wait"); expect(f.startTask).not.toHaveBeenCalled();
    await f.doctor.dispose(); const recovered = new PersonalDevelopmentDoctor(f.options); recovered.initialize(); cleanups.push(() => recovered.dispose());
    expect(await recovered.start(start())).toMatchObject({ runId: report.runId, sessionId: report.sessionId, decision: "wait" }); expect(f.createServiceSession).toHaveBeenCalledOnce();
  });
  it("freezes the actual origin route, makes the explicit personal choice idempotent and rejects changed invocation identity", async () => {
    const f = fixture(); f.createSession("origin"); const input = { ...start(), sessionId: "origin", providerId: "ignored", modelId: "ignored" };
    const report = await f.doctor.start(input); await eventually(() => f.doctor.snapshot()[0]?.status === "completed");
    const request = { operationId: "choose-personal", runId: report.runId, action: "personal" as const };
    const first = await f.doctor.control(request); const replay = await f.doctor.control(request);
    expect(first).toMatchObject({ decision: "personal", taskId: "personal-task", codeSessionId: "code-session" }); expect(replay).toEqual(first);
    expect(f.startTask).toHaveBeenCalledOnce(); expect(f.startTask.mock.calls[0]?.[0]).toMatchObject({ originSessionId: "origin", providerId: "provider", modelId: "model", effort: "medium" });
    expect(f.createServiceSession).not.toHaveBeenCalled(); await expect(async () => f.doctor.start({ ...input, request: "different" })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  });
  it("cancels the exact Owner action and retries the same card only after it settles", async () => {
    const f = fixture(); f.blockSource(); const report = await f.doctor.start(start()); await eventually(() => f.prepareSource.mock.calls.length === 1);
    await f.doctor.control({ operationId: "cancel-doctor", runId: report.runId, action: "cancel" });
    await eventually(() => f.doctor.snapshot()[0]?.status === "cancelled"); expect(f.fetch).not.toHaveBeenCalled(); f.unblockSource();
    const retry = { operationId: "retry-doctor", runId: report.runId, action: "retry" as const };
    await f.doctor.control(retry); await f.doctor.control(retry); await eventually(() => f.doctor.snapshot()[0]?.status === "completed");
    expect(f.doctor.snapshot()).toHaveLength(1); expect(f.doctor.snapshot()[0]).toMatchObject({ runId: report.runId, attempt: 2 }); expect(f.createServiceSession).toHaveBeenCalledOnce();
  });
  it("runs check mode without source preparation or upstream requests and keeps paths out of the card", async () => {
    const f = fixture(), report = await f.doctor.start({ ...start(), mode: "check", request: "" }); await eventually(() => f.doctor.snapshot()[0]?.status === "completed");
    expect(f.prepareSource).not.toHaveBeenCalled(); expect(f.fetch).not.toHaveBeenCalled(); expect(f.doctor.snapshot()[0]?.runId).toBe(report.runId);
    expect(JSON.stringify(f.doctor.snapshot())).not.toContain("private/tool.exe"); expect(f.store.listRuns({ sessionId: report.sessionId })).toEqual([]);
  });
  it("recovers a lost container response from its exact durable service receipt without creating again", async () => {
    const f = fixture();
    f.createServiceSession.mockImplementationOnce(async input => {
      f.store.runOperation({ id: input.operationId, kind: "create_personal_development_session", body: { targetId: input.targetId, title: input.title,
        providerId: input.providerId, modelId: input.modelId, effort: input.effort, fastMode: input.fastMode,
        permissionMode: input.permissionMode, planMode: input.planMode, serviceKind: "personal_development" } }, () => { f.createSession("container"); return { sessionId: "container" }; });
      throw new Error("Native response lost.");
    });
    const lost = await f.doctor.start(start()); expect(lost).toMatchObject({ status: "unknown", sessionId: "" });
    const recovered = await f.doctor.start(start()); expect(recovered).toMatchObject({ runId: lost.runId, status: "unknown", sessionId: "container" });
    expect(f.createServiceSession).toHaveBeenCalledOnce(); expect(f.environment).not.toHaveBeenCalled();
    await f.doctor.control({ operationId: "retry-after-receipt", runId: lost.runId, action: "retry" });
    await eventually(() => f.doctor.snapshot()[0]?.status === "completed"); expect(f.createServiceSession).toHaveBeenCalledOnce();
  });
  it("retries the same completed card after missing prerequisites, a failed query and waiting while preserving an admitted personal task", async () => {
    const f = fixture(); f.setNativeReady(false); const report = await f.doctor.start(start());
    await eventually(() => f.doctor.snapshot()[0]?.status === "completed");
    expect(f.doctor.snapshot()[0]?.error).toBe("ENVIRONMENT_NOT_READY"); expect(f.prepareSource).not.toHaveBeenCalled();
    f.setNativeReady(true); f.fetch.mockRejectedValue(new Error("Fixture network failure."));
    await f.doctor.control({ operationId: "retry-native", runId: report.runId, action: "retry" });
    await eventually(() => f.doctor.snapshot()[0]?.upstream?.status === "failed");
    f.fetch.mockImplementation(async () => new Response(JSON.stringify({ items: [], incomplete_results: false, total_count: 0 })));
    await f.doctor.control({ operationId: "retry-upstream", runId: report.runId, action: "retry" });
    await eventually(() => f.doctor.snapshot()[0]?.status === "completed");
    await f.doctor.control({ operationId: "wait-before-requery", runId: report.runId, action: "wait" });
    const retried = await f.doctor.control({ operationId: "retry-wait", runId: report.runId, action: "retry" });
    expect(retried.decision).toBeUndefined(); await eventually(() => f.doctor.snapshot()[0]?.status === "completed");
    expect(f.doctor.snapshot()).toHaveLength(1); expect(f.doctor.snapshot()[0]).toMatchObject({ runId: report.runId, attempt: 4 });
    await f.doctor.control({ operationId: "personal-after-requery", runId: report.runId, action: "personal" });
    await expect(f.doctor.control({ operationId: "retry-after-personal", runId: report.runId, action: "retry" })).rejects.toMatchObject({ code: "BUSY" });
    expect(f.doctor.snapshot()[0]).toMatchObject({ decision: "personal", taskId: "personal-task", codeSessionId: "code-session", attempt: 4 });
    expect(f.createServiceSession).toHaveBeenCalledOnce(); expect(f.startTask).toHaveBeenCalledOnce();
  });
});
