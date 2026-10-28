import { randomBytes } from "node:crypto";
import { lstat, mkdir, open } from "node:fs/promises";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import * as contract from "@joko/contracts";
import { PartnerNetworkStore, PartnerNetworkStoreError, networkHash, networkHumanId, networkIdentity, networkText,
  type NetworkRoom, type NetworkActor, type NetworkMessage, type NetworkExecution, type NetworkLink, type NetworkAttachment, type NetworkTaskCard, type NetworkPlan } from "@joko/store";
import type { ArtifactStore } from "./artifact-store.js";
import { readCurrentPartnerNetworkFailures } from "./partner-network-failure-reader.js";

export interface PartnerNetworkAuthority { readonly signal: AbortSignal; readonly deviceId: string; assertCurrent(): void; }
export const networkInteger = (value: bigint): number => { const result = Number(value); if (!Number.isSafeInteger(result) || result < 0) throw new PartnerNetworkStoreError("invalid"); return result; };
export const networkDigest = (secret: string): string => networkHash(secret);

export function networkRoom(room: NetworkRoom, selfId: string, joinId = ""): contract.PartnerNetworkRoom {
  const self = room.members.find(member => member.id === selfId);
  return create(contract.PartnerNetworkRoomSchema, { id: room.id, name: room.name, hostServerId: room.hostServerId, hostOrigin: room.hostOrigin,
    revision: BigInt(room.revision), state: room.state, members: room.members.map(networkActor), latestSequence: BigInt(room.latestSequence),
    readSequence: BigInt(self?.readSequence ?? 0), selfId, joinId, replyMode: room.replyMode, speakingMode: room.speakingMode,
    removedFromList: self?.removedFromList ?? false, availability: self?.state === "joined" ? "available" : "denied", updatedAtMs: BigInt(room.updatedAt), unread: self !== undefined && self.unreadSequence > self.readSequence,
    organizerId: room.organizerId ?? "", singleSpeaker: room.singleSpeaker === true });
}
function networkActor(actor: NetworkActor): contract.PartnerNetworkActor {
  return create(contract.PartnerNetworkActorSchema, { id: actor.id, kind: actor.kind, name: actor.name, ownerId: actor.ownerId,
    homeServerId: actor.homeServerId, partnerId: actor.partnerId, role: actor.role, state: actor.state, guestAccess: actor.guestAccess,
    accessRevision: BigInt(actor.accessRevision), description: actor.description, nickname: actor.nickname });
}
export function networkMessage(message: NetworkMessage, readerId?: string): contract.PartnerNetworkMessage {
  return create(contract.PartnerNetworkMessageSchema, { ...message, sequence: BigInt(message.sequence), createdAtMs: BigInt(message.createdAt),
    attachments: message.attachments.map(networkAttachment), ...(message.task ? { task: networkTaskCard({ ...message.task, sessionId: message.task.ownerId === readerId ? message.task.sessionId : "" }) } : { task: undefined }) });
}
function networkTaskCard(card: NetworkTaskCard): contract.PartnerNetworkTaskCard { return create(contract.PartnerNetworkTaskCardSchema, { ...card, revision: BigInt(card.revision), execution: BigInt(card.execution) }); }
export function networkAttachment(attachment: NetworkAttachment): contract.PartnerNetworkAttachment { return create(contract.PartnerNetworkAttachmentSchema, { ...attachment, sizeBytes: BigInt(attachment.sizeBytes) }); }
export function networkExecution(job: NetworkExecution): contract.PartnerNetworkExecution { return create(contract.PartnerNetworkExecutionSchema, { ...job,
  accessRevision: BigInt(job.accessRevision), lease: BigInt(job.lease), leaseExpiresAtMs: BigInt(job.leaseExpiresAt) }); }
