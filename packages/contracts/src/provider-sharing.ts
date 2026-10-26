import type { DescMessage, MessageInitShape, MessageShape } from "@bufbuild/protobuf";
import { ProviderSharingService } from "./gen/joko/v1/provider_sharing_pb.js";
import { taskShareEndpointPublicKey, taskShareOrigin } from "./task-sharing.js";

export const PROVIDER_SHARING_LINK_PATH = "/provider-share/join";
export function buildProviderSharingLink(origin: string, secret: string, endpointPublicKey: string): string {
  if (!/^[A-Za-z0-9_-]{43}$/u.test(secret)) throw new Error("The Provider invitation is invalid.");
  return `${taskShareOrigin(origin)}${PROVIDER_SHARING_LINK_PATH}#${encodeURIComponent(JSON.stringify({ format: 1, secret, endpointPublicKey: taskShareEndpointPublicKey(endpointPublicKey) }))}`;
}
export function parseProviderSharingLink(input: string): { readonly origin: string; readonly secret: string; readonly endpointPublicKey: string } {
  if (input.length > 8192) throw new Error("The Provider invitation is invalid.");
  const url = new URL(input.trim());
  if (url.search || url.username || url.password || !url.pathname.endsWith(PROVIDER_SHARING_LINK_PATH)) throw new Error("The Provider invitation is invalid.");
  const parsed: unknown = JSON.parse(decodeURIComponent(url.hash.slice(1)));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || Object.keys(parsed).sort().join(",") !== "endpointPublicKey,format,secret") throw new Error("The Provider invitation is invalid.");
  const value = parsed as Record<string, unknown>;
  if (value["format"] !== 1 || typeof value["secret"] !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(value["secret"]) || typeof value["endpointPublicKey"] !== "string") throw new Error("The Provider invitation is invalid.");
  const origin = taskShareOrigin(url.origin + url.pathname.slice(0, -PROVIDER_SHARING_LINK_PATH.length));
  return { origin, secret: value["secret"], endpointPublicKey: taskShareEndpointPublicKey(value["endpointPublicKey"]) };
}
/** Generated owner API only; all foreign credentials stay in the Home service. */
type RpcMethod<M extends { readonly input: DescMessage; readonly output: DescMessage }> =
  (request: MessageInitShape<M["input"]>, options: { readonly signal: AbortSignal }) => Promise<MessageShape<M["output"]>>;
export type ProviderSharingRpc = { readonly [K in keyof typeof ProviderSharingService.method]: RpcMethod<(typeof ProviderSharingService.method)[K]> };
export function createProviderSharingApi(rpc: ProviderSharingRpc, assertCurrent: (signal: AbortSignal) => void, lifetime: AbortSignal) {
  const call = async <T>(signal: AbortSignal, task: (active: AbortSignal) => Promise<T>): Promise<T> => {
    const active = AbortSignal.any([signal, lifetime]);
    active.throwIfAborted(); assertCurrent(active); const result = await task(active); active.throwIfAborted(); assertCurrent(active); return result;
  };
  return {
    list: (signal: AbortSignal) => call(signal, active => rpc.listProviderShares({}, { signal: active })),
    refresh: (signal: AbortSignal) => call(signal, active => rpc.refreshProviderSharing({}, { signal: active })),
    createLink: (input: Parameters<typeof rpc.createProviderShareLink>[0], signal: AbortSignal) => call(signal, active => rpc.createProviderShareLink(input, { signal: active })),
    decide: (operationId: string, requestId: string, approve: boolean, signal: AbortSignal) => call(signal, active => rpc.decideProviderShareRequest({ operationId, requestId, approve }, { signal: active })),
    member: (input: Parameters<typeof rpc.setProviderShareMember>[0], signal: AbortSignal) => call(signal, active => rpc.setProviderShareMember(input, { signal: active })),
    reshare: (operationId: string, id: string, approve: boolean, signal: AbortSignal) => call(signal, active => rpc.decideProviderReshare({ operationId, id, approve }, { signal: active })),
    preview: (link: string, signal: AbortSignal) => call(signal, active => rpc.previewProviderShare({ link }, { signal: active })),
    apply: (input: Parameters<typeof rpc.applyProviderShare>[0], signal: AbortSignal) => call(signal, active => rpc.applyProviderShare(input, { signal: active })),
    withdraw: (operationId: string, applicationId: string, signal: AbortSignal) => call(signal, active => rpc.withdrawProviderShare({ operationId, applicationId }, { signal: active })),
    leave: (operationId: string, joinId: string, signal: AbortSignal) => call(signal, active => rpc.leaveReceivedProviderShare({ operationId, joinId }, { signal: active }))
  };
}
export type ProviderSharingApi = ReturnType<typeof createProviderSharingApi>;
