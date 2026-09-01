import { randomUUID } from "node:crypto";

import type {
  BackendSnapshotScope,
  OwnerSnapshotScope,
  ScheduleSnapshotScope,
  ServerInfo,
  SessionSnapshotScope,
  Snapshot,
  SnapshotScope,
  TargetSnapshotScope,
  ToolSnapshotScope,
  WorkspaceSnapshotScope
} from "@joko/contracts";
import { NATIVE_HISTORY_REPLACES_TRANSIENT_FIELD, nativeHistoryEventContext } from "@joko/core";
import {
  NotFoundError,
  type OperationRecord,
  type OperationalSnapshot,
  type OperationalStore,
  type PersistedEvent,
  type QueueItemRecord,
  type SessionSnapshot,
  type StoredBackend,
  type StoredRun,
  type StoredSession,
  type StoredTarget
} from "@joko/store";

import {
  ProtoMappingError,
  toProtoArtifact,
  toProtoBackend,
  toProtoConnection,
  toProtoEvent,
  toProtoEventCursor,
  toProtoExtensionStatus,
  toProtoExtensionWidget,
  toProtoExtraDirectory,
  toProtoInteraction,
  toProtoModelDescriptor,
  toProtoProviderDescriptor,
  toProtoOperation,
  toProtoQueueItem,
  toProtoQueueControl,
  toProtoRevision,
  toProtoRuntimeCommand,
  toProtoRun,
  toProtoSchedule,
  toProtoSession,
  toProtoTarget,
  toProtoTimestamp,
  toProtoToolLease,
  toProtoWorkspace,
  type EventMappingContext,
  type SessionMappingContext
} from "./proto-mapper.js";
import { ExtraDirectoryManager } from "./extra-directory-manager.js";
import {
  EXTENSION_STATUSES_SETTING_KEY,
  EXTENSION_WIDGETS_SETTING_KEY,
  readExtensionStatuses,
  readExtensionWidgets
} from "./extension-ui-state.js";
import { materializedSessionRuntimeState, SESSION_RUNTIME_STATE_SETTING_KEY } from "./session-runtime-state.js";
import { readSessionCodeHostReferences } from "./session-code-host-context.js";
import {
  materializedNativeStateObservation,
  nativeBindingFingerprint,
  nativeStateObservationIsCurrent,
  SESSION_NATIVE_STATE_OBSERVATION_SETTING_KEY
} from "./native-state-observation.js";
import { NATIVE_HISTORY_BINDING_FINGERPRINT_FIELD } from "./native-history.js";
import { materializedRuntimeCommands, SESSION_RUNTIME_COMMANDS_SETTING_KEY } from "./runtime-command-state.js";

type ProtoMessage = { readonly $typeName: string };
const SNAPSHOT_SCAN_PAGE_SIZE = 10_000;

function scanStorePages<T>(read: (offset: number, limit: number) => readonly T[]): T[] {
  const values: T[] = [];
  for (;;) {
    const page = read(values.length, SNAPSHOT_SCAN_PAGE_SIZE);
    values.push(...page);
    if (page.length < SNAPSHOT_SCAN_PAGE_SIZE) return values;
  }
}

/** Per-Provider authority supplied by the live provisioning catalog. */
export interface SnapshotProviderCatalogEntry {
  readonly provider: Snapshot["providers"][number];
  /** Whether models owned by this Provider can be selected with its current authentication state. */
  readonly available: boolean;
}

export interface SnapshotProjectorOptions {
  /** Server identity placed in every snapshot. A factory can refresh server_time per request. */
  readonly server: ServerInfo | (() => ServerInfo);
  readonly now?: () => number;
  readonly idFactory?: () => string;
  /** Internal SQLite event scan page size; it does not change the requested timeline length. */
  readonly timelinePageSize?: number;
  /** Optional live Provider/auth projection. Built-in models remain durable Backend inventory. */
  readonly providerCatalog?: () => readonly SnapshotProviderCatalogEntry[];
  /** Adapter-composition defaults used only when a current native observation omits them. */
  readonly resolveSessionContextDefaults?: (session: {
    readonly sessionId: string;
    readonly backendId: string;
    readonly targetId: string;
  }) => {
    readonly autoCompaction?: boolean;
    readonly autoRetry?: boolean;
  } | undefined;
  /** Volatile native runtime selection, when it differs from the durable baseline. */
  readonly resolveSessionRuntimeModel?: (session: {
    readonly sessionId: string;
    readonly backendId: string;
    readonly targetId: string;
  }) => SessionMappingContext["runtimeModel"];
}

export interface SessionProjectionContextOptions {
  readonly activeRun?: StoredRun;
  readonly runtimeAttached?: boolean;
  readonly resolveContextDefaults?: SnapshotProjectorOptions["resolveSessionContextDefaults"];
  readonly runtimeModel?: SessionMappingContext["runtimeModel"];
}

/**
 * Builds the single Backend-neutral join used by snapshots, Session RPCs, and
 * session_changed Events. Values absent from this context are deliberately
 * unproven and therefore clear the corresponding protobuf projection fields.
 */
