import { create, fromBinary, isMessage, toBinary } from "@bufbuild/protobuf";
import { Code, ConnectError, type Transport } from "@connectrpc/connect";
import * as contract from "@joko/contracts";
import { devicePeerNativeAgentMethodEffect, DEVICE_PEER_NATIVE_AGENT_MAXIMUM_BYTES } from "@joko/device-peer";
import type { DevicePeerAuthority, DevicePeerOwner } from "./device-peer-owner.js";
import { hostedAgentPeerMethod } from "./hosted-agent-peer-port.js";

/** Uses the exact captured Device relation/route and a generated native-only
 * command. It never starts a local SDK or infers a URL from a model name. */
export function createHostedAgentPeerTransport(options: { readonly owner: DevicePeerOwner; readonly authority: DevicePeerAuthority }): Transport {
  return {
    unary: async (method, signal, timeoutMs, _header, input) => {
      options.authority.assertCurrent(["native_agents"]);
      const kind = hostedAgentPeerMethod(method), effect = devicePeerNativeAgentMethodEffect(kind);
      if (effect === undefined) throw new ConnectError("Native Agent method is unsupported.", Code.Unimplemented);
      const requestBytes = toBinary(method.input, create(method.input, input));
      if (requestBytes.byteLength > DEVICE_PEER_NATIVE_AGENT_MAXIMUM_BYTES) throw new ConnectError("Native Agent request exceeds its limit.", Code.ResourceExhausted);
      const deadline = timeoutMs !== undefined && timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined;
      const active = signal && deadline ? AbortSignal.any([signal, deadline]) : signal ?? deadline ?? new AbortController().signal;
      active.throwIfAborted();
      const response = await options.owner.dispatch(options.authority, { capability: "native_agents", effectKind: effect, action: "invokeHostedAgent", signal: active,
        payload: create(contract.DevicePeerCommandSchema, { capability: contract.DevicePeerCapabilityKind.NATIVE_AGENTS,
          effect: effect === "read_only" ? contract.DevicePeerEffectKind.READ_ONLY : contract.DevicePeerEffectKind.SIDE_EFFECT,
          action: { case: "invokeHostedAgent", value: { method: kind, requestBytes } } }) });
      if (response.outcome !== "completed") throw new ConnectError(response.outcome === "outcome_unknown"
        ? "Native Agent delivery outcome is unknown; the operation was not repeated." : "The native Agent node is unavailable.",
        response.outcome === "outcome_unknown" ? Code.Aborted : response.outcome === "aborted" ? Code.Canceled : Code.Unavailable);
      options.authority.assertCurrent(["native_agents"]); active.throwIfAborted();
      const payload = response.value as { case?: unknown; value?: unknown } | undefined;
      if (payload?.case !== "hostedAgent" || !isMessage(payload.value, contract.DevicePeerHostedAgentResultSchema)
        || payload.value.responseBytes.byteLength > DEVICE_PEER_NATIVE_AGENT_MAXIMUM_BYTES) throw new ConnectError("The native Agent reply is invalid.", Code.DataLoss);
      return { stream: false, service: method.parent, method, header: new Headers(), trailer: new Headers(), message: fromBinary(method.output, payload.value.responseBytes) };
    },
    stream: async () => { throw new ConnectError("The private native protocol uses unary methods.", Code.Unimplemented); }
  };
}
