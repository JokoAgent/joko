import { clone, equals } from "@bufbuild/protobuf";
import type { Client } from "@connectrpc/connect";
import { CollaborationGoalStatus, CollaborationGoalTreeSchema, CollaborationWorkerSchema, CollaborationSessionRole, CollaborationWorkerStatus, PermissionMode,
  type CollaborationGoal, type CollaborationGoalAccess, type CollaborationGoalTree, type CollaborationSettings, type CollaborationService,
  type CollaborationWorker, type CollaborationReportOrigin } from "@joko/contracts";
import type { MobileModelControlSelection, MobileModelRoute } from "./mobile-runtime-controls";
import { resolveMobileNewTaskDefaultModelAuthority, resolveMobileNewTaskExecutionAuthority } from "./mobile-runtime-controls";
import { TargetState, type Snapshot } from "@joko/contracts";

export const mobileWorkerRoles = ["developer", "designer", "reviewer", "tester", "merger"] as const;
export interface MobileWorkerForm {
  readonly sourceScope?: string;
  readonly role: string;
  readonly targetId: string;
  readonly model?: MobileModelControlSelection;
  readonly permissionMode: PermissionMode;
  readonly initialTask: string;
}
export interface MobileWorkerTarget {
  readonly id: string;
  readonly name: string;
  readonly backendId: string;
  readonly backendName: string;
  readonly models: readonly MobileModelRoute[];
  readonly defaultModel?: MobileModelControlSelection;
  readonly permissionModes: readonly PermissionMode[];
  readonly canSetEffort: boolean;
  readonly canSetFastMode: boolean;
}
export interface MobileCollaborationView {
  readonly role: "ordinary" | "lead" | "worker";
  readonly tree?: CollaborationGoalTree;
  readonly self?: CollaborationWorker;
  readonly settings?: CollaborationSettings;
}
export interface MobileCollaborationApi {
  readonly ownerKey: string;
  readonly sessionId: string;
  readonly generation: bigint;
  readonly profileId: string;
  readonly writable: boolean;
  readonly targets: readonly MobileWorkerTarget[];
  readonly initialTargetId: string;
  restore(signal: AbortSignal): Promise<MobileWorkerForm | undefined>;
  load(signal: AbortSignal): Promise<MobileCollaborationView>;
  enable(form: MobileWorkerForm, signal: AbortSignal): Promise<MobileCollaborationView>;
  create(view: MobileCollaborationView, form: MobileWorkerForm, signal: AbortSignal): Promise<MobileCollaborationView>;
  archive(view: MobileCollaborationView, worker: CollaborationWorker, signal: AbortSignal): Promise<MobileCollaborationView>;
  end(view: MobileCollaborationView, signal: AbortSignal): Promise<MobileCollaborationView>;
  openWorker(view: MobileCollaborationView, worker: CollaborationWorker, signal: AbortSignal): Promise<void>;
  openLead(view: MobileCollaborationView, signal: AbortSignal): Promise<void>;
  resolveReport(origin: CollaborationReportOrigin, signal: AbortSignal): Promise<string>;
}

export function mobileWorkerTargets(owner: Snapshot | undefined): readonly MobileWorkerTarget[] {
  if (!owner) return [];
  return owner.targets.flatMap(target => {
    if (target.state !== TargetState.ACTIVE) return [];
    const authority = resolveMobileNewTaskExecutionAuthority(owner, target.backendId);
    if (!authority) return [];
    return [{ id: target.targetId, name: target.displayName || target.targetId, backendId: target.backendId,
      backendName: authority.backend.displayName || target.backendId, models: authority.canSelectModel ? authority.models : [],
      defaultModel: resolveMobileNewTaskDefaultModelAuthority(owner, target.backendId)?.selection,
      permissionModes: authority.permissionModes, canSetEffort: authority.canSetEffort, canSetFastMode: authority.canSetFastMode }];
  });
}

