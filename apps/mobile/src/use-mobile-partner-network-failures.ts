import { useEffect, useMemo, useRef, useState } from "react";
import { Code, ConnectError } from "@connectrpc/connect";
import { PartnerNetworkFailureProjection, type PartnerNetworkExecution, type PartnerNetworkMessage } from "@joko/contracts";
import type { MobilePartnerNetworkApi } from "./mobile-partner-network";

export function useMobilePartnerNetworkFailures(api: MobilePartnerNetworkApi | undefined, target: { roomId: string; joinId: string } | undefined, messages: readonly PartnerNetworkMessage[], foreground: boolean, onDenied: () => void) {
  const projection = useRef(new PartnerNetworkFailureProjection()), [rows, setRows] = useState<readonly PartnerNetworkExecution[]>([]), [error, setError] = useState(false), denied = useRef(onDenied); denied.current = onDenied;
  const sources = JSON.stringify(messages.map(message => [message.id, message.deleted]));
  const scopeKey = JSON.stringify([api?.ownerKey, target?.roomId, target?.joinId]), publishedScope = useRef("");
  useEffect(() => { if (!api || !target) { projection.current.clear(); setRows([]); setError(false); publishedScope.current = scopeKey; return; } if (!foreground) return; const scope = new AbortController(); let reading = false;
    if (publishedScope.current !== scopeKey) { projection.current.clear(); setRows([]); publishedScope.current = scopeKey; }
    const read = async () => { if (reading) return; reading = true;
      try { const changed = await projection.current.refresh(messages, async (sourceMessageIds, signal) => (await api.readPartnerNetworkFailures({ ...target, sourceMessageIds: [...sourceMessageIds] }, { signal })).executions, scope.signal);
        if (!scope.signal.aborted && changed) { setRows(projection.current.rows); setError(false); } }
      catch (reason) { if (!scope.signal.aborted) { if (reason instanceof ConnectError && [Code.PermissionDenied, Code.Unauthenticated].includes(reason.code)) { projection.current.clear(); denied.current(); }
        setRows(projection.current.rows); setError(true); } } finally { reading = false; } };
    void read(); const timer = setInterval(() => { void read(); }, 2_000); return () => { scope.abort(); clearInterval(timer); }; }, [api?.ownerKey, target?.roomId, target?.joinId, sources, foreground]);
  const bySource = useMemo(() => { const value = new Map<string, PartnerNetworkExecution[]>(); if (publishedScope.current !== scopeKey) return value; for (const row of rows) value.set(row.sourceMessageId, [...value.get(row.sourceMessageId) ?? [], row]); return value; }, [rows, scopeKey]);
  return { bySource, error };
}
