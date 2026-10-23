import { isPartnerNetworkFailureCode } from "@joko/contracts";
import { networkIdentity, PartnerNetworkStoreError, type PartnerNetworkStore, type NetworkExecution } from "@joko/store";
import { partnerNetworkRuntimeFailureCode } from "./partner-network-failure.js";

/** A bounded source selection, independent of the latest message/execution page.
 * Every pointer is read from the room authority at query time. */
export function readCurrentPartnerNetworkFailures(storage: PartnerNetworkStore, roomId: string, actorId: string, sourceMessageIds: readonly string[]): NetworkExecution[] {
  const { room } = storage.assertJoined(roomId, actorId);
  if (sourceMessageIds.length > 100) throw new PartnerNetworkStoreError("invalid");
  const selected = new Set(sourceMessageIds.map(networkIdentity)), messages = new Map(storage.messages(roomId).map(message => [message.id, message]));
  const visible = new Set([...selected].filter(id => { const message = messages.get(id); return message && !message.deleted
    && (!message.threadRootId || messages.get(message.threadRootId)?.deleted === false); }));
  const jobs = storage.executions(roomId).filter(job => visible.has(job.sourceMessageId)), current = new Map<string, NetworkExecution>();
  for (const sourceId of visible) {
    const round = storage.rounds.current(roomId, sourceId);
    if (round && round.state !== "stopped") for (const job of jobs) {
      if (job.sourceMessageId !== sourceId || job.roundId !== round.id || job.kind === "plan-step" || job.kind === "plan-decision") continue;
      const key = `${sourceId}\0${job.actorId}`, previous = current.get(key);
      if (!previous || (job.circle ?? 0) > (previous.circle ?? 0)) current.set(key, job);
    }
    const decision = storage.plans.decisionExecution(roomId, sourceId);
    if (decision) {
      const plan = decision.planId ? storage.plans.get(roomId, decision.planId) : undefined;
      if (!plan || !["completed", "stopped", "dismissed", "superseded"].includes(plan.status)) current.set(`decision\0${sourceId}`, decision);
    }
  }
  for (const job of jobs) if (job.kind === "plan-step" && job.planId) {
    const plan = storage.plans.get(roomId, job.planId), step = plan.steps[job.planPosition ?? -1];
    if (plan.status === "waiting" && step?.status === "failed" && step.executionId === job.id && plan.currentStep === job.planPosition) current.set(`step\0${job.planId}\0${job.planPosition}`, job);
  }
  return [...current.values()].filter(job => ["failed", "unknown"].includes(job.status)).map(job => ({ ...job,
    failureCode: isPartnerNetworkFailureCode(job.failureCode) || job.failureCode === "input-unavailable" ? job.failureCode
      : job.failureCode === "timeout" ? "RUNTIME_TIMEOUT" : partnerNetworkRuntimeFailureCode(new Error(job.failureCode)) }));
}
