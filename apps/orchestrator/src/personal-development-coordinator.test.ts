import { execFile } from "node:child_process";
import { lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import type { AdapterContext, CreateNativeSessionInput, NativeSessionBinding, PromptInput } from "@joko/core";
import { PersonalDevelopmentError, type DevelopmentOperationResult, type DevelopmentState, type DevelopmentTask, type DevelopmentWorktreeAuthority, type PersonalDevelopmentOwner } from "@joko/personal-development";
import { OperationalStore } from "@joko/store";
import { FakeBackendAdapter, PI_LIKE_PROFILE } from "@joko/testkit";
import { acquireWorktreeSourceUse, releaseRetiredWorktreeSourceUse, type WorktreeSourceUseReceipt } from "@joko/worktree";
import { afterEach, describe, expect, it } from "vitest";

import { OperationalArtifactRepository } from "./artifact-repository.js";
import { ArtifactStore } from "./artifact-store.js";
import { PersonalDevelopmentCoordinator, personalDevelopmentOwnerIdentity } from "./personal-development-coordinator.js";
import { PERSONAL_DEVELOPMENT_PURPOSE_KEY, readPersonalDevelopmentPurpose } from "./personal-development-purpose.js";
import { PersonalDevelopmentReportTools } from "./personal-development-report-tools.js";
import { createPersonalDevelopmentWorktreeAuthority } from "./personal-development-worktree.js";
import { SessionHost } from "./session-host.js";
import { SessionWorktreeCoordinator } from "./session-worktree-coordinator.js";
import { mkdtemp } from "./test-paths.js";
import { WorkspaceService } from "./workspace-service.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

describe("personal development Session authority", () => {
  it("persists purpose before native creation, queues only after preparation, and captures only after exact writer retirement", { timeout: 40_000 }, async () => {
    const f = await fixture();
    const admitted = await f.coordinator.startTask(start());
    await eventually(() => f.coordinator.snapshot().preparations[0]?.sessionId !== undefined);
    const sessionId = f.coordinator.snapshot().preparations[0]!.sessionId!;
    const preparing = readPersonalDevelopmentPurpose(f.store, sessionId)!;
    expect(preparing).toMatchObject({ taskId: admitted.taskId, phase: "adopted", editing: "preparing", backendGeneration: 0 });
    expect(f.adapter.observedPurpose).toMatchObject({ taskId: admitted.taskId, phase: "creating" });
    expect(f.adapter.context).toBeUndefined();
    expect(() => f.host.enqueueServiceInput({ operationId: "premature-input", sessionId, source: "system", prompt: prompt("premature") }))
      .toThrow(/Continue the personal task/iu);
    f.owner.allowPreparation();
    await eventually(() => f.adapter.context !== undefined);
    const context = f.adapter.context!;
    const queue = f.store.listQueueItems({ sessionId, limit: 10 });
    expect(queue).toHaveLength(1); expect(queue[0]?.body.text).toBe(start().request);
    const bridge = new PersonalDevelopmentReportTools(() => f.coordinator);
    const caller = { sessionId, targetId: context.target.id, generation: context.generation, providerGeneration: 1, requestIdentity: "first-completion-request" };
    expect(await bridge.callTool("report_complete", { task_id: "foreign" }, undefined, caller)).toMatchObject({ isError: true });
    expect(await bridge.callTool("report_complete", {}, undefined, { ...caller, generation: context.generation + 1 })).toMatchObject({ isError: true });
    expect(await bridge.callTool("report_complete", {}, undefined, { ...caller, providerGeneration: undefined })).toMatchObject({ isError: true });
    expect(await bridge.callTool("report_complete", {}, undefined, caller)).toMatchObject({ isError: false });
    expect(readPersonalDevelopmentPurpose(f.store, sessionId)?.completion?.state).toBe("requested");
    expect(f.owner.completions).toBe(0);
    f.adapter.finish();
    await eventually(() => f.owner.completions === 1);
    await eventually(() => readPersonalDevelopmentPurpose(f.store, sessionId)?.editing === "completed");
    expect(f.adapter.closed).toContain(sessionId); expect(f.terminalClosures).toContain(sessionId);
    expect(f.host.isSessionActive(sessionId)).toBe(false);
    expect(f.owner.completedWithRetiredWriter).toBe(true);
    expect(() => f.host.enqueueServiceInput({ operationId: "completed-input", sessionId, source: "system", prompt: prompt("edit without continue") }))
      .toThrow(/Continue the personal task/iu);
    await f.coordinator.controlTask({ operationId: "end-personal-task", taskId: admitted.taskId, action: "end" });
    await eventually(() => f.store.getSession(sessionId).descriptor.archived);
    const binding = f.store.getSession(sessionId).descriptor.worktree!;
    await expect(lstat(binding.path)).rejects.toMatchObject({ code: "ENOENT" });
    expect(readPersonalDevelopmentPurpose(f.store, sessionId)?.editing).toBe("ended");
  });

  it("retains an unadopted exact checkout when native creation has an unknown result", { timeout: 30_000 }, async () => {
    const f = await fixture(true);
    const admitted = await f.coordinator.startTask(start());
    await eventually(() => f.coordinator.snapshot().preparations[0]?.status === "unknown");
    const purposes = f.store.listSettings("service").filter(setting => setting.key === PERSONAL_DEVELOPMENT_PURPOSE_KEY);
    expect(purposes).toHaveLength(1);
    const purpose = purposes[0]!.value as { sessionId: string; phase: string };
    expect(purpose.phase).toBe("creating");
    expect(f.store.listSessions()).toHaveLength(0);
    const state = JSON.parse(await readFile(join(f.root, "worktrees", "state.json"), "utf8")) as { entries: Array<{ sessionId: string; path: string }> };
    expect(state.entries).toHaveLength(1); expect(state.entries[0]?.sessionId).toBe(purpose.sessionId);
    await expect(lstat(state.entries[0]!.path)).resolves.toBeDefined();
    expect(f.adapter.closed).toEqual([]); expect(f.coordinator.busy()).toBe(true);
    expect((await f.coordinator.startTask(start())).taskId).toBe(admitted.taskId);
  });

  it("uses the exact merge candidate in a real Session and adopts only after normal settlement retires native writers", { timeout: 35_000 }, async () => {
    const f = await fixture();
    const candidate = join(f.root, "personal", "merge-candidate");
    await git(join(f.root, "personal", "source"), ["worktree", "add", "--detach", candidate, "HEAD"]);
    f.owner.mergeCandidate = candidate;
    expect(f.coordinator.mergeSource({ operationId: "merge-source", action: "start", targetId: "route-target" })).toBe("merge-source");
    await eventually(() => f.adapter.context !== undefined);
    const sessionId = f.adapter.context!.sessionId;
    expect(f.adapter.context?.target.workspaceRoot).toBe(candidate);
    expect(f.store.getSession(sessionId).descriptor.worktree).toBeUndefined();
    expect(readPersonalDevelopmentPurpose(f.store, sessionId)).toMatchObject({ phase: "adopted", editing: "editing",
      merge: { id: "merge-source", directory: candidate, leaseId: "merge-lease-1" } });
    expect(f.adapter.observedPurpose).toMatchObject({ phase: "creating", merge: { id: "merge-source", leaseId: "merge-lease-1" } });
    expect(f.coordinator.snapshot().mergeSessions).toMatchObject([{ sessionId, status: "editing" }]);
    expect(f.coordinator.busy()).toBe(true); expect(f.owner.mergeAdoptedWithRetiredWriter).toBe(false);
    f.adapter.finish();
    await eventually(() => f.owner.mergeAdoptedWithRetiredWriter);
    await eventually(() => f.store.getSession(sessionId).descriptor.archived);
    expect(f.adapter.closed).toContain(sessionId); expect(f.terminalClosures).toContain(sessionId);
    expect(readPersonalDevelopmentPurpose(f.store, sessionId)?.editing).toBe("ended");
    expect(f.owner.state.merge?.status).toBe("adopted");
    expect(f.coordinator.mergeSource({ operationId: "merge-source", action: "start", targetId: "route-target" })).toBe("merge-source");
  });

  it("ends an adopted task whose dependency preparation failed before the package published a task", { timeout: 30_000 }, async () => {
    const f = await fixture();
    f.owner.prepareTask = () => { throw new PersonalDevelopmentError("ENVIRONMENT_NOT_READY"); };
    const admitted = await f.coordinator.startTask(start());
    await eventually(() => f.coordinator.snapshot().preparations[0]?.status === "failed");
    const sessionId = f.coordinator.snapshot().preparations[0]!.sessionId!;
    expect(f.owner.snapshot().tasks[admitted.taskId]).toBeUndefined(); expect(f.adapter.context).toBeUndefined();
    await f.coordinator.controlTask({ operationId: "end-unprepared", taskId: admitted.taskId, action: "end" });
    await eventually(() => f.store.getSession(sessionId).descriptor.archived);
    expect(f.owner.state.tasks[admitted.taskId]?.status).toBe("ended");
    expect(f.owner.completions).toBe(0); expect(readPersonalDevelopmentPurpose(f.store, sessionId)?.editing).toBe("ended");
  });

  it("reconciles an exact released checkout after the package loses its cleanup reply", { timeout: 30_000 }, async () => {
    const f = await fixture(); f.owner.prepareTask = () => { throw new PersonalDevelopmentError("ENVIRONMENT_NOT_READY"); };
    const admitted = await f.coordinator.startTask(start());
    await eventually(() => f.coordinator.snapshot().preparations[0]?.status === "failed");
    const sessionId = f.coordinator.snapshot().preparations[0]!.sessionId!;
    f.owner.loseReleaseReply = true;
    await f.coordinator.controlTask({ operationId: "end-lost-reply", taskId: admitted.taskId, action: "end" });
    await eventually(() => f.owner.state.tasks[admitted.taskId]?.status === "cleanup");
    await eventually(() => f.store.getSession(sessionId).descriptor.worktree?.state === "preserved");
    await expect(lstat(f.store.getSession(sessionId).descriptor.worktree!.path)).rejects.toMatchObject({ code: "ENOENT" });
    await f.coordinator.controlTask({ operationId: "end-confirmed-retry", taskId: admitted.taskId, action: "end" });
    await eventually(() => f.store.getSession(sessionId).descriptor.archived);
    expect(f.owner.state.tasks[admitted.taskId]?.status).toBe("ended");
  });

  it("reconciles only the retired operation's exact durable source-use receipt across authority instances", { timeout: 30_000 }, async () => {
    const f = await fixture(); const admitted = await f.coordinator.startTask(start());
    await eventually(() => f.coordinator.snapshot().preparations[0]?.sessionId !== undefined);
    const sessionId = f.coordinator.snapshot().preparations[0]!.sessionId!;
    const signal = new AbortController().signal;
    const lease = await f.owner.authority.acquire({ taskId: admitted.taskId, sessionId, repositoryRoot: join(f.root, "personal", "source"), sourceRef: "joko-personal", signal });
    const foreign = await acquireWorktreeSourceUse(lease.path, "independent-native-writer", new AbortController());
    cleanups.push(() => foreign.release({ writerRetired: true }));
    await expect(f.owner.authority.withUse(lease, signal, async () => {
      const beforeEffect = f.store.listSettings("service", "personal-development").filter(setting => setting.key.startsWith("source-use:"));
      expect(beforeEffect).toHaveLength(1); expect(beforeEffect[0]?.value).toMatchObject({ operationId: "unknown-source-command", status: "active" });
      throw new PersonalDevelopmentError("PROCESS_UNKNOWN");
    }, { operationId: "unknown-source-command" })).rejects.toMatchObject({ code: "PROCESS_UNKNOWN" });
    const setting = f.store.listSettings("service", "personal-development").find(item => item.key.startsWith("source-use:"))!;
    const retained = setting.value as { receipt: WorktreeSourceUseReceipt; status: string };
    expect(retained.status).toBe("unknown");
    const directory = join(f.root, "worktrees", "source-uses", lease.leaseId), ownFile = join(directory, `${retained.receipt.id}.json`);
    await expect(lstat(ownFile)).resolves.toBeDefined();
    expect(JSON.parse(await readFile(ownFile, "utf8"))).toEqual(retained.receipt);
    const restarted = createPersonalDevelopmentWorktreeAuthority({ store: f.store, worktrees: f.worktrees,
      ownerId: personalDevelopmentOwnerIdentity(join(f.root, "personal")), sourceRoot: join(f.root, "personal", "source") });
    expect(await restarted.reconcileRetiredUses({ operationId: "another-command", commandIds: ["known-command"] })).toBe("retired");
    await expect(lstat(ownFile)).resolves.toBeDefined();
    await expect(releaseRetiredWorktreeSourceUse({ ...foreign.receipt!, ownerId: retained.receipt.ownerId })).rejects.toMatchObject({ code: "SESSION_CONFLICT" });
    expect(await restarted.reconcileRetiredUses({ operationId: "unknown-source-command", commandIds: ["known-command"] })).toBe("retired");
    await expect(lstat(ownFile)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(join(directory, `${foreign.receipt!.id}.json`))).resolves.toBeDefined();
    expect(f.store.findSetting("service", "personal-development", setting.key)).toBeUndefined();
  });

  it("allows the same task to retry only after its exact preparation writer is verified retired", { timeout: 30_000 }, async () => {
    const f = await fixture(); f.owner.preparationError = new PersonalDevelopmentError("PROCESS_UNKNOWN");
    const admitted = await f.coordinator.startTask(start()); f.owner.allowPreparation();
    await eventually(() => f.coordinator.snapshot().preparations[0]?.status === "unknown");
    const intent = f.coordinator.snapshot().preparations[0]!, operationId = intent.preparationOperationId!;
    await expect(f.coordinator.controlTask({ operationId: "retry-without-proof", taskId: admitted.taskId, action: "retry_preparation" }))
      .rejects.toMatchObject({ code: "PROCESS_UNKNOWN" });
    const failed = { ...f.owner.state.operations[operationId]!, status: "failed" as const, stage: "writer-retirement-verified", error: "COMMAND_FAILED" as const };
    f.owner.state = { ...f.owner.state, operations: { ...f.owner.state.operations, unrelated: { ...failed, id: "unrelated" } } }; f.owner.publish();
    expect(f.coordinator.snapshot().preparations[0]?.status).toBe("unknown");
    f.owner.state = { ...f.owner.state, operations: { ...f.owner.state.operations, [operationId]: failed } }; f.owner.publish();
    expect(f.coordinator.snapshot().preparations[0]?.status).toBe("failed"); expect(f.adapter.context).toBeUndefined();
    f.owner.preparationError = undefined;
    await f.coordinator.controlTask({ operationId: "retry-retired-preparation", taskId: admitted.taskId, action: "retry_preparation" });
    await eventually(() => f.adapter.context !== undefined);
    expect(f.coordinator.snapshot().preparations[0]).toMatchObject({ taskId: admitted.taskId, sessionId: intent.sessionId,
      preparationOperationId: "retry-retired-preparation", status: "succeeded" });
    expect(f.store.listSessions()).toHaveLength(1);
    expect(f.store.listQueueItems({ sessionId: intent.sessionId!, limit: 10 })).toHaveLength(1);
  });

  it("keeps a merge candidate fenced when native creation has no adopted binding or retirement proof", { timeout: 30_000 }, async () => {
    const f = await fixture(true); const candidate = join(f.root, "personal", "merge-candidate");
    await git(join(f.root, "personal", "source"), ["worktree", "add", "--detach", candidate, "HEAD"]); f.owner.mergeCandidate = candidate;
    f.coordinator.mergeSource({ operationId: "unknown-merge", action: "start", targetId: "route-target" });
    await eventually(() => f.coordinator.snapshot().mergeSessions?.[0]?.status === "unknown");
    expect(f.owner.state.merge?.resolution?.status).toBe("active"); expect(f.store.listSessions()).toHaveLength(0);
    await expect(lstat(candidate)).resolves.toBeDefined(); expect(f.coordinator.busy()).toBe(true);
    f.coordinator.mergeSource({ operationId: "cancel-unknown-merge", action: "cancel" });
    await eventually(() => f.coordinator.snapshot().mergeOperations?.some(operation => operation.id === "cancel-unknown-merge" && operation.status === "unknown") ?? false);
    expect(f.owner.state.merge?.status).toBe("conflict"); expect(f.adapter.closed).toEqual([]);
  });

  it.each(["archive", "delete"] as const)("preserves the original %s lifecycle while ending the exact personal task", { timeout: 30_000 }, async disposition => {
    const f = await fixture(); f.owner.prepareTask = () => { throw new PersonalDevelopmentError("ENVIRONMENT_NOT_READY"); };
    const admitted = await f.coordinator.startTask(start());
    await eventually(() => f.coordinator.snapshot().preparations[0]?.status === "failed");
    const sessionId = f.coordinator.snapshot().preparations[0]!.sessionId!;
    const operationId = `generic-personal-${disposition}`;
    let cleanup = f.store.prepareSessionLifecycleCleanup({ operationId, sessionId, disposition, releaseWorktree: true, deleteNativeSession: disposition === "delete" });
    await expect(f.coordinator.settleSessionLifecycle(cleanup)).rejects.toMatchObject({ code: "PROCESS_UNKNOWN" });
    await f.host.prepareSessionLifecycleClose(sessionId, disposition); await f.host.closeIfActive(sessionId);
    f.terminalClosures.push(sessionId); cleanup = f.store.advanceSessionLifecycleCleanup({ operationId, phase: "close" });
    if (!cleanup.nativeCompleted) { await f.host.deleteNativeSession(sessionId, operationId); cleanup = f.store.advanceSessionLifecycleCleanup({ operationId, phase: "native" }); }
    const settled = await f.coordinator.settleSessionLifecycle(cleanup);
    expect(settled).toMatchObject({ operationId, disposition, worktreeCompleted: true });
    f.store.finalizeSessionLifecycleCleanup({ operationId });
    expect(f.store.getSession(sessionId).descriptor.archived).toBe(true);
    expect(f.store.getSession(sessionId).descriptor.deletedAt !== undefined).toBe(disposition === "delete");
    expect(f.owner.state.tasks[admitted.taskId]?.status).toBe("ended");
    expect(readPersonalDevelopmentPurpose(f.store, sessionId)?.endingOperationId).toBe(operationId);
  });

  it("resolves a retained candidate after graceful retirement without duplicating its first message", { timeout: 35_000 }, async () => {
    const f = await fixture(); const candidate = join(f.root, "personal", "merge-candidate");
    await git(join(f.root, "personal", "source"), ["worktree", "add", "--detach", candidate, "HEAD"]); f.owner.mergeCandidate = candidate;
    f.coordinator.mergeSource({ operationId: "retained-merge", action: "start", targetId: "route-target" });
    await eventually(() => f.adapter.context !== undefined);
    const sessionId = f.adapter.context!.sessionId;
    await f.coordinator.dispose();
    expect(f.coordinator.snapshot().mergeSessions?.[0]?.status).toBe("retired");
    expect(f.owner.state.merge?.resolution?.status).toBe("retired");
    const resumed = new PersonalDevelopmentCoordinator({ store: f.store, owner: f.owner as unknown as PersonalDevelopmentOwner, host: f.host, worktrees: f.worktrees,
      availability: () => ({ available: true, reason: "" }), closeTerminals: async id => { f.terminalClosures.push(id); }, sourceTarget: async () => ({ channel: "dev", version: "0.1.0" }) });
    await resumed.initialize(); cleanups.push(() => resumed.dispose());
    resumed.mergeSource({ operationId: "resolve-retained", action: "resolve", targetId: "route-target" });
    await eventually(() => resumed.snapshot().mergeSessions?.[0]?.status === "editing");
    expect(resumed.snapshot().mergeSessions?.[0]).toMatchObject({ sessionId, leaseId: "merge-lease-2" });
    expect(f.store.listQueueItems({ sessionId, limit: 10 })).toHaveLength(2);
    resumed.mergeSource({ operationId: "open-existing-merge", action: "resolve", targetId: "route-target" });
    await eventually(() => resumed.snapshot().mergeOperations?.some(operation => operation.id === "open-existing-merge" && operation.status === "succeeded") ?? false);
    expect(f.store.listQueueItems({ sessionId, limit: 10 })).toHaveLength(2);
  });
});

function start() { return { operationId: "personal-start", request: "Improve this application", title: "Personal change", targetId: "route-target",
  fastMode: false, permissionMode: "ask" as const, planMode: false }; }
function prompt(text: string): PromptInput { return { text, images: [], files: [], mentions: [], disposition: "prompt" }; }

class ControlledAdapter extends FakeBackendAdapter {
  context: AdapterContext | undefined;
  observedPurpose: unknown;
  readonly closed: string[] = [];
  #finish: (() => void) | undefined;
  constructor(readonly store: OperationalStore, readonly unknownCreation: boolean) { super({ ...PI_LIKE_PROFILE, id: "personal-backend" }); }
  override async createSession(input: CreateNativeSessionInput, context: AdapterContext): Promise<NativeSessionBinding> {
    this.observedPurpose = readPersonalDevelopmentPurpose(this.store, context.sessionId);
    const binding = await super.createSession(input, context);
    if (this.unknownCreation) throw new Error("Native creation outcome is unknown."); return binding;
  }
  override async send(input: PromptInput, context: AdapterContext): Promise<void> {
    this.context = context;
    await new Promise<void>(resolveFinish => { this.#finish = resolveFinish; });
    await super.send(input, context);
  }
  finish(): void { this.#finish?.(); }
  override async closeSession(_binding: NativeSessionBinding, context: AdapterContext): Promise<void> { this.closed.push(context.sessionId); this.finish(); }
}

class FixtureOwner {
  readonly #listeners = new Set<(state: DevelopmentState) => void>();
  #release!: () => void;
  readonly #prepared = new Promise<void>(resolvePrepared => { this.#release = resolvePrepared; });
  completions = 0;
  completedWithRetiredWriter = false;
  mergeCandidate: string | undefined;
  mergeAdoptedWithRetiredWriter = false;
  loseReleaseReply = false;
  preparationError: PersonalDevelopmentError | undefined;
  #mergeLease = 0;
  authority!: DevelopmentWorktreeAuthority;
  host!: SessionHost;
  state: DevelopmentState = { format: 1, generation: 0, environment: { status: "ready", checks: [] },
    source: { status: "ready", commit: "a".repeat(40) }, tasks: {}, history: [], versions: { selected: "original", switching: false }, operations: {} };
  constructor(readonly rootDirectory: string, readonly store: OperationalStore) {}
  async initialize() {}
  snapshot() { return structuredClone(this.state); }
  subscribe(listener: (state: DevelopmentState) => void) { this.#listeners.add(listener); listener(this.snapshot()); return () => { this.#listeners.delete(listener); }; }
  publish() { this.state = { ...this.state, generation: this.state.generation + 1 }; for (const listener of this.#listeners) listener(this.snapshot()); }
  allowPreparation() { this.#release(); }
  async #operate<T>(id: string, action: () => Promise<T>, kind = "fixture-operation"): Promise<DevelopmentOperationResult<T>> {
    this.state = { ...this.state, operations: { ...this.state.operations, [id]: { id, kind, inputHash: "0".repeat(64), status: "running", stage: "admitted", startedAt: Date.now() } } }; this.publish();
    try {
      const value = await action(); this.state = { ...this.state, operations: { ...this.state.operations, [id]: { ...this.state.operations[id]!, status: "succeeded" } } }; this.publish();
      return { operationId: id, value, replayed: false };
    } catch (error) {
      this.state = { ...this.state, operations: { ...this.state.operations, [id]: { ...this.state.operations[id]!,
        status: error instanceof PersonalDevelopmentError && error.code === "PROCESS_UNKNOWN" ? "unknown" : "failed" } } }; this.publish(); throw error;
    }
  }
  prepareTask(input: { taskId: string; sessionId: string; request: string; title: string; operationId: string }) {
    return this.#operate(input.operationId, async () => {
      const lease = await this.authority.acquire({ ...input, repositoryRoot: join(this.rootDirectory, "source"), sourceRef: "joko-personal", signal: new AbortController().signal });
      await this.#prepared;
      if (this.preparationError !== undefined) throw this.preparationError;
      const task: DevelopmentTask = { ...lease, request: input.request, title: input.title, status: "editing", createdAt: Date.now() };
      this.state = { ...this.state, tasks: { ...this.state.tasks, [task.taskId]: task } }; this.publish(); return task;
    }, "task-prepare");
  }
  completeTask(input: { taskId: string; completionId: string; operationId: string }) {
    return this.#operate(input.operationId, async () => {
      const task = this.state.tasks[input.taskId]!;
      this.completedWithRetiredWriter = !this.host.isSessionActive(task.sessionId)
        && readPersonalDevelopmentPurpose(this.store, task.sessionId)?.completion?.state === "retired";
      if (!this.completedWithRetiredWriter) throw new Error("Completion observed a live writer.");
      this.state = { ...this.state, tasks: { ...this.state.tasks, [task.taskId]: { ...task, status: "completed", completionId: input.completionId } } };
      this.completions += 1; this.publish(); return input.completionId;
    });
  }
  endTask(input: { taskId: string; operationId: string }) {
    return this.#operate(input.operationId, async () => {
      const task = this.state.tasks[input.taskId]!;
      const result = await this.authority.release(task, new AbortController().signal);
      if (result !== "released") throw new Error("Exact task checkout was preserved.");
      this.state = { ...this.state, tasks: { ...this.state.tasks, [task.taskId]: { ...task, status: "ended" } } }; this.publish(); return result;
    });
  }
  retireUnpreparedTask(input: { taskId: string; sessionId: string; title: string; request: string; operationId: string }) {
    return this.#operate(input.operationId, async () => {
      const signal = new AbortController().signal;
      const lease = await this.authority.acquire({ ...input, repositoryRoot: join(this.rootDirectory, "source"), sourceRef: "joko-personal", signal });
      this.state = { ...this.state, tasks: { ...this.state.tasks, [input.taskId]: { ...lease, request: input.request, title: input.title, status: "cleanup", createdAt: Date.now() } } }; this.publish();
      const result = await this.authority.release(lease, signal);
      if (result !== "released") throw new Error("Unprepared task was preserved.");
      if (this.loseReleaseReply) { this.loseReleaseReply = false; throw new PersonalDevelopmentError("PROCESS_UNKNOWN"); }
      this.state = { ...this.state, tasks: { ...this.state.tasks, [input.taskId]: { ...lease, request: input.request, title: input.title, status: "ended", createdAt: Date.now() } } }; this.publish(); return result;
    });
  }
  mergeSource(input: { action: "start" | "adopt" | "cancel"; operationId: string }) {
    return this.#operate(input.operationId, async () => {
      if (input.action === "start") {
        if (this.mergeCandidate === undefined) throw new Error("No merge candidate.");
        this.state = { ...this.state, merge: { id: input.operationId, status: "conflict", candidate: this.mergeCandidate,
          baselineCommit: "a".repeat(40), baselineTree: "b".repeat(40), upstreamCommit: "c".repeat(40) } }; this.publish();
      } else {
        const merge = this.state.merge!;
        this.mergeAdoptedWithRetiredWriter = merge.resolution?.status === "retired" && !this.host.isSessionActive(merge.resolution.sessionId);
        if (!this.mergeAdoptedWithRetiredWriter) throw new Error("Merge observed a live native writer.");
        this.state = { ...this.state, merge: { ...merge, status: input.action === "adopt" ? "adopted" : "cancelled" } }; this.publish();
      }
      return this.state.merge;
    });
  }
  acquireMergeResolution(input: { mergeId: string; sessionId: string }) {
    return this.#operate(`merge-acquire-${++this.#mergeLease}`, async () => {
      const merge = this.state.merge!;
      if (merge.id !== input.mergeId || !this.mergeCandidate) throw new Error("Changed merge candidate.");
      const leaseId = `merge-lease-${this.#mergeLease}`;
      this.state = { ...this.state, merge: { ...merge, resolution: { sessionId: input.sessionId, leaseId, status: "active" } } }; this.publish();
      return { directory: this.mergeCandidate, leaseId };
    });
  }
  releaseMergeResolution(input: { mergeId: string; sessionId: string; leaseId: string; outcome: "retired" | "unknown" }) {
    return this.#operate(`merge-release-${this.#mergeLease}`, async () => {
      const merge = this.state.merge!;
      if (merge.id !== input.mergeId || merge.resolution?.sessionId !== input.sessionId || merge.resolution.leaseId !== input.leaseId) throw new Error("Changed merge lease.");
      this.state = { ...this.state, merge: { ...merge, resolution: { ...merge.resolution, status: input.outcome } } }; this.publish(); return input.outcome;
    });
  }
  cancel() { this.allowPreparation(); return true; }
}

