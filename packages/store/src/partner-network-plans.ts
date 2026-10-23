import { randomUUID } from "node:crypto";
import type { OperationalStore } from "./operational-store.js";
import { networkHash, networkIdentity, networkText, PartnerNetworkStoreError,
  type NetworkActor, type NetworkAttachment, type NetworkExecution, type NetworkMessage, type NetworkRoom } from "./partner-network-store.js";

export interface NetworkPlanStep {
  position: number; actorId: string; task: string; status: "pending" | "running" | "completed" | "failed";
  resultMessageId: string; startedAt: number; finishedAt: number; failureCode: string; executionId: string;
}
export interface NetworkPlan {
  id: string; roomId: string; revision: number; status: "proposed" | "running" | "waiting" | "completed" | "stopped" | "dismissed" | "superseded";
  sourceMessageId: string; requestText: string; requesterId: string; organizerId: string; steps: NetworkPlanStep[];
  currentStep: number; noteMessageIds: string[]; createdAt: number; updatedAt: number;
  requestMessageIds: string[];
}
export interface NetworkPlanDecision { needsPlan: boolean; steps: readonly { actorId: string; task: string }[]; }
export interface NetworkPlanAction {
  operationId: string; roomId: string; actorId: string; planId: string; expectedRevision: number; action: string;
  position: number; targetId: string; sourceMessageId: string;
}
export interface NetworkExecutionSettlement {
  roomId: string; ownerId: string; executionId: string; lease: number; action: string; text: string; failureCode: string;
  decision?: NetworkPlanDecision; attachments?: readonly NetworkAttachment[]; seenNoteIds?: readonly string[]; completionId?: string;
}
interface Port {
  store: OperationalStore; now(): number; room(id: string): NetworkRoom; save(room: NetworkRoom): void;
  message(roomId: string, id: string): NetworkMessage; jobs(roomId: string): NetworkExecution[];
  append(room: NetworkRoom, message: Omit<NetworkMessage, "id" | "sequence" | "createdAt" | "reactions" | "deleted">): NetworkMessage;
  enqueue(job: NetworkExecution): void; end(job: NetworkExecution, status: NetworkExecution["status"], failureCode?: string): NetworkExecution;
  cancel(roomId: string): void; ordinary(room: NetworkRoom, requesterId: string, message: NetworkMessage, roundId: string): void;
}
const open = (plan: NetworkPlan) => ["proposed", "running", "waiting"].includes(plan.status);

