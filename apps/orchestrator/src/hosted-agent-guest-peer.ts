import { createHash } from "node:crypto";
import { create, fromBinary, toBinary, type DescMethodUnary, type Message } from "@bufbuild/protobuf";
import { createClient, createRouterTransport, type CallOptions } from "@connectrpc/connect";
import * as contract from "@joko/contracts";
import { DEVICE_PEER_NATIVE_AGENT_MAXIMUM_BYTES, type DevicePeerNativeAgentPort } from "@joko/device-peer";
import type { HostedAgentPrincipal } from "./hosted-agent-host.js";
import type { HostedAgentRuntime } from "./hosted-agent-runtime.js";
import { createHostedAgentConnectService } from "./hosted-agent-connect-service.js";
import { HostedAgentWireError } from "./hosted-agent-wire.js";

/** Closed same-owner group relay. The owner Device authenticates the group
 * computer; it never makes the onward person an owner native principal. */
export function createHostedAgentGuestPeerPort(runtime: HostedAgentRuntime, controllerServerId: string, assertAuthorityCurrent: () => void = () => {}): DevicePeerNativeAgentPort {
  const lifetime = new AbortController(), scopes = new Map<string, { readonly principal: HostedAgentPrincipal; readonly client: ReturnType<typeof clientFor> }>();
  const owners = new Set<HostedAgentPrincipal>();
  const options = runtime.connectOptions(); let retiring: Promise<void> | undefined;
  function clientFor(principal: HostedAgentPrincipal) { return createClient(contract.HostedAgentService, createRouterTransport(router => {
    router.service(contract.HostedAgentService, createHostedAgentConnectService({ ...options, authenticate: () => principal }),
      { readMaxBytes: DEVICE_PEER_NATIVE_AGENT_MAXIMUM_BYTES, writeMaxBytes: DEVICE_PEER_NATIVE_AGENT_MAXIMUM_BYTES });
  })); }
  return {
    invoke: async (kind, bytes, signal, authority) => {
      assertAuthorityCurrent(); lifetime.signal.throwIfAborted(); signal.throwIfAborted();
      const method = hostedAgentGuestPeerDescriptor(kind); if (!method || !(bytes instanceof Uint8Array) || bytes.byteLength > DEVICE_PEER_NATIVE_AGENT_MAXIMUM_BYTES) throw new HostedAgentWireError();
      const envelope = fromBinary(contract.HostedAgentGuestRelayRequestSchema, bytes), scope = envelope.scope;
      if (!scope || !/^[a-f0-9]{64}$/u.test(scope.relayId) || !validId(scope.backendId) || !validId(scope.providerId)
        || !scope.modelIds.length || scope.modelIds.length > 4096 || scope.modelIds.some(model => !validId(model)) || new Set(scope.modelIds).size !== scope.modelIds.length
        || !validId(authority.controllerDeviceId) || envelope.requestBytes.byteLength > 64 * 1024 * 1024
        || envelope.purge && kind !== contract.HostedAgentPeerMethod.GUEST_RELAY_CLOSE) throw new HostedAgentWireError();
      const ownerId = `owner-guest-relay:${hash([controllerServerId, authority.controllerDeviceId, scope.relayId, scope.backendId, scope.providerId])}`;
      if (kind === contract.HostedAgentPeerMethod.GUEST_RELAY_CLOSE) {
        const request = fromBinary(contract.CloseHostedAgentRequestSchema, envelope.requestBytes);
        if (request.format !== 1 || !validId(request.runId)) throw new HostedAgentWireError();
        const terminal: HostedAgentPrincipal = { id: ownerId, deviceId: authority.controllerDeviceId, trust: "guest", assertCurrent: assertAuthorityCurrent };
        await runtime.endpoint.closeRelayedGuest(terminal, request.runId, envelope.purge);
        if (envelope.purge) await runtime.purgeClosedRelayedGuestSessions(ownerId, scope.backendId);
        assertAuthorityCurrent(); signal.throwIfAborted();
        return toBinary(contract.CloseHostedAgentResponseSchema, create(contract.CloseHostedAgentResponseSchema, { format: 1 }));
      }
      const scopeKey = JSON.stringify([ownerId, [...scope.modelIds].sort()]); let entry = scopes.get(scopeKey);
      if (entry) { try { entry.principal.assertCurrent(); } catch { entry = undefined; } }
      if (!entry) {
        if (owners.size >= 65_536) throw new HostedAgentWireError();
        const computer = runtime.settings.captureComputer(), providerPermission = runtime.settings.captureProvider(scope.backendId, scope.providerId);
        const assertCurrent = () => { assertAuthorityCurrent(); lifetime.signal.throwIfAborted(); computer(); providerPermission();
          const provider = runtime.shareableProvider(scope.backendId, scope.providerId); provider.assertCurrent();
          if (scope.modelIds.some(modelId => !provider.models.some(model => model.modelId === modelId))) throw new HostedAgentWireError(); };
        const principal: HostedAgentPrincipal = { id: ownerId, deviceId: authority.controllerDeviceId, trust: "guest", assertCurrent,
          providerGrant: { backendId: scope.backendId, providerId: scope.providerId, modelIds: [...scope.modelIds], groupMember: true, assertCurrent } };
        entry = { principal, client: clientFor(principal) }; scopes.set(scopeKey, entry); owners.add(principal);
      }
      entry.principal.assertCurrent();
      const invoke = entry.client[method.localName as keyof typeof entry.client] as (request: Message, options: CallOptions) => Promise<Message>;
      const result = await invoke(fromBinary(method.input, envelope.requestBytes), { signal: AbortSignal.any([lifetime.signal, signal]) });
      entry.principal.assertCurrent(); signal.throwIfAborted(); const response = toBinary(method.output, result);
      if (response.byteLength > DEVICE_PEER_NATIVE_AGENT_MAXIMUM_BYTES) throw new HostedAgentWireError(); return response;
    },
    retire: () => {
      lifetime.abort(); return retiring ??= Promise.all([...owners].map(principal => runtime.endpoint.closePrincipal(principal))).then(() => {})
        .catch(error => { retiring = undefined; throw error; });
    }
  };
}
export function hostedAgentGuestPeerDescriptor(kind: contract.HostedAgentPeerMethod): DescMethodUnary | undefined {
  const methods = contract.HostedAgentService.method;
  switch (kind) {
    case contract.HostedAgentPeerMethod.GUEST_RELAY_CATALOG: return methods.getHostedAgentCatalog;
    case contract.HostedAgentPeerMethod.GUEST_RELAY_OPEN: return methods.openHostedAgent;
    case contract.HostedAgentPeerMethod.GUEST_RELAY_CALL: return methods.callHostedAgent;
    case contract.HostedAgentPeerMethod.GUEST_RELAY_POLL: return methods.pollHostedAgents;
    case contract.HostedAgentPeerMethod.GUEST_RELAY_REPLY: return methods.replyHostedAgent;
    case contract.HostedAgentPeerMethod.GUEST_RELAY_READ_ARTIFACT: return methods.readHostedAgentArtifact;
    case contract.HostedAgentPeerMethod.GUEST_RELAY_CLOSE: return methods.closeHostedAgent;
    default: return undefined;
  }
}
export function hostedAgentGuestPeerMethod(method: DescMethodUnary): contract.HostedAgentPeerMethod {
  for (const kind of [contract.HostedAgentPeerMethod.GUEST_RELAY_CATALOG, contract.HostedAgentPeerMethod.GUEST_RELAY_OPEN, contract.HostedAgentPeerMethod.GUEST_RELAY_CALL,
    contract.HostedAgentPeerMethod.GUEST_RELAY_POLL, contract.HostedAgentPeerMethod.GUEST_RELAY_REPLY, contract.HostedAgentPeerMethod.GUEST_RELAY_READ_ARTIFACT, contract.HostedAgentPeerMethod.GUEST_RELAY_CLOSE]) {
    if (hostedAgentGuestPeerDescriptor(kind)?.name === method.name && method.parent.typeName === contract.HostedAgentService.typeName) return kind;
  }
  throw new HostedAgentWireError();
}
function validId(value: string): boolean { return !!value && value.length <= 512 && !/[\0\r\n]/u.test(value); }
function hash(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
