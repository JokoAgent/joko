import { LoaderCircle } from "lucide-react";
import type { JSX } from "react";
import { workingStatusTurnKey, type SessionWorkingStatus } from "@joko/contracts";
import type { AppController } from "../controller.js";
import type { PartnerProfileView, SessionView } from "../model.js";
import { currentPartnerWorkingStatus } from "../partner-working-status.js";
import { PartnerAvatar } from "./PartnerAvatar.js";
import { usePartnerConversation } from "./PartnerConversation.js";
import { PartnerWorkingStatusText } from "./PartnerWorkingStatusText.js";
import { partnerWorkingOwnerKey, usePartnerDocumentForeground, usePartnerWorkingCaption, usePartnerWorkingProfile } from "./use-partner-working-status.js";
import type { Translator } from "./types.js";
import "./partner-working-status.css";

export function PartnerWorkingLabel({ controller, partner, status, ownerKey, t }: {
  readonly controller: AppController; readonly partner: PartnerProfileView; readonly status: SessionWorkingStatus;
  readonly ownerKey: string; readonly t: Translator;
}): JSX.Element {
  const caption = usePartnerWorkingCaption(controller, partner, status, ownerKey);
  return <span className="partner-working-label" data-working-phase={status.phase} data-working-copy-source={caption ? "generated" : "default"}>
    <PartnerWorkingStatusText key={`${ownerKey}:${workingStatusTurnKey(status)}`} text={caption ?? t(`partnerWorking.${status.phase}`)} />
  </span>;
}

export function PartnerWorkingStatus({ controller, session, backgroundTaskIds, suppressed = false, waiting = false, t }: {
  readonly controller: AppController; readonly session: SessionView; readonly backgroundTaskIds: readonly string[];
  readonly suppressed?: boolean; readonly waiting?: boolean; readonly t: Translator;
}): JSX.Element | null {
  const conversation = usePartnerConversation();
  const foreground = usePartnerDocumentForeground();
  const ownerKey = `${partnerWorkingOwnerKey(controller)}:${conversation?.ownerKey}`;
  const active = !suppressed && foreground && controller.state.ready && controller.state.connectionState === "connected"
    && conversation?.kind === "partner" && conversation.confirmed && conversation.editable && conversation.sessionId === session.id;
  const foregroundRunning = ["running", "retrying"].includes(session.state) || session.compacting === true;
  const backgroundOnly = !foregroundRunning && backgroundTaskIds.length > 0;
  const scope = JSON.stringify([ownerKey, session.id, session.generation.toString(), session.activeRunId, session.activeAttemptId]);
  const projection = usePartnerWorkingProfile(controller, conversation?.partner, scope, active && foregroundRunning);
  const profile = projection?.profile;
  const partner = profile ?? conversation?.partner;
  if (!active || !partner || partner.lifecycle !== "active" || partner.initializationState !== "ready"
    || partner.canonicalSessionId !== session.id || partner.homeTargetId !== session.targetId
    || !foregroundRunning && !backgroundOnly && !waiting && session.state !== "waiting") return null;
  const status = profile && currentPartnerWorkingStatus(profile, controller.state.snapshot);
  if (foregroundRunning && !waiting && projection?.observed && !profile?.activity.workingStatus) return null;
  if (foregroundRunning && !status && !waiting) return null;
  const background = { sessionId: session.id, targetId: session.targetId, backendId: session.backendId, generation: session.generation,
    runId: "", attemptId: "", phase: "processing" as const };
  return <div className="partner-working-status" role="status" aria-live="polite">
    <PartnerAvatar preset={partner.avatar} partner={partner} /><LoaderCircle className="partner-working-spinner" aria-hidden="true" />
    {waiting || session.state === "waiting" ? <PartnerWorkingStatusText key={`${scope}:waiting`} text={t("session.waiting")} />
      : <PartnerWorkingLabel controller={controller} partner={partner} status={backgroundOnly ? background : status!} ownerKey={ownerKey} t={t} />}
  </div>;
}
