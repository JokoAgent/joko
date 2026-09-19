import {
  LAN_DISCOVERY_GROUP,
  LAN_DISCOVERY_MAX_DATAGRAM_BYTES,
  LAN_DISCOVERY_NONCE_BYTES,
  LAN_DISCOVERY_PORT,
  decodeLanDiscoveryDatagram,
  encodeLanDiscoveryQuery,
  isPrivateLanDiscoveryHost,
  type DiscoveredNodeRecord
} from "@joko/contracts";

export interface ReceivedLanDatagram {
  readonly bytes: Uint8Array;
  readonly address: string;
}

export interface MobileLanDiscoveryTransport {
  discover(request: {
    readonly bytes: Uint8Array;
    readonly group: string;
    readonly port: number;
    readonly timeoutMs: number;
    readonly maximumResponses: number;
  }): Promise<readonly ReceivedLanDatagram[]>;
}

export interface MobileDiscovery {
  scan(signal?: AbortSignal): Promise<readonly DiscoveredNodeRecord[]>;
}

export function createMobileDiscovery(
  transport: MobileLanDiscoveryTransport,
  nonce: () => Uint8Array,
  now: () => number = Date.now
): MobileDiscovery {
  return {
    async scan(signal) {
      if (signal?.aborted) throw new Error("Nearby node discovery was cancelled.");
      const queryNonce = nonce();
      if (queryNonce.byteLength !== LAN_DISCOVERY_NONCE_BYTES) {
        throw new Error("Nearby node discovery could not create a valid request identity.");
      }
      const responses = await transport.discover({
        bytes: encodeLanDiscoveryQuery(queryNonce),
        group: LAN_DISCOVERY_GROUP,
        port: LAN_DISCOVERY_PORT,
        timeoutMs: 1_500,
        maximumResponses: 64
      });
      if (signal?.aborted) throw new Error("Nearby node discovery was cancelled.");
      const candidates = new Map<string, DiscoveredNodeRecord>();
      const conflicts = new Set<string>();
      for (const response of responses.slice(0, 64)) {
        if (response.bytes.byteLength < 1 || response.bytes.byteLength > LAN_DISCOVERY_MAX_DATAGRAM_BYTES
          || !isPrivateLanDiscoveryHost(response.address)) continue;
        const decoded = decodeLanDiscoveryDatagram(response.bytes, now());
        if (decoded?.kind !== "announce" || !sameBytes(decoded.nonce, queryNonce)) continue;
        const previous = candidates.get(decoded.node.serverId);
        if (previous !== undefined && previous.origin !== decoded.node.origin) {
          conflicts.add(decoded.node.serverId);
          candidates.delete(decoded.node.serverId);
          continue;
        }
        if (!conflicts.has(decoded.node.serverId)) candidates.set(decoded.node.serverId, decoded.node);
      }
      return [...candidates.values()].sort((left, right) =>
        left.displayName.localeCompare(right.displayName) || left.serverId.localeCompare(right.serverId));
    }
  };
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1) difference |= left[index]! ^ right[index]!;
  return difference === 0;
}
