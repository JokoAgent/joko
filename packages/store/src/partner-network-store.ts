import { randomUUID } from "node:crypto";
import type { OperationalStore } from "./operational-store.js";
import { operationBodyHash } from "./serialization.js";
import { PartnerNetworkRounds, networkRoundJobId, type NetworkRoundTurn } from "./partner-network-rounds.js";
import { PartnerNetworkPlans, type NetworkExecutionSettlement } from "./partner-network-plans.js";

export interface NetworkActor {
  id: string; kind: "human" | "partner"; name: string; ownerId: string; homeServerId: string; partnerId: string;
  role: "owner" | "admin" | "member"; state: "joined" | "left" | "removed";
  guestAccess: "none" | "chat" | "tools"; accessRevision: number; description: string; nickname: string;
  credentialDigest: string; readSequence: number; unreadSequence: number; removedFromList: boolean;
}
export interface NetworkRoom {
  format: 1; id: string; name: string; hostServerId: string; hostOrigin: string; revision: number;
  state: "active" | "archived" | "dissolved"; members: NetworkActor[]; latestSequence: number;
  replyMode: "all" | "mentioned"; speakingMode: "auto" | "sequential"; updatedAt: number; organizerId?: string;
}
export interface NetworkAttachment { id: string; name: string; mediaType: string; sizeBytes: number; }
export interface NetworkTaskCard {
  taskId: string; homeServerId: string; ownerId: string; actorId: string; title: string; status: string;
  revision: number; sessionId: string; execution: number; interactionKind: string; question: string;
}
export interface NetworkMessage {
  id: string; sequence: number; authorId: string; authorName: string; text: string; mentions: string[];
  threadRootId: string; quoteId: string; createdAt: number; deleted: boolean;
  reactions: { emoji: string; actorIds: string[] }[]; attachments: NetworkAttachment[];
  kind?: "message" | "member-joined" | "thread-share" | "task" | "plan"; eventActorId?: string; threadShareId?: string; task?: NetworkTaskCard;
  planId?: string; mentionAll?: boolean;
}
export interface NetworkLink { id: string; roomId: string; state: "active" | "revoked" | "consumed"; digest: string; expiresAt: number | null; reusable: boolean; }
export interface NetworkExecution {
  id: string; roomId: string; actorId: string; requesterId: string; sourceMessageId: string;
  accessMode: "owner" | "chat" | "tools"; accessRevision: number;
  status: "queued" | "running" | "completed" | "cancelled" | "failed" | "unknown";
  lease: number; leaseExpiresAt: number; failureCode: string; roundId: string; ordinal: number;
  circle?: number; parallel?: boolean; contextThroughSequence?: number;
  kind?: "reply" | "member-joined" | "plan-decision" | "plan-step"; planId?: string; planPosition?: number; decisionMode?: "auto" | "forced" | "revise";
}
export class PartnerNetworkStoreError extends Error {
  constructor(readonly code: "invalid" | "denied" | "not_found" | "changed" | "expired", message = "The conversation is unavailable.") { super(message); }
}
const SCOPE = "partner-network.v1";
const clone = <T>(value: T): T => structuredClone(value);
export const networkHash = (value: unknown): string => operationBodyHash(value).slice("sha256:".length);
export function networkIdentity(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(value)) throw new PartnerNetworkStoreError("invalid"); return value;
}
export function networkText(value: string, maximum: number, allowEmpty = false): string {
  if (typeof value !== "string" || value.length > maximum || !allowEmpty && !value.trim() || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) throw new PartnerNetworkStoreError("invalid");
  return value;
}
export const networkHumanId = (serverId: string): string => `person:${networkHash(networkIdentity(serverId))}`;
export const networkPartnerId = (serverId: string, partnerId: string): string => `partner:${networkHash([networkIdentity(serverId), networkIdentity(partnerId)])}`;