export function sessionProjectionContext(
  store: OperationalStore,
  session: StoredSession,
  options: SessionProjectionContextOptions = {}
): SessionMappingContext {
  const runtimeState = materializedSessionRuntimeState(store.findSetting(
    "session",
    session.descriptor.id,
    SESSION_RUNTIME_STATE_SETTING_KEY
  )?.value);
  const nativeObservation = materializedNativeStateObservation(store.findSetting(
    "session",
    session.descriptor.id,
    SESSION_NATIVE_STATE_OBSERVATION_SETTING_KEY
  )?.value);
  const observedContextState = nativeObservation !== undefined && nativeStateObservationIsCurrent(
    nativeObservation,
    session.descriptor.binding.generation,
    session.descriptor.binding.opaqueRef
  ) ? nativeObservation.state : undefined;
  const defaults = options.resolveContextDefaults?.({
    sessionId: session.descriptor.id,
    backendId: session.descriptor.backendId,
    targetId: session.descriptor.targetId
  });
  const autoCompaction = observedContextState?.autoCompaction ?? defaults?.autoCompaction;
  const autoRetry = observedContextState?.autoRetry ?? defaults?.autoRetry;
  const contextState = observedContextState === undefined && autoCompaction === undefined && autoRetry === undefined
    ? undefined
    : {
        ...(observedContextState === undefined ? {} : { compacting: observedContextState.compacting }),
        ...(autoCompaction === undefined ? {} : { autoCompaction }),
        ...(autoRetry === undefined ? {} : { autoRetry })
      };
  return {
    ...(options.activeRun === undefined ? {} : { activeRun: options.activeRun }),
    ...(options.runtimeAttached === undefined ? {} : { runtimeAttached: options.runtimeAttached }),
    ...(options.runtimeModel === undefined ? {} : { runtimeModel: options.runtimeModel }),
    ...(runtimeState?.usage === undefined ? {} : {
      usage: runtimeState.usage,
      usageMeasuredAt: runtimeState.updatedAt
    }),
    ...(runtimeState?.activeNativeEntryId === undefined
      ? {}
      : { activeNativeEntryId: runtimeState.activeNativeEntryId }),
    ...(session.descriptor.derivationOrigin === undefined
      ? {}
      : {
          derivationOriginAvailability: sessionDerivationOriginAvailability(store, session)
        }),
    codeHostPullRequests: readSessionCodeHostReferences(store, session.descriptor.id),
    ...(contextState === undefined ? {} : { contextState })
  };
}

function sessionDerivationOriginAvailability(
  store: OperationalStore,
  session: StoredSession
): NonNullable<SessionMappingContext["derivationOriginAvailability"]> {
  const origin = session.descriptor.derivationOrigin;
  if (origin === undefined) return { sourceSessionAvailable: false, sourceMessageAvailable: false };
  let source: StoredSession;
  try {
    source = store.getSession(origin.sourceSessionId);
  } catch (error) {
    if (error instanceof NotFoundError) {
      return { sourceSessionAvailable: false, sourceMessageAvailable: false };
    }
    throw error;
  }
  const sourceSessionAvailable = !source.descriptor.archived && source.descriptor.deletedAt === undefined;
  if (
    !sourceSessionAvailable
    || origin.sourceMessageId === undefined
    || origin.sourceEventId === undefined
  ) {
    return { sourceSessionAvailable, sourceMessageAvailable: false };
  }
  const visible = store.findVisibleSessionMessageOrigin({
    sessionId: origin.sourceSessionId,
    eventId: origin.sourceEventId
  });
  return {
    sourceSessionAvailable,
    sourceMessageAvailable: visible?.messageId === origin.sourceMessageId
  };
}

export interface SessionSnapshotRequest {
  readonly sessionId: string;
  readonly recentTimelineItems?: number;
}

/**
 * Projects durable product state into self-consistent protobuf snapshots.
 *
 * The Backend-native conversation/tree is deliberately absent. SQLite is authority for
 * product entities and the durable event timeline, never a source from which to
 * reconstruct a Backend's in-memory/native context.
 */
export class SnapshotProjector {
  private readonly now: () => number;
  private readonly idFactory: () => string;
  private readonly timelinePageSize: number;
  private readonly extraDirectories: ExtraDirectoryManager;

