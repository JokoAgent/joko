import { createClient, ConnectError, Code, type Transport } from "@connectrpc/connect";
import {
  createTaskSharingApi, TASK_SHARE_METHODS, TASK_SHARE_ATTACHMENT_CHUNK_BYTES, TaskSharingService, TaskShareMethod, ActorKind,
  type TaskSharingApi, type TaskSharingRpc, type TaskShareCallableMethod,
  type JoinedTaskShare, type Snapshot, type Operation
} from "@joko/contracts";
import type { TaskSharingGatewayPort } from "./gateway.js";
import { randomUuid, sha256Hex } from "./web-crypto.js";
import { canOpenJoinedTask } from "./task-sharing.js";

export function createWebTaskSharingApi(transport: Transport, lifetime: AbortSignal, current: () => boolean): TaskSharingApi {
  const client = createClient(TaskSharingService, transport);
  const rpc = Object.fromEntries(Object.entries(client).map(([key, method]) => [key,
    (request: never, options: { readonly signal: AbortSignal }) => method(request, {
      signal: AbortSignal.any([lifetime, options.signal])
    })
  ])) as TaskSharingRpc;
  return createTaskSharingApi({ rpc, assertCurrent(signal) {
    signal.throwIfAborted(); lifetime.throwIfAborted();
    if (!current()) throw new ConnectError("The Home connection changed.", Code.Canceled);
  } });
}

