import { useEffect, useRef, useState } from "react";
import type { MobilePartnerDirectoryProfile, MobilePartnerDirectoryTransport } from "./mobile-partner-directory";

type PeerTransport = Pick<MobilePartnerDirectoryTransport, "ownerKey" | "list">;
interface PeerState {
  readonly scope?: string;
  readonly peers: ReadonlyMap<string, MobilePartnerDirectoryProfile>;
  readonly loading: boolean;
  readonly failed: boolean;
}
const NO_PEERS: ReadonlyMap<string, MobilePartnerDirectoryProfile> = new Map();

/** Task presentation only. Profiles never authorize navigation or replace the Client's fresh open. */
export function useMobilePartnerPeers(transport: PeerTransport | undefined, taskOwnerKey: string | undefined,
  hasPrivateCandidates: boolean, enabled: boolean, retrySequence = 0) {
  const [state, setState] = useState<PeerState>({ peers: NO_PEERS, loading: false, failed: false });
  const [attempt, setAttempt] = useState(0);
  const scope = enabled && hasPrivateCandidates && transport && taskOwnerKey
    ? JSON.stringify([transport.ownerKey, taskOwnerKey]) : undefined;
  const current = useRef({ transport, scope }); current.current = { transport, scope };
  useEffect(() => {
    setState({ scope, peers: NO_PEERS, loading: scope !== undefined, failed: false });
    const source = current.current.transport;
    if (!scope || !source) return;
    const abort = new AbortController();
    const isCurrent = (): boolean => !abort.signal.aborted && current.current.scope === scope
      && current.current.transport?.ownerKey === source.ownerKey;
    void source.list(abort.signal).then((catalog) => {
      if (isCurrent()) setState({ scope, peers: new Map(catalog.partners.map((partner) => [partner.partnerId, partner])),
        loading: false, failed: false });
    }).catch(() => {
      if (isCurrent()) setState({ scope, peers: NO_PEERS, loading: false, failed: true });
    });
    return () => abort.abort();
  }, [scope, retrySequence, attempt]);
  const visible = scope !== undefined && state.scope === scope;
  return { peers: visible ? state.peers : NO_PEERS, loading: visible && state.loading, failed: visible && state.failed,
    retry: () => setAttempt((value) => value + 1) };
}