  constructor(
    private readonly store: OperationalStore,
    private readonly options: SnapshotProjectorOptions
  ) {
    this.now = options.now ?? Date.now;
    this.idFactory = options.idFactory ?? randomUUID;
    const pageSize = options.timelinePageSize ?? 1_000;
    if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 1_000) {
      throw new ProtoMappingError(
        "out_of_range",
        "snapshot.timeline_page_size",
        "Timeline page size must be an integer between 1 and 1000."
      );
    }
    this.timelinePageSize = pageSize;
    this.extraDirectories = new ExtraDirectoryManager(store);
  }

  project(scope: SnapshotScope): Snapshot {
    switch (scope.kind.case) {
      case "owner": return this.projectOwnerSnapshot();
      case "backend": return this.projectBackendSnapshot(scope.kind.value.backendId);
      case "target": return this.projectTargetSnapshot(scope.kind.value.targetId);
      case "session": return this.projectSessionSnapshot({
        sessionId: scope.kind.value.sessionId,
        recentTimelineItems: scope.kind.value.recentTimelineItems
      });
      case "workspace": return this.projectWorkspaceSnapshot(scope.kind.value.workspaceId);
      case "schedule": return this.projectScheduleSnapshot(scope.kind.value.scheduleId);
      case "tool": return this.projectToolSnapshot(scope.kind.value.toolProviderId);
      case undefined:
        throw new ProtoMappingError("invalid_argument", "snapshot.scope.kind", "Snapshot scope is required.");
    }
  }

  projectOwnerSnapshot(): Snapshot {
    const createdAt = this.now();
    return this.store.transaction((store) => {
      // The public store transaction is the consistency boundary for the base
      // snapshot plus entity lists not exposed by OperationalSnapshot.
      const base = store.getSnapshot(createdAt);
      const visibleSessionIds = new Set(base.sessions.map((session) => session.descriptor.id));
      const runs = scanStorePages((offset, limit) => store.listRuns({ limit, offset }))
        .filter((run) => visibleSessionIds.has(run.descriptor.sessionId));
      const visibleRunIds = new Set(runs.map((run) => run.descriptor.id));
      const queueItems = scanStorePages((offset, limit) => store.listQueueItems({ limit, offset }))
        .filter((item) => visibleSessionIds.has(item.sessionId) && visibleRunIds.has(item.runId));
      const schedules = store.listSchedules()
        .filter((schedule) => schedule.sessionId === undefined || visibleSessionIds.has(schedule.sessionId));
      const interactions = scanStorePages((offset, limit) => store.listInteractions({ limit, offset }))
        .filter((interaction) => visibleSessionIds.has(interaction.sessionId));
      const artifacts = scanStorePages((offset, limit) => store.listArtifacts({ limit, offset }));
      const toolLeases = store.listToolLeases()
        .filter((lease) => visibleSessionIds.has(lease.sessionId));
      const operations = scanStorePages((offset, limit) => store.listOperations({ limit, offset }));
      const scope = proto<SnapshotScope>("joko.v1.SnapshotScope", {
        kind: {
          case: "owner",
          value: proto<OwnerSnapshotScope>("joko.v1.OwnerSnapshotScope", {})
        }
      });
      return this.buildSnapshot({
        scope,
        revision: base.revision,
        cursor: base.globalCursor,
        generation: 0,
        createdAt,
        connections: base.connections.map(toProtoConnection),
        backends: base.backends,
        targets: base.targets,
        sessions: base.sessions,
        runs,
        queueItems,
        schedules,
        interactions,
        artifacts,
        toolLeases,
        operations,
        workspaces: base.targets.map(toProtoWorkspace),
        timeline: [],
        base
      });
    });
  }

  projectBackendSnapshot(backendId: string): Snapshot {
    requireScopeIdentifier(backendId, "snapshot.backend_id");
    const scope = proto<SnapshotScope>("joko.v1.SnapshotScope", {
      kind: {
        case: "backend",
        value: proto<BackendSnapshotScope>("joko.v1.BackendSnapshotScope", { backendId })
      }
    });
    return this.projectFilteredSnapshot(scope, (store, base) => {
      store.getBackend(backendId);
      const targetIds = new Set(base.targets
        .filter((target) => target.descriptor.backendId === backendId)
        .map((target) => target.descriptor.id));
      const sessionIds = new Set(base.sessions
        .filter((session) => session.descriptor.backendId === backendId)
        .map((session) => session.descriptor.id));
      return { backendIds: new Set([backendId]), targetIds, sessionIds };
    });
  }

  projectTargetSnapshot(targetId: string): Snapshot {
    requireScopeIdentifier(targetId, "snapshot.target_id");
    const scope = proto<SnapshotScope>("joko.v1.SnapshotScope", {
      kind: {
        case: "target",
        value: proto<TargetSnapshotScope>("joko.v1.TargetSnapshotScope", { targetId })
      }
    });
    return this.projectFilteredSnapshot(scope, (store, base) => {
      const target = store.getTarget(targetId);
      const sessionIds = new Set(base.sessions
        .filter((session) => session.descriptor.targetId === targetId)
        .map((session) => session.descriptor.id));
      return {
        backendIds: new Set([target.descriptor.backendId]),
        targetIds: new Set([targetId]),
        sessionIds
      };
    });
  }

  projectWorkspaceSnapshot(workspaceId: string): Snapshot {
    requireScopeIdentifier(workspaceId, "snapshot.workspace_id");
    const scope = proto<SnapshotScope>("joko.v1.SnapshotScope", {
      kind: {
        case: "workspace",
        value: proto<WorkspaceSnapshotScope>("joko.v1.WorkspaceSnapshotScope", { workspaceId })
      }
    });
    return this.projectFilteredSnapshot(scope, (store, base) => {
      const target = store.listTargets().find((candidate) => workspaceIdForTarget(candidate) === workspaceId);
      if (target === undefined) throw new NotFoundError("Workspace", workspaceId);
      const sessionIds = new Set(base.sessions
        .filter((session) => session.descriptor.targetId === target.descriptor.id)
        .map((session) => session.descriptor.id));
      return {
        backendIds: new Set([target.descriptor.backendId]),
        targetIds: new Set([target.descriptor.id]),
        sessionIds
      };
    });
  }

  projectScheduleSnapshot(scheduleId: string): Snapshot {
    requireScopeIdentifier(scheduleId, "snapshot.schedule_id");
    const scope = proto<SnapshotScope>("joko.v1.SnapshotScope", {
      kind: {
        case: "schedule",
        value: proto<ScheduleSnapshotScope>("joko.v1.ScheduleSnapshotScope", { scheduleId })
      }
    });
    return this.projectFilteredSnapshot(scope, (store, base) => {
      const schedule = store.getSchedule(scheduleId);
      const sessionIds = new Set(schedule.sessionId === undefined
        ? base.sessions
          .filter((session) => session.descriptor.targetId === schedule.targetId)
          .map((session) => session.descriptor.id)
        : [schedule.sessionId]);
      return {
        backendIds: new Set([schedule.backendId]),
        targetIds: new Set([schedule.targetId]),
        sessionIds,
        scheduleIds: new Set([scheduleId])
      };
    });
  }

  projectToolSnapshot(toolProviderId: string): Snapshot {
    requireScopeIdentifier(toolProviderId, "snapshot.tool_provider_id");
    const scope = proto<SnapshotScope>("joko.v1.SnapshotScope", {
      kind: {
        case: "tool",
        value: proto<ToolSnapshotScope>("joko.v1.ToolSnapshotScope", { toolProviderId })
      }
    });
    return this.projectFilteredSnapshot(scope, (store) => {
      const leases = store.listToolLeases({ toolId: toolProviderId });
      const sessions = leases.map((lease) => store.getSession(lease.sessionId));
      return {
        backendIds: new Set(sessions.map((session) => session.descriptor.backendId)),
        targetIds: new Set(sessions.map((session) => session.descriptor.targetId)),
        sessionIds: new Set(sessions.map((session) => session.descriptor.id)),
        toolProviderId,
        includeSchedules: false
      };
    });
  }

  projectSessionSnapshot(request: SessionSnapshotRequest | string, recentTimelineItems = 200): Snapshot {
    const normalized = typeof request === "string"
      ? { sessionId: request, recentTimelineItems }
      : request;
    const timelineLimit = normalized.recentTimelineItems ?? 200;
    validateTimelineLimit(timelineLimit);
    if (normalized.sessionId.trim() === "") {
      throw new ProtoMappingError("invalid_argument", "snapshot.session_id", "Session ID must not be empty.");
    }
    const createdAt = this.now();
    return this.store.transaction((store) => {
      const base = store.getSessionSnapshot(normalized.sessionId);
      const toolLeases = store.listToolLeases({ sessionId: normalized.sessionId });
      const operationIds = new Set([
        ...base.queueItems.map((item) => item.operationId),
        ...base.interactions.flatMap((interaction) => interaction.operationId === undefined ? [] : [interaction.operationId])
      ]);
      const references = new Set([
        normalized.sessionId,
        base.target.descriptor.id,
        base.backend.descriptor.id,
        ...base.runs.map((run) => run.descriptor.id),
        ...base.queueItems.map((item) => item.id),
        ...base.interactions.map((interaction) => interaction.id),
        ...base.schedules.map((schedule) => schedule.id),
        ...base.artifacts.map((artifact) => artifact.blob.id)
      ]);
      const operations = scanStorePages((offset, limit) => store.listOperations({ limit, offset }))
        .filter((operation) => operationIds.has(operation.id) || operationMatches(operation, references));
      const timeline = timelineLimit === 0
        ? []
        : activeNativeTimeline(
            this.readTimeline(store, normalized.sessionId, base.globalCursor),
            base.session.descriptor.binding
          ).slice(-timelineLimit);
      const scope = proto<SnapshotScope>("joko.v1.SnapshotScope", {
        kind: {
          case: "session",
          value: proto<SessionSnapshotScope>("joko.v1.SessionSnapshotScope", {
            sessionId: normalized.sessionId,
            recentTimelineItems: timelineLimit
          })
        }
      });
      const activeRun = base.runs.find((run) => isActiveRun(run));
      return this.buildSnapshot({
        scope,
        revision: base.revision,
        cursor: base.globalCursor,
        generation: base.session.descriptor.binding.generation,
        createdAt,
        connections: [],
        backends: [base.backend],
        targets: [base.target],
        sessions: [base.session],
        runs: base.runs,
        queueItems: base.queueItems,
        schedules: base.schedules,
        interactions: base.interactions,
        artifacts: base.artifacts,
        toolLeases,
        operations,
        workspaces: [toProtoWorkspace(base.target)],
        timeline,
        sessionBase: base,
        activeRuns: activeRun === undefined ? new Map() : new Map([[base.session.descriptor.id, activeRun]])
      });
    });
  }

  private projectFilteredSnapshot(
    scope: SnapshotScope,
    select: (store: OperationalStore, base: OperationalSnapshot) => GraphFilter
  ): Snapshot {
    const createdAt = this.now();
    return this.store.transaction((store) => {
      const base = store.getSnapshot(createdAt);
      const filter = select(store, base);
      const backends = base.backends.filter((backend) => filter.backendIds.has(backend.descriptor.id));
      const targets = base.targets.filter((target) => filter.targetIds.has(target.descriptor.id));
      const sessions = base.sessions.filter((session) => filter.sessionIds.has(session.descriptor.id));
      const visibleSessionIds = new Set(sessions.map((session) => session.descriptor.id));
      const runs = scanStorePages((offset, limit) => store.listRuns({ limit, offset }))
        .filter((run) => visibleSessionIds.has(run.descriptor.sessionId));
      const visibleRunIds = new Set(runs.map((run) => run.descriptor.id));
      const queueItems = scanStorePages((offset, limit) => store.listQueueItems({ limit, offset }))
        .filter((item) => visibleSessionIds.has(item.sessionId) && visibleRunIds.has(item.runId));
      const schedules = filter.includeSchedules === false
        ? []
        : store.listSchedules().filter((schedule) => filter.scheduleIds === undefined
          ? filter.targetIds.has(schedule.targetId) &&
            (schedule.sessionId === undefined || visibleSessionIds.has(schedule.sessionId))
          : filter.scheduleIds.has(schedule.id));
      const interactions = scanStorePages((offset, limit) => store.listInteractions({ limit, offset }))
        .filter((interaction) => visibleSessionIds.has(interaction.sessionId));
      const artifacts = scanStorePages((offset, limit) => store.listArtifacts({ limit, offset }))
        .filter((artifact) => artifact.sessionId !== undefined && visibleSessionIds.has(artifact.sessionId));
      const toolLeases = store.listToolLeases(filter.toolProviderId === undefined
        ? {}
        : { toolId: filter.toolProviderId })
        .filter((lease) => visibleSessionIds.has(lease.sessionId));
      const operationIds = new Set([
        ...queueItems.map((item) => item.operationId),
        ...interactions.flatMap((interaction) => interaction.operationId === undefined ? [] : [interaction.operationId])
      ]);
      const references = new Set([
        ...filter.backendIds,
        ...filter.targetIds,
        ...visibleSessionIds,
        ...visibleRunIds,
        ...queueItems.map((item) => item.id),
        ...schedules.map((schedule) => schedule.id),
        ...interactions.map((interaction) => interaction.id),
        ...artifacts.map((artifact) => artifact.blob.id),
        ...(filter.toolProviderId === undefined ? [] : [filter.toolProviderId])
      ]);
      const operations = scanStorePages((offset, limit) => store.listOperations({ limit, offset }))
        .filter((operation) => operationIds.has(operation.id) || operationMatches(operation, references));
      return this.buildSnapshot({
        scope,
        revision: base.revision,
        cursor: base.globalCursor,
        generation: 0,
        createdAt,
        connections: [],
        backends,
        targets,
        sessions,
        runs,
        queueItems,
        schedules,
        interactions,
        artifacts,
        toolLeases,
        operations,
        workspaces: targets.map(toProtoWorkspace),
        timeline: [],
        base
      });
    });
  }

  private readTimeline(
    store: OperationalStore,
    sessionId: string,
    snapshotCursor: bigint
  ): PersistedEvent[] {
    const events: PersistedEvent[] = [];
    let afterCursor = 0n;
    while (afterCursor < snapshotCursor) {
      const page = store.listEvents({
        sessionId,
        afterCursor,
        limit: this.timelinePageSize
      });
      if (page.length === 0) break;
      for (const event of page) {
        if (event.globalCursor <= snapshotCursor) events.push(event);
      }
      const nextCursor = page.at(-1)?.globalCursor;
      if (nextCursor === undefined || nextCursor <= afterCursor) break;
      afterCursor = nextCursor;
      if (page.length < this.timelinePageSize) break;
    }
    return events;
  }

  private buildSnapshot(input: BuildSnapshotInput): Snapshot {
    const backendById = new Map(input.backends.map((backend) => [backend.descriptor.id, backend]));
    const targetById = new Map(input.targets.map((target) => [target.descriptor.id, target]));
    const sessionById = new Map(input.sessions.map((session) => [session.descriptor.id, session]));
    const runById = new Map(input.runs.map((run) => [run.descriptor.id, run]));
    const queueById = new Map(input.queueItems.map((item) => [item.id, item]));
    const interactionById = new Map(input.interactions.map((interaction) => [interaction.id, interaction]));
    const artifactById = new Map(input.artifacts.map((artifact) => [artifact.blob.id, artifact]));
    const activeRuns = input.activeRuns ?? activeRunsBySession(input.runs);
    const sessionContexts = new Map(input.sessions.map((session) => {
      const activeRun = activeRuns.get(session.descriptor.id);
      return [session.descriptor.id, sessionProjectionContext(this.store, session, {
        ...(activeRun === undefined ? {} : { activeRun }),
        runtimeAttached: activeRun !== undefined,
        resolveContextDefaults: this.options.resolveSessionContextDefaults,
        runtimeModel: this.options.resolveSessionRuntimeModel?.({
          sessionId: session.descriptor.id,
          backendId: session.descriptor.backendId,
          targetId: session.descriptor.targetId
        })
      })] as const;
    }));
    const attemptsByRun = new Map<string, ReturnType<OperationalStore["listAttempts"]>>();
    for (const run of input.runs) {
      const attempts = input.sessionBase === undefined
        ? this.store.listAttempts(run.descriptor.id)
        : input.sessionBase.attempts.filter((attempt) => attempt.descriptor.runId === run.descriptor.id);
      attemptsByRun.set(run.descriptor.id, attempts);
    }
    const sourceQueueByRun = new Map(input.queueItems.map((item) => [item.runId, item.id]));
    const { providers, models } = providerCatalog(
      input.backends,
      input.revision,
      input.createdAt,
      this.options.providerCatalog?.() ?? []
    );

    const mappedRuns = input.runs.map((run) => {
      const session = sessionById.get(run.descriptor.sessionId);
      if (session === undefined) {
        throw projectionReferenceError("run.session_id", run.descriptor.id, run.descriptor.sessionId);
      }
      return toProtoRun(run, {
        backendId: session.descriptor.backendId,
        targetId: session.descriptor.targetId,
        attempts: attemptsByRun.get(run.descriptor.id) ?? [],
        sourceQueueItemId: sourceQueueByRun.get(run.descriptor.id)
      });
    });

    const mappedQueue = input.queueItems.map((item, index) => {
      const session = sessionById.get(item.sessionId);
      const run = runById.get(item.runId);
      if (session === undefined) throw projectionReferenceError("queue_item.session_id", item.id, item.sessionId);
      if (run === undefined) throw projectionReferenceError("queue_item.run_id", item.id, item.runId);
      return toProtoQueueItem(item, {
        backendId: session.descriptor.backendId,
        targetId: session.descriptor.targetId,
        source: run.descriptor.source,
        ...(run.descriptor.parentRunId === undefined ? {} : { parentRunId: run.descriptor.parentRunId }),
        generation: session.descriptor.binding.generation
      }, BigInt(index));
    });

    const mappedSchedules = input.schedules.map((schedule) => toProtoSchedule(
      schedule,
      this.store.listScheduleRuns(schedule.id, 100),
      runById
    ));
    const mappedInteractions = input.interactions.map((interaction) => {
      const session = sessionById.get(interaction.sessionId);
      if (session === undefined) {
        throw projectionReferenceError("interaction.session_id", interaction.id, interaction.sessionId);
      }
      return toProtoInteraction(interaction, {
        backendId: session.descriptor.backendId,
        targetId: session.descriptor.targetId
      });
    });
    const mappedLeases = input.toolLeases.map((lease) => {
      const session = sessionById.get(lease.sessionId);
      if (session === undefined) throw projectionReferenceError("tool_lease.session_id", lease.id, lease.sessionId);
      return toProtoToolLease(lease, session.descriptor.backendId);
    });
    const mappedTimeline = input.timeline.map((event) => toProtoEvent(event, {
      queueItem: eventQueueItem(event, queueById, input.queueItems),
      queueControl: event.payload.type === "queue_control"
        ? this.store.getQueueControl(event.sessionId)
        : undefined,
      interaction: eventInteraction(event, interactionById),
      artifact: event.payload.type === "artifact" ? artifactById.get(event.payload.artifact.id) : undefined,
      run: event.runId === undefined ? undefined : runById.get(event.runId),
      attempts: event.runId === undefined ? undefined : attemptsByRun.get(event.runId),
      session: sessionById.get(event.sessionId),
      sessionContext: sessionContexts.get(event.sessionId),
      target: targetById.get(event.targetId)
    } satisfies EventMappingContext));
    const mappedBackgroundTasks: Snapshot["backgroundTasks"] = input.sessions.flatMap((session) =>
      this.store.listActiveSessionBackgroundTaskEvents(session.descriptor.id).flatMap((event) => {
        const kind = toProtoEvent(event).payload?.kind;
        const task = kind?.case === "backgroundTaskChanged" ? kind.value.backgroundTask : undefined;
        if (task === undefined) return [];
        // Snapshot activity is a fence, not conversation content. Keep only
        // typed identity/state/version facts and omit Adapter-supplied title,
        // status text, error text, or anything that could contain a secret.
        return [proto<Snapshot["backgroundTasks"][number]>("joko.v1.BackgroundTask", {
          ...task,
          displayName: "",
          statusText: "",
          error: undefined
        })];
      })
    );

    return proto<Snapshot>("joko.v1.Snapshot", {
      snapshotId: this.idFactory(),
      scope: input.scope,
      revision: toProtoRevision(input.revision),
      resumeCursor: toProtoEventCursor(input.cursor, input.generation, input.createdAt),
      generation: BigInt(input.generation),
      createdAt: toProtoTimestamp(input.createdAt),
      server: this.resolveServer(),
      connections: input.connections,
      devices: [],
      deviceControlRelations: [],
      backends: input.backends.map(toProtoBackend),
      targets: input.targets.map(toProtoTarget),
      sessions: input.sessions.map((session) => toProtoSession(
        session,
        sessionContexts.get(session.descriptor.id)
      )),
      runs: mappedRuns,
      queueItems: mappedQueue,
      queueControls: input.sessions.map((session) => toProtoQueueControl(
        this.store.getQueueControl(session.descriptor.id),
        session,
        input.queueItems.filter((item) => item.sessionId === session.descriptor.id && item.state === "accepted").length
      )),
      schedules: mappedSchedules,
      operations: input.operations.map((operation) => toProtoOperation(operation)),
      interactions: mappedInteractions,
      workspaces: input.workspaces,
      artifacts: input.artifacts.map(toProtoArtifact),
      providers,
      models,
      toolProviders: [],
      toolLeases: mappedLeases,
      mcpServers: [],
      browsers: [],
      backgroundTasks: mappedBackgroundTasks,
      runtimeCommands: input.sessions.flatMap((session) => {
        const observation = materializedRuntimeCommands(this.store.findSetting(
          "session",
          session.descriptor.id,
          SESSION_RUNTIME_COMMANDS_SETTING_KEY
        )?.value);
        return observation?.commands.map((command) =>
          toProtoRuntimeCommand(command, session.descriptor.id)
        ) ?? [];
      }),
      resources: [],
      settings: undefined,
      // Product persistence cannot authoritatively reconstruct Backend-native context/tree.
      nativeSessionTree: undefined,
      timeline: mappedTimeline,
      browserTransfers: [],
      extraDirectories: this.extraDirectories.list()
        .filter((directory) => targetById.has(directory.targetId))
        .map(toProtoExtraDirectory),
      extensionWidgets: input.sessions.flatMap((session) => {
        const value = this.store.findSetting<unknown>(
          "session",
          session.descriptor.id,
          EXTENSION_WIDGETS_SETTING_KEY
        )?.value;
        return readExtensionWidgets(value).map((widget) => toProtoExtensionWidget({
          sessionId: session.descriptor.id,
          key: widget.key,
          lines: widget.lines,
          placement: widget.placement,
          updatedAt: widget.updatedAt,
          removed: false
        }));
      }),
      extensionStatuses: input.sessions.flatMap((session) => {
        const value = this.store.findSetting<unknown>(
          "session",
          session.descriptor.id,
          EXTENSION_STATUSES_SETTING_KEY
        )?.value;
        return readExtensionStatuses(value).map((status) => toProtoExtensionStatus({
          sessionId: session.descriptor.id,
          key: status.key,
          text: status.text,
          updatedAt: status.updatedAt
        }));
      }),
      reviewRuns: []
    });
  }

  private resolveServer(): ServerInfo {
    return typeof this.options.server === "function" ? this.options.server() : this.options.server;
  }
}

