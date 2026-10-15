import { createHash, randomBytes, randomUUID } from "node:crypto";
import { create, fromBinary } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import * as contract from "@joko/contracts";
import { TaskShareStore, operationBodyHash, type OperationalStore, type TaskShareRecord, type TaskShareMemberRecord, type TaskShareActionReceipt } from "@joko/store";
import { fromProtoEventCursor, toProtoEventCursor, fromProtoInputContent } from "./proto-mapper.js";
import type { TaskShareLease, TaskSharingRuntimePort } from "./task-sharing-host-types.js";
import type { ArtifactStore } from "./artifact-store.js";
import { TaskSharingHostMedia } from "./task-sharing-host-media.js";
export type { TaskShareLease, TaskSharingRuntimePort, PreparedTaskShareOperation } from "./task-sharing-host-types.js";

export interface TaskSharingHostOptions {
  readonly store: OperationalStore; readonly serverId: string; readonly origin: string;
  readonly generation: () => bigint; readonly runtime: TaskSharingRuntimePort;
  readonly artifacts?: ArtifactStore;
}

/** Host authority for one canonical task. Guest keys are never Connections. */
export class TaskSharingHost {
  readonly shares: TaskShareStore;
  readonly media: TaskSharingHostMedia | undefined;
  readonly #leases = new Set<{ readonly lease: TaskShareLease; readonly controller: AbortController }>();
  readonly #stopStore: () => void;
  readonly #invitationReplies = new Map<string, string>();
  #closed = false;
  constructor(readonly options: TaskSharingHostOptions) {
    this.shares = new TaskShareStore(options.store);
    this.media = options.artifacts === undefined ? undefined : new TaskSharingHostMedia(options.store, this.shares, options.artifacts);
    this.#stopStore = options.store.subscribe(() => this.reconcile());
  }
  list(): readonly contract.TaskShare[] {
    return this.shares.list().map(share => this.publicShare(share));
  }
  get(shareId: string): contract.TaskShare { return this.publicShare(this.shares.get(shareId)); }
  create(input: { readonly operationId: string; readonly sessionId: string }): contract.TaskShare {
    if (!this.options.runtime.canShare(input.sessionId)) throw denied("This task cannot be shared.");
    const result = this.options.store.runOperation({ id: input.operationId, kind: "task_share_create", body: input }, () =>
      this.shares.create({ shareId: `share-${randomUUID()}`, sessionId: input.sessionId, invitationSha256Hex: hash(randomBytes(32).toString("base64url")) }).shareId);
    return this.get(result.value);
  }
  invite(input: { readonly operationId: string; readonly shareId: string }): { share: contract.TaskShare; invitation: string } {
    const previous = this.options.store.findOperation(input.operationId);
    if (previous !== undefined && !this.#invitationReplies.has(input.operationId)) throw new ConnectError("The invitation response is no longer available. Create a new invitation explicitly.", Code.FailedPrecondition);
    let invitation = this.#invitationReplies.get(input.operationId);
    const result = this.options.store.runOperation({ id: input.operationId, kind: "task_share_invite", body: input }, () => {
      const inviteSecret = randomBytes(32).toString("base64url");
      const share = this.shares.setInvitation(input.shareId, hash(inviteSecret));
      invitation = contract.buildTaskShareInvitation({ hostOrigin: this.options.origin, hostServerId: this.options.serverId,
        shareId: share.shareId, shareGeneration: BigInt(share.shareGeneration), inviteSecret });
      return share.shareId;
    });
    if (!invitation) throw new ConnectError("Create a new invitation explicitly.", Code.FailedPrecondition);
    this.#invitationReplies.set(input.operationId, invitation);
    // Invitations are private, short-lived replies rather than durable receipts.
    setTimeout(() => this.#invitationReplies.delete(input.operationId), 60_000).unref();
    return { share: this.get(result.value), invitation };
  }
  remove(input: { readonly operationId: string; readonly shareId: string; readonly memberId: string; readonly memberGeneration: bigint }): contract.TaskShare {
    const result = this.options.store.runOperation({ id: input.operationId, kind: "task_share_remove", body: input }, () => {
      const share = this.shares.active(input.shareId), member = share.members.find(row => row.memberId === input.memberId);
      if (!member || BigInt(member.memberGeneration) !== input.memberGeneration) throw denied("The participant changed. Refresh before removing them.");
      return this.shares.remove(input.shareId, input.memberId).shareId;
    });
    this.reconcile(); return this.get(result.value);
  }
  end(input: { readonly operationId: string; readonly shareId: string }): contract.TaskShare {
    const result = this.options.store.runOperation({ id: input.operationId, kind: "task_share_end", body: input }, () => this.shares.end(input.shareId).shareId);
    this.reconcile(); return this.get(result.value);
  }
  endAll(input: { readonly operationId: string; readonly shareIds: readonly string[] }, assertCurrent: () => void): { endedShareIds: string[]; failedShareIds: string[] } {
    assertCurrent();
    const result = this.options.store.runOperation({ id: input.operationId, kind: "task_share_end_all", body: input }, () => {
      const endedShareIds: string[] = [], failedShareIds: string[] = [];
      for (const shareId of [...new Set(input.shareIds)]) {
        assertCurrent();
        try { this.end({ operationId: `${input.operationId}:${hash(shareId)}`, shareId }); endedShareIds.push(shareId); }
        catch { failedShareIds.push(shareId); }
      }
      return { endedShareIds, failedShareIds };
    });
    assertCurrent(); return result.value;
  }
  lookupAction(operationId: string): contract.TaskSharingActionReceipt {
    const operation = this.options.store.findOperation(operationId);
    if (!operation || !["task_share_create", "task_share_invite", "task_share_remove", "task_share_end", "task_share_end_all"].includes(operation.kind)) throw new ConnectError("The task sharing action was not found.", Code.NotFound);
    const batch = operation.kind === "task_share_end_all" && operation.response && typeof operation.response === "object"
      ? operation.response as { endedShareIds: string[]; failedShareIds: string[] } : undefined;
    return create(contract.TaskSharingActionReceiptSchema, { operationId, kind: operation.kind,
      status: operation.status === "completed" ? "applied" : operation.status === "failed" ? "failed" : "unknown",
      errorCode: operation.status === "failed" ? "action_failed" : "",
      ...(typeof operation.response === "string" ? { share: this.get(operation.response) } : {}),
      ...(batch === undefined ? {} : batch) });
  }
  previewInvitation(invitation: string): contract.TaskShare {
    const parsed = this.invitation(invitation), share = this.shares.active(parsed.shareId);
    if (BigInt(share.shareGeneration) !== parsed.shareGeneration || share.invitationSha256Hex !== hash(parsed.inviteSecret)) throw denied("The task invitation is no longer available.");
    return this.publicShare(share);
  }
  acceptJoin(input: { readonly intentId: string; readonly invitation: string; readonly credentialSha256Hex: string;
    readonly displayName: string; readonly homeServerId: string; readonly homeDeviceId: string }): { share: contract.TaskShare; member: contract.TaskShareMember } {
    const parsed = this.invitation(input.invitation);
    const result = this.shares.join({ ...input, shareId: parsed.shareId, shareGeneration: safeGeneration(parsed.shareGeneration),
      invitationSha256Hex: hash(parsed.inviteSecret), memberId: `member-${randomUUID()}` });
    return { share: this.publicShare(result.share), member: publicMember(result.member) };
  }
  getJoinReceipt(input: { readonly intentId: string; readonly credentialSha256Hex: string }, lease: TaskShareLease): { share: contract.TaskShare; member: contract.TaskShareMember } {
    lease.assertCurrent();
    if (input.credentialSha256Hex !== lease.proof.credentialSha256Hex) throw denied("The join receipt belongs to another participant.");
    const result = this.shares.byCredential(input.credentialSha256Hex);
    if (result.member.joinIntentId !== input.intentId) throw denied("The original task join could not be confirmed.");
    return { share: this.publicShare(result.share), member: publicMember(result.member) };
  }
  authenticate(authorization: string | undefined, expected?: contract.TaskShareScope): TaskShareLease {
    if (this.#closed) throw denied("Task sharing is closed.");
    const secret = /^TaskShareGuest ([A-Za-z0-9_-]{32,256})$/u.exec(authorization ?? "")?.[1];
    if (!secret) throw new ConnectError("Task guest authentication is required.", Code.Unauthenticated);
    let current;
    try { current = this.shares.byCredential(hash(secret)); } catch { throw denied("Task membership is unavailable or revoked."); }
    const { share, member } = current;
    const proof = { shareId: share.shareId, shareGeneration: share.shareGeneration, memberId: member.memberId,
      memberGeneration: member.memberGeneration, credentialSha256Hex: hash(secret) };
    const scope = create(contract.TaskShareScopeSchema, { hostServerId: this.options.serverId, shareId: share.shareId,
      shareGeneration: BigInt(share.shareGeneration), sessionId: share.sessionId, memberId: member.memberId, memberGeneration: BigInt(member.memberGeneration) });
    if (expected) contract.assertTaskShareScope(expected, this.publicShare(share), member.memberId, BigInt(member.memberGeneration));
    const controller = new AbortController();
    const lease: TaskShareLease = { proof, scope, author: this.shares.author(proof), signal: controller.signal,
      assertCurrent: () => {
        controller.signal.throwIfAborted();
        if (this.#closed) throw denied("Task sharing is closed.");
        this.shares.authorize(proof);
      } };
    this.#leases.add({ lease, controller });
    return lease;
  }
  release(lease: TaskShareLease): void {
    for (const entry of this.#leases) if (entry.lease === lease) { this.#leases.delete(entry); entry.controller.abort(); }
  }
  async readSnapshot(lease: TaskShareLease, signal: AbortSignal): Promise<contract.TaskShareSnapshot> {
    lease.assertCurrent();
    const snapshot = await this.options.runtime.snapshot(lease, AbortSignal.any([signal, lease.signal]));
    lease.assertCurrent(); signal.throwIfAborted();
    if (snapshot.scope?.kind.case !== "session" || snapshot.scope.kind.value.sessionId !== lease.scope.sessionId
      || snapshot.sessions.some(row => row.sessionId !== lease.scope.sessionId)) throw denied("The task projection does not match its authority.");
    const { share, member } = this.shares.authorize(lease.proof);
    return create(contract.TaskShareSnapshotSchema, { share: this.publicShare(share), member: publicMember(member), snapshot });
  }
  readEvents(lease: TaskShareLease, after: contract.EventCursor | undefined, limit: number, signal: AbortSignal): contract.TaskShareEventBatch {
    lease.assertCurrent(); signal.throwIfAborted();
    const generation = this.options.generation(), highWater = this.options.store.health().globalCursor;
    const cursor = fromProtoEventCursor(after), maximum = Math.min(Math.max(limit || 200, 1), 500);
    if (cursor.generation !== generation || cursor.sequence > highWater) return create(contract.TaskShareEventBatchSchema, {
      generation, resyncRequired: true, resumeCursor: toProtoEventCursor(highWater, generation, Date.now()) });
    const page = this.options.store.listEvents({ sessionId: lease.scope.sessionId, afterCursor: cursor.sequence, limit: maximum });
    const events = page.flatMap(event => { const projected = this.options.runtime.projectEvent(lease, event); return projected ? [projected] : []; });
    lease.assertCurrent(); signal.throwIfAborted();
    const resume = page.length < maximum ? highWater : page.at(-1)!.globalCursor;
    return create(contract.TaskShareEventBatchSchema, { events, generation,
      resumeCursor: toProtoEventCursor(resume, generation, Date.now()), resyncRequired: false });
  }
  async invoke(lease: TaskShareLease, method: contract.TaskShareMethod, requestBytes: Uint8Array, signal: AbortSignal): Promise<Uint8Array> {
    lease.assertCurrent(); signal.throwIfAborted();
    if (!Object.hasOwn(contract.TASK_SHARE_METHODS, method)) throw denied("This operation is not available to task guests.");
    if (requestBytes.byteLength > 4 * 1024 * 1024) throw new ConnectError("The shared task request is too large.", Code.ResourceExhausted);
    if (method !== contract.TaskShareMethod.SUBMIT_OPERATION) {
      const result = await this.options.runtime.read(lease, method, requestBytes, AbortSignal.any([signal, lease.signal]));
      lease.assertCurrent(); signal.throwIfAborted(); return result;
    }
    const request = fromBinary(contract.SubmitOperationRequestSchema, requestBytes);
    const prepared = this.options.store.transaction(() => {
      lease.assertCurrent(); this.assertMutation(lease, request);
      const receipt = this.shares.receipt(lease.proof, request.operationId, requestBytes);
      if (receipt) return { receipt };
      const operation = this.options.runtime.prepareOperation(lease, request);
      this.shares.recordAuthor(request.operationId, lease.author);
      this.shares.admit(lease.proof, request.operationId, requestBytes);
      if (operation.kind === "transactional") {
        const response = operation.commit(this.options.store, lease.author);
        lease.assertCurrent();
        this.shares.settle(lease.proof, request.operationId, requestBytes, { status: "completed", responseHex: Buffer.from(response).toString("hex") });
        return { response, afterCommit: operation.afterCommit };
      }
      return { effect: operation.execute };
    });
    if ("receipt" in prepared) return replay(prepared.receipt!);
    if ("response" in prepared) { prepared.afterCommit?.(); lease.assertCurrent(); return prepared.response!; }
    try {
      const response = await prepared.effect!(lease.author, AbortSignal.any([signal, lease.signal]));
      this.options.store.transaction(() => {
        lease.assertCurrent(); this.shares.settle(lease.proof, request.operationId, requestBytes,
          { status: "completed", responseHex: Buffer.from(response).toString("hex") });
      });
      lease.assertCurrent(); signal.throwIfAborted(); return response;
    } catch (error) {
      // An admitted native effect is never automatically replayed, including
      // loss of its membership or request transport while settling.
      try { this.options.store.transaction(() => this.shares.settle(lease.proof, request.operationId, requestBytes,
        { status: "unknown", errorCode: "outcome_unknown" })); } catch { /* Revoked author cannot publish a receipt. */ }
      throw error;
    }
  }
  leave(lease: TaskShareLease, operationId: string): { share: contract.TaskShare; member: contract.TaskShareMember } {
    const result = this.options.store.transaction(() => {
      lease.assertCurrent();
      return this.options.store.runOperation({ id: operationId, kind: "task_share_leave", body: lease.scope }, () =>
        this.shares.remove(lease.scope.shareId, lease.scope.memberId, "left"));
    });
    this.reconcile();
    return { share: this.publicShare(result.value), member: publicMember(result.value.members.find(row => row.memberId === lease.scope.memberId)!) };
  }
  lookupLeave(authorization: string | undefined, input: { readonly scope: contract.TaskShareScope; readonly operationId: string }): boolean {
    if (this.#closed) throw denied("Task sharing is closed.");
    const secret = /^TaskShareGuest ([A-Za-z0-9_-]{32,256})$/u.exec(authorization ?? "")?.[1];
    if (!secret) throw new ConnectError("Task guest authentication is required.", Code.Unauthenticated);
    return this.options.store.transaction(() => {
      const scope = input.scope;
      let share: TaskShareRecord;
      try { share = this.shares.get(scope.shareId); } catch { throw denied("The original task leave cannot be verified."); }
      const member = share.members.find(row => row.memberId === scope.memberId);
      if (scope.hostServerId !== this.options.serverId || scope.sessionId !== share.sessionId
        || scope.shareGeneration < 1n || scope.shareGeneration > BigInt(share.shareGeneration)
        || !member || scope.memberGeneration < 1n || scope.memberGeneration > BigInt(member.memberGeneration)
        || member.credentialSha256Hex !== hash(secret)) throw denied("The original task leave belongs to another participant.");
      const operation = this.options.store.findOperation(input.operationId);
      if (!operation) throw new ConnectError("No task leave was admitted with this identity.", Code.NotFound);
      if (operation.kind !== "task_share_leave" || operation.bodyHash !== operationBodyHash(scope)) throw denied("The original task leave belongs to another participant.");
      if (operation.status !== "completed") throw new ConnectError("The original task leave is awaiting confirmation.", Code.FailedPrecondition);
      return true;
    });
  }
  transfer(lease: TaskShareLease, transfer: contract.TaskShareAttachmentTransfer, signal: AbortSignal): Promise<contract.TaskShareAttachmentResult> {
    if (!this.media) throw new ConnectError("Task attachment storage is unavailable.", Code.Unavailable);
    return this.media.transfer(lease, transfer, signal);
  }
  reconcile(): void {
    this.media?.reconcile();
    for (const entry of this.#leases) {
      try { entry.lease.assertCurrent(); } catch { entry.controller.abort(); this.#leases.delete(entry); }
    }
  }
  close(): void {
    this.#closed = true; this.#stopStore(); this.reconcile(); this.#invitationReplies.clear(); this.media?.close();
  }
  private invitation(value: string): contract.TaskShareInvitation {
    const parsed = contract.parseTaskShareInvitation(value);
    if (parsed.hostOrigin !== this.options.origin || parsed.hostServerId !== this.options.serverId) throw denied("This invitation belongs to another Host.");
    return parsed;
  }
  private publicShare(share: TaskShareRecord): contract.TaskShare {
    const session = this.options.store.getSession(share.sessionId).descriptor;
    return create(contract.TaskShareSchema, { shareId: share.shareId, sessionId: share.sessionId,
      shareGeneration: BigInt(share.shareGeneration), revision: BigInt(share.revision), title: session.title,
      hostServerId: this.options.serverId, hostOrigin: this.options.origin, status: share.status,
      members: share.members.map(publicMember), createdAtMs: BigInt(share.createdAt) });
  }
  private assertMutation(lease: TaskShareLease, request: contract.SubmitOperationRequest): void {
    if (request.connectionId !== "" || !request.operationId) throw denied("Task guest operations cannot claim a node Connection.");
    const payload = request.mutation?.payload;
    if (!payload || !new Set(["sendInput", "resumeSession", "resumeQueue", "setSessionModel", "setSessionRuntime", "abortRun",
      "cancelQueueItem", "editQueueItem", "setQueueItemEditLock", "resolveInteraction"]).has(payload.case ?? "")) throw denied("This action requires the task owner.");
    for (const precondition of request.mutation!.preconditions) {
      const entity = precondition.entity;
      let permitted = false;
      if (entity) {
        switch (entity.kind) {
          case contract.EntityKind.SESSION:
          case contract.EntityKind.QUEUE_CONTROL: permitted = entity.id === lease.scope.sessionId; break;
          case contract.EntityKind.RUN: permitted = this.options.store.findRun(entity.id)?.descriptor.sessionId === lease.scope.sessionId; break;
          case contract.EntityKind.QUEUE_ITEM:
            try { permitted = this.options.store.getQueueItem(entity.id).sessionId === lease.scope.sessionId; } catch { /* Missing entities confer no shared-task authority. */ }
            break;
          case contract.EntityKind.INTERACTION: permitted = this.options.store.findInteraction(entity.id)?.sessionId === lease.scope.sessionId; break;
          case contract.EntityKind.BACKEND: permitted = this.options.store.listBackends().some(backend => backend.descriptor.id === entity.id); break;
        }
      }
      if (!permitted) throw denied("The action precondition is outside this shared task.");
    }
    const value = payload.value as unknown as Record<string, unknown>;
    if (typeof value["sessionId"] === "string" && value["sessionId"] !== lease.scope.sessionId) throw denied("The action targets another task.");
    if (payload.case === "cancelQueueItem" || payload.case === "editQueueItem" || payload.case === "setQueueItemEditLock") {
      try { this.shares.assertOwnPending(lease.proof, payload.value.queueItemId); }
      catch { throw denied("Only your own pending input may be changed."); }
    }
    if (payload.case === "abortRun" && this.options.store.getRun(payload.value.runId).descriptor.sessionId !== lease.scope.sessionId) throw denied("The Run belongs to another task.");
    if (payload.case === "sendInput") {
      const overrides = payload.value.overrides;
      if (overrides && (overrides.permissionMode !== undefined || overrides.planMode !== undefined || overrides.extraDirectoryIds.length > 0)) throw denied("Task guests cannot change execution permissions.");
    }
    if (payload.case === "setSessionRuntime") {
      const change = payload.value;
      if (change.expectedRuntimeGeneration < 0n || change.expectedRuntimeGeneration > BigInt(Number.MAX_SAFE_INTEGER)
        || [change.backendId, change.providerId, change.modelId].some(field => field !== undefined && (!field || field.length > 256 || /[\u0000-\u001f\u007f]/u.test(field)))
        || change.effort !== undefined && (change.effort.length > 128 || /[\u0000-\u001f\u007f]/u.test(change.effort))
        || ![change.backendId, change.providerId, change.modelId, change.effort, change.fastMode].some(field => field !== undefined)) throw denied("The task runtime change is invalid.");
    }
    if (payload.case === "sendInput" || payload.case === "editQueueItem") {
      const prompt = fromProtoInputContent(payload.value.input);
      for (const file of [...prompt.images, ...prompt.files]) {
        if (!this.media) throw denied("Task attachment storage is unavailable.");
        this.media.assertVisibleBlob(lease, file.blob.id);
      }
      // Mentions can confer workspace/resource/other-task authority. The
      // fixed guest input boundary accepts its own uploaded attachments.
      if (prompt.mentions.length) throw denied("Task guests cannot introduce workspace, resource, or other-task references.");
    }
    if (payload.case === "resolveInteraction") {
      const interaction = this.options.store.getInteraction(payload.value.interactionId);
      if (interaction.sessionId !== lease.scope.sessionId || interaction.status !== "open"
        || !["permission", "question", "plan_review"].includes(interaction.kind)) throw denied("This confirmation requires the task owner.");
    }
  }
}
function publicMember(member: TaskShareMemberRecord): contract.TaskShareMember {
  return create(contract.TaskShareMemberSchema, { memberId: member.memberId, memberGeneration: BigInt(member.memberGeneration),
    displayName: member.displayName, status: member.status, joinedAtMs: BigInt(member.joinedAt) });
}
function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function safeGeneration(value: bigint): number {
  const result = Number(value); if (!Number.isSafeInteger(result) || result < 1) throw denied("The task sharing generation is invalid."); return result;
}
function denied(message: string): ConnectError { return new ConnectError(message, Code.PermissionDenied); }
function replay(receipt: TaskShareActionReceipt): Uint8Array {
  if (receipt.status !== "completed" || receipt.responseHex === undefined) throw new ConnectError("The original shared-task operation is awaiting confirmation; it will not be replayed.", Code.FailedPrecondition);
  return Buffer.from(receipt.responseHex, "hex");
}
