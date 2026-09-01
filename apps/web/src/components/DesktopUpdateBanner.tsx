import { useEffect, useRef, useState, type JSX } from "react";
import { Check, Flame, LoaderCircle, X } from "lucide-react";

import { useDesktopUpdateBusyDeferral } from "../desktop-update-busy-deferral.js";
import {
  desktopUpdateApi,
  desktopUpdateIsPending,
  dismissDesktopUpdateBanner,
  restoreDesktopUpdateBanner,
  useDesktopUpdateBannerDismiss,
  useDesktopUpdateStatus
} from "../desktop-update.js";
import type { MessageKey } from "../i18n.js";
import type { Translator } from "./types.js";
import { IconButton, cx } from "./ui.js";

export interface DesktopUpdateBannerProps {
  readonly collapsed: boolean;
  readonly probeRuntimeActivity: () => Promise<boolean>;
  readonly t: Translator;
}

export function DesktopUpdateBanner({ collapsed, probeRuntimeActivity, t }: DesktopUpdateBannerProps): JSX.Element | null {
  const status = useDesktopUpdateStatus();
  const dismiss = useDesktopUpdateBannerDismiss();
  const hideUntilBusyDecision = useDesktopUpdateBusyDeferral(status, probeRuntimeActivity);
  const [confirming, setConfirming] = useState(false);
  const [actionError, setActionError] = useState<MessageKey>();
  const mountedRef = useRef(false);
  const actionEpochRef = useRef(0);
  const actionInFlightRef = useRef(false);
  const statusRef = useRef<JokoDesktopUpdateStatus | undefined>(undefined);
  const statusActionKey = desktopUpdateActionKey(status);
  const statusActionKeyRef = useRef<string | undefined>(undefined);
  const dismissRef = useRef(dismiss);
  const probeRuntimeActivityRef = useRef(probeRuntimeActivity);
  if (statusActionKeyRef.current !== statusActionKey || dismissRef.current !== dismiss) {
    // A preload push, dismissal, restore, or newer download invalidates an
    // outstanding probe. Equivalent ready snapshots keep the current action
    // alive so a failure result remains visible and retryable.
    actionEpochRef.current += 1;
    actionInFlightRef.current = false;
  }
  statusRef.current = status;
  statusActionKeyRef.current = statusActionKey;
  dismissRef.current = dismiss;
  probeRuntimeActivityRef.current = probeRuntimeActivity;
  const cancelRef = useRef<HTMLButtonElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const restoreTriggerFocusRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      actionEpochRef.current += 1;
      actionInFlightRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (statusRef.current?.status !== "ready") {
      setConfirming(false);
    }
    setActionError(undefined);
  }, [statusActionKey]);

  useEffect(() => {
    if (confirming) cancelRef.current?.focus();
    else if (restoreTriggerFocusRef.current) {
      restoreTriggerFocusRef.current = false;
      triggerRef.current?.focus();
    }
  }, [collapsed, confirming]);

  // Render Sidebar chrome only for an installable patch or while a
  // newer patch supersedes it. Initial checks/downloads and platform/manual
  // errors stay on their dedicated update surfaces.
  if (status === undefined || (status.status !== "ready" && status.status !== "superseding")) return null;
  if (!collapsed && (hideUntilBusyDecision || dismiss.dismissed)) return null;
  if (collapsed && dismiss.dismissed && dismiss.reason === "user") return null;

  const preparing = status.status === "superseding";

  const canContinue = (epoch: number, version: string): boolean => mountedRef.current
    && actionEpochRef.current === epoch
    && dismissRef.current.dismissed !== true
    && statusRef.current?.status === "ready"
    && statusRef.current.version === version;

  const relaunch = async (): Promise<void> => {
    const ready = statusRef.current;
    if (actionInFlightRef.current || ready?.status !== "ready" || dismissRef.current.dismissed) return;
    const updates = desktopUpdateApi();
    if (updates === undefined) {
      setActionError("desktop.updateActionUnavailable");
      return;
    }
    const epoch = ++actionEpochRef.current;
    const version = ready.version;
    actionInFlightRef.current = true;
    setActionError(undefined);
    try {
      if (!canContinue(epoch, version)) return;
      const result = await updates.relaunch({ allowBusy: true });
      if (canContinue(epoch, version) && !result.accepted) {
        if (result.reason === "busy") setConfirming(true);
        else setActionError(desktopUpdateRelaunchError(result.reason));
      }
    } catch {
      if (canContinue(epoch, version)) setActionError("desktop.updateRelaunchFailed");
    } finally {
      if (mountedRef.current && actionEpochRef.current === epoch) {
        actionInFlightRef.current = false;
      }
    }
  };

  const enterRelaunch = async (): Promise<void> => {
    const ready = statusRef.current;
    if (actionInFlightRef.current || ready?.status !== "ready" || dismissRef.current.dismissed) return;
    const updates = desktopUpdateApi();
    if (updates === undefined) {
      setActionError("desktop.updateActionUnavailable");
      return;
    }
    const epoch = ++actionEpochRef.current;
    const version = ready.version;
    actionInFlightRef.current = true;
    setActionError(undefined);
    let blocksShutdown = true;
    try {
      blocksShutdown = await probeRuntimeActivityRef.current();
    } catch {
      // An unavailable or stale owner probe cannot prove relaunch is safe.
      blocksShutdown = true;
    }
    if (!canContinue(epoch, version)) return;
    if (blocksShutdown) {
      actionInFlightRef.current = false;
      setConfirming(true);
      return;
    }
    try {
      const result = await updates.relaunch({ allowBusy: false });
      if (canContinue(epoch, version) && !result.accepted) {
        if (result.reason === "busy") setConfirming(true);
        else setActionError(desktopUpdateRelaunchError(result.reason));
      }
    } catch {
      if (canContinue(epoch, version)) setActionError("desktop.updateRelaunchFailed");
    } finally {
      if (mountedRef.current && actionEpochRef.current === epoch) {
        actionInFlightRef.current = false;
      }
    }
  };

  const cancelConfirmation = (): void => {
    restoreTriggerFocusRef.current = true;
    setConfirming(false);
  };

  const dismissBanner = (): void => {
    actionEpochRef.current += 1;
    actionInFlightRef.current = false;
    restoreTriggerFocusRef.current = false;
    setConfirming(false);
    dismissDesktopUpdateBanner(status);
  };

  if (collapsed) {
    if (status.status === "ready" && confirming) {
      return <div className="desktop-update-banner desktop-update-banner--rail is-confirming" data-status="ready">
        <IconButton label={t("desktop.updateRestartAnywayAria")} tip={t("desktop.updateRestartAnywayTooltip")} onClick={() => { void relaunch(); }}>
          <Check aria-hidden="true" />
        </IconButton>
        <IconButton buttonRef={cancelRef} label={t("desktop.updateCancelRestartAria")} tip={t("desktop.updateCancelRestartTooltip")} onClick={cancelConfirmation}>
          <X aria-hidden="true" />
        </IconButton>
      </div>;
    }
    if (status.status === "ready") {
      const error = actionError === undefined ? undefined : t(actionError);
      return <div
        className={cx("desktop-update-banner desktop-update-banner--rail", error !== undefined && "is-error")}
        data-status="ready"
        role={error === undefined ? undefined : "alert"}
        aria-live={error === undefined ? undefined : "assertive"}
      >
        <IconButton
          buttonRef={triggerRef}
          onClick={() => { void enterRelaunch(); }}
          label={error ?? t("desktop.updateReadyCollapsedAria", { version: status.version })}
          tip={error ?? t("desktop.updateReadyTooltip", { version: status.version })}
        >
          <Flame aria-hidden="true" />
          {error !== undefined && <span className="sr-only">{error}</span>}
        </IconButton>
      </div>;
    }
    return <div className="desktop-update-banner desktop-update-banner--rail" data-status="superseding" role="status" aria-label={t("desktop.updatePreparingAria")}>
      <IconButton label={t("desktop.updatePreparingAria")} disabled disabledReason={t("desktop.updatePreparing")}>
        <LoaderCircle className="is-spinning" aria-hidden="true" />
      </IconButton>
    </div>;
  }

  const title = desktopUpdateTitle(status, confirming, t);
  const subtitle = desktopUpdateSubtitle(status, t, confirming);
  const canDismiss = desktopUpdateIsPending(status);
  const leadIcon = preparing
    ? <LoaderCircle className="desktop-update-banner__lead is-spinning" aria-hidden="true" />
    : <Flame className="desktop-update-banner__lead" aria-hidden="true" />;

  return <section className={cx("desktop-update-banner desktop-update-banner--expanded", confirming && "is-confirming")} data-status={status.status} aria-label={t("desktop.updateBannerAria")}>
    {canDismiss && <IconButton
      className="desktop-update-banner__dismiss"
      label={t("desktop.updateDismissAria")}
      onClick={dismissBanner}
    ><X aria-hidden="true" /></IconButton>}
    {leadIcon}
    <strong className="desktop-update-banner__title">{title}</strong>
    <p className={cx("desktop-update-banner__subtitle", confirming && "is-warning")}>{subtitle}</p>
    {status.status === "ready" && (confirming
      ? <div className="desktop-update-banner__confirm-actions">
          <button type="button" className="desktop-update-banner__pill" onClick={() => { void relaunch(); }} aria-label={t("desktop.updateRestartAnywayAria")}>
            {t("desktop.updateRestartAnyway")}
          </button>
          <button ref={cancelRef} type="button" className="desktop-update-banner__cancel" onClick={cancelConfirmation} aria-label={t("desktop.updateCancelRestartAria")}>{t("common.cancel")}</button>
        </div>
      : <button ref={triggerRef} type="button" className="desktop-update-banner__pill" onClick={() => { void enterRelaunch(); }} aria-label={t("desktop.updateRelaunchAria", { version: status.version })}>
          {t("desktop.updateRelaunch")}
        </button>)}
    {preparing && <button type="button" className="desktop-update-banner__pill" disabled aria-label={t("desktop.updatePreparingAria")}>
      <LoaderCircle className="is-spinning" aria-hidden="true" />{t("desktop.updatePreparing")}
    </button>}
    {actionError !== undefined && <p className="desktop-update-banner__error" role="alert">{t(actionError)}</p>}
  </section>;
}