/**
 * Keep every native branch durable while projecting only the current native leaf's
 * ancestor chain. Filtering happens before the caller applies its page limit.
 */
export function activeNativeTimeline(
  events: readonly PersistedEvent[],
  currentBinding?: { readonly opaqueRef: string; readonly generation: number }
): PersistedEvent[] {
  const marker = [...events].reverse().find((event) => event.payload.type === "native_session_changed");
  if (marker?.payload.type !== "native_session_changed") {
    if (currentBinding === undefined) return [...events];
    const currentFingerprint = nativeBindingFingerprint(currentBinding.opaqueRef);
    return events.filter((event) => {
      const identity = nativeHistoryEventContext(event.payload)?.identity;
      if (identity !== undefined) {
        return event.metadata?.fields[NATIVE_HISTORY_BINDING_FINGERPRINT_FIELD] === currentFingerprint;
      }
      return event.generation === currentBinding.generation;
    });
  }
  if (currentBinding !== undefined && marker.payload.opaqueRef !== currentBinding.opaqueRef) {
    return events.filter((event) =>
      nativeHistoryEventContext(event.payload)?.identity === undefined &&
      event.generation === currentBinding.generation
    );
  }
  const nativeReference = marker.payload.opaqueRef;
  const bindingFingerprint = nativeBindingFingerprint(nativeReference);
  const leafId = marker.payload.leafId;
  const parents = new Map<string, string | undefined>();
  for (const event of events) {
    const identity = nativeHistoryEventContext(event.payload)?.identity;
    const entryId = identity?.entryId;
    if (entryId === undefined) continue;
    const eventBindingFingerprint = event.metadata?.fields[NATIVE_HISTORY_BINDING_FINGERPRINT_FIELD];
    if (eventBindingFingerprint !== bindingFingerprint) continue;
    if (!parents.has(entryId)) parents.set(entryId, identity?.parentEntryId);
  }
  const active = new Set<string>();
  let cursor = leafId;
  while (cursor !== undefined && !active.has(cursor)) {
    active.add(cursor);
    cursor = parents.get(cursor);
  }
  return events.filter((event) => {
    const entryId = nativeHistoryEventContext(event.payload)?.identity?.entryId;
    if (entryId !== undefined) {
      const eventBindingFingerprint = event.metadata?.fields[NATIVE_HISTORY_BINDING_FINGERPRINT_FIELD];
      if (eventBindingFingerprint !== bindingFingerprint) return false;
      return leafId === undefined || active.has(entryId);
    }
    // Persistence-confirmed history replaces transient live stream records
    // that preceded the leaf marker; later in-flight records remain visible.
    if (
      event.globalCursor <= marker.globalCursor &&
      event.metadata?.fields[NATIVE_HISTORY_REPLACES_TRANSIENT_FIELD] === true
    ) return false;
    return true;
  });
}

