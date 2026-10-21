import { createHash, randomUUID } from "node:crypto";
import { mkdir, realpath } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import type { OperationalStore, QueueItemRecord, StoredSession, StoredRun } from "@joko/store";
import type { ExtensionCatalogManager } from "./extension-catalog.js";
import type { SessionHost } from "./session-host.js";
import type { AppDefaultModelCoordinator } from "./app-default-model.js";
import type { CollaborationGoalManager } from "./collaboration-goal-manager.js";
import type { NativeToolAuthorization, NativeToolAuthorizationDecision, NativeToolAuthorizationRequest } from "@joko/core";
import { classifyToolCall, evaluateOrderedPolicyRules, policyObservationForToolCall, type PolicyContext, type PolicySnapshot } from "@joko/core";
import { modelRoutingEnabled } from "./backend-model-access.js";
import { policySnapshotFor } from "./policy-settings.js";

export interface ExtensionTaskRoute {
  readonly backendId: string; readonly providerId: string; readonly modelId: string;
  readonly effort?: string; readonly fastMode: boolean;
}
export interface ExtensionTaskPreferences {
  readonly model?: ExtensionTaskRoute; readonly targetId?: string; readonly permissionMode: "ask" | "acceptEdits" | "auto";
}
export interface ExtensionTaskOwner {
  readonly extensionId: string; readonly resourceId: string; readonly installation: string;
  readonly assertCurrent: () => void; readonly signal: AbortSignal;
  readonly sourceSessionId?: string;
}
interface TaskReceipt {
  readonly version: 1; readonly extensionId: string; readonly resourceId: string; readonly installation: string;
  readonly operationId: string; readonly fingerprint: string; readonly sessionId?: string; readonly revoked?: boolean;
}
interface InputReceipt extends TaskReceipt {
  readonly sessionId: string; readonly runId: string; readonly queueItemId: string;
}
const TASKS = "extension-task-owners", INPUTS = "extension-task-inputs", PREFS = "extension-task-preferences", INSTALLATIONS = "extension-task-installations";
const PLANS = "extension-task-plans";
interface DirectoryApproval { readonly targetId: string; readonly revision: string; readonly root: string }
interface TeamPlan { readonly concurrency: number; readonly task: string; readonly scope: string; readonly preferences: string;
  readonly coordinatorRoute: ExtensionTaskRoute;
  readonly directories: readonly DirectoryApproval[];
  readonly items: readonly { readonly label: string; readonly targetId: string; readonly targetRevision: string; readonly route: ExtensionTaskRoute; readonly task: string }[] }
const OPERATIONS = ["capabilities", "models", "create", "get", "list", "setModel", "send", "getRun", "listRuns", "readMessages", "cancel", "setHidden", "requestWriteAccess", "startTeam", "getTeam", "setTeamPlan", "releaseWorker"] as const;
const hash = (value: unknown): string => createHash("sha256").update(JSON.stringify(value, (_key, item: unknown) => typeof item === "bigint" ? item.toString() : item && typeof item === "object" && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item)).digest("hex");
const failure = (code: string, message: string): never => { throw Object.assign(new Error(message), { code }); };
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return failure("INVALID_REQUEST", "An object is required.");
  return value as Record<string, unknown>;
}
export interface ExtensionTaskReviewScope {
  readonly extensionId: string; readonly role: "coordinator" | "worker"; readonly task: string; readonly workingDirectory: string;
  readonly route: ExtensionTaskRoute; readonly userInstructions: readonly string[]; readonly authorizationRevision: string;
  readonly approvedRoots: readonly { readonly path: string; readonly access: "read_only" | "read_write" }[];
}
function text(value: unknown, maximum = 256): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum || value.includes("\0")) return failure("INVALID_REQUEST", "A bounded non-empty string is required.");
  return value;
}
function exact(value: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(value).some(key => !keys.includes(key))) failure("INVALID_REQUEST", "Unexpected request fields.");
}
function limit(value: unknown): number {
  if (value === undefined) return 50;
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > 100) return failure("INVALID_REQUEST", "Limit must be between 1 and 100.");
  return Number(value);
}
function taskScope(session: StoredSession): string {
  const task = session.descriptor;
  return hash([task.targetId, task.worktree, task.binding, task.backendId, task.providerId, task.modelId, task.effort, task.fastMode, task.permissionMode, task.planMode, task.archived, task.deletedAt]);
}
const teamScope = (session: StoredSession): string => hash([session.descriptor.targetId, session.descriptor.worktree?.path]);
const directoryPreference = (preferences: ExtensionTaskPreferences | undefined): string => hash(preferences?.targetId ?? null);
const permissionAllowed = (actual: string, configured: string): boolean => {
  const rank = (mode: string) => mode === "ask" ? 1 : mode === "acceptEdits" ? 2 : mode === "auto" ? 3 : -1;
  return rank(actual) >= 0 && rank(actual) <= rank(configured);
};
function inputReceipt(store: OperationalStore, runId: string): InputReceipt | undefined {
  const seen = new Set<string>();
  for (let current: string | undefined = runId; current && !seen.has(current);) {
    seen.add(current);
    const receipt = store.findSetting<InputReceipt>("service", INPUTS, current)?.value;
    if (receipt) return receipt;
    const run: StoredRun["descriptor"] | undefined = store.findRun(current)?.descriptor;
    current = run?.parentRunId;
  }
  return undefined;
}
function sessionRuns(store: OperationalStore, sessionId: string): StoredRun[] {
  const result: StoredRun[] = [];
  for (let offset = 0; ; offset += 500) { const page = store.listRuns({ sessionId, offset, limit: 500 }); result.push(...page); if (page.length < 500) return result; }
}
export class ExtensionTasks {
  #tail: Promise<unknown> = Promise.resolve();
  readonly #writes = new Set<Promise<unknown>>();
  readonly #writeAttempts = new Map<string, { readonly extensionId: string; readonly taskId: string; readonly installation: string; readonly mode: "acceptEdits" | "auto"; pending: boolean }>();
  constructor(readonly options: { readonly store: OperationalStore; readonly host: SessionHost;
    readonly catalog: Pick<ExtensionCatalogManager, "get">; readonly defaults: Pick<AppDefaultModelCoordinator, "current">;
    readonly rootDirectory: string; readonly redact: (text: string) => string; readonly teams?: CollaborationGoalManager;
    readonly reviewNativeTool?: (scope: ExtensionTaskReviewScope, request: NativeToolAuthorizationRequest, assertCurrent: () => void) => Promise<NativeToolAuthorizationDecision> }) {}

