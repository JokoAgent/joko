import { create, fromBinary, toBinary, type DescMessage, type MessageInitShape, type MessageShape } from "@bufbuild/protobuf";
import { ArtifactService, BackendService, InteractionService, OperationService, QueueService, RunService, SessionService, SubagentService } from "./gen/joko/v1/service_pb.js";
import { TaskSharingService, TaskShareRuntimeService } from "./gen/joko/v1/task_sharing_pb.js";
import { TaskShareMethod, type TaskShare, type TaskShareScope, type JoinedTaskShare } from "./gen/joko/v1/task_sharing_types_pb.js";

export interface TaskShareInvitation {
  readonly hostOrigin: string;
  readonly endpointPublicKey: string;
  readonly hostServerId: string;
  readonly shareId: string;
  readonly shareGeneration: bigint;
  readonly inviteSecret: string;
}
const identifier = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
export const TASK_SHARE_ATTACHMENT_CHUNK_BYTES = 256 * 1024;
export function taskShareEndpointPublicKey(value: string): string {
  if (typeof value !== "string" || !/^ed25519:[a-f0-9]{64}$/u.test(value)) throw new Error("The trusted endpoint public key is invalid or missing.");
  return value;
}
export function taskShareIdentity(value: string): string {
  if (!identifier.test(value)) throw new Error("The shared task identity is invalid.");
  return value;
}
export function taskShareOrigin(value: string): string {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.pathname !== "/"
    || url.search || url.hash || url.origin !== value) throw new Error("The shared task origin is invalid.");
  return url.origin;
}
/** Explicit clipboard/deep-link value only; never a navigation or draft key. */
export function buildTaskShareInvitation(input: TaskShareInvitation): string {
  taskShareOrigin(input.hostOrigin); taskShareIdentity(input.hostServerId); taskShareIdentity(input.shareId);
  taskShareEndpointPublicKey(input.endpointPublicKey);
  if (input.shareGeneration < 1n || !/^[A-Za-z0-9_-]{32,256}$/u.test(input.inviteSecret)) throw new Error("The shared task invitation is invalid.");
  return `joko://shared-task/join#${encodeURIComponent(JSON.stringify({ format: 1, hostOrigin: input.hostOrigin,
    hostServerId: input.hostServerId, endpointPublicKey: input.endpointPublicKey, shareId: input.shareId, shareGeneration: String(input.shareGeneration), inviteSecret: input.inviteSecret }))}`;
}
export function parseTaskShareInvitation(value: string): TaskShareInvitation {
  if (value.length > 8192 || value.trim() !== value) throw new Error("The shared task invitation is invalid.");
  const url = new URL(value);
  if (url.protocol !== "joko:" || url.hostname !== "shared-task" || url.pathname !== "/join" || url.username || url.password || url.port || url.search) throw new Error("The shared task invitation is invalid.");
  const row: unknown = JSON.parse(decodeURIComponent(url.hash.slice(1)));
  if (!row || typeof row !== "object" || Array.isArray(row)
    || Object.keys(row).sort().join(",") !== "endpointPublicKey,format,hostOrigin,hostServerId,inviteSecret,shareGeneration,shareId") throw new Error("The shared task invitation is invalid.");
  const item = row as Record<string, unknown>;
  if (item["format"] !== 1 || typeof item["hostOrigin"] !== "string" || typeof item["hostServerId"] !== "string"
    || typeof item["shareId"] !== "string" || typeof item["shareGeneration"] !== "string" || !/^[1-9]\d{0,19}$/u.test(item["shareGeneration"])
    || typeof item["inviteSecret"] !== "string" || typeof item["endpointPublicKey"] !== "string") throw new Error("The shared task invitation is invalid.");
  const result = { hostOrigin: taskShareOrigin(item["hostOrigin"]), hostServerId: taskShareIdentity(item["hostServerId"]),
    endpointPublicKey: taskShareEndpointPublicKey(item["endpointPublicKey"]), shareId: taskShareIdentity(item["shareId"]), shareGeneration: BigInt(item["shareGeneration"]), inviteSecret: item["inviteSecret"] };
  if (result.shareGeneration > 18446744073709551615n || !/^[A-Za-z0-9_-]{32,256}$/u.test(result.inviteSecret)) throw new Error("The shared task invitation is invalid.");
  return result;
}
export const TASK_SHARE_METHODS = {
  [TaskShareMethod.GET_SESSION]: SessionService.method.getSession,
  [TaskShareMethod.LIST_SESSION_TIMELINE]: SessionService.method.listSessionTimeline,
  [TaskShareMethod.SEARCH_SESSION_MESSAGES]: SessionService.method.searchSessionMessages,
  [TaskShareMethod.LIST_RUNS]: RunService.method.listRuns,
  [TaskShareMethod.GET_RUN]: RunService.method.getRun,
  [TaskShareMethod.LIST_QUEUE_ITEMS]: QueueService.method.listQueueItems,
  [TaskShareMethod.GET_QUEUE_CONTROL]: QueueService.method.getQueueControl,
  [TaskShareMethod.LIST_INTERACTIONS]: InteractionService.method.listInteractions,
  [TaskShareMethod.GET_INTERACTION]: InteractionService.method.getInteraction,
  [TaskShareMethod.GET_SESSION_STATISTICS]: SessionService.method.getSessionStatistics,
  [TaskShareMethod.LIST_BACKGROUND_TASKS]: SessionService.method.listBackgroundTasks,
  [TaskShareMethod.LIST_SUBAGENT_RUNS]: SubagentService.method.listSubagentRuns,
  [TaskShareMethod.GET_SUBAGENT_RUN]: SubagentService.method.getSubagentRun,
  [TaskShareMethod.LIST_SUBAGENT_TRANSCRIPT]: SubagentService.method.listSubagentTranscript,
  [TaskShareMethod.LIST_MODELS]: BackendService.method.listModels,
  [TaskShareMethod.LIST_PROVIDERS]: BackendService.method.listProviders,
  [TaskShareMethod.GET_BACKEND]: BackendService.method.getBackend,
  [TaskShareMethod.SUBMIT_OPERATION]: OperationService.method.submitOperation,
  [TaskShareMethod.GET_OPERATION]: OperationService.method.getOperation,
  [TaskShareMethod.LIST_ARTIFACTS]: ArtifactService.method.listArtifacts,
  [TaskShareMethod.GET_ARTIFACT]: ArtifactService.method.getArtifact,
  [TaskShareMethod.GET_RUNTIME_CONTROL]: TaskShareRuntimeService.method.getRuntimeControl,
  [TaskShareMethod.LIST_BACKENDS]: BackendService.method.listBackends,
  [TaskShareMethod.GET_BACKGROUND_TASK_OUTPUT]: SessionService.method.getBackgroundTaskOutput,
} as const;
export type TaskShareCallableMethod = keyof typeof TASK_SHARE_METHODS;
export function taskShareMethodDescriptor(method: TaskShareMethod) {
  if (!Object.hasOwn(TASK_SHARE_METHODS, method)) throw new Error("The shared task method is not allowed.");
  return TASK_SHARE_METHODS[method as TaskShareCallableMethod];
}
export function decodeTaskShareRequest(method: TaskShareMethod, bytes: Uint8Array) {
  if (bytes.byteLength > 4 * 1024 * 1024) throw new Error("The shared task request is too large.");
  return fromBinary(taskShareMethodDescriptor(method).input, bytes);
}
export function scopeForJoinedTask(joined: JoinedTaskShare): MessageInitShape<typeof import("./gen/joko/v1/task_sharing_types_pb.js").TaskShareScopeSchema> {
  const { share, member } = joined;
  if (!share || !member) throw new Error("The joined task owner is missing.");
  return { hostServerId: share.hostServerId, shareId: share.shareId, shareGeneration: share.shareGeneration,
    sessionId: share.sessionId, memberId: member.memberId, memberGeneration: member.memberGeneration };
}
export function assertTaskShareScope(scope: TaskShareScope, share: TaskShare, memberId: string, memberGeneration: bigint): void {
  if (scope.hostServerId !== share.hostServerId || scope.shareId !== share.shareId || scope.sessionId !== share.sessionId
    || scope.shareGeneration !== share.shareGeneration || scope.memberId !== memberId || scope.memberGeneration !== memberGeneration) throw new Error("The shared task owner changed.");
}
type RpcMethod<M extends { readonly input: DescMessage; readonly output: DescMessage }> =
  (request: MessageInitShape<M["input"]>, options: { readonly signal: AbortSignal }) => Promise<MessageShape<M["output"]>>;
