import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, resolve } from "node:path";
import { redactSecrets, type PartnerSessionTaskReceipt, type PromptInput, type RunDescriptor, type TargetDescriptor } from "@joko/core";
import { NotFoundError, type OperationalStore, type PartnerModelRouteRecord, type PartnerProfileRecord, type QueueItemRecord } from "@joko/store";
import type { PartnerManager } from "./partner-manager.js";
import type { SessionHost, InteractionDecisionSubmission } from "./session-host.js";
import type { WorkspaceService } from "./workspace-service.js";
import type { SessionRuntimeProfile } from "./session-runtime-control.js";
import { checkPartnerWorkbenchProject } from "./partner-workbench-project.js";
import { persistSessionTaskActivity } from "./session-task-activity.js";
import type { PartnerHomeProjects } from "./partner-home-projects.js";
import { readPartnerSessionTaskGroupOrigin, type PartnerSessionTaskGroupOrigin, type PartnerSessionTaskGroupPublisher } from "./partner-session-task-group-publisher.js";
import { partnerTaskContextUsage, suggestPartnerTaskRoute } from "./partner-task-route.js";

const SCOPE = "partner.session-tasks";
const DEFAULT_RESUME_INPUT = "Continue from the existing task history after the requested pause. Check completed actions; do not replay the original request.";
const CANCEL_OPERATION = "partner_task_cancel";
const STOP_UNCONFIRMED = "Task shutdown is still unconfirmed. Input remains held; inspect or retry stopping the same task.";
function sameComputer(target: TargetDescriptor, home: TargetDescriptor): boolean {
  const child = target.remoteWorkspace, parent = home.remoteWorkspace;
  return parent === undefined ? child === undefined : parent.kind === "device_peer" && child?.kind === "device_peer"
    && parent.controllerDeviceId === child.controllerDeviceId && parent.targetDeviceId === child.targetDeviceId;
}
const activeStates = ["preparing", "queued", "running", "waiting"] as const;
export type PartnerSessionTaskStatus = typeof activeStates[number] | "completed" | "failed" | "cancelled" | "timed-out" | "unknown";
type CancellationStatus = "cancelled" | "timed-out";
export interface TaskModelSelection { readonly id: string; readonly effort?: string; readonly fastMode?: boolean | "ultrafast" }
export interface StartPartnerSessionTask {
  readonly instruction: string; readonly title?: string; readonly workingDir?: string; readonly useWorktree?: boolean;
  readonly contextRefs?: readonly string[]; readonly timeoutMs?: number; readonly modelSelection?: TaskModelSelection;
}
export interface PartnerSessionTaskRecord {
  readonly version: 1; readonly id: string; readonly partnerId: string; readonly parentSessionId: string;
  readonly requestFingerprint: string; readonly title: string; readonly objective: string; readonly contextRefs: readonly string[];
  readonly targetId: string; readonly directory: string; readonly realDirectory: string; readonly useWorktree: boolean;
  readonly route: PartnerModelRouteRecord; readonly routes: readonly PartnerModelRouteRecord[]; readonly explicitModel: boolean;
  readonly permissionMode: PartnerProfileRecord["capabilities"]["permissionMode"]; readonly planMode: boolean;
  readonly timeoutMs: number; readonly deadlineAt: number; readonly createdAt: number; readonly updatedAt: number;
  readonly execution: number; readonly executionRunIds: readonly string[]; readonly status: PartnerSessionTaskStatus;
  readonly control: "active" | "pausing" | "paused" | "cancelling";
  readonly sessionId?: string; readonly runId?: string; readonly pauseAt?: number; readonly queuePauseRevision?: string;
  readonly result?: string; readonly error?: string; readonly deliveredExecution?: number;
  readonly group?: PartnerSessionTaskGroupOrigin; readonly groupFallback?: true; readonly groupDeliveryError?: string;
  readonly topicOperationId?: string;
}
export class PartnerSessionTaskError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "PartnerSessionTaskError"; }
}
type TaskHost = Pick<SessionHost, "createServiceSession" | "registerTarget" | "enqueueServiceInput" | "abort"
  | "getSessionRuntimeControl" | "getSessionRuntimeUsage" | "setSessionRuntimeControl" | "resolveInteraction" | "isSessionActive"
  | "preparePartnerPauseQueue" | "pausePartnerSession" | "restorePartnerQueue" | "wakePartnerSession">;

/** Independent visible tasks have their own durable creation and execution owner.
 * Native history, Queue, interactions, worktrees and artifacts keep their existing owners. */
export class PartnerSessionTaskManager {
  readonly #ids = new Set<string>(); readonly #sessions = new Map<string, string>();
  readonly #locks = new Map<string, Promise<unknown>>(); readonly #timers = new Map<string, ReturnType<typeof setTimeout>>();
  #unsubscribe?: () => void; #closed = false;
  constructor(readonly store: OperationalStore, readonly partners: PartnerManager, readonly host: TaskHost,
    readonly workspaces: Pick<WorkspaceService, "register">, readonly managedDataDirectory: string, readonly now = Date.now,
    readonly remoteProjects?: PartnerHomeProjects, readonly groupPublisher?: PartnerSessionTaskGroupPublisher) {
    for (const row of store.listSettings("service", SCOPE)) this.#index(readRecord(row.value));
  }