export function mobileWorkerInitialTask(initialTask: string, pendingLeadInput: string): string {
  const task = initialTask.trim(), context = pendingLeadInput.trim();
  if (!task || !context) return task;
  return `${task}\n\nPending Lead input:\nThe Lead has not sent this input yet, so it is not available in Lead session history. Use it only as context for the Worker task above; do not treat it as a replacement task.\n${context}`;
}
export interface MobileCollaborationRpc {
  list(signal: AbortSignal): Promise<readonly CollaborationGoalAccess[]>;
  get(goalId: string, signal: AbortSignal): Promise<CollaborationGoalTree>;
  createGoal(id: string, title: string, objective: string, signal: AbortSignal): Promise<CollaborationGoalTree>;
  createWorker(goal: CollaborationGoal, form: MobileWorkerForm, label: string, id: string, signal: AbortSignal): Promise<CollaborationGoalTree>;
  archive(goal: CollaborationGoal, worker: CollaborationWorker, id: string, signal: AbortSignal): Promise<CollaborationGoalTree>;
  release(goal: CollaborationGoal, worker: CollaborationWorker, id: string, signal: AbortSignal): Promise<CollaborationGoalTree>;
  end(goal: CollaborationGoal, id: string, signal: AbortSignal): Promise<CollaborationGoalTree>;
}

export function normalizeMobileWorkerForm(value: MobileWorkerForm): MobileWorkerForm {
  if (!value || typeof value.role !== "string" || !text(value.role.trim(), 32) || !identity(value.targetId) || typeof value.initialTask !== "string"
    || value.initialTask.includes("\0") || [...value.initialTask.trim()].length > 32_000
    || ![PermissionMode.ASK, PermissionMode.ACCEPT_EDITS, PermissionMode.AUTO, PermissionMode.BYPASS_PERMISSIONS].includes(value.permissionMode)) {
    throw new Error("Review the worker role, route and initial task.");
  }
  if (value.sourceScope !== undefined && (typeof value.sourceScope !== "string" || !value.sourceScope || value.sourceScope.length > 64_000 || value.sourceScope.includes("\0"))) throw new Error("The confirmed collaboration source is invalid.");
  if (value.model && (!identity(value.model.providerId) || !identity(value.model.modelId)
    || value.model.effortId !== undefined && !identity(value.model.effortId) || typeof value.model.fastMode !== "boolean")) {
    throw new Error("The selected worker model is invalid.");
  }
  return { role: value.role.trim(), targetId: value.targetId, permissionMode: value.permissionMode,
    initialTask: value.initialTask.trim(), ...(value.model === undefined ? {} : { model: { ...value.model } }), ...(value.sourceScope ? { sourceScope: value.sourceScope } : {}) };
}

export function mobileWorkerLabel(role: string, workers: readonly CollaborationWorker[]): string {
  const base = role.trim().slice(0, 32), used = new Set(workers.map(worker => worker.label.toLowerCase()));
  if (!used.has(base.toLowerCase())) return base;
  for (let suffix = 2; suffix <= 10_000; suffix++) { const label = `${base}-${suffix}`; if (!used.has(label.toLowerCase())) return label; }
  throw new Error("No worker label is available in this team.");
}