export function projectSnapshot(
  store: OperationalStore,
  scope: SnapshotScope,
  options: SnapshotProjectorOptions
): Snapshot {
  return new SnapshotProjector(store, options).project(scope);
}

interface BuildSnapshotInput {
  readonly scope: SnapshotScope;
  readonly revision: bigint;
  readonly cursor: bigint;
  readonly generation: number;
  readonly createdAt: number;
  readonly connections: Snapshot["connections"];
  readonly backends: readonly StoredBackend[];
  readonly targets: readonly StoredTarget[];
  readonly sessions: readonly StoredSession[];
  readonly runs: readonly StoredRun[];
  readonly queueItems: readonly QueueItemRecord[];
  readonly schedules: SessionSnapshot["schedules"];
  readonly interactions: SessionSnapshot["interactions"];
  readonly artifacts: SessionSnapshot["artifacts"];
  readonly toolLeases: ReturnType<OperationalStore["listToolLeases"]>;
  readonly operations: readonly OperationRecord[];
  readonly workspaces: Snapshot["workspaces"];
  readonly timeline: readonly PersistedEvent[];
  readonly base?: OperationalSnapshot;
  readonly sessionBase?: SessionSnapshot;
  readonly activeRuns?: ReadonlyMap<string, StoredRun>;
}