async function fixture(unknownCreation = false) {
  const root = await mkdtemp(join(tmpdir(), "joko-personal-composition-"));
  const ownerRoot = join(root, "personal"), sourceRoot = join(ownerRoot, "source");
  await mkdir(sourceRoot, { recursive: true });
  await git(sourceRoot, ["init", "--initial-branch=joko-personal"]);
  await git(sourceRoot, ["config", "user.name", "Joko Test"]); await git(sourceRoot, ["config", "user.email", "test@invalid.example"]);
  await writeFile(join(sourceRoot, "tracked.txt"), "initial\n"); await git(sourceRoot, ["add", "."]); await git(sourceRoot, ["commit", "-m", "initial"]);
  const store = new OperationalStore(join(root, "store.db"));
  const artifacts = new ArtifactStore({ rootDirectory: join(root, "artifacts"), repository: new OperationalArtifactRepository(store), ingestRoots: [root] });
  await artifacts.initialize(); const workspaces = new WorkspaceService();
  const worktrees = new SessionWorktreeCoordinator({ store, workspaces, storageRoot: join(root, "worktrees") });
  await worktrees.initialize(); const adapter = new ControlledAdapter(store, unknownCreation);
  let coordinator!: PersonalDevelopmentCoordinator;
  const host = new SessionHost(store, artifacts, [adapter], { worktrees, onServiceRunSettled: input => coordinator.onRunSettled(input) });
  await host.initialize();
  await host.registerTarget({ id: "route-target", backendId: adapter.id, displayName: "Route", workspaceRoot: sourceRoot, managed: false, trusted: true });
  const owner = new FixtureOwner(ownerRoot, store);
  owner.authority = createPersonalDevelopmentWorktreeAuthority({ store, worktrees, ownerId: personalDevelopmentOwnerIdentity(ownerRoot), sourceRoot }); owner.host = host;
  const terminalClosures: string[] = [];
  coordinator = new PersonalDevelopmentCoordinator({ store, owner: owner as unknown as PersonalDevelopmentOwner, host, worktrees,
    availability: () => ({ available: true, reason: "" }), closeTerminals: async id => { terminalClosures.push(id); }, sourceTarget: async () => ({ channel: "dev", version: "0.1.0" }) });
  await coordinator.initialize();
  cleanups.push(async () => { adapter.finish(); owner.allowPreparation(); await coordinator.dispose(); await host.dispose().catch(() => undefined);
    worktrees.dispose(); await workspaces.close(); store.close(); await rm(root, { recursive: true, force: true, maxRetries: 3 }); });
  return { root, owner, store, coordinator, adapter, host, worktrees, terminalClosures };
}
async function git(cwd: string, args: readonly string[]): Promise<void> {
  await new Promise<void>((resolveCommand, reject) => execFile("git", [...args], { cwd, windowsHide: true }, error => error ? reject(error) : resolveCommand()));
}
async function eventually(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (!check()) { if (Date.now() > deadline) throw new Error("Personal task did not reach its expected state."); await new Promise(resolveWait => setTimeout(resolveWait, 10)); }
}
