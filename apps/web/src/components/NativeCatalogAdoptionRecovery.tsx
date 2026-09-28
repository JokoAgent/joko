import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import { AlertTriangle, CheckCircle2 } from "lucide-react";
import type { AppController } from "../controller.js";
import type { NativeCatalogAdoptionView } from "../model.js";
import type { Translator } from "./types.js";
import { Button } from "./ui.js";

/** A durable, connection-owned recovery surface for pre-adoption native effects. */
export function NativeCatalogAdoptionRecovery({ controller, t, onResolved, refreshKey }: {
  readonly controller: AppController;
  readonly t: Translator;
  readonly onResolved?: () => void;
  readonly refreshKey?: number;
}): JSX.Element | null {
  const controllerRef = useRef(controller);
  controllerRef.current = controller;
  const resolvedRef = useRef(onResolved);
  resolvedRef.current = onResolved;
  const ownerKey = [
    controller.state.activeProfile?.serverId ?? "",
    controller.state.activeProfile?.id ?? "",
    controller.state.connectionGeneration ?? 0
  ].join("\u0000");
  const ownerRef = useRef(ownerKey);
  ownerRef.current = ownerKey;
  const connected = controller.state.connectionState === "connected";
  const [statusOwner, setStatusOwner] = useState<string>();
  const [items, setItems] = useState<readonly NativeCatalogAdoptionView[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyOperationId, setBusyOperationId] = useState<string>();
  const [error, setError] = useState(false);
  const [lastInspection, setLastInspection] = useState<ReadonlyMap<string, "present" | "absent" | "unknown">>(new Map());

  useEffect(() => {
    let active = true;
    setStatusOwner(undefined);
    setItems([]);
    setError(false);
    setLastInspection(new Map());
    setBusyOperationId(undefined);
    setLoading(connected);
    if (connected) {
      void controllerRef.current.listNativeCatalogAdoptions().then((next) => {
        if (active && ownerRef.current === ownerKey) {
          setItems(next);
          setStatusOwner(ownerKey);
          setLoading(false);
        }
      }).catch(() => {
        if (active && ownerRef.current === ownerKey) {
          setError(true);
          setStatusOwner(ownerKey);
          setLoading(false);
        }
      });
    }
    return () => { active = false; };
  }, [connected, ownerKey, refreshKey]);

  const refresh = async (): Promise<void> => {
    if (!connected || loading || busyOperationId !== undefined) return;
    const owner = ownerKey;
    setLoading(true);
    setError(false);
    try {
      const next = await controllerRef.current.listNativeCatalogAdoptions();
      if (ownerRef.current !== owner) return;
      setItems(next);
      setStatusOwner(owner);
      setLastInspection(new Map());
    } catch {
      if (ownerRef.current === owner) setError(true);
    } finally {
      if (ownerRef.current === owner) setLoading(false);
    }
  };

  const reconcile = async (operationId: string): Promise<void> => {
    if (!connected || loading || busyOperationId !== undefined) return;
    const owner = ownerKey;
    setBusyOperationId(operationId);
    setError(false);
    try {
      const result = await controllerRef.current.reconcileNativeCatalogAdoption(operationId);
      if (ownerRef.current !== owner) return;
      setItems((current) => current.map((item) => item.operationId === operationId ? result.adoption : item));
      setLastInspection((current) => new Map(current).set(operationId, result.inspection));
      if (result.adoption.state !== "pending") resolvedRef.current?.();
    } catch {
      if (ownerRef.current === owner) setError(true);
    } finally {
      if (ownerRef.current === owner) setBusyOperationId(undefined);
    }
  };

  if (!connected || (statusOwner !== ownerKey && !loading)) return null;
  if (!loading && items.length === 0 && !error) return null;
  return <section className="native-catalog-recovery" aria-label={t("settings.sessionImport.recoveryTitle")}
    aria-busy={loading}>
    <header>
      <strong>{t("settings.sessionImport.recoveryTitle")}</strong>
      <Button disabled={loading || busyOperationId !== undefined} onClick={() => { void refresh(); }}>
        {t("common.refresh")}
      </Button>
    </header>
    {loading && <p role="status">{t("settings.sessionImport.recoveryLoading")}</p>}
    {error && <p role="alert">{t("settings.sessionImport.recoveryLoadFailed")}</p>}
    {items.map((item) => {
      const inspection = lastInspection.get(item.operationId);
      const terminal = item.state !== "pending";
      const detail = item.state === "adopted"
        ? t("settings.sessionImport.recoveryAdopted")
        : item.state === "absent"
          ? t("settings.sessionImport.recoveryAbsent")
          : inspection === "unknown"
            ? t("settings.sessionImport.recoveryUnknown")
            : t("settings.sessionImport.recoveryPending");
      return <div key={item.operationId} className="native-catalog-recovery__item" role={terminal ? "status" : "alert"}>
        {terminal ? <CheckCircle2 aria-hidden="true" /> : <AlertTriangle aria-hidden="true" />}
        <div>
          <strong>{item.title}</strong>
          <p>{detail}</p>
          {item.state === "pending" && <Button disabled={loading || busyOperationId !== undefined}
            onClick={() => { void reconcile(item.operationId); }}>
            {busyOperationId === item.operationId
              ? t("settings.sessionImport.recoveryVerifying")
              : t("settings.sessionImport.recoveryVerify")}
          </Button>}
        </div>
      </div>;
    })}
  </section>;
}