/** The room writer owns every plan transition and queues a step before any computer can execute it. */
export class PartnerNetworkPlans {
  constructor(readonly port: Port) {}
  #scope(roomId: string): string { return `partner-network.v1:${networkIdentity(roomId)}`; }
  list(roomId: string): NetworkPlan[] { return this.port.store.listSettingsByKeyPrefix("service", this.#scope(roomId), "plan:")
    .map(row => structuredClone(row.value as NetworkPlan)).sort((a, b) => a.createdAt - b.createdAt); }
  get(roomId: string, id: string): NetworkPlan {
    const value = this.port.store.findSetting<NetworkPlan>("service", this.#scope(roomId), `plan:${networkIdentity(id)}`)?.value;
    if (!value || value.roomId !== roomId) throw new PartnerNetworkStoreError("not_found"); return structuredClone(value);
  }
  current(roomId: string): NetworkPlan | undefined { return this.list(roomId).findLast(open); }
  #put(plan: NetworkPlan): NetworkPlan {
    const next = { ...plan, revision: plan.revision + 1, updatedAt: this.port.now() };
    this.port.store.setSetting("service", this.#scope(plan.roomId), `plan:${plan.id}`, next); return structuredClone(next);
  }
  eligible(room: NetworkRoom, requesterId: string): NetworkActor[] { return room.members.filter(actor => actor.kind === "partner" && actor.state === "joined"
    && room.members.some(owner => owner.id === actor.ownerId && owner.state === "joined") && (actor.ownerId === requesterId || actor.guestAccess !== "none")); }
  #organizer(room: NetworkRoom, requesterId: string): NetworkActor | undefined {
    const members = this.eligible(room, requesterId); return members.find(actor => actor.id === room.organizerId) ?? members[0];
  }
  onSend(room: NetworkRoom, requesterId: string, message: NetworkMessage, force: boolean, specific: boolean): boolean {
    if (specific || message.threadRootId || message.kind === "member-joined") return false;
    const plan = this.current(room.id);
    if (plan && ["running", "waiting"].includes(plan.status)) {
      if (plan.noteMessageIds.length >= 100) throw new PartnerNetworkStoreError("invalid", "Finish the current step before adding more notes.");
      plan.noteMessageIds.push(message.id);
      if (plan.status === "waiting") this.#begin(room, this.#put(plan), plan.currentStep, requesterId, false);
      else this.#put(plan);
      return true;
    }
    const organizer = this.#organizer(room, requesterId);
    if (!organizer) {
      if (force || plan?.status === "proposed") throw new PartnerNetworkStoreError("denied", "No available organizer can arrange this work.");
      return false;
    }
    this.port.cancel(room.id);
    this.#decision(room, requesterId, organizer, message, plan?.status === "proposed" ? "revise" : force ? "forced" : "auto", plan?.id ?? "");
    return true;
  }
  #job(room: NetworkRoom, requesterId: string, actor: NetworkActor, sourceMessageId: string, kind: "plan-decision" | "plan-step"): NetworkExecution {
    return { id: randomUUID(), roomId: room.id, actorId: actor.id, requesterId, sourceMessageId, kind,
      accessMode: actor.ownerId === requesterId ? "owner" : actor.guestAccess as "chat" | "tools", accessRevision: actor.accessRevision,
      status: "queued", lease: 0, leaseExpiresAt: 0, failureCode: "", roundId: randomUUID(), ordinal: 0 };
  }
  #decision(room: NetworkRoom, requesterId: string, organizer: NetworkActor, source: NetworkMessage, mode: "auto" | "forced" | "revise", previousId: string): void {
    const job = { ...this.#job(room, requesterId, organizer, source.id, "plan-decision"), decisionMode: mode, planId: previousId };
    this.port.enqueue(job); this.port.store.setSetting("service", this.#scope(room.id), `plan-decision-head:${networkHash(source.id)}`, { executionId: job.id });
  }
  decisionExecution(roomId: string, sourceMessageId: string): NetworkExecution | undefined {
    const head = this.port.store.findSetting<{ executionId: string }>("service", this.#scope(roomId), `plan-decision-head:${networkHash(sourceMessageId)}`)?.value;
    return head ? this.port.jobs(roomId).find(job => job.id === head.executionId && job.sourceMessageId === sourceMessageId && job.kind === "plan-decision") : undefined;
  }
  #begin(room: NetworkRoom, plan: NetworkPlan, position: number, requesterId: string, clearNotes: boolean): NetworkPlan {
    const step = plan.steps[position]; if (!step) throw new PartnerNetworkStoreError("invalid");
    const actor = this.eligible(room, requesterId).find(actor => actor.id === step.actorId);
    this.port.cancel(room.id); plan.currentStep = position; if (clearNotes) plan.noteMessageIds = [];
    if (!actor) {
      step.status = "failed"; step.failureCode = "runtime-unavailable"; step.finishedAt = this.port.now(); plan.status = "waiting";
    } else {
      step.status = "running"; step.failureCode = ""; step.startedAt = this.port.now(); step.finishedAt = 0; plan.status = "running";
      const job = { ...this.#job(room, requesterId, actor, plan.sourceMessageId, "plan-step"), planId: plan.id, planPosition: position };
      step.executionId = job.id; this.port.enqueue(job);
    }
    return this.#put(plan);
  }
  action(input: NetworkPlanAction): NetworkPlan | undefined {
    return this.port.store.transaction(() => {
      const room = this.port.room(input.roomId), member = room.members.find(actor => actor.id === input.actorId && actor.kind === "human" && actor.state === "joined");
      if (!member || room.state !== "active") throw new PartnerNetworkStoreError("denied");
      const key = `plan-operation:${networkHash([input.actorId, networkIdentity(input.operationId)])}`, digest = networkHash(input);
      const previous = this.port.store.findSetting<{ digest: string; plan?: NetworkPlan }>("service", this.#scope(room.id), key)?.value;
      if (previous) { if (previous.digest !== digest) throw new PartnerNetworkStoreError("changed"); return previous.plan && structuredClone(previous.plan); }
      let result: NetworkPlan | undefined;
      if (input.action === "retry-decision") {
        const source = this.port.message(room.id, input.sourceMessageId), old = this.decisionExecution(room.id, source.id);
        if (!old || !["failed", "unknown"].includes(old.status) || this.current(room.id)?.status !== undefined && this.current(room.id)?.status !== "proposed"
          || source.deleted || source.authorId !== input.actorId) throw new PartnerNetworkStoreError("denied");
        const organizer = this.#organizer(room, input.actorId); if (!organizer) throw new PartnerNetworkStoreError("denied");
        this.#decision(room, input.actorId, organizer, source, old.decisionMode === "revise" ? "revise" : "forced", old.planId ?? "");
      } else {
        const plan = this.get(room.id, input.planId);
        if (plan.revision !== input.expectedRevision || !open(plan)) throw new PartnerNetworkStoreError("changed", "Refresh the plan before changing it.");
        const step = plan.steps[input.position];
        switch (input.action) {
          case "start": if (plan.status !== "proposed") throw new PartnerNetworkStoreError("denied"); result = this.#begin(room, plan, 0, input.actorId, true); break;
          case "continue": if (plan.status !== "waiting" || plan.steps[plan.currentStep]?.status !== "completed") throw new PartnerNetworkStoreError("denied");
            result = this.#begin(room, plan, plan.currentStep + 1, input.actorId, true); break;
          case "retry": if (plan.status !== "waiting" || plan.steps[plan.currentStep]?.status !== "failed") throw new PartnerNetworkStoreError("denied");
            result = this.#begin(room, plan, plan.currentStep, input.actorId, false); break;
          case "dismiss": if (plan.status !== "proposed") throw new PartnerNetworkStoreError("denied"); plan.status = "dismissed"; result = this.#put(plan); break;
          case "stop": this.stop(room.id, plan.id); result = this.get(room.id, plan.id); break;
          case "reassign": if (!step || !["proposed", "waiting"].includes(plan.status) || plan.status === "waiting" && step.status === "completed"
            || !this.eligible(room, input.actorId).some(actor => actor.id === input.targetId)) throw new PartnerNetworkStoreError("denied");
            step.actorId = input.targetId; result = this.#put(plan); break;
          case "remove-step": if (!step || plan.status !== "proposed" || plan.steps.length < 2) throw new PartnerNetworkStoreError("denied");
            plan.steps.splice(input.position, 1); plan.steps.forEach((step, position) => { step.position = position; }); result = this.#put(plan); break;
          default: throw new PartnerNetworkStoreError("invalid");
        }
      }
      this.port.store.setSetting("service", this.#scope(room.id), key, { digest, ...(result ? { plan: result } : {}) }); this.port.save(room); return result;
    });
  }
  stop(roomId: string, planId?: string): void {
    const plan = planId ? this.get(roomId, planId) : this.current(roomId); if (!plan || !open(plan)) return;
    for (const job of this.port.jobs(roomId)) if (job.planId === plan.id) this.port.end(job, "cancelled");
    plan.status = "stopped"; for (const step of plan.steps) if (step.status === "running") { step.status = "failed"; step.finishedAt = this.port.now(); }
    this.#put(plan);
  }
  #settlementKey(job: NetworkExecution, completionId: string): string { return `plan-settlement:${networkHash([job.id, job.lease, completionId])}`; }
  receipt(input: NetworkExecutionSettlement): NetworkExecution | undefined {
    const key = this.#settlementKey({ id: input.executionId, lease: input.lease } as NetworkExecution, input.completionId ?? "");
    const old = this.port.store.findSetting<{ digest: string; job: NetworkExecution }>("service", this.#scope(input.roomId), key)?.value;
    if (!old) return undefined; if (old.digest !== networkHash(input)) throw new PartnerNetworkStoreError("changed"); return structuredClone(old.job);
  }
  settle(room: NetworkRoom, actor: NetworkActor, job: NetworkExecution, input: NetworkExecutionSettlement, failureCode: string): NetworkExecution {
    if (job.kind === "plan-decision") return this.#settleDecision(room, actor, job, input, failureCode);
    const plan = this.get(room.id, job.planId ?? ""), step = plan.steps[job.planPosition ?? -1];
    if (plan.status !== "running" || plan.currentStep !== job.planPosition || step?.status !== "running" || step.actorId !== actor.id || step.executionId !== job.id) throw new PartnerNetworkStoreError("denied");
    const key = this.#settlementKey(job, input.completionId ?? "");
    if (input.action === "complete") {
      const seen = new Set(input.seenNoteIds ?? []);
      if ([...seen].some(id => !plan.noteMessageIds.includes(id))) throw new PartnerNetworkStoreError("invalid");
      if (plan.noteMessageIds.some(id => !seen.has(id))) {
        this.#receipt(key, input, job); return job;
      }
      const owner = room.members.find(member => member.id === actor.ownerId)!;
      const message = this.port.append(room, { authorId: actor.id, authorName: `${actor.nickname || actor.name} (${owner.nickname || owner.name})`,
        text: networkText(input.text, 24_000, true), mentions: [], threadRootId: "", quoteId: "", attachments: [...input.attachments ?? []], planId: plan.id });
      step.status = "completed"; step.resultMessageId = message.id; step.failureCode = ""; step.finishedAt = this.port.now();
      plan.status = step.position === plan.steps.length - 1 ? "completed" : "waiting";
    } else {
      step.status = "failed"; step.failureCode = failureCode; step.finishedAt = this.port.now(); plan.status = "waiting";
    }
    this.#put(plan); const ended = this.port.end(job, input.action === "complete" ? "completed" : "failed", failureCode);
    this.#receipt(key, input, ended); return ended;
  }
  #receipt(key: string, input: NetworkExecutionSettlement, job: NetworkExecution): void {
    this.port.store.setSetting("service", this.#scope(job.roomId), key, { digest: networkHash(input), job });
  }
  #settleDecision(room: NetworkRoom, actor: NetworkActor, job: NetworkExecution, input: NetworkExecutionSettlement, failureCode: string): NetworkExecution {
    const source = this.port.message(room.id, job.sourceMessageId), eligible = this.eligible(room, job.requesterId), allowed = new Set(eligible.map(actor => actor.id));
    const decision = input.decision, steps: { actorId: string; task: string }[] = [];
    if (input.action === "complete" && decision?.needsPlan) {
      if (!decision.steps.length || decision.steps.length > 6) throw new PartnerNetworkStoreError("invalid");
      for (const draft of decision.steps) {
        if (!allowed.has(draft.actorId)) throw new PartnerNetworkStoreError("denied");
        const task = [...networkText(draft.task.replace(/\s+/gu, " ").trim(), 80)].slice(0, 30).join("");
        const previous = steps.at(-1); if (previous?.actorId === draft.actorId) previous.task = [...`${previous.task}；${task}`].slice(0, 30).join(""); else steps.push({ actorId: draft.actorId, task });
      }
    }
    const needsPlan = steps.length > 0 && (job.decisionMode !== "auto" || new Set(steps.map(step => step.actorId)).size >= 2);
    let ended: NetworkExecution;
    if (needsPlan) {
      const previous = this.current(room.id); if (previous && previous.status !== "proposed") throw new PartnerNetworkStoreError("changed");
      if (previous) { previous.status = "superseded"; this.#put(previous); }
      const quote = source.quoteId ? this.port.message(room.id, source.quoteId) : undefined;
      const requestText = [previous?.requestText, source.text, quote && !quote.deleted ? `Quoted ${JSON.stringify(quote.authorName)}: ${quote.text.slice(0, 2_000)}` : ""].filter(Boolean).join("\n\n").slice(-8_000);
      const requestMessageIds = [...previous?.requestMessageIds ?? [], source.id];
      if (requestMessageIds.length > 20) throw new PartnerNetworkStoreError("invalid", "Start a new arrangement after this many revisions.");
      const now = this.port.now(), plan = this.#put({ id: randomUUID(), roomId: room.id, revision: 0, status: "proposed", sourceMessageId: source.id,
        requestText, requestMessageIds, requesterId: job.requesterId, organizerId: actor.id, steps: steps.map((step, position) => ({ ...step, position,
          status: "pending", resultMessageId: "", startedAt: 0, finishedAt: 0, failureCode: "", executionId: "" })), currentStep: 0, noteMessageIds: [], createdAt: now, updatedAt: now });
      const owner = room.members.find(member => member.id === actor.ownerId)!;
      this.port.append(room, { authorId: actor.id, authorName: `${actor.nickname || actor.name} (${owner.nickname || owner.name})`, text: "", mentions: [], threadRootId: "", quoteId: "", attachments: [], kind: "plan", planId: plan.id });
      ended = this.port.end(job, "completed");
    } else if (job.decisionMode === "auto") {
      this.port.ordinary(room, job.requesterId, source, source.id); ended = this.port.end(job, "completed");
    } else ended = this.port.end(job, "failed", failureCode || "model-unavailable");
    this.#receipt(this.#settlementKey(job, input.completionId ?? ""), input, ended); return ended;
  }
  interrupted(job: NetworkExecution, failureCode: string): void {
    if (job.kind !== "plan-step" || !job.planId) return;
    const plan = this.get(job.roomId, job.planId), step = plan.steps[job.planPosition ?? -1];
    if (plan.status === "running" && step?.status === "running") { step.status = "failed"; step.failureCode = failureCode; step.finishedAt = this.port.now(); plan.status = "waiting"; this.#put(plan); }
  }
}
