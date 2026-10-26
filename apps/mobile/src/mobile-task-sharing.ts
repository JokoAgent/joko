import { Code, ConnectError, createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@joko/connection-transport";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import {
  ActorKind, TaskSharingService, TaskShareMethod, OperationState, SessionMessageSearchSemanticMode,
  createTaskSharingApi, type TaskSharingApi, type TaskSharingRpc, type JoinedTaskShare,
  type Snapshot, type SharedTaskAuthor, type Operation, type BlobRef
} from "@joko/contracts";
import type { MobileNetwork, PairedCredential } from "./network";

export interface MobileJoinedTaskSource {
  readonly kind: "joined";
  readonly homeProfileId: string;
  readonly homeServerId: string;
  readonly homeOrigin: string;
  readonly joined: JoinedTaskShare;
}
export type MobileTaskSource = { readonly kind: "own" } | MobileJoinedTaskSource;

export function mobileSharedTaskDraftProfileId(homeProfileId: string, homeServerId: string, homeOrigin: string, joinId: string): string {
  return `shared-${bytesToHex(sha256(new TextEncoder().encode(JSON.stringify([homeProfileId, homeServerId, homeOrigin, joinId]))))}`;
}

export function mobileTaskSharingApi(credential: PairedCredential, current: () => boolean): TaskSharingApi {
  const rpc = createClient(TaskSharingService, createConnectTransport({ baseUrl: credential.origin,
    endpointPublicKey: credential.endpointPublicKey,
    transportKind: credential.transportKind ?? 'https',
    useBinaryFormat: true, interceptors: [next => async request => {
      request.header.set("authorization", `Bearer ${credential.authKey}`); return next(request);
    }] }));
  return createTaskSharingApi({ rpc: rpc as TaskSharingRpc, assertCurrent(signal) {
    signal.throwIfAborted(); if (!current()) throw new ConnectError("The Home connection changed.", Code.Canceled);
  } });
}

export function assertMobileSharedTaskSnapshot(source: MobileJoinedTaskSource, snapshot: Snapshot): void {
  const share = source.joined.share, member = source.joined.member;
  if (!share || !member || !["active", "disconnected"].includes(source.joined.status) || share.status !== "active" || member.status !== "active"
    || snapshot.server?.serverId !== share.hostServerId || snapshot.scope?.kind.case !== "session"
    || snapshot.scope.kind.value.sessionId !== share.sessionId || snapshot.sessions.length !== 1
    || snapshot.sessions[0]?.sessionId !== share.sessionId) {
    throw new ConnectError("Access to this shared task changed.", Code.PermissionDenied);
  }
}

export function mobileSharedTaskAuthorMatches(source: MobileJoinedTaskSource, author: SharedTaskAuthor | undefined): boolean {
  const share = source.joined.share, member = source.joined.member;
  return !!share && !!member && !!author && author.shareId === share.shareId && author.sessionId === share.sessionId
    && author.shareGeneration === share.shareGeneration && author.memberId === member.memberId
    && author.memberGeneration === member.memberGeneration;
}

export function assertMobileSharedTaskOperation(source: MobileJoinedTaskSource, operationId: string, operation: Operation): void {
  if (operation.operationId !== operationId || operation.connectionId !== ""
    || !mobileSharedTaskAuthorMatches(source, operation.sharedTaskAuthor)
    || operation.actor?.kind !== ActorKind.TASK_PARTICIPANT || operation.actor.id !== source.joined.member?.memberId) {
    throw new ConnectError("The shared task receipt belongs to another participant.", Code.PermissionDenied);
  }
}

