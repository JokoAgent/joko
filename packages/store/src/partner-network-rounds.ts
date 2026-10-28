import type { OperationalStore } from "./operational-store.js";
import { networkHash, type NetworkExecution, type NetworkMessage, type NetworkRoom } from "./partner-network-store.js";

export interface NetworkRound {
  readonly format: 1; readonly id: string; readonly roomId: string; readonly requesterId: string; readonly sourceMessageId: string;
  readonly responders: readonly string[]; readonly circle: number; readonly replies: number; readonly circleReplies: number;
  readonly settledIds: readonly string[]; readonly parallel: boolean; readonly welcome: boolean; readonly throughSequence: number;
  readonly state: "active" | "completed" | "stopped";
}
export interface NetworkRoundTurn { readonly actorId: string; readonly ordinal: number; readonly circle: number; readonly parallel: boolean; readonly contextThroughSequence: number; }
export type NetworkRoundExecution = NetworkExecution & { readonly circle?: number; readonly parallel?: boolean; readonly contextThroughSequence?: number };
const scope = (roomId: string) => `partner-network-rounds.v1:${roomId}`;

/** Persisted room orchestration only. The caller owns the room/queue transaction and grant checks. */
export class PartnerNetworkRounds {
  constructor(readonly store: OperationalStore) {}
  get(roomId: string, roundId: string): NetworkRound | undefined {
    const value = this.store.findSetting<NetworkRound>("service", scope(roomId), roundId)?.value;
    if (value && (value.format !== 1 || value.id !== roundId || value.roomId !== roomId || !Array.isArray(value.responders)
      || value.circle < 0 || value.circle > 2 || value.replies < 0 || value.replies > 10)) throw new Error("Rebuild incompatible development conversation rounds.");
    return value;
  }
  current(roomId: string, sourceId: string): NetworkRound | undefined {
    const head = this.store.findSetting<{ roundId: string }>("service", `partner-network-round-head.v1:${roomId}`, sourceId)?.value;
    return head ? this.get(roomId, head.roundId) : undefined;
  }
  #save(round: NetworkRound): NetworkRound { this.store.setSetting("service", scope(round.roomId), round.id, round); return round; }
  start(input: { room: NetworkRoom; requesterId: string; message: NetworkMessage; roundId: string; responders: readonly string[]; mentionAll: boolean; continued?: boolean }): readonly NetworkRoundTurn[] {
    const previous = this.get(input.room.id, input.roundId); if (previous) return [];
    const welcome = input.message.kind === "member-joined", responders = [...new Set(input.responders)];
    const specific = !input.mentionAll && input.message.mentions.length > 0;
    const round = this.#save({ format: 1, id: input.roundId, roomId: input.room.id, requesterId: input.requesterId, sourceMessageId: input.message.id,
      responders, circle: 0, replies: 0, circleReplies: 0, settledIds: [], parallel: !input.room.singleSpeaker && !input.continued && !specific && input.room.speakingMode === "auto" && responders.length >= 2,
      welcome, throughSequence: input.room.latestSequence, state: responders.length ? "active" : "completed" });
    this.store.setSetting("service", `partner-network-round-head.v1:${input.room.id}`, input.message.id, { roundId: round.id });
    return this.#turns(round, responders);
  }
  #turns(round: NetworkRound, eligible: readonly string[]): readonly NetworkRoundTurn[] {
    const original = [...round.responders.slice(round.circle), ...round.responders.slice(0, round.circle)];
    return original.filter(actorId => eligible.includes(actorId)).slice(0, 10 - round.replies).map((actorId, ordinal) => ({ actorId, ordinal, circle: round.circle,
      parallel: round.circle === 0 && round.parallel, contextThroughSequence: round.throughSequence }));
  }
  canClaim(job: NetworkRoundExecution, jobs: readonly NetworkRoundExecution[]): boolean {
    const round = this.get(job.roomId, job.roundId); if (!round) return true;
    if (round.state !== "active" || round.replies >= 10 || (job.circle ?? 0) !== round.circle) return false;
    return job.parallel === true || !jobs.some(other => other.roundId === job.roundId && (other.circle ?? 0) === round.circle && other.ordinal < job.ordinal && ["queued", "running"].includes(other.status));
  }
  contextThrough(room: NetworkRoom, job: NetworkRoundExecution): number {
    return job.parallel === true ? job.contextThroughSequence ?? room.latestSequence : room.latestSequence;
  }
  mayPublish(job: NetworkRoundExecution): boolean { const round = this.get(job.roomId, job.roundId); return !round || round.state === "active" && round.replies < 10 && (job.circle ?? 0) === round.circle; }
  settled(input: { room: NetworkRoom; job: NetworkRoundExecution; jobs: readonly NetworkRoundExecution[]; published: boolean; eligible: readonly string[] }): readonly NetworkRoundTurn[] {
    const round = this.get(input.room.id, input.job.roundId); if (!round || round.state !== "active" || round.settledIds.includes(input.job.id)) return [];
    let current = this.#save({ ...round, replies: Math.min(10, round.replies + Number(input.published)), circleReplies: round.circleReplies + Number(input.published), settledIds: [...round.settledIds, input.job.id] });
    if (current.replies >= 10) { this.#save({ ...current, state: "completed" }); return []; }
    if (input.jobs.some(job => job.roundId === current.id && (job.circle ?? 0) === current.circle && ["queued", "running"].includes(job.status))) return [];
    if (input.room.singleSpeaker || !current.circleReplies || current.welcome || current.responders.length < 2 || current.circle >= 2) { this.#save({ ...current, state: "completed" }); return []; }
    current = this.#save({ ...current, circle: current.circle + 1, circleReplies: 0, throughSequence: input.room.latestSequence });
    const dropped = new Set(input.jobs.filter(job => job.roundId === current.id && ["failed", "unknown", "cancelled"].includes(job.status)).map(job => job.actorId));
    const turns = this.#turns(current, input.eligible.filter(actorId => !dropped.has(actorId))); if (!turns.length) this.#save({ ...current, state: "completed" }); return turns;
  }
  stopRoom(roomId: string, sourceIds?: readonly string[]): void { for (const row of this.store.listSettings("service", scope(roomId))) {
    const round = row.value as NetworkRound; if (round.state === "active" && (!sourceIds || sourceIds.includes(round.sourceMessageId))) this.#save({ ...round, state: "stopped" });
  } }
  continuation(roomId: string, sourceId: string): readonly string[] | undefined {
    const rounds = this.store.listSettings("service", scope(roomId)).map(row => row.value as NetworkRound).filter(round => round.sourceMessageId === sourceId && !round.welcome);
    return (rounds.find(round => round.id === sourceId) ?? rounds[0])?.responders;
  }
  canContinue(roomId: string, sourceId: string): boolean {
    const head = this.store.findSetting<{ roundId: string }>("service", `partner-network-round-head.v1:${roomId}`, sourceId)?.value;
    const round = head && this.get(roomId, head.roundId); return !!round && !round.welcome && round.state === "completed" && round.responders.length > 0;
  }
}

export const networkRoundJobId = (roundId: string, circle: number, actorId: string): string => `round-job:${networkHash([roundId, circle, actorId])}`;