  async initialize(): Promise<void> {
    for (const row of this.store.listSettings("service", SCOPE)) {
      const record = readRecord(row.value); this.#index(record);
      // Creation with a lost receipt may already have touched the native runtime.
      // Observe its durable operation; never replay native creation or input here.
      if (record.status === "preparing") this.#recoverCreation(record);
      if (record.control === "cancelling") this.#recoverCancellation(record, row.revision);
    }
    this.#unsubscribe = this.store.subscribe(event => {
      const id = event.sessionId === undefined ? undefined : this.#sessions.get(event.sessionId);
      if (id) void this.#serial(id, () => this.#reconcile(id)).catch(() => undefined);
      else if (event.sessionId !== undefined) {
        const partner = event.targetId === undefined ? undefined : this.partners.partnerForHomeTarget(event.targetId);
        if (partner?.canonicalSessionId === event.sessionId) void this.refreshPartner(partner.id).catch(() => undefined);
      }
    });
    for (const id of this.#ids) await this.#serial(id, () => this.#reconcile(id));
  }
  async close(): Promise<void> {
    this.#closed = true; this.#unsubscribe?.();
    this.groupPublisher?.close();
    for (const timer of this.#timers.values()) clearTimeout(timer); this.#timers.clear();
    await Promise.allSettled([...this.#locks.values()]);
  }
  ownedSessions(partnerId: string): readonly string[] {
    return this.list(partnerId).flatMap(task => task.sessionId === undefined ? [] : [task.sessionId]);
  }
  forgetPartner(partnerId: string): void {
    for (const task of this.list(partnerId)) {
      if (task.sessionId) { const session = this.store.getSession(task.sessionId).descriptor; if (!session.archived && session.deletedAt === undefined) throw changed(); }
      clearTimeout(this.#timers.get(task.id)); this.#timers.delete(task.id); this.#ids.delete(task.id);
      if (task.sessionId) this.#sessions.delete(task.sessionId); this.store.deleteSetting("service", SCOPE, task.id); this.groupPublisher?.forget(task.id);
    }
  }
  async refreshPartner(partnerId: string): Promise<void> {
    await Promise.allSettled(this.list(partnerId).filter(task => task.deliveredExecution !== task.execution && !isActive(task.status) && task.status !== "unknown")
      .map(task => this.#serial(task.id, () => this.#reconcile(task.id))));
  }
  list(partnerId: string): readonly PartnerSessionTaskRecord[] {
    return this.store.listSettings("service", SCOPE).map(row => readRecord(row.value)).filter(row => row.partnerId === partnerId)
      .sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
  }
  isHeld(sessionId: string): boolean {
    const id = this.#sessions.get(sessionId); if (!id) return false;
    const task = this.#read(id);
    try { return task.control !== "active" || this.partners.getPartner(task.partnerId).lifecycle === "paused"; }
    catch { return true; }
  }
  isRetiring(sessionId: string): boolean {
    const id = this.#sessions.get(sessionId); if (!id) return false;
    try { const partnerId = this.#read(id).partnerId; return this.partners.getPartner(partnerId).lifecycle === "deleted"
      || this.partners.listPendingDeletions().some(deletion => deletion.partnerId === partnerId); }
    catch { return true; }
  }
  fallback(input: { readonly sessionId: string; readonly current: SessionRuntimeProfile; readonly visitedRoutes: readonly string[]; readonly currentHop: number }) {
    const id = this.#sessions.get(input.sessionId); if (!id) return { owned: false };
    const task = this.#read(id), key = (route: SessionRuntimeProfile) => `${route.backendId}\0${route.providerId}\0${route.modelId}`;
    if (task.explicitModel || input.currentHop >= task.routes.length - 1) return { owned: true };
    const visited = new Set([...input.visitedRoutes, key(input.current)]), index = task.routes.findIndex(route => key(route) === key(input.current));
    const candidate = task.routes.slice(Math.max(0, index + 1)).find(route => !visited.has(key(route)));
    return candidate === undefined ? { owned: true } : { owned: true, candidate };
  }
  caller(sessionId: string) {
    const group = this.groupPublisher?.capture(sessionId), topic = group ? undefined : this.partners.independentTaskTopic(sessionId);
    const profile = group?.profile ?? topic?.profile ?? this.partners.runtimeCaller(sessionId);
    const assertCurrent = () => {
      group?.assertCurrent();
      const currentTopic = topic ? this.partners.independentTaskTopic(sessionId) : undefined;
      if (topic && currentTopic?.operationId !== topic.operationId) throw changed();
      const current = group ? this.partners.getPartner(profile.id) : currentTopic?.profile ?? this.partners.runtimeCaller(sessionId);
      const session = this.store.getSession(sessionId).descriptor;
      if (current.revision !== profile.revision || current.profileVersion !== profile.profileVersion || current.lifecycle !== "active"
        || current.initializationState !== "ready" || session.archived || session.deletedAt !== undefined) throw changed();
    };
    assertCurrent(); return { profile, group, topic, assertCurrent };
  }
  #resolveModel(sessionId: string, explicit?: PartnerModelRouteRecord) {
    const caller = this.caller(sessionId);
    if (!caller.group) return this.partners.resolveTaskModel(sessionId, explicit, caller.topic?.operationId);
    if (!caller.profile.canonicalSessionId) throw changed();
    const runtime = this.host.getSessionRuntimeControl(sessionId), selected = explicit ?? caller.profile.taskModelOverride ?? runtime.effective;
    const frozen = this.partners.resolveTaskModel(caller.profile.canonicalSessionId, selected);
    return { route: frozen.route, assertCurrent: () => { caller.assertCurrent(); frozen.assertCurrent();
      if (explicit === undefined && caller.profile.taskModelOverride === undefined && this.host.getSessionRuntimeControl(sessionId).generation !== runtime.generation) throw changed(); } };
  }
  models(sessionId: string) {
    const { profile } = this.caller(sessionId), available = [];
    for (const backend of this.store.listBackends()) for (const model of backend.descriptor.models) {
      const route = { backendId: backend.descriptor.id, providerId: model.providerId, modelId: model.modelId,
        ...(model.thinkingLevels.length ? { effort: model.thinkingLevels.includes("medium") ? "medium" : model.thinkingLevels[0]! } : {}), fastMode: false };
      try {
        this.#resolveModel(sessionId, route).assertCurrent();
        available.push({ id: routeId(route), ...route, name: model.displayName, efforts: model.thinkingLevels, supportsFastMode: model.supportsFastMode === true, supportsUltrafastMode: model.supportsUltrafastMode === true });
      } catch { /* Unavailable or disabled routes are never selectable. */ }
    }
    return { current: profile.taskModelOverride ?? this.host.getSessionRuntimeControl(sessionId).effective, partnerRevision: profile.revision.toString(), available };
  }
  start(sessionId: string, id: string, input: StartPartnerSessionTask, assertCaller: () => void): Promise<PartnerSessionTaskRecord> {
    return this.#serial(id, async () => {
      assertCaller(); const caller = this.caller(sessionId), { profile } = caller;
      const assertAdmission = () => { assertCaller(); caller.assertCurrent(); };
      const normalized = normalizeStart(input), fingerprint = hash(JSON.stringify(normalized));
      const saved = this.store.findSetting("service", SCOPE, id);
      if (saved) {
        const task = readRecord(saved.value);
        if (task.partnerId !== profile.id || task.parentSessionId !== sessionId || task.requestFingerprint !== fingerprint) throw invalid("This task identity belongs to a different request.");
        return this.#reconcile(id);
      }
      let selected: PartnerModelRouteRecord | undefined;
      if (normalized.modelSelection) {
        const choice = this.models(sessionId).available.find(row => row.id === normalized.modelSelection!.id);
        if (!choice) throw invalid("The selected task model is unavailable. Read the model directory again.");
        selected = { backendId: choice.backendId, providerId: choice.providerId, modelId: choice.modelId,
          ...(normalized.modelSelection.effort === undefined ? choice.effort === undefined ? {} : { effort: choice.effort } : { effort: normalized.modelSelection.effort }),
          fastMode: normalized.modelSelection.fastMode ?? false };
      }
      const frozen = this.#resolveModel(sessionId, selected), route = frozen.route;
      const home = this.store.getTarget(profile.homeTargetId).descriptor;
      const remote = home.remoteWorkspace;
      if (remote && (remote.kind !== "device_peer" || !this.remoteProjects?.remote(home))) throw invalid("This Partner execution computer is unavailable.");
      if (remote && normalized.useWorktree) throw invalid("Creating an independent task worktree is unavailable on this execution computer. Start it in an explicitly selected project directory.");
      const directory = normalized.workingDir ?? home.workspaceRoot;
      if (normalized.workingDir && !remote) {
        if (!isAbsolute(directory)) throw invalid("An existing absolute working directory is required.");
        await checkPartnerWorkbenchProject(directory, { managedDataDirectory: this.managedDataDirectory, homeDirectory: homedir(), caseInsensitive: process.platform !== "linux" });
      }
      const actual = remote ? await this.remoteProjects!.executionDirectory(home, directory, () => { assertCaller(); frozen.assertCurrent(); }) : await realpath(directory);
      if (!remote && !(await stat(actual)).isDirectory()) throw invalid("The working directory is unavailable.");
      assertAdmission(); frozen.assertCurrent();
      const targetId = `partner-task-target:${hash(JSON.stringify([profile.id, home.id, route.backendId, directory, actual])).slice(0, 32)}`;
      const createdAt = this.now();
      let task: PartnerSessionTaskRecord = { version: 1, id, partnerId: profile.id, parentSessionId: sessionId, requestFingerprint: fingerprint,
        title: normalized.title ?? normalized.instruction.split("\n")[0]!.slice(0, 120), objective: normalized.instruction, contextRefs: normalized.contextRefs,
        targetId, directory, realDirectory: actual, useWorktree: normalized.useWorktree, route,
        routes: selected || profile.taskModelOverride ? [route] : profile.capabilities.modelChain.map(item => ({ ...item })),
        explicitModel: selected !== undefined || profile.taskModelOverride !== undefined, permissionMode: profile.capabilities.permissionMode, planMode: profile.capabilities.planMode,
        timeoutMs: normalized.timeoutMs, deadlineAt: createdAt + normalized.timeoutMs, createdAt, updatedAt: createdAt, execution: 1, executionRunIds: [], status: "preparing", control: "active",
        ...(caller.topic ? { topicOperationId: caller.topic.operationId } : {}),
        ...(caller.group ? { group: { version: 1, roomId: caller.group.roomId, joinId: caller.group.joinId, hostServerId: caller.group.hostServerId,
          actorId: caller.group.actorId, ownerId: caller.group.ownerId, sourceMessageId: caller.group.sourceMessageId, accessRevision: caller.group.accessRevision,
          fallbackSessionId: profile.canonicalSessionId! } } : {}) };
      this.store.transaction(() => {
        this.#save(task);
        this.#recordTaskReceipt(task);
      });
      try {
        const binding = remote === undefined ? undefined : { ...remote, workspaceRoot: actual };
        await this.workspaces.register({ id: targetId, root: actual, displayName: basename(directory), trusted: true,
          ...(binding ? { remote: { targetId, binding } } : {}) });
        assertAdmission(); frozen.assertCurrent(); await this.#assertDirectory(task);
        const existing = this.store.listTargets(route.backendId).find(item => item.descriptor.id === targetId);
        if (existing === undefined) await this.host.registerTarget({ id: targetId, backendId: route.backendId, displayName: basename(directory), workspaceRoot: actual, managed: !normalized.workingDir, trusted: true,
          ...(binding ? { remoteWorkspace: binding } : {}) },
          { workspaceId: targetId, kind: "partner_session_task", partnerId: profile.id, homeTargetId: home.id,
            homeCanonicalSessionId: caller.topic ? profile.canonicalSessionId! : sessionId });
        else if (!existing.descriptor.trusted || existing.descriptor.workspaceRoot !== actual || !sameComputer(existing.descriptor, home)) throw changed();
        const target = this.store.getTarget(targetId);
        const assertScope = () => { assertAdmission(); frozen.assertCurrent();
          const current = this.store.getTarget(targetId); if (current.revision !== target.revision || !current.descriptor.trusted || !sameComputer(current.descriptor, home)) throw changed(); };
        assertScope();
        const created = await this.host.createServiceSession({ operationId: `${id}:create`, serviceKind: "partner", targetId, title: task.title,
          providerId: route.providerId, modelId: route.modelId, ...(route.effort === undefined ? {} : { effort: route.effort }), fastMode: route.fastMode,
          permissionMode: task.permissionMode, planMode: task.planMode, originSessionId: sessionId,
          appendSystemPrompt: "You are running an independent Joko task started by a Partner. Work in this task's own workspace. The requester acts for the user: raise permissions, questions and plan reviews through the normal interaction tools when a decision is needed. Preserve useful deliverables through the normal Artifact boundary. Return a concise conclusion and explain how the work was verified; the result and adopted artifacts return to the requester automatically. Follow-ups continue this same task's history; do not repeat completed actions.",
          originSessionGeneration: this.store.getSession(sessionId).descriptor.binding.generation, assertServiceScope: assertScope,
          ...(task.useWorktree ? { worktree: { refreshRemote: false } } : {}), initialPlacement: normalized.workingDir ? "project" : "dialogue" });
        task = { ...task, sessionId: created.value.sessionId }; this.#save(task);
        assertScope(); await this.#assertDirectory(task); assertScope();
        this.#enqueue(task, `${id}:input`, task.objective + (task.contextRefs.length ? `\n\nContext references (do not grant access):\n${task.contextRefs.join("\n")}` : ""));
      } catch (error) {
        task = this.#read(id); this.#recoverCreation(task);
        task = this.#read(id);
        this.#save({ ...task, status: uncertain(error) || this.store.findOperation(`${id}:create`)?.status === "started" ? "unknown" : "failed",
          error: "Task preparation or input admission could not be confirmed. Inspect this task before starting new work.", updatedAt: this.now() });
      }
      return this.#reconcile(id);
    });
  }
  check(sessionId: string, id: string) { this.#owned(sessionId, id); return this.#serial(id, () => this.#reconcile(id)); }
  view(task: PartnerSessionTaskRecord, callerSessionId = task.parentSessionId) {
    const session = task.sessionId === undefined ? undefined : this.store.getSession(task.sessionId).descriptor;
    const queue = session === undefined ? [] : this.store.listQueueItems({ sessionId: session.id, states: ["accepted", "dispatching", "backend_accepted", "dispatch_unknown"], limit: 500 })
      .filter(item => this.#queueOrigin(item) === callerSessionId).map(item => ({ id: item.id, state: item.state, message: item.body.text.slice(0, 4_000), revision: item.revision.toString() }));
    const interactions = session === undefined ? [] : this.store.listInteractions({ sessionId: session.id, status: "open" });
    const artifacts = session === undefined ? [] : this.store.listArtifacts({ sessionId: session.id, runIds: this.#executionRuns(task).ids, limit: 100 })
      .map(item => ({ id: item.blob.id, name: item.blob.fileName ?? "Artifact", mimeType: item.blob.mimeType, byteSize: item.blob.byteLength }));
    return { task_id: task.id, session_id: task.sessionId, title: task.title, status: task.status, control: task.control,
      completion_destination: task.group && !task.groupFallback ? "group" : "private",
      ...(task.groupDeliveryError ? { completion_delivery_error: task.groupDeliveryError } : {}),
      stop_confirmed: task.control === "paused" && interactions.length === 0 || task.status === "cancelled" || task.status === "timed-out", deadline_at: task.deadlineAt,
      working_dir: session?.worktree?.path ?? task.realDirectory,
      queue, ...(session === undefined ? {} : { queue_control: this.store.getQueueControl(session.id) }), pending_interactions: interactions, result: task.result, error: task.error, artifacts, model_route: session ? this.host.getSessionRuntimeControl(session.id).effective : task.route };
  }
  messageReceipt(sessionId: string, task: PartnerSessionTaskRecord, queuedMessageId: string) {
    try {
      const item = this.store.getQueueItem(queuedMessageId);
      if (item.sessionId !== task.sessionId || this.#queueOrigin(item) !== sessionId) throw invalid("The queued message does not belong to this caller and task.");
      return { queued_message_id: item.id, state: item.state };
    } catch (error) {
      if (error instanceof PartnerSessionTaskError) throw error;
      return { queued_message_id: queuedMessageId, state: error instanceof NotFoundError ? "not-found" : "unavailable" };
    }
  }
  message(sessionId: string, id: string, operationId: string, input: { readonly mode: "queue" | "steer" | "resume" | "edit" | "withdraw";
    readonly message?: string; readonly queuedMessageId?: string; readonly interactionId?: string; readonly interactionGeneration?: number; readonly decision?: InteractionDecisionSubmission }, assertCaller: () => void) {
    this.#owned(sessionId, id);
    return this.#serial(id, async () => {
      assertCaller(); let task = this.#owned(sessionId, id); task = await this.#reconcile(task.id);
      if (!task.sessionId) throw invalid("This task has no confirmed Session.");
      this.#assertTaskSession(task); await this.#assertDirectory(task); assertCaller(); this.#assertTaskSession(task);
      if (input.mode === "resume") {
        this.#resume(task, task.sessionId, sessionId, operationId, input.message, assertCaller);
        return this.#reconcile(id);
      }
      if (task.control !== "active" || task.status === "unknown") throw invalid("Resume a confirmed pause or resolve the unknown task state before sending input.");
      if (input.decision) {
        const interaction = this.store.getInteraction(input.interactionId!);
        if (interaction.sessionId !== task.sessionId || interaction.generation !== input.interactionGeneration || interaction.status !== "open") throw changed();
        const claim = this.store.claimDeferredEffectOperation({ id: operationId, kind: "partner_task_interaction", body: { taskId: id, interactionId: interaction.id, generation: interaction.generation, decision: input.decision } }, () => assertCaller());
        if (claim.claimed) {
          assertCaller(); this.host.resolveInteraction(interaction.id, interaction.generation, input.decision, operationId, operationId);
          this.store.completeDeferredEffectOperation(operationId, claim.operation.bodyHash, () => ({ resolved: true }));
        }
        return this.#reconcile(id);
      }
      if (input.mode === "edit" || input.mode === "withdraw") {
        const item = this.store.getQueueItem(input.queuedMessageId!);
        if (item.sessionId !== task.sessionId || this.#queueOrigin(item) !== sessionId || item.state !== "accepted") throw invalid("Only your own unconsumed input can be edited or withdrawn.");
        this.store.runOperation({ id: operationId, kind: "partner_task_queue_edit", body: { taskId: id, mode: input.mode, queueItemId: item.id, message: input.message } }, store => {
          assertCaller(); if (input.mode === "edit") store.editQueueItem({ queueItemId: item.id, expectedRevision: item.revision, body: prompt(input.message!), traceId: operationId });
          else store.cancelQueueItem({ queueItemId: item.id, expectedRevision: item.revision, traceId: operationId });
          return { queueItemId: item.id };
        }); return this.#reconcile(id);
      }
      if (input.mode === "steer") {
        const active = this.store.listRuns({ sessionId: task.sessionId, activeOnly: true, limit: 500 }).some(run => run.descriptor.state === "running" || run.descriptor.state === "waiting");
        const actualBackendId = this.store.getSession(task.sessionId!).descriptor.backendId;
        if (!active || this.store.getBackend(actualBackendId).descriptor.capabilities.get("turn.steer")?.supported !== true) throw invalid("This task cannot accept same-turn steer; no queued fallback was sent.");
      }
      const existing = this.store.findOperation(operationId);
      if (existing) {
        const body = existing.body as { sessionId?: string; prompt?: PromptInput; originSessionId?: string };
        if (body.sessionId !== task.sessionId || body.originSessionId !== sessionId || body.prompt?.text !== input.message || body.prompt?.disposition !== (input.mode === "steer" ? "steer" : "prompt")) throw invalid("This input identity belongs to another message.");
        return this.#reconcile(id);
      }
      if (!isActive(task.status)) task = { ...task, execution: task.execution + 1, executionRunIds: [], runId: undefined,
        deadlineAt: this.now() + task.timeoutMs, pauseAt: undefined, queuePauseRevision: undefined, status: "queued", result: undefined, error: undefined };
      assertCaller(); this.#enqueue(task, operationId, input.message!, input.mode === "steer" ? "steer" : "prompt", sessionId); return this.#reconcile(id);
    });
  }

  #resume(task: PartnerSessionTaskRecord, childSessionId: string, callerSessionId: string, operationId: string, message: string | undefined, assertCaller: () => void): void {
    const inputOperationId = `${operationId}:resume-input`;
    const text = message ?? DEFAULT_RESUME_INPUT;
    this.store.transaction(store => {
      store.runOperation({ id: `${operationId}:resume-task`, kind: "partner_task_resume",
        body: { taskId: task.id, childSessionId, callerSessionId, messageHash: message === undefined ? null : hash(message) } }, () => {
        assertCaller();
        const prior = store.findOperation(inputOperationId);
        if (prior?.status === "completed") {
          const body = prior.body as { sessionId?: string; originSessionId?: string; prompt?: PromptInput };
          if (prior.kind !== "service_send_input" || body.sessionId !== childSessionId || body.originSessionId !== callerSessionId
            || body.prompt?.disposition !== "prompt" || body.prompt.text !== text) throw invalid("This input identity belongs to another message.");
          return { sessionId: childSessionId };
        }
        if (task.control !== "paused") throw invalid("Only a confirmed paused task can resume.");
        const open = store.listInteractions({ sessionId: childSessionId, status: "open" });
        if (open.length && message) throw invalid("Resume without input, then answer the pending interaction.");

        const needsInput = Boolean(message) || !open.length && store.countQueueItems({ sessionId: childSessionId, states: ["accepted"] }) === 0;
        // Restore the original pause while the task still owns it. Admit the
        // continuation after the same transaction makes the task active.
        this.host.restorePartnerQueue({ sessionId: childSessionId, operationId,
          ...(task.queuePauseRevision ? { queuePauseRevision: BigInt(task.queuePauseRevision) } : {}) });
        const at = this.now();
        const resumed: PartnerSessionTaskRecord = { ...task, control: "active", deadlineAt: task.deadlineAt + Math.max(0, at - task.pauseAt!),
          pauseAt: undefined, queuePauseRevision: undefined, updatedAt: at };
        this.#save(resumed);
        if (needsInput) this.#enqueue(resumed, inputOperationId, text, "prompt", callerSessionId, { deferDispatch: true });
        return { sessionId: childSessionId };
      });
    });
    const current = this.#read(task.id);
    if (current.control === "active") {
      this.#arm(current);
      this.host.wakePartnerSession(childSessionId);
    }
  }

  stop(sessionId: string, id: string, operationId: string, mode: "cancel" | "pause" | "request-stop", assertCaller: () => void) {
    this.#owned(sessionId, id);
    return this.#serial(id, async () => {
      assertCaller();
      const owned = this.#owned(sessionId, id);
      const prior = this.store.findOperation(operationId);
      if (prior?.kind === CANCEL_OPERATION) {
        const body = prior.body as { taskId: string; sessionId: string; status: CancellationStatus };
        if (mode !== "cancel" || body.taskId !== id || body.sessionId !== owned.sessionId || body.status !== "cancelled") {
          throw invalid("This stop identity belongs to another task control.");
        }
        return this.#reconcile(id);
      }
      const queuePause = mode === "cancel" ? this.store.findOperation(`${operationId}:queue`) : undefined;
      if (queuePause?.kind === "pause_partner_queue") {
        if ((queuePause.body as { sessionId: string }).sessionId !== owned.sessionId) throw invalid("This stop identity belongs to another task.");
        return this.#reconcile(id);
      }
      const task = await this.#reconcile(id); this.#assertTaskSession(task);
      if (!isActive(task.status) && task.status !== "unknown" && task.control === "active") return task;
      if (mode === "request-stop") {
        if (task.control !== "active") return task;
        const claim = this.store.claimDeferredEffectOperation({ id: operationId, kind: "partner_task_stop_request", body: { taskId: id, sessionId: task.sessionId, execution: task.execution } }, () => assertCaller());
        if (!claim.claimed) return this.#reconcile(id);
        try {
          for (const run of this.store.listRuns({ sessionId: task.sessionId!, activeOnly: true, limit: 500 })) {
            if (run.descriptor.state !== "queued") { assertCaller(); await this.host.abort(task.sessionId!, run.descriptor.id); }
          }
          this.store.completeDeferredEffectOperation(operationId, claim.operation.bodyHash, () => ({ requested: true }));
        } catch { throw new PartnerSessionTaskError("STOP_UNCONFIRMED", "The stop request is unconfirmed. Inspect the same execution before another control action."); }
        return this.#reconcile(id);
      }
      if (mode === "cancel") return this.#cancel(task, operationId, "cancelled", assertCaller);
      if (task.control === "cancelling") return task;
      return this.#pause(task, operationId, assertCaller);
    });
  }
  inspectRoute(sessionId: string, id: string) {
    const task = this.#owned(sessionId, id); this.#assertTaskSession(task);
    if (isActive(task.status) || task.status === "unknown" || this.store.countQueueItems({ sessionId: task.sessionId!, states: ["accepted", "dispatching", "backend_accepted", "dispatch_unknown"] }) > 0) throw invalid("Finish or stop this execution before inspecting the next route.");
    const runtime = this.host.getSessionRuntimeControl(task.sessionId!), current = runtime.pending?.profile ?? runtime.effective;
    const session = this.store.getSession(task.sessionId!).descriptor;
    const readings = this.host.getSessionRuntimeUsage(session.id);
    const usage = partnerTaskContextUsage(readings.live, readings.closed, readings.durable);
    const windowOf = (route: PartnerModelRouteRecord) => this.store.getBackend(route.backendId).descriptor.models
      .find(model => model.providerId === route.providerId && model.modelId === route.modelId)?.contextWindow;
    const currentWindow = current ? windowOf(current) : undefined;
    const contextWindow = Math.max(usage.contextWindow ?? 0, currentWindow ?? 0);
    const latest = this.store.listRuns({ sessionId: session.id, limit: 1 })[0]?.descriptor;
    const next = task.explicitModel || task.status !== "failed" || latest?.state !== "failed" ? undefined : suggestPartnerTaskRoute({
      chain: task.routes, current, failure: latest.error, visitedRoutes: runtime.visitedRoutes,
      contextTokens: usage.contextTokens, currentContextWindow: contextWindow > 0 ? contextWindow : null, windowOf,
      available: route => { try { this.#resolveModel(sessionId, route).assertCurrent(); return true; } catch { return false; } }
    });
    const selectionToken = next ? hash(JSON.stringify([task.id, task.execution, runtime.generation, next])) : undefined;
    return { generation: runtime.generation, current, next, selection_token: selectionToken };
  }
  async advanceRoute(sessionId: string, id: string, generation: number, token: string, assertCaller: () => void) {
    return this.#serial(id, async () => {
      assertCaller(); const inspected = this.inspectRoute(sessionId, id);
      if (inspected.generation !== generation || inspected.selection_token !== token || !inspected.next) throw changed();
      const task = this.#owned(sessionId, id); this.#resolveModel(sessionId, inspected.next).assertCurrent();
      const result = await this.host.setSessionRuntimeControl({ sessionId: task.sessionId!, expectedGeneration: generation,
        patch: { backendId: inspected.next.backendId, providerId: inspected.next.providerId, modelId: inspected.next.modelId, ...(inspected.next.effort === undefined ? {} : { effort: inspected.next.effort }), fastMode: inspected.next.fastMode } });
      assertCaller(); return result;
    });
  }
  #holdQueue(task: PartnerSessionTaskRecord, sessionId: string, operationId: string, control: "pausing" | "cancelling") {
    const wasQueuePaused = this.store.getQueueControl(sessionId).paused;
    const held = { ...task, control, pauseAt: task.pauseAt ?? this.now(), updatedAt: this.now() };
    this.#save(held);
    const revision = this.host.preparePartnerPauseQueue({ sessionId, operationId, wasQueuePaused });
    if (revision !== undefined) this.#save({ ...held, queuePauseRevision: revision.toString() });
  }
  async #pause(task: PartnerSessionTaskRecord, operationId: string, assertCurrent: () => void) {
    const { sessionId } = task;
    if (!sessionId) throw invalid("The task Session is unconfirmed.");
    this.store.transaction(() => { assertCurrent(); this.#holdQueue(task, sessionId, operationId, "pausing"); });
    try {
      // Waiting on an exact open decision is already an input boundary. Keep
      // that native resolver alive for a reversible pause instead of dismissing it.
      const waitingOnly = this.store.listInteractions({ sessionId, status: "open", limit: 1 }).length > 0;
      if (!waitingOnly) await this.host.pausePartnerSession({ sessionId, operationId, assertCurrent, pauseGoal: async () => undefined });
      assertCurrent();
      task = { ...this.#read(task.id), control: "paused", status: "waiting", error: undefined, updatedAt: this.now() };
      this.#save(task);
      this.#arm(task);
      return task;
    } catch {
      task = { ...this.#read(task.id), error: STOP_UNCONFIRMED, updatedAt: this.now() };
      this.#save(task);
      return task;
    }
  }
  async #cancel(task: PartnerSessionTaskRecord, operationId: string, status: CancellationStatus, assertCurrent: () => void) {
    const { sessionId, execution } = task;
    if (!sessionId) throw invalid("The task Session is unconfirmed.");
    const receipt = { taskId: task.id, sessionId, execution, status };
    const assertOwner = () => { assertCurrent(); this.#assertTaskSession(task, status === "timed-out"); };
    const claim = this.store.claimDeferredEffectOperation({
      id: operationId, kind: CANCEL_OPERATION, body: receipt
    }, () => {
      assertOwner();
      this.#holdQueue(task, sessionId, operationId, "cancelling");
    });
    if (!claim.claimed) return this.#read(task.id);
    try {
      await this.host.pausePartnerSession({ sessionId, operationId, assertCurrent: assertOwner, pauseGoal: async () => undefined, cancelQueued: true,
        commitStop: () => {
          this.store.completeDeferredEffectOperation(operationId, claim.operation.bodyHash, () => {
            this.#finishCancellation(this.#read(task.id), sessionId, operationId, status);
            return receipt;
          });
        } });
    } catch {
      this.store.transaction(() => {
        this.store.failEffectOperation(operationId, claim.operation.bodyHash, new Error(STOP_UNCONFIRMED));
        this.#save({ ...this.#read(task.id), error: STOP_UNCONFIRMED, updatedAt: this.now() });
      });
      return this.#read(task.id);
    }
    await this.#deliver(this.#read(task.id));
    const settled = this.#read(task.id);
    this.#arm(settled);
    return settled;
  }
  #finishCancellation(task: PartnerSessionTaskRecord, sessionId: string, operationId: string, status: CancellationStatus) {
    this.host.restorePartnerQueue({ sessionId, operationId,
      ...(task.queuePauseRevision ? { queuePauseRevision: BigInt(task.queuePauseRevision) } : {}) });
    this.#save({ ...task, control: "active", status, pauseAt: undefined, queuePauseRevision: undefined,
      error: status === "timed-out" ? "This execution reached its original time budget." : undefined, updatedAt: this.now() });
  }
  #recoverCancellation(task: PartnerSessionTaskRecord, intentRevision: bigint) {
    const { sessionId } = task;
    if (!sessionId) return;
    try { this.#assertTaskSession(task, true); } catch { return; }
    if (this.host.isSessionActive(sessionId) || this.store.listRuns({ sessionId, activeOnly: true, limit: 1 }).length
      || this.store.listQueueItems({ sessionId, states: ["accepted", "dispatching", "backend_accepted", "dispatch_unknown"], limit: 1 }).length) return;
    const aborted = new Set(this.#executionRuns(task).leaves.filter(run => run.state === "aborted").map(run => run.id));
    if (aborted.size === 0) return;
    const generation = this.store.getSession(sessionId).descriptor.binding.generation;
    const deadlineId = `${task.id}:deadline:${task.execution}`;
    // A terminal Run alone could come from an interrupt. The original Host
    // shutdown writes its own Queue cancellation and Run events in one commit.
    let beforeCursor: bigint | undefined;
    for (;;) {
      const events = this.store.listEvents({ sessionId, order: "desc", limit: 100, ...(beforeCursor === undefined ? {} : { beforeCursor }) });
      if (events.length === 0) return;
      for (const event of events) {
        if (event.revision <= intentRevision) return;
        if (event.payload.type !== "run_state" || event.payload.state !== "aborted" || event.generation !== generation
          || event.runId === undefined || !aborted.has(event.runId) || !event.traceId.endsWith(":stopped")) continue;
        const operationId = event.traceId.slice(0, -":stopped".length);
        if (operationId !== deadlineId && !/^partner-task-control:[a-f0-9]{64}$/u.test(operationId)) continue;
        const queue = this.store.findQueueItemByRunId(sessionId, event.runId);
        if (queue?.state !== "cancelled" || queue.revision !== event.revision || queue.operationId !== event.operationId) continue;
        const pause = this.store.findOperation<{ revision?: string }>(`${operationId}:queue`);
        const body = pause?.body as { sessionId: string; wasQueuePaused: boolean } | undefined;
        if (pause?.kind !== "pause_partner_queue" || pause.status !== "completed" || body?.sessionId !== sessionId
          || pause.revision >= event.revision || this.store.findOperation(operationId)) continue;
        if (body.wasQueuePaused === true) {
          if (pause.revision <= intentRevision) continue;
        } else if (body.wasQueuePaused !== false || pause.response?.revision === undefined || pause.response.revision !== task.queuePauseRevision) {
          continue;
        }
        const status = operationId === deadlineId ? "timed-out" : "cancelled";
        const receipt = { taskId: task.id, sessionId, execution: task.execution, status };
        this.store.runOperation({ id: operationId, kind: CANCEL_OPERATION, body: receipt }, () => {
          this.#finishCancellation(task, sessionId, operationId, status);
          return receipt;
        });
        return;
      }
      beforeCursor = events.at(-1)!.globalCursor;
    }
  }
  #enqueue(task: PartnerSessionTaskRecord, operationId: string, text: string, disposition: PromptInput["disposition"] = "prompt",
    callerSessionId = task.parentSessionId, options: { readonly deferDispatch?: true } = {}) {
    this.#assertTaskSession(task);
    this.host.enqueueServiceInput({ operationId, sessionId: task.sessionId!, source: "system", originSessionId: callerSessionId, prompt: prompt(text, disposition), ...options,
      onAdmitted: (_store, receipt) => {
        if (this.#read(task.id).execution !== task.execution) this.#recordTaskReceipt(task);
        this.#save({ ...task, runId: receipt.runId,
          executionRunIds: [...new Set([...task.executionRunIds, receipt.runId])], status: "queued", updatedAt: this.now() });
      } });
    if (options.deferDispatch !== true) this.#arm(this.#read(task.id));
  }
  async #reconcile(id: string): Promise<PartnerSessionTaskRecord> {
    let task = this.#read(id);
    if (this.#closed) return task;
    const interactions = task.sessionId ? this.store.listInteractions({ sessionId: task.sessionId, status: "open" }) : [];
    this.groupPublisher?.synchronizeProgress(task, interactions);
    if (task.group && this.groupPublisher && this.partners.getPartner(task.partnerId).lifecycle === "active") {
      for (const result of await this.groupPublisher.retryEarlierResults(task)) {
        this.#returnGroupPrivate(task, result.id, result.fallbackSessionId);
      }
      task = this.#read(id);
    }
    if (task.status === "unknown" && (!task.sessionId || !task.runId)) { this.#recoverCreation(task); task = this.#read(id); }
    if (task.status === "unknown" && task.runId) {
      const latest = this.#executionRuns(task).leaves.at(-1);
      if (latest && latest.state !== "dispatch_unknown" && latest.error?.stateMayHaveChanged !== true) {
        task = { ...task, status: "queued" }; this.#save(task);
      }
    }
    if (!task.sessionId || task.status === "preparing" || task.status === "unknown") {
      if (task.status === "unknown") this.groupPublisher?.skipProgress(task.id);
      else if (task.group && !isActive(task.status)) await this.#deliver(task);
      else if (!isActive(task.status)) this.#recordTaskReceipt(task, true);
      this.#arm(this.#read(id)); return this.#read(id);
    }
    for (const interaction of interactions) {
      try {
        if (task.group && !task.groupFallback && this.groupPublisher) {
          const delivered = await this.groupPublisher.interaction(task, interaction);
          if (delivered !== "fallback") continue;
          task = { ...task, groupFallback: true }; this.#save(task);
        }
        const profile = this.partners.getPartner(task.partnerId), destination = this.#privateParentId(task, profile);
        if (task.topicOperationId !== undefined && destination === undefined) continue;
        const parent = this.store.getSession(destination ?? task.parentSessionId).descriptor;
        if (profile.lifecycle !== "active" || parent.archived || parent.deletedAt !== undefined) continue;
        this.host.enqueueServiceInput({ operationId: `${task.id}:interaction:${hash(JSON.stringify([interaction.id, interaction.generation]))}`, sessionId: parent.id, source: "system", originSessionId: task.sessionId,
          prompt: prompt(`Your independent task needs a decision. Inspect the exact pending interaction and respond through the task's normal interaction control. Do not start another task or replay its request.\n${redactSecrets(JSON.stringify({ taskId: task.id, sessionId: task.sessionId, interactionId: interaction.id, generation: interaction.generation, interaction: interaction.payload }))}`) });
      } catch { /* The interaction stays visible in its task; it can be returned after the requester recovers. */ }
    }
    if (task.control === "active" && isActive(task.status)) {
      const execution = this.#executionRuns(task), latest = execution.leaves.at(-1);
      const runs = execution.leaves.filter(run => run.state !== "completed" && run.state !== "aborted" && run.state !== "failed");
      const status: PartnerSessionTaskStatus = runs.some(run => run.state === "dispatch_unknown") || latest?.error?.stateMayHaveChanged === true ? "unknown"
        : runs.some(run => run.state === "waiting") ? "waiting" : runs.some(run => run.state === "running" || run.state === "retrying") ? "running"
        : runs.length ? "queued" : latest?.state === "completed" ? "completed" : latest?.state === "aborted" ? "cancelled" : latest?.state === "failed" ? "failed" : task.status;
      if (status !== task.status) {
        task = { ...task, status, updatedAt: this.now(), ...(status === "completed" ? { result: this.#result(task.sessionId!, execution.ids, task.group !== undefined) } : {}),
          ...(status === "failed" ? { error: redactSecrets(latest?.error?.message ?? "The task failed.").slice(0, 4_000) } : {}) };
        this.#save(task);
      }
    }
    if (task.group && !task.groupFallback && this.groupPublisher && isActive(task.status)) {
      if (await this.groupPublisher.running(task) === "fallback") { task = { ...task, groupFallback: true }; this.#save(task); }
    }
    if (task.control !== "active") { this.#arm(task); return task; }
    if (isActive(task.status) && task.deadlineAt <= this.now()) return this.#cancel(task, `${task.id}:deadline:${task.execution}`, "timed-out", () => undefined);
    if (!isActive(task.status) && task.status !== "unknown") await this.#deliver(task); this.#arm(this.#read(id)); return this.#read(id);
  }
  async #deliver(task: PartnerSessionTaskRecord) {
    if (task.deliveredExecution === task.execution) return;
    try {
      const profile = this.partners.getPartner(task.partnerId);
      if (profile.lifecycle !== "active") {
        if (task.sessionId && task.runId) persistSessionTaskActivity(this.store, task.sessionId, { runId: task.runId, completionNotification: "none" });
        return;
      }
      if (!task.group) this.#recordTaskReceipt(task, true);
      const runIds = this.#executionRuns(task).ids;
      if (task.group && !task.groupFallback && this.groupPublisher) {
        const delivered = await this.groupPublisher.terminal(task, runIds);
        if (delivered === "retry") { this.#arm(task); return; }
        if (delivered === "delivered") { this.#save({ ...task, deliveredExecution: task.execution, updatedAt: this.now() }); return; }
        task = { ...task, groupFallback: true }; this.#save(task);
      }
      if (task.group && task.groupFallback && this.groupPublisher) {
        const delivery = this.groupPublisher.privateResult(task, runIds);
        if (delivery.delivered) { this.#save({ ...task, deliveredExecution: task.execution, updatedAt: this.now() }); return; }
        if (delivery.failed) return;
        if (!delivery.ready) { this.#arm(task); return; }
        if (this.#returnGroupPrivate(task, delivery.id, delivery.fallbackSessionId) === "delivered") this.#save({ ...this.#read(task.id), deliveredExecution: task.execution, updatedAt: this.now() });
        return;
      }
      const destination = this.#privateParentId(task, profile);
      const parent = destination === undefined ? undefined : this.store.findSession(destination)?.descriptor;
      if (parent === undefined || parent.archived || parent.deletedAt !== undefined) {
        if (task.sessionId && task.runId) persistSessionTaskActivity(this.store, task.sessionId, { runId: task.runId, completionNotification: "none" });
        return;
      }
      const artifacts = task.sessionId ? this.store.listArtifacts({ sessionId: task.sessionId, runIds, limit: 100 })
        .map(item => ({ id: item.blob.id, name: item.blob.fileName ?? "Artifact", mimeType: item.blob.mimeType })) : [];
      const payload = { taskId: task.id, sessionId: task.sessionId, title: task.title, status: task.status, result: task.result, error: task.error, artifacts };
      this.host.enqueueServiceInput({ operationId: `${task.id}:result:${task.execution}`, sessionId: parent.id, source: "system",
        originSessionId: task.sessionId, prompt: prompt(`Independent task returned. Review its result and present the useful outcome to the user.\n${JSON.stringify(payload)}`),
        onAdmitted: () => this.#save({ ...task, deliveredExecution: task.execution, updatedAt: this.now() }) });
    } catch (error) {
      if (error instanceof NotFoundError && task.sessionId && task.runId) {
        persistSessionTaskActivity(this.store, task.sessionId, { runId: task.runId, completionNotification: "none" });
      }
      // An uncertain admission retains its exact durable return identity.
    }
  }

  #recordTaskReceipt(task: PartnerSessionTaskRecord, includeOutcome = false): void {
    if (task.group) return;
    const profile = this.partners.getPartner(task.partnerId);
    const parent = this.store.findSession(task.parentSessionId)?.descriptor;
    if (parent === undefined || profile.lifecycle !== "active" || this.#privateParentId(task, profile) !== parent.id
      || profile.homeTargetId !== parent.targetId || parent.archived || parent.deletedAt !== undefined
      || !this.store.getTarget(parent.targetId).descriptor.trusted) return;
    const common = { taskId: task.id, execution: task.execution, title: task.title };
    const write = (receipt: PartnerSessionTaskReceipt): void => {
      const phase = receipt.status === "preparing" ? "request" : "outcome";
      const id = `partner-task-receipt:${hash(JSON.stringify([parent.id, task.id, task.execution, phase]))}`;
      this.store.recordPartnerSessionTaskReceipt(id, parent.id, receipt);
    };
    this.store.transaction(() => {
      write({ ...common, status: "preparing" });
      const { status } = task;
      if (includeOutcome && (status === "completed" || status === "failed" || status === "cancelled" || status === "timed-out")) {
        write({ ...common, status, taskSessionId: task.sessionId, result: task.result, error: task.error });
      }
    });
  }
  #returnGroupPrivate(task: PartnerSessionTaskRecord, deliveryId: string, sessionId: string): "delivered" | "retry" | "failed" {
    const assertDestination = () => {
      const profile = this.partners.getPartner(task.partnerId), parent = this.store.getSession(sessionId).descriptor;
      if (profile.lifecycle !== "active" || profile.canonicalSessionId !== sessionId || parent.targetId !== profile.homeTargetId
        || parent.archived || parent.deletedAt !== undefined || !this.store.getTarget(parent.targetId).descriptor.trusted) throw changed();
    };
    const fail = () => this.store.transaction(() => {
      this.groupPublisher!.failPrivate(deliveryId);
      const current = this.#read(task.id);
      this.#save({ ...current, groupDeliveryError: "The original private destination is no longer available. Open the independent task to read its result.", updatedAt: this.now() });
      if (current.sessionId && current.runId) persistSessionTaskActivity(this.store, current.sessionId, { runId: current.runId, completionNotification: "none" });
      return "failed" as const;
    });
    try { assertDestination(); } catch { return fail(); }
    try { this.groupPublisher!.publishPrivate(deliveryId, sessionId, assertDestination); return "delivered"; }
    catch {
      try { assertDestination(); } catch { return fail(); }
      if (this.store.findOperation(`${deliveryId}:private`)?.status === "failed") return fail();
      this.groupPublisher!.deferPrivate(deliveryId); return "retry";
    }
  }
  #executionRuns(task: PartnerSessionTaskRecord): { readonly ids: readonly string[]; readonly leaves: readonly RunDescriptor[] } {
    const ids = new Set<string>(), leaves: RunDescriptor[] = [];
    for (const runId of task.executionRunIds) {
      let run = this.store.getRun(runId).descriptor;
      if (run.sessionId !== task.sessionId) throw changed();
      while (!ids.has(run.id)) {
        ids.add(run.id);
        const next = this.store.findRunByParentId(run.id)?.descriptor;
        // Host recovery and plan continuation retain the original execution.
        // An ordinary retry or follow-up belongs to the user's separate input.
        if (next?.source !== "system" || next.sessionId !== run.sessionId) {
          leaves.push(run);
          break;
        }
        run = next;
      }
    }
    return { ids: [...ids], leaves };
  }
  #result(sessionId: string, runIds: readonly string[], full: boolean) {
    const event = this.store.findLatestAssistantReplyForRuns(sessionId, runIds);
    const text = event?.payload.type === "message_complete" ? redactSecrets(event.payload.blocks.filter(block => block.kind === "text").map(block => block.text).join("\n")) : "";
    return full ? text : text.slice(0, 12_000);
  }
  #recoverCreation(task: PartnerSessionTaskRecord) {
    const creation = this.store.findOperation<{ sessionId: string }>(`${task.id}:create`),
      dispatch = task.execution === 1 ? this.store.findOperation<{ runId: string }>(`${task.id}:input`) : undefined;
    const sessionId = task.sessionId ?? (creation?.status === "completed" ? creation.response?.sessionId : undefined);
    const runId = task.runId ?? (dispatch?.status === "completed" ? dispatch.response?.runId : undefined);
    this.#save({ ...task, ...(sessionId ? { sessionId } : {}), ...(runId ? { runId } : {}),
      executionRunIds: runId === undefined ? task.executionRunIds : [...new Set([...task.executionRunIds, runId])],
      status: sessionId && runId ? "queued" : creation?.status === "started" || dispatch?.status === "started" || uncertain(creation?.error) || uncertain(dispatch?.error) ? "unknown" : "failed", updatedAt: this.now() });
  }
  #arm(task: PartnerSessionTaskRecord) {
    clearTimeout(this.#timers.get(task.id)); this.#timers.delete(task.id);
    if (this.#closed) return;
    const retry = task.group && this.partners.getPartner(task.partnerId).lifecycle === "active" ? this.groupPublisher?.nextAttempt(task.id) : undefined;
    const deadline = isActive(task.status) && task.control === "active" ? task.deadlineAt : undefined;
    const at = deadline === undefined ? retry : retry === undefined ? deadline : Math.min(deadline, retry);
    if (at === undefined) return;
    const timer = setTimeout(() => { this.#timers.delete(task.id); void this.#serial(task.id, () => this.#reconcile(task.id)).catch(() => undefined); }, Math.max(1, at - this.now()));
    timer.unref(); this.#timers.set(task.id, timer);
  }
  #owned(sessionId: string, id: string) {
    const { profile, group, topic } = this.caller(sessionId), task = this.#read(id);
    if (profile.id !== task.partnerId || ((topic !== undefined || task.topicOperationId !== undefined)
      && (topic?.operationId !== task.topicOperationId || task.parentSessionId !== sessionId))
      || group && (task.parentSessionId !== sessionId || !task.group
      || task.group.roomId !== group.roomId || task.group.hostServerId !== group.hostServerId || task.group.actorId !== group.actorId
      || task.group.ownerId !== group.ownerId || task.group.accessRevision !== group.accessRevision || task.group.joinId !== group.joinId))
      throw invalid("Only the requesting Partner and authorized conversation can control this independent task."); return task;
  }
  #privateParentId(task: PartnerSessionTaskRecord, profile: PartnerProfileRecord): string | undefined {
    if (task.topicOperationId === undefined) return profile.canonicalSessionId;
    try {
      const topic = this.partners.independentTaskTopic(task.parentSessionId);
      return topic?.operationId === task.topicOperationId && topic.profile.id === profile.id ? task.parentSessionId : undefined;
    } catch { return undefined; }
  }
  #assertTaskSession(task: PartnerSessionTaskRecord, allowRetiredTopic = false) {
    if (!task.sessionId) throw invalid("The independent task Session is unavailable.");
    const session = this.store.getSession(task.sessionId).descriptor, target = this.store.getTarget(task.targetId).descriptor;
    if (session.targetId !== task.targetId || session.backendId !== task.route.backendId || session.archived || session.deletedAt !== undefined
      || !target.trusted || target.workspaceRoot !== task.realDirectory) throw changed();
    const profile = this.partners.getPartner(task.partnerId), home = this.store.getTarget(profile.homeTargetId).descriptor;
    const requiresParent = !task.group && (!allowRetiredTopic || task.topicOperationId === undefined);
    if (requiresParent && this.#privateParentId(task, profile) !== task.parentSessionId
      || !sameComputer(target, home) || target.remoteWorkspace && !this.remoteProjects?.remote(target)) throw changed();
  }
  async #assertDirectory(task: PartnerSessionTaskRecord) {
    const profile = this.partners.getPartner(task.partnerId), home = this.store.getTarget(profile.homeTargetId).descriptor;
    if (!task.group && this.#privateParentId(task, profile) !== task.parentSessionId) throw changed();
    if (home.remoteWorkspace) {
      if (!this.remoteProjects?.remote(home) || await this.remoteProjects.executionDirectory(home, task.directory, () => {
        const current = this.partners.getPartner(task.partnerId);
        if (current.homeTargetId !== home.id || !task.group && this.#privateParentId(task, current) !== task.parentSessionId) throw changed();
      }) !== task.realDirectory) throw changed();
    } else if (await realpath(task.directory) !== task.realDirectory || !(await stat(task.realDirectory)).isDirectory()) throw changed();
  }
  #queueOrigin(item: QueueItemRecord) { const operation = this.store.getOperation(item.operationId); return operation.kind === "service_send_input" ? (operation.body as { originSessionId?: string }).originSessionId : undefined; }
  #read(id: string) { const record = readRecord(this.store.getSetting("service", SCOPE, id).value); if (record.id !== id) throw changed(); return record; }
  #save(record: PartnerSessionTaskRecord) {
    // Current task JSON uses absent optional fields. The general Store sanitizer
    // intentionally turns explicit undefined into null, so omit them before writing.
    const persisted = readRecord(JSON.parse(JSON.stringify(record)) as unknown);
    this.store.setSetting("service", SCOPE, persisted.id, persisted, this.now()); this.#index(persisted);
    if (persisted.sessionId && persisted.runId) persistSessionTaskActivity(this.store, persisted.sessionId, { runId: persisted.runId,
      completionNotification: persisted.deliveredExecution === persisted.execution ? "teammate" : "pending" });
  }
  #index(record: PartnerSessionTaskRecord) { this.#ids.add(record.id); if (record.sessionId) this.#sessions.set(record.sessionId, record.id); }
  #serial<T>(id: string, callback: () => T | Promise<T>): Promise<T> {
    const result = (this.#locks.get(id) ?? Promise.resolve()).catch(() => undefined).then(callback); this.#locks.set(id, result);
    void result.finally(() => { if (this.#locks.get(id) === result) this.#locks.delete(id); }).catch(() => undefined); return result;
  }
}
function hash(value: string) { return createHash("sha256").update(value).digest("hex"); }
function routeId(route: PartnerModelRouteRecord) { return `task-route:${hash(JSON.stringify([route.backendId, route.providerId, route.modelId]))}`; }
function prompt(text: string, disposition: PromptInput["disposition"] = "prompt"): PromptInput { return { text, images: [], files: [], mentions: [], disposition }; }
function invalid(message: string) { return new PartnerSessionTaskError("TASK_INVALID", message); }
function changed() { return new PartnerSessionTaskError("TASK_CHANGED", "The task owner, directory or runtime changed. Read its current state before continuing."); }
function uncertain(error: unknown) { return typeof error === "object" && error !== null && "stateMayHaveChanged" in error && error.stateMayHaveChanged === true; }
function isActive(status: PartnerSessionTaskStatus) { return (activeStates as readonly string[]).includes(status); }
function bounded(value: unknown, maximum: number, allowEmpty = false): string {
  if (typeof value !== "string" || value.length > maximum || !allowEmpty && !value.trim() || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value) || redactSecrets(value) !== value) throw invalid("Task text is invalid or exceeds its limit."); return value.trim();
}
function normalizeStart(input: StartPartnerSessionTask) {
  const timeoutMs = input.timeoutMs ?? 1_800_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 86_400_000 || input.useWorktree !== undefined && typeof input.useWorktree !== "boolean") throw invalid("Task time budget or worktree selection is invalid.");
  const contextRefs = input.contextRefs ?? []; if (!Array.isArray(contextRefs) || contextRefs.length > 32) throw invalid("Provide at most 32 context references.");
  const modelSelection = input.modelSelection === undefined ? undefined : { id: bounded(input.modelSelection.id, 2048),
    ...(input.modelSelection.effort === undefined ? {} : { effort: bounded(input.modelSelection.effort, 64) }),
    ...(input.modelSelection.fastMode === undefined ? {} : { fastMode: input.modelSelection.fastMode }) };
  if (modelSelection?.fastMode !== undefined && typeof modelSelection.fastMode !== "boolean" && modelSelection.fastMode !== "ultrafast") throw invalid("The model speed is invalid.");
  return { instruction: bounded(input.instruction, 12_000), ...(input.title === undefined ? {} : { title: bounded(input.title, 120) }),
    ...(input.workingDir === undefined ? {} : { workingDir: bounded(input.workingDir, 1_024) }), useWorktree: input.useWorktree ?? false,
    contextRefs: contextRefs.map(value => bounded(value, 512)), timeoutMs, ...(modelSelection ? { modelSelection } : {}) };
}
function readRecord(value: unknown): PartnerSessionTaskRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw changed(); const row = value as Record<string, unknown>;
  const required = ["version", "id", "partnerId", "parentSessionId", "requestFingerprint", "title", "objective", "contextRefs", "targetId", "directory", "realDirectory", "useWorktree", "route", "routes", "explicitModel", "permissionMode", "planMode", "timeoutMs", "deadlineAt", "createdAt", "updatedAt", "execution", "executionRunIds", "status", "control"];
  const optional = ["sessionId", "runId", "pauseAt", "queuePauseRevision", "result", "error", "deliveredExecution", "group", "groupFallback", "groupDeliveryError", "topicOperationId"];
  if (required.some(key => !Object.hasOwn(row, key)) || Object.keys(row).some(key => !required.includes(key) && !optional.includes(key)) || row["version"] !== 1
    || ["id", "partnerId", "parentSessionId", "title", "objective", "targetId", "directory", "realDirectory"].some(key => typeof row[key] !== "string" || !row[key])
    || !/^[a-f0-9]{64}$/u.test(String(row["requestFingerprint"])) || !["preparing", "queued", "running", "waiting", "completed", "failed", "cancelled", "timed-out", "unknown"].includes(String(row["status"]))
    || !["active", "pausing", "paused", "cancelling"].includes(String(row["control"])) || !["ask", "acceptEdits", "auto", "bypassPermissions"].includes(String(row["permissionMode"]))
    || ["useWorktree", "explicitModel", "planMode"].some(key => typeof row[key] !== "boolean")
    || ["timeoutMs", "deadlineAt", "createdAt", "updatedAt", "execution"].some(key => !Number.isSafeInteger(row[key]) || Number(row[key]) < 1)
    || !Array.isArray(row["executionRunIds"]) || row["executionRunIds"].some(id => typeof id !== "string" || id.length < 1 || id.length > 256)
    || new Set(row["executionRunIds"]).size !== row["executionRunIds"].length
    || (typeof row["runId"] === "string" && !row["executionRunIds"].includes(row["runId"]))
    || !Array.isArray(row["contextRefs"]) || row["contextRefs"].length > 32 || row["contextRefs"].some(item => typeof item !== "string" || item.length > 512)
    || !Array.isArray(row["routes"]) || row["routes"].length < 1 || row["routes"].length > 5
    || [row["route"], ...row["routes"]].some(route => !validRoute(route))
    || ["sessionId", "runId", "queuePauseRevision", "result", "error", "groupDeliveryError"].some(key => row[key] !== undefined && typeof row[key] !== "string")
    || ["pauseAt", "deliveredExecution"].some(key => row[key] !== undefined && (!Number.isSafeInteger(row[key]) || Number(row[key]) < 1))
    || row["groupFallback"] !== undefined && row["groupFallback"] !== true) throw changed();
  if (row["topicOperationId"] !== undefined && (typeof row["topicOperationId"] !== "string"
    || row["topicOperationId"].length < 1 || row["topicOperationId"].length > 256 || row["group"] !== undefined)) throw changed();
  if (row["group"] !== undefined) readPartnerSessionTaskGroupOrigin(row["group"]);
  return value as PartnerSessionTaskRecord;
}
function validRoute(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false; const route = value as Record<string, unknown>;
  return Object.keys(route).every(key => ["backendId", "providerId", "modelId", "effort", "fastMode"].includes(key))
    && ["backendId", "providerId", "modelId"].every(key => typeof route[key] === "string" && route[key] !== "") && (typeof route["fastMode"] === "boolean" || route["fastMode"] === "ultrafast") && (route["effort"] === undefined || typeof route["effort"] === "string");
}
