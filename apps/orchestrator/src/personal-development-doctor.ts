import { createHash } from "node:crypto";
import { PersonalDevelopmentError, type PersonalDevelopmentOwner } from "@joko/personal-development";
import { operationBodyHash, type OperationalStore } from "@joko/store";
import { personalDevelopmentIdentity, type PersonalDevelopmentCoordinator } from "./personal-development-coordinator.js";
import type { createPersonalDevelopmentDoctorPrerequisites } from "./personal-development-doctor-environment.js";
import type { DevelopmentDoctorCheck, DevelopmentDoctorRun, DevelopmentDoctorStartInput, DevelopmentUpstreamRuntime } from "./personal-development-doctor-types.js";
import { PersonalDevelopmentSettingsEnvironment, safeDevelopmentDoctorCheck } from "./personal-development-settings-environment.js";
import { searchPersonalDevelopmentUpstream } from "./personal-development-upstream.js";
import type { SessionHost } from "./session-host.js";

const SCOPE = "personal-development-doctor", CHECK_IDS = ["platform", "git", "gitLfs", "node", "pnpm", "python", "native", "storage"];
const stableId = (prefix: string, value: string) => `${prefix}-${createHash("sha256").update(value).digest("hex").slice(0, 40)}`;
interface DoctorRecord {
  readonly format: 1; readonly ownerId: string; readonly inputHash: string; readonly input: DevelopmentDoctorStartInput;
  readonly creationOperationId: string; readonly sessionGeneration?: number;
  readonly report: DevelopmentDoctorRun; readonly controls: Readonly<Record<string, { readonly action: string }>>;
}
interface DoctorFlight { readonly controller: AbortController; readonly attempt: number; readonly promise: Promise<void>; ownerOperationId?: string }
type DoctorHost = Pick<SessionHost, "createServiceSession" | "getSessionRuntimeControl">;

