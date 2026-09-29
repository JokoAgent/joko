import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import { AlertTriangle, CheckCircle2 } from "lucide-react";
import type { AppController } from "../controller.js";
import type { PortableReplacementCleanupView } from "../model.js";
import type { Translator } from "./types.js";
import { Button } from "./ui.js";

/** The task, not the transient import dialog, owns visibility of its cleanup receipt. */
export function PortableReplacementCleanupNotice({ controller, sessionId, t }: {
  readonly controller: AppController;
  readonly sessionId: string;
  readonly t: Translator;
}): JSX.Element | null {
  const controllerRef = useRef(controller);
  controllerRef.current = controller;
  const ownerKey = [
    controller.state.activeProfile?.serverId ?? "",
    controller.state.activeProfile?.id ?? "",
    controller.state.connectionGeneration ?? 0,
    sessionId
  ].join("\u0000");
  const ownerRef = useRef(ownerKey);
  ownerRef.current = ownerKey;
  const connected = controller.state.connectionState === "connected";
  const [statusOwner, setStatusOwner] = useState<string>();
  const [cleanup, setCleanup] = useState<PortableReplacementCleanupView>();
  const [inspection, setInspection] = useState<"present" | "absent" | "unknown">();
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    let active = true;
    setStatusOwner(undefined);
    setCleanup(undefined);
    setInspection(undefined);
    setConfirming(false);
    setError(false);
    setBusy(false);
    if (connected) {
      void controllerRef.current.getPortableReplacementCleanup(sessionId).then((value) => {
        if (active && ownerRef.current === ownerKey) {
          setCleanup(value);
          setStatusOwner(ownerKey);
        }
      }).catch(() => {
        if (active && ownerRef.current === ownerKey) {
          setError(true);
          setStatusOwner(ownerKey);
        }
      });
    }
    return () => { active = false; };
  }, [connected, ownerKey, sessionId]);

  const run = async (action: "refresh" | "inspect" | "retry"): Promise<void> => {
    if (!connected || busy) return;
    const owner = ownerKey;
    const revision = statusOwner === ownerKey ? cleanup?.revision : undefined;
    setBusy(true);
    setConfirming(false);
    setError(false);
    try {
      if (action === "refresh") {
        const value = await controllerRef.current.getPortableReplacementCleanup(sessionId);
        if (ownerRef.current !== owner) return;
        setCleanup(value);
        setInspection(undefined);
        setStatusOwner(owner);
      } else {
        if (action === "retry" && revision === undefined) return;
        const result = action === "retry"
          ? await controllerRef.current.retryPortableReplacementCleanup(sessionId, revision!)
          : await controllerRef.current.reconcilePortableReplacementCleanup(sessionId);
        if (ownerRef.current !== owner) return;
        setCleanup(result.cleanup);
        setInspection(result.inspection);
        setStatusOwner(owner);
      }
    } catch {
      if (ownerRef.current === owner) {
        setError(true);
        setStatusOwner(owner);
      }
    } finally {
      if (ownerRef.current === owner) setBusy(false);
    }
  };

  if (!connected || statusOwner !== ownerKey || (cleanup === undefined && !error)) return null;
  const complete = cleanup?.nativeState === "completed" && cleanup.worktreeState === "completed";
  const title = cleanup === undefined ? t("portable.cleanupLoadFailed")
    : complete ? t("portable.cleanupComplete")
      : cleanup.nativeState === "completed" ? t("portable.cleanupWorktreePending")
        : cleanup.nativeState === "dispatched" || cleanup.nativeState === "pending"
          ? t("portable.cleanupInProgress")
          : inspection === "present" ? t("portable.cleanupPresent")
            : t("portable.cleanupUnknown");
  const description = cleanup?.nativeState === "unknown"
    ? inspection === "present" ? t("portable.cleanupPresentBody") : t("portable.cleanupUnknownBody")
    : cleanup?.nativeState === "completed" && cleanup.worktreeState === "pending"
      ? t("portable.cleanupWorktreeBody") : undefined;
  return <div className={`portable-cleanup-notice${complete ? " portable-cleanup-notice--complete" : ""}`} role={complete ? "status" : "alert"}>
    {complete ? <CheckCircle2 aria-hidden="true" /> : <AlertTriangle aria-hidden="true" />}
    <div className="portable-cleanup-notice__content">
      <strong>{title}</strong>
      {description !== undefined && <small>{description}</small>}
      {error && <small>{t("portable.cleanupActionFailed")}</small>}
      <div className="portable-cleanup-notice__actions">
        {cleanup?.nativeState === "unknown" && !confirming && <Button disabled={busy} onClick={() => { void run("inspect"); }}>{t("portable.cleanupVerify")}</Button>}
        {cleanup?.nativeState === "unknown" && inspection === "present" && !confirming && <Button tone="danger" disabled={busy} onClick={() => setConfirming(true)}>{t("portable.cleanupRetryDelete")}</Button>}
        {confirming && <>
          <small>{t("portable.cleanupConfirmBody")}</small>
          <Button tone="danger" disabled={busy} onClick={() => { void run("retry"); }}>{t("portable.cleanupConfirmDelete")}</Button>
          <Button tone="ghost" disabled={busy} onClick={() => setConfirming(false)}>{t("common.cancel")}</Button>
        </>}
        {cleanup?.nativeState === "completed" && cleanup.worktreeState === "pending" && <Button disabled={busy} onClick={() => { void run("inspect"); }}>{t("common.retry")}</Button>}
        {error && <Button disabled={busy} onClick={() => { void run("refresh"); }}>{t("common.refresh")}</Button>}
      </div>
    </div>
  </div>;
}