/** Closed task surface: no method falls through to the ordinary Home network. */
export function mobileJoinedTaskNetwork(api: TaskSharingApi, source: MobileJoinedTaskSource,
  lifetime: AbortSignal, newId: () => string): MobileNetwork {
  const share = source.joined.share!;
  const signalFor = (signal?: AbortSignal) => signal ? AbortSignal.any([lifetime, signal]) : lifetime;
  const exact = (sessionId: string) => {
    lifetime.throwIfAborted();
    if (sessionId !== share.sessionId) throw new ConnectError("This task belongs to another source.", Code.PermissionDenied);
  };
  const operation = async (id: string, signal?: AbortSignal) => {
    const result = await api.invoke(source.joined.joinId, TaskShareMethod.GET_OPERATION, { operationId: id }, signalFor(signal));
    if (result.operation) assertMobileSharedTaskOperation(source, id, result.operation);
    return result.operation;
  };
  const surface: Partial<MobileNetwork> = {
    async readSession(_credential, sessionId, signal) {
      exact(sessionId);
      const response = await api.snapshot(source.joined.joinId, signalFor(signal));
      if (response.share?.shareId !== share.shareId || response.share.shareGeneration !== share.shareGeneration
        || response.member?.memberId !== source.joined.member?.memberId
        || response.member?.memberGeneration !== source.joined.member?.memberGeneration
        || response.share.status !== "active" || response.member?.status !== "active" || !response.snapshot) {
        throw new ConnectError("Access to this shared task ended.", Code.PermissionDenied);
      }
      assertMobileSharedTaskSnapshot(source, response.snapshot); return response.snapshot;
    },
    async readTaskHeaderRole(_credential, sessionId) { exact(sessionId); return "ordinary"; },
    async readHistory(_credential, sessionId, before, signal) {
      exact(sessionId); const response = await api.invoke(source.joined.joinId, TaskShareMethod.LIST_SESSION_TIMELINE,
        { sessionId, limit: 120, beforeCursor: before }, signalFor(signal));
      return { events: response.events, before: response.nextBeforeCursor };
    },
    async readAround(_credential, sessionId, eventId, signal) {
      exact(sessionId); return (await api.invoke(source.joined.joinId, TaskShareMethod.LIST_SESSION_TIMELINE,
        { sessionId, aroundEventId: eventId, limit: 120 }, signalFor(signal))).events;
    },
    async searchSessionMessages(_credential, query, status, signal) {
      const response = await api.invoke(source.joined.joinId, TaskShareMethod.SEARCH_SESSION_MESSAGES,
        { scope: { case: "sessionId", value: share.sessionId }, query,
          semanticMode: SessionMessageSearchSemanticMode.UNSPECIFIED, filters: { sessionStatus: status }, page: { pageSize: 100 } }, signalFor(signal));
      return response.matches;
    },
    async listBackgroundTasks(_credential, sessionId, pageToken = "", signal) {
      exact(sessionId); const response = await api.invoke(source.joined.joinId, TaskShareMethod.LIST_BACKGROUND_TASKS,
        { sessionId, page: { pageToken, pageSize: 100 } }, signalFor(signal));
      return { tasks: response.backgroundTasks, nextPageToken: response.page?.nextPageToken ?? "" };
    },
    async readBackgroundTaskOutput(_credential, sessionId, backgroundTaskId, signal) {
      exact(sessionId); const response = await api.invoke(source.joined.joinId, TaskShareMethod.GET_BACKGROUND_TASK_OUTPUT,
        { sessionId, backgroundTaskId, maximumBytes: 16_384 }, signalFor(signal));
      if (!response.output || response.output.sessionId !== sessionId || response.output.backgroundTaskId !== backgroundTaskId) throw new Error("The background output changed owner.");
      return response.output;
    },
    async listSubagentRuns(_credential, sessionId, pageToken = "", signal) {
      exact(sessionId); const response = await api.invoke(source.joined.joinId, TaskShareMethod.LIST_SUBAGENT_RUNS,
        { sessionId, page: { pageToken, pageSize: 100 } }, signalFor(signal));
      return { runs: response.runs, nextPageToken: response.page?.nextPageToken ?? "" };
    },
    async getSubagentRun(_credential, sessionId, runId, signal) {
      exact(sessionId); const response = await api.invoke(source.joined.joinId, TaskShareMethod.GET_SUBAGENT_RUN,
        { sessionId, subagentRunId: runId }, signalFor(signal));
      if (!response.run?.run || response.run.run.sessionId !== sessionId || response.run.run.subagentRunId !== runId) throw new Error("The delegated run changed owner.");
      return response.run;
    },
    async listSubagentTranscript(_credential, sessionId, runId, childId = "", pageToken = "", signal) {
      exact(sessionId); const response = await api.invoke(source.joined.joinId, TaskShareMethod.LIST_SUBAGENT_TRANSCRIPT,
        { sessionId, subagentRunId: runId, childId, page: { pageToken, pageSize: 200 } }, signalFor(signal));
      return { entries: response.entries, nextPageToken: response.page?.nextPageToken ?? "", tailPageToken: response.tailPageToken };
    },
    async listSessionArtifacts(_credential, sessionId, signal) {
      exact(sessionId); const response = await api.invoke(source.joined.joinId, TaskShareMethod.LIST_ARTIFACTS,
        { sessionId, page: { pageSize: 100 } }, signalFor(signal));
      return { artifacts: response.artifacts, generation: 0n, revision: "" } as Awaited<ReturnType<MobileNetwork["listSessionArtifacts"]>>;
    },
    async submit(_credential, operationId, mutation, signal) {
      const response = await api.invoke(source.joined.joinId, TaskShareMethod.SUBMIT_OPERATION,
        { operationId, mutation }, signalFor(signal));
      if (!response.operation) throw new Error("The shared task did not return an operation receipt.");
      assertMobileSharedTaskOperation(source, operationId, response.operation); return response.operation;
    },
    async getOperation(_credential, operationId, signal) { return operation(operationId, signal); },
    async waitOperation(_credential, operationId, signal) {
      const owned = signalFor(signal);
      for (;;) {
        const result = await operation(operationId, owned);
        if (result && [OperationState.SUCCEEDED, OperationState.FAILED, OperationState.CANCELLED, OperationState.CONFLICT].includes(result.state)) return result;
        await mobileTaskSharingDelay(500, owned);
      }
    },
    async uploadBlob(_credential, input, signal) {
      const { File } = await import("expo-file-system");
      const owned = signalFor(signal), bytes = await new File(input.uri).bytes(); owned.throwIfAborted();
      if (bytes.length !== input.byteSize || bytes.length > 20 * 1024 * 1024 || bytesToHex(sha256(bytes)) !== input.sha256Hex) throw new Error("The attachment changed before transfer.");
      const begin = await api.transfer({ joinId: source.joined.joinId, transfer: { action: { case: "begin", value: {
        operationId: newId(), name: input.fileName, mediaType: input.mediaType, sizeBytes: BigInt(bytes.length), sha256Hex: input.sha256Hex
      } } } }, owned);
      for (let offset = 0; offset <= bytes.length;) {
        const end = Math.min(offset + 256 * 1024, bytes.length);
        const result = await api.transfer({ joinId: source.joined.joinId, transfer: { action: { case: "write", value: {
          ticketId: begin.ticketId, offset: BigInt(offset), data: bytes.slice(offset, end), finish: end === bytes.length
        } } } }, owned);
        if (result.offset !== BigInt(end)) throw new Error("The attachment acknowledgement is incomplete.");
        if (end === bytes.length) {
          if (!result.complete || !result.blob) throw new Error("The attachment was not committed.");
          return result.blob;
        }
        offset = end;
      }
      throw new Error("The attachment was not committed.");
    },
    async downloadBlob(_credential, blob, signal) { return downloadSharedBlob(api, source, blob, signalFor(signal)); },
    async readImageThumbnail() { return undefined; }
  };
  return surface as MobileNetwork;
}