  /** Private native-loop authority is resolved on every action, including reads,
   * rather than borrowing model-visible plugin text as owner authorization. */
  nativeToolAuthorization(sessionId: string): NativeToolAuthorization | undefined {
    const worker = this.options.store.findCollaborationWorkerBySession(sessionId), leadId = worker ? this.options.store.getCollaborationGoal(worker.goalId).leadSessionId : sessionId;
    if (!this.#receipt(leadId) || !isExtensionTaskControlled(this.options.store, sessionId)) return undefined;
    const capture = (): { readonly revision: string; readonly scope?: ExtensionTaskReviewScope; readonly ownerInputPending?: boolean; readonly policy: PolicySnapshot } => {
      const receipt = this.#receipt(leadId)!;
      this.#assert({ extensionId: receipt.extensionId, resourceId: receipt.resourceId, installation: receipt.installation, assertCurrent: () => {}, signal: new AbortController().signal });
      if (receipt.revoked) failure("PERMISSION_DENIED", "The original plugin task authorization was revoked.");
      const task = this.options.store.getSession(sessionId), lead = this.options.store.getSession(leadId), preferences = this.preferences(receipt.extensionId).config;
      if (task.descriptor.archived || task.descriptor.deletedAt || lead.descriptor.archived || lead.descriptor.deletedAt
        || !permissionAllowed(task.descriptor.permissionMode, preferences.permissionMode)) failure("PERMISSION_DENIED", "The native task exceeds its current plugin permission policy.");
      const route = this.#route({ backendId: task.descriptor.backendId, providerId: task.descriptor.providerId, modelId: task.descriptor.modelId, effort: task.descriptor.effort, fastMode: task.descriptor.fastMode });
      const planReceipt = this.options.store.findSetting<{ readonly plan: TeamPlan; readonly settledLabels?: readonly string[] }>("service", PLANS, leadId), plan = planReceipt?.value.plan;
      const item = worker ? plan?.items.find(item => item.label === worker.label) : undefined;
      const currentTarget = this.#target(task.descriptor.targetId, route.backendId);
      const workspace = this.options.host.captureToolWorkspace({ sessionId, targetId: task.descriptor.targetId, generation: task.descriptor.binding.generation });
      workspace.assertCurrent(); if (workspace.remote) failure("PERMISSION_DENIED", "Plugin task native authority requires its approved local workspace.");
      const root = realpathSync(workspace.root);
      const policy = policySnapshotFor(this.options.store, { ...currentTarget.descriptor, workspaceRoot: root });
      const approvedRoots = [{ path: root, access: "read_write" as const }, ...this.options.host.extraDirectories.listForTarget(task.descriptor.targetId)];
      const extension = this.options.catalog.get(receipt.extensionId), backend = this.options.store.getBackend(task.descriptor.backendId).descriptor;
      let ownerInputPending = false;
      const instructions = [...new Set([leadId, sessionId])].flatMap(id => {
        const values: { readonly at: number; readonly text: string }[] = [];
        for (let offset = 0; ; offset += 500) {
          const page = this.options.store.listQueueItems({ sessionId: id, includeCleared: true, offset, limit: 500 });
          for (const queue of page) if (this.options.store.getRun(queue.runId).descriptor.source === "user") {
            if (["dispatching", "dispatch_unknown"].includes(queue.state)) ownerInputPending = true;
            if (["backend_accepted", "completed"].includes(queue.state)) values.push({ at: queue.createdAt, text: queue.body.text });
          }
          if (page.length < 500) break;
        }
        for (let offset = 0; ; offset += 500) {
          const page = this.options.store.listInteractions({ sessionId: id, includeCleared: true, kinds: ["question", "plan_review"], offset, limit: 500 });
          for (const interaction of page) if (interaction.status === "resolved") {
            if (!interaction.decision || interaction.decision.kind !== "question" && interaction.decision.kind !== "plan_review") return failure("PERMISSION_DENIED", "An owner answer receipt is incomplete.");
            const decision = interaction.decision;
            values.push({ at: interaction.resolvedAt ?? interaction.createdAt, text: decision.kind === "plan_review"
              ? JSON.stringify({ interactionContext: interaction.payload, ownerPlanDecision: decision.decision, ownerFeedback: decision.feedback })
              : JSON.stringify({ interactionContext: interaction.payload, ownerAnswers: decision.answers }) });
          }
          if (page.length < 500) break;
        }
        return values;
      }).sort((a, b) => a.at - b.at).map(value => value.text);
      if (instructions.length > 64 || instructions.reduce((total, value) => total + value.length, 0) > 16_000) failure("PERMISSION_DENIED", "Complete owner instructions exceed the bounded authorization evidence budget.");
      const revision = hash([receipt, taskScope(task), taskScope(lead), currentTarget.revision, preferences, planReceipt?.revision, instructions, ownerInputPending, approvedRoots, policy.generation,
        extension.revision, extension.owner, extension.permissions, extension.setup, backend.instanceGeneration,
        this.options.store.findSetting("service", "orchestrator", `settings.model_access.${backend.id}`)?.revision,
        worker ? [worker.id, worker.label, worker.targetId, worker.providerId, worker.modelId, worker.effort, worker.fastMode, worker.permissionMode, worker.planMode, worker.runtimeReleased, worker.sessionGeneration] : null]);
      if (task.descriptor.permissionMode !== "auto") return { revision, policy };
      if (!plan) return failure("PERMISSION_DENIED", "The host-registered delegated task scope is missing.");
      if (task.descriptor.planMode || lead.descriptor.planMode || !plan.task.trim() || worker && (!item || worker.runtimeReleased || planReceipt?.value.settledLabels?.includes(worker.label)
        || this.options.store.getCollaborationGoal(worker.goalId).status !== "active") || !worker && hash(route) !== hash(plan.coordinatorRoute)) failure("PERMISSION_DENIED", "The host-registered delegated task scope is missing or changed.");
      if (worker) assertExtensionWorkerPlan(this.options.store, leadId, { ...worker, existingWorkerId: worker.id, route: task.descriptor });
      else if (teamScope(lead) !== plan.scope || directoryPreference(preferences) !== plan.preferences || plan.directories.some(directory => this.#target(directory.targetId).revision.toString() !== directory.revision)) failure("PERMISSION_DENIED", "The delegated task directory approval changed.");
      return { revision, ownerInputPending, policy, scope: { extensionId: receipt.extensionId, role: worker ? "worker" : "coordinator", task: item?.task ?? plan.task,
        route, workingDirectory: root, userInstructions: instructions, authorizationRevision: revision, approvedRoots } };
    };
    return { required: true, capture: () => capture().revision, assertCurrent: (expected?: string) => {
      if (expected !== undefined && capture().revision !== expected) failure("PERMISSION_DENIED", "The original native action authorization changed."); capture();
    }, review: async request => {
      try {
        request.signal.throwIfAborted(); const before = capture();
        const ordered = nativeTaskPolicy(before.policy, request);
        if (ordered === "deny") return { verdict: "block", reason: "Current target policy denies this native action.", authorizationRevision: before.revision };
        if (!before.scope) return { verdict: ordered === "ask" ? "ask" : "default", authorizationRevision: before.revision };
        if (before.ownerInputPending) return { verdict: "block", reason: "The latest owner input has not been confirmed in the native task." };
        const assertCurrent = () => { request.signal.throwIfAborted(); if (capture().revision !== before.revision) failure("PERMISSION_DENIED", "Native delegated authorization changed during review."); };
        const decision = this.options.reviewNativeTool ? await this.options.reviewNativeTool(before.scope, request, assertCurrent)
          : { verdict: "ask" as const, unavailable: true, reason: "The automatic reviewer is unavailable; confirm this action explicitly." };
        assertCurrent(); return { ...decision, ...(ordered === "ask" && decision.verdict === "allow" ? { verdict: "ask" as const } : {}), authorizationRevision: before.revision };
      } catch { return { verdict: "block", reason: "The current delegated task authority could not be verified. Retry from its current owner and scope." }; }
    } };
  }

  /** Durable install incarnation survives service/Backend restarts and package
   * updates. Resource removal atomically retires it before a reinstall. */
  installation(extensionId: string, resourceId: string): string {
    const extension = this.options.catalog.get(extensionId);
    if (!extension.installed || extension.owner.kind !== "resource" || extension.owner.resourceId !== resourceId) return failure("PERMISSION_DENIED", "Plugin installation unavailable.");
    const previous = this.options.store.findSetting<{ readonly version: 1; readonly id: string; readonly active: boolean }>("service", INSTALLATIONS, resourceId)?.value;
    if (previous?.version === 1 && previous.active) return previous.id;
    const id = randomUUID(); this.options.store.setSetting("service", INSTALLATIONS, resourceId, { version: 1, id, active: true }); return id;
  }

  #exclusive<T>(work: () => Promise<T>): Promise<T> {
    const next = this.#tail.catch(() => undefined).then(work); this.#tail = next; return next;
  }
  #assert(owner: ExtensionTaskOwner, hidden = false): void {
    owner.assertCurrent(); owner.signal.throwIfAborted();
    const extension = this.options.catalog.get(owner.extensionId);
    const installation = this.options.store.findSetting<{ readonly active: boolean; readonly id: string }>("service", INSTALLATIONS, owner.resourceId)?.value;
    if (!extension.installed || !extension.enabled || extension.owner.kind !== "resource" || extension.owner.resourceId !== owner.resourceId
      || !extension.runtime?.tasks || !["ready", "not_required"].includes(extension.setup.state)
      || extension.permissions.some(permission => permission.required && !permission.granted)
      || hidden && !extension.runtime.tasks.hidden || !installation?.active || installation.id !== owner.installation) failure("PERMISSION_DENIED", "Plugin task authority is unavailable.");
  }
  preferences(id: string) {
    const extension = this.options.catalog.get(id);
    if (!extension.installed || !extension.runtime || !extension.runtime.tasks && !extension.runtime.text) failure("PERMISSION_DENIED", "Plugin task preferences are unavailable.");
    const stored = this.options.store.findSetting<ExtensionTaskPreferences>("service", PREFS, id);
    const writeRequests = [...this.#writeAttempts.values()].flatMap(attempt => {
      const receipt = this.#receipt(attempt.taskId);
      if (attempt.extensionId !== id || attempt.pending || !receipt || receipt.revoked || receipt.installation !== attempt.installation) return [];
      const task = this.options.store.getSession(attempt.taskId).descriptor;
      return task.archived || task.deletedAt ? [] : [{ taskId: attempt.taskId, title: task.title, mode: attempt.mode }];
    });
    return { revision: stored?.revision ?? 0n, config: stored?.value ?? { permissionMode: "ask" as const }, writeRequests,
      show: extension.runtime!.showTaskPreferences !== false, tasks: !!extension.runtime!.tasks, models: this.models(),
      targets: this.options.store.listTargets().filter(target => target.descriptor.trusted && !target.descriptor.remoteWorkspace).map(target => target.descriptor) };
  }
  updatePreferences(id: string, expected: bigint, config: ExtensionTaskPreferences, assertCurrent: () => void): ReturnType<ExtensionTasks["preferences"]> {
    assertCurrent(); const before = this.preferences(id);
    if (before.revision !== expected) failure("STALE_REVISION", "Plugin task preferences changed.");
    const value = record(config); exact(value, ["model", "targetId", "permissionMode"]);
    if (!["ask", "acceptEdits", "auto"].includes(String(config.permissionMode))) failure("INVALID_REQUEST", "Unsupported plugin task permission mode.");
    if (config.model) this.#route(config.model);
    if (config.targetId !== undefined) this.#target(text(config.targetId), config.model?.backendId);
    assertCurrent(); this.options.store.setSetting("service", PREFS, id, config);
    return this.preferences(id);
  }
  models() {
    return this.options.store.listBackends().flatMap(backend => backend.descriptor.models.filter(model => modelRoutingEnabled(this.options.store, backend.descriptor.id, model.providerId, model.modelId)).map(model => ({
      route: { backendId: backend.descriptor.id, providerId: model.providerId, modelId: model.modelId,
        ...(model.defaultEffort ? { effort: model.defaultEffort } : {}), fastMode: false },
      efforts: model.thinkingLevels, supportsFastMode: model.supportsFastMode === true, name: model.displayName
    })));
  }
  #route(input: unknown): ExtensionTaskRoute {
    const value = record(input); exact(value, ["backendId", "providerId", "modelId", "effort", "fastMode"]);
    const route: ExtensionTaskRoute = { backendId: text(value.backendId), providerId: text(value.providerId), modelId: text(value.modelId),
      ...(value.effort === undefined || value.effort === "" ? {} : { effort: text(value.effort, 32) }), fastMode: value.fastMode === true };
    if (typeof value.fastMode !== "boolean") failure("INVALID_REQUEST", "Fast mode must be boolean.");
    const backend = this.options.store.getBackend(route.backendId);
    const model = backend.descriptor.models.find(candidate => candidate.providerId === route.providerId && candidate.modelId === route.modelId);
    if (!model || !modelRoutingEnabled(this.options.store, route.backendId, route.providerId, route.modelId) || route.effort && !model.thinkingLevels.includes(route.effort) || route.fastMode && model.supportsFastMode !== true) failure("ROUTE_UNAVAILABLE", "The selected model route is unavailable.");
    return route;
  }
  #target(id: string, backendId?: string) {
    const target = this.options.store.getTarget(id);
    if (!target.descriptor.trusted || target.descriptor.remoteWorkspace || backendId && target.descriptor.backendId !== backendId) failure("PERMISSION_DENIED", "A matching trusted local task directory is required.");
    return target;
  }
  #resolve(owner: ExtensionTaskOwner, requested?: unknown): ExtensionTaskRoute {
    const preferences = this.preferences(owner.extensionId).config;
    if (requested !== undefined) return this.#route(requested);
    if (preferences.model) return this.#route(preferences.model);
    if (owner.sourceSessionId) {
      const source = this.options.store.getSession(owner.sourceSessionId).descriptor;
      if (!source.modelId || !source.providerId || source.deletedAt || source.archived) failure("ROUTE_UNAVAILABLE", "The source task is no longer available.");
      return this.#route({ backendId: source.backendId, providerId: source.providerId, modelId: source.modelId, effort: source.effort, fastMode: source.fastMode });
    }
    const selected = this.options.defaults.current();
    if (!selected) return failure("ROUTE_UNAVAILABLE", "Choose a plugin model or an application default model first.");
    return this.#route(selected);
  }
  #receipt(sessionId: string): TaskReceipt | undefined { return this.options.store.findSetting<TaskReceipt>("service", TASKS, sessionId)?.value; }
  #own(owner: ExtensionTaskOwner, id: string): StoredSession {
    this.#assert(owner); const receipt = this.#receipt(id), session = this.options.store.getSession(id);
    if (!receipt || receipt.version !== 1 || receipt.revoked || receipt.extensionId !== owner.extensionId || receipt.installation !== owner.installation
      || receipt.resourceId !== owner.resourceId || session.descriptor.remoteWorkspace || this.options.store.findCollaborationWorkerBySession(id)) failure("TASK_NOT_FOUND", "This plugin does not own that ordinary local task.");
    return session;
  }
  #view(session: StoredSession) {
    const task = session.descriptor, runtime = this.options.host.getSessionRuntimeControl(task.id);
    return { taskId: task.id, title: task.title, revision: hash([session.revision.toString(), runtime]),
      status: task.deletedAt ? "deleted" : task.archived ? "archived" : "active", hidden: task.hidden === true,
      resolvedConfig: runtime.pending?.profile ?? runtime.effective ?? { backendId: task.backendId, providerId: task.providerId, modelId: task.modelId, effort: task.effort, fastMode: task.fastMode },
      permissionMode: task.permissionMode, planMode: task.planMode };
  }
  #all() { return this.options.store.listSettings("service", TASKS).flatMap(setting => {
    const value = setting.value as TaskReceipt;
    return value.version === 1 && !value.revoked && value.sessionId === setting.key ? [value] : [];
  }); }
  #run(owner: ExtensionTaskOwner, runId: string) {
    this.#assert(owner); const receipt = inputReceipt(this.options.store, runId);
    if (!receipt || receipt.revoked || receipt.extensionId !== owner.extensionId || receipt.installation !== owner.installation) return failure("RUN_NOT_FOUND", "This plugin does not own that input.");
    this.#own(owner, receipt.sessionId);
    const run = this.options.store.getRun(runId).descriptor, queue = this.options.store.findQueueItemByRunId(receipt.sessionId, runId, { includeCleared: true }) ?? this.options.store.getQueueItem(receipt.queueItemId);
    if (run.sessionId !== receipt.sessionId) return failure("RUN_NOT_FOUND", "The input does not belong to this task.");
    return { receipt: { ...receipt, runId, queueItemId: queue.id }, value: { runId, taskId: receipt.sessionId, status: run.state, queueState: queue.state,
      acceptedAt: run.createdAt, ...(run.endedAt ? { completedAt: run.endedAt } : {}), ...(run.error ? { error: run.error } : {}),
      usage: run.usage ?? { status: "unavailable", reason: "Per-input usage is not available." } } };
  }
  assertQueueCurrent(item: QueueItemRecord): void {
    const receipt = inputReceipt(this.options.store, item.runId);
    if (!receipt) {
      const worker = this.options.store.findCollaborationWorkerBySession(item.sessionId);
      if (worker && this.options.store.getRun(item.runId).descriptor.source !== "user") {
        const lead = this.options.store.getCollaborationGoal(worker.goalId).leadSessionId;
        this.assertTeamWorkerCurrent(lead);
        assertExtensionWorkerPlan(this.options.store, lead, { ...worker, existingWorkerId: worker.id, route: this.options.store.getSession(item.sessionId).descriptor });
      } else if (this.#receipt(item.sessionId) && this.options.store.getRun(item.runId).descriptor.source !== "user") {
        this.assertTeamWorkerCurrent(item.sessionId);
      }
      return;
    }
    const owner = this.#receipt(item.sessionId), extension = this.options.catalog.get(receipt.extensionId);
    const installation = this.options.store.findSetting<{ readonly id: string; readonly active: boolean }>("service", INSTALLATIONS, receipt.resourceId)?.value;
    if (!owner || owner.revoked || owner.installation !== receipt.installation || !installation?.active || installation.id !== receipt.installation || !extension.installed || !extension.enabled || !extension.runtime?.tasks
      || extension.owner.kind !== "resource" || extension.owner.resourceId !== receipt.resourceId || extension.permissions.some(p => p.required && !p.granted)) failure("PERMISSION_DENIED", "Plugin task authority was revoked before dispatch.");
    const preferences = this.preferences(receipt.extensionId).config, task = this.options.store.getSession(item.sessionId).descriptor;
    if (task.planMode || !permissionAllowed(task.permissionMode, preferences.permissionMode)) failure("PERMISSION_DENIED", "The task exceeds the plugin permission policy.");
  }
  assertTeamWorkerCurrent(leadSessionId: string): void {
    const receipt = this.#receipt(leadSessionId);
    if (!receipt) return;
    const extension = this.options.catalog.get(receipt.extensionId), installation = this.options.store.findSetting<{ readonly active: boolean; readonly id: string }>("service", INSTALLATIONS, receipt.resourceId)?.value;
    const task = this.options.store.getSession(leadSessionId).descriptor;
    if (receipt.revoked || !installation?.active || installation.id !== receipt.installation || !extension.installed || !extension.enabled
      || !extension.runtime?.tasks || extension.permissions.some(value => value.required && !value.granted)
      || this.preferences(receipt.extensionId).config.permissionMode !== "auto" || task.permissionMode !== "auto" || task.planMode || task.archived || task.deletedAt) failure("PERMISSION_DENIED", "Plugin team authority changed before worker admission.");
  }
  backgroundTasks(id: string) {
    this.options.catalog.get(id);
    return this.#all().filter(receipt => receipt.extensionId === id).flatMap(receipt => {
      let task: StoredSession | undefined;
      try { task = this.options.store.getSession(receipt.sessionId!); } catch { return []; }
      if (!task || !task.descriptor.hidden || task.descriptor.deletedAt) return [];
      return [{ taskId: task.descriptor.id, title: task.descriptor.title, archived: task.descriptor.archived, updatedAt: task.descriptor.updatedAt,
        running: this.options.store.listRuns({ sessionId: task.descriptor.id, activeOnly: true, limit: 1 }).length > 0 }];
    });
  }
  reveal(id: string, taskId: string, assertCurrent: () => void): void {
    assertCurrent();
    const receipt = this.#receipt(taskId);
    if (!receipt || receipt.revoked || receipt.extensionId !== id) failure("TASK_NOT_FOUND", "Plugin background task unavailable.");
    this.#hidden(taskId, false);
  }
  #hidden(id: string, hidden: boolean): void {
    const task = this.options.store.getSession(id);
    if (task.descriptor.deletedAt || !!task.descriptor.hidden === hidden) return;
    this.options.store.updateSession(id, { hidden }, task.revision, hidden ? task.descriptor.updatedAt : Date.now());
  }
  /** Called in the same Resource removal transaction, before ownership is revoked. */
  uninstall(store: OperationalStore, resourceId: string): void {
    for (const receipt of this.#all().filter(receipt => receipt.resourceId === resourceId)) {
      this.#hidden(receipt.sessionId!, false);
      for (const goal of store.listCollaborationGoals({ leadSessionId: receipt.sessionId! })) {
        for (const worker of store.listCollaborationWorkers({ goalId: goal.id, includeArchived: true })) if (worker.sessionId) this.#hidden(worker.sessionId, false);
      }
      store.setSetting("service", TASKS, receipt.sessionId!, { ...receipt, revoked: true });
    }
    const installation = store.findSetting<{ readonly version: 1; readonly id: string }>("service", INSTALLATIONS, resourceId)?.value;
    if (installation) store.setSetting("service", INSTALLATIONS, resourceId, { ...installation, active: false });
  }
  async retryWriteAccess(extensionId: string, taskId: string, signal: AbortSignal, assertCurrent: () => void) {
    assertCurrent(); signal.throwIfAborted();
    const receipt = this.#receipt(taskId), attempt = [...this.#writeAttempts.values()].find(value => value.extensionId === extensionId && value.taskId === taskId && value.installation === receipt?.installation);
    if (!receipt || receipt.revoked || !attempt) return failure("TASK_NOT_FOUND", "No recoverable plugin permission request exists.");
    const pending = this.#writeAccess({ extensionId, resourceId: receipt.resourceId, installation: receipt.installation, signal, assertCurrent }, { taskId, mode: attempt.mode }, true);
    this.#writes.add(pending); void pending.finally(() => this.#writes.delete(pending)).catch(() => undefined); return pending;
  }
  async #writeAccess(owner: ExtensionTaskOwner, request: Record<string, unknown>, explicit = false) {
    exact(request, ["type", "kind", "taskId", "mode"]); this.#assert(owner);
    const mode = request.mode === undefined ? "acceptEdits" : request.mode;
    if (mode !== "auto" && mode !== "acceptEdits") return failure("UNSUPPORTED_PERMISSION_MODE", "Only edit approval or Auto may be requested.");
    const task = this.#own(owner, text(request.taskId)), initial = this.preferences(owner.extensionId), stamp = hash(initial.config);
    if (permissionAllowed(task.descriptor.permissionMode, initial.config.permissionMode) && !task.descriptor.planMode
      && (mode === "auto" ? task.descriptor.permissionMode === "auto" : ["acceptEdits", "auto"].includes(task.descriptor.permissionMode))) return { granted: true, task: this.#view(task) };
    const backend = this.options.store.getBackend(task.descriptor.backendId).descriptor;
    if (backend.capabilities.get("permission.change")?.supported !== true || !backend.capabilities.get("permission.modes")?.options?.includes(mode)) failure("UNSUPPORTED_PERMISSION_MODE", "The task's native backend does not support that permission mode.");
    this.options.host.assertSessionLifecycleIdle(task.descriptor.id);
    if (mode === "acceptEdits" && this.options.store.countRuns({ sessionId: task.descriptor.id, includeCleared: true }) !== 0) failure("TASK_BUSY", "Only an unstarted task may request edit approval.");
    if (task.descriptor.planMode) failure("PERMISSION_DENIED", "Exit read-only planning before requesting plugin write access.");
    const scope = taskScope(task);
    const key = hash([owner.installation, task.descriptor.id]);
    const previous = this.#writeAttempts.get(key);
    if (previous?.pending || previous && !explicit) return { granted: false, task: this.#view(task) };
    if ([...this.#writeAttempts.values()].some(value => value.pending)) failure("TASK_BUSY", "Another plugin permission request is already pending.");
    const assertCurrent = () => { if (taskScope(this.#own(owner, task.descriptor.id)) !== scope || hash(this.preferences(owner.extensionId).config) !== stamp) failure("STALE_REVISION", "Task configuration or plugin permission preferences changed."); };
    const attempt = { extensionId: owner.extensionId, taskId: task.descriptor.id, installation: owner.installation, mode: mode as "acceptEdits" | "auto", pending: true };
    this.#writeAttempts.set(key, attempt);
    try {
    try { await this.options.host.authorizeExtensionTaskWrite(task.descriptor.id, owner.signal, assertCurrent, mode); }
    catch { this.#assert(owner); return { granted: false, task: this.#view(this.#own(owner, task.descriptor.id)) }; }
    assertCurrent();
    const oldMode = task.descriptor.permissionMode;
    try {
      await this.options.host.applySessionSettings(task.descriptor.id, { permissionMode: mode }, { requireNativeObservation: true });
      assertCurrent(); this.options.host.assertSessionLifecycleIdle(task.descriptor.id);
      this.options.store.transaction(store => {
        assertCurrent(); const current = this.#own(owner, task.descriptor.id);
        if (current.descriptor.planMode) failure("PERMISSION_DENIED", "Plan mode changed during plugin permission approval.");
        store.updateSession(task.descriptor.id, { permissionMode: mode });
        store.setSetting("service", PREFS, owner.extensionId, { ...initial.config, permissionMode: mode === "auto" || initial.config.permissionMode === "ask" ? mode : initial.config.permissionMode });
      });
    } catch (error) { await this.options.host.applySessionSettings(task.descriptor.id, { permissionMode: oldMode }).catch(() => undefined); throw error; }
    this.#writeAttempts.delete(key); return { granted: true, task: this.#view(this.#own(owner, task.descriptor.id)) };
    } finally { attempt.pending = false; }
  }
  async drain(): Promise<void> {
    do { const tail = this.#tail; await Promise.allSettled([tail, ...this.#writes]); if (tail === this.#tail && !this.#writes.size) return; } while (true);
  }
  async request(owner: ExtensionTaskOwner, input: unknown): Promise<unknown> {
    const early = record(input);
    if (early.kind === "requestWriteAccess") {
      const pending = this.#writeAccess(owner, early); this.#writes.add(pending);
      void pending.then(() => this.#writes.delete(pending), () => this.#writes.delete(pending)); return pending;
    }
    return this.#exclusive(async () => {
      const request = record(input), kind = text(request.kind, 32);
      const keys: Record<string, readonly string[]> = { capabilities: [], models: [], create: ["requestKey", "title", "route", "hidden", "isolatedWorkspace", "callId"], get: ["taskId"], list: ["after", "limit"],
        setModel: ["taskId", "expectedRevision", "route"], send: ["taskId", "expectedRevision", "requestKey", "text"], getRun: ["runId"], listRuns: ["taskId", "after", "limit"], readMessages: ["taskId", "after", "limit"], cancel: ["runId"], setHidden: ["taskId", "hidden"],
        startTeam: ["taskId"], getTeam: ["taskId"], setTeamPlan: ["taskId", "plan"], releaseWorker: ["taskId", "workerId", "completedAt"] };
      if (!keys[kind]) failure("INVALID_REQUEST", "Unsupported plugin task operation.");
      exact(request, ["type", "kind", ...keys[kind]!]); this.#assert(owner);
      if (kind === "capabilities") return { version: 1, operations: OPERATIONS.filter(operation => this.options.teams || !["startTeam", "getTeam", "setTeamPlan", "releaseWorker"].includes(operation)), scope: "own-plugin-local-session", exactRoute: true, pluginDefaultModel: true, sourceCallContext: true, writeAccessModes: ["acceptEdits", "auto"], hiddenTasks: this.options.catalog.get(owner.extensionId).runtime?.tasks?.hidden === true };
      if (kind === "models") return { items: this.models() };
      if (kind === "create") {
        const title = text(request.title, 120), requestKey = text(request.requestKey), hidden = request.hidden === true;
        if (request.hidden !== undefined && typeof request.hidden !== "boolean" || request.isolatedWorkspace !== undefined && typeof request.isolatedWorkspace !== "boolean") failure("INVALID_REQUEST", "Task flags must be boolean.");
        this.#assert(owner, hidden);
        const operationId = `extension-create-${hash([owner.extensionId, owner.installation, requestKey])}`, fingerprint = hash(request);
        const previous = this.options.store.findSetting<TaskReceipt>("service", TASKS, operationId)?.value;
        if (previous) {
          if (previous.fingerprint !== fingerprint) failure("IDEMPOTENCY_CONFLICT", "The request key has different content.");
          if (!previous.sessionId) failure("RECONCILING", "The task creation outcome is not confirmed. Inspect its operation.");
          return this.#view(this.#own(owner, previous.sessionId!));
        }
        const route = this.#resolve(owner, request.route), preferences = this.preferences(owner.extensionId), stamp = hash(preferences.config);
        let targetId = preferences.config.targetId;
        if (!targetId) {
          const root = join(this.options.rootDirectory, hash([owner.extensionId, route.backendId]));
          await mkdir(root, { recursive: true, mode: 0o700 }); this.#assert(owner, hidden);
          const workspaceRoot = await realpath(root);
          targetId = `extension-target-${hash([owner.extensionId, route.backendId])}`;
          if (!this.options.store.listTargets().some(target => target.descriptor.id === targetId)) await this.options.host.registerTarget({ id: targetId, backendId: route.backendId,
            displayName: this.options.catalog.get(owner.extensionId).name, workspaceRoot, managed: true, trusted: true });
        }
        this.#target(targetId, route.backendId);
        const current = () => { this.#assert(owner, hidden); this.#target(targetId!, route.backendId); if (stamp !== hash(this.preferences(owner.extensionId).config)) failure("STALE_REVISION", "Plugin task settings changed during creation."); this.#route(route); };
        current();
        const receipt: TaskReceipt = { version: 1, extensionId: owner.extensionId, resourceId: owner.resourceId, installation: owner.installation, operationId, fingerprint };
        this.options.store.setSetting("service", TASKS, operationId, receipt);
        const created = await this.options.host.createServiceSession({ operationId, serviceKind: "extension", targetId, title, ...route,
          permissionMode: preferences.config.permissionMode, planMode: false, hidden, assertServiceScope: current,
          ...(request.isolatedWorkspace ? { worktree: { refreshRemote: false } } : {}),
          onExtensionAdmitted: (store, session) => {
            current(); const adopted = { ...receipt, sessionId: session.descriptor.id };
            store.setSetting("service", TASKS, operationId, adopted); store.setSetting("service", TASKS, session.descriptor.id, adopted);
          } });
        current(); return this.#view(this.#own(owner, created.value.sessionId));
      }
      if (kind === "get") return this.#view(this.#own(owner, text(request.taskId)));
      if (kind === "list") {
        const items = [...new Set(this.#all().filter(receipt => receipt.extensionId === owner.extensionId && receipt.installation === owner.installation).map(receipt => receipt.sessionId!))].sort();
        const after = request.after === undefined ? "" : text(request.after); const page = items.filter(id => id > after).slice(0, limit(request.limit));
        return { items: page.map(id => this.#view(this.#own(owner, id))), nextCursor: page.length === limit(request.limit) ? page.at(-1) : null };
      }
      if (kind === "getRun") return this.#run(owner, text(request.runId)).value;
      if (kind === "cancel") {
        const run = this.#run(owner, text(request.runId)); const queue = this.options.store.getQueueItem(run.receipt.queueItemId);
        if (["completed", "failed", "aborted"].includes(run.value.status)) return run.value;
        this.#assert(owner);
        if (queue.state === "accepted") this.options.store.cancelQueueItem({ queueItemId: queue.id, expectedRevision: queue.revision, traceId: `extension-cancel:${queue.id}` });
        else if (["dispatching", "backend_accepted"].includes(queue.state)) await this.options.host.abort(queue.sessionId, queue.runId, () => { this.#assert(owner); this.#run(owner, queue.runId); });
        else if (queue.state === "dispatch_unknown") failure("RECONCILING", "The input dispatch result is unknown.");
        return this.#run(owner, run.value.runId).value;
      }
      const task = this.#own(owner, text(request.taskId));
      if (["setTeamPlan", "startTeam", "getTeam", "releaseWorker"].includes(kind)) {
        const teams = this.options.teams;
        if (!teams) return failure("HOST_NOT_READY", "Task collaboration is unavailable.");
        const goal = this.options.store.findActiveCollaborationGoalByLeadSession(task.descriptor.id);
        if (kind === "setTeamPlan") {
          const value = record(request.plan); exact(value, ["concurrency", "task", "items"]);
          if (Buffer.byteLength(JSON.stringify(value)) > 1_048_576 || !Array.isArray(value.items) || value.items.length < 1 || value.items.length > 1000
            || !Number.isSafeInteger(value.concurrency) || Number(value.concurrency) < 1 || Number(value.concurrency) > 128) failure("INVALID_REQUEST", "Task team plan exceeds its supported budget.");
          const prior = this.options.store.findSetting<{ readonly fingerprint: string; readonly plan: TeamPlan }>("service", PLANS, task.descriptor.id)?.value;
          const fingerprint = hash(value);
          if (prior) { if (prior.fingerprint !== fingerprint) failure("IDEMPOTENCY_CONFLICT", "The registered team plan is immutable."); return { ok: true }; }
          if (this.options.store.listRuns({ sessionId: task.descriptor.id, limit: 1 }).length || goal && teams.getTree(goal.id).workers.length) failure("TASK_BUSY", "Register the team plan before first dispatch or worker creation.");
          const scope = teamScope(task), preferences = this.preferences(owner.extensionId).config, preferenceStamp = directoryPreference(preferences);
          const primary = this.#target(task.descriptor.targetId), approved = preferences.targetId ? this.#target(preferences.targetId) : undefined;
          const root = await realpath(task.descriptor.worktree?.path ?? primary.descriptor.workspaceRoot);
          const extra = approved ? await realpath(approved.descriptor.workspaceRoot) : undefined;
          const directories: DirectoryApproval[] = [{ targetId: primary.descriptor.id, revision: primary.revision.toString(), root },
            ...(approved && extra ? [{ targetId: approved.descriptor.id, revision: approved.revision.toString(), root: extra }] : [])];
          const current = () => { this.#assert(owner); if (teamScope(this.#own(owner, task.descriptor.id)) !== scope || directoryPreference(this.preferences(owner.extensionId).config) !== preferenceStamp
            || directories.some(directory => this.#target(directory.targetId).revision.toString() !== directory.revision)) failure("STALE_REVISION", "Task team directory approval changed."); };
          const items: TeamPlan["items"][number][] = [];
          for (const raw of value.items as unknown[]) {
            const item = record(raw); exact(item, ["label", "workingDir", "route", "task"]);
            const route = this.#route(item.route), directory = await realpath(text(item.workingDir, 32_768));
            const child = relative(root, directory);
            if (directory !== extra && (isAbsolute(child) || child === ".." || child.startsWith(`..${sep}`))) failure("PERMISSION_DENIED", "The worker directory was not approved for this plugin task.");
            current();
            const targetId = `extension-team-target-${hash([owner.installation, directory, route.backendId])}`;
            if (!this.options.store.listTargets().some(target => target.descriptor.id === targetId)) await this.options.host.registerTarget({ id: targetId, backendId: route.backendId, workspaceRoot: directory, displayName: task.descriptor.title, managed: false, trusted: true });
            current(); const target = this.#target(targetId, route.backendId);
            if (target.descriptor.workspaceRoot !== directory) failure("PERMISSION_DENIED", "The worker target directory changed.");
            items.push({ label: text(item.label, 64), targetId, targetRevision: target.revision.toString(), route, task: text(item.task, 8000) });
          }
          if (new Set(items.map(item => item.label)).size !== items.length) failure("INVALID_REQUEST", "Worker labels must be unique.");
          current();
          if (this.options.store.listRuns({ sessionId: task.descriptor.id, limit: 1 }).length || goal && teams.getTree(goal.id).workers.length) failure("TASK_BUSY", "The task started while its team plan was being registered.");
          const coordinatorRoute = this.#route({ backendId: task.descriptor.backendId, providerId: task.descriptor.providerId, modelId: task.descriptor.modelId, effort: task.descriptor.effort, fastMode: task.descriptor.fastMode });
          const plan: TeamPlan = { concurrency: Number(value.concurrency), task: text(value.task, 8000), items, scope, preferences: preferenceStamp, directories, coordinatorRoute };
          this.options.store.setSetting("service", PLANS, task.descriptor.id, { version: 1, fingerprint, plan }); return { ok: true };
        }
        if (kind === "getTeam") return goal ? teams.getTree(goal.id) : { team: null };
        if (kind === "startTeam") {
          if (task.descriptor.permissionMode !== "auto" || this.preferences(owner.extensionId).config.permissionMode !== "auto" || task.descriptor.planMode) failure("PERMISSION_DENIED", "Task teams require explicitly approved Auto permission.");
          if (goal) return teams.getTree(goal.id);
          const plan = this.options.store.findSetting<{ readonly plan: TeamPlan }>("service", PLANS, task.descriptor.id)?.value?.plan;
          return teams.createGoal({ operationId: `extension-team-${hash([owner.installation, task.descriptor.id])}`, leadSessionId: task.descriptor.id, expectedSessionGeneration: task.descriptor.binding.generation,
            title: task.descriptor.title, objective: plan?.task ?? task.descriptor.title, maximumWorkers: plan?.concurrency ?? 128 });
        }
        const worker = this.options.store.getCollaborationWorker(text(request.workerId));
        if (!goal || worker.goalId !== goal.id || !worker.sessionId || worker.sessionGeneration === undefined) failure("PERMISSION_DENIED", "The worker is not owned by this plugin task.");
        const ended = this.options.store.listRuns({ sessionId: worker.sessionId, limit: 1 })[0]?.descriptor.endedAt;
        if (!Number.isSafeInteger(request.completedAt) || ended !== request.completedAt) failure("STALE_REVISION", "The worker completion changed before release.");
        const released = await teams.releaseWorker({ operationId: `extension-release-${hash([owner.installation, worker.id, ended])}`, workerId: worker.id, callerLeadSessionId: task.descriptor.id, expectedRevision: worker.revision, expectedSessionGeneration: worker.sessionGeneration! });
        const plan = this.options.store.findSetting<{ readonly plan: TeamPlan; readonly settledLabels?: readonly string[] }>("service", PLANS, task.descriptor.id)?.value;
        if (plan) this.options.store.setSetting("service", PLANS, task.descriptor.id, { ...plan, settledLabels: [...new Set([...(plan.settledLabels ?? []), worker.label])] });
        return released;
      }
      if (kind === "setHidden") {
        this.#assert(owner, true); if (typeof request.hidden !== "boolean") failure("INVALID_REQUEST", "Task visibility must be boolean.");
        this.#hidden(task.descriptor.id, request.hidden as boolean); return this.#view(this.#own(owner, task.descriptor.id));
      }
      if (kind === "listRuns") {
        const ids = sessionRuns(this.options.store, task.descriptor.id).filter(run => inputReceipt(this.options.store, run.descriptor.id)?.installation === owner.installation).map(run => run.descriptor.id).sort();
        const after = request.after === undefined ? "" : text(request.after), page = ids.filter(id => id > after).slice(0, limit(request.limit));
        return { items: page.map(id => this.#run(owner, id).value), nextCursor: page.length === limit(request.limit) ? page.at(-1) : null };
      }
      if (kind === "readMessages") {
        if (request.after !== undefined && !/^(?:0|[1-9][0-9]{0,19})$/u.test(text(request.after, 20))) failure("INVALID_REQUEST", "A decimal event cursor is required.");
        const after = request.after === undefined ? 0n : BigInt(text(request.after));
        const events = this.options.store.listEvents({ sessionId: task.descriptor.id, afterCursor: after, limit: limit(request.limit) });
        return { items: events.filter(event => event.payload.type === "message_complete").map(event => ({ id: event.id, cursor: event.globalCursor.toString(), createdAt: event.emittedAt, message: event.payload })), nextCursor: events.length === limit(request.limit) ? events.at(-1)?.globalCursor.toString() : null };
      }
      const view = this.#view(task);
      if (kind === "send") {
        const operationId = `extension-send-${hash([owner.extensionId, owner.installation, task.descriptor.id, text(request.requestKey)])}`;
        const prior = this.options.store.findSetting<InputReceipt>("service", INPUTS, operationId)?.value;
        if (prior) { if (prior.fingerprint !== hash(request)) failure("IDEMPOTENCY_CONFLICT", "The request key has different input."); return this.#run(owner, prior.runId).value; }
      }
      if (request.expectedRevision !== view.revision) failure("STALE_REVISION", "Task configuration changed. Refresh before retrying.");
      if (task.descriptor.archived || task.descriptor.deletedAt) failure("TASK_BUSY", "The task is not active.");
      if (kind === "setModel") {
        const route = this.#resolve(owner, request.route === "plugin-default" ? undefined : request.route), stamp = hash(this.preferences(owner.extensionId).config);
        const result = await this.options.host.setSessionRuntimeControl({ sessionId: task.descriptor.id, expectedGeneration: this.options.host.getSessionRuntimeControl(task.descriptor.id).generation,
          patch: route, source: "agent", assertAuthority: () => { this.#assert(owner); if (this.#view(this.#own(owner, task.descriptor.id)).revision !== view.revision || request.route === "plugin-default" && hash(this.preferences(owner.extensionId).config) !== stamp) failure("STALE_REVISION", "Task or plugin preferences changed."); } });
        return { status: result.status, task: this.#view(this.#own(owner, task.descriptor.id)) };
      }
      if (kind === "send") {
        const message = text(request.text, 32_768), requestKey = text(request.requestKey), operationId = `extension-send-${hash([owner.extensionId, owner.installation, task.descriptor.id, requestKey])}`;
        if (this.options.redact(message) !== message) failure("INVALID_REQUEST", "Protected credentials cannot be sent as task input.");
        const fingerprint = hash(request), prior = this.options.store.findSetting<InputReceipt>("service", INPUTS, operationId)?.value;
        if (prior) { if (prior.fingerprint !== fingerprint) failure("IDEMPOTENCY_CONFLICT", "The request key has different input."); return this.#run(owner, prior.runId).value; }
        const preferences = this.preferences(owner.extensionId).config;
        if (task.descriptor.planMode || !permissionAllowed(task.descriptor.permissionMode, preferences.permissionMode)) failure("PERMISSION_DENIED", "Task permissions exceed plugin policy.");
        this.#assert(owner);
        const result = this.options.host.enqueueServiceInput({ operationId, sessionId: task.descriptor.id, source: "system",
          prompt: { text: `[Plugin input from ${owner.extensionId}: external application data]\n${message}`, mentions: [], images: [], files: [], disposition: "prompt" },
          onAdmitted: (store, accepted) => {
            this.#assert(owner);
            const receipt: InputReceipt = { version: 1, extensionId: owner.extensionId, resourceId: owner.resourceId, installation: owner.installation, operationId, fingerprint, ...accepted };
            store.setSetting("service", INPUTS, accepted.runId, receipt); store.setSetting("service", INPUTS, operationId, receipt);
          } });
        return this.#run(owner, result.value.runId).value;
      }
      return failure("INVALID_REQUEST", "Unsupported plugin task operation.");
    });
  }
}

function nativeTaskPolicy(policy: PolicySnapshot, request: NativeToolAuthorizationRequest): "allow" | "deny" | "ask" | undefined {
  const input = request.input && typeof request.input === "object" && !Array.isArray(request.input) ? request.input as Record<string, unknown> : {};
  const aliases: Readonly<Record<string, string>> = { Read: "read", Glob: "find", Grep: "grep", LS: "ls", Write: "write", Edit: "edit", MultiEdit: "edit", Bash: "bash", command: "bash" };
  const call = { name: aliases[request.toolName] ?? request.toolName, args: { ...input, ...(input.file_path === undefined ? {} : { path: input.file_path }) } };
  const context: PolicyContext = { workspaceRoot: policy.workspaceRoot, extraReadOnlyRoots: [], mode: "ask", explicitAllowTools: new Set(), explicitDenyTools: new Set() };
  if (request.toolName === "file_change" && Array.isArray(input.changes)) {
    const decisions = input.changes.flatMap(change => {
      const value = record(change), kind = record(value.kind), paths = [value.path, kind.move_path].filter(path => typeof path === "string");
      return paths.map(path => { const file = { name: "write", args: { path } }; return evaluateOrderedPolicyRules(policy, policyObservationForToolCall(file, context, classifyToolCall(file, context)))?.action; });
    });
    return decisions.includes("deny") ? "deny" : decisions.includes("ask") ? "ask" : decisions.includes("allow") ? "allow" : undefined;
  }
  return evaluateOrderedPolicyRules(policy, policyObservationForToolCall(call, context, classifyToolCall(call, context)))?.action;
}

/** Private service provenance also limits cross-task tools for plugin-owned executions. */
export function isExtensionTaskControlled(store: OperationalStore, sessionId: string): boolean {
  const worker = store.findCollaborationWorkerBySession(sessionId);
  const leadSessionId = worker ? store.getCollaborationGoal(worker.goalId).leadSessionId : sessionId;
  const receipt = store.findSetting<TaskReceipt>("service", TASKS, leadSessionId)?.value;
  if (!receipt) return false;
  if (!receipt.revoked) return true;
  if (worker && store.listRuns({ sessionId, limit: 1 })[0]?.descriptor.source !== "user") return true;
  if (store.listRuns({ sessionId, activeOnly: true, limit: 1 })[0]?.descriptor.source === "system") return true;
  return store.listQueueItems({ sessionId, states: ["accepted", "dispatching", "backend_accepted", "dispatch_unknown"] }).some(item => inputReceipt(store, item.runId) !== undefined);
}

/** Collaboration's ordinary worker path consumes the registered exact plan;
 * a model cannot turn plugin Auto permission into arbitrary worker routes. */
export function assertExtensionWorkerPlan(store: OperationalStore, leadSessionId: string, input: {
  readonly label: string; readonly assignment: string; readonly parentWorkerId?: string;
  readonly existingWorkerId?: string;
  readonly route: { readonly targetId: string; readonly providerId?: string; readonly modelId?: string; readonly effort?: string; readonly fastMode: boolean; readonly permissionMode: string; readonly planMode: boolean };
}): void {
  if (!isExtensionTaskControlled(store, leadSessionId)) return;
  const receipt = store.findSetting<TaskReceipt>("service", TASKS, leadSessionId)?.value;
  const config = receipt ? store.findSetting<ExtensionTaskPreferences>("service", PREFS, receipt.extensionId)?.value : undefined;
  const registered = store.findSetting<{ readonly plan: TeamPlan; readonly settledLabels?: readonly string[] }>("service", PLANS, leadSessionId)?.value, plan = registered?.plan;
  const item = plan?.items.find(value => value.label === input.label), target = store.getTarget(input.route.targetId);
  const lead = store.getSession(leadSessionId);
  const root = realpathSync(lead.descriptor.worktree?.path ?? store.getTarget(lead.descriptor.targetId).descriptor.workspaceRoot), directory = realpathSync(target.descriptor.workspaceRoot);
  const extra = config?.targetId ? store.getTarget(config.targetId) : undefined;
  const child = relative(root, directory), within = !isAbsolute(child) && child !== ".." && !child.startsWith(`..${sep}`);
  const backend = store.getBackend(target.descriptor.backendId).descriptor, model = backend.models.find(value => value.providerId === input.route.providerId && value.modelId === input.route.modelId);
  if (!receipt || receipt.revoked || !target.descriptor.trusted || target.descriptor.remoteWorkspace || !store.getTarget(lead.descriptor.targetId).descriptor.trusted
    || !within && (!extra?.descriptor.trusted || extra.descriptor.remoteWorkspace || realpathSync(extra.descriptor.workspaceRoot) !== directory)
    || !model || !modelRoutingEnabled(store, backend.id, model.providerId, model.modelId) || input.route.effort && !model.thinkingLevels.includes(input.route.effort)
    || input.route.fastMode && model.supportsFastMode !== true || input.route.permissionMode !== "auto" || input.route.planMode || config?.permissionMode !== "auto") failure("PERMISSION_DENIED", "The worker request exceeds the plugin's directory, model or permission policy.");
  if (!plan) return;
  if (!item || registered?.settledLabels?.includes(input.label) || item.targetId !== input.route.targetId
    || target.descriptor.backendId !== item.route.backendId || input.route.providerId !== item.route.providerId || input.route.modelId !== item.route.modelId
    || input.route.effort !== item.route.effort || input.route.fastMode !== item.route.fastMode || input.route.permissionMode !== "auto" || input.route.planMode
    || target.revision.toString() !== item.targetRevision
    || teamScope(lead) !== plan.scope || directoryPreference(config) !== plan.preferences || plan.directories.some(directory => {
      const approved = store.getTarget(directory.targetId);
      return !approved.descriptor.trusted || approved.descriptor.remoteWorkspace || approved.revision.toString() !== directory.revision
        || realpathSync(directory.targetId === lead.descriptor.targetId && lead.descriptor.worktree ? lead.descriptor.worktree.path : approved.descriptor.workspaceRoot) !== directory.root;
    })) failure("PERMISSION_DENIED", "The worker request does not match the plugin's registered task plan and permission policy.");
  const goal = store.findActiveCollaborationGoalByLeadSession(leadSessionId);
  if (goal && store.listCollaborationWorkers({ goalId: goal.id }).filter(worker => worker.id !== input.existingWorkerId && !worker.runtimeReleased && !["archived", "stopped"].includes(worker.status)).length >= plan!.concurrency) failure("TASK_BUSY", "The registered plugin team concurrency is exhausted.");
}
