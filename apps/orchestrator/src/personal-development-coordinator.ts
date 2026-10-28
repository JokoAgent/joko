import { createHash } from "node:crypto";
import { join, resolve } from "node:path";

import type { PermissionMode } from "@joko/core";
import { PersonalDevelopmentError, type DevelopmentChannel, type DevelopmentOperationResult, type DevelopmentState, type PersonalDevelopmentOwner } from "@joko/personal-development";
import { operationBodyHash, type OperationalStore, type SessionLifecycleCleanupRecord } from "@joko/store";

import type { BridgeToolCallContext } from "./mcp-router.js";
import type { DevelopmentDoctorEnvironment, DevelopmentDoctorRun } from "./personal-development-doctor-types.js";
import type { DevelopmentOperation } from "@joko/personal-development";
import { PersonalDevelopmentMergeCoordinator, type PersonalMergeOperation, type PersonalMergeSession } from "./personal-development-merge.js";
import { PERSONAL_DEVELOPMENT_PURPOSE_KEY, PERSONAL_DEVELOPMENT_SCOPE, readPersonalDevelopmentPurpose,
  savePersonalDevelopmentPurpose, samePersonalWorktree, type PersonalDevelopmentPurpose } from "./personal-development-purpose.js";
import type { CreateServiceSessionInput, SessionHost } from "./session-host.js";
import type { SessionWorktreeCoordinator } from "./session-worktree-coordinator.js";

type PersonalHost = Pick<SessionHost, "registerTarget" | "createServiceSession" | "enqueueServiceInput" | "getSessionRuntimeControl"
  | "isSessionActive" | "preparePersonalDevelopmentClose" | "preparePersonalDevelopmentCompletion" | "preparePersonalDevelopmentMergeCompletion"
  | "isPrivateSessionCreationClosed" | "releasePrivateSessionCreationReceipt">;

export interface PersonalDevelopmentAvailability { readonly available: boolean; readonly reason: string }
export interface PersonalDevelopmentStartInput {
  readonly operationId: string; readonly request: string; readonly title: string; readonly targetId: string;
  readonly originSessionId?: string; readonly providerId?: string; readonly modelId?: string; readonly effort?: string;
  readonly fastMode: boolean | "ultrafast"; readonly permissionMode: PermissionMode; readonly planMode: boolean;
}
export interface PersonalTaskIntent {
  readonly format: 1; readonly ownerId: string; readonly taskId: string; readonly operationId: string;
  readonly requestHash: string; readonly input: PersonalDevelopmentStartInput;
  readonly sourceTargetId: string; readonly creationOperationId: string;
  readonly originGeneration?: number; readonly sessionId?: string;
  readonly preparationOperationId?: string; readonly cancelRequested?: boolean;
  readonly status: "running" | "succeeded" | "failed" | "unknown" | "ended" | "cancelled";
  readonly stage: string; readonly startedAt: number; readonly error?: string;
}
export interface PersonalDevelopmentView {
  readonly generation: number; readonly state: DevelopmentState; readonly preparations: readonly PersonalTaskIntent[];
  readonly taskStates: Readonly<Record<string, { readonly editing: PersonalDevelopmentPurpose["editing"]; readonly completion?: string }>>;
  readonly mergeSessions?: readonly PersonalMergeSession[];
  readonly mergeOperations?: readonly PersonalMergeOperation[];
  readonly doctorRuns?: readonly DevelopmentDoctorRun[];
  readonly environment?: DevelopmentDoctorEnvironment;
  readonly environmentOperations?: readonly DevelopmentOperation[];
}

const taskKey = (id: string) => `task:${id}`;
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const operationKey = (kind: string, id: string) => `${kind}-${digest(id).slice(0, 40)}`;
const invalid = () => new PersonalDevelopmentError("INVALID_ARGUMENT");
export function personalDevelopmentIdentity(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/u.test(value)) throw invalid(); return value;
}
export function personalDevelopmentOwnerIdentity(rootDirectory: string): string { return digest(resolve(rootDirectory)); }

/** Composes visible Sessions and the existing package owner. Native versions,
 * process supervision and downloads remain with their established owners. */
