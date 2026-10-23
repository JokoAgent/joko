import { create, fromBinary, toBinary, isMessage, type Message, type DescMethodUnary } from "@bufbuild/protobuf";
import { Code, ConnectError, createClient, createRouterTransport, type Transport, type CallOptions, type Client } from "@connectrpc/connect";
import * as contract from "@joko/contracts";
import { devicePeerNativeAgentMethodEffect, DEVICE_PEER_NATIVE_AGENT_MAXIMUM_BYTES, type DevicePeerNativeAgentPort } from "@joko/device-peer";
import type { DevicePeerAuthority, DevicePeerOwner } from "./device-peer-owner.js";
import { createProviderGroupConnectService, type ProviderGroupConnectOptions } from "./provider-group-connect-service.js";

/** Only coordination and read-only views cross an owner Device route. Group
 * management is deliberately absent from this closed peer method table. */
export function providerGroupPeerDescriptor(kind: contract.HostedAgentPeerMethod): DescMethodUnary | undefined {
  const methods = contract.ProviderGroupService.method;
  switch (kind) {
    case contract.HostedAgentPeerMethod.GROUP_GET: return methods.getProviderGroup;
    case contract.HostedAgentPeerMethod.GROUP_PICK: return methods.pickProviderGroupMember;
    case contract.HostedAgentPeerMethod.GROUP_COOL: return methods.coolProviderGroupMember;
    case contract.HostedAgentPeerMethod.GROUP_LEASES: return methods.reportProviderGroupLeases;
    case contract.HostedAgentPeerMethod.GROUP_USAGE_REPORT: return methods.reportProviderGroupUsage;
    case contract.HostedAgentPeerMethod.GROUP_USAGE: return methods.getProviderGroupUsage;
    case contract.HostedAgentPeerMethod.GROUP_SCHEDULING_STATE: return methods.getProviderSchedulingState;
    default: return undefined;
  }
}
function peerMethod(method: DescMethodUnary): contract.HostedAgentPeerMethod {
  if (method.parent.typeName !== contract.ProviderGroupService.typeName) throw new ConnectError("Provider group method is unsupported.", Code.Unimplemented);
  for (const kind of [contract.HostedAgentPeerMethod.GROUP_GET, contract.HostedAgentPeerMethod.GROUP_PICK, contract.HostedAgentPeerMethod.GROUP_COOL,
    contract.HostedAgentPeerMethod.GROUP_LEASES, contract.HostedAgentPeerMethod.GROUP_USAGE_REPORT, contract.HostedAgentPeerMethod.GROUP_USAGE, contract.HostedAgentPeerMethod.GROUP_SCHEDULING_STATE]) {
    if (providerGroupPeerDescriptor(kind)?.name === method.name) return kind;
  }
  throw new ConnectError("Provider group management cannot be forwarded.", Code.PermissionDenied);
}
export function createProviderGroupPeerTransport(options: { readonly owner: DevicePeerOwner; readonly authority: DevicePeerAuthority }): Transport {
  return { unary: async (method, signal, timeoutMs, _header, input) => {
    options.authority.assertCurrent(["native_agents"]); const kind = peerMethod(method), effect = devicePeerNativeAgentMethodEffect(kind);
    if (!effect) throw new ConnectError("Provider group method is unsupported.", Code.Unimplemented);
    const bytes = toBinary(method.input, create(method.input, input)); if (bytes.byteLength > DEVICE_PEER_NATIVE_AGENT_MAXIMUM_BYTES) throw new ConnectError("Provider group request is too large.", Code.ResourceExhausted);
    const deadline = timeoutMs && timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined;
    const active = signal && deadline ? AbortSignal.any([signal, deadline]) : signal ?? deadline ?? new AbortController().signal; active.throwIfAborted();
    const result = await options.owner.dispatch(options.authority, { capability: "native_agents", effectKind: effect, action: "invokeHostedAgent", signal: active,
      payload: create(contract.DevicePeerCommandSchema, { capability: contract.DevicePeerCapabilityKind.NATIVE_AGENTS,
        effect: effect === "read_only" ? contract.DevicePeerEffectKind.READ_ONLY : contract.DevicePeerEffectKind.SIDE_EFFECT,
        action: { case: "invokeHostedAgent", value: { method: kind, requestBytes: bytes } } }) });
    if (result.outcome !== "completed") throw new ConnectError("Provider group delivery could not be confirmed.", result.outcome === "outcome_unknown" ? Code.Aborted : Code.Unavailable);
    options.authority.assertCurrent(["native_agents"]); active.throwIfAborted(); const payload = result.value as { case?: unknown; value?: unknown } | undefined;
    if (payload?.case !== "hostedAgent" || !isMessage(payload.value, contract.DevicePeerHostedAgentResultSchema)
      || payload.value.responseBytes.byteLength > DEVICE_PEER_NATIVE_AGENT_MAXIMUM_BYTES) throw new ConnectError("Invalid Provider group reply.", Code.DataLoss);
    return { stream: false, service: method.parent, method, header: new Headers(), trailer: new Headers(), message: fromBinary(method.output, payload.value.responseBytes) };
  }, stream: async () => { throw new ConnectError("Provider group requests use unary methods.", Code.Unimplemented); } };
}
/** Adds owner-only group coordination to an existing exact-route native port.
 * It never converts a task guest or Provider guest into a paired Device. */
export function withProviderGroupPeerPort(base: DevicePeerNativeAgentPort, options: Omit<ProviderGroupConnectOptions, "authenticate">,
  assertAuthorityCurrent: () => void = () => {}): DevicePeerNativeAgentPort {
  const lifetime = new AbortController();
  // A multipart usage report spans requests. Its service owner must survive
  // each request so an incomplete batch never replaces a complete snapshot.
  const controllers = new Map<string, Client<typeof contract.ProviderGroupService>>();
  return { invoke: async (kind, bytes, signal, authority) => {
    const method = providerGroupPeerDescriptor(kind); if (!method) return base.invoke(kind, bytes, signal, authority);
    assertAuthorityCurrent(); lifetime.signal.throwIfAborted(); signal.throwIfAborted();
    const principal = { id: authority.controllerDeviceId, trust: "owner" as const, management: false,
      assertCurrent: () => { assertAuthorityCurrent(); lifetime.signal.throwIfAborted(); } };
    if (!principal.id || bytes.byteLength > DEVICE_PEER_NATIVE_AGENT_MAXIMUM_BYTES) throw new ConnectError("Invalid group Device scope.", Code.PermissionDenied);
    let client = controllers.get(principal.id);
    if (!client) {
      if (controllers.size >= 1024) throw new ConnectError("Too many group Device scopes.", Code.ResourceExhausted);
      client = createClient(contract.ProviderGroupService, createRouterTransport(({ service }) => {
        service(contract.ProviderGroupService, createProviderGroupConnectService({ ...options, authenticate: () => principal }));
      }));
      controllers.set(principal.id, client);
    }
    const invoke = client[method.localName as keyof typeof client] as (request: Message, options: CallOptions) => Promise<Message>;
    const result = await invoke(fromBinary(method.input, bytes), { signal: AbortSignal.any([signal, lifetime.signal]) }); principal.assertCurrent();
    const output = toBinary(method.output, result); if (output.byteLength > DEVICE_PEER_NATIVE_AGENT_MAXIMUM_BYTES) throw new ConnectError("Group reply is too large.", Code.ResourceExhausted); return output;
  }, retire: async () => { lifetime.abort(); controllers.clear(); await base.retire(); } };
}