export function projectMobileCollaborationTree(value: CollaborationGoalTree | undefined, expectedGoalId: string, viewerSessionId: string): CollaborationGoalTree {
  const goal = value?.goal;
  if (!value || !goal || goal.goalId !== expectedGoalId || !identity(goal.goalId) || !identity(goal.leadId)
    || !identity(goal.leadSessionId) || !identity(goal.backendId) || !identity(goal.targetId)
    || !text(goal.title, 256) || !text(goal.objective, 32_000) || !revision(goal.revision)
    || !generation(goal.sessionGeneration) || !generation(goal.backendInstanceGeneration)
    || ![CollaborationGoalStatus.ACTIVE, CollaborationGoalStatus.COMPLETED, CollaborationGoalStatus.STOPPED, CollaborationGoalStatus.FAILED, CollaborationGoalStatus.ARCHIVED].includes(goal.status)
    || goal.maximumWorkers !== undefined && (!Number.isInteger(goal.maximumWorkers) || goal.maximumWorkers < 1 || goal.maximumWorkers > 128)
    || !times(goal.createdAt, goal.updatedAt) || (goal.status === CollaborationGoalStatus.ACTIVE) !== (goal.completedAt === undefined)
    || goal.completedAt !== undefined && timestamp(goal.completedAt) < timestamp(goal.createdAt)
    || value.workers.length > 10_000 || value.queue.length > 100_000) throw new Error("The collaboration Goal is invalid.");
  const ids = new Map<string, CollaborationWorker>(), sessions = new Set<string>();
  for (const worker of value.workers) {
    const route = worker.route;
    if (!identity(worker.workerId) || ids.has(worker.workerId) || worker.goalId !== goal.goalId || !route
      || !revision(worker.revision) || !text(worker.label, 64) || !text(worker.role, 128)
      || worker.assignment !== "" && !text(worker.assignment, 32_000) || !identity(route.backendId) || !identity(route.targetId)
      || (route.providerId === undefined) !== (route.modelId === undefined)
      || route.providerId !== undefined && !identity(route.providerId) || route.modelId !== undefined && !identity(route.modelId)
      || route.effort !== undefined && !identity(route.effort)
      || ![PermissionMode.ASK, PermissionMode.ACCEPT_EDITS, PermissionMode.AUTO, PermissionMode.BYPASS_PERMISSIONS].includes(route.permissionMode)
      || (worker.sessionId === undefined) !== (worker.sessionGeneration === undefined)
      || (worker.sessionId === undefined) !== (worker.backendInstanceGeneration === undefined)
      || worker.sessionId !== undefined && (!identity(worker.sessionId) || sessions.has(worker.sessionId) || worker.sessionId === goal.leadSessionId)
      || worker.sessionGeneration !== undefined && !generation(worker.sessionGeneration)
      || worker.backendInstanceGeneration !== undefined && !generation(worker.backendInstanceGeneration)
      || ![CollaborationWorkerStatus.PROVISIONING, CollaborationWorkerStatus.IDLE, CollaborationWorkerStatus.QUEUED,
        CollaborationWorkerStatus.RUNNING, CollaborationWorkerStatus.COMPLETED, CollaborationWorkerStatus.FAILED,
        CollaborationWorkerStatus.STOPPING, CollaborationWorkerStatus.STOPPED, CollaborationWorkerStatus.DISPATCH_UNKNOWN,
        CollaborationWorkerStatus.ARCHIVED].includes(worker.status) || !times(worker.createdAt, worker.updatedAt)
      || worker.runtimeReleased && ![CollaborationWorkerStatus.IDLE, CollaborationWorkerStatus.COMPLETED, CollaborationWorkerStatus.FAILED, CollaborationWorkerStatus.STOPPED, CollaborationWorkerStatus.ARCHIVED].includes(worker.status)
      || [CollaborationWorkerStatus.STOPPED, CollaborationWorkerStatus.ARCHIVED].includes(worker.status) && !worker.runtimeReleased
      || worker.focused && (worker.runtimeReleased || [CollaborationWorkerStatus.FAILED, CollaborationWorkerStatus.STOPPED, CollaborationWorkerStatus.ARCHIVED].includes(worker.status))) {
      throw new Error("The collaboration worker is invalid.");
    }
    ids.set(worker.workerId, worker); if (worker.sessionId) sessions.add(worker.sessionId);
  }
  for (const worker of value.workers) {
    const seen = new Set([worker.workerId]); let parent = worker.parentWorkerId;
    while (parent !== undefined) {
      if (seen.has(parent) || !ids.has(parent)) throw new Error("The collaboration worker tree has an invalid parent.");
      seen.add(parent); parent = ids.get(parent)!.parentWorkerId;
    }
  }
  if (goal.leadSessionId !== viewerSessionId && !value.workers.some(worker => worker.sessionId === viewerSessionId)) throw new Error("The collaboration belongs to another task.");
  const focused = value.workers.filter(worker => worker.focused);
  if (value.focusedWorkerId === undefined ? focused.length !== 0 : focused.length !== 1 || focused[0]!.workerId !== value.focusedWorkerId) throw new Error("The collaboration focus is invalid.");
  for (const entry of value.queue) {
    const dispatch = entry.dispatch, worker = dispatch && ids.get(dispatch.workerId);
    if (!dispatch || !worker || dispatch.goalId !== goal.goalId || dispatch.callerLeadSessionId !== goal.leadSessionId
      || !identity(dispatch.dispatchId) || !revision(dispatch.revision) || !text(dispatch.message, 32_000)
      || entry.queueItem !== undefined && (entry.queueItem.queueItemId !== dispatch.queueItemId || entry.queueItem.sessionId !== worker.sessionId
        || entry.queueItem.backendId !== worker.route!.backendId || entry.queueItem.targetId !== worker.route!.targetId)) {
      throw new Error("The collaboration Queue belongs to another worker.");
    }
  }
  return clone(CollaborationGoalTreeSchema, value);
}

