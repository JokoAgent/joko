import { createClient, type Transport } from "@connectrpc/connect";
import { base64Encode } from "@bufbuild/protobuf/wire";
import { InputHandoffService, InputHandoffDecisionKind, type CredentialUploadTicket, type DevicePeerRouteIdentity } from "@joko/contracts";
import { inputHandoffPresentationDigest, inputHandoffSnapshotFromProto, type InputHandoffApi } from "./input-handoff.js";

export function createInputHandoffGateway(options: {
  readonly transport: Transport;
  readonly signal: AbortSignal;
  readonly assertCurrent: () => void;
  readonly upload: (value: string, ticket: CredentialUploadTicket | undefined, signal: AbortSignal) => Promise<string>;
  readonly openLive?: (peer: DevicePeerRouteIdentity, requestId: string, signal: AbortSignal) => Promise<void>;
}): InputHandoffApi {
  const client = createClient(InputHandoffService, options.transport);
  const invoke = async <T>(signal: AbortSignal | undefined, work: (active: AbortSignal) => Promise<T>): Promise<T> => {
    const active = signal ? AbortSignal.any([signal, options.signal]) : options.signal;
    active.throwIfAborted(); options.assertCurrent(); const value = await work(active);
    active.throwIfAborted(); options.assertCurrent(); return value;
  };
  const kinds = { done: InputHandoffDecisionKind.DONE, cancel: InputHandoffDecisionKind.CANCEL, stay: InputHandoffDecisionKind.STAY,
    refresh: InputHandoffDecisionKind.REFRESH, claim: InputHandoffDecisionKind.CLAIM, picture: InputHandoffDecisionKind.PICTURE };
  return {
    listInputHandoffs: (sessionId, signal) => invoke(signal, async active => (await client.listInputHandoffs({ sessionId }, { signal: active })).states.map(inputHandoffSnapshotFromProto)),
    decideInputHandoff: (requestId, decision, signal) => invoke(signal, async active => (await client.decideInputHandoff({ requestId,
      expectedRevision: BigInt(decision.expectedRevision), decision: kinds[decision.action] }, { signal: active })).accepted),
    submitInputHandoff: (snapshot, submission, signal) => invoke(signal, async active => {
      if (submission.expectedRevision !== snapshot.revision) return false;
      const presentationSha256 = await inputHandoffPresentationDigest(snapshot); active.throwIfAborted(); options.assertCurrent();
      const ticket = await client.beginInputHandoffSubmission({ requestId: snapshot.requestId, expectedRevision: BigInt(snapshot.revision), presentationSha256 }, { signal: active });
      active.throwIfAborted(); options.assertCurrent();
      const credentialUploadTicketId = await options.upload(JSON.stringify(submission), ticket.ticket, active);
      active.throwIfAborted(); options.assertCurrent();
      return (await client.submitInputHandoff({ requestId: snapshot.requestId, expectedRevision: BigInt(snapshot.revision), credentialUploadTicketId }, { signal: active })).accepted;
    }),
    readInputHandoffPicture: (snapshot, signal) => invoke(signal, async active => {
      const presentationSha256 = await inputHandoffPresentationDigest(snapshot); active.throwIfAborted(); options.assertCurrent();
      const value = await client.readInputHandoffPicture({ requestId: snapshot.requestId, expectedRevision: BigInt(snapshot.revision), presentationSha256 }, { signal: active });
      return { mime: "image/jpeg", data: base64Encode(value.jpeg), width: value.width, height: value.height,
        ...(value.qrText === undefined ? {} : { qr: { text: value.qrText, ...(value.qrUrl === undefined ? {} : { url: value.qrUrl }) } }) };
    }),
    ...(options.openLive ? { openInputHandoffLiveView: (snapshot, signal) => invoke(signal, async active => {
      const presentationSha256 = await inputHandoffPresentationDigest(snapshot); active.throwIfAborted(); options.assertCurrent();
      const value = await client.openInputHandoffLiveView({ requestId: snapshot.requestId, expectedRevision: BigInt(snapshot.revision), presentationSha256 }, { signal: active });
      active.throwIfAborted(); options.assertCurrent();
      if (!value.peer || value.requestId !== snapshot.requestId) throw new Error("The input window changed.");
      await options.openLive!(value.peer, value.requestId, active);
    }) } : {})
  };
}