/** One writer owns room state, member grants, timeline, queue and immutable effect receipts. */
export class PartnerNetworkStore {
  readonly plans: PartnerNetworkPlans;
  readonly rounds: PartnerNetworkRounds;
  constructor(readonly store: OperationalStore, readonly now: () => number = Date.now) {
    this.rounds = new PartnerNetworkRounds(store);
    this.plans = new PartnerNetworkPlans({ store, now, room: id => this.get(id), save: room => { this.#save(room); },
      message: (roomId, id) => this.message(roomId, id), jobs: roomId => this.executions(roomId), append: (room, message) => this.#append(room, message),
      enqueue: job => { this.#put(job.roomId, `execution:${job.id}`, job); }, end: (job, status, code) => this.#end(job, status, code),
      cancel: roomId => this.#cancel(roomId), ordinary: (room, requesterId, message, roundId) => this.#queue(room, requesterId, message, roundId) });
  }
  #get<T>(owner: string, key: string): T | undefined { return this.store.findSetting<T>("service", `${SCOPE}:${owner}`, key)?.value; }
  #put<T>(owner: string, key: string, value: T): T { this.store.setSetting("service", `${SCOPE}:${owner}`, key, value); return clone(value); }
  #rows<T>(owner: string, prefix: string): T[] { return this.store.listSettingsByKeyPrefix("service", `${SCOPE}:${owner}`, prefix).map(row => clone(row.value as T)); }
  list(): NetworkRoom[] { return this.#rows<NetworkRoom>("host", "room:").map(room => this.#check(room)); }
  get(id: string): NetworkRoom { const room = this.#get<NetworkRoom>("host", `room:${networkIdentity(id)}`); if (!room) throw new PartnerNetworkStoreError("not_found"); return this.#check(room); }
  #check(room: NetworkRoom): NetworkRoom {
    if (room.format !== 1 || !Number.isSafeInteger(room.revision) || room.revision < 1 || !Array.isArray(room.members)
      || !["active", "archived", "dissolved"].includes(room.state) || !Number.isSafeInteger(room.latestSequence) || room.latestSequence < 0
      || !room.members.every(member => ["human", "partner"].includes(member.kind) && ["joined", "left", "removed"].includes(member.state)
        && ["owner", "admin", "member"].includes(member.role) && ["none", "chat", "tools"].includes(member.guestAccess)
        && Number.isSafeInteger(member.readSequence) && member.readSequence >= 0 && Number.isSafeInteger(member.unreadSequence) && member.unreadSequence >= 0
        && Number.isSafeInteger(member.accessRevision) && member.accessRevision >= 1 && typeof member.credentialDigest === "string")) throw new PartnerNetworkStoreError("invalid", "Rebuild incompatible development conversation data.");
    return clone(room);
  }
  #save(room: NetworkRoom): NetworkRoom { return this.#put("host", `room:${room.id}`, { ...room, revision: room.revision + 1, updatedAt: this.now() }); }
  member(room: NetworkRoom, actorId: string, joined = true): NetworkActor {
    const actor = room.members.find(item => item.id === actorId && item.kind === "human");
    if (!actor || joined && actor.state !== "joined") throw new PartnerNetworkStoreError("denied"); return actor;
  }
  authenticate(roomId: string, digest: string): NetworkActor {
    const room = this.get(roomId), member = room.members.find(actor => actor.kind === "human" && actor.credentialDigest === digest && digest.length === 64);
    if (!member) throw new PartnerNetworkStoreError("denied"); return member;
  }
  assertJoined(roomId: string, actorId: string): { room: NetworkRoom; actor: NetworkActor } { const room = this.get(roomId); return { room, actor: this.member(room, actorId) }; }
  #active(room: NetworkRoom): void { if (room.state !== "active") throw new PartnerNetworkStoreError("denied", "This conversation no longer accepts messages."); }
  #admin(actor: NetworkActor): void { if (!["owner", "admin"].includes(actor.role)) throw new PartnerNetworkStoreError("denied"); }
  operation<T>(roomId: string, actorId: string, operationId: string, input: unknown, action: () => T): T {
    const key = `receipt:${networkHash([networkIdentity(actorId), networkIdentity(operationId)])}`, bodyHash = networkHash(input);
    return this.store.transaction(() => {
      const previous = this.#get<{ bodyHash: string; value: T }>(roomId, key);
      if (previous) { if (previous.bodyHash !== bodyHash) throw new PartnerNetworkStoreError("changed", "This operation already names different input."); return clone(previous.value); }
      const value = action(); this.#put(roomId, key, { bodyHash, value }); return value;
    });
  }
  create(input: { operationId: string; serverId: string; origin: string; name: string; displayName: string; partners: readonly { id: string; name: string; description: string }[] }): NetworkRoom {
    const actorId = networkHumanId(input.serverId);
    return this.operation("host", actorId, input.operationId, input, () => {
      const room: NetworkRoom = { format: 1, id: randomUUID(), name: networkText(input.name.trim(), 120), hostServerId: networkIdentity(input.serverId),
        hostOrigin: input.origin, revision: 1, state: "active", latestSequence: 0, replyMode: "all", speakingMode: "auto", updatedAt: this.now(),
        members: [{ id: actorId, kind: "human", name: networkText(input.displayName.trim(), 128), ownerId: actorId, homeServerId: input.serverId, partnerId: "",
          role: "owner", state: "joined", guestAccess: "none", accessRevision: 1, description: "", nickname: "", credentialDigest: "", readSequence: 0, unreadSequence: 0, removedFromList: false }] };
      for (const partner of input.partners) this.#addPartner(room, actorId, partner);
      return this.#put("host", `room:${room.id}`, room);
    });
  }
  invite(input: { operationId: string; roomId: string; actorId: string; expectedRevision: number; digest: string; reusable: boolean; lifetimeMs: number }): NetworkLink {
    this.#admin(this.assertJoined(input.roomId, input.actorId).actor);
    return this.operation(input.roomId, input.actorId, input.operationId, { ...input, digest: undefined }, () => {
      const { room, actor } = this.assertJoined(input.roomId, input.actorId); this.#active(room); this.#admin(actor); this.#revision(room, input.expectedRevision);
      if (!/^[a-f0-9]{64}$/u.test(input.digest) || !Number.isSafeInteger(input.lifetimeMs) || input.lifetimeMs !== 0 && input.lifetimeMs < 60_000 || input.lifetimeMs > 30 * 86400_000 || input.lifetimeMs === 0 && !input.reusable) throw new PartnerNetworkStoreError("invalid");
      const link: NetworkLink = { id: randomUUID(), roomId: room.id, digest: input.digest, state: "active", reusable: input.reusable, expiresAt: input.lifetimeMs === 0 ? null : this.now() + input.lifetimeMs };
      this.#put("host", `link:${input.digest}`, link); return link;
    });
  }
  link(digest: string): NetworkLink {
    const link = this.#get<NetworkLink>("host", `link:${digest}`); if (!link || !/^[a-f0-9]{64}$/u.test(digest)) throw new PartnerNetworkStoreError("not_found");
    if (link.state !== "active") throw new PartnerNetworkStoreError("denied", "This invitation has been used or revoked.");
    if (link.expiresAt !== null && link.expiresAt <= this.now()) throw new PartnerNetworkStoreError("expired", "This invitation has expired.");
    this.#active(this.get(link.roomId)); return clone(link);
  }
  accept(input: { operationId: string; linkDigest: string; homeServerId: string; displayName: string; credentialDigest: string }): { room: NetworkRoom; memberId: string } {
    const actorId = networkHumanId(input.homeServerId), oldLink = this.#get<NetworkLink>("host", `link:${input.linkDigest}`);
    if (!oldLink) throw new PartnerNetworkStoreError("not_found");
    return this.operation(oldLink.roomId, actorId, input.operationId, input, () => {
      const link = this.link(input.linkDigest), room = this.get(link.roomId);
      if (input.homeServerId === room.hostServerId || !/^[a-f0-9]{64}$/u.test(input.credentialDigest)) throw new PartnerNetworkStoreError("denied");
      const previous = room.members.find(actor => actor.id === actorId);
      if (previous?.state === "joined") throw new PartnerNetworkStoreError("changed", "This person already belongs to the group.");
      const actor: NetworkActor = { id: actorId, kind: "human", ownerId: actorId, homeServerId: networkIdentity(input.homeServerId), partnerId: "", name: networkText(input.displayName.trim(), 128),
        role: "member", state: "joined", guestAccess: "none", accessRevision: (previous?.accessRevision ?? 0) + 1, description: "", nickname: "", credentialDigest: input.credentialDigest,
        readSequence: room.latestSequence, unreadSequence: room.latestSequence, removedFromList: false };
      room.members = room.members.filter(member => member.id !== actorId); room.members.push(actor); this.#capacity(room);
      if (!link.reusable) this.#put("host", `link:${link.digest}`, { ...link, state: "consumed" });
      const event = this.#append(room, { authorId: actor.id, authorName: actor.nickname || actor.name, text: "", mentions: [], threadRootId: "", quoteId: "", attachments: [], kind: "member-joined", eventActorId: actor.id });
      this.#queue(room, actor.id, event, event.id);
      return { room: this.#save(room), memberId: actorId };
    });
  }
  #capacity(room: NetworkRoom): void { if (room.members.filter(actor => actor.state === "joined").length > 100) throw new PartnerNetworkStoreError("invalid"); }
  #revision(room: NetworkRoom, revision: number): void { if (room.revision !== revision) throw new PartnerNetworkStoreError("changed", "Refresh this conversation before changing it."); }
  #addPartner(room: NetworkRoom, ownerId: string, partner: { id: string; name: string; description: string }): void {
    const owner = this.member(room, ownerId), actorId = networkPartnerId(owner.homeServerId, partner.id), previous = room.members.find(actor => actor.id === actorId);
    if (previous?.state === "joined") throw new PartnerNetworkStoreError("changed");
    room.members = room.members.filter(actor => actor.id !== actorId);
    room.members.push({ id: actorId, kind: "partner", name: networkText(partner.name, 128), description: networkText(partner.description, 8000, true), ownerId,
      homeServerId: owner.homeServerId, partnerId: networkIdentity(partner.id), role: "member", state: "joined", guestAccess: "chat", accessRevision: (previous?.accessRevision ?? 0) + 1,
      nickname: "", credentialDigest: "", readSequence: 0, unreadSequence: 0, removedFromList: false }); this.#capacity(room);
  }
  manage(input: { operationId: string; roomId: string; actorId: string; expectedRevision: number; action: string; targetId: string; value: string; throughSequence: number;
    partner?: { id: string; name: string; description: string } }): NetworkRoom {
    this.member(this.get(input.roomId), input.actorId, !["remove-list", "restore-list"].includes(input.action));
    return this.operation(input.roomId, input.actorId, input.operationId, input, () => {
      const room = this.get(input.roomId), actor = this.member(room, input.actorId, !["remove-list", "restore-list"].includes(input.action));
      const target = room.members.find(member => member.id === input.targetId);
      if (["remove-list", "restore-list"].includes(input.action)) { actor.removedFromList = input.action === "remove-list"; return this.#save(room); }
      if (input.action === "mark-read") { if (!Number.isSafeInteger(input.throughSequence) || input.throughSequence < 0 || input.throughSequence > room.latestSequence) throw new PartnerNetworkStoreError("invalid");
        actor.readSequence = Math.max(actor.readSequence, input.throughSequence); return this.#save(room); }
      this.#revision(room, input.expectedRevision);
      if (["rename", "archive", "restore", "dissolve", "remove-member", "set-role", "revoke-link", "reply-mode", "speaking-mode", "organizer"].includes(input.action)) this.#admin(actor);
      if (room.state === "dissolved" && input.action !== "leave") throw new PartnerNetworkStoreError("denied");
      switch (input.action) {
        case "rename": room.name = networkText(input.value.trim(), 120); break;
        case "archive": room.state = "archived"; this.plans.stop(room.id); this.#cancel(room.id); break;
        case "restore": room.state = "active"; break;
        case "dissolve": if (actor.role !== "owner") throw new PartnerNetworkStoreError("denied"); room.state = "dissolved"; this.plans.stop(room.id); this.#cancel(room.id); break;
        case "leave": this.#remove(room, actor); break;
        case "remove-member": if (!target || target.kind !== "human" || target.role === "owner" || actor.role === "admin" && target.role === "admin") throw new PartnerNetworkStoreError("denied"); this.#remove(room, target); target.state = "removed"; break;
        case "set-role": if (actor.role !== "owner" || !target || target.kind !== "human" || target.state !== "joined" || !["owner", "admin", "member"].includes(input.value)) throw new PartnerNetworkStoreError("denied");
          if (target.id === actor.id && input.value !== "owner" && room.members.filter(member => member.role === "owner" && member.state === "joined").length < 2) throw new PartnerNetworkStoreError("denied", "Transfer ownership or dissolve the group before leaving.");
          target.role = input.value as NetworkActor["role"]; if (input.value === "owner" && target.id !== actor.id) actor.role = "member"; break;
        case "nickname": if (!target || target.id !== actor.id && target.ownerId !== actor.id) throw new PartnerNetworkStoreError("denied"); target.nickname = networkText(input.value.trim(), 128, true); break;
        case "add-partner": this.#active(room); if (!input.partner) throw new PartnerNetworkStoreError("invalid"); this.#addPartner(room, actor.id, input.partner); break;
        case "remove-partner": if (!target || target.kind !== "partner" || target.ownerId !== actor.id) throw new PartnerNetworkStoreError("denied"); target.state = "left"; target.accessRevision++; this.#cancel(room.id, target.id); break;
        case "set-access": if (!target || target.kind !== "partner" || target.ownerId !== actor.id || target.state !== "joined" || !["none", "chat", "tools"].includes(input.value)) throw new PartnerNetworkStoreError("denied");
          target.guestAccess = input.value as NetworkActor["guestAccess"]; target.accessRevision++; this.#cancel(room.id, target.id); break;
        case "revoke-link": { const link = this.#rows<NetworkLink>("host", "link:").find(item => item.roomId === room.id && item.id === input.value);
          if (!link) throw new PartnerNetworkStoreError("not_found"); this.#put("host", `link:${link.digest}`, { ...link, state: "revoked" }); break; }
        case "reply-mode": if (!["all", "mentioned"].includes(input.value)) throw new PartnerNetworkStoreError("invalid"); room.replyMode = input.value as NetworkRoom["replyMode"]; break;
        case "speaking-mode": if (!["auto", "sequential"].includes(input.value)) throw new PartnerNetworkStoreError("invalid"); room.speakingMode = input.value as NetworkRoom["speakingMode"]; break;
        case "organizer": if (input.value && !room.members.some(member => member.id === input.value && member.kind === "partner" && member.state === "joined")) throw new PartnerNetworkStoreError("denied"); room.organizerId = input.value; break;
        case "stop": this.plans.stop(room.id); this.#cancel(room.id); break;
        case "continue": { this.#active(room); const source = this.messages(room.id).findLast(message => room.members.some(member => member.id === message.authorId && member.kind === "human") && !message.deleted
          && (!message.kind || message.kind === "message") && message.threadRootId === input.value);
          if (!source || !this.canContinue(room.id, input.value)) throw new PartnerNetworkStoreError("not_found"); this.#cancel(room.id); this.#queue(room, actor.id, source, randomUUID()); break; }
        default: throw new PartnerNetworkStoreError("invalid");
      }
      return this.#save(room);
    });
  }
  #remove(room: NetworkRoom, actor: NetworkActor): void {
    if (actor.role === "owner" && room.members.filter(member => member.kind === "human" && member.role === "owner" && member.state === "joined").length < 2 && room.state !== "dissolved") throw new PartnerNetworkStoreError("denied", "Transfer ownership or dissolve the group before leaving.");
    actor.state = "left"; actor.accessRevision++;
    for (const member of room.members) if (member.ownerId === actor.id && member.kind === "partner") { member.state = "left"; member.guestAccess = "none"; member.accessRevision++; }
    for (const job of this.executions(room.id)) if (job.requesterId === actor.id || room.members.some(member => member.id === job.actorId && member.ownerId === actor.id)) this.#end(job, "cancelled");
  }
  messages(roomId: string): NetworkMessage[] { this.get(roomId); return this.#rows<NetworkMessage>(roomId, "message:").sort((a, b) => a.sequence - b.sequence); }
  message(roomId: string, messageId: string): NetworkMessage { const value = this.#get<NetworkMessage>(roomId, `message:${networkIdentity(messageId)}`); if (!value) throw new PartnerNetworkStoreError("not_found"); return clone(value); }
  #append(room: NetworkRoom, message: Omit<NetworkMessage, "id" | "sequence" | "createdAt" | "reactions" | "deleted">): NetworkMessage {
    const value: NetworkMessage = { ...message, id: randomUUID(), sequence: ++room.latestSequence, createdAt: this.now(), deleted: false, reactions: [] };
    for (const actor of room.members) if (actor.kind === "human" && actor.state === "joined" && actor.id !== value.authorId) actor.unreadSequence = value.sequence;
    this.#put(room.id, `message:${value.id}`, value); return value;
  }
  send(input: { operationId: string; roomId: string; actorId: string; text: string; mentions: readonly string[]; mentionAll: boolean; threadRootId: string; quoteId: string; attachments: readonly NetworkAttachment[]; forcePlan?: boolean }): NetworkMessage {
    this.assertJoined(input.roomId, input.actorId);
    return this.operation(input.roomId, input.actorId, input.operationId, input, () => {
      const { room, actor } = this.assertJoined(input.roomId, input.actorId); this.#active(room);
      const text = networkText(input.text, 8_000, true); if (!text.trim() && !input.attachments.length || input.attachments.length > 20) throw new PartnerNetworkStoreError("invalid");
      if (input.mentions.length > 100 || input.mentions.some(id => !room.members.some(member => member.id === id && member.state === "joined"))) throw new PartnerNetworkStoreError("changed", "A mentioned member has left. Edit the message before sending.");
      const mentions = [...new Set([...input.mentions, ...input.mentionAll ? room.members.filter(member => member.state === "joined").map(member => member.id) : []])].filter(id => id !== actor.id);
      if (input.threadRootId) { const root = this.message(room.id, input.threadRootId); if (root.deleted || root.threadRootId) throw new PartnerNetworkStoreError("invalid"); }
      if (input.quoteId) { const quote = this.message(room.id, input.quoteId); if (quote.deleted || quote.threadRootId) throw new PartnerNetworkStoreError("changed", "The quoted message is unavailable."); }
      for (const attachment of input.attachments) {
        const saved = this.#get<{ actorId: string; attachment: NetworkAttachment; complete: boolean }>(room.id, `media:${networkIdentity(attachment.id)}`);
        if (!saved?.complete || saved.actorId !== actor.id || networkHash(saved.attachment) !== networkHash(attachment)) throw new PartnerNetworkStoreError("denied");
      }
      const message = this.#append(room, { authorId: actor.id, authorName: actor.nickname || actor.name, text, mentions, mentionAll: input.mentionAll,
        threadRootId: input.threadRootId, quoteId: input.quoteId, attachments: [...input.attachments] });
      const specific = input.mentions.some(id => room.members.some(member => member.id === id && member.kind === "partner"));
      if (!this.plans.onSend(room, actor.id, message, input.forcePlan === true, specific)) {
        this.#cancel(room.id, undefined, false); this.#queue(room, actor.id, message, message.id);
      }
      this.#save(room); return message;
    });
  }
  #queue(room: NetworkRoom, requesterId: string, message: NetworkMessage, roundId: string): void {
    if (message.kind === "thread-share" || message.kind === "task") return;
    const original = roundId === message.id ? undefined : this.rounds.continuation(room.id, message.id);
    const responders = room.members.filter(actor => actor.kind === "partner" && actor.state === "joined" && (actor.ownerId === requesterId || actor.guestAccess !== "none")
      && (original ? original.includes(actor.id) : message.kind === "member-joined" || (message.mentions.length ? message.mentions.includes(actor.id) : room.replyMode === "all")));
    const ordered = message.mentions.length ? [...responders].sort((a, b) => message.mentions.indexOf(a.id) - message.mentions.indexOf(b.id)) : responders;
    const turns = this.rounds.start({ room, requesterId, message, roundId, responders: original ? original.filter(id => responders.some(actor => actor.id === id)) : ordered.map(actor => actor.id), mentionAll: message.mentionAll === true, continued: roundId !== message.id });
    this.#queueTurns(room, requesterId, message, roundId, turns.filter(turn => responders.some(actor => actor.id === turn.actorId)));
  }
  #queueTurns(room: NetworkRoom, requesterId: string, message: NetworkMessage, roundId: string, turns: readonly NetworkRoundTurn[]): void {
    for (const turn of turns) {
      const actor = room.members.find(member => member.id === turn.actorId && member.kind === "partner" && member.state === "joined" && (member.ownerId === requesterId || member.guestAccess !== "none")); if (!actor) continue;
      const job: NetworkExecution = { id: networkRoundJobId(roundId, turn.circle, actor.id), roomId: room.id, requesterId, sourceMessageId: message.id,
        accessMode: actor.ownerId === requesterId ? "owner" : actor.guestAccess as "chat" | "tools", accessRevision: actor.accessRevision,
        status: "queued", lease: 0, leaseExpiresAt: 0, failureCode: "", roundId, ...turn, kind: message.kind === "member-joined" ? "member-joined" : "reply" };
      this.#put(room.id, `execution:${job.id}`, job);
    }
  }
  /** Service-owned task publications never wake a group lane or replay a native effect. */
  appendActorMessage(input: { roomId: string; ownerId: string; actorId: string; operationId: string; text: string; attachments?: readonly NetworkAttachment[]; task?: NetworkTaskCard }): NetworkMessage {
    this.assertJoined(input.roomId, input.ownerId);
    return this.operation(input.roomId, input.ownerId, input.operationId, input, () => {
      const { room } = this.assertJoined(input.roomId, input.ownerId); this.#active(room);
      const actor = room.members.find(member => member.id === input.actorId && member.kind === "partner" && member.state === "joined" && member.ownerId === input.ownerId);
      if (!actor) throw new PartnerNetworkStoreError("denied");
      const text = networkText(input.text, 24_000, true), attachments = input.attachments ?? [];
      if (!text.trim() && !attachments.length && !input.task || attachments.length > 20) throw new PartnerNetworkStoreError("invalid");
      for (const attachment of attachments) { const saved = this.media(room.id, attachment.id);
        if (!saved.complete || saved.actorId !== input.ownerId || networkHash(saved.attachment) !== networkHash(attachment)) throw new PartnerNetworkStoreError("denied"); }
      if (input.task) { const card = input.task;
        [card.taskId, card.actorId, card.homeServerId, card.ownerId].forEach(networkIdentity); if (card.sessionId) networkIdentity(card.sessionId);
        if (card.actorId !== actor.id || card.ownerId !== actor.ownerId || card.homeServerId !== actor.homeServerId || !Number.isSafeInteger(card.revision) || card.revision < 1
          || !Number.isSafeInteger(card.execution) || card.execution < 1 || !["preparing", "queued", "running", "waiting", "completed", "failed", "cancelled", "timed-out", "unknown"].includes(card.status)
          || !["", "permission", "question", "plan_review"].includes(card.interactionKind)) throw new PartnerNetworkStoreError("invalid");
        networkText(card.title, 120); networkText(card.question, 16_000, true);
      }
      const owner = this.member(room, actor.ownerId), message = this.#append(room, { authorId: actor.id, authorName: `${actor.nickname || actor.name} (${owner.nickname || owner.name})`, text,
        mentions: [], threadRootId: "", quoteId: "", attachments: [...attachments], kind: input.task ? "task" : "message", ...(input.task ? { task: clone(input.task) } : {}) });
      this.#save(room); return message;
    });
  }
  shareThread(input: { roomId: string; ownerId: string; operationId: string; sourceId: string }): NetworkRoom {
    this.assertJoined(input.roomId, input.ownerId);
    return this.operation(input.roomId, input.ownerId, input.operationId, input, () => {
      const { room, actor } = this.assertJoined(input.roomId, input.ownerId); this.#active(room); const reply = this.message(room.id, input.sourceId);
      if (reply.deleted || !reply.threadRootId || this.message(room.id, reply.threadRootId).deleted) throw new PartnerNetworkStoreError("denied");
      this.#append(room, { authorId: actor.id, authorName: actor.nickname || actor.name, text: `↪ ${reply.authorName}: ${reply.text.slice(0, 240)}`,
        mentions: [], threadRootId: "", quoteId: "", attachments: [], kind: "thread-share", threadShareId: reply.id });
      return this.#save(room);
    });
  }
  react(input: { operationId: string; roomId: string; actorId: string; messageId: string; emoji: string; add: boolean }): NetworkMessage {
    this.assertJoined(input.roomId, input.actorId);
    return this.operation(input.roomId, input.actorId, input.operationId, input, () => {
      const { room, actor } = this.assertJoined(input.roomId, input.actorId); this.#active(room); const message = this.message(room.id, input.messageId);
      if (message.deleted) throw new PartnerNetworkStoreError("not_found"); const emoji = networkText(input.emoji, 32); let reaction = message.reactions.find(row => row.emoji === emoji);
      if (!reaction) { reaction = { emoji, actorIds: [] }; message.reactions.push(reaction); }
      reaction.actorIds = reaction.actorIds.filter(id => id !== actor.id); if (input.add) reaction.actorIds.push(actor.id);
      message.reactions = message.reactions.filter(row => row.actorIds.length); this.#put(room.id, `message:${message.id}`, message); this.#save(room); return message;
    });
  }
  executions(roomId: string): NetworkExecution[] { return this.#rows<NetworkExecution>(roomId, "execution:"); }
  canContinue(roomId: string, threadRootId = ""): boolean {
    const room = this.get(roomId); if (room.state !== "active" || this.executions(roomId).some(job => ["queued", "running"].includes(job.status))) return false;
    const source = this.messages(roomId).findLast(message => !message.deleted && (!message.kind || message.kind === "message") && message.threadRootId === threadRootId && room.members.some(actor => actor.kind === "human" && actor.id === message.authorId));
    return !!source && this.rounds.canContinue(roomId, source.id);
  }
  #end(job: NetworkExecution, status: NetworkExecution["status"], failureCode = ""): NetworkExecution {
    if (!["queued", "running"].includes(job.status)) return job;
    const ended = this.#put(job.roomId, `execution:${job.id}`, { ...job, status, leaseExpiresAt: 0, failureCode });
    if (["unknown", "failed", "cancelled"].includes(status)) this.plans.interrupted(job, failureCode || "outcome-unknown");
    return ended;
  }
  #cancel(roomId: string, actorId?: string, includePlans = true): void { if (!actorId) this.rounds.stopRoom(roomId); for (const job of this.executions(roomId)) if ((!actorId || job.actorId === actorId)
    && (includePlans || job.kind !== "plan-step")) this.#end(job, "cancelled"); }
  validateExecution(roomId: string, executionId: string, lease: number, ownerId: string): { room: NetworkRoom; actor: NetworkActor; job: NetworkExecution } {
    const { room } = this.assertJoined(roomId, ownerId); this.#active(room); const job = this.#get<NetworkExecution>(room.id, `execution:${networkIdentity(executionId)}`);
    const actor = job && room.members.find(member => member.id === job.actorId && member.kind === "partner" && member.ownerId === ownerId && member.state === "joined");
    if (!job || !actor || job.status !== "running" || job.lease !== lease || job.leaseExpiresAt <= this.now() || job.accessRevision !== actor.accessRevision
      || !room.members.some(member => member.id === job.requesterId && member.state === "joined") || job.accessMode === "owner" && job.requesterId !== actor.ownerId
      || job.accessMode !== "owner" && actor.guestAccess !== job.accessMode) throw new PartnerNetworkStoreError("denied", "This execution lease or companion authorization has ended.");
    return { room, actor, job: clone(job) };
  }
  claim(roomId: string, ownerId: string, actorId: string): NetworkExecution | undefined {
    return this.store.transaction(() => {
      const { room } = this.assertJoined(roomId, ownerId); if (room.state !== "active") return undefined;
      const actor = room.members.find(member => member.id === actorId && member.ownerId === ownerId && member.kind === "partner" && member.state === "joined"); if (!actor) throw new PartnerNetworkStoreError("denied");
      let jobs = this.executions(room.id); for (const job of jobs) if (job.status === "running" && job.leaseExpiresAt <= this.now()) this.#end(job, "unknown", "lease-expired");
      jobs = this.executions(room.id);
      for (const ended of jobs.filter(job => ["completed", "failed", "cancelled", "unknown"].includes(job.status) && !["plan-decision", "plan-step"].includes(job.kind ?? ""))) this.#settleRound(room, ended, false);
      jobs = this.executions(room.id);
      if (jobs.some(job => job.actorId === actorId && job.status === "running" && job.leaseExpiresAt > this.now())) return undefined;
      const job = jobs.find(item => item.actorId === actorId && item.status === "queued" && item.accessRevision === actor.accessRevision
        && this.rounds.canClaim(item, jobs));
      if (!job) return undefined;
      const next = { ...job, status: "running" as const, lease: job.lease + 1, leaseExpiresAt: this.now() + 30_000,
        ...(["plan-decision", "plan-step"].includes(job.kind ?? "") ? {} : { contextThroughSequence: this.rounds.contextThrough(room, job) }) };
      this.#put(room.id, `execution:${job.id}`, next); this.#save(room); return next;
    });
  }
  settle(input: NetworkExecutionSettlement): NetworkExecution {
    this.assertJoined(input.roomId, input.ownerId);
    return this.store.transaction(() => {
      const old = this.#get<NetworkExecution>(input.roomId, `execution:${networkIdentity(input.executionId)}`);
      if (old && ["plan-decision", "plan-step"].includes(old.kind ?? "") && input.action !== "renew") {
        const receipt = this.plans.receipt(input); if (receipt) return receipt;
      }
      if (old?.lease === input.lease && ["completed", "failed"].includes(old.status)) {
        const receipt = this.#get<{ inputHash: string }>(input.roomId, `settlement:${old.id}:${old.lease}`);
        if (receipt?.inputHash !== networkHash(input)) throw new PartnerNetworkStoreError("changed"); return old;
      }
      const { room, actor, job } = this.validateExecution(input.roomId, input.executionId, input.lease, input.ownerId);
      if (input.action === "renew") return this.#put(room.id, `execution:${job.id}`, { ...job, leaseExpiresAt: this.now() + 30_000 });
      if (!["complete", "fail"].includes(input.action)) throw new PartnerNetworkStoreError("invalid");
      const text = networkText(input.text, 24_000, true);
      for (const attachment of input.attachments ?? []) { const saved = this.media(room.id, attachment.id);
        if (!saved.complete || saved.actorId !== input.ownerId || networkHash(saved.attachment) !== networkHash(attachment)) throw new PartnerNetworkStoreError("denied"); }
      if ((input.attachments?.length ?? 0) > 20) throw new PartnerNetworkStoreError("invalid");
      const failureCode = input.action === "fail" && ["model-unavailable", "runtime-unavailable", "failed", "timeout", "outcome-unknown", "input-unavailable", "workdir-unavailable",
        "IMAGE_INPUT_UNSUPPORTED", "MODEL_UNAVAILABLE", "AUTH_REQUIRED", "RATE_LIMITED", "UPSTREAM_OVERLOADED", "QUOTA_EXCEEDED", "NETWORK_ERROR", "RUNTIME_TIMEOUT", "RUNTIME_ERROR"].includes(input.failureCode) ? input.failureCode : input.action === "fail" ? "failed" : "";
      if (["plan-decision", "plan-step"].includes(job.kind ?? "")) {
        const ended = this.plans.settle(room, actor, job, input, failureCode); this.#save(room); return ended;
      }
      const published = input.action === "complete" && !!text.trim() && text.trim() !== "NO_REPLY" && this.rounds.mayPublish(job);
      if (published) {
        const source = this.message(room.id, job.sourceMessageId), owner = this.member(room, actor.ownerId);
        this.#append(room, { authorId: actor.id, authorName: `${actor.nickname || actor.name} (${owner.nickname || owner.name})`, text, mentions: [], threadRootId: source.threadRootId,
          quoteId: "", attachments: [] });
      }
      this.#put(room.id, `settlement:${job.id}:${job.lease}`, { inputHash: networkHash(input) }); this.#save(room);
      const ended = this.#end(job, input.action === "complete" ? "completed" : "failed", failureCode); this.#settleRound(room, ended, published); return ended;
    });
  }
  #settleRound(room: NetworkRoom, job: NetworkExecution, published: boolean): void {
    const eligible = room.members.filter(actor => actor.kind === "partner" && actor.state === "joined" && (actor.ownerId === job.requesterId || actor.guestAccess !== "none")).map(actor => actor.id);
    const turns = this.rounds.settled({ room, job, jobs: this.executions(room.id), published, eligible });
    if (turns.length) this.#queueTurns(room, job.requesterId, this.message(room.id, job.sourceMessageId), job.roundId, turns);
  }
  recover(): void { this.store.transaction(() => { for (const room of this.list()) { this.rounds.stopRoom(room.id); for (const job of this.executions(room.id)) {
    if (job.status === "running") this.#end(job, "unknown", "outcome-unknown");
    else if (job.status === "queued" && job.kind === "plan-step") this.#end(job, "unknown", "outcome-unknown");
    else if (job.status === "queued") this.#end(job, "cancelled");
  } } }); }
  media(roomId: string, mediaId: string): { actorId: string; attachment: NetworkAttachment; complete: boolean; offset: number } {
    const value = this.#get<{ actorId: string; attachment: NetworkAttachment; complete: boolean; offset: number }>(roomId, `media:${networkIdentity(mediaId)}`);
    if (!value) throw new PartnerNetworkStoreError("not_found"); return clone(value);
  }
  saveMedia(roomId: string, input: ReturnType<PartnerNetworkStore["media"]>): void { this.#put(roomId, `media:${input.attachment.id}`, input); }
}
