import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, type HandlerContext, type ServiceImpl } from "@connectrpc/connect";
import * as contract from "@joko/contracts";
import type { ConnectionManager } from "./connection-manager.js";
import type { ConnectionRecord } from "@joko/store";
import type { DevicePeerOwner } from "./device-peer-owner.js";
import type { NativeInputHandoffHost } from "./input-handoff/native-host.js";
import { toProtoRevision } from "./proto-mapper.js";
import type { InputHandoffCoordinator, InputHandoffOwner } from "./input-handoff/coordinator.js";

export function createInputHandoffConnectService(options: {
  readonly coordinator: InputHandoffCoordinator;
  readonly connections: ConnectionManager;
  readonly peers: DevicePeerOwner;
  readonly native: NativeInputHandoffHost;
}): ServiceImpl<typeof contract.InputHandoffService> {
  const owner = (context: HandlerContext): InputHandoffOwner & { readonly connection: ConnectionRecord } => {
    context.signal.throwIfAborted();
    try {
      const connection = options.connections.authenticate(context.requestHeader.get("authorization") ?? undefined);
      return { connection, connectionId: connection.id, deviceId: connection.deviceId,
        assertCurrent: () => { options.connections.fence(connection); },
        onRevoked: listener => options.connections.onRevoked(connection.id, listener) };
    } catch { throw new ConnectError("The current computer owner must authorize input handoff.", Code.Unauthenticated); }
  };
  const invoke = async <T>(context: HandlerContext, action: (actor: InputHandoffOwner & { readonly connection: ConnectionRecord }) => T | Promise<T>): Promise<T> => {
    const actor = owner(context);
    try { actor.assertCurrent(); const result = await action(actor); actor.assertCurrent(); context.signal.throwIfAborted(); return result; }
    catch (error) {
      if (error instanceof ConnectError) throw error;
      if (context.signal.aborted) throw new ConnectError("Input handoff was cancelled.", Code.Canceled);
      throw new ConnectError("This input handoff step is no longer available.", Code.FailedPrecondition);
    }
  };
  const identity = (value: string): string => { if (!value || value.length > 512 || /[\0\r\n]/u.test(value)) throw new ConnectError("Invalid input handoff identity.", Code.InvalidArgument); return value; };
  const revision = (value: bigint): number => { const number = Number(value); if (!Number.isSafeInteger(number) || number < 1) throw new ConnectError("Invalid input handoff revision.", Code.InvalidArgument); return number; };
  const duringRequest = (actor: InputHandoffOwner, context: HandlerContext): InputHandoffOwner => ({ ...actor,
    assertCurrent: () => { context.signal.throwIfAborted(); actor.assertCurrent(); } });
  const kinds = new Map<contract.InputHandoffDecisionKind, contract.InputHandoffDecision["action"]>([
    [contract.InputHandoffDecisionKind.DONE, "done"], [contract.InputHandoffDecisionKind.CANCEL, "cancel"],
    [contract.InputHandoffDecisionKind.STAY, "stay"], [contract.InputHandoffDecisionKind.REFRESH, "refresh"],
    [contract.InputHandoffDecisionKind.CLAIM, "claim"], [contract.InputHandoffDecisionKind.PICTURE, "picture"]
  ]);
  return {
    listInputHandoffTasks: (_request, context) => invoke(context, () => create(contract.ListInputHandoffTasksResponseSchema, {
      tasks: options.coordinator.taskSummaries().map(value => ({ sessionId: value.sessionId, generation: BigInt(value.generation),
        requestId: value.snapshot.requestId, stepNumber: value.snapshot.stepNumber }))
    })),
    listInputHandoffs: (request, context) => invoke(context, actor => {
      const nativeDeviceId = options.native.currentDeviceId();
      const canView = nativeDeviceId && options.peers.listForCapabilities(actor.connection, ["remote_desktop"]).some(peer => peer.targetDeviceId === nativeDeviceId);
      return create(contract.ListInputHandoffsResponseSchema, { states: options.coordinator.list(identity(request.sessionId))
        .map(value => { const { liveView, ...rest } = value; return inputHandoffState({ ...rest, ...(liveView && canView ? { liveView: true as const } : {}) }); }) });
    }),
    decideInputHandoff: (request, context) => invoke(context, async actor => {
      const action = kinds.get(request.decision); if (!action) throw new ConnectError("Invalid input handoff decision.", Code.InvalidArgument);
      return create(contract.DecideInputHandoffResponseSchema, { accepted: await options.coordinator.decide(identity(request.requestId),
        { kind: "input_handoff", action, expectedRevision: revision(request.expectedRevision) }, duringRequest(actor, context)) });
    }),
    beginInputHandoffSubmission: (request, context) => invoke(context, actor => {
      const ticket = options.coordinator.beginSubmission(identity(request.requestId), revision(request.expectedRevision), request.presentationSha256, actor);
      return create(contract.BeginInputHandoffSubmissionResponseSchema, { ticket: { ticketId: ticket.credentialUploadTicketId,
        relativeEndpoint: `/v1/credentials/upload/${encodeURIComponent(ticket.credentialUploadTicketId)}`,
        expiresAt: { seconds: BigInt(Math.floor(ticket.expiresAt / 1000)), nanos: ticket.expiresAt % 1000 * 1_000_000 }, maximumBytes: BigInt(ticket.maximumBytes) } });
    }),
    submitInputHandoff: (request, context) => invoke(context, async actor => create(contract.SubmitInputHandoffResponseSchema, {
      accepted: await options.coordinator.submit(identity(request.requestId), revision(request.expectedRevision), identity(request.credentialUploadTicketId), duringRequest(actor, context))
    })),
    readInputHandoffPicture: (request, context) => invoke(context, actor => {
      const picture = options.coordinator.picture(identity(request.requestId), revision(request.expectedRevision), request.presentationSha256, actor);
      if (!picture) throw new ConnectError("The current input handoff picture is unavailable.", Code.NotFound);
      return create(contract.ReadInputHandoffPictureResponseSchema, { jpeg: Buffer.from(picture.data, "base64"), width: picture.width, height: picture.height,
        ...(picture.qr ? { qrText: picture.qr.text, ...(picture.qr.url ? { qrUrl: picture.qr.url } : {}) } : {}) });
    }),
    openInputHandoffLiveView: (request, context) => invoke(context, actor => {
      const requestId = identity(request.requestId), deviceId = options.native.currentDeviceId();
      if (!deviceId) throw new ConnectError("The original computer is unavailable.", Code.Unavailable);
      const peer = options.peers.listForCapabilities(actor.connection, ["remote_desktop"]).find(value => value.targetDeviceId === deviceId);
      if (!peer || !options.coordinator.authorizeLiveView(requestId, revision(request.expectedRevision), request.presentationSha256, actor)) {
        throw new ConnectError("This input window is unavailable.", Code.FailedPrecondition);
      }
      options.peers.capture(actor.connection, peer, ["remote_desktop"]).assertCurrent();
      return create(contract.OpenInputHandoffLiveViewResponseSchema, { requestId, peer: {
        targetDeviceId: peer.targetDeviceId, targetDeviceRevision: toProtoRevision(peer.targetDeviceRevision),
        relationId: peer.relationId, relationRevision: toProtoRevision(peer.relationRevision), routeGeneration: BigInt(peer.routeGeneration)
      } });
    })
  };
}