export class PersonalDevelopmentCoordinator {
  readonly ownerId: string;
  readonly sourceRoot: string;
  readonly #store: OperationalStore;
  readonly #owner: PersonalDevelopmentOwner;
  readonly #host: PersonalHost;
  readonly #worktrees: SessionWorktreeCoordinator;
  readonly #available: () => PersonalDevelopmentAvailability;
  readonly #closeTerminals: (sessionId: string) => Promise<void>;
  readonly #sourceTarget: () => Promise<{ readonly channel: DevelopmentChannel; readonly version: string }>;
  readonly #listeners = new Set<(view: PersonalDevelopmentView) => void>();
  readonly #flights = new Map<string, Promise<unknown>>();
  readonly #merges: PersonalDevelopmentMergeCoordinator;
  #unsubscribe: (() => void) | undefined;
  #doctorReports: { snapshot(): readonly DevelopmentDoctorRun[]; subscribe(listener: () => void): () => void;
    settingsEnvironment?(): DevelopmentDoctorEnvironment | undefined; settingsEnvironmentOperations?(): readonly DevelopmentOperation[];
    cancelSettingsEnvironment?(operationId: string): boolean } | undefined;
  #unsubscribeDoctor: (() => void) | undefined;
  #generation = 0;
  #closed = false;

  constructor(options: { readonly store: OperationalStore; readonly owner: PersonalDevelopmentOwner;
    readonly host: PersonalHost; readonly worktrees: SessionWorktreeCoordinator;
    readonly availability: () => PersonalDevelopmentAvailability; readonly closeTerminals: (sessionId: string) => Promise<void>;
    readonly sourceTarget: () => Promise<{ readonly channel: DevelopmentChannel; readonly version: string }> }) {
    this.#store = options.store; this.#owner = options.owner; this.#host = options.host; this.#worktrees = options.worktrees;
    this.#available = options.availability; this.#closeTerminals = options.closeTerminals;
    this.#sourceTarget = options.sourceTarget;
    this.ownerId = personalDevelopmentOwnerIdentity(options.owner.rootDirectory); this.sourceRoot = join(options.owner.rootDirectory, "source");
    this.#merges = new PersonalDevelopmentMergeCoordinator({ store: options.store, owner: options.owner, host: options.host, ownerId: this.ownerId,
      assertAvailable: () => this.#assertAvailable(), closeTerminals: options.closeTerminals, publish: () => this.#publish() });
  }

  async initialize(): Promise<void> {
    await this.#owner.initialize();
    const sequence = this.#store.findSetting("service", PERSONAL_DEVELOPMENT_SCOPE, `sequence:${this.ownerId}`)?.value;
    if (sequence !== undefined && (!Number.isSafeInteger(sequence) || Number(sequence) < 0)) throw new PersonalDevelopmentError("STATE_INVALID");
    this.#generation = Number(sequence ?? 0);
    this.#merges.initialize();
    for (const intent of this.#intents()) if (intent.status === "running") {
      this.#saveIntent({ ...intent, status: "unknown", stage: "recovery-required", error: "PROCESS_UNKNOWN" });
    }
    this.#unsubscribe = this.#owner.subscribe(state => {
      for (const intent of this.#intents()) {
        const preparation = intent.preparationOperationId === undefined ? undefined : state.operations[intent.preparationOperationId];
        if (intent.status === "unknown" && preparation?.kind === "task-prepare" && preparation.status === "failed"
          && preparation.stage === "writer-retirement-verified" && preparation.error === "COMMAND_FAILED") {
          this.#saveIntent({ ...intent, status: "failed", stage: "preparation-failed", error: "COMMAND_FAILED" });
        }
      }
      this.#publish();
    });
  }
  availability(): PersonalDevelopmentAvailability { return this.#available(); }
  busy(): boolean {
    return this.#merges.busy() || this.#intents().some(intent => intent.status === "running" || intent.status === "unknown"
      || intent.sessionId !== undefined && (intent.status === "failed" || intent.status === "cancelled"))
      || Object.values(this.#owner.snapshot().tasks).some(task => ["preparing", "editing", "cleanup"].includes(task.status))
      || Object.values(this.#owner.snapshot().tests ?? {}).some(test => test.status !== "stopped");
  }
  async sourceTarget(): Promise<{ readonly channel: DevelopmentChannel; readonly version: string }> {
    this.#assertAvailable(); return this.#sourceTarget();
  }
  #assertAvailable(): void {
    if (this.#closed) throw new PersonalDevelopmentError("OWNER_CHANGED");
    if (!this.#available().available) throw new PersonalDevelopmentError("ENVIRONMENT_NOT_READY");
  }
  snapshot(): PersonalDevelopmentView {
    const preparations = this.#intents();
    const taskStates: Record<string, { readonly editing: PersonalDevelopmentPurpose["editing"]; readonly completion?: string }> = {};
    for (const intent of preparations) if (intent.sessionId !== undefined) {
      const purpose = readPersonalDevelopmentPurpose(this.#store, intent.sessionId);
      if (purpose?.ownerId === this.ownerId) taskStates[intent.taskId] = { editing: purpose.editing,
        ...(purpose.completion === undefined ? {} : { completion: purpose.completion.state }) };
    }
    return { generation: this.#generation, state: this.#owner.snapshot(), preparations, taskStates,
      mergeSessions: this.#merges.sessions(), mergeOperations: this.#merges.operations(), doctorRuns: this.#doctorReports?.snapshot() ?? [],
      environment: this.#doctorReports?.settingsEnvironment?.(), environmentOperations: this.#doctorReports?.settingsEnvironmentOperations?.() ?? [] };
  }
  subscribe(listener: (view: PersonalDevelopmentView) => void): () => void {
    this.#listeners.add(listener); listener(this.snapshot()); return () => { this.#listeners.delete(listener); };
  }
  notifyAvailability(): void { if (!this.#closed) this.#publish(); }
  setDoctorReports(reports: { snapshot(): readonly DevelopmentDoctorRun[]; subscribe(listener: () => void): () => void;
    settingsEnvironment?(): DevelopmentDoctorEnvironment | undefined; settingsEnvironmentOperations?(): readonly DevelopmentOperation[];
    cancelSettingsEnvironment?(operationId: string): boolean }): void {
    this.#unsubscribeDoctor?.(); this.#doctorReports = reports; this.#unsubscribeDoctor = reports.subscribe(() => this.#publish());
  }
  mergeSource(input: { readonly action: "start" | "resolve" | "adopt" | "cancel"; readonly targetId?: string; readonly operationId: string }): string {
    personalDevelopmentIdentity(input.operationId); return this.#merges.run(input);
  }
  #publish(): void {
    if (this.#closed) return;
    this.#generation += 1;
    this.#store.setSetting("service", PERSONAL_DEVELOPMENT_SCOPE, `sequence:${this.ownerId}`, this.#generation);
    const view = this.snapshot(); for (const listener of this.#listeners) listener(view);
  }
  #intents(): readonly PersonalTaskIntent[] {
    return this.#store.listSettings("service", PERSONAL_DEVELOPMENT_SCOPE)
      .filter(setting => setting.key.startsWith("task:"))
      .map(setting => {
        const value = setting.value as PersonalTaskIntent;
        if (value?.format !== 1 || value.ownerId !== this.ownerId || taskKey(value.taskId) !== setting.key
          || !value.input || !["running", "succeeded", "failed", "unknown", "ended", "cancelled"].includes(value.status)) throw new PersonalDevelopmentError("STATE_INVALID");
        return value;
      });
  }
  #intent(taskId: string): PersonalTaskIntent {
    const value = this.#intents().find(intent => intent.taskId === personalDevelopmentIdentity(taskId));
    if (!value) throw invalid(); return value;
  }
  #saveIntent(intent: PersonalTaskIntent): void {
    this.#store.setSetting("service", PERSONAL_DEVELOPMENT_SCOPE, taskKey(intent.taskId), JSON.parse(JSON.stringify(intent)) as PersonalTaskIntent); this.#publish();
  }

  /** Resolves once the Owner has published durable admission, never after the
   * entire download/build. Disconnect cancellation belongs only to the view. */
  async admit(operationId: string, action: () => Promise<DevelopmentOperationResult<unknown>>): Promise<string> {
    this.#assertAvailable(); personalDevelopmentIdentity(operationId);
    let unsubscribe: () => void = () => undefined;
    const admitted = new Promise<string>(resolveAdmission => {
      unsubscribe = this.#owner.subscribe(state => { if (state.operations[operationId] !== undefined) resolveAdmission(operationId); });
    });
    let promise: Promise<DevelopmentOperationResult<unknown>>;
    try { promise = action(); } catch (error) { unsubscribe(); throw error; }
    this.#flights.set(operationId, promise);
    void promise.finally(() => { this.#flights.delete(operationId); }).catch(() => undefined);
    try { return await Promise.race([admitted, promise.then(result => result.operationId)]); }
    finally { unsubscribe(); }
  }
  cancel(operationId: string): boolean {
    if (this.#closed) throw new PersonalDevelopmentError("OWNER_CHANGED"); personalDevelopmentIdentity(operationId);
    if (this.#doctorReports?.cancelSettingsEnvironment?.(operationId)) return true;
    const intent = this.#intents().find(task => task.operationId === operationId && task.status === "running");
    if (intent !== undefined) {
      this.#saveIntent({ ...intent, cancelRequested: true });
      if (intent.preparationOperationId !== undefined) this.#owner.cancel(intent.preparationOperationId);
      return true;
    }
    return this.#owner.cancel(operationId);
  }

  async startTask(input: PersonalDevelopmentStartInput): Promise<PersonalTaskIntent> {
    this.#assertAvailable(); personalDevelopmentIdentity(input.operationId);
    if (!input.request.trim() || input.request.length > 4_000 || !input.title.trim() || input.title.length > 200) throw invalid();
    const selected = this.#store.getTarget(input.targetId);
    if (!selected.descriptor.trusted || selected.descriptor.remoteWorkspace !== undefined) throw new PersonalDevelopmentError("OWNER_CHANGED");
    const origin = input.originSessionId ? this.#store.getSession(input.originSessionId) : undefined;
    if (origin !== undefined && (origin.descriptor.archived || origin.descriptor.deletedAt !== undefined || origin.descriptor.remoteWorkspace !== undefined)) throw new PersonalDevelopmentError("OWNER_CHANGED");
    const route = origin === undefined ? undefined : this.#host.getSessionRuntimeControl(origin.descriptor.id).effective;
    const normalized: PersonalDevelopmentStartInput = { ...input, title: input.title.trim(),
      ...(route === undefined ? {} : { providerId: route.providerId, modelId: route.modelId, effort: route.effort,
        fastMode: route.fastMode, permissionMode: origin!.descriptor.permissionMode, planMode: origin!.descriptor.planMode }) };
    if (route !== undefined && route.backendId !== selected.descriptor.backendId) throw new PersonalDevelopmentError("OWNER_CHANGED");
    const taskId = operationKey("personal", input.operationId), requestHash = operationBodyHash(normalized);
    const existing = this.#intents().find(intent => intent.taskId === taskId);
    if (existing !== undefined) {
      if (existing.requestHash !== requestHash) throw invalid(); return existing;
    }
    if (this.#owner.snapshot().source.status !== "ready") throw new PersonalDevelopmentError("SOURCE_MISSING");
    const intent: PersonalTaskIntent = { format: 1, ownerId: this.ownerId, taskId, operationId: input.operationId,
      requestHash, input: normalized, sourceTargetId: `personal-target-${digest(`${this.ownerId}:${selected.descriptor.backendId}`).slice(0, 32)}`,
      creationOperationId: operationKey("personal-create", input.operationId), status: "running", stage: "creating-task", startedAt: Date.now(),
      ...(origin === undefined ? {} : { originGeneration: origin.descriptor.binding.generation }) };
    this.#saveIntent(intent);
    const flight = this.#prepareTask(intent, selected.descriptor.backendId).catch(error => {
      const latest = this.#intent(taskId);
      this.#saveIntent({ ...latest, status: error instanceof PersonalDevelopmentError && error.code === "CANCELLED" ? "cancelled"
        : error instanceof PersonalDevelopmentError && error.code !== "PROCESS_UNKNOWN" ? "failed" : "unknown",
        stage: "preparation-failed", error: error instanceof PersonalDevelopmentError ? error.code : "PROCESS_UNKNOWN" });
    }).finally(() => { this.#flights.delete(input.operationId); });
    this.#flights.set(input.operationId, flight); return intent;
  }

  async #prepareTask(initial: PersonalTaskIntent, backendId: string, preparationOperationId = operationKey("personal-prepare", initial.operationId)): Promise<void> {
    const assertScope = () => {
      this.#assertAvailable(); const live = this.#intent(initial.taskId);
      if (live.requestHash !== initial.requestHash || live.ownerId !== this.ownerId || live.status !== "running") throw new PersonalDevelopmentError("OWNER_CHANGED");
      if (live.cancelRequested === true) throw new PersonalDevelopmentError("CANCELLED");
      if (initial.input.originSessionId !== undefined) {
        const origin = this.#store.getSession(initial.input.originSessionId).descriptor;
        if (origin.deletedAt !== undefined || origin.archived || origin.remoteWorkspace !== undefined || origin.binding.generation !== initial.originGeneration) throw new PersonalDevelopmentError("OWNER_CHANGED");
      }
    };
    const existing = this.#store.listTargets(backendId).find(target => target.descriptor.id === initial.sourceTargetId);
    if (existing === undefined) await this.#host.registerTarget({ id: initial.sourceTargetId, backendId, displayName: "Personal source", workspaceRoot: this.sourceRoot, managed: true, trusted: true },
      { kind: "personal_development", ownerId: this.ownerId });
    else if (!existing.descriptor.trusted || !existing.descriptor.managed || existing.descriptor.remoteWorkspace !== undefined
      || resolve(existing.descriptor.workspaceRoot) !== resolve(this.sourceRoot)) throw new PersonalDevelopmentError("OWNER_CHANGED");
    assertScope(); const target = this.#store.getTarget(initial.sourceTargetId);
    const input = initial.input;
    const hooks: Pick<CreateServiceSessionInput, "onPreparing" | "onAdmitted"> = {
      onPreparing: (store, preparing) => {
        assertScope(); if (preparing.target.revision !== target.revision) throw new PersonalDevelopmentError("OWNER_CHANGED");
        savePersonalDevelopmentPurpose(store, { format: 1, taskId: initial.taskId, ownerId: this.ownerId,
          creationOperationId: initial.creationOperationId, sessionId: preparing.sessionId, targetId: target.descriptor.id,
          targetRevision: target.revision.toString(), backendId, backendGeneration: preparing.backendGeneration,
          phase: "creating", editing: "preparing" });
      },
      onAdmitted: (store, session) => {
        assertScope(); const purpose = readPersonalDevelopmentPurpose(store, session.descriptor.id);
        const binding = session.descriptor.worktree;
        if (purpose?.taskId !== initial.taskId || purpose.phase !== "creating" || binding === undefined || binding.remote !== undefined
          || resolve(binding.repositoryRoot) !== resolve(this.sourceRoot) || binding.sourceRef !== "joko-personal"
          || store.getTarget(target.descriptor.id).revision !== target.revision) throw new PersonalDevelopmentError("OWNER_CHANGED");
        savePersonalDevelopmentPurpose(store, { ...purpose, phase: "adopted", binding: session.descriptor.binding, worktree: binding });
      }
    };
    const created = await this.#host.createServiceSession({ operationId: initial.creationOperationId, serviceKind: "personal_development",
      targetId: target.descriptor.id, title: input.title, fastMode: input.fastMode, permissionMode: input.permissionMode, planMode: input.planMode,
      ...(input.providerId === undefined ? {} : { providerId: input.providerId }), ...(input.modelId === undefined ? {} : { modelId: input.modelId }),
      ...(input.effort === undefined ? {} : { effort: input.effort }), worktree: { sourceRef: "joko-personal", refreshRemote: false },
      appendSystemPrompt: "You are implementing the user's requested personal Joko changes in this task's isolated checkout. Preserve unrelated work. After implementation and the necessary checks, call report_complete to request completion, then finish the turn. Completion is recorded only after this task's writers stop. Do not launch a personal build or switch the running application yourself.",
      assertServiceScope: assertScope, ...hooks });
    const intent = { ...this.#intent(initial.taskId), sessionId: created.value.sessionId, stage: "preparing-dependencies", preparationOperationId };
    this.#saveIntent(intent);
    await this.#owner.prepareTask({ taskId: intent.taskId, sessionId: created.value.sessionId, request: input.request,
      title: input.title, operationId: preparationOperationId });
    assertScope(); const purpose = this.#purpose(intent.taskId);
    savePersonalDevelopmentPurpose(this.#store, { ...purpose, editing: "editing" });
    this.#host.enqueueServiceInput({ operationId: operationKey("personal-input", initial.operationId), sessionId: purpose.sessionId,
      source: "system", prompt: { text: input.request, images: [], files: [], mentions: [], disposition: "prompt" },
      onAdmitted: (store, queued) => savePersonalDevelopmentPurpose(store, { ...this.#purpose(intent.taskId), editing: "editing",
        queueItemId: queued.queueItemId, runId: queued.runId }) });
    this.#saveIntent({ ...this.#intent(intent.taskId), status: "succeeded", stage: "editing" });
  }

  #purpose(taskId: string): PersonalDevelopmentPurpose {
    const intent = this.#intent(taskId);
    if (intent.sessionId === undefined) throw new PersonalDevelopmentError("OWNER_CHANGED");
    const purpose = readPersonalDevelopmentPurpose(this.#store, intent.sessionId);
    const session = this.#store.getSession(intent.sessionId).descriptor;
    const target = this.#store.getTarget(session.targetId);
    if (purpose?.taskId !== taskId || purpose.ownerId !== this.ownerId || purpose.phase !== "adopted"
      || purpose.binding === undefined || purpose.worktree === undefined || session.worktree === undefined
      || !samePersonalWorktree(purpose.worktree, session.worktree) || session.binding.opaqueRef !== purpose.binding.opaqueRef
      || session.binding.nativeSessionId !== purpose.binding.nativeSessionId || session.deletedAt !== undefined || session.archived
      || target.revision.toString() !== purpose.targetRevision || target.descriptor.remoteWorkspace !== undefined
      || this.#store.getBackend(purpose.backendId).descriptor.instanceGeneration !== purpose.backendGeneration) throw new PersonalDevelopmentError("OWNER_CHANGED");
    return purpose;
  }
  includeForSession(sessionId: string, targetId: string): boolean {
    try { const purpose = readPersonalDevelopmentPurpose(this.#store, sessionId);
      return purpose?.ownerId === this.ownerId && purpose.merge === undefined && purpose.targetId === targetId && purpose.editing !== "ended"; }
    catch { return false; }
  }
  reportComplete(context: BridgeToolCallContext): { readonly completionId: string; readonly state: "requested" } {
    this.#assertAvailable();
    const purpose = readPersonalDevelopmentPurpose(this.#store, context.sessionId);
    if (purpose?.taskId === undefined) throw new PersonalDevelopmentError("OWNER_CHANGED");
    const current = this.#purpose(purpose.taskId), session = this.#store.getSession(context.sessionId).descriptor;
    if (context.targetId !== current.targetId || context.generation !== session.binding.generation
      || context.providerGeneration !== 1 || current.editing !== "editing" && current.editing !== "completing") throw new PersonalDevelopmentError("OWNER_CHANGED");
    const runs = this.#store.listRuns({ sessionId: context.sessionId, activeOnly: true, limit: 2 });
    if (runs.length !== 1 || context.requestIdentity === undefined) throw new PersonalDevelopmentError("BUSY");
    const runId = runs[0]!.descriptor.id;
    if (this.#store.listQueueItems({ sessionId: context.sessionId, states: ["accepted", "dispatching", "backend_accepted", "dispatch_unknown"], limit: 500 })
      .some(item => item.runId !== runId)) throw new PersonalDevelopmentError("BUSY");
    const completionId = operationKey("completion", `${current.taskId}:${runId}:${context.requestIdentity}`);
    if (current.completion !== undefined && (current.completion.id !== completionId || current.completion.runId !== runId)) throw new PersonalDevelopmentError("CONFLICT");
    savePersonalDevelopmentPurpose(this.#store, { ...current, editing: "completing",
      completion: { id: completionId, runId, generation: context.generation, state: "requested" } });
    this.#publish(); return { completionId, state: "requested" };
  }
  onRunSettled(input: { readonly sessionId: string; readonly runId: string; readonly outcome: "completed" | "aborted" | "failed" }): void {
    this.#merges.onRunSettled(input);
    const purpose = readPersonalDevelopmentPurpose(this.#store, input.sessionId);
    if (purpose?.ownerId !== this.ownerId || purpose.completion?.runId !== input.runId || purpose.completion.state !== "requested") return;
    const job = this.#completeSettled(purpose, input.outcome).catch(() => {
      const latest = readPersonalDevelopmentPurpose(this.#store, input.sessionId);
      if (latest !== undefined && latest.completion !== undefined && latest.completion.id === purpose.completion?.id) savePersonalDevelopmentPurpose(this.#store,
        { ...latest, editing: "unknown", completion: { ...latest.completion, state: "unknown" } });
      this.#publish();
    });
    this.#flights.set(purpose.completion.id, job);
    void job.finally(() => this.#flights.delete(purpose.completion!.id)).catch(() => undefined);
  }
  async #completeSettled(purpose: PersonalDevelopmentPurpose, outcome: "completed" | "aborted" | "failed"): Promise<void> {
    if (outcome !== "completed" || purpose.completion === undefined) throw new PersonalDevelopmentError("PROCESS_UNKNOWN");
    if (this.#store.getSession(purpose.sessionId).descriptor.binding.generation !== purpose.completion.generation
      || this.#purpose(purpose.taskId).editing !== "completing") throw new PersonalDevelopmentError("OWNER_CHANGED");
    await this.#host.preparePersonalDevelopmentCompletion(purpose.sessionId, purpose.completion.id); await this.#closeTerminals(purpose.sessionId);
    const current = this.#purpose(purpose.taskId);
    if (current.completion?.id !== purpose.completion.id || this.#host.isSessionActive(purpose.sessionId)
      || this.#store.getSession(purpose.sessionId).descriptor.binding.generation !== purpose.completion.generation
      || this.#store.getRun(purpose.completion.runId).descriptor.state !== "completed") throw new PersonalDevelopmentError("PROCESS_UNKNOWN");
    savePersonalDevelopmentPurpose(this.#store, { ...current, completion: { ...current.completion, state: "retired" } });
    await this.#owner.completeTask({ taskId: purpose.taskId, completionId: purpose.completion.id,
      operationId: operationKey("personal-complete", purpose.completion.id) });
    const completed = this.#purpose(purpose.taskId);
    savePersonalDevelopmentPurpose(this.#store, { ...completed, editing: "completed", completion: { ...current.completion, state: "completed" } });
    this.#publish();
  }
  async controlTask(input: { readonly operationId: string; readonly taskId: string; readonly action: "continue" | "end" | "start_test" | "stop_test" | "retry_preparation"; readonly message?: string }): Promise<string> {
    this.#assertAvailable(); personalDevelopmentIdentity(input.operationId); const purpose = this.#purpose(input.taskId);
    if (input.action === "retry_preparation") {
      const intent = this.#intent(input.taskId);
      const previous = intent.preparationOperationId === undefined ? undefined : this.#owner.snapshot().operations[intent.preparationOperationId];
      if (intent.status !== "failed" && intent.status !== "cancelled" || previous?.status === "unknown" || this.#store.findOperation(intent.creationOperationId)?.status !== "completed") throw new PersonalDevelopmentError("PROCESS_UNKNOWN");
      this.#saveIntent({ ...intent, status: "running", stage: "preparing-dependencies", preparationOperationId: input.operationId, error: undefined, cancelRequested: false });
      savePersonalDevelopmentPurpose(this.#store, { ...purpose, editing: "preparing" });
      return this.admit(input.operationId, async () => {
        try {
          await this.#prepareTask(this.#intent(input.taskId), purpose.backendId, input.operationId);
          return { operationId: input.operationId, value: input.taskId, replayed: false };
        } catch (error) {
          this.#saveIntent({ ...this.#intent(input.taskId), status: error instanceof PersonalDevelopmentError && error.code !== "PROCESS_UNKNOWN" ? "failed" : "unknown",
            stage: "preparation-failed", error: error instanceof PersonalDevelopmentError ? error.code : "PROCESS_UNKNOWN" });
          throw error;
        }
      });
    }
    if (input.action === "continue") {
      if (purpose.editing !== "completed") throw new PersonalDevelopmentError("BUSY");
      return this.admit(input.operationId, async () => {
        const result = await this.#owner.continueTask({ taskId: input.taskId, operationId: input.operationId });
        savePersonalDevelopmentPurpose(this.#store, { ...this.#purpose(input.taskId), editing: "editing", completion: undefined });
        if (input.message?.trim()) this.#host.enqueueServiceInput({ operationId: operationKey("personal-continue-input", input.operationId),
          sessionId: purpose.sessionId, source: "system", prompt: { text: input.message, images: [], files: [], mentions: [], disposition: "prompt" } });
        this.#publish(); return result;
      });
    }
    if (input.action === "start_test" || input.action === "stop_test") {
      if (purpose.editing !== "completed" && purpose.editing !== "busy") throw new PersonalDevelopmentError("BUSY");
      return this.admit(input.operationId, async () => {
        savePersonalDevelopmentPurpose(this.#store, { ...this.#purpose(input.taskId), editing: "busy" });
        const result = await this.#owner.testTask({ taskId: input.taskId, action: input.action === "start_test" ? "start" : "stop", operationId: input.operationId });
        savePersonalDevelopmentPurpose(this.#store, { ...this.#purpose(input.taskId), editing: input.action === "start_test" ? "busy" : "completed" });
        this.#publish(); return result;
      });
    }
    const endingOperationId = operationKey("personal-end", input.taskId);
    savePersonalDevelopmentPurpose(this.#store, { ...purpose, editing: "ending", completion: undefined, endingOperationId });
    const cleanup = this.#store.findSessionLifecycleCleanup(endingOperationId)
      ?? this.#store.prepareSessionLifecycleCleanup({ operationId: endingOperationId, sessionId: purpose.sessionId,
        disposition: "archive", releaseWorktree: true });
    if (cleanup.state === "completed") return input.operationId;
    return this.admit(input.operationId, async () => {
      try {
        if (!this.#store.getSessionLifecycleCleanup(endingOperationId).closeCompleted) {
          await this.#host.preparePersonalDevelopmentClose(purpose.sessionId);
          await this.#closeTerminals(purpose.sessionId);
          this.#store.advanceSessionLifecycleCleanup({ operationId: endingOperationId, phase: "close" });
        }
        const intent = this.#intent(input.taskId);
        const result = this.#owner.snapshot().tasks[input.taskId] === undefined
          ? await this.#owner.retireUnpreparedTask({ taskId: input.taskId, sessionId: purpose.sessionId,
            title: intent.input.title, request: intent.input.request, operationId: input.operationId })
          : await this.#owner.endTask({ taskId: input.taskId, operationId: input.operationId });
        this.#store.advanceSessionLifecycleCleanup({ operationId: endingOperationId, phase: "worktree" });
        this.#store.transaction(store => {
          const current = readPersonalDevelopmentPurpose(store, purpose.sessionId);
          if (current?.endingOperationId !== endingOperationId) throw new PersonalDevelopmentError("OWNER_CHANGED");
          savePersonalDevelopmentPurpose(store, { ...current, editing: "ended" });
          store.finalizeSessionLifecycleCleanup({ operationId: endingOperationId });
        });
        this.#saveIntent({ ...this.#intent(input.taskId), status: "ended", stage: "ended" });
        return result;
      } catch (error) {
        this.#store.recordSessionLifecycleCleanupFailure({ operationId: endingOperationId, message: "Personal task cleanup is pending." });
        throw error;
      }
    });
  }
  /** Generic archive/delete keeps its own disposition and operation manifest.
   * Its close/native receipts precede package history and checkout retirement. */
  async settleSessionLifecycle(input: SessionLifecycleCleanupRecord): Promise<SessionLifecycleCleanupRecord> {
    if (this.#closed) throw new PersonalDevelopmentError("OWNER_CHANGED");
    const cleanup = this.#store.getSessionLifecycleCleanup(input.operationId);
    if (cleanup.sessionId !== input.sessionId || !cleanup.closeCompleted || !cleanup.nativeCompleted
      || this.#host.isSessionActive(cleanup.sessionId)) throw new PersonalDevelopmentError("PROCESS_UNKNOWN");
    const purpose = readPersonalDevelopmentPurpose(this.#store, cleanup.sessionId);
    if (purpose?.ownerId !== this.ownerId || purpose.phase !== "adopted") throw new PersonalDevelopmentError("OWNER_CHANGED");
    if (purpose.merge !== undefined) { await this.#merges.settleSessionLifecycle(cleanup); return this.#store.getSessionLifecycleCleanup(cleanup.operationId); }
    if (purpose.editing === "ended") return cleanup.worktreeCompleted ? cleanup : this.#store.advanceSessionLifecycleCleanup({ operationId: cleanup.operationId, phase: "worktree" });
    const current = this.#purpose(purpose.taskId), intent = this.#intent(purpose.taskId);
    savePersonalDevelopmentPurpose(this.#store, { ...current, editing: "ending", completion: undefined, endingOperationId: cleanup.operationId });
    const operationId = operationKey("personal-lifecycle-end", `${cleanup.operationId}:${cleanup.revision}`);
    if (this.#owner.snapshot().tasks[purpose.taskId] === undefined) await this.#owner.retireUnpreparedTask({ taskId: purpose.taskId,
      sessionId: purpose.sessionId, title: intent.input.title, request: intent.input.request, operationId });
    else await this.#owner.endTask({ taskId: purpose.taskId, operationId });
    this.#store.transaction(store => {
      const latest = readPersonalDevelopmentPurpose(store, purpose.sessionId);
      if (latest?.endingOperationId !== cleanup.operationId) throw new PersonalDevelopmentError("OWNER_CHANGED");
      store.advanceSessionLifecycleCleanup({ operationId: cleanup.operationId, phase: "worktree" });
      savePersonalDevelopmentPurpose(store, { ...latest, editing: "ended" });
    });
    this.#saveIntent({ ...this.#intent(purpose.taskId), status: "ended", stage: "ended" });
    return this.#store.getSessionLifecycleCleanup(cleanup.operationId);
  }
  async dispose(): Promise<void> {
    this.#closed = true; this.#unsubscribe?.(); this.#unsubscribeDoctor?.(); this.#listeners.clear();
    for (const operation of Object.values(this.#owner.snapshot().operations)) if (operation.status === "running") this.#owner.cancel(operation.id);
    await this.#merges.dispose();
    await Promise.allSettled([...this.#flights.values()]);
  }
}
