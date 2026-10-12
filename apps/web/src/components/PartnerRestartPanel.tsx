import { useEffect, useRef, useState, type JSX } from "react";
import type { PartnerRestartResult, PartnerRestartView } from "@joko/contracts";
import type { AppController } from "../controller.js";
import type { PartnerProfileView } from "../model.js";
import { PartnerRestartReceipts } from "../partner-restart-receipts.js";
import type { Translator } from "./types.js";
import { Button, Modal } from "./ui.js";

export function PartnerRestartPanel({ controller, ownerKey, foreground, partner, pending, t, onClose, onChanged, onBusyChange }: {
  readonly controller: AppController; readonly ownerKey: string; readonly foreground: boolean;
  readonly partner?: PartnerProfileView; readonly pending: readonly PartnerRestartView[];
  readonly t: Translator; readonly onClose: () => void; readonly onChanged: () => void;
  readonly onBusyChange?: (busy: boolean) => void;
}): JSX.Element {
  const current = useRef({ controller, ownerKey, foreground, onClose, onChanged });
  current.current = { controller, ownerKey, foreground, onClose, onChanged };
  const receipts = useRef<PartnerRestartReceipts | undefined>(undefined);
  const request = useRef<AbortController | undefined>(undefined);
  const busyRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const [available, setAvailable] = useState(false);
  const [reload, setReload] = useState(0);
  const [succeeded, setSucceeded] = useState(false);
  const [error, setError] = useState<string>();
  const [records, setRecords] = useState<ReadonlyMap<string, PartnerRestartView | undefined>>(new Map());
  const signature = JSON.stringify(pending.map((item) => [item.requestId, item.phase, item.runtimeClosePending]));
  useEffect(() => {
    if (!foreground || controller.state.connectionState !== "connected") { request.current?.abort(); setReady(false); return; }
    if (busyRef.current) return;
    const abort = new AbortController(); request.current?.abort(); request.current = abort;
    setReady(false); setError(undefined);
    const active = (): boolean => !abort.signal.aborted && current.current.ownerKey === ownerKey && current.current.foreground;
    const run = async (): Promise<void> => {
      try {
        const storage = document.defaultView?.localStorage;
        if (!storage) throw new Error("Receipt storage unavailable.");
        const store = receipts.current ??= new PartnerRestartReceipts(storage, controller.state.activeProfile);
        const ids = [...new Set([...store.list(), ...pending.map((item) => item.requestId)])];
        setRecords(new Map(ids.map((id) => [id, pending.find((item) => item.requestId === id)])));
        setAvailable(false);
        if (partner) {
          const controls = await current.current.controller.getPartnerRestartControls(partner.id, abort.signal);
          if (!active()) return;
          setAvailable(controls.available && controls.revision === partner.revision);
        }
        for (const id of ids) {
          if (!active()) return;
          setRecords((old) => new Map(old).set(id, pending.find((item) => item.requestId === id)));
          const result = await current.current.controller.getPartnerRestart(id, abort.signal);
          if (!active()) return;
          if (result.retired || result.restart?.phase === "ready") {
            store.resolve(id); setRecords((old) => { const next = new Map(old); next.delete(id); return next; });
          } else setRecords((old) => new Map(old).set(id, result.restart));
        }
      } catch { if (active()) setError(t(partner ? "partners.restartLoadFailed" : "partners.restartUnknown")); }
      finally { if (active()) setReady(true); }
    };
    if (!busyRef.current) void run();
    return () => abort.abort();
  }, [ownerKey, foreground, controller.state.connectionState, signature, busy, partner?.id, partner?.revision, reload]);
  useEffect(() => () => request.current?.abort(), []);

  const act = (action: (signal: AbortSignal) => Promise<PartnerRestartResult>, closeConfirmation = false): void => {
    if (!ready || !foreground || busyRef.current || controller.state.connectionState !== "connected") return;
    busyRef.current = true; setBusy(true); onBusyChange?.(true); setError(undefined);
    request.current?.abort(); const abort = new AbortController(); request.current = abort;
    const active = (): boolean => !abort.signal.aborted && current.current.ownerKey === ownerKey && current.current.foreground;
    void action(abort.signal).then((result) => {
      if (!active()) return;
      const id = result.restart?.requestId;
      if (id) {
        if (result.restart!.phase === "ready") { receipts.current!.resolve(id); setRecords((old) => { const next = new Map(old); next.delete(id); return next; }); }
        else setRecords((old) => new Map(old).set(id, result.restart));
      }
      if (result.restart?.phase === "ready") setSucceeded(true);
      if (closeConfirmation) current.current.onClose();
      current.current.onChanged();
    }).catch(() => { if (active()) setError(t("partners.restartUnknown")); })
      .finally(() => { busyRef.current = false; if (current.current.ownerKey === ownerKey) { setBusy(false); onBusyChange?.(false); } });
  };
  const restart = (): void => {
    if (!partner || !available || records.size > 0) return;
    const id = crypto.randomUUID(); const selected = partner;
    act(async (signal) => {
      const controls = await current.current.controller.getPartnerRestartControls(selected.id, signal);
      if (!controls.available || controls.revision !== selected.revision) throw new Error("Refresh the Partner before restarting.");
      signal.throwIfAborted(); receipts.current!.claim(id);
      setRecords((old) => new Map(old).set(id, undefined));
      signal.throwIfAborted();
      return { restart: await current.current.controller.restartPartner(id, selected.id, selected.revision, signal), retired: false };
    }, true);
  };
  const recover = (id: string, kind: "read" | "retry" | "retire"): void => act(async (signal) => {
    const result = kind === "retry" ? { restart: await current.current.controller.retryPartnerRestart(id, signal), retired: false }
      : kind === "retire" ? await current.current.controller.retirePartnerRestart(id, signal)
        : await current.current.controller.getPartnerRestart(id, signal);
    if (result.retired) { receipts.current!.resolve(id); setRecords((old) => { const next = new Map(old); next.delete(id); return next; }); }
    return result;
  });
  return <>
    {(records.size > 0 || error) && <section className="partner-state-panel" aria-label={t("partners.restartRecovery")}>
      <h2>{t("partners.restartRecovery")}</h2>{error && <p role="alert">{error}</p>}
      {[...records].map(([id, record]) => <div key={id} className="partner-delete-dialog">
        <p role="status">{t(!record ? "partners.restartUnknown" : record.runtimeClosePending ? "partners.restart.runtime_close_pending" : `partners.restart.${record.phase}`)}</p>
        <div className="modal__actions"><Button disabled={busy || !ready} onClick={() => recover(id, "read")}>{t("partners.checkRestart")}</Button>
          {record && record.phase !== "ready" && <Button disabled={busy || !ready} onClick={() => recover(id, "retry")}>{t("partners.retryRestart")}</Button>}
          {!record && <Button disabled={busy || !ready} onClick={() => recover(id, "retire")}>{t("partners.retireRestart")}</Button>}</div>
      </div>)}
    </section>}
    {succeeded && <p role="status">{t("partners.restart.ready")}</p>}
    <Modal open={partner !== undefined} title={t("partners.restartTitle", { name: partner?.displayName ?? "" })}
      description={t("partners.restartBody")} size="small" onClose={busy ? () => undefined : onClose}>
      <div className="partner-delete-dialog">
        {error && <p role="alert">{error}</p>}
        {!ready && <p role="status">{t("common.loading")}</p>}
        {error && <Button disabled={busy} onClick={() => setReload((value) => value + 1)}>{t("common.retry")}</Button>}
        {!available && ready && <p role="status">{t("partners.restartUnavailable")}</p>}
        <div className="modal__actions"><Button onClick={onClose} disabled={busy}>{t("common.cancel")}</Button>
          <Button disabled={!ready || !available || busy || records.size > 0} onClick={restart}>
            {busy ? t("common.working") : t("partners.restartAction")}</Button></div>
      </div>
    </Modal>
  </>;
}