export function createJoinedTaskPort(api: TaskSharingApi, joined: JoinedTaskShare, lifetime: AbortSignal, operations: TaskSharingGatewayPort["operations"]): TaskSharingGatewayPort {
  const share = joined.share, member = joined.member;
  if (!share || !member || !canOpenJoinedTask(joined.status) || share.status !== "active" || member.status !== "active") {
    throw new ConnectError("This shared task is unavailable.", Code.PermissionDenied);
  }
  const signalFor = (signal?: AbortSignal): AbortSignal => signal ? AbortSignal.any([lifetime, signal]) : lifetime;
  const verify = (snapshot: Snapshot): Snapshot => {
    if (snapshot.server?.serverId !== share.hostServerId || snapshot.sessions.length !== 1
      || snapshot.sessions[0]?.sessionId !== share.sessionId || snapshot.scope?.kind.case !== "session"
      || snapshot.scope.kind.value.sessionId !== share.sessionId) {
      throw new ConnectError("The shared task projection changed owner.", Code.PermissionDenied);
    }
    return snapshot;
  };
  const transport: Transport = {
    async unary(method, signal, _timeout, _headers, input) {
      const entry = Object.entries(TASK_SHARE_METHODS).find(([, descriptor]) =>
        descriptor.parent.typeName === method.parent.typeName && descriptor.name === method.name);
      if (!entry) throw new ConnectError("This action is unavailable for a shared task.", Code.PermissionDenied);
      const message = await api.invoke(joined.joinId, Number(entry[0]) as TaskShareCallableMethod, input as never, signalFor(signal));
      if ([TaskShareMethod.SUBMIT_OPERATION, TaskShareMethod.GET_OPERATION].includes(Number(entry[0]))) {
        const operation = (message as { readonly operation?: Operation }).operation;
        const expectedId = (input as { readonly operationId?: string }).operationId;
        const author = operation?.sharedTaskAuthor;
        if (!operation || operation.operationId !== expectedId || operation.connectionId !== ""
          || operation.actor?.kind !== ActorKind.TASK_PARTICIPANT || operation.actor.id !== member.memberId
          || author?.shareId !== share.shareId || author.shareGeneration !== share.shareGeneration
          || author.sessionId !== share.sessionId || author.memberId !== member.memberId || author.memberGeneration !== member.memberGeneration) {
          throw new ConnectError("The shared task operation receipt changed owner.", Code.PermissionDenied);
        }
      }
      return { stream: false, service: method.parent, method, header: new Headers(), message: message as never, trailer: new Headers() };
    },
    async stream() { throw new ConnectError("Shared tasks use finite event batches.", Code.PermissionDenied); }
  };
  return {
    operations,
    scopeKey: JSON.stringify([joined.joinId, share.hostServerId, share.shareId, share.shareGeneration.toString(), share.sessionId, member.memberId, member.memberGeneration.toString()]),
    transport,
    async snapshot(signal) {
      const state = await api.snapshot(joined.joinId, signalFor(signal));
      if (state.share?.shareId !== share.shareId || state.share.shareGeneration !== share.shareGeneration
        || state.member?.memberId !== member.memberId || state.member.memberGeneration !== member.memberGeneration
        || state.share.status !== "active" || state.member.status !== "active" || !state.snapshot) {
        throw new ConnectError("Access to this shared task changed.", Code.PermissionDenied);
      }
      return verify(state.snapshot);
    },
    events(after, signal) { return api.events({ joinId: joined.joinId, after, limit: 128 }, signalFor(signal)); },
    async upload(file, signal) {
      const owned = signalFor(signal), bytes = new Uint8Array(await file.arrayBuffer());
      owned.throwIfAborted();
      if (bytes.byteLength > 20 * 1024 * 1024) throw new Error("This attachment exceeds the shared task transfer limit.");
      const begun = await api.transfer({ joinId: joined.joinId, transfer: { action: { case: "begin", value: {
        operationId: randomUuid(), name: file.name, mediaType: file.type || "application/octet-stream",
        sizeBytes: BigInt(bytes.byteLength), sha256Hex: await sha256Hex(bytes.buffer)
      } } } }, owned);
      let offset = 0;
      do {
        const end = Math.min(offset + TASK_SHARE_ATTACHMENT_CHUNK_BYTES, bytes.byteLength);
        const result = await api.transfer({ joinId: joined.joinId, transfer: { action: { case: "write", value: {
          ticketId: begun.ticketId, offset: BigInt(offset), data: bytes.slice(offset, end), finish: end === bytes.byteLength
        } } } }, owned);
        if (result.offset !== BigInt(end)) throw new Error("The attachment transfer did not acknowledge this chunk.");
        if (end === bytes.byteLength) {
          if (!result.complete || !result.blob) throw new Error("The attachment was not committed.");
          return result.blob as unknown as Record<string, unknown>;
        }
        offset = end;
      } while (offset < bytes.byteLength);
      throw new Error("The attachment was not committed.");
    },
    async download(blobId, signal) {
      const owned = signalFor(signal), chunks: Uint8Array<ArrayBuffer>[] = [];
      let offset = 0n;
      for (let count = 0; count < 128; count++) {
        const result = await api.transfer({ joinId: joined.joinId, transfer: { action: { case: "read", value: {
          blobId, offset, maximumBytes: TASK_SHARE_ATTACHMENT_CHUNK_BYTES
        } } } }, owned);
        if (result.offset !== offset + BigInt(result.data.byteLength) || result.data.byteLength > TASK_SHARE_ATTACHMENT_CHUNK_BYTES) throw new Error("The attachment transfer is incomplete.");
        chunks.push(Uint8Array.from(result.data)); offset = result.offset;
        if (offset > 20n * 1024n * 1024n) throw new Error("This attachment exceeds the shared task transfer limit.");
        if (result.complete) {
          const blob = new Blob(chunks, { type: result.blob?.mediaType || "application/octet-stream" });
          if (!result.blob || result.blob.byteSize !== BigInt(blob.size)
            || await sha256Hex(await blob.arrayBuffer()) !== result.blob.sha256Hex) throw new Error("The attachment identity could not be verified.");
          owned.throwIfAborted(); return blob;
        }
        if (result.data.byteLength === 0) throw new Error("The attachment transfer stopped making progress.");
      }
      throw new Error("The attachment transfer did not finish.");
    }
  };
}
