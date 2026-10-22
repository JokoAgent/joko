import { fromBinary, toBinary, type Message, type DescMethodUnary } from "@bufbuild/protobuf";
import { createHash } from "node:crypto";
import { createClient, createRouterTransport, type CallOptions } from "@connectrpc/connect";
import * as contract from "@joko/contracts";
import { DEVICE_PEER_NATIVE_AGENT_MAXIMUM_BYTES, devicePeerNativeAgentMethodEffect, type DevicePeerNativeAgentPort } from "@joko/device-peer";
import type { HostedAgentRuntime } from "./hosted-agent-runtime.js";
import { createHostedAgentConnectService } from "./hosted-agent-connect-service.js";
import { HostedAgentWireError } from "./hosted-agent-wire.js";
import type { HostedAgentPrincipal } from "./hosted-agent-host.js";
import { createHostedAgentGuestPeerPort, hostedAgentGuestPeerDescriptor } from "./hosted-agent-guest-peer.js";

/** The outbound service-node configuration already pins the authenticated
 * controller server. The command payload cannot supply its trust or identity.
 * Each route owns a fresh live authority over that stable controller scope. */
export function createHostedAgentPeerPort(runtime: HostedAgentRuntime, controllerServerId: string, assertAuthorityCurrent: () => void = () => {}): DevicePeerNativeAgentPort {
  if (!controllerServerId || controllerServerId.length > 256 || /[\0\r\n]/u.test(controllerServerId)) throw new Error("The native controller identity is invalid.");
  const lifetime = new AbortController(), principals = new Map<string, { readonly principal: HostedAgentPrincipal; readonly client: ReturnType<typeof makeClient> }>();
  const options = runtime.connectOptions();
  const guestRelay = createHostedAgentGuestPeerPort(runtime, controllerServerId, assertAuthorityCurrent);
  let retirement: Promise<void> | undefined;
  function makeClient(principal: HostedAgentPrincipal) { return createClient(contract.HostedAgentService, createRouterTransport(({ service }) => {
    service(contract.HostedAgentService, createHostedAgentConnectService({ ...options, authenticate: () => principal }),
      { readMaxBytes: DEVICE_PEER_NATIVE_AGENT_MAXIMUM_BYTES, writeMaxBytes: DEVICE_PEER_NATIVE_AGENT_MAXIMUM_BYTES });
  })); }
  return {
    invoke: async (kind, bytes, signal, authority) => {
      if (hostedAgentGuestPeerDescriptor(kind)) return guestRelay.invoke(kind, bytes, signal, authority);
      assertAuthorityCurrent();
      lifetime.signal.throwIfAborted(); signal.throwIfAborted();
      // This is the controller identity inserted by the authenticated Device
      // route owner, separate from the nested native request. One relay Hub
      // may serve multiple original Devices; their runs and quotas stay apart.
      const deviceId = authority.controllerDeviceId;
      if (!deviceId || deviceId.length > 256 || /[\0\r\n]/u.test(deviceId)) throw new HostedAgentWireError();
      let scoped = principals.get(deviceId);
      if (!scoped) {
        const principal: HostedAgentPrincipal = { id: `service-peer:${createHash("sha256").update(JSON.stringify([controllerServerId, deviceId])).digest("hex")}`,
          deviceId, trust: "owner", assertCurrent: () => { assertAuthorityCurrent(); lifetime.signal.throwIfAborted(); } };
        scoped = { principal, client: makeClient(principal) }; principals.set(deviceId, scoped);
      }
      const { principal, client } = scoped; principal.assertCurrent();
      if (!(bytes instanceof Uint8Array) || bytes.byteLength > DEVICE_PEER_NATIVE_AGENT_MAXIMUM_BYTES || devicePeerNativeAgentMethodEffect(kind) === undefined) throw new HostedAgentWireError();
      const method = hostedAgentPeerDescriptor(kind), invoke = client[method.localName as keyof typeof client] as (request: Message, options: CallOptions) => Promise<Message>;
      const result = await invoke(fromBinary(method.input, bytes), { signal: AbortSignal.any([lifetime.signal, signal]) });
      principal.assertCurrent(); signal.throwIfAborted(); const response = toBinary(method.output, result);
      if (response.byteLength > DEVICE_PEER_NATIVE_AGENT_MAXIMUM_BYTES) throw new HostedAgentWireError(); return response;
    },
    retire: () => {
      lifetime.abort();
      return retirement ??= Promise.all([guestRelay.retire(), ...[...principals.values()].map(scope => runtime.endpoint.closePrincipal(scope.principal))]).then(() => {})
        .catch(error => { retirement = undefined; throw error; });
    }
  };
}
export function hostedAgentPeerDescriptor(method: contract.HostedAgentPeerMethod): DescMethodUnary {
  const methods = contract.HostedAgentService.method;
  switch (method) {
    case contract.HostedAgentPeerMethod.GET_CATALOG: return methods.getHostedAgentCatalog;
    case contract.HostedAgentPeerMethod.GET_SETTINGS: return methods.getHostedAgentSettings;
    case contract.HostedAgentPeerMethod.UPDATE_SETTINGS: return methods.updateHostedAgentSettings;
    case contract.HostedAgentPeerMethod.OPEN: return methods.openHostedAgent;
    case contract.HostedAgentPeerMethod.CALL: return methods.callHostedAgent;
    case contract.HostedAgentPeerMethod.POLL: return methods.pollHostedAgents;
    case contract.HostedAgentPeerMethod.REPLY: return methods.replyHostedAgent;
    case contract.HostedAgentPeerMethod.READ_ARTIFACT: return methods.readHostedAgentArtifact;
    case contract.HostedAgentPeerMethod.CLOSE: return methods.closeHostedAgent;
    default: throw new HostedAgentWireError();
  }
}
export function hostedAgentPeerMethod(method: DescMethodUnary): contract.HostedAgentPeerMethod {
  if (method.parent.typeName !== contract.HostedAgentService.typeName) throw new HostedAgentWireError();
  for (const value of [contract.HostedAgentPeerMethod.GET_CATALOG, contract.HostedAgentPeerMethod.GET_SETTINGS, contract.HostedAgentPeerMethod.UPDATE_SETTINGS, contract.HostedAgentPeerMethod.OPEN,
    contract.HostedAgentPeerMethod.CALL, contract.HostedAgentPeerMethod.POLL, contract.HostedAgentPeerMethod.REPLY,
    contract.HostedAgentPeerMethod.READ_ARTIFACT, contract.HostedAgentPeerMethod.CLOSE]) {
    if (hostedAgentPeerDescriptor(value).name === method.name) return value;
  }
  throw new HostedAgentWireError();
}
