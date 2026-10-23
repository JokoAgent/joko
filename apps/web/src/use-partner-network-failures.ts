import { useEffect, useMemo, useRef, useState } from "react";
import { Code, ConnectError } from "@connectrpc/connect";
import { PartnerNetworkFailureProjection, type PartnerNetworkExecution, type PartnerNetworkMessage } from "@joko/contracts";
import type { PartnerNetworkApi } from "./partner-network-api.js";

export function usePartnerNetworkFailures(api: PartnerNetworkApi, target: { roomId: string; joinId: string }, messages: readonly PartnerNetworkMessage[], onDenied: () => void) {
  const projection = useRef(new PartnerNetworkFailureProjection()), [rows, setRows] = useState<readonly PartnerNetworkExecution[]>([]), [error, setError] = useState(false), denied = useRef(onDenied); denied.current = onDenied;
  const sources = JSON.stringify(messages.map(message => [message.id, message.deleted]));
  useEffect(() => { const scope = new AbortController(); let reading = false;
    const read = async () => { if (reading || document.visibilityState === "hidden") return; reading = true;
      try { const changed = await projection.current.refresh(messages, async (sourceMessageIds, signal) => (await api.readPartnerNetworkFailures({ ...target, sourceMessageIds: [...sourceMessageIds] }, { signal })).executions, scope.signal);
        if (!scope.signal.aborted && changed) { setRows(projection.current.rows); setError(false); } }
      catch (reason) { if (!scope.signal.aborted) { if (reason instanceof ConnectError && [Code.PermissionDenied, Code.Unauthenticated].includes(reason.code)) { projection.current.clear(); denied.current(); }
        setRows(projection.current.rows); setError(true); } } finally { reading = false; } };
    void read(); const timer = setInterval(() => { void read(); }, 2_000); document.addEventListener("visibilitychange", read);
    return () => { scope.abort(); clearInterval(timer); document.removeEventListener("visibilitychange", read); }; }, [sources]);
  const bySource = useMemo(() => { const value = new Map<string, PartnerNetworkExecution[]>(); for (const row of rows) value.set(row.sourceMessageId, [...value.get(row.sourceMessageId) ?? [], row]); return value; }, [rows]);
  return { bySource, error };
}