interface GraphFilter {
  readonly backendIds: ReadonlySet<string>;
  readonly targetIds: ReadonlySet<string>;
  readonly sessionIds: ReadonlySet<string>;
  readonly scheduleIds?: ReadonlySet<string>;
  readonly toolProviderId?: string;
  readonly includeSchedules?: boolean;
}

function proto<T extends ProtoMessage>(
  typeName: T["$typeName"],
  fields: Omit<T, "$typeName" | "$unknown">
): T {
  return { $typeName: typeName, ...fields } as T;
}

function validateTimelineLimit(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > 10_000) {
    throw new ProtoMappingError(
      "out_of_range",
      "snapshot.recent_timeline_items",
      "Recent timeline items must be an integer between 0 and 10000."
    );
  }
}

function requireScopeIdentifier(value: string, fieldPath: string): void {
  if (value.trim() === "") {
    throw new ProtoMappingError("invalid_argument", fieldPath, `${fieldPath} must not be empty.`);
  }
}

function workspaceIdForTarget(target: StoredTarget): string {
  if (typeof target.metadata !== "object" || target.metadata === null || Array.isArray(target.metadata)) {
    return target.descriptor.id;
  }
  const value = (target.metadata as Readonly<Record<string, unknown>>).workspaceId;
  return typeof value === "string" && value !== "" ? value : target.descriptor.id;
}

