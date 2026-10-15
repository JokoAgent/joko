import { createHash, randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { mkdir } from "node:fs/promises";
import type { DevelopmentArtifact, DevelopmentChannel, DevelopmentHistoryEntry, DevelopmentOperation, DevelopmentOperationResult,
  DevelopmentOwnerOptions, DevelopmentProgress, DevelopmentSource, DevelopmentState, DevelopmentTask, DevelopmentTestState, DevelopmentToolCheck, DevelopmentVersionState } from "./types.js";
import { PersonalDevelopmentError } from "./types.js";
import { buildDevelopmentVersion, inspectDevelopmentArtifact, resolveDevelopmentRuntime, restoreDevelopmentBuild, type DevelopmentBuildJournal } from "./build.js";
import { DevelopmentTools, supportedDevelopmentHost } from "./tools.js";
import { DevelopmentRepository } from "./repository.js";
import { createLatestDevelopmentSourceReader } from "./latest-source.js";
import { DIGEST, directoryDigest, exists, GIT_IDENTITY, HASH, identity, managedPath, ordinaryDirectory, PERSONAL_BRANCH, readJson, removeManaged, safeRoot, writeJson } from "./storage.js";

interface DiskState { readonly format: 1; readonly state: DevelopmentState; readonly receipts: Readonly<Record<string, unknown>> }
const initial = (): DevelopmentState => ({ format: 1, generation: 0, environment: { status: "unchecked", checks: [] },
  source: { status: "missing" }, tasks: {}, history: [], versions: { selected: "original", switching: false }, operations: {} });
const clone = <T>(value: T): T => structuredClone(value);
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
function stateFromDisk(value: unknown): DiskState {
  if (!record(value) || value.format !== 1 || !record(value.state) || !record(value.receipts)) throw new PersonalDevelopmentError("STATE_INVALID");
  const state = value.state;
  if (state.format !== 1 || !Number.isSafeInteger(state.generation) || Number(state.generation) < 0
    || !record(state.environment) || !Array.isArray(state.environment.checks) || !record(state.source)
    || !record(state.tasks) || !Array.isArray(state.history) || !record(state.versions) || !record(state.operations)) throw new PersonalDevelopmentError("STATE_INVALID");
  for (const [id, raw] of Object.entries(state.operations)) {
    if (!record(raw) || raw.id !== id || !DIGEST.test(String(raw.inputHash)) || !["running", "succeeded", "failed", "cancelled", "unknown"].includes(String(raw.status))) throw new PersonalDevelopmentError("STATE_INVALID");
  }
  for (const [id, raw] of Object.entries(state.tasks)) {
    if (!record(raw) || raw.taskId !== id || typeof raw.sessionId !== "string" || typeof raw.leaseId !== "string"
      || typeof raw.path !== "string" || !HASH.test(String(raw.baseCommit)) || typeof raw.branch !== "string") throw new PersonalDevelopmentError("STATE_INVALID");
  }
  for (const raw of state.history) {
    if (!record(raw) || typeof raw.id !== "string" || !HASH.test(String(raw.baseCommit)) || !HASH.test(String(raw.tree)) || !HASH.test(String(raw.commit))) throw new PersonalDevelopmentError("STATE_INVALID");
  }
  if (state.merge !== undefined && (!record(state.merge) || state.merge.resolution !== undefined && (!record(state.merge.resolution)
    || typeof state.merge.resolution.sessionId !== "string" || typeof state.merge.resolution.leaseId !== "string"
    || !["active", "retired", "unknown"].includes(String(state.merge.resolution.status))))) throw new PersonalDevelopmentError("STATE_INVALID");
  return value as unknown as DiskState;
}

/** Service-owned current-v1 state. Client disconnects never cancel an admitted operation. */
export class PersonalDevelopmentOwner {
  readonly rootDirectory: string;
  readonly #options: DevelopmentOwnerOptions;
  readonly #tools: DevelopmentTools;
  readonly #repository: DevelopmentRepository;
  readonly #readLatestSource: ReturnType<typeof createLatestDevelopmentSourceReader>;
  #state: DevelopmentState = initial();
  #published: DevelopmentState = initial();
  #receipts: Record<string, unknown> = {};
  #initialize: Promise<void> | undefined;
  #saveFlight: Promise<void> = Promise.resolve();
  #flight: { readonly id: string; readonly kind: string; readonly hash: string; readonly controller: AbortController; readonly promise: Promise<DevelopmentOperationResult<unknown>> } | undefined;
  #closed = false;
  readonly #listeners = new Set<(state: DevelopmentState) => void>();
  readonly #liveTests = new Map<string, { readonly stop: () => void; readonly done: Promise<void> }>();
  constructor(options: DevelopmentOwnerOptions) {
    this.#options = options; this.rootDirectory = resolve(options.rootDirectory);
    if (options.rootDirectory !== this.rootDirectory) throw new PersonalDevelopmentError("UNSAFE_PATH");
    const process = { ...options.process, run: (input: Parameters<DevelopmentOwnerOptions["process"]["run"]>[0]) => options.process.run({ ...input,
      operationId: this.#flight?.id, commandJournalDirectory: join(this.rootDirectory, "command-journal") }) };
    this.#tools = new DevelopmentTools(this.rootDirectory, { ...options, process }); this.#repository = new DevelopmentRepository(this.rootDirectory, this.#tools);
    this.#readLatestSource = createLatestDevelopmentSourceReader(options.fetch ?? fetch, options.now ?? Date.now);
  }
  snapshot(): DevelopmentState { return clone(this.#published); }
  subscribe(listener: (state: DevelopmentState) => void): () => void {
    this.#listeners.add(listener); listener(this.snapshot()); return () => { this.#listeners.delete(listener); };
  }
  initialize(): Promise<void> { return this.#initialize ??= this.#open(); }
  async #open(): Promise<void> {
    await safeRoot(this.rootDirectory);
    const file = join(this.rootDirectory, "state.json");
    if (await exists(file)) {
      const disk = stateFromDisk(await readJson(file)); this.#state = disk.state; this.#published = clone(disk.state); this.#receipts = { ...disk.receipts };
      const operations = { ...this.#state.operations }; let recovered = false;
      if (this.#state.source.latestVersion !== undefined) { this.#state = { ...this.#state, source: { ...this.#state.source, latestVersion: undefined } }; recovered = true; }
      for (const [id, operation] of Object.entries(operations)) if (operation.status === "running") {
        operations[id] = { ...operation, status: "unknown", error: "PROCESS_UNKNOWN", stage: "recovery-required", finishedAt: this.#now() }; recovered = true;
      }
      if (recovered) {
        this.#state = { ...this.#state, operations, versions: { ...this.#state.versions, switching: this.#state.versions.pendingHandoff !== undefined } };
        await this.#save();
      }
    } else await this.#save();
  }
  #now(): number { return (this.#options.now ?? Date.now)(); }
  #assertOpen(): void { if (this.#closed) throw new PersonalDevelopmentError("OWNER_CHANGED"); }
  #save(): Promise<void> {
    const disk = clone({ format: 1 as const, state: { ...this.#state, generation: this.#state.generation + 1 }, receipts: this.#receipts });
    this.#state = disk.state;
    const saving = this.#saveFlight.then(() => writeJson(join(this.rootDirectory, "state.json"), disk));
    this.#saveFlight = saving.catch(() => undefined);
    return saving.then(() => {
      this.#published = clone(disk.state);
      for (const listener of this.#listeners) { try { listener(clone(disk.state)); } catch { /* An observer cannot roll back durable admission. */ } }
    });
  }
  async #stage(id: string, stage: string, details?: DevelopmentProgress): Promise<void> {
    const operation = this.#state.operations[id]; if (!operation || operation.status !== "running") throw new PersonalDevelopmentError("OWNER_CHANGED");
    this.#state = { ...this.#state, operations: { ...this.#state.operations, [id]: { ...operation, stage,
      percent: details?.percent, dependencyProgress: details?.dependencyProgress } } }; await this.#save();
  }
  async #operate<T>(kind: string, input: unknown, operationId: string | undefined,
    run: (signal: AbortSignal, operationId: string) => Promise<T>): Promise<DevelopmentOperationResult<T>> {
    this.#assertOpen(); await this.initialize(); this.#assertOpen();
    const platform = this.#options.platform ?? process.platform;
    const libc = this.#options.libc ?? (process.platform === "linux" && typeof (process.report.getReport() as { header?: { glibcVersionRuntime?: unknown } }).header?.glibcVersionRuntime === "string" ? "glibc" : undefined);
    if (!supportedDevelopmentHost(platform, this.#options.arch ?? process.arch) || platform === "linux" && libc !== "glibc") throw new PersonalDevelopmentError("UNSUPPORTED_PLATFORM");
    const id = identity(operationId ?? randomUUID()); const hash = createHash("sha256").update(JSON.stringify({ kind, input })).digest("hex");
    const current = this.#flight;
    if (current) {
      if (current.id === id) {
        if (current.hash !== hash || current.kind !== kind) throw new PersonalDevelopmentError("INVALID_ARGUMENT");
        return current.promise as Promise<DevelopmentOperationResult<T>>;
      }
      throw new PersonalDevelopmentError("BUSY");
    }
    const previous = this.#state.operations[id];
    if (previous) {
      if (previous.kind !== kind || previous.inputHash !== hash) throw new PersonalDevelopmentError("INVALID_ARGUMENT");
      if (previous.status === "succeeded" && Object.hasOwn(this.#receipts, id)) return { operationId: id, value: clone(this.#receipts[id]) as T, replayed: true };
      throw new PersonalDevelopmentError(previous.error ?? "PROCESS_UNKNOWN");
    }
    const controller = new AbortController();
    const operation: DevelopmentOperation = { id, kind, inputHash: hash, status: "running", stage: "admitted", startedAt: this.#now() };
    this.#state = { ...this.#state, operations: { ...this.#state.operations, [id]: operation } };
    const promise = (async (): Promise<DevelopmentOperationResult<T>> => {
      try {
        await this.#save();
        const value = await run(controller.signal, id);
        this.#receipts[id] = clone(value);
        this.#state = { ...this.#state, operations: { ...this.#state.operations, [id]: { ...this.#state.operations[id]!, status: "succeeded", stage: "completed", finishedAt: this.#now() } } };
        await this.#save(); return { operationId: id, value: clone(value), replayed: false };
      } catch (error) {
        const safe = error instanceof PersonalDevelopmentError ? error : new PersonalDevelopmentError(controller.signal.aborted ? "CANCELLED" : "COMMAND_FAILED");
        const status = safe.code === "PROCESS_UNKNOWN" ? "unknown" : safe.code === "CANCELLED" ? "cancelled" : "failed";
        const failed = this.#state.operations[id]!;
        const diagnostics = [...failed.diagnostics ?? [], { stage: failed.stage, code: safe.code, ...(safe.exitCode === undefined ? {} : { exitCode: safe.exitCode }) }].slice(-32);
        this.#state = { ...this.#state, operations: { ...this.#state.operations, [id]: { ...failed, status, error: safe.code, diagnostics, finishedAt: this.#now() } } };
        await this.#save(); throw safe;
      } finally { if (this.#flight?.id === id) this.#flight = undefined; }
    })();
    this.#flight = { id, kind, hash, controller, promise }; return promise;
  }
  cancel(operationId: string): boolean {
    if (this.#flight?.id !== operationId) return false; this.#flight.controller.abort(); return true;
  }
  async #check(signal: AbortSignal): Promise<readonly DevelopmentToolCheck[]> {
    const checks = await this.#tools.check(signal);
    this.#state = { ...this.#state, environment: { status: checks.every(check => check.status === "ready") ? "ready" : "failed", checks } }; await this.#save(); return checks;
  }
  async #requireEnvironment(signal: AbortSignal): Promise<void> {
    if (!(await this.#check(signal)).every(check => check.status === "ready")) throw new PersonalDevelopmentError("ENVIRONMENT_NOT_READY");
  }
  checkEnvironment(input: { readonly operationId?: string } = {}) {
    return this.#operate("environment-check", {}, input.operationId, signal => this.#check(signal));
  }
  prepareEnvironment(input: { readonly operationId?: string } = {}) {
    return this.#operate("environment-prepare", {}, input.operationId, async (signal, id) => {
      this.#assertNoUnknownWriter();
      this.#state = { ...this.#state, environment: { ...this.#state.environment, status: "preparing" } }; await this.#save();
      try {
      const checks = await this.#tools.prepare(signal, (stage, percent, check) => {
        if (check) this.#state = { ...this.#state, environment: { ...this.#state.environment,
          checks: this.#state.environment.checks.some(value => value.id === check.id) ? this.#state.environment.checks.map(value => value.id === check.id ? check : value) : [...this.#state.environment.checks, check] } };
        void this.#stage(id, stage, { stage, percent }).catch(() => undefined);
      });
      this.#state = { ...this.#state, environment: { status: checks.every(check => check.status === "ready") ? "ready" : "failed", checks } }; await this.#save(); return checks;
      } catch (error) {
        this.#state = { ...this.#state, environment: { ...this.#state.environment, status: "failed",
          checks: this.#state.environment.checks.map(check => ["downloading", "verifying", "extracting"].includes(check.status) ? { ...check, status: "failed" as const } : check) } }; await this.#save(); throw error;
      }
    });
  }
  prepareSource(input: { readonly channel: DevelopmentChannel; readonly version: string; readonly operationId?: string }) {
    const selection = { channel: input.channel, version: input.version };
    return this.#operate("source-prepare", selection, input.operationId, async (signal, id) => {
      this.#assertNoUnknownWriter();
      this.#assertNoMergeWriter();
      if (this.#state.merge && ["conflict", "ready"].includes(this.#state.merge.status)) throw new PersonalDevelopmentError("BUSY");
      await this.#requireEnvironment(signal);
      if (Object.values(this.#state.tasks).some(task => task.status === "preparing") || await this.#options.nativeVersions.busy()) throw new PersonalDevelopmentError("BUSY");
      this.#state = { ...this.#state, source: { ...selection, status: "preparing" } }; await this.#save();
      try {
        const source = await this.#repository.prepare(selection, signal, (stage, details) => this.#stage(id, stage, details));
        this.#state = { ...this.#state, source }; await this.#save(); return source;
      } catch (error) {
        const code = error instanceof PersonalDevelopmentError ? error.code : signal.aborted ? "CANCELLED" : "COMMAND_FAILED";
        this.#state = { ...this.#state, source: { ...selection, status: code === "CANCELLED" ? "cancelled" : "failed", error: code } }; await this.#save(); throw error;
      }
    });
  }
  clearSource(input: { readonly operationId?: string } = {}) {
    return this.#operate("source-clear", {}, input.operationId, async signal => {
      this.#assertNoUnknownWriter();
      this.#assertNoActiveTasks(); if (await this.#options.nativeVersions.busy()) throw new PersonalDevelopmentError("BUSY");
      if (await exists(this.#repository.source)) { await this.#requireEnvironment(signal); await this.#repository.clear(signal); }
      const source: DevelopmentSource = { status: "missing" }; this.#state = { ...this.#state, source }; await this.#save(); return source;
    });
  }
  refreshSourceStatus(input: { readonly operationId?: string } = {}) {
    return this.#operate("source-status", {}, input.operationId, async signal => {
      await this.#requireEnvironment(signal);
      const source = await this.#repository.readSourceStatus(this.#state.source, signal);
      if (source.status !== "ready") { this.#state = { ...this.#state, source }; await this.#save(); return clone(source); }
      const original = await this.#options.nativeVersions.original();
      const channel = source.channel ?? (original.development ? "dev" : /-beta(?:[.+-]|$)/u.test(original.version) ? "beta" : "release");
      this.#state = { ...this.#state, source: { ...source, latestVersion: { status: "checking", channel, checkedAt: this.#now() } } }; await this.#save();
      const latestVersion = await this.#readLatestSource(channel, source.mainCommit, signal);
      this.#state = { ...this.#state, source: { ...source, latestVersion } }; await this.#save(); return clone(this.#state.source);
    });
  }
  #assertNoActiveTasks(): void {
    if (Object.values(this.#state.tasks).some(task => ["preparing", "editing", "completed", "cleanup"].includes(task.status))) throw new PersonalDevelopmentError("BUSY");
    if (this.#state.merge && ["conflict", "ready"].includes(this.#state.merge.status)) throw new PersonalDevelopmentError("BUSY");
    if (Object.values(this.#state.tests ?? {}).some(test => test.status !== "stopped")) throw new PersonalDevelopmentError("BUSY");
  }
  #assertNoMergeWriter(): void {
    const resolution = this.#state.merge?.resolution;
    if (resolution && resolution.status !== "retired") throw new PersonalDevelopmentError("BUSY");
  }
  #assertNoUnknownWriter(): void {
    if (Object.values(this.#state.operations).some(operation => operation.status === "unknown" && !["version-action", "version-reconcile"].includes(operation.kind))) {
      throw new PersonalDevelopmentError("BUSY");
    }
  }
  #recordVerifiedTaskCleanup(task: DevelopmentTask): void {
    const operations = { ...this.#state.operations };
    for (const [id, operation] of Object.entries(operations)) {
      if (operation.status !== "unknown" || !["task-end", "task-retire-unprepared"].includes(operation.kind)) continue;
      const input = operation.kind === "task-end" ? { taskId: task.taskId }
        : { taskId: task.taskId, sessionId: task.sessionId, title: task.title, request: task.request };
      const expected = createHash("sha256").update(JSON.stringify({ kind: operation.kind, input })).digest("hex");
      if (operation.inputHash !== expected) continue;
      operations[id] = { ...operation, status: "succeeded", error: undefined, stage: "cleanup-verified", finishedAt: this.#now() };
      this.#receipts[id] = "released";
    }
    this.#state = { ...this.#state, operations };
  }
  #task(taskId: string): DevelopmentTask {
    const task = this.#state.tasks[identity(taskId)]; if (!task) throw new PersonalDevelopmentError("INVALID_ARGUMENT"); return task;
  }
  prepareTask(input: { readonly taskId: string; readonly sessionId: string; readonly request: string; readonly title: string; readonly operationId?: string }) {
    const data = { taskId: identity(input.taskId), sessionId: input.sessionId, request: input.request, title: input.title };
    if (!data.sessionId || data.sessionId.length > 256 || !data.request.trim() || data.request.length > 4000 || data.title.length > 512) throw new PersonalDevelopmentError("INVALID_ARGUMENT");
    return this.#operate("task-prepare", data, input.operationId, async (signal, id) => {
      this.#assertNoUnknownWriter();
      await this.#requireEnvironment(signal); await this.#repository.assertSource(signal);
      const previous = this.#state.tasks[data.taskId];
      if (previous && (previous.sessionId !== data.sessionId || previous.request !== data.request)) throw new PersonalDevelopmentError("INVALID_ARGUMENT");
      const lease = await this.#options.worktrees.acquire({ taskId: data.taskId, sessionId: data.sessionId,
        repositoryRoot: this.#repository.source, sourceRef: PERSONAL_BRANCH, signal });
      if (lease.taskId !== data.taskId || lease.sessionId !== data.sessionId || lease.branch === PERSONAL_BRANCH || !HASH.test(lease.baseCommit)) throw new PersonalDevelopmentError("OWNER_CHANGED");
      await this.#options.worktrees.assertCurrent(lease);
      const task: DevelopmentTask = { ...lease, request: data.request, title: data.title, status: "preparing", createdAt: previous?.createdAt ?? this.#now() };
      this.#state = { ...this.#state, tasks: { ...this.#state.tasks, [task.taskId]: task } }; await this.#save();
      await this.#stage(id, "installing-task-dependencies");
      try {
        await this.#options.worktrees.withUse(lease, signal, async () => {
          await this.#options.worktrees.assertCurrent(lease);
          await this.#tools.run("pnpm", ["install", "--frozen-lockfile", "--prefer-offline", "--prod=false"], lease.path, signal, {
            timeoutMs: 20 * 60_000, onProgress: details => { void this.#stage(id, "installing-task-dependencies", details).catch(() => undefined); } });
          await this.#options.worktrees.assertCurrent(lease);
        }, { operationId: id });
        const ready: DevelopmentTask = { ...task, status: "editing" };
        this.#state = { ...this.#state, tasks: { ...this.#state.tasks, [task.taskId]: ready } }; await this.#save(); return ready;
      } catch (error) {
        this.#state = { ...this.#state, tasks: { ...this.#state.tasks, [task.taskId]: { ...task, status: signal.aborted ? "cancelled" : "failed" } } }; await this.#save(); throw error;
      }
    });
  }
  completeTask(input: { readonly taskId: string; readonly completionId: string; readonly operationId?: string }) {
    const completionId = identity(input.completionId);
    return this.#operate("task-complete", { taskId: input.taskId, completionId }, input.operationId, async (signal, id) => {
      this.#assertNoUnknownWriter();
      await this.#requireEnvironment(signal); const task = this.#task(input.taskId);
      return this.#options.worktrees.withUse(task, signal, async () => {
        await this.#options.worktrees.assertCurrent(task);
        const completed = await this.#repository.commit(task.path, signal, "feat(personal): complete requested changes");
        // JSON history alone does not keep Git objects alive after the task branch is reclaimed.
        await this.#repository.git(["update-ref", `refs/joko-personal/completions/${completionId}`, completed.commit], task.path, signal);
        await this.#options.worktrees.assertCurrent(task);
        const entry: DevelopmentHistoryEntry = { id: completionId, taskId: task.taskId, sessionId: task.sessionId, title: task.title,
          baseCommit: task.baseCommit, tree: completed.tree, commit: completed.commit, createdAt: this.#now(), state: "available" };
        const existing = this.#state.history.find(value => value.id === completionId);
        if (existing && (existing.taskId !== task.taskId || existing.tree !== completed.tree)) throw new PersonalDevelopmentError("SOURCE_CHANGED");
        this.#state = { ...this.#state, history: existing ? this.#state.history : [...this.#state.history, entry],
          tasks: { ...this.#state.tasks, [task.taskId]: { ...task, status: "completed", completionId, completedTree: completed.tree } } };
        await this.#save(); return existing ?? entry;
      }, { operationId: id });
    });
  }
  continueTask(input: { readonly taskId: string; readonly operationId?: string }) {
    return this.#operate("task-continue", { taskId: input.taskId }, input.operationId, async signal => {
      this.#assertNoUnknownWriter();
      await this.#stopTest(input.taskId, signal);
      const task = this.#task(input.taskId); await this.#options.worktrees.assertCurrent(task);
      if (task.status === "ended" || task.status === "cleanup") throw new PersonalDevelopmentError("BUSY");
      const next: DevelopmentTask = { ...task, status: "editing", completionId: undefined, completedTree: undefined };
      this.#state = { ...this.#state, tasks: { ...this.#state.tasks, [task.taskId]: next } }; await this.#save(); return next;
    });
  }
  endTask(input: { readonly taskId: string; readonly operationId?: string }) {
    return this.#operate("task-end", { taskId: input.taskId }, input.operationId, async signal => {
      await this.#stopTest(input.taskId, signal);
      const task = this.#task(input.taskId); if (task.status === "ended") return "released" as const;
      if (task.status !== "cleanup") {
        this.#assertNoUnknownWriter();
        await this.#options.worktrees.assertCurrent(task);
        await this.#requireEnvironment(signal);
        const retained = await this.#repository.commit(task.path, signal, "chore(personal): preserve task before cleanup");
        await this.#repository.git(["update-ref", `refs/joko-personal/ended-tasks/${task.taskId}`, retained.commit], task.path, signal);
        this.#state = { ...this.#state, tasks: { ...this.#state.tasks, [task.taskId]: { ...task, status: "cleanup" } } }; await this.#save();
      }
      const result = await this.#options.worktrees.release(task, signal);
      if (result !== "released") throw new PersonalDevelopmentError("BUSY");
      this.#recordVerifiedTaskCleanup(task);
      this.#state = { ...this.#state, tasks: { ...this.#state.tasks, [task.taskId]: { ...task, status: "ended" } } }; await this.#save(); return result;
    });
  }
  /** Trusted Session intent may retire an adopted checkout whose dependency preparation never reached task persistence. */
  retireUnpreparedTask(input: { readonly taskId: string; readonly sessionId: string; readonly title: string; readonly request: string; readonly operationId?: string }) {
    const data = { taskId: identity(input.taskId), sessionId: input.sessionId, title: input.title, request: input.request };
    if (!data.sessionId || data.sessionId.length > 256 || !data.request.trim() || data.request.length > 4000 || data.title.length > 512) throw new PersonalDevelopmentError("INVALID_ARGUMENT");
    return this.#operate("task-retire-unprepared", data, input.operationId, async signal => {
      let task = this.#state.tasks[data.taskId];
      if (task && (task.sessionId !== data.sessionId || task.request !== data.request)) throw new PersonalDevelopmentError("OWNER_CHANGED");
      if (task?.status === "ended") return "released" as const;
      if (task && task.status !== "cleanup") throw new PersonalDevelopmentError("BUSY");
      if (!task) {
        const lease = await this.#options.worktrees.acquire({ taskId: data.taskId, sessionId: data.sessionId,
          repositoryRoot: this.#repository.source, sourceRef: PERSONAL_BRANCH, signal });
        if (lease.taskId !== data.taskId || lease.sessionId !== data.sessionId || lease.branch === PERSONAL_BRANCH || !HASH.test(lease.baseCommit)) throw new PersonalDevelopmentError("OWNER_CHANGED");
        await this.#options.worktrees.assertCurrent(lease);
        task = { ...lease, request: data.request, title: data.title, status: "cleanup", createdAt: this.#now() };
        this.#state = { ...this.#state, tasks: { ...this.#state.tasks, [task.taskId]: task } }; await this.#save();
      }
      // Safe release owns the clean/dirty decision. Missing preparation never authorizes deleting authored files.
      const outcome = await this.#options.worktrees.release(task, signal);
      if (outcome !== "released") throw new PersonalDevelopmentError("BUSY");
      this.#recordVerifiedTaskCleanup(task);
      this.#state = { ...this.#state, tasks: { ...this.#state.tasks, [task.taskId]: { ...task, status: "ended" } } }; await this.#save(); return outcome;
    });
  }
  history(): readonly DevelopmentHistoryEntry[] { return clone(this.#published.history); }
  testTask(input: { readonly taskId: string; readonly action: "start" | "stop"; readonly operationId?: string }) {
    if (!["start", "stop"].includes(input.action)) throw new PersonalDevelopmentError("INVALID_ARGUMENT");
    return this.#operate("task-test", { taskId: input.taskId, action: input.action }, input.operationId, async (signal, id) => {
      if (input.action === "stop") { await this.#stopTest(input.taskId, signal); return clone(this.#state.tests?.[input.taskId] ?? null); }
      this.#assertNoUnknownWriter();
      const native = this.#options.nativeVersions;
      if (!native.startTest || !native.stopTest) throw new PersonalDevelopmentError("VERSION_UNAVAILABLE");
      const task = this.#task(input.taskId);
      if (task.status !== "completed" || !task.completionId || !task.completedTree) throw new PersonalDevelopmentError("BUSY");
      if (this.#state.tests?.[task.taskId]?.status === "running") return clone(this.#state.tests[task.taskId]!);
      await this.#stopTest(task.taskId, signal); await this.#requireEnvironment(signal);
      let resolveStarted!: (state: DevelopmentTestState) => void; let rejectStarted!: (error: unknown) => void;
      const started = new Promise<DevelopmentTestState>((resolveStart, rejectStart) => { resolveStarted = resolveStart; rejectStarted = rejectStart; });
      let stop!: () => void; const stopped = new Promise<void>(resolveStop => { stop = resolveStop; });
      const lifetime = new AbortController(); const abort = (): void => { lifetime.abort(); stop(); };
      signal.addEventListener("abort", abort, { once: true }); if (signal.aborted) abort();
      let receipt: string | undefined; let launched = false;
      const done = this.#options.worktrees.withUse(task, lifetime.signal, async () => {
        try {
          await this.#options.worktrees.assertCurrent(task);
          if (await this.#repository.snapshot(task.path, lifetime.signal) !== task.completedTree) throw new PersonalDevelopmentError("SOURCE_CHANGED");
          this.#state = { ...this.#state, tests: { ...this.#state.tests, [task.taskId]: { completionId: task.completionId!, status: "building" } } }; await this.#save();
          const release = join(task.path, "apps", "desktop", "release");
          if (await exists(release)) await removeManaged(task.path, release);
          await this.#tools.run("pnpm", ["build:desktop:unpacked"], task.path, lifetime.signal, { timeoutMs: 60 * 60_000 });
          await this.#options.worktrees.assertCurrent(task);
          if (await this.#repository.snapshot(task.path, lifetime.signal) !== task.completedTree) throw new PersonalDevelopmentError("SOURCE_CHANGED");
          const runtime = await resolveDevelopmentRuntime(release, this.#options.platform ?? process.platform, this.#options.arch ?? process.arch);
          const runtimeDigest = await directoryDigest(runtime.runtimeDirectory);
          receipt = await native.startTest!({ ...runtime, taskId: task.taskId, sessionId: task.sessionId, completionId: task.completionId!, runtimeDigest }, lifetime.signal);
          if (!receipt || receipt.length > 256) throw new PersonalDevelopmentError("PROCESS_UNKNOWN");
          const ready: DevelopmentTestState = { completionId: task.completionId!, status: "running", receipt, runtimeDigest };
          this.#state = { ...this.#state, tests: { ...this.#state.tests, [task.taskId]: ready } }; await this.#save();
          launched = true; signal.removeEventListener("abort", abort); resolveStarted(ready);
          await stopped;
          if (await native.stopTest!(receipt, new AbortController().signal) !== "retired") throw new PersonalDevelopmentError("PROCESS_UNKNOWN");
          this.#state = { ...this.#state, tests: { ...this.#state.tests, [task.taskId]: { ...ready, status: "stopped" } } }; await this.#save();
        } catch (error) {
          const unknown = error instanceof PersonalDevelopmentError && error.code === "PROCESS_UNKNOWN";
          this.#state = { ...this.#state, tests: { ...this.#state.tests, [task.taskId]: { completionId: task.completionId!, receipt,
            status: unknown || !!receipt ? "unknown" : "stopped" } } }; await this.#save();
          if (!launched) rejectStarted(error); throw error;
        } finally { signal.removeEventListener("abort", abort); }
      }, { operationId: id }).catch(error => { rejectStarted(error); throw error; }).finally(() => { this.#liveTests.delete(task.taskId); });
      this.#liveTests.set(task.taskId, { stop, done }); void done.catch(() => undefined); return started;
    });
  }
  async #stopTest(taskId: string, signal: AbortSignal): Promise<void> {
    const live = this.#liveTests.get(taskId);
    if (live) { live.stop(); await live.done; return; }
    const test = this.#state.tests?.[taskId]; if (!test || test.status === "stopped") return;
    let receipt = test.receipt;
    if (!receipt && this.#options.nativeVersions.findTest) {
      const observed = await this.#options.nativeVersions.findTest(taskId, test.completionId);
      if (observed.status === "retired") {
        this.#state = { ...this.#state, tests: { ...this.#state.tests, [taskId]: { ...test, status: "stopped" } } }; await this.#save(); return;
      }
      receipt = observed.receipt;
    }
    if (!receipt || !this.#options.nativeVersions.stopTest) throw new PersonalDevelopmentError("PROCESS_UNKNOWN");
    if (await this.#options.nativeVersions.stopTest(receipt, signal) !== "retired") throw new PersonalDevelopmentError("PROCESS_UNKNOWN");
    this.#state = { ...this.#state, tests: { ...this.#state.tests, [taskId]: { ...test, status: "stopped" } } }; await this.#save();
  }
  /** Verified native exit observations cannot retire a newer test occupying the same task. */
  async reconcileTestExit(input: { readonly taskId: string; readonly receipt: string; readonly outcome: "retired" | "unknown" }): Promise<void> {
    this.#assertOpen(); await this.initialize(); const test = this.#state.tests?.[input.taskId];
    if (!test || test.receipt !== input.receipt) throw new PersonalDevelopmentError("OWNER_CHANGED");
    if (input.outcome === "retired") { await this.#stopTest(input.taskId, new AbortController().signal); return; }
    if (input.outcome !== "unknown") throw new PersonalDevelopmentError("INVALID_ARGUMENT");
    this.#state = { ...this.#state, tests: { ...this.#state.tests, [input.taskId]: { ...test, status: "unknown" } } }; await this.#save();
  }
  actHistory(input: { readonly entryId: string; readonly action: "integrate" | "revert" | "reapply" | "hide"; readonly operationId?: string }) {
    return this.#operate("history-action", { entryId: input.entryId, action: input.action }, input.operationId, async (signal, id) => {
      const entry = this.#state.history.find(value => value.id === input.entryId); if (!entry) throw new PersonalDevelopmentError("INVALID_ARGUMENT");
      if (input.action === "hide") {
        const task = this.#state.tasks[entry.taskId]; if (task && task.status !== "ended") throw new PersonalDevelopmentError("BUSY");
        this.#state = { ...this.#state, history: this.#state.history.map(value => value.id === entry.id ? { ...value, hidden: true } : value) }; await this.#save(); return this.history();
      }
      this.#assertNoMergeWriter();
      this.#assertNoUnknownWriter();
      await this.#requireEnvironment(signal); await this.#repository.assertSource(signal);
      if (await this.#options.nativeVersions.busy()) throw new PersonalDevelopmentError("BUSY");
      const latest = entry.receipts?.at(-1);
      if (input.action === "revert" && (!latest || entry.state !== "integrated") || input.action === "integrate" && entry.state === "integrated"
        || input.action === "reapply" && entry.state !== "removed") throw new PersonalDevelopmentError("INVALID_ARGUMENT");
      const repo = this.#repository; const original = await repo.commit(repo.source, signal, "chore(personal): preserve local changes");
      const candidate = await repo.candidate(randomUUID(), original.commit, signal); let unknown = false;
      try {
        const before = input.action === "revert" ? latest!.afterTree : await repo.git(["rev-parse", `${entry.baseCommit}^{tree}`], candidate, signal);
        const after = input.action === "revert" ? latest!.beforeTree : entry.tree;
        await repo.apply(candidate, before, after, signal, true);
        const next = await repo.commit(candidate, signal, `feat(personal): ${input.action} selected changes`);
        await this.#stage(id, "adopting-history");
        if (await repo.head(repo.source, signal) !== original.commit || await repo.snapshot(repo.source, signal) !== original.tree) throw new PersonalDevelopmentError("SOURCE_CHANGED");
        await writeJson(join(repo.root, "build-journal.json"), { format: 1, id, originalCommit: original.commit, originalTree: original.tree,
          candidateCommit: next.commit, candidateTree: next.tree, candidateDirectory: candidate, stage: "adopting" });
        await repo.apply(repo.source, original.tree, next.tree, signal);
        await repo.git(["update-ref", `refs/heads/${PERSONAL_BRANCH}`, next.commit, original.commit], repo.source, signal);
        await repo.git(["reset", "--mixed", next.commit], repo.source, signal);
        const receipt = { id, action: input.action, beforeCommit: original.commit, beforeTree: original.tree,
          afterCommit: next.commit, afterTree: next.tree, at: this.#now() };
        const updated: DevelopmentHistoryEntry = { ...entry, state: input.action === "revert" ? "removed" : "integrated", integratedCommit: next.commit, receipts: [...entry.receipts ?? [], receipt] };
        this.#state = { ...this.#state, history: this.#state.history.map(value => value.id === entry.id ? updated : value) }; await this.#save();
        await writeJson(join(repo.root, "build-journal.json"), { format: 1, id, originalCommit: original.commit, originalTree: original.tree,
          candidateCommit: next.commit, candidateTree: next.tree, candidateDirectory: candidate, stage: "published" });
        return this.history();
      } catch (error) {
        unknown = error instanceof PersonalDevelopmentError && error.code === "PROCESS_UNKNOWN";
        if (!unknown) await restoreDevelopmentBuild(repo, new AbortController().signal); throw error;
      } finally { if (!unknown && await exists(candidate)) await repo.removeCandidate(candidate, new AbortController().signal).catch(() => undefined); }
    });
  }
  build(input: { readonly taskId?: string; readonly entryIds?: readonly string[]; readonly operationId?: string } = {}) {
    const selection = { taskId: input.taskId, entryIds: input.entryIds ? [...new Set(input.entryIds)] : undefined };
    return this.#operate("personal-build", selection, input.operationId, async (signal, id) => {
      this.#assertNoUnknownWriter();
      this.#assertNoMergeWriter();
      if (input.taskId) await this.#stopTest(input.taskId, signal);
      await this.#requireEnvironment(signal); if (await this.#options.nativeVersions.busy()) throw new PersonalDevelopmentError("BUSY");
      if (this.#state.syncLatestBeforeBuild) {
        await this.#merge("start", id, signal);
        if (this.#state.merge?.status === "conflict") throw new PersonalDevelopmentError("CONFLICT");
        if (this.#state.merge?.status === "ready") await this.#merge("adopt", id, signal);
      }
      const task = input.taskId ? this.#task(input.taskId) : undefined;
      if (task && task.status !== "completed") throw new PersonalDevelopmentError("BUSY");
      const ids = selection.entryIds ?? (task?.completionId ? [task.completionId] : []);
      const entries = ids.map(entryId => { const entry = this.#state.history.find(value => value.id === entryId); if (!entry) throw new PersonalDevelopmentError("INVALID_ARGUMENT"); return entry; });
      const run = () => buildDevelopmentVersion({ repository: this.#repository, options: this.#options, operationId: id, entries, signal,
        progress: (stage, details) => this.#stage(id, stage, details), beforePublish: async (artifact, integrations) => {
          const personal = this.#state.versions.personal;
          this.#state = { ...this.#state, versions: { ...this.#state.versions, personal: artifact },
            source: { ...this.#state.source, commit: artifact.commit },
            history: this.#state.history.map(entry => {
              const integration = integrations.find(value => value.entryId === entry.id); if (!integration) return entry;
              return { ...entry, state: "integrated", integratedCommit: artifact.commit, receipts: [...entry.receipts ?? [], {
                id, action: "integrate", beforeCommit: integration.beforeCommit, beforeTree: integration.beforeTree,
                afterCommit: integration.afterCommit, afterTree: integration.afterTree, at: this.#now()
              }] };
            }) };
          try { await this.#save(); } catch (error) { this.#state = { ...this.#state, versions: { ...this.#state.versions, personal } }; throw error; }
        } });
      if (!task) return run();
      return this.#options.worktrees.withUse(task, signal, async () => {
        await this.#options.worktrees.assertCurrent(task);
        if (await this.#repository.snapshot(task.path, signal) !== task.completedTree) throw new PersonalDevelopmentError("SOURCE_CHANGED");
        return run();
      }, { operationId: id });
    });
  }
  recoverBuild(input: { readonly operationId?: string } = {}) {
    return this.#operate("build-recover", {}, input.operationId, async signal => {
      this.#assertNoUnknownWriter();
      this.#assertNoMergeWriter();
      if (await this.#options.nativeVersions.busy()) throw new PersonalDevelopmentError("BUSY");
      await this.#requireEnvironment(signal); const restored = await restoreDevelopmentBuild(this.#repository, signal);
      const merge = this.#state.merge;
      if (merge?.status === "adopted" && await exists(merge.candidate)) await this.#repository.removeCandidate(merge.candidate, signal);
      return restored;
    });
  }
  recoverUnknownWriters(input: { readonly operationId?: string } = {}) {
    return this.#operate("process-recover", {}, input.operationId, async () => {
      const recovered: string[] = [], unknown: string[] = [];
      const operations = { ...this.#state.operations };
      for (const [id, operation] of Object.entries(operations)) {
        if (operation.status !== "unknown" || ["version-action", "version-reconcile"].includes(operation.kind)) continue;
        if (operation.kind === "task-test" && Object.values(this.#state.tests ?? {}).some(test => test.status !== "stopped")) { unknown.push(id); continue; }
        const proof = await this.#options.process.recover?.({ operationId: id, journalDirectory: join(this.rootDirectory, "command-journal") }).catch(() => undefined);
        if (proof?.status !== "retired" || proof.commandIds.length === 0) { unknown.push(id); continue; }
        // The Session authority alone owns the durable operation-to-worktree/token association.
        if (await this.#options.worktrees.reconcileRetiredUses({ operationId: id, commandIds: proof.commandIds }).catch(() => "unknown" as const) !== "retired") { unknown.push(id); continue; }
        operations[id] = { ...operation, status: "failed", error: "COMMAND_FAILED", stage: "writer-retirement-verified", finishedAt: this.#now() };
        delete this.#receipts[id]; recovered.push(id);
      }
      this.#state = { ...this.#state, operations }; await this.#save(); return { recovered, unknown };
    });
  }
  setSyncLatestBeforeBuild(input: { readonly enabled: boolean; readonly operationId?: string }) {
    if (typeof input.enabled !== "boolean") throw new PersonalDevelopmentError("INVALID_ARGUMENT");
    return this.#operate("source-sync-setting", { enabled: input.enabled }, input.operationId, async () => {
      this.#state = { ...this.#state, syncLatestBeforeBuild: input.enabled }; await this.#save(); return input.enabled;
    });
  }
  mergeSource(input: { readonly action: "start" | "adopt" | "cancel"; readonly expectedMergeId?: string; readonly operationId?: string }) {
    if (!["start", "adopt", "cancel"].includes(input.action)) throw new PersonalDevelopmentError("INVALID_ARGUMENT");
    const expectedMergeId = input.expectedMergeId === undefined ? undefined : identity(input.expectedMergeId);
    return this.#operate("source-merge", { action: input.action, expectedMergeId }, input.operationId, async (signal, id) => {
      this.#assertNoUnknownWriter();
      if (expectedMergeId !== undefined && this.#state.merge?.id !== expectedMergeId) throw new PersonalDevelopmentError("OWNER_CHANGED");
      await this.#requireEnvironment(signal); if (await this.#options.nativeVersions.busy()) throw new PersonalDevelopmentError("BUSY");
      await this.#merge(input.action, id, signal); return clone(this.#state.merge ?? null);
    });
  }
  /** The Orchestrator must persist exact Session-purpose intent before this lease and before any native creation effect. */
  acquireMergeResolution(input: { readonly mergeId: string; readonly sessionId: string; readonly operationId?: string }) {
    const data = { mergeId: identity(input.mergeId), sessionId: input.sessionId };
    if (!data.sessionId || data.sessionId.length > 256) throw new PersonalDevelopmentError("INVALID_ARGUMENT");
    return this.#operate("merge-resolution-acquire", data, input.operationId, async signal => {
      this.#assertNoUnknownWriter();
      const pending = this.#state.merge;
      if (!pending || pending.id !== data.mergeId || !["conflict", "ready"].includes(pending.status)) throw new PersonalDevelopmentError("OWNER_CHANGED");
      if (pending.resolution && (pending.resolution.status === "unknown" || pending.resolution.status === "active" && pending.resolution.sessionId !== data.sessionId)) throw new PersonalDevelopmentError("BUSY");
      await this.#requireEnvironment(signal); await this.#repository.assertSource(signal); await this.#repository.assertCandidate(pending.candidate, signal);
      const leaseId = pending.resolution?.status === "active" ? pending.resolution.leaseId : randomUUID();
      this.#state = { ...this.#state, merge: { ...pending, resolution: { sessionId: data.sessionId, leaseId, status: "active" } } }; await this.#save();
      return { directory: pending.candidate, leaseId };
    });
  }
  /** Only exact native retirement proof may remove the persistent candidate writer fence. */
  releaseMergeResolution(input: { readonly mergeId: string; readonly sessionId: string; readonly leaseId: string; readonly outcome: "retired" | "unknown"; readonly operationId?: string }) {
    const data = { mergeId: identity(input.mergeId), sessionId: input.sessionId, leaseId: identity(input.leaseId), outcome: input.outcome };
    if (!["retired", "unknown"].includes(data.outcome)) throw new PersonalDevelopmentError("INVALID_ARGUMENT");
    return this.#operate("merge-resolution-release", data, input.operationId, async () => {
      const pending = this.#state.merge; const resolution = pending?.resolution;
      if (!pending || pending.id !== data.mergeId || !resolution || resolution.sessionId !== data.sessionId || resolution.leaseId !== data.leaseId) throw new PersonalDevelopmentError("OWNER_CHANGED");
      if (resolution.status === "retired" && data.outcome === "unknown") throw new PersonalDevelopmentError("OWNER_CHANGED");
      this.#state = { ...this.#state, merge: { ...pending, resolution: { ...resolution, status: data.outcome } } }; await this.#save(); return data.outcome;
    });
  }
  async #merge(action: "start" | "adopt" | "cancel", id: string, signal: AbortSignal): Promise<void> {
    this.#assertNoMergeWriter();
    const repo = this.#repository; await repo.assertSource(signal);
    const pending = this.#state.merge;
    if (action === "cancel") {
      if (!pending || !["conflict", "ready"].includes(pending.status)) throw new PersonalDevelopmentError("INVALID_ARGUMENT");
      await managedPath(this.rootDirectory, pending.candidate);
      await repo.removeCandidate(pending.candidate, signal);
      this.#state = { ...this.#state, merge: { ...pending, status: "cancelled" } }; await this.#save(); return;
    }
    if (action === "start") {
      if (pending && ["conflict", "ready"].includes(pending.status)) throw new PersonalDevelopmentError("BUSY");
      await repo.git(["fetch", "--tags", "--force", "origin"], repo.source, signal);
      let upstreamRef = "origin/main";
      if (this.#state.source.channel !== "dev") {
        const tags = (await repo.git(["tag", "--list"], repo.source, signal)).split(/\r?\n/u).filter(tag => /^v\d+\.\d+\.\d+(?:-beta)?$/u.test(tag));
        const versions = tags.map(tag => tag.replace(/-beta$/u, "")).sort((left, right) => {
          const a = left.slice(1).split(".").map(Number); const b = right.slice(1).split(".").map(Number);
          return (b[0]! - a[0]!) || (b[1]! - a[1]!) || (b[2]! - a[2]!);
        });
        const latest = versions[0]; if (!latest) throw new PersonalDevelopmentError("TAG_NOT_FOUND");
        const selected = this.#state.source.channel === "beta" && tags.includes(`${latest}-beta`) ? `${latest}-beta` : latest;
        if (!tags.includes(selected)) throw new PersonalDevelopmentError("TAG_NOT_FOUND"); upstreamRef = `refs/tags/${selected}`;
      }
      const upstreamCommit = await repo.git(["rev-parse", `${upstreamRef}^{commit}`], repo.source, signal);
      const base = await repo.commit(repo.source, signal, "chore(personal): preserve changes before source update");
      try { await repo.git(["merge-base", "--is-ancestor", upstreamCommit, base.commit], repo.source, signal); return; }
      catch (error) { if (!(error instanceof PersonalDevelopmentError) || error.exitCode !== 1) throw error; }
      const candidate = await repo.candidate(randomUUID(), base.commit, signal);
      let status: "ready" | "conflict" = "ready";
      try { await repo.git([...GIT_IDENTITY, "merge", "--no-commit", "--no-ff", upstreamCommit], candidate, signal); }
      catch (error) {
        if (error instanceof PersonalDevelopmentError && error.exitCode === 1 && await repo.git(["ls-files", "--unmerged"], candidate, signal)) status = "conflict";
        else { if (!(error instanceof PersonalDevelopmentError) || error.code !== "PROCESS_UNKNOWN") await repo.removeCandidate(candidate, new AbortController().signal).catch(() => undefined); throw error; }
      }
      this.#state = { ...this.#state, merge: { id, candidate, status, baselineCommit: base.commit, baselineTree: base.tree, upstreamCommit } }; await this.#save(); return;
    }
    if (!pending || !["conflict", "ready"].includes(pending.status)) throw new PersonalDevelopmentError("INVALID_ARGUMENT");
    await managedPath(this.rootDirectory, pending.candidate);
    const next = await repo.commit(pending.candidate, signal, "feat(personal): merge source updates", undefined, true);
    if (await repo.head(repo.source, signal) !== pending.baselineCommit || await repo.snapshot(repo.source, signal) !== pending.baselineTree) throw new PersonalDevelopmentError("SOURCE_CHANGED");
    const mainBefore = await repo.readRef("refs/heads/main", signal), personalUpstreamBefore = await repo.readRef("refs/joko-personal/personal-upstream", signal);
    if (mainBefore && mainBefore !== pending.upstreamCommit) {
      try { await repo.git(["merge-base", "--is-ancestor", mainBefore, pending.upstreamCommit], repo.source, signal); }
      catch (error) { if (error instanceof PersonalDevelopmentError && error.exitCode === 1) throw new PersonalDevelopmentError("SOURCE_CHANGED"); throw error; }
    }
    if (mainBefore) await repo.git(["update-ref", `refs/joko-personal/merge-backups/${pending.id}/${id}/main`, mainBefore], repo.source, signal);
    if (personalUpstreamBefore) await repo.git(["update-ref", `refs/joko-personal/merge-backups/${pending.id}/${id}/upstream`, personalUpstreamBefore], repo.source, signal);
    const journal: DevelopmentBuildJournal = { format: 1, id, originalCommit: pending.baselineCommit, originalTree: pending.baselineTree,
      candidateCommit: next.commit, candidateTree: next.tree, candidateDirectory: pending.candidate, stage: "adopting", preserveCandidate: true,
      sourceRefUpdate: { mainBefore: mainBefore ?? null, personalUpstreamBefore: personalUpstreamBefore ?? null, target: pending.upstreamCommit } };
    await writeJson(join(repo.root, "build-journal.json"), journal);
    try {
      await repo.apply(repo.source, pending.baselineTree, next.tree, signal);
      await repo.git(["update-ref", `refs/heads/${PERSONAL_BRANCH}`, next.commit, pending.baselineCommit], repo.source, signal);
      await repo.git(["reset", "--mixed", next.commit], repo.source, signal);
      await repo.git(["update-ref", "refs/heads/main", pending.upstreamCommit, mainBefore ?? "0".repeat(pending.upstreamCommit.length)], repo.source, signal);
      await repo.git(["update-ref", "refs/joko-personal/personal-upstream", pending.upstreamCommit, personalUpstreamBefore ?? "0".repeat(pending.upstreamCommit.length)], repo.source, signal);
      const source = await repo.readSourceStatus({ ...this.#state.source, commit: next.commit, upstreamCommit: pending.upstreamCommit }, signal);
      await writeJson(join(repo.root, "build-journal.json"), { ...journal, stage: "published" });
      this.#state = { ...this.#state, merge: { ...pending, status: "adopted" }, source }; await this.#save();
    } catch (error) {
      if (!(error instanceof PersonalDevelopmentError) || error.code !== "PROCESS_UNKNOWN") await restoreDevelopmentBuild(repo, new AbortController().signal);
      throw error;
    }
    await repo.removeCandidate(pending.candidate, signal);
  }
  versions(): DevelopmentVersionState { return clone(this.#published.versions); }
  refreshVersions(input: { readonly operationId?: string } = {}) {
    return this.#operate("version-refresh", {}, input.operationId, async () => {
      const original = await this.#options.nativeVersions.original(); const current = await this.#options.nativeVersions.current();
      if (current.id !== "original" && current.id !== "personal" || current.id === "personal" && (!current.generation || !identity(current.generation))) throw new PersonalDevelopmentError("VERSION_UNAVAILABLE");
      this.#state = { ...this.#state, versions: { ...this.#state.versions, original: { version: original.version, development: original.development },
        currentId: current.id, currentGeneration: current.generation } }; await this.#save(); return this.versions();
    });
  }
  async actVersion(input: { readonly action: "switch" | "remove"; readonly id: "original" | "personal"; readonly operationId?: string }) {
    if (!["switch", "remove"].includes(input.action) || !["original", "personal"].includes(input.id)) throw new PersonalDevelopmentError("INVALID_ARGUMENT");
    const completed = await this.#operate("version-action", { action: input.action, id: input.id }, input.operationId, async (signal, operationId) => {
      this.#assertNoUnknownWriter();
      this.#assertNoMergeWriter();
      if (this.#state.versions.switching) throw new PersonalDevelopmentError("BUSY");
      if (await this.#options.nativeVersions.busy()) throw new PersonalDevelopmentError("BUSY");
      const current = await this.#options.nativeVersions.current(); const personal = this.#state.versions.personal;
      if (input.action === "remove") {
        if (input.id !== "personal" || current.id !== "original" || this.#state.versions.selected !== "original" || !personal) throw new PersonalDevelopmentError("BUSY");
        await inspectDevelopmentArtifact(personal, this.rootDirectory);
        // Retire the public slot before deleting its exact owned generation.
        this.#state = { ...this.#state, versions: { selected: "original", switching: false } }; await this.#save();
        await removeManaged(this.rootDirectory, personal.directory); return this.versions();
      }
      const original = await this.#options.nativeVersions.original();
      let target;
      if (input.id === "personal") {
        if (!personal) throw new PersonalDevelopmentError("VERSION_UNAVAILABLE");
        await inspectDevelopmentArtifact(personal, this.rootDirectory);
        if (personal.compatibilityIdentity !== original.compatibilityIdentity) throw new PersonalDevelopmentError("VERSION_INCOMPATIBLE");
        target = { id: "personal" as const, generation: personal.id, runtimeDirectory: personal.runtimeDirectory,
          executable: personal.executable, runtimeDigest: personal.runtimeDigest, compatibilityIdentity: personal.compatibilityIdentity };
      } else {
        target = { id: "original" as const, runtimeDirectory: original.runtimeDirectory, executable: original.executable,
          runtimeDigest: await directoryDigest(original.runtimeDirectory), compatibilityIdentity: original.compatibilityIdentity };
      }
      if (current.id === target.id && current.generation === target.generation) return this.versions();
      this.#state = { ...this.#state, versions: { ...this.#state.versions, switching: true } }; await this.#save();
      const outcome = await this.#options.nativeVersions.handoff({ ...target, operationId }, signal);
      if (outcome.status === "queued") {
        const ticketId = identity(outcome.ticketId);
        this.#state = { ...this.#state, versions: { ...this.#state.versions, switching: true, pendingHandoff: {
          ticketId, operationId, targetId: target.id, targetGeneration: target.generation,
          previousId: current.id, previousGeneration: current.generation, status: "queued"
        } } }; await this.#save();
      } else {
        this.#state = { ...this.#state, versions: { ...this.#state.versions, switching: outcome.status === "unknown" } }; await this.#save();
        throw new PersonalDevelopmentError(outcome.status === "unknown" ? "PROCESS_UNKNOWN" : "VERSION_UNAVAILABLE");
      }
      return this.versions();
    });
    const pending = this.#state.versions.pendingHandoff;
    if (pending?.status === "queued" && pending.operationId === completed.operationId && this.#options.nativeVersions.activateHandoff) {
      try { await this.#options.nativeVersions.activateHandoff(pending.ticketId); }
      catch {
        if (this.#state.versions.pendingHandoff?.ticketId === pending.ticketId) {
          this.#state = { ...this.#state, versions: { ...this.#state.versions, pendingHandoff: { ...pending, status: "unknown" } } }; await this.#save();
        }
      }
    }
    return { ...completed, value: this.versions() };
  }
  /** Only a verified native broker proof may call this service-private reconciliation entry. */
  reconcileVersionHandoff(input: { readonly ticketId: string; readonly outcome: "ready" | "failed" | "unknown";
    readonly current: { readonly id: "original" | "personal"; readonly generation?: string }; readonly operationId?: string }) {
    const ticketId = identity(input.ticketId);
    if (!["ready", "failed", "unknown"].includes(input.outcome)) throw new PersonalDevelopmentError("INVALID_ARGUMENT");
    return this.#operate("version-reconcile", { ticketId, outcome: input.outcome, current: input.current }, input.operationId, async () => {
      const pending = this.#state.versions.pendingHandoff;
      if (!pending || pending.ticketId !== ticketId) throw new PersonalDevelopmentError("OWNER_CHANGED");
      if (input.outcome === "unknown") {
        this.#state = { ...this.#state, versions: { ...this.#state.versions, switching: true, pendingHandoff: { ...pending, status: "unknown" } } };
      } else {
        const id = input.outcome === "ready" ? pending.targetId : pending.previousId;
        const generation = input.outcome === "ready" ? pending.targetGeneration : pending.previousGeneration;
        if (input.current.id !== id || input.current.generation !== generation) throw new PersonalDevelopmentError("OWNER_CHANGED");
        this.#state = { ...this.#state, versions: { ...this.#state.versions, switching: false, selected: id,
          currentId: id, currentGeneration: generation, pendingHandoff: undefined } };
      }
      await this.#save(); return this.versions();
    });
  }
  revealBuild(input: { readonly operationId?: string } = {}) {
    return this.#operate("build-reveal", {}, input.operationId, async () => {
      const artifact = this.#state.versions.personal; if (!artifact) throw new PersonalDevelopmentError("VERSION_UNAVAILABLE");
      await inspectDevelopmentArtifact(artifact, this.rootDirectory); await this.#options.nativeVersions.reveal(join(artifact.directory, artifact.installer)); return true;
    });
  }
  async dispose(): Promise<void> {
    this.#closed = true; this.#flight?.controller.abort(); await this.#flight?.promise.catch(() => undefined);
    for (const taskId of [...this.#liveTests.keys()]) await this.#stopTest(taskId, new AbortController().signal).catch(() => undefined);
    await this.#saveFlight; this.#listeners.clear();
  }
}
