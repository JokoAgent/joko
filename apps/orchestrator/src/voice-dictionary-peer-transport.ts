import {
  NodeSyncDirectTransport, NodeSyncLanTransport,
  type NodeSyncCipherChunkFrame, type NodeSyncDeliveryContext, type NodeSyncLanCandidate, type NodeSyncLanTransportOptions
} from "@joko/node-sync";
import type { VoiceDictionaryPeerStore } from "@joko/store";

export interface VoiceDictionaryPeerTransport {
  start(): Promise<void>;
  stop(): void;
  send(peerId: string, frame: NodeSyncCipherChunkFrame, delivery?: NodeSyncDeliveryContext): Promise<boolean>;
  candidates(now?: number): readonly NodeSyncLanCandidate[];
  onlinePeerIds(now?: number): readonly string[];
  eligiblePeerIds?(): readonly string[];
  probe?(peerId: string, delivery?: NodeSyncDeliveryContext): Promise<boolean>;
  listenerPort?(): number | undefined;
}

/** One exchange owner selects routes; both transports enforce the same independent grant. */
export function createVoiceDictionaryPeerTransport(
  options: NodeSyncLanTransportOptions, store: VoiceDictionaryPeerStore, enableLan: boolean
): VoiceDictionaryPeerTransport {
  const lan = enableLan ? new NodeSyncLanTransport(options) : undefined;
  const listener = store.listener();
  const direct = listener === undefined ? undefined : new NodeSyncDirectTransport({
    ...options, listenPort: listener.listenPort,
    getEndpoints: () => store.peers().flatMap((peer) => peer.route === undefined ? [] : [{
      ...peer.route, nodeId: peer.peerId, displayName: peer.displayName, publicKey: peer.publicKey,
      revision: store.configurationRevision()
    }])
  });
  let stopped = false;
  return {
    start: async () => {
      try { await Promise.all([lan?.start(), direct?.start()]); }
      catch (error) { stopped = true; lan?.stop(); direct?.stop(); throw error; }
      if (stopped) throw new Error("Dictionary peer transport was retired.");
    },
    stop: () => { stopped = true; lan?.stop(); direct?.stop(); },
    listenerPort: () => direct?.listenerPort(),
    candidates: (now) => {
      const candidates = new Map((lan?.candidates(now) ?? []).map((candidate) => [candidate.nodeId, candidate]));
      for (const candidate of direct?.candidates(now) ?? []) candidates.set(candidate.nodeId, candidate);
      return [...candidates.values()];
    },
    onlinePeerIds: (now) => [...new Set([...(lan?.onlinePeerIds(now) ?? []), ...(direct?.onlinePeerIds(now) ?? [])])],
    eligiblePeerIds: () => [...new Set([...(lan?.onlinePeerIds() ?? []), ...(direct?.eligiblePeerIds() ?? [])])],
    probe: async (peerId, delivery) => {
      const current = (): boolean => !stopped && (delivery === undefined || (!delivery.signal.aborted && delivery.isCurrent()));
      if (!current()) return false;
      if (direct?.eligiblePeerIds().includes(peerId) && await direct.probe(peerId, delivery)) return current();
      return current() && (lan?.onlinePeerIds().includes(peerId) ?? false);
    },
    send: async (peerId, frame, delivery) => {
      const current = (): boolean => !stopped && (delivery === undefined || (!delivery.signal.aborted && delivery.isCurrent()));
      if (!current()) return false;
      if (direct?.eligiblePeerIds().includes(peerId) && await direct.send(peerId, frame, delivery)) return current();
      return current() && (await lan?.send(peerId, frame, delivery) ?? false);
    }
  };
}