async function downloadSharedBlob(api: TaskSharingApi, source: MobileJoinedTaskSource, blob: BlobRef, signal: AbortSignal) {
  const parts: Uint8Array[] = []; let offset = 0n;
  if (blob.byteSize > 20n * 1024n * 1024n || blob.byteSize < 0n) throw new Error("The shared attachment exceeds the transfer limit.");
  do {
    const result = await api.transfer({ joinId: source.joined.joinId, transfer: { action: { case: "read", value: {
      blobId: blob.blobId, offset, maximumBytes: 256 * 1024
    } } } }, signal);
    if (result.offset !== offset + BigInt(result.data.length) || result.data.length > 256 * 1024 || result.offset > blob.byteSize) throw new Error("The attachment chunk is invalid.");
    parts.push(result.data); offset = result.offset;
    if (result.complete) {
      if (!result.blob || result.blob.blobId !== blob.blobId || result.blob.sha256Hex !== blob.sha256Hex || offset !== blob.byteSize) throw new Error("The attachment identity changed.");
      const bytes = new Uint8Array(Number(offset)); let written = 0;
      for (const part of parts) { bytes.set(part, written); written += part.length; }
      if (bytesToHex(sha256(bytes)) !== blob.sha256Hex) throw new Error("The attachment digest is invalid.");
      signal.throwIfAborted(); return { bytes, mediaType: blob.mediaType };
    }
    if (result.data.length === 0) throw new Error("The attachment transfer stopped.");
  } while (offset <= blob.byteSize);
  throw new Error("The attachment transfer is incomplete.");
}

export function mobileTaskSharingDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const abort = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); reject(new ConnectError("The task observation retired.", Code.Canceled)); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });
}