export function networkPlan(plan: NetworkPlan): contract.PartnerNetworkPlan { return create(contract.PartnerNetworkPlanSchema, { ...plan,
  revision: BigInt(plan.revision), createdAtMs: BigInt(plan.createdAt), updatedAtMs: BigInt(plan.updatedAt),
  steps: plan.steps.map(step => ({ ...step, startedAtMs: BigInt(step.startedAt), finishedAtMs: BigInt(step.finishedAt) })) }); }
function networkLink(link: NetworkLink): contract.PartnerNetworkLink { return create(contract.PartnerNetworkLinkSchema, { ...link, expiresAtMs: BigInt(link.expiresAt ?? 0) }); }

export function buildPartnerNetworkInvitation(input: { origin: string; serverId: string; secret: string; endpointPublicKey: string }): string {
  const origin = contract.taskShareOrigin(input.origin); networkIdentity(input.serverId);
  if (!/^[A-Za-z0-9_-]{43}$/u.test(input.secret)) throw new PartnerNetworkStoreError("invalid");
  return `joko://conversation/join#${Buffer.from(JSON.stringify([origin, input.serverId, input.secret, contract.taskShareEndpointPublicKey(input.endpointPublicKey)])).toString("base64url")}`;
}
export function parsePartnerNetworkInvitation(input: string): { origin: string; serverId: string; secret: string; endpointPublicKey: string } {
  try {
    if (input.length > 2048 || !/^joko:\/\/conversation\/join#[A-Za-z0-9_-]+$/u.test(input)) throw new Error();
    const parsed = JSON.parse(Buffer.from(input.slice(input.indexOf("#") + 1), "base64url").toString("utf8")) as unknown;
    if (!Array.isArray(parsed) || parsed.length !== 4 || !parsed.every(value => typeof value === "string") || !/^[A-Za-z0-9_-]{43}$/u.test(parsed[2]!)) throw new Error();
    return { origin: contract.taskShareOrigin(parsed[0]!), serverId: networkIdentity(parsed[1]!), secret: parsed[2]!, endpointPublicKey: contract.taskShareEndpointPublicKey(parsed[3]!) };
  } catch { throw new ConnectError("The invitation is incomplete or invalid.", Code.InvalidArgument); }
}

/** Every foreign call is scoped to one current room membership, never a Connection. */
export class PartnerNetworkHost {
  readonly #invites = new Map<string, { fingerprint: string; value: contract.InvitePartnerNetworkResponse }>();
  readonly #mediaFlights = new Map<string, Promise<unknown>>();
  constructor(readonly options: { storage: PartnerNetworkStore; serverId: string; origin: string | (() => string); endpointPublicKey: string; mediaDirectory: string;
    partner: (id: string) => { id: string; name: string; description: string }; artifacts?: ArtifactStore }) {}
  #origin(): string { return contract.taskShareOrigin(typeof this.options.origin === "string" ? this.options.origin : this.options.origin()); }
  #room(room: NetworkRoom, selfId: string, joinId = ""): contract.PartnerNetworkRoom {
    const result = networkRoom({ ...room, hostOrigin: this.#origin() }, selfId, joinId);
    if (room.members.some(actor => actor.id === selfId && actor.state === "joined")) result.unread = this.storage.hasUnread(room.id, selfId);
    return result;
  }
  get storage(): PartnerNetworkStore { return this.options.storage; }
  get selfId(): string { return networkHumanId(this.options.serverId); }
  actor(roomId: string, authorization?: string): string {
    if (!authorization) throw new ConnectError("A conversation membership is required.", Code.Unauthenticated);
    const match = /^Bearer joko-conversation-([A-Za-z0-9_-]{43})$/u.exec(authorization);
    if (!match) throw new ConnectError("A conversation membership is required.", Code.Unauthenticated);
    return this.storage.authenticate(roomId, networkDigest(match[1]!)).id;
  }
  assertActor(roomId: string, actorId: string): void { this.storage.assertJoined(roomId, actorId); }
  list(): contract.PartnerNetworkRoom[] { return this.storage.list().map(room => this.#room(room, this.selfId)); }
  create(request: contract.CreatePartnerNetworkRequest): contract.PartnerNetworkRoom {
    if (request.partnerIds.length > 6 || new Set(request.partnerIds).size !== request.partnerIds.length) throw new PartnerNetworkStoreError("invalid");
    return this.#room(this.storage.create({ operationId: request.operationId, name: request.name, displayName: request.displayName,
      serverId: this.options.serverId, origin: this.#origin(), partners: request.partnerIds.map(id => this.options.partner(id)) }), this.selfId);
  }
  invite(request: contract.InvitePartnerNetworkRequest, actorId: string): contract.InvitePartnerNetworkResponse {
    const authority = this.storage.assertJoined(request.roomId, actorId).actor;
    if (!["owner", "admin"].includes(authority.role)) throw new PartnerNetworkStoreError("denied");
    const key = networkHash([request.roomId, actorId, request.operationId]), fingerprint = networkHash([request.roomId, actorId, request.expectedRevision.toString(), request.reusable, request.lifetimeMs.toString()]);
    const old = this.#invites.get(key); if (old) { if (old.fingerprint !== fingerprint) throw new PartnerNetworkStoreError("changed"); return old.value; }
    const secret = randomBytes(32).toString("base64url"), link = this.storage.invite({ operationId: request.operationId, roomId: request.roomId, actorId,
      expectedRevision: networkInteger(request.expectedRevision), digest: networkDigest(secret), reusable: request.reusable, lifetimeMs: networkInteger(request.lifetimeMs) || (request.reusable ? 0 : 86400_000) });
    if (link.digest !== networkDigest(secret)) throw new ConnectError("The original invitation reply is no longer available. Create a new invitation explicitly.", Code.FailedPrecondition);
    const value = create(contract.InvitePartnerNetworkResponseSchema, { link: networkLink(link), invitation: buildPartnerNetworkInvitation({ origin: this.#origin(), serverId: this.options.serverId, secret, endpointPublicKey: this.options.endpointPublicKey }) });
    this.#invites.set(key, { fingerprint, value }); setTimeout(() => this.#invites.delete(key), 60_000).unref(); return value;
  }
  inspect(invitation: string): contract.PreviewPartnerNetworkResponse {
    const parsed = parsePartnerNetworkInvitation(invitation);
    if (parsed.serverId !== this.options.serverId || parsed.endpointPublicKey !== this.options.endpointPublicKey) throw new PartnerNetworkStoreError("denied");
    const link = this.storage.link(networkDigest(parsed.secret)), room = this.storage.get(link.roomId);
    // Preview reveals the group name and inviter only; no history or other members.
    const preview = this.#room({ ...room, members: room.members.filter(member => member.kind === "human" && member.role === "owner") }, "");
    return create(contract.PreviewPartnerNetworkResponseSchema, { room: preview, link: networkLink(link) });
  }
  accept(request: contract.AcceptPartnerNetworkRequest): contract.AcceptPartnerNetworkResponse {
    const parsed = parsePartnerNetworkInvitation(request.invitation);
    if (parsed.serverId !== this.options.serverId || parsed.endpointPublicKey !== this.options.endpointPublicKey) throw new PartnerNetworkStoreError("denied");
    const result = this.storage.accept({ operationId: request.operationId, linkDigest: networkDigest(parsed.secret), homeServerId: request.homeServerId,
      displayName: request.displayName, credentialDigest: request.credentialSha256 });
    return create(contract.AcceptPartnerNetworkResponseSchema, { room: this.#room(result.room, result.memberId), memberId: result.memberId });
  }
  snapshot(request: contract.GetPartnerNetworkRequest, actorId: string): contract.PartnerNetworkSnapshot {
    const { room } = this.storage.assertJoined(request.roomId, actorId), before = networkInteger(request.beforeSequence);
    let messages = this.storage.messages(room.id).filter(message => !before || message.sequence < before);
    if (request.threadRootId) {
      const root = this.storage.message(room.id, request.threadRootId); if (root.deleted || root.threadRootId) throw new PartnerNetworkStoreError("not_found");
      messages = messages.filter(message => message.id === root.id || message.threadRootId === root.id);
    } else messages = messages.filter(message => !message.threadRootId);
    const reader = this.storage.reader(room.id, actorId, request.threadRootId);
    const page = messages.slice(-100);
    if (request.threadRootId && !page.some(message => message.id === request.threadRootId)) page.unshift(this.storage.message(room.id, request.threadRootId));
    return create(contract.PartnerNetworkSnapshotSchema, { room: this.#room(room, actorId), messages: this.#projectMessages(room.id, page, actorId), hasMore: messages.filter(message => !request.threadRootId || message.id !== request.threadRootId).length > 100, canContinue: this.storage.canContinue(room.id, request.threadRootId),
      readerStateSupported: true, threadReadSequence: BigInt(reader.readSequence), threadFollowing: reader.following, threads: this.#threads(room.id, actorId),
      executions: this.storage.executions(room.id).filter(job => ["queued", "running", "failed", "unknown"].includes(job.status) && this.storage.message(room.id, job.sourceMessageId).threadRootId === request.threadRootId).slice(-100).map(networkExecution),
      plans: request.threadRootId ? [] : this.storage.plans.list(room.id).filter(plan => messages.slice(-100).some(message => message.planId === plan.id) || ["proposed", "running", "waiting"].includes(plan.status)).map(networkPlan) });
  }
  #threads(roomId: string, actorId: string): contract.PartnerNetworkThread[] {
    const messages = this.storage.messages(roomId), newest = messages.slice(-100);
    return messages.filter(root => !root.deleted && !root.threadRootId).flatMap(root => {
      const replies = messages.filter(message => message.threadRootId === root.id && !message.deleted && message.kind !== "member-joined"), last = replies.at(-1);
      if (!last) return [];
      const reader = this.storage.reader(roomId, actorId, root.id), unread = newest.filter(message => message.threadRootId === root.id && !message.deleted && message.kind !== "member-joined" && message.authorId !== actorId && message.sequence > reader.readSequence);
      return [create(contract.PartnerNetworkThreadSchema, { rootId: root.id, rootText: root.text.slice(0, 160) || root.attachments.map(file => file.name).join(", ").slice(0, 160),
        replyCount: BigInt(replies.length), readSequence: BigInt(reader.readSequence), unreadCount: BigInt(unread.length), latestUnreadSequence: BigInt(unread.at(-1)?.sequence ?? 0),
        mentioned: unread.some(message => message.mentions.includes(actorId)), following: reader.following, authorName: last.authorName,
        text: last.text.slice(0, 160) || last.attachments.map(file => file.name).join(", ").slice(0, 160), updatedAtMs: BigInt(last.createdAt) })];
    }).sort((a, b) => Number(b.unreadCount > 0n) - Number(a.unreadCount > 0n) || Number(b.updatedAtMs - a.updatedAtMs)).slice(0, 50);
  }
  failures(request: contract.ReadPartnerNetworkFailuresRequest, actorId: string): contract.ReadPartnerNetworkFailuresResponse {
    return create(contract.ReadPartnerNetworkFailuresResponseSchema, { executions: readCurrentPartnerNetworkFailures(this.storage, request.roomId, actorId, request.sourceMessageIds).map(networkExecution) });
  }
  #projectMessages(roomId: string, messages: readonly NetworkMessage[], readerId: string): contract.PartnerNetworkMessage[] {
    const available = this.storage.messages(roomId), byId = new Map(available.map(message => [message.id, message]));
    return messages.map(message => {
      const value = networkMessage(message, readerId), replies = available.filter(reply => !reply.deleted && reply.threadRootId === message.id);
      if (!message.threadRootId && replies.length) { const latest = replies.at(-1)!; value.threadPreview = create(contract.PartnerNetworkThreadPreviewSchema,
        { rootId: message.id, replyCount: BigInt(replies.length), latestReplyId: latest.id, authorName: latest.authorName, text: latest.text.slice(0, 160) || latest.task?.title || "" }); }
      if (message.kind === "thread-share" && message.threadShareId) {
        const source = byId.get(message.threadShareId), root = source?.threadRootId ? byId.get(source.threadRootId) : undefined;
        if (source && !source.deleted && root && !root.deleted) value.sharedReply = networkMessage(source, readerId);
      }
      if (message.deleted) { value.text = ""; value.attachments = []; value.sharedReply = undefined; value.threadPreview = undefined; value.task = undefined; }
      return value;
    });
  }
  send(request: contract.SendPartnerNetworkRequest, actorId: string): contract.PartnerNetworkMessage {
    return networkMessage(this.storage.send({ operationId: request.operationId, roomId: request.roomId, actorId, text: request.text,
      mentions: request.mentions, mentionAll: request.mentionAll, threadRootId: request.threadRootId, quoteId: request.quoteId, forcePlan: request.forcePlan,
      attachments: request.attachments.map(attachment => ({ id: attachment.id, name: attachment.name, mediaType: attachment.mediaType, sizeBytes: networkInteger(attachment.sizeBytes) })) }));
  }
  manage(request: contract.ManagePartnerNetworkRequest, actorId: string, local: boolean): contract.PartnerNetworkRoom {
    if (request.action === "share-thread") return this.#room(this.storage.shareThread({ roomId: request.roomId, ownerId: actorId, operationId: request.operationId, sourceId: request.value }), actorId);
    let partner: { id: string; name: string; description: string } | undefined;
    if (request.action === "add-partner") {
      if (local) partner = this.options.partner(request.actorId);
      else { if (!request.partner) throw new PartnerNetworkStoreError("invalid"); partner = { id: request.partner.partnerId, name: request.partner.name, description: request.partner.description }; }
    }
    return this.#room(this.storage.manage({ operationId: request.operationId, roomId: request.roomId, actorId, expectedRevision: networkInteger(request.expectedRevision),
      action: request.action, targetId: request.actorId, value: request.value, throughSequence: networkInteger(request.throughSequence), threadRootId: request.threadRootId,
      ...(request.following !== undefined ? { following: request.following } : {}), ...(partner ? { partner } : {}) }), actorId);
  }
  react(request: contract.ReactPartnerNetworkRequest, actorId: string): contract.PartnerNetworkMessage {
    return networkMessage(this.storage.react({ operationId: request.operationId, roomId: request.roomId, actorId, messageId: request.messageId, emoji: request.emoji, add: request.add }));
  }
  claim(request: contract.ClaimPartnerNetworkRequest, actorId: string): contract.ClaimPartnerNetworkResponse {
    const job = this.storage.claim(request.roomId, actorId, request.actorId);
    return create(contract.ClaimPartnerNetworkResponseSchema, job ? { execution: networkExecution(job), snapshot: this.executionSnapshot(request.roomId, job.id, job.lease, actorId) } : {});
  }
  executionSnapshot(roomId: string, executionId: string, lease: number, actorId: string): contract.PartnerNetworkSnapshot {
    const { room, job } = this.storage.validateExecution(roomId, executionId, lease, actorId), source = this.storage.message(roomId, job.sourceMessageId);
    const available = this.storage.messages(roomId).filter(message => message.sequence <= (job.contextThroughSequence ?? room.latestSequence));
    const plan = job.planId ? this.storage.plans.get(roomId, job.planId) : undefined;
    const groupBackground = plan?.kind === "talk" ? [] : available.filter(message => !message.threadRootId).slice(room.singleSpeaker ? -12 : -30).map(message =>
      room.singleSpeaker && message.id !== source.id ? { ...message, text: message.text.slice(0, 600) } : message);
    const messages = source.threadRootId ? [...groupBackground, this.storage.message(roomId, source.threadRootId), ...available.filter(message => message.threadRootId === source.threadRootId).slice(-100)] : groupBackground;
    if (!messages.some(message => message.id === source.id)) messages.push(source);
    if (source.quoteId && !messages.some(message => message.id === source.quoteId)) messages.push(this.storage.message(roomId, source.quoteId));
    if (plan) for (const id of [plan.sourceMessageId, ...plan.requestMessageIds, ...plan.noteMessageIds, ...plan.steps.filter(step => plan.kind !== "talk" || step.position < job.planPosition!).flatMap(step => step.resultMessageId ? [step.resultMessageId] : [])]) {
      if (!messages.some(message => message.id === id)) messages.push(this.storage.message(roomId, id));
    }
    return create(contract.PartnerNetworkSnapshotSchema, { room: this.#room(room, actorId), messages: [...new Map(messages.map(message => [message.id, message])).values()].map(message => networkMessage(message, actorId)),
      executions: [networkExecution(job)], plans: plan ? [networkPlan(plan)] : [] });
  }
  readExecution(request: contract.GetPartnerNetworkExecutionRequest, actorId: string): contract.GetPartnerNetworkExecutionResponse {
    const snapshot = this.executionSnapshot(request.roomId, request.executionId, networkInteger(request.lease), actorId);
    return create(contract.GetPartnerNetworkExecutionResponseSchema, { snapshot, execution: snapshot.executions[0] });
  }
  plan(request: contract.PlanPartnerNetworkRequest, actorId: string): contract.PlanPartnerNetworkResponse {
    const plan = this.storage.plans.action({ operationId: request.operationId, roomId: request.roomId, actorId, planId: request.planId,
      expectedRevision: networkInteger(request.expectedRevision), action: request.action, position: request.position, targetId: request.actorId, sourceMessageId: request.sourceMessageId });
    return create(contract.PlanPartnerNetworkResponseSchema, { ...(plan ? { plan: networkPlan(plan) } : {}),
      snapshot: this.snapshot(create(contract.GetPartnerNetworkRequestSchema, { roomId: request.roomId }), actorId) });
  }
  settle(request: contract.SettlePartnerNetworkRequest, actorId: string): contract.PartnerNetworkExecution {
    return networkExecution(this.storage.settle({ roomId: request.roomId, ownerId: actorId, executionId: request.executionId, lease: networkInteger(request.lease), action: request.action,
      text: request.text, failureCode: request.failureCode, completionId: request.completionId, seenNoteIds: request.seenNoteIds,
      attachments: request.attachments.map(attachment => ({ id: attachment.id, name: attachment.name, mediaType: attachment.mediaType, sizeBytes: networkInteger(attachment.sizeBytes) })),
      ...(request.decision ? { decision: { needsPlan: request.decision.needsPlan, steps: request.decision.steps.map(step => ({ actorId: step.actorId, task: step.task })) } } : {}) }));
  }
  publish(request: contract.PublishPartnerNetworkActorRequest, ownerId: string): contract.PartnerNetworkMessage {
    const task = request.task;
    return networkMessage(this.storage.appendActorMessage({ roomId: request.roomId, ownerId, actorId: request.actorId, operationId: request.operationId, text: request.text,
      attachments: request.attachments.map(attachment => ({ id: attachment.id, name: attachment.name, mediaType: attachment.mediaType, sizeBytes: networkInteger(attachment.sizeBytes) })),
      ...(task ? { task: { taskId: task.taskId, homeServerId: task.homeServerId, ownerId: task.ownerId, actorId: task.actorId, title: task.title, status: task.status,
        revision: networkInteger(task.revision), sessionId: task.sessionId, execution: networkInteger(task.execution), interactionKind: task.interactionKind, question: task.question } } : {}) }));
  }
  media(request: contract.MediaPartnerNetworkRequest, actorId: string, authority: Pick<PartnerNetworkAuthority, "signal" | "assertCurrent">): Promise<contract.MediaPartnerNetworkResponse> {
    const id = request.action === "begin" ? `media:${networkHash([actorId, networkIdentity(request.operationId)])}` : request.mediaId;
    const key = `${request.roomId}:${id}`, previous = this.#mediaFlights.get(key) ?? Promise.resolve();
    const task = previous.catch(() => {}).then(() => this.#media(request, actorId, authority)).finally(() => { if (this.#mediaFlights.get(key) === task) this.#mediaFlights.delete(key); });
    this.#mediaFlights.set(key, task); return task;
  }
  async #media(request: contract.MediaPartnerNetworkRequest, actorId: string, authority: Pick<PartnerNetworkAuthority, "signal" | "assertCurrent">): Promise<contract.MediaPartnerNetworkResponse> {
    const check = () => { authority.signal.throwIfAborted(); authority.assertCurrent(); this.assertActor(request.roomId, actorId); }; check();
    const directory = join(this.options.mediaDirectory, networkIdentity(request.roomId));
    if (request.action === "begin") {
      const { room } = this.storage.assertJoined(request.roomId, actorId); if (room.state !== "active") throw new PartnerNetworkStoreError("denied");
      const sizeBytes = networkInteger(request.sizeBytes), id = `media:${networkHash([actorId, networkIdentity(request.operationId)])}`;
      if (sizeBytes < 1 || sizeBytes > 100 * 1024 * 1024) throw new PartnerNetworkStoreError("invalid");
      const attachment = { id, name: networkText(request.name, 255), mediaType: networkText(request.mediaType, 200), sizeBytes };
      let saved: ReturnType<PartnerNetworkStore["media"]>;
      try {
        saved = this.storage.media(request.roomId, id);
        if (networkHash(saved.attachment) !== networkHash(attachment) || saved.actorId !== actorId) throw new PartnerNetworkStoreError("changed");
      } catch (error) {
        if (!(error instanceof PartnerNetworkStoreError) || error.code !== "not_found") throw error;
        // The exact upload intent is durable before creating its file. Offset
        // zero can resume either side of an interrupted file creation.
        saved = { actorId, attachment, complete: false, offset: 0 };
        this.storage.saveMedia(request.roomId, saved);
      }
      try { await this.#prepareMediaFile(directory, saved, check); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new PartnerNetworkStoreError("not_found");
        throw error;
      }
      return create(contract.MediaPartnerNetworkResponseSchema, { attachment: networkAttachment(saved.attachment), offset: BigInt(saved.offset), complete: saved.complete });
    }
    const saved = this.storage.media(request.roomId, request.mediaId), path = join(directory, saved.attachment.id.replace(":", "-")), offset = networkInteger(request.offset);
    if (request.action === "authorize") {
      if (!this.options.artifacts || !saved.complete || !this.storage.messages(request.roomId).some(message => !message.deleted && message.attachments.some(attachment => attachment.id === saved.attachment.id))) throw new PartnerNetworkStoreError("denied");
      const handle = await open(path, "r");
      try {
        const artifact = await this.options.artifacts.ingestFileHandle(handle, { expectedSize: saved.attachment.sizeBytes, fileName: saved.attachment.name,
          mimeType: saved.attachment.mediaType, signal: authority.signal, beforeFinalize: async () => check() }); check();
        const ticket = await this.options.artifacts.createDownloadTicket(artifact.id); check();
        return create(contract.MediaPartnerNetworkResponseSchema, { attachment: networkAttachment(saved.attachment), complete: true,
          downloadUrl: `${this.#origin()}/v1/blobs/download/${encodeURIComponent(ticket.ticketId)}/${encodeURIComponent(ticket.secret)}` });
      } finally { await handle.close(); }
    }
    if (request.action === "read") {
      if (!saved.complete || !this.storage.messages(request.roomId).some(message => !message.deleted && message.attachments.some(attachment => attachment.id === saved.attachment.id))) throw new PartnerNetworkStoreError("denied");
      if (offset > saved.attachment.sizeBytes) throw new PartnerNetworkStoreError("invalid");
      const file = await open(path, "r"); try {
        const buffer = Buffer.alloc(Math.min(256 * 1024, saved.attachment.sizeBytes - offset)), result = await file.read(buffer, 0, buffer.length, offset); check();
        if (result.bytesRead !== buffer.length) throw new PartnerNetworkStoreError("not_found");
        return create(contract.MediaPartnerNetworkResponseSchema, { attachment: networkAttachment(saved.attachment), offset: BigInt(offset + result.bytesRead), data: buffer, complete: offset + result.bytesRead === saved.attachment.sizeBytes });
      } finally { await file.close(); }
    }
    if (request.action !== "write" || saved.actorId !== actorId || request.data.byteLength > 256 * 1024 || offset > saved.offset || offset + request.data.byteLength > saved.attachment.sizeBytes) throw new PartnerNetworkStoreError("denied");
    if (offset < saved.offset || saved.complete) {
      const file = await open(path, "r"); try { const buffer = Buffer.alloc(request.data.byteLength); await file.read(buffer, 0, buffer.length, offset); check();
        if (!buffer.equals(Buffer.from(request.data))) throw new PartnerNetworkStoreError("changed");
      } finally { await file.close(); }
      return create(contract.MediaPartnerNetworkResponseSchema, { attachment: networkAttachment(saved.attachment), offset: BigInt(saved.offset), complete: saved.complete });
    }
    const file = await open(path, "r+"); try { check(); await file.write(request.data, 0, request.data.byteLength, offset); await file.sync(); check(); } finally { await file.close(); }
    const next = { ...saved, offset: offset + request.data.byteLength, complete: offset + request.data.byteLength === saved.attachment.sizeBytes };
    this.storage.saveMedia(request.roomId, next); return create(contract.MediaPartnerNetworkResponseSchema, { attachment: networkAttachment(saved.attachment), offset: BigInt(next.offset), complete: next.complete });
  }
  async #prepareMediaFile(directory: string, saved: ReturnType<PartnerNetworkStore["media"]>, check: () => void): Promise<void> {
    await mkdir(directory, { recursive: true, mode: 0o700 }); check();
    const parent = await lstat(directory); check();
    if (!parent.isDirectory() || parent.isSymbolicLink()) throw new PartnerNetworkStoreError("changed");
    const path = join(directory, saved.attachment.id.replace(":", "-"));
    const openExisting = async () => {
      const before = await lstat(path); check();
      if (!before.isFile() || before.isSymbolicLink()) throw new PartnerNetworkStoreError("changed");
      const handle = await open(path, "r+");
      try {
        const opened = await handle.stat(); check();
        if (opened.dev !== before.dev || opened.ino !== before.ino) throw new PartnerNetworkStoreError("changed");
        return handle;
      } catch (error) { await handle.close(); throw error; }
    };
    let handle: Awaited<ReturnType<typeof open>>;
    if (saved.offset === 0 && !saved.complete) {
      try { handle = await open(path, "wx", 0o600); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        handle = await openExisting();
      }
    } else handle = await openExisting();
    try {
      const info = await handle.stat(); check();
      if (!info.isFile() || info.size < saved.offset || info.size > saved.attachment.sizeBytes
        || saved.complete && info.size !== saved.attachment.sizeBytes) throw new PartnerNetworkStoreError("changed");
    } finally { await handle.close(); }
    check();
  }
  async close(): Promise<void> { this.#invites.clear(); await Promise.allSettled(this.#mediaFlights.values()); }
}
export function partnerNetworkError(error: unknown): never {
  if (error instanceof ConnectError) throw error;
  if (error instanceof PartnerNetworkStoreError) throw new ConnectError(error.message, ({ invalid: Code.InvalidArgument, denied: Code.PermissionDenied,
    not_found: Code.NotFound, changed: Code.Aborted, expired: Code.FailedPrecondition })[error.code]);
  throw new ConnectError("The conversation is temporarily unavailable. Check the original operation before retrying.", Code.Unavailable);
}
