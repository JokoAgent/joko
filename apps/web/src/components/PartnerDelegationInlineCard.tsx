import { FileText, RefreshCcw, Square, TriangleAlert } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";

import type { OperationApi, PartnerDelegationView } from "../model.js";
import { Button, Pill, cx } from "./ui.js";
import type { Translator } from "./types.js";
import "./partner-delegation-inline-card.css";

const ACTIVE_STATUSES = new Set<PartnerDelegationView["status"]>([
  "preparing",
  "queued",
  "running",
  "waiting",
  "unknown"
]);

export interface PartnerDelegationCardActions {
  readonly get?: OperationApi["getPartnerDelegation"];
  readonly cancel?: OperationApi["cancelPartnerDelegation"];
  readonly openSession?: (sessionId: string) => void;
}

export function PartnerDelegationInlineCard({ initial, targetName, ownerKey, actions, t }: {
  readonly initial: PartnerDelegationView;
  readonly targetName: string;
  readonly ownerKey: string;
  readonly actions: PartnerDelegationCardActions;
  readonly t: Translator;
}): JSX.Element {
  const [delegation, setDelegation] = useState(initial);
  const [refreshToken, setRefreshToken] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState<string>();
  const [now, setNow] = useState(Date.now());
  const currentRef = useRef(delegation);
  currentRef.current = delegation;

  useEffect(() => {
    setDelegation(initial);
    setError(undefined);
  }, [initial.id, initial.revision, ownerKey]);

  useEffect(() => {
    if (!partnerDelegationActive(delegation.status)) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [delegation.status]);

  useEffect(() => {
    if (actions.get === undefined) return;
    const abort = new AbortController();
    let timer: number | undefined;
    const refresh = async (): Promise<void> => {
      setRefreshing(true);
      try {
        const current = await actions.get!(initial.requesterPartnerId, initial.id, abort.signal);
        if (abort.signal.aborted) return;
        currentRef.current = current;
        setDelegation(current);
        setError(undefined);
        if (partnerDelegationActive(current.status)) timer = window.setTimeout(() => void refresh(), 2_000);
      } catch {
        if (abort.signal.aborted) return;
        setError(t("partners.delegationStale"));
        if (partnerDelegationActive(currentRef.current.status)) timer = window.setTimeout(() => void refresh(), 2_000);
      } finally {
        if (!abort.signal.aborted) setRefreshing(false);
      }
    };
    void refresh();
    return () => {
      abort.abort();
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [actions.get, initial.id, initial.requesterPartnerId, ownerKey, refreshToken, t]);

  const cancel = async (): Promise<void> => {
    if (actions.cancel === undefined || cancelling) return;
    setCancelling(true);
    setError(undefined);
    try {
      const updated = await actions.cancel(
        delegation.requesterPartnerId,
        delegation.id,
        delegation.revision
      );
      currentRef.current = updated;
      setDelegation(updated);
    } catch {
      setError(t("partners.cancelDelegationFailed"));
      setRefreshToken((value) => value + 1);
    } finally {
      setCancelling(false);
    }
  };

  const active = partnerDelegationActive(delegation.status);
  const tone = delegation.status === "completed" ? "success"
    : delegation.status === "failed" ? "danger"
      : delegation.status === "unknown" || delegation.status === "waiting" ? "warning"
        : delegation.status === "running" ? "accent" : "neutral";
  const durationEnd = delegation.completedAt ?? (active ? now : delegation.updatedAt);
  return <article
    className={cx("partner-delegation-inline", `is-${delegation.status}`)}
    aria-label={t("partners.delegationCard", { title: delegation.title })}
  >
    <header>
      <div><strong>{delegation.title}</strong><small>{t("partners.delegatedTo", { name: targetName })}</small></div>
      <Pill tone={tone}>{t(`partners.delegationState.${delegation.status}`)}</Pill>
    </header>
    <p className="partner-delegation-inline__objective">{delegation.objective}</p>
    <div className="partner-delegation-inline__meta">
      <span>{formatPartnerDuration(Math.max(0, durationEnd - (delegation.startedAt ?? delegation.createdAt)), t)}</span>
      <span>{t("partners.artifactCount", { count: delegation.artifactCount })}</span>
    </div>
    {delegation.status === "waiting" && <p className="partner-delegation-inline__notice">{t("partners.delegationWaitingBody")}</p>}
    {delegation.status === "unknown" && <p className="partner-delegation-inline__notice"><TriangleAlert aria-hidden="true" />{t("partners.delegationUnknownBody")}</p>}
    {delegation.resultSummary !== undefined && <div className="partner-delegation-inline__result"><strong>{t("partners.delegationResult")}</strong><p>{delegation.resultSummary}</p></div>}
    {delegation.error !== undefined && delegation.status === "failed" && <p className="partner-delegation-inline__error" role="alert">{delegation.error}</p>}
    {error !== undefined && <p className="partner-delegation-inline__stale" role="status"><TriangleAlert aria-hidden="true" /><span>{error}</span>{actions.get !== undefined && <Button tone="ghost" disabled={refreshing} onClick={() => setRefreshToken((value) => value + 1)}><RefreshCcw aria-hidden="true" />{t("common.retry")}</Button>}</p>}
    {(delegation.childSessionId !== undefined || active && actions.cancel !== undefined) && <footer>
      {delegation.childSessionId !== undefined && actions.openSession !== undefined && <Button tone="secondary" onClick={() => actions.openSession?.(delegation.childSessionId!)}><FileText aria-hidden="true" />{t("partners.openDelegatedTask")}</Button>}
      {active && actions.cancel !== undefined && <Button tone="ghost" disabled={cancelling} onClick={() => void cancel()}><Square aria-hidden="true" />{cancelling ? t("common.working") : t("partners.stopDelegation")}</Button>}
    </footer>}
  </article>;
}

export function partnerDelegationActive(status: PartnerDelegationView["status"]): boolean {
  return ACTIVE_STATUSES.has(status);
}

export function formatPartnerDuration(durationMs: number, t: Translator): string {
  const totalSeconds = Math.floor(durationMs / 1_000);
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  return hours > 0
    ? t("partners.duration.hoursMinutes", { hours, minutes })
    : minutes > 0
      ? t("partners.duration.minutes", { count: minutes })
      : t("partners.duration.seconds", { count: seconds });
}
