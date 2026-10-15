import { useEffect, useRef, useState, type JSX } from "react";
import type { TaskShareRuntimeControl } from "@joko/contracts";
import type { OrchestratorGateway } from "../gateway.js";
import type { BackendView, SessionView } from "../model.js";
import type { Translator } from "./types.js";
import { Button, Pill, SelectControl, SwitchControl } from "./ui.js";

export function TaskSharingRuntimeControls({ gateway, session, t }: { readonly gateway: OrchestratorGateway; readonly session: SessionView; readonly t: Translator }): JSX.Element {
  const [control, setControl] = useState<TaskShareRuntimeControl>();
  const [backends, setBackends] = useState<readonly BackendView[]>([]);
  const [error, setError] = useState<string>(), [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const active = useRef<object | undefined>(undefined);
  useEffect(() => {
    const owner = {}; active.current = owner;
    setControl(undefined); setBusy(false); setError(undefined);
    let flight = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = async (): Promise<void> => {
      if (active.current !== owner || flight || document.visibilityState === "hidden") return;
      flight = true;
      try {
        await gateway.recoverSharedTaskOperations();
        const [next, inventory] = await Promise.all([gateway.getSharedTaskRuntimeControl(session.id), gateway.getSharedTaskBackends()]);
        if (active.current === owner) { setControl(next); setBackends(inventory); setError(undefined); }
      } catch (cause) { if (active.current === owner) setError(cause instanceof Error ? cause.message : t("taskSharing.unavailable")); }
      finally { flight = false; if (active.current === owner) timer = setTimeout(() => { void read(); }, 2_000); }
    };
    const foreground = (): void => { if (timer) clearTimeout(timer); void read(); };
    document.addEventListener("visibilitychange", foreground); void read();
    return () => { if (active.current === owner) active.current = undefined; if (timer) clearTimeout(timer); document.removeEventListener("visibilitychange", foreground); };
  }, [gateway, session.id, session.generation, refresh, t]);
  const configure = async (patch: Parameters<OrchestratorGateway["setSharedTaskRuntime"]>[1]): Promise<void> => {
    if (busy || !control) return; const owner = active.current; setBusy(true); setError(undefined);
    try { await gateway.setSharedTaskRuntime(session.id, patch); if (active.current === owner) setRefresh(value => value + 1); }
    catch (cause) { if (active.current === owner) setError(cause instanceof Error ? cause.message : t("taskSharing.unknown")); }
    finally { if (active.current === owner) setBusy(false); }
  };
  const profile = control?.pending ?? control?.effective ?? control?.baseline;
  const thinking = session.model?.efforts.includes("off") && session.model.efforts.includes("xhigh");
  return <section className="settings-card task-sharing-runtime" aria-label={t("taskSharing.backend")}>
    <label>{t("taskSharing.backend")}<SelectControl value={profile?.backendId ?? session.backendId} disabled={busy || !control || control.handoffState === "unknown"} onChange={event => { void configure({ backendId: event.target.value }); }}>
      {backends.length === 0 && <option value={session.backendId}>{session.backendId}</option>}
      {backends.map(backend => <option value={backend.id} key={backend.id}>{backend.name}</option>)}
    </SelectControl></label>
    {thinking && <label>{t("taskSharing.thinking")}<SwitchControl checked={(profile?.effort ?? session.effort) === "xhigh"} disabled={busy || !control || control.handoffState === "unknown"} onChange={event => { void configure({ effort: event.target.checked ? "xhigh" : "off" }); }} /></label>}
    {control?.pending && <Pill>{t("taskSharing.pending")}</Pill>}
    {error && <div role="status">{error}<Button disabled={busy} onClick={() => setRefresh(value => value + 1)}>{t("taskSharing.check")}</Button></div>}
  </section>;
}