export function DesktopUpdateRestoreButton({ suppressBusy = false, t }: {
  readonly suppressBusy?: boolean;
  readonly t: Translator;
}): JSX.Element | null {
  const status = useDesktopUpdateStatus();
  const dismiss = useDesktopUpdateBannerDismiss();
  if (
    !dismiss.dismissed
    || !desktopUpdateIsPending(status)
    || suppressBusy && dismiss.reason === "busy"
  ) return null;
  return <IconButton className="desktop-update-restore" label={t("desktop.updateRestoreAria")} onClick={restoreDesktopUpdateBanner}>
    <Flame aria-hidden="true" />
  </IconButton>;
}

function desktopUpdateTitle(status: Extract<JokoDesktopUpdateStatus, { readonly status: "ready" | "superseding" }>, confirming: boolean, t: Translator): string {
  if (status.status === "ready") return confirming
    ? t("desktop.updateBusyTitle")
    : t("desktop.updateReadyTitle", { version: status.version });
  return t("desktop.updateSupersedingTitle");
}

function desktopUpdateSubtitle(
  status: Extract<JokoDesktopUpdateStatus, { readonly status: "ready" | "superseding" }>,
  t: Translator,
  confirming = false
): string {
  if (confirming && status.status === "ready") return t("desktop.updateBusyHint");
  if (status.status === "ready") return t("desktop.updateReadySubtitle");
  return t("desktop.updatePreparing");
}

function desktopUpdateRelaunchError(reason: Exclude<JokoDesktopUpdateRelaunchResult, { readonly accepted: true }>["reason"]): MessageKey {
  if (reason === "orchestrator-shutdown-failed") return "desktop.updateErrorOrchestratorShutdown";
  if (reason === "apply-failed") return "desktop.updateErrorApply";
  return "desktop.updateNoLongerReady";
}

function desktopUpdateActionKey(status: JokoDesktopUpdateStatus | undefined): string | undefined {
  if (status?.status === "ready") return `ready\0${status.version}`;
  if (status?.status === "superseding") return `superseding\0${status.version}\0${status.nextVersion}`;
  return status?.status;
}