function operationMatches(operation: OperationRecord, references: ReadonlySet<string>): boolean {
  return containsReference(operation.body, references) || containsReference(operation.response, references);
}

function containsReference(value: unknown, references: ReadonlySet<string>, seen = new Set<object>()): boolean {
  if (typeof value === "string") return references.has(value);
  if (typeof value !== "object" || value === null) return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.some((entry) => containsReference(entry, references, seen));
  return Object.values(value as Readonly<Record<string, unknown>>)
    .some((entry) => containsReference(entry, references, seen));
}

function isActiveRun(run: StoredRun): boolean {
  return ["queued", "running", "waiting", "retrying", "dispatch_unknown"].includes(run.descriptor.state);
}

function activeRunsBySession(runs: readonly StoredRun[]): ReadonlyMap<string, StoredRun> {
  const result = new Map<string, StoredRun>();
  for (const run of runs) {
    if (isActiveRun(run) && !result.has(run.descriptor.sessionId)) {
      result.set(run.descriptor.sessionId, run);
    }
  }
  return result;
}

function providerCatalog(
  backends: readonly StoredBackend[],
  revision: bigint,
  createdAt: number,
  authoritative: readonly SnapshotProviderCatalogEntry[]
): { readonly providers: Snapshot["providers"]; readonly models: Snapshot["models"] } {
  const providers = new Map<string, Snapshot["providers"][number]>();
  const availability = new Map<string, boolean>();
  const models = new Map<string, Snapshot["models"][number]>();
  const backendIds = new Set(backends.map((backend) => backend.descriptor.id));
  for (const entry of authoritative) {
    const backendId = entry.provider.backendId;
    const providerId = entry.provider.providerId;
    if (backendId === "" || !backendIds.has(backendId)) {
      throw new ProtoMappingError("invalid_argument", "snapshot.providers.backend_id", "Provider Backend ID must identify a projected Backend.");
    }
    if (providerId === "") {
      throw new ProtoMappingError("invalid_argument", "snapshot.providers.provider_id", "Provider ID is required.");
    }
    const key = providerProjectionKey(backendId, providerId);
    if (providers.has(key)) {
      throw new ProtoMappingError("invalid_argument", "snapshot.providers.provider_id", `Provider ${providerId} is duplicated for Backend ${backendId}.`);
    }
    providers.set(key, entry.provider);
    availability.set(key, entry.available);
  }
  for (const backend of backends) {
    const backendId = backend.descriptor.id;
    const explicitProviderIds = new Set<string>();
    for (const provider of backend.descriptor.providers ?? []) {
      if (provider.providerId === "" || explicitProviderIds.has(provider.providerId)) {
        throw new ProtoMappingError("invalid_argument", "snapshot.providers.provider_id", `Backend ${backendId} advertises an invalid or duplicated Provider ID.`);
      }
      explicitProviderIds.add(provider.providerId);
      const providerKey = providerProjectionKey(backendId, provider.providerId);
      availability.set(providerKey, backendAuthenticationAvailable(provider.authenticationState));
      if (!providers.has(providerKey)) {
        providers.set(providerKey, toProtoProviderDescriptor(
          backendId,
          provider.providerId,
          provider.api,
          backendAuthenticationAvailable(provider.authenticationState),
          revision,
          backend.updatedAt || createdAt,
          {
            login: provider.supportsLogin,
            logout: provider.supportsLogout,
            refresh: provider.supportsRefresh,
            modelRefresh: provider.supportsModelRefresh,
            loginMethods: provider.loginMethods,
            displayName: provider.displayName,
            authenticationState: provider.authenticationState,
            accessKind: provider.accessKind,
            accessProduct: provider.accessProduct,
            providesModelPricing: provider.providesModelPricing,
            credentialSurfaces: provider.credentialSurfaces
          }
        ));
      }
    }
    for (const model of backend.descriptor.models) {
      const providerKey = providerProjectionKey(backendId, model.providerId);
      const key = modelProjectionKey(backendId, model.providerId, model.modelId);
      if (!models.has(key)) {
        const mapped = toProtoModelDescriptor(backendId, model);
        models.set(key, {
          ...mapped,
          available: availability.get(providerKey)
            ?? backendAuthenticationAvailable(backend.descriptor.authenticationState)
        });
      }
      if (!providers.has(providerKey)) {
        providers.set(providerKey, toProtoProviderDescriptor(
          backendId,
          model.providerId,
          model.api,
          backendAuthenticationAvailable(backend.descriptor.authenticationState),
          revision,
          backend.updatedAt || createdAt,
          backendProviderOperations(backend.descriptor)
        ));
      }
    }
  }
  return { providers: [...providers.values()], models: [...models.values()] };
}

