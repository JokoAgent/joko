import { HostedAgentPeerMethod } from "@joko/contracts";
import type { DevicePeerEffectKind } from "./protocol.js";
export const DEVICE_PEER_NATIVE_AGENT_MAXIMUM_BYTES = 66 * 1024 * 1024;

/** Every model mutation remains a side-effecting Device command even when the
 * nested native call happens to be an observation. Unknown delivery is never
 * converted into permission to dispatch another native turn. */
export function devicePeerNativeAgentMethodEffect(method: HostedAgentPeerMethod): DevicePeerEffectKind | undefined {
  switch (method) {
    case HostedAgentPeerMethod.GET_CATALOG:
    case HostedAgentPeerMethod.GET_SETTINGS:
    case HostedAgentPeerMethod.POLL:
    case HostedAgentPeerMethod.READ_ARTIFACT: return "read_only";
    case HostedAgentPeerMethod.UPDATE_SETTINGS:
    case HostedAgentPeerMethod.OPEN:
    case HostedAgentPeerMethod.CALL:
    case HostedAgentPeerMethod.REPLY:
    case HostedAgentPeerMethod.CLOSE: return "side_effect";
    default: return undefined;
  }
}