export function inputHandoffState(value: contract.InputHandoffSnapshot): contract.InputHandoffState {
  const phases: Record<contract.InputHandoffPhase, contract.InputHandoffStatePhase> = {
    reading: contract.InputHandoffStatePhase.READING, ready: contract.InputHandoffStatePhase.READY, working: contract.InputHandoffStatePhase.WORKING,
    finishing: contract.InputHandoffStatePhase.FINISHING, succeeded: contract.InputHandoffStatePhase.SUCCEEDED, cancelled: contract.InputHandoffStatePhase.CANCELLED,
    failed: contract.InputHandoffStatePhase.FAILED, expired: contract.InputHandoffStatePhase.EXPIRED
  };
  return create(contract.InputHandoffStateSchema, { requestId: value.requestId, revision: BigInt(value.revision), phase: phases[value.phase], purpose: value.purpose,
    ...(value.note === undefined ? {} : { note: value.note }), ...(value.holder ? { holder: { ...value.holder, local: value.holder.local === true } } : {}),
    ...(value.requester === undefined ? {} : { requester: value.requester }), ...(value.command === undefined ? {} : { command: value.command }),
    source: value.source, stepNumber: value.stepNumber, controls: value.controls.map(control => ({ id: control.id, control: control.kind === "text"
      ? { case: "text" as const, value: { label: control.label, contentType: control.contentType, ...(control.placeholder === undefined ? {} : { placeholder: control.placeholder }),
          multiline: control.multiline === true, filled: control.filled === true, suggestions: [...control.suggestions ?? []] } }
      : { case: "errorNote" as const, value: control.text } })),
    ...(value.finishingUntil === undefined ? {} : { finishingUntilMs: BigInt(value.finishingUntil) }), ...(value.failure === undefined ? {} : { failure: value.failure }),
    agentControlled: value.agentControlled === true, remoteInput: value.remoteInput === true, terminal: value.terminal === true, picture: value.picture === true,
    liveView: value.liveView === true, ...(value.deviceCode ? { deviceCode: value.deviceCode } : {}), ...(value.qr ? { qr: value.qr } : {}) });
}