function providerProjectionKey(backendId: string, providerId: string): string {
  return `${backendId}\u0000${providerId}`;
}

function modelProjectionKey(backendId: string, providerId: string, modelId: string): string {
  return `${providerProjectionKey(backendId, providerId)}\u0000${modelId}`;
}

function backendAuthenticationAvailable(state: StoredBackend["descriptor"]["authenticationState"]): boolean {
  return state === "authenticated" || state === "not_required";
}

function backendProviderOperations(descriptor: StoredBackend["descriptor"]): {
  readonly login: boolean;
  readonly logout: boolean;
  readonly refresh: boolean;
  readonly modelRefresh: boolean;
  readonly loginMethods: readonly string[];
} {
  const login = descriptor.capabilities.get("provider.login");
  return {
    login: login?.supported === true,
    logout: descriptor.capabilities.get("provider.logout")?.supported === true,
    refresh: descriptor.capabilities.get("provider.refresh")?.supported === true,
    modelRefresh: descriptor.capabilities.get("provider.model_refresh")?.supported === true,
    loginMethods: login?.options ?? []
  };
}

function eventQueueItem(
  event: PersistedEvent,
  queueById: ReadonlyMap<string, QueueItemRecord>,
  queueItems: readonly QueueItemRecord[]
): QueueItemRecord | undefined {
  if (event.payload.type === "queue_update" && event.payload.itemId !== undefined) {
    return queueById.get(event.payload.itemId);
  }
  if (event.operationId !== undefined) {
    const byOperation = queueItems.find((item) => item.operationId === event.operationId);
    if (byOperation !== undefined) return byOperation;
  }
  return event.runId === undefined ? undefined : queueItems.find((item) => item.runId === event.runId);
}

function eventInteraction(
  event: PersistedEvent,
  interactions: ReadonlyMap<string, SessionSnapshot["interactions"][number]>
): SessionSnapshot["interactions"][number] | undefined {
  switch (event.payload.type) {
    case "interaction_opened": return interactions.get(event.payload.interaction.id);
    case "interaction_resolved":
    case "interaction_dismissed": return interactions.get(event.payload.interactionId);
    default: return undefined;
  }
}

function projectionReferenceError(field: string, entityId: string, missingId: string): ProtoMappingError {
  return new ProtoMappingError(
    "invalid_argument",
    field,
    `Cannot project entity ${entityId}: referenced ${field} ${missingId} is missing.`
  );
}
