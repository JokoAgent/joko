import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, type HandlerContext, type ServiceImpl } from "@connectrpc/connect";
import * as contract from "@joko/contracts";
import type { Routine, RoutineInput, RoutineRun, RoutineSource, RoutineTrigger } from "@joko/core";
import { fromProtoRevision, fromProtoTimestamp, toProtoRevision, toProtoTimestamp } from "./proto-mapper.js";
import { parseRoutineInput } from "./partner-routine-definition.js";
import { PartnerRoutineError, type PartnerRoutineManager } from "./partner-routine-manager.js";

export function createPartnerRoutineConnectService(manager: PartnerRoutineManager | undefined,
  authenticate: (context: HandlerContext) => unknown): ServiceImpl<typeof contract.PartnerRoutineService> {
  const owner = () => { if (!manager) throw new ConnectError("Partner routines are unavailable.", Code.Unimplemented); return manager; };
  const invoke = async <T>(context: HandlerContext, action: () => T | Promise<T>): Promise<T> => {
    authenticate(context);
    try { const result = await action(); authenticate(context); return result; }
    catch (error) { if (error instanceof ConnectError) throw error;
      throw new ConnectError(error instanceof PartnerRoutineError ? error.message : "Routine changed or is unavailable. Refresh before retrying.",
        error instanceof PartnerRoutineError && error.code === "invalid" ? Code.InvalidArgument : Code.FailedPrecondition); }
  };
  return {
    listPartnerRoutines: (request, context) => invoke(context, () => {
      const catalog = owner().catalog(request.partnerId);
      return create(contract.ListPartnerRoutinesResponseSchema, { partnerId: catalog.partnerId,
        partnerRevision: toProtoRevision(catalog.partnerRevision), writable: catalog.writable,
        routines: catalog.routines.map(toProtoRoutine), sources: catalog.sources.map(toProtoSource),
        models: catalog.models.map(model => ({ ...model, route: toProtoRoutineModel(model.route) })) });
    }),
    savePartnerRoutine: (request, context) => invoke(context, async () => {
      if (!request.definition || request.intent.case === undefined) throw new ConnectError("Definition and intent are required.", Code.InvalidArgument);
      const routine = await owner().save({ partnerId: request.partnerId,
        partnerRevision: fromProtoRevision(request.expectedPartnerRevision), definition: fromProtoDefinition(request.definition),
        ...(request.intent.case === "creationRequestId" ? { requestId: request.intent.value }
          : { routineId: request.intent.value, revision: numberRevision(request.expectedRevision) }) });
      return create(contract.SavePartnerRoutineResponseSchema, { routine: toProtoRoutine(routine) });
    }),
    runPartnerRoutine: (request, context) => invoke(context, async () => {
      await owner().run({ partnerId: request.partnerId, partnerRevision: fromProtoRevision(request.expectedPartnerRevision),
        routineId: request.routineId, revision: numberRevision(request.expectedRevision), requestId: request.requestId });
      return create(contract.RunPartnerRoutineResponseSchema);
    }),
    deletePartnerRoutine: (request, context) => invoke(context, async () => {
      await owner().remove({ partnerId: request.partnerId, partnerRevision: fromProtoRevision(request.expectedPartnerRevision),
        routineId: request.routineId, revision: numberRevision(request.expectedRevision) });
      return create(contract.DeletePartnerRoutineResponseSchema);
    }),
    listPartnerRoutineRuns: (request, context) => invoke(context, () => {
      const result = owner().history(request.partnerId, request.routineId, request.offset ?? 0);
      return create(contract.ListPartnerRoutineRunsResponseSchema, { runs: result.runs.map(toProtoRun), nextOffset: result.nextOffset });
    }),
    getPartnerRoutineCreation: (request, context) => invoke(context, () => {
      const result = owner().creation(request.partnerId, request.requestId);
      return create(contract.GetPartnerRoutineCreationResponseSchema, { retired: result.retired,
        ...(result.routine ? { routine: toProtoRoutine(result.routine) } : {}) });
    }),
    retirePartnerRoutineCreation: (request, context) => invoke(context, async () => {
      const result = await owner().retireCreation(request.partnerId, request.requestId);
      return create(contract.RetirePartnerRoutineCreationResponseSchema, { retired: result.retired,
        ...(result.routine ? { routine: toProtoRoutine(result.routine) } : {}) });
    })
  };
}
function numberRevision(value: contract.Revision | undefined): number {
  const revision = fromProtoRevision(value);
  if (revision < 1n || revision > BigInt(Number.MAX_SAFE_INTEGER)) throw new ConnectError("Routine revision is invalid.", Code.InvalidArgument);
  return Number(revision);
}
function safeNumber(value: bigint): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) throw new ConnectError("Routine numeric field is invalid.", Code.InvalidArgument);
  return Number(value);
}
function fromProtoDefinition(value: contract.RoutineDefinition): RoutineInput {
  const mode = value.sessionMode;
  if (![contract.RoutineSessionMode.UNSPECIFIED, contract.RoutineSessionMode.PERSISTENT, contract.RoutineSessionMode.FRESH].includes(mode))
    throw new ConnectError("Routine session mode is invalid.", Code.InvalidArgument);
  const model = value.modelOverride;
  if (model && !model.selection?.model) throw new ConnectError("A complete routine model route is required.", Code.InvalidArgument);
  return parseRoutineInput({ name: value.name, prompt: value.prompt, enabled: value.enabled, silentWhenIdle: value.silentWhenIdle,
    sessionMode: mode === contract.RoutineSessionMode.FRESH ? "fresh" : "persistent",
    ...(model ? { modelOverride: { backendId: model.backendId, providerId: model.selection!.model!.providerId,
      modelId: model.selection!.model!.modelId, ...(model.selection!.effortId ? { effort: model.selection!.effortId } : {}),
      fastMode: contract.decodeModelSpeed(model.selection!) } } : { modelOverride: null }),
    ...(value.preRunHook ? { preRunHook: { command: value.preRunHook.command,
      ...(value.preRunHook.timeoutMs === undefined ? {} : { timeoutMs: safeNumber(value.preRunHook.timeoutMs) }) } } : {}),
    triggers: value.triggers.map((trigger): RoutineTrigger => {
      const kind = trigger.kind;
      switch (kind.case) {
        case "cron": return { id: trigger.id, kind: "cron", expression: kind.value.expression, timezone: kind.value.timezone };
        case "interval": return { id: trigger.id, kind: "interval", intervalMs: safeNumber(kind.value.intervalMs),
          ...(kind.value.anchorMs === undefined ? {} : { anchorMs: safeNumber(kind.value.anchorMs) }) };
        case "once": { const at = fromProtoTimestamp(kind.value.at); if (at === undefined) throw new ConnectError("One-shot time is required.", Code.InvalidArgument);
          return { id: trigger.id, kind: "once", at }; }
        case "event": return { id: trigger.id, kind: "event", sourceId: kind.value.sourceId, eventType: kind.value.eventType,
          filters: kind.value.filters.map(filter => ({ field: filter.field, operator: fromProtoOperator(filter.operator), value: filter.value })) };
        default: throw new ConnectError("Routine trigger kind is required.", Code.InvalidArgument);
      }
    }) });
}
function fromProtoOperator(value: contract.RoutineFilterOperator): "equals" | "contains" | "not-equals" {
  if (value === contract.RoutineFilterOperator.EQUALS) return "equals";
  if (value === contract.RoutineFilterOperator.CONTAINS) return "contains";
  if (value === contract.RoutineFilterOperator.NOT_EQUALS) return "not-equals";
  throw new ConnectError("Routine filter operator is invalid.", Code.InvalidArgument);
}
function toProtoRoutine(value: Routine): contract.PartnerRoutine {
  return create(contract.PartnerRoutineSchema, { id: value.id, partnerId: value.partnerId, revision: toProtoRevision(BigInt(value.revision)),
    ...(value.builtin ? { builtin: value.builtin, builtinVersion: value.builtinVersion } : {}),
    definition: { name: value.name, prompt: value.prompt, enabled: value.enabled, silentWhenIdle: value.silentWhenIdle,
      sessionMode: value.sessionMode === "fresh" ? contract.RoutineSessionMode.FRESH : contract.RoutineSessionMode.PERSISTENT,
      ...(value.modelOverride ? { modelOverride: toProtoRoutineModel(value.modelOverride) } : {}),
      ...(value.preRunHook ? { preRunHook: { command: value.preRunHook.command,
        ...(value.preRunHook.timeoutMs === undefined ? {} : { timeoutMs: BigInt(value.preRunHook.timeoutMs) }) } } : {}),
      triggers: value.triggers.map(toProtoRoutineTrigger) }, ...(value.activity ? { activity: runStatus(value.activity) } : {}),
    createdAt: toProtoTimestamp(value.createdAt), updatedAt: toProtoTimestamp(value.updatedAt) });
}
export function toProtoRoutineTrigger(trigger: RoutineTrigger): contract.RoutineTrigger {
  const base = { id: trigger.id };
  switch (trigger.kind) {
    case "cron": return create(contract.RoutineTriggerSchema, { ...base, kind: { case: "cron", value: { expression: trigger.expression, timezone: trigger.timezone } } });
    case "interval": return create(contract.RoutineTriggerSchema, { ...base, kind: { case: "interval", value: { intervalMs: BigInt(trigger.intervalMs),
      ...(trigger.anchorMs === undefined ? {} : { anchorMs: BigInt(trigger.anchorMs) }) } } });
    case "once": return create(contract.RoutineTriggerSchema, { ...base, kind: { case: "once", value: { at: toProtoTimestamp(trigger.at) } } });
    case "event": return create(contract.RoutineTriggerSchema, { ...base, kind: { case: "event", value: { sourceId: trigger.sourceId, eventType: trigger.eventType,
      filters: trigger.filters.map(filter => ({ ...filter, operator: filter.operator === "equals" ? contract.RoutineFilterOperator.EQUALS
        : filter.operator === "contains" ? contract.RoutineFilterOperator.CONTAINS : contract.RoutineFilterOperator.NOT_EQUALS })) } } });
  }
}
export function runStatus(value: RoutineRun["status"]): contract.RoutineRunStatus {
  return { queued: contract.RoutineRunStatus.QUEUED, running: contract.RoutineRunStatus.RUNNING, success: contract.RoutineRunStatus.SUCCESS,
    failed: contract.RoutineRunStatus.FAILED, interrupted: contract.RoutineRunStatus.INTERRUPTED, cancelled: contract.RoutineRunStatus.CANCELLED,
    skipped: contract.RoutineRunStatus.SKIPPED }[value];
}
function toProtoRun(value: RoutineRun): contract.PartnerRoutineRun {
  return create(contract.PartnerRoutineRunSchema, { id: value.id, routineId: value.routineId,
    definitionRevision: toProtoRevision(BigInt(value.revision)), triggerIds: value.triggerIds, status: runStatus(value.status),
    createdAt: toProtoTimestamp(value.createdAt), ...(value.finishedAt === undefined ? {} : { finishedAt: toProtoTimestamp(value.finishedAt) }),
    error: value.error, scheduleRunId: value.scheduleRunId, sessionId: value.sessionId, resultText: value.resultText });
}
function toProtoRoutineModel(value: NonNullable<Routine["modelOverride"]>) {
  return { backendId: value.backendId, selection: { model: { providerId: value.providerId, modelId: value.modelId },
    ...(value.effort === undefined ? {} : { effortId: value.effort }), ...contract.encodeModelSpeed(value.fastMode) } };
}
function toProtoSource(value: RoutineSource): contract.RoutineSource {
  return create(contract.RoutineSourceSchema, { id: value.id, name: value.name, events: value.events,
    status: value.status === "listening" ? contract.RoutineSourceStatus.LISTENING
      : value.status === "error" ? contract.RoutineSourceStatus.ERROR : contract.RoutineSourceStatus.DISCONNECTED,
    ...(value.lastEventAt === undefined ? {} : { lastEventAt: toProtoTimestamp(value.lastEventAt) }) });
}
