import { fromPartnerWorkingPhase, workingStatusTurnKey, type PartnerWorkingStatus, type SessionWorkingStatus } from "@joko/contracts";
import type { AppSnapshot, PartnerProfileView } from "./model.js";

export function mapPartnerWorkingStatus(value: PartnerWorkingStatus): SessionWorkingStatus {
  const phase = fromPartnerWorkingPhase(value.phase);
  if (!phase || value.generation < 1n || ![value.sessionId, value.targetId, value.backendId].every(validId)
    || value.runId !== "" && !validId(value.runId) || value.attemptId !== "" && !validId(value.attemptId)
    || value.runId === "" && value.attemptId !== "" || !validWorkingCaption(value.caption)) {
    throw new Error("The Joko node returned invalid Partner working facts.");
  }
  return { sessionId: value.sessionId, targetId: value.targetId, backendId: value.backendId, generation: value.generation,
    runId: value.runId, attemptId: value.attemptId, phase };
}

export function validWorkingCaption(value: string): boolean {
  return value.length <= 64 && !/[<>`/\\\r\n\p{Cc}\p{Cf}]/u.test(value);
}

/** Host facts remain display-only and must agree with this live Snapshot. */
export function currentPartnerWorkingStatus(partner: PartnerProfileView, snapshot: AppSnapshot): SessionWorkingStatus | undefined {
  if (partner.lifecycle !== "active" || partner.initializationState !== "ready") return undefined;
  const matches = snapshot.sessions.filter((session) => session.id === partner.canonicalSessionId
    && session.targetId === partner.homeTargetId && !session.archived && session.generation > 0n);
  const session = matches.length === 1 ? matches[0] : undefined;
  if (!session || !["running", "retrying"].includes(session.state) && session.compacting !== true) return undefined;
  if (snapshot.interactions.some((interaction) => interaction.sessionId === session.id && interaction.generation === session.generation)) return undefined;
  if (snapshot.targets.filter((target) => target.id === session.targetId).length !== 1
    || snapshot.backends.filter((backend) => backend.id === session.backendId && backend.health !== "unavailable").length !== 1) return undefined;
  const identity = { sessionId: session.id, targetId: session.targetId, backendId: session.backendId,
    generation: session.generation, runId: session.activeRunId ?? "", attemptId: session.activeAttemptId ?? "" };
  const host = partner.activity.workingStatus;
  const phase = session.compacting === true ? "compacting" : host && workingStatusTurnKey(host) === workingStatusTurnKey(identity)
    ? host.phase : session.state === "retrying" ? "reconnecting" : "processing";
  return { ...identity, phase };
}

function validId(value: string): boolean { return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(value); }