export function createMobileCollaborationRpc(rpc: Client<typeof CollaborationService>, sessionId: string, sessionGeneration: bigint,
  assertCurrent: (signal: AbortSignal) => void): MobileCollaborationRpc {
  const tree = (value: CollaborationGoalTree | undefined, goalId: string, signal: AbortSignal) => {
    assertCurrent(signal); return projectMobileCollaborationTree(value, goalId, sessionId);
  };
  const lead = (goal: CollaborationGoal, signal: AbortSignal) => { assertCurrent(signal);
    if (!identity(goal.goalId) || !revision(goal.revision)) throw new Error("Select a current collaboration Goal.");
    return { goalId: goal.goalId, callerLeadSessionId: goal.leadSessionId };
  };
  const ownedWorker = (goal: CollaborationGoal, worker: CollaborationWorker, signal: AbortSignal) => {
    const scope = lead(goal, signal);
    if (worker.goalId !== goal.goalId || !identity(worker.workerId) || !revision(worker.revision)) throw new Error("Select a current worker from this Goal.");
    return { ...scope, workerId: worker.workerId, expectedRevision: worker.revision };
  };
  return {
    async list(signal) {
      assertCurrent(signal); const response = await rpc.listCollaborationGoals({ sessionId, includeArchived: true }, { signal }); assertCurrent(signal);
      const ids = new Set<string>();
      for (const access of response.access) {
        const goal = access.goal;
        if (!goal || !identity(goal.goalId) || ids.has(goal.goalId)
          || access.role === CollaborationSessionRole.LEAD && (goal.leadSessionId !== sessionId || access.workerId !== undefined)
          || access.role === CollaborationSessionRole.WORKER && (goal.leadSessionId === sessionId || !identity(access.workerId))
          || ![CollaborationSessionRole.LEAD, CollaborationSessionRole.WORKER].includes(access.role)) throw new Error("The collaboration access is invalid.");
        ids.add(goal.goalId);
      }
      if (response.access.some(access => access.role === CollaborationSessionRole.WORKER) && response.access.length !== 1) throw new Error("The collaboration roles conflict.");
      return response.access;
    },
    async get(goalId, signal) { assertCurrent(signal); return tree((await rpc.getCollaborationGoal({ goalId, viewerSessionId: sessionId }, { signal })).tree, goalId, signal); },
    async createGoal(id, title, objective, signal) {
      assertCurrent(signal);
      const value = (await rpc.createCollaborationGoal({ operationId: id, leadSessionId: sessionId, expectedSessionGeneration: sessionGeneration, title, objective }, { signal })).tree;
      const result = tree(value, value?.goal?.goalId ?? "", signal);
      if (result.goal!.leadSessionId !== sessionId || result.goal!.sessionGeneration !== sessionGeneration || result.goal!.title !== title || result.goal!.objective !== objective) throw new Error("The collaboration creation returned another Goal.");
      return result;
    },
    async createWorker(goal, form, label, id, signal) {
      const scope = lead(goal, signal), exact = normalizeMobileWorkerForm(form);
      const response = await rpc.createCollaborationWorker({ ...scope, operationId: id, expectedGoalRevision: goal.revision,
        label, role: exact.role, assignment: exact.initialTask, targetId: exact.targetId, permissionMode: exact.permissionMode, planMode: false,
        ...(exact.model === undefined ? {} : { providerId: exact.model.providerId, modelId: exact.model.modelId,
          effort: exact.model.effortId, fastMode: exact.model.fastMode }) }, { signal });
      const result = tree(response.tree, goal.goalId, signal), worker = response.worker;
      if (!worker || worker.goalId !== goal.goalId || worker.label !== label || worker.role !== exact.role || worker.assignment !== exact.initialTask
        || worker.route?.targetId !== exact.targetId || worker.route.permissionMode !== exact.permissionMode || worker.route.planMode
        || exact.model !== undefined && (worker.route.providerId !== exact.model.providerId || worker.route.modelId !== exact.model.modelId
          || worker.route.effort !== exact.model.effortId || worker.route.fastMode !== exact.model.fastMode)
        || !result.workers.some(candidate => candidate.workerId === worker.workerId && equals(CollaborationWorkerSchema, candidate, worker))) throw new Error("The created worker does not match the requested role and route.");
      return result;
    },
    async archive(goal, worker, id, signal) {
      const response = await rpc.archiveCollaborationWorker({ ...ownedWorker(goal, worker, signal), operationId: id }, { signal });
      const result = tree(response.tree, goal.goalId, signal);
      if (!result.workers.some(candidate => candidate.workerId === worker.workerId && candidate.status === CollaborationWorkerStatus.ARCHIVED && candidate.runtimeReleased)) throw new Error("The worker archive could not be confirmed.");
      return result;
    },
    async release(goal, worker, id, signal) {
      if (worker.status !== CollaborationWorkerStatus.COMPLETED || worker.runtimeReleased || worker.sessionGeneration === undefined) throw new Error("Only the displayed completed worker can be acknowledged.");
      const response = await rpc.releaseCollaborationWorker({ ...ownedWorker(goal, worker, signal), expectedSessionGeneration: worker.sessionGeneration, operationId: id }, { signal });
      const result = tree(response.tree, goal.goalId, signal);
      if (!result.workers.some(candidate => candidate.workerId === worker.workerId && candidate.runtimeReleased)) throw new Error("The completed worker release could not be confirmed.");
      return result;
    },
    async end(goal, id, signal) {
      const response = await rpc.setCollaborationGoalStatus({ ...lead(goal, signal), operationId: id, expectedRevision: goal.revision, status: CollaborationGoalStatus.STOPPED }, { signal });
      const result = tree(response.tree, goal.goalId, signal);
      if (result.goal!.status !== CollaborationGoalStatus.STOPPED) throw new Error("The collaboration stop could not be confirmed.");
      return result;
    }
  };
}

function identity(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 1_024 && value === value.trim() && !/[\u0000-\u001f\u007f]/u.test(value); }
function text(value: unknown, maximum: number): value is string { return typeof value === "string" && !!value.trim() && value.trim() === value && !value.includes("\0") && [...value].length <= maximum; }
function revision(value: { value: bigint } | undefined): boolean { return value !== undefined && value.value >= 1n; }
function generation(value: bigint): boolean { return value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER); }
function timestamp(value: { seconds: bigint; nanos: number } | undefined): number {
  if (!value || value.seconds < 0n
    || !Number.isInteger(value.nanos) || value.nanos < 0 || value.nanos >= 1_000_000_000 || value.nanos % 1_000_000 !== 0) throw new Error("The collaboration timestamp is invalid.");
  const time = value.seconds * 1_000n + BigInt(value.nanos / 1_000_000);
  if (time > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("The collaboration timestamp is invalid.");
  return Number(time);
}
function times(created: { seconds: bigint; nanos: number } | undefined, updated: { seconds: bigint; nanos: number } | undefined): boolean { return timestamp(updated) >= timestamp(created); }
