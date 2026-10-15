import { create, toBinary } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import * as contract from "@joko/contracts";
import { TaskShareStore, type PersistedEvent } from "@joko/store";
import { eventWithServiceCursor, mapSession, mapRun, mapQueueItem, mapQueueControl, mapInteraction, sessionStatistics,
  toProtoOperation, mutationFromRecord, outcomeFromRecord, serverInfo, paginate, backendCatalogModels,
  nativeSessionMessageSearchFilters, type ConnectServiceDependencies } from "./connect-services.js";
import { fromProtoEventCursor, toProtoEventCursor, toProtoArtifact, toProtoBackend, toProtoModelDescriptor,
  toProtoProviderDescriptor, toProtoSubagentRun, toProtoSubagentRunDetail, toProtoSubagentTranscriptEntry,
  toProtoTimestamp, toProtoRevision } from "./proto-mapper.js";
import { projectBackgroundTaskHistory } from "./background-task-history.js";
import { readTaskBackgroundOutput } from "./background-task-output.js";
import type { TaskShareLease } from "./task-sharing-host-types.js";

/** Exact task reads over the original Store. This does not authenticate a
 * guest as a node owner or call ordinary RPC implementations with fake context. */
export class TaskSharingReads {
  constructor(readonly dependencies: ConnectServiceDependencies, readonly generation: () => bigint) {}
  async snapshot(lease: TaskShareLease, signal: AbortSignal): Promise<contract.Snapshot> {
    lease.assertCurrent(); signal.throwIfAborted();
    const snapshot = this.dependencies.store.transaction(store => {
      lease.assertCurrent();
      const base = store.getSessionSnapshot(lease.scope.sessionId);
      const events = store.listEvents({ sessionId: lease.scope.sessionId, order: "desc", activeNativeTimeline: true, limit: 200 }).reverse();
      return create(contract.SnapshotSchema, { snapshotId: `shared:${lease.scope.shareId}:${base.revision}`, revision: toProtoRevision(base.revision),
        scope: { kind: { case: "session", value: { sessionId: lease.scope.sessionId, recentTimelineItems: 200 } } },
        generation: this.generation(), server: serverInfo(this.dependencies, Date.now()), createdAt: toProtoTimestamp(Date.now()),
        resumeCursor: toProtoEventCursor(base.globalCursor, this.generation(), Date.now()),
        sessions: [this.session(lease)], runs: base.runs.map(row => mapRun(store, row)),
        queueItems: base.queueItems.map((row, index) => mapQueueItem(store, row, BigInt(index), this.dependencies.taskShares)),
        queueControls: [mapQueueControl(store, lease.scope.sessionId)], interactions: base.interactions.map(row => mapInteraction(store, row)),
        artifacts: base.artifacts.map(toProtoArtifact), timeline: events.flatMap(event => { const projected = this.projectEvent(lease, event); return projected ? [projected] : []; }),
        backends: store.listBackends().map(row => ({ ...toProtoBackend(row), error: undefined })),
        models: store.listBackends().flatMap(row => backendCatalogModels(this.dependencies, row.descriptor).map(model => toProtoModelDescriptor(row.descriptor.id, model))) });
    });
    lease.assertCurrent(); signal.throwIfAborted(); return snapshot;
  }
  projectEvent(lease: TaskShareLease, event: PersistedEvent): contract.Event | undefined {
    lease.assertCurrent();
    if (event.sessionId !== lease.scope.sessionId || !VISIBLE_EVENTS.has(event.payload.type)) return undefined;
    const projected = eventWithServiceCursor(event, this.dependencies, this.generation());
    if (projected.payload?.kind.case === "sessionChanged") projected.payload.kind.value.session = this.session(lease);
    return projected;
  }
  async read(lease: TaskShareLease, method: contract.TaskShareMethod, bytes: Uint8Array, signal: AbortSignal): Promise<Uint8Array> {
    lease.assertCurrent(); signal.throwIfAborted();
    const request = contract.decodeTaskShareRequest(method, bytes) as unknown as Record<string, unknown>;
    const descriptor = contract.taskShareMethodDescriptor(method), store = this.dependencies.store, sessionId = lease.scope.sessionId;
    const exactSession = () => { if (request["sessionId"] !== sessionId) throw denied(); };
    const page = request["page"] as contract.PageRequest | undefined;
    let output: object;
    switch (method) {
      case contract.TaskShareMethod.GET_SESSION: exactSession(); output = { session: this.session(lease) }; break;
      case contract.TaskShareMethod.LIST_SESSION_TIMELINE: {
        exactSession(); const before = request["beforeCursor"] as contract.EventCursor | undefined;
        const cursor = before === undefined ? undefined : fromProtoEventCursor(before);
        if (cursor !== undefined && cursor.generation !== this.generation()) throw new ConnectError("Fetch the current shared-task snapshot.", Code.FailedPrecondition);
        const around = String(request["aroundEventId"] ?? ""), limit = Math.min(Math.max(Number(request["limit"]) || 100, 1), 500);
        if (around && before) throw new ConnectError("Around and before cursors cannot be combined.", Code.InvalidArgument);
        const events = around ? store.listEventsAround(sessionId, around, limit)
          : store.listEvents({ sessionId, ...(cursor ? { beforeCursor: cursor.sequence } : {}), order: "desc", activeNativeTimeline: true, limit: limit + 1 });
        const hasMore = !around && events.length > limit, chosen = around ? events : events.slice(0, limit).reverse();
        output = { events: chosen.flatMap(event => { const projected = this.projectEvent(lease, event); return projected ? [projected] : []; }),
          ...(hasMore && chosen[0] ? { nextBeforeCursor: toProtoEventCursor(chosen[0].globalCursor, this.generation(), Date.now()) } : {}) }; break;
      }
      case contract.TaskShareMethod.SEARCH_SESSION_MESSAGES: {
        const scope = request["scope"] as { case: string; value: string };
        if (scope?.case !== "sessionId" || scope.value !== sessionId) throw denied();
        const query = String(request["query"] ?? ""), filters = nativeSessionMessageSearchFilters(request["filters"] as contract.SessionMessageSearchFilters | undefined);
        const result = store.searchSessionMessages({ scope: { sessionId }, query, ...(filters ? { filters } : {}),
          limit: Math.min(Math.max(page?.pageSize || 24, 1), 100), ...(page?.pageToken ? { pageToken: page.pageToken } : {}),
          semanticSkipReason: "Shared-task search uses the original durable keyword index." });
        output = { matches: result.matches.map(match => create(contract.SessionMessageSearchMatchSchema, { sessionId: match.sessionId,
          eventId: match.eventId, timelineItemId: match.timelineItemId, role: match.role === "user" ? contract.SessionMessageSearchRole.USER : contract.SessionMessageSearchRole.ASSISTANT,
          kind: contract.SessionMessageSearchKind.TEXT_MESSAGE, snippet: match.snippet, createdAt: toProtoTimestamp(match.createdAt), score: match.score })),
          page: { nextPageToken: result.nextPageToken ?? "", totalSize: BigInt(result.totalSize) }, revision: toProtoRevision(result.revision),
          vectorUsed: result.vectorUsed, vectorSkipReason: result.vectorSkipReason ?? "", poolCapped: result.poolCapped }; break;
      }
      case contract.TaskShareMethod.LIST_RUNS: {
        exactSession(); output = paged(store.listRuns({ sessionId }).map(row => mapRun(store, row)), page, "runs"); break;
      }
      case contract.TaskShareMethod.GET_RUN: {
        const run = store.getRun(String(request["runId"])); if (run.descriptor.sessionId !== sessionId) throw denied();
        output = { run: mapRun(store, run) }; break;
      }
      case contract.TaskShareMethod.LIST_QUEUE_ITEMS: {
        exactSession(); const rows = store.getSessionSnapshot(sessionId).queueItems;
        output = paged(rows.map((row, index) => mapQueueItem(store, row, BigInt(index), this.dependencies.taskShares)).filter(row => request["state"] === undefined || row.state === request["state"]), page, "queueItems"); break;
      }
      case contract.TaskShareMethod.GET_QUEUE_CONTROL: exactSession(); output = { queueControl: mapQueueControl(store, sessionId) }; break;
      case contract.TaskShareMethod.LIST_INTERACTIONS: {
        exactSession(); const rows = store.getSessionSnapshot(sessionId).interactions;
        output = paged(rows.map(row => mapInteraction(store, row)), page, "interactions"); break;
      }
      case contract.TaskShareMethod.GET_INTERACTION: {
        const item = store.getInteraction(String(request["interactionId"])); if (item.sessionId !== sessionId) throw denied();
        output = { interaction: mapInteraction(store, item) }; break;
      }
      case contract.TaskShareMethod.GET_SESSION_STATISTICS:
        exactSession(); output = { statistics: await sessionStatistics(this.dependencies, sessionId) }; break;
      case contract.TaskShareMethod.LIST_BACKGROUND_TASKS: {
        exactSession(); const rows = projectBackgroundTaskHistory(store.listSessionBackgroundTaskEvents(sessionId));
        output = paged(rows.filter(row => request["state"] === undefined || row.state === request["state"]), page, "backgroundTasks"); break;
      }
      case contract.TaskShareMethod.LIST_SUBAGENT_RUNS: {
        exactSession(); const result = store.listSubagentRuns({ sessionId, limit: Math.min(page?.pageSize || 50, 100), ...(page?.pageToken ? { pageToken: page.pageToken } : {}) });
        output = { runs: result.runs.map(run => toProtoSubagentRun(run)), page: { nextPageToken: result.nextPageToken ?? "", totalSize: BigInt(result.totalSize) } }; break;
      }
      case contract.TaskShareMethod.GET_SUBAGENT_RUN: {
        exactSession(); const result = store.getSessionSubagentRun(sessionId, String(request["subagentRunId"])); if (!result) throw denied();
        output = { run: toProtoSubagentRunDetail(result.run, { revision: result.event.revision, generation: result.event.generation, updatedAt: result.event.emittedAt }) }; break;
      }
      case contract.TaskShareMethod.LIST_SUBAGENT_TRANSCRIPT: {
        exactSession(); const run = store.getSessionSubagentRun(sessionId, String(request["subagentRunId"]));
        if (!run?.run.capabilities.viewFullTranscript) throw denied();
        const result = store.listSubagentTranscript({ sessionId, subagentRunId: run.run.id, ...(request["childId"] ? { childId: String(request["childId"]) } : {}),
          limit: Math.min(page?.pageSize || 50, 200), ...(page?.pageToken ? { pageToken: page.pageToken } : {}) });
        output = { entries: result.entries.map(toProtoSubagentTranscriptEntry), page: { nextPageToken: result.nextPageToken ?? "", totalSize: BigInt(result.totalSize) }, tailPageToken: result.tailPageToken }; break;
      }
      case contract.TaskShareMethod.LIST_MODELS: {
        const backendId = String(request["backendId"] || store.getSession(sessionId).descriptor.backendId), backend = store.getBackend(backendId).descriptor;
        const models = backendCatalogModels(this.dependencies, backend).filter(model => !request["providerId"] || model.providerId === request["providerId"]);
        output = paged(models.map(model => toProtoModelDescriptor(backendId, model)), page, "models"); break;
      }
      case contract.TaskShareMethod.LIST_PROVIDERS: {
        const backendId = String(request["backendId"] || store.getSession(sessionId).descriptor.backendId), backend = store.getBackend(backendId).descriptor;
        const models = backendCatalogModels(this.dependencies, backend), providerIds = [...new Set(models.map(model => model.providerId))];
        const record = store.getBackend(backendId);
        output = paged(providerIds.map(providerId => toProtoProviderDescriptor(backendId, providerId, models.find(model => model.providerId === providerId)!.api,
          backend.authenticationState === "authenticated" || backend.authenticationState === "not_required", record.revision, record.updatedAt)), page, "providers"); break;
      }
      case contract.TaskShareMethod.GET_BACKEND: {
        const backend = toProtoBackend(store.getBackend(String(request["backendId"]))); output = { backend: { ...backend, error: undefined } }; break;
      }
      case contract.TaskShareMethod.LIST_BACKENDS:
        output = paged(store.listBackends().map(row => ({ ...toProtoBackend(row), error: undefined })), page, "backends"); break;
      case contract.TaskShareMethod.GET_RUNTIME_CONTROL: {
        exactSession(); const control = this.dependencies.sessionHost.getSessionRuntimeControl(sessionId);
        output = { control: { generation: BigInt(control.generation), baseline: control.baseline, effective: control.effective,
          ...(control.pending === undefined ? {} : { pending: control.pending.profile, pendingGeneration: BigInt(control.pending.generation) }),
          handoffState: control.handoffState ?? "" } }; break;
      }
      case contract.TaskShareMethod.GET_BACKGROUND_TASK_OUTPUT: {
        exactSession();
        output = { output: await readTaskBackgroundOutput(this.dependencies.sessionHost, sessionId,
          String(request["backgroundTaskId"] ?? ""), Number(request["maximumBytes"] || 16_384), () => lease.assertCurrent(), signal) };
        break;
      }
      case contract.TaskShareMethod.GET_OPERATION: {
        const operationId = String(request["operationId"]), authors = new TaskShareStore(store), author = authors.getAuthorForOperation(operationId);
        const operation = store.findOperation(operationId);
        if (!operation && !author) throw new ConnectError("No shared-task operation was admitted with this identity.", Code.NotFound);
        if (author?.shareId !== lease.proof.shareId || author.shareGeneration !== lease.proof.shareGeneration
          || author.sessionId !== sessionId || author.memberId !== lease.proof.memberId || author.memberGeneration !== lease.proof.memberGeneration) throw denied();
        if (!operation) throw new ConnectError("The original shared-task admission is still awaiting confirmation.", Code.FailedPrecondition);
        output = { operation: minimizeSharedTaskOperation(toProtoOperation(this.dependencies, operation, mutationFromRecord(store, operation), outcomeFromRecord(operation), Date.now()), lease) }; break;
      }
      case contract.TaskShareMethod.LIST_ARTIFACTS: {
        exactSession(); if (request["referenceTargetSessionId"] || request["referenceTargetGeneration"] !== undefined) throw denied();
        const runId = String(request["runId"] ?? ""); if (runId && store.getRun(runId).descriptor.sessionId !== sessionId) throw denied();
        const rows = store.getSessionSnapshot(sessionId).artifacts.filter(row => !runId || row.runId === runId);
        output = { ...paged(rows.map(toProtoArtifact), page, "artifacts"), revision: toProtoRevision(store.health().revision) }; break;
      }
      case contract.TaskShareMethod.GET_ARTIFACT: {
        const artifact = store.getArtifact(String(request["artifactId"])); if (artifact.sessionId !== sessionId) throw denied();
        output = { artifact: toProtoArtifact(artifact) }; break;
      }
      default: throw denied();
    }
    lease.assertCurrent(); signal.throwIfAborted();
    return toBinary(descriptor.output, create(descriptor.output, output as never));
  }
  private session(lease: TaskShareLease): contract.Session {
    const session = mapSession(this.dependencies, this.dependencies.store.getSession(lease.scope.sessionId));
    return minimizeSharedTaskSession(session, lease);
  }
}
const VISIBLE_EVENTS = new Set([
  "session_changed", "run_state", "queue_update", "queue_control", "text_delta", "thinking_delta", "status",
  "message_complete", "tool_start", "tool_update", "tool_result", "artifact", "interaction_opened", "interaction_resolved", "interaction_dismissed",
  "background_task", "retry", "compaction", "usage", "resource_usage", "context_cleared", "context_rebuild", "message_deleted", "session_reset", "done", "error",
  "session_attention", "subagent_run", "subagent_transcript", "runtime_recovery", "history_pruned", "runtime_handoff"
]);
function denied(): ConnectError { return new ConnectError("The requested data is outside this shared task.", Code.PermissionDenied); }
export function minimizeSharedTaskSession(session: contract.Session, lease: TaskShareLease): contract.Session {
  if (session.sessionId !== lease.scope.sessionId) throw denied();
  return create(contract.SessionSchema, { ...session, worktree: undefined, codeHostPullRequests: [],
    nativeBinding: session.nativeBinding === undefined ? undefined : { ...session.nativeBinding, opaqueReference: `shared:${lease.scope.shareId}` } });
}
export function minimizeSharedTaskOperation(operation: contract.Operation, lease: TaskShareLease): contract.Operation {
  const payload = operation.result?.payload;
  if (!payload?.case) return operation;
  if (payload.case === "session") return create(contract.OperationSchema, { ...operation,
    result: create(contract.OperationResultSchema, { payload: { case: "session", value: minimizeSharedTaskSession(payload.value, lease) } }) });
  if (!["acknowledgement", "queueItem", "queueControl", "run", "interaction"].includes(payload.case)) throw denied();
  if ("sessionId" in payload.value && payload.value.sessionId !== lease.scope.sessionId) throw denied();
  return operation;
}
function paged<T>(values: readonly T[], page: contract.PageRequest | undefined, key: string): object {
  const result = paginate(values, page); return { [key]: result.values, page: result.page };
}