export type TaskSharingRpc = { readonly [K in keyof typeof TaskSharingService.method]: RpcMethod<(typeof TaskSharingService.method)[K]> };
/** Generated-client-only facade shared by Web and Mobile. No credentials or DOM. */
export function createTaskSharingApi(input: { readonly rpc: TaskSharingRpc; readonly assertCurrent: (signal: AbortSignal) => void }) {
  const call = async <T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> => {
    signal.throwIfAborted(); input.assertCurrent(signal); const value = await work();
    signal.throwIfAborted(); input.assertCurrent(signal); return value;
  };
  const rpc = input.rpc;
  return {
    list: (signal: AbortSignal) => call(signal, () => rpc.listTaskShares({}, { signal })),
    get: (shareId: string, signal: AbortSignal) => call(signal, () => rpc.getTaskShare({ shareId }, { signal })),
    create: (operationId: string, sessionId: string, signal: AbortSignal) => call(signal, () => rpc.createTaskShare({ operationId, sessionId }, { signal })),
    invite: (operationId: string, shareId: string, signal: AbortSignal) => call(signal, () => rpc.createTaskShareInvitation({ operationId, shareId }, { signal })),
    remove: (operationId: string, shareId: string, memberId: string, memberGeneration: bigint, signal: AbortSignal) =>
      call(signal, () => rpc.removeTaskShareMember({ operationId, shareId, memberId, memberGeneration }, { signal })),
    end: (operationId: string, shareId: string, signal: AbortSignal) => call(signal, () => rpc.endTaskShare({ operationId, shareId }, { signal })),
    endAll: (operationId: string, shareIds: readonly string[], signal: AbortSignal) => call(signal, () => rpc.endAllTaskShares({ operationId, shareIds: [...shareIds] }, { signal })),
    preview: (invitation: string, signal: AbortSignal) => call(signal, () => rpc.previewTaskShareInvitation({ invitation }, { signal })),
    join: (operationId: string, invitation: string, displayName: string, signal: AbortSignal) => call(signal, () => rpc.joinTaskShare({ operationId, invitation, displayName }, { signal })),
    lookupJoin: (operationId: string, signal: AbortSignal) => call(signal, () => rpc.getTaskShareJoinIntent({ operationId }, { signal })),
    lookupAction: (operationId: string, signal: AbortSignal) => call(signal, async () => {
      const response = await rpc.getTaskSharingActionReceipt({ operationId }, { signal });
      if (!response.receipt || response.receipt.operationId !== operationId) throw new Error("The task action receipt is invalid."); return response.receipt;
    }),
    leave: (operationId: string, joinId: string, signal: AbortSignal) => call(signal, () => rpc.leaveTaskShare({ operationId, joinId }, { signal })),
    snapshot: (joinId: string, signal: AbortSignal) => call(signal, async () => {
      const response = await rpc.getJoinedTaskSnapshot({ joinId }, { signal });
      if (!response.state?.share || !response.state.member || !response.state.snapshot) throw new Error("The shared task snapshot is incomplete.");
      return response.state;
    }),
    events: (request: MessageInitShape<(typeof TaskSharingService.method.readJoinedTaskEvents)["input"]>, signal: AbortSignal) =>
      call(signal, async () => { const response = await rpc.readJoinedTaskEvents(request, { signal }); if (!response.batch) throw new Error("The shared task batch is missing."); return response.batch; }),
    transfer: (request: MessageInitShape<(typeof TaskSharingService.method.transferJoinedTaskAttachment)["input"]>, signal: AbortSignal) =>
      call(signal, async () => { const response = await rpc.transferJoinedTaskAttachment(request, { signal }); if (!response.result) throw new Error("The shared task transfer is missing."); return response.result; }),
    invoke: <M extends TaskShareCallableMethod>(joinId: string, method: M,
      request: MessageInitShape<(typeof TASK_SHARE_METHODS)[M]["input"]>, signal: AbortSignal): Promise<MessageShape<(typeof TASK_SHARE_METHODS)[M]["output"]>> =>
      call(signal, async () => {
        const descriptor = TASK_SHARE_METHODS[method];
        const response = await rpc.invokeJoinedTask({ joinId, method, requestBytes: toBinary(descriptor.input, create(descriptor.input, request)) }, { signal });
        return fromBinary(descriptor.output, response.responseBytes) as MessageShape<(typeof TASK_SHARE_METHODS)[M]["output"]>;
      })
  };
}
export type TaskSharingApi = ReturnType<typeof createTaskSharingApi>;
