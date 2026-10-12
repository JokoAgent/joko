import { useEffect, useRef, useState, type JSX } from "react";
import type { PartnerDeletionResult, PartnerDeletionView } from "@joko/contracts";
import type { AppController } from "../controller.js";
import type { PartnerProfileView } from "../model.js";
import { PartnerDeletionReceipts } from "../partner-deletion-receipts.js";
import type { Translator } from "./types.js";
import { Button, Modal } from "./ui.js";

export function PartnerDeletionPanel({ controller, ownerKey, foreground, partner, pending, t, onClose, onChanged }: {
  readonly controller: AppController; readonly ownerKey: string; readonly foreground: boolean;
  readonly partner?: PartnerProfileView; readonly pending: readonly PartnerDeletionView[];
  readonly t: Translator; readonly onClose: () => void; readonly onChanged: () => void;
}): JSX.Element {
  const current = useRef({ controller, ownerKey, foreground, onClose, onChanged });
  current.current = { controller, ownerKey, foreground, onClose, onChanged };
  const receipts = useRef<PartnerDeletionReceipts | undefined>(undefined);
  const request = useRef<AbortController | undefined>(undefined);
  const busyRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string>();
  const [confirmation, setConfirmation] = useState("");
  const [records, setRecords] = useState<ReadonlyMap<string, PartnerDeletionView | undefined>>(new Map());
  const signature = JSON.stringify(pending.map((item) => [item.requestId, item.phase, item.failure]));
  useEffect(() => setConfirmation(""), [partner?.id, partner?.revision]);
  useEffect(() => {
    if (!foreground || controller.state.connectionState !== "connected") { request.current?.abort(); setReady(false); return; }
    if (busyRef.current) return;
    const abort = new AbortController(); request.current?.abort(); request.current = abort;
    const active = (): boolean => !abort.signal.aborted && current.current.ownerKey === ownerKey && current.current.foreground;
    const run = async (): Promise<void> => {
      try {
        const storage = document.defaultView?.localStorage;
        if (!storage) throw new Error("Receipt storage unavailable.");
        const store = receipts.current ??= new PartnerDeletionReceipts(storage, controller.state.activeProfile);
        const ids = [...new Set([...store.list(), ...pending.map((item) => item.requestId)])];
        setReady(true);
        for (const id of ids) {
          if (!active()) return;
          setRecords((old) => new Map(old).set(id, pending.find((item) => item.requestId === id)));
          const result = await current.current.controller.getPartnerDeletion(id, abort.signal);
          if (!active()) return;
          if (result.retired || result.deletion?.phase === "completed") {
            store.resolve(id); setRecords((old) => { const next = new Map(old); next.delete(id); return next; });
          } else setRecords((old) => new Map(old).set(id, result.deletion));
        }
      } catch { if (active()) setError(t("partners.deletionUnknown")); }
    };
    if (!busyRef.current) void run();
    return () => abort.abort();
  }, [ownerKey, foreground, controller.state.connectionState, signature, busy]);
  useEffect(() => () => request.current?.abort(), []);

  const act = (action: (signal: AbortSignal) => Promise<PartnerDeletionResult>, deleting = false): void => {
    if (!ready || !foreground || busyRef.current || controller.state.connectionState !== "connected") return;
    busyRef.current = true; setBusy(true); setError(undefined);
    request.current?.abort(); const abort = new AbortController(); request.current = abort;
    const active = (): boolean => !abort.signal.aborted && current.current.ownerKey === ownerKey && current.current.foreground;
    void action(abort.signal).then((result) => {
      if (!active()) return;
      const id = result.deletion?.requestId;
      if (id) {
        if (result.deletion!.phase === "completed") { receipts.current!.resolve(id); setRecords((old) => { const next = new Map(old); next.delete(id); return next; }); }
        else setRecords((old) => new Map(old).set(id, result.deletion));
      }
      if (deleting) { setConfirmation(""); current.current.onClose(); }
      current.current.onChanged();
    }).catch(() => { if (active()) setError(t("partners.deletionUnknown")); })
      .finally(() => { busyRef.current = false; if (current.current.ownerKey === ownerKey) setBusy(false); });
  };
  const remove = (): void => {
    if (!partner || confirmation !== partner.displayName || records.size > 0) return;
    const id = crypto.randomUUID(); const selected = partner; const name = confirmation;
    act(async (signal) => {
      receipts.current!.claim(id);
      setRecords((old) => new Map(old).set(id, undefined));
      signal.throwIfAborted();
      return { deletion: await current.current.controller.deletePartner(id, selected.id, selected.revision, name, signal), retired: false };
    }, true);
  };
  const recover = (id: string, kind: "read" | "retry" | "retire"): void => act(async (signal) => {
    const result = kind === "retry" ? { deletion: await current.current.controller.retryPartnerDeletion(id, signal), retired: false }
      : kind === "retire" ? await current.current.controller.retirePartnerDeletion(id, signal)
        : await current.current.controller.getPartnerDeletion(id, signal);
    if (result.retired) { receipts.current!.resolve(id); setRecords((old) => { const next = new Map(old); next.delete(id); return next; }); }
    return result;
  });
  return <>
    {(records.size > 0 || error) && <section className="partner-state-panel" aria-label={t("partners.deletionRecovery")}>
      <h2>{t("partners.deletionRecovery")}</h2>{error && <p role="alert">{error}</p>}
      {[...records].map(([id, record]) => <div key={id} className="partner-delete-dialog">
        <p role="status">{t(!record ? "partners.deletionUnknown" : record.failure ? `partners.deletion.${record.failure}` : `partners.deletion.${record.phase}`)}</p>
        <div className="modal__actions"><Button disabled={busy || !ready} onClick={() => recover(id, "read")}>{t("partners.checkDeletion")}</Button>
          {record && record.phase !== "completed" && <Button disabled={busy || !ready} onClick={() => recover(id, "retry")}>{t("partners.retryDeletion")}</Button>}
          {!record && <Button disabled={busy || !ready} onClick={() => recover(id, "retire")}>{t("partners.retireDeletion")}</Button>}</div>
      </div>)}
    </section>}
    <Modal open={partner !== undefined} title={t("partners.deleteTitle", { name: partner?.displayName ?? "" })}
      description={t("partners.deleteBody")} size="small" onClose={busy ? () => undefined : onClose}>
      <div className="partner-delete-dialog"><p>{t("partners.deleteWarning")}</p>
        {error && <p role="alert">{error}</p>}<label className="field"><span>{t("partners.typeName", { name: partner?.displayName ?? "" })}</span>
          <input autoComplete="off" value={confirmation} disabled={busy || records.size > 0} onChange={(event) => setConfirmation(event.target.value)} /></label>
        <div className="modal__actions"><Button onClick={onClose} disabled={busy}>{t("common.cancel")}</Button>
          <Button tone="danger" disabled={!ready || busy || records.size > 0 || confirmation !== partner?.displayName} onClick={remove}>
            {busy ? t("common.working") : t("common.delete")}</Button></div>
      </div>
    </Modal>
  </>;
}
