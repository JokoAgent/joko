import { fromPartnerWorkingPhase, projectSessionWorkingStatus, workingStatusTurnKey,
  type PartnerWorkingStatus, type Event, type ObservedWorkingPhase, type SessionWorkingStatus } from "@joko/contracts";
import { mobilePartnerActivityState, type MobilePartnerDirectoryObservation } from "./mobile-partner-activity";
import type { MobilePartnerDirectoryProfile } from "./mobile-partner-directory";
import type { MobileSupportedLocale } from "./mobile-locale-preference";

export type MobilePartnerWorkingPhase = ObservedWorkingPhase;
export interface MobilePartnerWorkingStatus extends SessionWorkingStatus {
  readonly turnKey: string;
}

export interface MobilePartnerWorkingTransport {
  readonly ownerKey: string;
  read(partner: MobilePartnerDirectoryProfile, status: SessionWorkingStatus, locale: MobileSupportedLocale,
    signal: AbortSignal): Promise<string | undefined>;
}

/** Host facts are display-only until the current authenticated Snapshot agrees with their incarnation. */
export function projectMobilePartnerWorkingStatus(value: PartnerWorkingStatus): SessionWorkingStatus {
  const phase = fromPartnerWorkingPhase(value.phase);
  if (!phase || value.generation < 1n || ![value.sessionId, value.targetId, value.backendId].every(validId)
    || value.runId !== "" && !validId(value.runId) || value.attemptId !== "" && !validId(value.attemptId)
    || value.runId === "" && value.attemptId !== "" || value.caption.length > 64
    || /[<>`/\\\r\n\p{Cc}\p{Cf}]/u.test(value.caption)) throw new Error("The Joko node returned invalid Partner working facts.");
  return { sessionId: value.sessionId, targetId: value.targetId, backendId: value.backendId, generation: value.generation,
    runId: value.runId, attemptId: value.attemptId, phase };
}

export function mobilePartnerDirectoryWorkingStatus(partner: MobilePartnerDirectoryProfile,
  observation: MobilePartnerDirectoryObservation | undefined): MobilePartnerWorkingStatus | undefined {
  const host = partner.activity.workingStatus;
  if (!host || !observation?.online || partner.lifecycle !== "active" || partner.initializationState !== "ready"
    || !["working", "recovering", "compacting"].includes(mobilePartnerActivityState(partner, observation))) return undefined;
  const session = observation.snapshot.sessions.find((entry) => entry.sessionId === partner.canonicalSessionId)!;
  const local = projectSessionWorkingStatus(session, observation.snapshot.runs, observation.snapshot.interactions, []);
  return local && workingStatusTurnKey(local) === workingStatusTurnKey(host) ? { ...host,
    turnKey: JSON.stringify([observation.ownerKey, host.sessionId, host.generation.toString(), host.runId, host.attemptId]) } : undefined;
}

function validId(value: string): boolean { return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(value); }

/** The current canonical Run supplies facts even while the user reads an older message window. */
export function mobilePartnerWorkingStatus(partner: MobilePartnerDirectoryProfile | undefined,
  observation: MobilePartnerDirectoryObservation | undefined, events: readonly Event[]): MobilePartnerWorkingStatus | undefined {
  if (!partner || !observation?.online || partner.lifecycle !== "active" || partner.initializationState !== "ready"
    || !["working", "recovering", "compacting"].includes(mobilePartnerActivityState(partner, observation))) return undefined;
  const session = observation.snapshot.sessions.find((entry) => entry.sessionId === partner.canonicalSessionId)!;
  const status = projectSessionWorkingStatus(session, observation.snapshot.runs, observation.snapshot.interactions, events);
  return status && { ...status, turnKey: JSON.stringify([observation.ownerKey, status.sessionId,
    status.generation.toString(), status.runId, status.attemptId]) };
}
