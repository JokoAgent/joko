import { useEffect, useRef, useState, type JSX } from "react";
import { ShieldAlert } from "lucide-react";
import type { Translator } from "./types.js";
import { Button, Modal } from "./ui.js";

interface PermissionConfirmation {
  readonly scope: string;
  readonly ownerDocument: Document;
  readonly accept: () => void;
  readonly cancel?: () => void;
}

export function usePartnerPermissionConfirmation(scope: string, available: boolean, t: Translator) {
  const rootRef = useRef<HTMLElement | null>(null);
  const latest = useRef({ scope, available });
  latest.current = { scope, available };
  const [pending, setPending] = useState<PermissionConfirmation>();
  const pendingRef = useRef<PermissionConfirmation | undefined>(undefined);
  const retire = (candidate?: PermissionConfirmation): void => {
    if (candidate !== undefined && pendingRef.current !== candidate) return;
    pendingRef.current = undefined;
    setPending(undefined);
  };
  useEffect(() => {
    if (pendingRef.current?.scope !== scope || !available) retire();
  }, [scope, available]);
  useEffect(() => {
    if (pending === undefined) return;
    const ownerWindow = pending.ownerDocument.defaultView;
    const stop = (): void => retire(pending);
    const visibility = (): void => { if (pending.ownerDocument.visibilityState === "hidden") stop(); };
    ownerWindow?.addEventListener("pagehide", stop);
    ownerWindow?.addEventListener("blur", stop);
    pending.ownerDocument.addEventListener("visibilitychange", visibility);
    return () => {
      ownerWindow?.removeEventListener("pagehide", stop);
      ownerWindow?.removeEventListener("blur", stop);
      pending.ownerDocument.removeEventListener("visibilitychange", visibility);
      if (pendingRef.current === pending) pendingRef.current = undefined;
    };
  }, [pending]);
  useEffect(() => () => { pendingRef.current = undefined; }, []);
  const request = (accept: () => void, cancel?: () => void): void => {
    const ownerDocument = rootRef.current?.ownerDocument;
    if (latest.current.scope !== scope || !latest.current.available || ownerDocument?.defaultView === null || ownerDocument === undefined
      || ownerDocument.visibilityState === "hidden" || pendingRef.current !== undefined) return;
    const candidate = { scope, ownerDocument, accept, cancel };
    pendingRef.current = candidate;
    setPending(candidate);
  };
  const active = pending?.scope === scope && available ? pending : undefined;
  const dialog: JSX.Element = <Modal open={active !== undefined} ownerDocument={active?.ownerDocument}
    title={t("permission.full")} description={t("permission.fullHelp")} dialogRole="alertdialog" size="small"
    onClose={() => { if (active !== undefined) { retire(active); active.cancel?.(); } }}>
    <div className="risk-confirmation"><div className="risk-confirmation__icon"><ShieldAlert aria-hidden="true" /></div>
      <p>{t("permission.fullHelp")}</p><div className="modal__actions">
        <Button onClick={() => { if (active !== undefined) { retire(active); active.cancel?.(); } }}>{t("common.cancel")}</Button>
        <Button tone="danger" onClick={() => {
          if (active === undefined || pendingRef.current !== active || latest.current.scope !== active.scope
            || !latest.current.available || !rootRef.current?.isConnected || rootRef.current.ownerDocument !== active.ownerDocument
            || active.ownerDocument.visibilityState === "hidden") { retire(active); return; }
          retire(active);
          active.accept();
        }}>{t("common.enable")} {t("permission.full")}</Button>
      </div></div>
  </Modal>;
  return { rootRef, request, dialog };
}
