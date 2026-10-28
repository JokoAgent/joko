import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, type HandlerContext, type ServiceImpl } from "@connectrpc/connect";
import * as contract from "@joko/contracts";
import type { ConnectionRecord, PartnerCapabilitiesRecord } from "@joko/store";
import type { DevicePeerSelectionIdentity } from "./device-peer-owner.js";
import { PartnerHomeError, type PartnerHomeMoveRecord, type PartnerHomeOwner } from "./partner-home-owner.js";
import type { PartnerHomeRuntimeAdapter, PartnerHomeModel } from "./partner-home-runtime.js";
import { fromProtoRevision, toProtoRevision, toProtoTimestamp } from "./proto-mapper.js";

export function createPartnerHomeConnectService(home: PartnerHomeOwner | undefined, runtime: PartnerHomeRuntimeAdapter | undefined,
  authenticate: (context: HandlerContext) => ConnectionRecord): ServiceImpl<typeof contract.PartnerHomeService> {
  const owner = () => { if (!home || !runtime) throw new ConnectError("Partner homes are unavailable.", Code.Unimplemented); return { home, runtime }; };
  const invoke = async <T>(context: HandlerContext, action: (connection: ConnectionRecord) => T | Promise<T>): Promise<T> => {
    const connection = authenticate(context); context.signal.throwIfAborted();
    try { const result = await action(connection); authenticate(context); return result; }
    catch (error) { if (error instanceof ConnectError) throw error;
      throw new ConnectError(error instanceof PartnerHomeError ? error.code : "The execution computer is unavailable.", Code.FailedPrecondition); }
  };
  const identity = (partnerId: string, generation: number) => create(contract.PartnerHomeIdentitySchema,
    { partnerId, authorityServerId: owner().runtime.authorityServerId, generation: BigInt(generation) });
  const current = (partnerId: string) => {
    const { home, runtime } = owner(), record = home.current(partnerId);
    return create(contract.PartnerHomeSchema, { identity: identity(partnerId, record.generation), deviceId: record.location.deviceId,
      deviceName: record.location.name, serviceNode: record.location.kind === "service", available: runtime.sourceAvailable(record), changing: home.storage.changing(partnerId) });
  };
  const receipt = (value: PartnerHomeMoveRecord) => create(contract.PartnerHomeMoveSchema, {
    requestId: value.requestId, identity: identity(value.partnerId, value.source.generation + (value.committed ? 1 : 0)),
    phase: { waiting: contract.PartnerHomeMovePhase.WAITING, stopping: contract.PartnerHomeMovePhase.STOPPING,
      preparing: contract.PartnerHomeMovePhase.PREPARING, activating: contract.PartnerHomeMovePhase.ACTIVATING,
      ready: contract.PartnerHomeMovePhase.READY, "needs-attention": contract.PartnerHomeMovePhase.NEEDS_ATTENTION }[value.phase],
    failure: value.failure === undefined ? contract.PartnerHomeMoveFailure.UNSPECIFIED : {
      busy: contract.PartnerHomeMoveFailure.BUSY, "source-unavailable": contract.PartnerHomeMoveFailure.SOURCE_UNAVAILABLE,
      "target-unavailable": contract.PartnerHomeMoveFailure.TARGET_UNAVAILABLE, "runtime-unavailable": contract.PartnerHomeMoveFailure.RUNTIME_UNAVAILABLE,
      "state-changed": contract.PartnerHomeMoveFailure.STATE_CHANGED, "outcome-unknown": contract.PartnerHomeMoveFailure.OUTCOME_UNKNOWN,
      "preparation-failed": contract.PartnerHomeMoveFailure.PREPARATION_FAILED }[value.failure],
    sourceDeviceName: value.source.location.name, targetDeviceName: value.destination.name,
    ...(value.canonicalSessionId ? { canonicalSessionId: value.canonicalSessionId } : {}),
    createdAt: toProtoTimestamp(value.createdAt), updatedAt: toProtoTimestamp(value.updatedAt) });
  const pendingMove = (partnerId: string) => {
    const latest = owner().home.storage.list().filter(move => move.partnerId === partnerId).sort((a, b) => b.createdAt - a.createdAt || b.requestId.localeCompare(a.requestId))[0];
    return latest && latest.phase !== "ready" ? receipt(latest) : undefined;
  };
  return {
    getPartnerHome: (request, context) => invoke(context, () => {
      return create(contract.GetPartnerHomeResponseSchema, { home: current(request.partnerId), pendingMove: pendingMove(request.partnerId) });
    }),
    listPartnerHomeTargets: (request, context) => invoke(context, connection => create(contract.ListPartnerHomeTargetsResponseSchema, {
      home: current(request.partnerId), pendingMove: pendingMove(request.partnerId),
      targets: owner().runtime.targets(connection).map(item => create(contract.PartnerHomeTargetSchema, {
        destination: destination(item.selection), deviceName: item.name, platform: item.platform, available: true })) })),
    inspectPartnerHomeTarget: (request, context) => invoke(context, async connection => {
      const selected = selection(request.destination), { runtime, home } = owner();
      const result = await runtime.inspect(connection, request.partnerId, selected);
      return create(contract.InspectPartnerHomeTargetResponseSchema, { identity: identity(request.partnerId, home.current(request.partnerId).generation),
        target: { destination: request.destination, deviceName: result.location.name, platform: result.platform, available: true },
        availability: contract.PartnerHomeTargetAvailability.READY, models: result.models.map(model) });
    }),
    movePartnerHome: (request, context) => invoke(context, async connection => {
      const { home, runtime } = owner(), expected = request.expectedHome;
      if (!expected || expected.authorityServerId !== runtime.authorityServerId || expected.generation < 1n || expected.generation > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new ConnectError("Refresh the Partner home before moving it.", Code.InvalidArgument);
      }
      const selected = selection(request.destination), previous = home.get(request.requestId);
      const same = previous && (selected ? previous.destination.kind === "device" && previous.destination.deviceId === selected.targetDeviceId
        && previous.destination.controllerDeviceId === connection.deviceId : previous.destination.kind === "service");
      const target = same ? previous.destination : (await runtime.inspect(connection, expected.partnerId, selected)).location;
      if (request.busyAction !== contract.PartnerHomeBusyAction.WAIT && request.busyAction !== contract.PartnerHomeBusyAction.STOP) {
        throw new ConnectError("Choose whether to wait for or stop the current work.", Code.InvalidArgument);
      }
      const move = await home.move({ requestId: request.requestId, partnerId: expected.partnerId,
        expectedGeneration: Number(expected.generation), expectedPartnerRevision: fromProtoRevision(request.expectedPartnerRevision, "expected_partner_revision"),
        destination: target, capabilities: capabilities(request.capabilities), busyAction: request.busyAction === contract.PartnerHomeBusyAction.WAIT ? "wait" : "stop",
        continueWhenSourceOffline: request.continueWhenSourceOffline });
      return create(contract.MovePartnerHomeResponseSchema, { move: receipt(move) });
    }),
    getPartnerHomeMove: (request, context) => invoke(context, () => {
      const result = owner().home.get(request.requestId); if (!result) throw new ConnectError("Home change not found.", Code.NotFound);
      return create(contract.GetPartnerHomeMoveResponseSchema, { move: receipt(result) });
    }),
    retryPartnerHomeMove: (request, context) => invoke(context, () => {
      const { home } = owner(), existing = home.get(request.requestId);
      if (!existing) throw new ConnectError("Home change not found.", Code.NotFound);
      void home.retry(request.requestId).catch(() => undefined);
      return create(contract.RetryPartnerHomeMoveResponseSchema, { move: receipt(home.get(request.requestId)!) });
    }),
  };
}
function selection(value: contract.PartnerHomeDestination | undefined): DevicePeerSelectionIdentity | undefined {
  if (value?.location.case === "serviceNode" && value.location.value) return undefined;
  if (value?.location.case !== "peer") throw new ConnectError("Choose an execution computer.", Code.InvalidArgument);
  const peer = value.location.value;
  if (peer.routeGeneration < 1n || peer.routeGeneration > BigInt(Number.MAX_SAFE_INTEGER)) throw new ConnectError("Refresh the execution computers.", Code.InvalidArgument);
  return { targetDeviceId: peer.targetDeviceId, relationId: peer.relationId,
    targetDeviceRevision: fromProtoRevision(peer.targetDeviceRevision, "target_device_revision"), relationRevision: fromProtoRevision(peer.relationRevision, "relation_revision"),
    routeGeneration: Number(peer.routeGeneration) };
}
function destination(value?: DevicePeerSelectionIdentity): contract.PartnerHomeDestination {
  return create(contract.PartnerHomeDestinationSchema, { location: value ? { case: "peer", value: { targetDeviceId: value.targetDeviceId,
    relationId: value.relationId, targetDeviceRevision: toProtoRevision(value.targetDeviceRevision), relationRevision: toProtoRevision(value.relationRevision),
    routeGeneration: BigInt(value.routeGeneration) } } : { case: "serviceNode", value: true } });
}
function capabilities(value: contract.PartnerCapabilities | undefined): PartnerCapabilitiesRecord {
  if (!value || ![contract.PermissionMode.ASK, contract.PermissionMode.ACCEPT_EDITS, contract.PermissionMode.AUTO, contract.PermissionMode.BYPASS_PERMISSIONS].includes(value.permissionMode)) {
    throw new ConnectError("Select a model and permissions for the new computer.", Code.InvalidArgument);
  }
  return { modelChain: value.modelChain.map(route => ({ backendId: route.backendId, providerId: route.providerId, modelId: route.modelId,
    ...(route.effort === undefined ? {} : { effort: route.effort }), fastMode: contract.decodeModelSpeed(route) })),
    permissionMode: value.permissionMode === contract.PermissionMode.ASK ? "ask" : value.permissionMode === contract.PermissionMode.ACCEPT_EDITS ? "acceptEdits" : value.permissionMode === contract.PermissionMode.AUTO ? "auto" : "bypassPermissions",
    planMode: value.planMode, inputHandoff: value.inputHandoff ?? true };
}
function model(value: PartnerHomeModel): contract.PartnerHomeModelChoice {
  return create(contract.PartnerHomeModelChoiceSchema, { route: { ...value.route, ...contract.encodeModelSpeed(value.route.fastMode) }, displayName: value.displayName, canSetPlanMode: value.canSetPlanMode,
    permissionModes: value.permissionModes.map(mode => mode === "ask" ? contract.PermissionMode.ASK : mode === "acceptEdits" ? contract.PermissionMode.ACCEPT_EDITS : mode === "auto" ? contract.PermissionMode.AUTO : contract.PermissionMode.BYPASS_PERMISSIONS) });
}