/** Durable Session cards composed without a QueueItem or an Agent turn. */
export class PersonalDevelopmentDoctor {
  readonly #listeners = new Set<() => void>();
  readonly #flights = new Map<string, DoctorFlight>();
  readonly #starts = new Map<string, Promise<DevelopmentDoctorRun>>();
  #unsubscribeOwner: (() => void) | undefined;
  #unsubscribeCoordinator: (() => void) | undefined;
  #unsubscribeSettingsEnvironment: (() => void) | undefined;
  readonly #settingsEnvironment: PersonalDevelopmentSettingsEnvironment;
  #closed = false;
  constructor(readonly options: { readonly store: OperationalStore; readonly owner: PersonalDevelopmentOwner; readonly host: DoctorHost;
    readonly coordinator: PersonalDevelopmentCoordinator; readonly prerequisites: ReturnType<typeof createPersonalDevelopmentDoctorPrerequisites>;
    readonly runtime: () => DevelopmentUpstreamRuntime | Promise<DevelopmentUpstreamRuntime>; readonly fetch: typeof fetch;
    readonly now?: () => number; readonly platform?: string; readonly arch?: string }) {
    this.#settingsEnvironment = new PersonalDevelopmentSettingsEnvironment({ ...options, ownerId: options.coordinator.ownerId, assertAvailable: () => this.#assertAvailable() });
  }
  get #now(): number { return this.options.now?.() ?? Date.now(); }
  get #ownerId(): string { return this.options.coordinator.ownerId; }
  initialize(): void {
    this.#settingsEnvironment.initialize();
    this.#unsubscribeSettingsEnvironment = this.#settingsEnvironment.subscribe(() => { for (const listener of this.#listeners) listener(); });
    for (const record of this.#records()) if (record.report.status === "running") {
      this.#save({ ...record, report: { ...record.report, status: "unknown", stage: "recovery-required", error: "PROCESS_UNKNOWN", updatedAt: this.#now } });
    }
    this.#unsubscribeOwner = this.options.owner.subscribe(state => {
      for (const [runId, flight] of this.#flights) {
        if (!flight.ownerOperationId) continue;
        const record = this.#record(runId); if (record.report.attempt !== flight.attempt || record.report.status !== "running") continue;
        const operation = state.operations[flight.ownerOperationId]; if (!operation) continue;
        const tools = state.environment.checks.map(safeDevelopmentDoctorCheck);
        const installing = operation.stage.startsWith("installing:") ? operation.stage.slice("installing:".length) : undefined;
        const checks = record.report.checks.map(check => tools.find(tool => tool.id === check.id)
          ?? (installing === check.id ? { ...check, status: "checking" as const, reason: "installing" } : check));
        this.#save({ ...record, report: { ...record.report, checks, operation, ...(record.report.stage === "source" ? { source: state.source } : {}), updatedAt: this.#now } });
      }
    });
    this.#unsubscribeCoordinator = this.options.coordinator.subscribe(() => this.#syncTasks()); this.#syncTasks();
  }
  snapshot(): readonly DevelopmentDoctorRun[] { return this.#records().map(record => structuredClone(record.report)).sort((a, b) => a.createdAt - b.createdAt); }
  settingsEnvironment() { return this.#settingsEnvironment.snapshot(); }
  settingsEnvironmentOperations() { return this.#settingsEnvironment.operations(); }
  runSettingsEnvironment(input: { readonly operationId: string; readonly mode: "check" | "prepare" }): string { return this.#settingsEnvironment.run(input); }
  cancelSettingsEnvironment(operationId: string): boolean { return this.#settingsEnvironment.cancel(operationId); }
  subscribe(listener: () => void): () => void { this.#listeners.add(listener); listener(); return () => { this.#listeners.delete(listener); }; }
  #records(): readonly DoctorRecord[] {
    return this.options.store.listSettings("service", SCOPE).filter(setting => setting.key.startsWith(`${this.#ownerId}:`)).map(setting => {
      const value = setting.value as DoctorRecord;
      if (value?.format !== 1 || value.ownerId !== this.#ownerId || !value.input || !value.report || value.report.runId !== setting.key.slice(this.#ownerId.length + 1)
        || !["running", "completed", "cancelled", "failed", "unknown"].includes(value.report.status) || !Number.isSafeInteger(value.report.attempt)) throw new PersonalDevelopmentError("STATE_INVALID");
      return value;
    });
  }
  #record(runId: string): DoctorRecord { personalDevelopmentIdentity(runId); const value = this.#records().find(record => record.report.runId === runId);
    if (!value) throw new PersonalDevelopmentError("INVALID_ARGUMENT"); return value; }
  #save(value: DoctorRecord): void {
    this.options.store.setSetting("service", SCOPE, `${this.#ownerId}:${value.report.runId}`, JSON.parse(JSON.stringify(value)) as DoctorRecord);
    for (const listener of this.#listeners) listener();
  }
  #assertAvailable(): void {
    if (this.#closed || !this.options.coordinator.availability().available) throw new PersonalDevelopmentError("OWNER_CHANGED");
  }
  #assertSession(record: DoctorRecord): void {
    this.#assertAvailable(); if (!record.report.sessionId) throw new PersonalDevelopmentError("PROCESS_UNKNOWN");
    const session = this.options.store.getSession(record.report.sessionId).descriptor, target = this.options.store.getTarget(session.targetId).descriptor;
    if (session.deletedAt !== undefined || session.archived || session.remoteWorkspace !== undefined || target.remoteWorkspace !== undefined || !target.trusted
      || session.binding.generation !== record.sessionGeneration || target.backendId !== this.options.store.getTarget(record.input.targetId).descriptor.backendId) throw new PersonalDevelopmentError("OWNER_CHANGED");
  }
  #recoverContainer(record: DoctorRecord): DoctorRecord {
    if (record.report.sessionId) return record;
    try {
      const operation = this.options.store.getOperation<{ sessionId: string }>(record.creationOperationId);
      if (operation.status !== "completed" || !operation.response?.sessionId) return record;
      const body = operation.body as Record<string, unknown>;
      if (operation.kind !== "create_personal_development_session" || body.serviceKind !== "personal_development" || body.worktree != null
        || (["targetId", "providerId", "modelId", "effort", "fastMode", "permissionMode", "planMode"] as const).some(key => (body[key] ?? undefined) !== record.input[key])
        || body.title !== record.input.title.trim()) return record;
      const session = this.options.store.getSession(operation.response.sessionId).descriptor;
      if (session.targetId !== record.input.targetId) return record;
      const effective = this.options.host.getSessionRuntimeControl(session.id).effective ?? session;
      const recovered: DoctorRecord = { ...record, sessionGeneration: session.binding.generation, input: { ...record.input,
        providerId: effective.providerId, modelId: effective.modelId, effort: effective.effort, fastMode: effective.fastMode,
        permissionMode: session.permissionMode, planMode: session.planMode }, report: { ...record.report, sessionId: session.id, updatedAt: this.#now } };
      this.#assertSession(recovered); this.#save(recovered); return recovered;
    } catch { return record; }
  }
  start(input: DevelopmentDoctorStartInput): Promise<DevelopmentDoctorRun> {
    this.#assertAvailable(); personalDevelopmentIdentity(input.operationId);
    if (!input.title.trim() || input.title.length > 200 || input.request.length > 4_000 || input.mode !== "check" && input.mode !== "prepare"
      || !["ask", "acceptEdits", "auto", "bypassPermissions"].includes(input.permissionMode)) throw new PersonalDevelopmentError("INVALID_ARGUMENT");
    const runId = stableId("doctor", `${this.#ownerId}:${input.operationId}`), inputHash = operationBodyHash(input);
    const existing = this.#records().find(record => record.report.runId === runId);
    if (existing) {
      if (existing.inputHash !== inputHash) throw new PersonalDevelopmentError("INVALID_ARGUMENT");
      return this.#starts.get(runId) ?? Promise.resolve(structuredClone(this.#recoverContainer(existing).report));
    }
    const target = this.options.store.getTarget(input.targetId).descriptor;
    if (!target.trusted || target.remoteWorkspace !== undefined) throw new PersonalDevelopmentError("OWNER_CHANGED");
    const origin = input.sessionId ? this.options.store.getSession(input.sessionId).descriptor : undefined;
    if (origin && (origin.archived || origin.deletedAt !== undefined || origin.remoteWorkspace !== undefined || origin.backendId !== target.backendId)) throw new PersonalDevelopmentError("OWNER_CHANGED");
    const effective = origin ? this.options.host.getSessionRuntimeControl(origin.id).effective ?? origin : undefined;
    const normalized: DevelopmentDoctorStartInput = effective ? { ...input, providerId: effective.providerId, modelId: effective.modelId, effort: effective.effort,
      fastMode: effective.fastMode, permissionMode: origin!.permissionMode, planMode: origin!.planMode } : input;
    const record: DoctorRecord = { format: 1, ownerId: this.#ownerId, inputHash, input: normalized,
      creationOperationId: stableId("doctor-container", runId), controls: {}, ...(origin ? { sessionGeneration: origin.binding.generation } : {}),
      report: { runId, sessionId: origin?.id ?? "", mode: input.mode, request: input.request, status: "running", stage: origin ? "environment" : "creating-session",
        checks: CHECK_IDS.map(id => ({ id, status: "pending" })), ...(input.mode === "prepare" ? { upstream: { status: "pending", items: [] } } : {}),
        createdAt: this.#now, updatedAt: this.#now, attempt: 1, platform: this.options.platform ?? process.platform, arch: this.options.arch ?? process.arch } };
    this.#save(record);
    const pending = this.#createAndStart(record).finally(() => { this.#starts.delete(runId); }); this.#starts.set(runId, pending); return pending;
  }
  async #createAndStart(initial: DoctorRecord): Promise<DevelopmentDoctorRun> {
    try {
      let record = initial;
      if (!record.report.sessionId) {
        const input = record.input;
        const created = await this.options.host.createServiceSession({ operationId: record.creationOperationId, serviceKind: "personal_development", targetId: input.targetId,
          title: input.title.trim(), providerId: input.providerId, modelId: input.modelId, effort: input.effort, fastMode: input.fastMode,
          permissionMode: input.permissionMode, planMode: input.planMode, assertServiceScope: () => this.#assertAvailable() });
        this.#assertAvailable(); const session = this.options.store.getSession(created.value.sessionId).descriptor;
        const effective = this.options.host.getSessionRuntimeControl(session.id).effective ?? session;
        record = { ...record, sessionGeneration: session.binding.generation, input: { ...record.input,
          providerId: effective.providerId, modelId: effective.modelId, effort: effective.effort, fastMode: effective.fastMode,
          permissionMode: session.permissionMode, planMode: session.planMode }, report: { ...record.report, sessionId: session.id, stage: "environment", updatedAt: this.#now } }; this.#save(record);
      }
      this.#launch(record); return structuredClone(this.#record(record.report.runId).report);
    } catch (error) {
      const record = this.#record(initial.report.runId), code = error instanceof PersonalDevelopmentError ? error.code : "PROCESS_UNKNOWN";
      const report = { ...record.report, status: code === "PROCESS_UNKNOWN" ? "unknown" as const : "failed" as const, error: code, updatedAt: this.#now };
      this.#save({ ...record, report }); return structuredClone(report);
    }
  }
  #launch(record: DoctorRecord): void {
    const controller = new AbortController(), runId = record.report.runId;
    // Defer execution until the flight is installed so synchronous Owner publication is observed.
    const promise = Promise.resolve().then(() => this.#run(runId, record.report.attempt, controller));
    this.#flights.set(runId, { controller, attempt: record.report.attempt, promise });
    void promise.finally(() => { if (this.#flights.get(runId)?.controller === controller) this.#flights.delete(runId); }).catch(() => undefined);
  }
  async #run(runId: string, attempt: number, controller: AbortController): Promise<void> {
    const timeout = setTimeout(() => controller.abort("timeout"), this.#record(runId).report.mode === "check" ? 60_000 : 20 * 60_000); timeout.unref();
    const signal = controller.signal, flight = this.#flights.get(runId)!;
    const cancel = () => { if (flight.ownerOperationId) this.options.owner.cancel(flight.ownerOperationId); }; signal.addEventListener("abort", cancel, { once: true });
    const assert = () => { signal.throwIfAborted(); const record = this.#record(runId); if (record.report.attempt !== attempt) throw new PersonalDevelopmentError("OWNER_CHANGED"); this.#assertSession(record); return record; };
    const update = (patch: Partial<DevelopmentDoctorRun>) => { const record = this.#record(runId); if (record.report.attempt !== attempt) return;
      this.#save({ ...record, report: { ...record.report, ...patch, updatedAt: this.#now } }); };
    try {
      let record = assert(); const platform = this.options.prerequisites.platform(); update({ checks: record.report.checks.map(check => check.id === "platform" ? platform : check) });
      if (platform.status !== "ready") throw new PersonalDevelopmentError("UNSUPPORTED_PLATFORM");
      flight.ownerOperationId = stableId("doctor-environment", `${runId}:${attempt}`);
      if (record.input.mode === "check") await this.options.owner.checkEnvironment({ operationId: flight.ownerOperationId });
      else await this.options.owner.prepareEnvironment({ operationId: flight.ownerOperationId });
      record = assert(); const tools: DevelopmentDoctorCheck[] = this.options.owner.snapshot().environment.checks.map(safeDevelopmentDoctorCheck);
      update({ checks: record.report.checks.map(check => tools.find(tool => tool.id === check.id) ?? check) });
      for (const id of ["native", "storage"] as const) {
        record = assert(); update({ checks: record.report.checks.map(check => check.id === id ? { id, status: "checking" } : check) });
        const check = await this.options.prerequisites[id](signal); record = assert(); update({ checks: record.report.checks.map(value => value.id === id ? check : value) });
      }
      record = assert();
      if (record.input.mode === "check" || !record.report.checks.every(check => check.status === "ready")) {
        update({ status: "completed", stage: "completed", ...(!record.report.checks.every(check => check.status === "ready") ? { error: "ENVIRONMENT_NOT_READY" } : {}) }); return;
      }
      if (!record.input.request.trim()) { update({ status: "completed", stage: "completed", upstream: { status: "needsRequest", items: [] } }); return; }
      update({ stage: "source" }); const target = await this.options.coordinator.sourceTarget(); assert();
      flight.ownerOperationId = stableId("doctor-source", `${runId}:${attempt}`);
      await this.options.owner.prepareSource({ ...target, operationId: flight.ownerOperationId }); record = assert();
      const source = this.options.owner.snapshot().source; if (source.status !== "ready") throw new PersonalDevelopmentError("SOURCE_MISSING");
      update({ source, stage: "upstream", upstream: { status: "searching", items: [] } });
      const runtime = await this.options.runtime(); assert();
      const upstream = await searchPersonalDevelopmentUpstream(record.input.request, signal, { fetch: this.options.fetch, runtime,
        isCurrent: async () => { assert(); return operationBodyHash(await this.options.runtime()) === operationBodyHash(runtime); } });
      assert(); update({ status: "completed", stage: "completed", upstream });
    } catch (error) {
      const code = error instanceof PersonalDevelopmentError ? error.code : signal.aborted ? "CANCELLED" : "PROCESS_UNKNOWN";
      const record = this.#record(runId);
      update({ status: code === "PROCESS_UNKNOWN" ? "unknown" : signal.aborted && signal.reason !== "timeout" ? "cancelled" : "failed",
        stage: "stopped", error: signal.reason === "timeout" ? "TIMEOUT" : code,
        ...(record.report.stage === "source" ? { source: this.options.owner.snapshot().source } : {}),
        checks: record.report.checks.map(check => ["pending", "checking", "downloading", "verifying", "extracting"].includes(check.status) ? { ...check, status: signal.aborted ? "cancelled" : "failed" } : check),
        ...(record.report.upstream?.status === "searching" ? { upstream: { status: signal.aborted ? "cancelled" : "failed", items: [] } } : {}) });
    } finally { clearTimeout(timeout); signal.removeEventListener("abort", cancel); }
  }
  async control(input: { readonly operationId: string; readonly runId: string; readonly action: "cancel" | "retry" | "wait" | "personal" }): Promise<DevelopmentDoctorRun> {
    this.#assertAvailable(); personalDevelopmentIdentity(input.operationId); let record = this.#recoverContainer(this.#record(input.runId)); this.#assertSession(record);
    const receipt = record.controls[input.operationId];
    if (receipt && receipt.action !== input.action) throw new PersonalDevelopmentError("INVALID_ARGUMENT");
    if (receipt) return structuredClone(record.report);
    if (input.action === "cancel") {
      const flight = this.#flights.get(input.runId); flight?.controller.abort(); if (flight?.ownerOperationId) this.options.owner.cancel(flight.ownerOperationId);
      this.#save({ ...record, controls: { ...record.controls, [input.operationId]: { action: input.action } } }); return structuredClone(this.#record(input.runId).report);
    }
    if (input.action === "retry") {
      if (this.#flights.has(input.runId) || record.report.decision === "personal" || record.report.taskId !== undefined || record.report.codeSessionId !== undefined
        || Object.values(this.options.owner.snapshot().operations).some(operation => operation.status === "unknown")) throw new PersonalDevelopmentError("BUSY");
      record = { ...record, controls: { ...record.controls, [input.operationId]: { action: input.action } }, report: { ...record.report, status: "running", stage: "environment", error: undefined, decision: undefined,
        upstream: record.input.mode === "prepare" ? { status: "pending", items: [] } : undefined, checks: CHECK_IDS.map(id => ({ id, status: "pending" })), attempt: record.report.attempt + 1, updatedAt: this.#now } };
      this.#save(record); this.#launch(record); return structuredClone(record.report);
    }
    if (record.report.status !== "completed" || !["found", "notFound"].includes(record.report.upstream?.status ?? "")
      || record.report.decision !== undefined && record.report.decision !== input.action) throw new PersonalDevelopmentError("INVALID_ARGUMENT");
    record = { ...record, controls: { ...record.controls, [input.operationId]: { action: input.action } }, report: { ...record.report, decision: input.action, updatedAt: this.#now } };
    this.#save(record);
    if (input.action === "personal" && !record.report.taskId) {
      const origin = this.options.store.getSession(record.report.sessionId).descriptor, effective = this.options.host.getSessionRuntimeControl(origin.id).effective ?? origin;
      if (effective.providerId !== record.input.providerId || effective.modelId !== record.input.modelId || effective.effort !== record.input.effort
        || effective.fastMode !== record.input.fastMode || origin.permissionMode !== record.input.permissionMode || origin.planMode !== record.input.planMode) throw new PersonalDevelopmentError("OWNER_CHANGED");
      const intent = await this.options.coordinator.startTask({ ...record.input, operationId: stableId("doctor-personal", record.report.runId), originSessionId: record.report.sessionId });
      record = this.#record(input.runId); this.#save({ ...record, report: { ...record.report, taskId: intent.taskId, codeSessionId: intent.sessionId, updatedAt: this.#now } }); this.#syncTasks();
    }
    return structuredClone(this.#record(input.runId).report);
  }
  #syncTasks(): void {
    if (this.#closed) return;
    const tasks = this.options.coordinator.snapshot().preparations;
    for (const record of this.#records()) {
      const operationId = stableId("doctor-personal", record.report.runId), task = tasks.find(value => value.operationId === operationId);
      if (!task || record.report.taskId === task.taskId && record.report.codeSessionId === task.sessionId) continue;
      this.#save({ ...record, report: { ...record.report, taskId: task.taskId, codeSessionId: task.sessionId, updatedAt: this.#now } });
    }
  }
  async dispose(): Promise<void> {
    this.#closed = true; this.#unsubscribeOwner?.(); this.#unsubscribeCoordinator?.(); this.#unsubscribeSettingsEnvironment?.();
    await this.#settingsEnvironment.dispose();
    for (const flight of this.#flights.values()) { flight.controller.abort(); if (flight.ownerOperationId) this.options.owner.cancel(flight.ownerOperationId); }
    await Promise.allSettled([...this.#starts.values(), ...[...this.#flights.values()].map(flight => flight.promise)]); this.#listeners.clear();
  }
}
