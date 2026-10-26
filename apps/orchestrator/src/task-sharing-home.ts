import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { create, fromBinary, fromJsonString, toBinary, toJsonString } from "@bufbuild/protobuf";
import { Code, ConnectError, createClient, type Client } from "@connectrpc/connect";
import { createConnectTransport } from "@joko/connection-transport/node";
import * as contract from "@joko/contracts";
import type { CredentialVault, EncryptedCredential } from "./credential-vault.js";

export interface TaskSharingHomeAuthority {
  readonly deviceId: string;
  readonly signal: AbortSignal;
  assertCurrent(): void;
}
export interface TaskSharingHomeRemote {
  readonly guest: Client<typeof contract.TaskSharingGuestService>;
  verify(serverId: string, signal: AbortSignal): Promise<void>;
}
interface StoredIntent {
  readonly operationId: string;
  readonly requestSha256Hex: string;
  readonly joinId: string;
  readonly hostOrigin: string;
  readonly endpointPublicKey: string;
  readonly hostServerId: string;
  readonly shareId: string;
  readonly shareGeneration: string;
  readonly displayName: string;
  readonly homeDeviceId: string;
  readonly credentialSha256Hex: string;
  sealed: EncryptedCredential;
  status: "prepared" | "sent" | "joined" | "unknown" | "failed";
  errorCode: string;
}
interface StoredJoin {
  value: string;
  readonly endpointPublicKey: string;
  readonly credentialReference: string;
  readonly sealed: EncryptedCredential;
}
interface StoredWrite {
  readonly joinId: string;
  readonly operationId: string;
  readonly requestSha256Hex: string;
  status: "sent" | "unknown" | "complete";
}
interface HomeDisk {
  readonly format: 1;
  readonly serverId: string;
  readonly intents: readonly StoredIntent[];
  readonly joined: readonly StoredJoin[];
  readonly writes: readonly StoredWrite[];
  readonly actions: readonly string[];
}
/** Same-Home directory and sealed foreign credentials, never a second Session store. */
export class TaskSharingHome {
  readonly #intents = new Map<string, StoredIntent>();
  readonly #joined = new Map<string, StoredJoin>();
  readonly #writes = new Map<string, StoredWrite>();
  readonly #actions = new Map<string, contract.TaskSharingActionReceipt>();
  readonly #joinInputs = new Map<string, string>();
  readonly #flights = new Map<string, Promise<unknown>>();
  readonly #lifetimes = new Map<string, AbortController>();
  #saveFlight: Promise<void> = Promise.resolve();
  #closed = false;
  #directoryOffset = 0;
  constructor(readonly options: { readonly directory: string; readonly vault: CredentialVault; readonly serverId: string;
    readonly connect?: (origin: string, endpointPublicKey: string) => TaskSharingHomeRemote; readonly now?: () => number }) {}

  async initialize(): Promise<void> {
    await mkdir(this.options.directory, { recursive: true, mode: 0o700 });
    let text: string;
    try { text = await readFile(join(this.options.directory, "home.json"), "utf8"); }
    catch (error) { if (isMissing(error)) return; throw error; }
    if (Buffer.byteLength(text) > 16 * 1024 * 1024) throw new Error("The private shared task directory is invalid.");
    const value = JSON.parse(text) as HomeDisk;
    if (value.format !== 1 || value.serverId !== this.options.serverId || !Array.isArray(value.intents)
      || !Array.isArray(value.joined) || !Array.isArray(value.writes) || !Array.isArray(value.actions)) throw new Error("The private shared task directory is invalid.");
    for (const item of value.intents) {
      contract.taskShareIdentity(item.operationId); contract.taskShareIdentity(item.joinId); contract.taskShareOrigin(item.hostOrigin);
      contract.taskShareEndpointPublicKey(item.endpointPublicKey);
      if (!/^[a-f0-9]{64}$/u.test(item.requestSha256Hex) || !/^[a-f0-9]{64}$/u.test(item.credentialSha256Hex)
        || !["prepared", "sent", "joined", "unknown", "failed"].includes(item.status) || this.#intents.has(item.operationId)) throw new Error("The shared task intent is invalid.");
      this.#intents.set(item.operationId, { ...item, status: item.status === "sent" || item.status === "prepared" ? "unknown" : item.status });
    }
    for (const item of value.joined) {
      const joined = fromJsonString(contract.JoinedTaskShareSchema, item.value);
      contract.taskShareEndpointPublicKey(item.endpointPublicKey);
      this.#validateJoined(joined);
      if (item.credentialReference !== this.#joinedReference(joined, item.endpointPublicKey)) throw unavailable();
      if (this.#joined.has(joined.joinId)) throw new Error("The joined task identity is duplicated.");
      this.#joined.set(joined.joinId, item); this.#lifetimes.set(joined.joinId, new AbortController());
    }
    for (const item of value.writes) {
      if (!/^[a-f0-9]{64}$/u.test(item.requestSha256Hex) || !["sent", "unknown", "complete"].includes(item.status)) throw new Error("The shared task receipt is invalid.");
      this.#writes.set(`${item.joinId}:${item.operationId}`, { ...item, status: item.status === "sent" ? "unknown" : item.status });
    }
    for (const item of value.actions) {
      const receipt = fromJsonString(contract.TaskSharingActionReceiptSchema, item); contract.taskShareIdentity(receipt.operationId);
      this.#actions.set(receipt.operationId, create(contract.TaskSharingActionReceiptSchema, { ...receipt, status: receipt.status === "sent" ? "unknown" : receipt.status }));
    }
  }
  list(): { readonly joined: contract.JoinedTaskShare[]; readonly intents: contract.TaskShareJoinIntent[] } {
    return { joined: [...this.#joined.values()].map(item => fromJsonString(contract.JoinedTaskShareSchema, item.value)),
      intents: [...this.#intents.values()].map(item => this.#intent(item)) };
  }
  async preview(invitation: string, auth: TaskSharingHomeAuthority): Promise<contract.TaskShare> {
    const parsed = contract.parseTaskShareInvitation(invitation); const remote = this.#remote(parsed.hostOrigin, parsed.endpointPublicKey);
    auth.assertCurrent(); await remote.verify(parsed.hostServerId, auth.signal); auth.assertCurrent();
    const response = await remote.guest.inspectTaskShareInvitation({ invitation }, { signal: auth.signal }); auth.assertCurrent();
    return this.#checkInvitationShare(parsed, response.share);
  }
  join(operationId: string, invitation: string, displayName: string, auth: TaskSharingHomeAuthority): Promise<contract.TaskShareJoinIntent> {
    contract.taskShareIdentity(operationId); const parsed = contract.parseTaskShareInvitation(invitation);
    if (parsed.hostServerId === this.options.serverId) throw new ConnectError("Open your own task from the owned directory.", Code.FailedPrecondition);
    const name = displayName.trim(); if (!name || name.length > 128) throw new ConnectError("A participant name is required.", Code.InvalidArgument);
    const fingerprint = digest(JSON.stringify([invitation, name, auth.deviceId]));
    const previous = this.#intents.get(operationId);
    if (previous && previous.requestSha256Hex !== fingerprint) throw new ConnectError("The join operation has different input.", Code.AlreadyExists);
    const activeFingerprint = this.#joinInputs.get(operationId);
    if (activeFingerprint !== undefined && activeFingerprint !== fingerprint) throw new ConnectError("The join operation has different input.", Code.AlreadyExists);
    this.#joinInputs.set(operationId, fingerprint);
    return this.#single(`join:${operationId}`, async () => {
      const old = this.#intents.get(operationId);
      if (old) return old.status === "joined" || old.status === "failed" ? this.#intent(old) : this.#recover(old, auth);
      await this.preview(invitation, auth); auth.assertCurrent();
      const secret = randomBytes(32).toString("base64url"), joinId = randomUUID();
      const intent: StoredIntent = { operationId, requestSha256Hex: fingerprint, joinId, hostOrigin: parsed.hostOrigin,
        endpointPublicKey: parsed.endpointPublicKey,
        hostServerId: parsed.hostServerId, shareId: parsed.shareId, shareGeneration: String(parsed.shareGeneration), displayName: name,
        homeDeviceId: auth.deviceId, credentialSha256Hex: digest(secret),
        sealed: this.options.vault.seal(JSON.stringify({ secret }), this.#intentReference(operationId, joinId, parsed.hostServerId, parsed.shareId, parsed.hostOrigin, parsed.endpointPublicKey)),
        status: "prepared", errorCode: "" };
      this.#intents.set(operationId, intent); await this.#save(); auth.assertCurrent();
      intent.status = "sent"; await this.#save(); auth.assertCurrent();
      try {
        const remote = this.#remote(parsed.hostOrigin, parsed.endpointPublicKey); await remote.verify(parsed.hostServerId, auth.signal); auth.assertCurrent();
        const response = await remote.guest.acceptTaskShareJoin({ intentId: operationId, invitation, credentialSha256Hex: intent.credentialSha256Hex,
          displayName: name, homeServerId: this.options.serverId, homeDeviceId: auth.deviceId }, { signal: auth.signal });
        auth.assertCurrent(); await this.#accept(intent, response.share, response.member, secret); auth.assertCurrent();
      } catch (error) {
        intent.status = "unknown"; intent.errorCode = safeCode(error); await this.#save(); auth.assertCurrent();
      }
      return this.#intent(intent);
    }).finally(() => this.#joinInputs.delete(operationId));
  }
  async lookup(operationId: string, auth: TaskSharingHomeAuthority): Promise<contract.TaskShareJoinIntent> {
    const intent = this.#intents.get(contract.taskShareIdentity(operationId));
    if (!intent) throw new ConnectError("The join operation was not found.", Code.NotFound);
    return this.#single(`join:${operationId}`, () => intent.status === "joined" || intent.status === "failed"
      ? Promise.resolve(this.#intent(intent)) : this.#recover(intent, auth));
  }
  async refreshDirectory(auth: TaskSharingHomeAuthority): Promise<void> {
    auth.assertCurrent();
    await this.#single("directory-refresh", async () => {
      const ids = [...this.#joined.keys()], start = this.#directoryOffset % Math.max(1, ids.length);
      const pending = [...ids.slice(start), ...ids.slice(0, start)];
      const signal = AbortSignal.any([auth.signal, AbortSignal.timeout(5_000)]);
      const worker = async () => {
        for (;;) {
          if (signal.aborted) { auth.assertCurrent(); return; }
          const joinId = pending.shift(); if (joinId === undefined) return;
          const stored = this.#joined.get(joinId); if (!stored) continue;
          const before = fromJsonString(contract.JoinedTaskShareSchema, stored.value);
          if (!["active", "disconnected"].includes(before.status)) continue;
          const bounded: TaskSharingHomeAuthority = { ...auth, signal,
            assertCurrent: () => { auth.assertCurrent(); signal.throwIfAborted(); } };
          try {
            const state = await this.snapshot(joinId, bounded); auth.assertCurrent();
            if (this.#joined.get(joinId) !== stored) continue;
            stored.value = toJsonString(contract.JoinedTaskShareSchema, create(contract.JoinedTaskShareSchema,
              { ...before, share: state.share, member: state.member, status: "active", errorCode: "" }));
          } catch {
            auth.assertCurrent();
            if (this.#joined.get(joinId) !== stored) continue;
            stored.value = toJsonString(contract.JoinedTaskShareSchema, create(contract.JoinedTaskShareSchema,
              { ...before, status: "disconnected", errorCode: "UNAVAILABLE" }));
          }
        }
      };
      await Promise.all([worker(), worker(), worker()]);
      this.#directoryOffset = (start + ids.length - pending.length) % Math.max(1, ids.length);
      auth.assertCurrent(); await this.#save();
    });
    auth.assertCurrent();
  }

  async snapshot(joinId: string, auth: TaskSharingHomeAuthority): Promise<contract.TaskShareSnapshot> {
    return this.#withRemote(joinId, auth, async (remote, scope, options) => {
      const response = await remote.guest.getSharedTaskSnapshot({ scope }, options);
      if (!response.state?.share || !response.state.member || !response.state.snapshot) throw unavailable();
      contract.assertTaskShareScope(scope, response.state.share, response.state.member.memberId, response.state.member.memberGeneration);
      const snapshot = response.state.snapshot;
      if (snapshot.sessions.length !== 1 || snapshot.sessions[0]?.sessionId !== scope.sessionId) throw unavailable();
      const captured = fromJsonString(contract.JoinedTaskShareSchema, this.#joined.get(joinId)!.value);
      return create(contract.TaskShareSnapshotSchema, { ...response.state, share: { ...response.state.share, hostOrigin: captured.share!.hostOrigin } });
    });
  }
  events(joinId: string, after: contract.EventCursor | undefined, limit: number, auth: TaskSharingHomeAuthority): Promise<contract.TaskShareEventBatch> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new ConnectError("The event batch limit is invalid.", Code.InvalidArgument);
    return this.#withRemote(joinId, auth, async (remote, scope, options) => {
      const response = await remote.guest.readSharedTaskEvents({ scope, after, limit }, options);
      if (!response.batch || response.batch.events.length > limit) throw unavailable();
      if (response.batch.events.some(event => event.identity?.sessionId !== scope.sessionId)) throw unavailable();
      return response.batch;
    });
  }
  invoke(joinId: string, method: contract.TaskShareMethod, requestBytes: Uint8Array, auth: TaskSharingHomeAuthority): Promise<Uint8Array> {
    contract.decodeTaskShareRequest(method, requestBytes);
    return this.#withRemote(joinId, auth, async (remote, scope, options) => {
      let write: StoredWrite | undefined;
      if (method === contract.TaskShareMethod.SUBMIT_OPERATION) {
        const request = fromBinary(contract.SubmitOperationRequestSchema, requestBytes); contract.taskShareIdentity(request.operationId);
        const key = `${joinId}:${request.operationId}`, hash = digest(requestBytes); write = this.#writes.get(key);
        if (write && write.requestSha256Hex !== hash) throw new ConnectError("The task operation has different input.", Code.AlreadyExists);
        if (write) {
          const response = await remote.guest.invokeSharedTask({ scope, method: contract.TaskShareMethod.GET_OPERATION,
            requestBytes: toBinary(contract.GetOperationRequestSchema, create(contract.GetOperationRequestSchema, { operationId: request.operationId })) }, options);
          const receipt = fromBinary(contract.GetOperationResponseSchema, response.responseBytes);
          if (!receipt.operation || receipt.operation.operationId !== request.operationId) throw unavailable();
          return toBinary(contract.SubmitOperationResponseSchema, create(contract.SubmitOperationResponseSchema, { operation: receipt.operation }));
        }
        write = { joinId, operationId: request.operationId, requestSha256Hex: hash, status: "sent" };
        this.#writes.set(key, write); await this.#save(); auth.assertCurrent();
      }
      try {
        const result = await remote.guest.invokeSharedTask({ scope, method, requestBytes }, options);
        if (write) { write.status = "complete"; await this.#save(); }
        return result.responseBytes;
      } catch (error) { if (write) { write.status = "unknown"; await this.#save(); } throw error; }
    });
  }
  async leave(operationId: string, joinId: string, auth: TaskSharingHomeAuthority): Promise<contract.JoinedTaskShare> {
    contract.taskShareIdentity(operationId);
    const oldReceipt = this.#actions.get(operationId);
    if (oldReceipt) {
      if (oldReceipt.kind !== "task_share_leave" || oldReceipt.joined?.joinId !== joinId) throw new ConnectError("The action has different input.", Code.AlreadyExists);
      if (oldReceipt.status === "applied" && oldReceipt.joined) return oldReceipt.joined;
      throw new ConnectError("Check the original leave receipt before taking another action.", Code.FailedPrecondition);
    }
    return this.#single(`leave:${joinId}`, async () => {
      const stored = this.#joined.get(joinId); if (!stored) throw unavailable();
      const before = fromJsonString(contract.JoinedTaskShareSchema, stored.value);
      if (["revoked", "ended", "left"].includes(before.status)) {
        auth.assertCurrent();
        const next = create(contract.JoinedTaskShareSchema, { ...before, status: "left", errorCode: "" });
        this.#joined.set(joinId, { ...stored, value: toJsonString(contract.JoinedTaskShareSchema, next),
          sealed: this.options.vault.seal("{}", stored.credentialReference) });
        this.#lifetimes.get(joinId)?.abort();
        this.#actions.set(operationId, create(contract.TaskSharingActionReceiptSchema, { operationId, kind: "task_share_leave", status: "applied", joined: next }));
        await this.#save(); auth.assertCurrent(); return next;
      }
      this.#actions.set(operationId, create(contract.TaskSharingActionReceiptSchema, { operationId, kind: "task_share_leave", status: "sent", joined: before }));
      await this.#save(); auth.assertCurrent(); this.#lifetimes.get(joinId)?.abort();
      try { return await this.#withRemote(joinId, auth, async (remote, scope, options) => {
        const response = await remote.guest.leaveSharedTask({ scope, operationId }, options); auth.assertCurrent();
        if (!response.share || !response.member || response.share.shareId !== scope.shareId || response.share.sessionId !== scope.sessionId
          || response.share.hostServerId !== scope.hostServerId || response.member.memberId !== scope.memberId
          || response.member.memberGeneration < scope.memberGeneration) throw unavailable();
        return fromJsonString(contract.JoinedTaskShareSchema, this.#joined.get(joinId)!.value);
      }, true).then(async joined => {
      const next = create(contract.JoinedTaskShareSchema, { ...joined, status: "left", errorCode: "" });
      const old = this.#joined.get(joinId)!; this.#joined.set(joinId, { ...old, value: toJsonString(contract.JoinedTaskShareSchema, next),
        sealed: this.options.vault.seal("{}", old.credentialReference) });
      this.#actions.set(operationId, create(contract.TaskSharingActionReceiptSchema, { operationId, kind: "task_share_leave", status: "applied", joined: next }));
      this.#lifetimes.get(joinId)?.abort(); await this.#save(); return next;
      }); } catch (error) {
        this.#actions.set(operationId, create(contract.TaskSharingActionReceiptSchema, { operationId, kind: "task_share_leave", status: "unknown", errorCode: safeCode(error), joined: before }));
        await this.#save(); throw error;
      }
    });
  }
  async lookupAction(operationId: string, auth?: TaskSharingHomeAuthority): Promise<contract.TaskSharingActionReceipt | undefined> {
    const value = this.#actions.get(contract.taskShareIdentity(operationId));
    if (!value) return undefined;
    if (auth && value.kind === "task_share_leave" && ["unknown", "sent"].includes(value.status) && value.joined) {
      const joinId = value.joined.joinId, stored = this.#joined.get(joinId);
      if (stored) {
        const joined = fromJsonString(contract.JoinedTaskShareSchema, stored.value);
        auth.assertCurrent();
        const remote = this.#remote(joined.share!.hostOrigin, stored.endpointPublicKey);
        await remote.verify(joined.share!.hostServerId, auth.signal); auth.assertCurrent();
        const secret = this.options.vault.open(stored.sealed, stored.credentialReference);
        const response = await remote.guest.getSharedTaskLeaveReceipt({ operationId,
          scope: contract.scopeForJoinedTask(joined) }, { signal: auth.signal, headers: { authorization: `TaskShareGuest ${secret}` } });
        auth.assertCurrent();
        if (this.#joined.get(joinId) !== stored || this.#actions.get(operationId) !== value) throw unavailable();
        if (response.applied) {
          const next = create(contract.JoinedTaskShareSchema, { ...joined, status: "left", errorCode: "" });
          this.#joined.set(joinId, { ...stored, value: toJsonString(contract.JoinedTaskShareSchema, next),
            sealed: this.options.vault.seal("{}", stored.credentialReference) });
          this.#actions.set(operationId, create(contract.TaskSharingActionReceiptSchema, { operationId, kind: "task_share_leave", status: "applied", joined: next }));
          this.#lifetimes.get(joinId)?.abort(); await this.#save(); auth.assertCurrent();
        }
      }
    }
    return create(contract.TaskSharingActionReceiptSchema, this.#actions.get(operationId)!);
  }
  transfer(joinId: string, transfer: contract.TaskShareAttachmentTransfer | undefined, auth: TaskSharingHomeAuthority): Promise<contract.TaskShareAttachmentResult> {
    if (!transfer || transfer.action.case === undefined || transfer.action.case === "write" && transfer.action.value.data.byteLength > contract.TASK_SHARE_ATTACHMENT_CHUNK_BYTES
      || transfer.action.case === "read" && transfer.action.value.maximumBytes > contract.TASK_SHARE_ATTACHMENT_CHUNK_BYTES) throw new ConnectError("The shared task transfer is invalid.", Code.InvalidArgument);
    return this.#withRemote(joinId, auth, async (remote, scope, options) => {
      const response = await remote.guest.transferSharedTaskAttachment({ scope, transfer }, options);
      if (!response.result || response.result.data.byteLength > contract.TASK_SHARE_ATTACHMENT_CHUNK_BYTES) throw unavailable(); return response.result;
    });
  }
  async dispose(): Promise<void> {
    this.#closed = true; for (const lifetime of this.#lifetimes.values()) lifetime.abort(); await this.#saveFlight;
  }
  async #withRemote<T>(joinId: string, auth: TaskSharingHomeAuthority,
    work: (remote: TaskSharingHomeRemote, scope: contract.TaskShareScope, options: { signal: AbortSignal; headers: { authorization: string } }) => Promise<T>, leaving = false): Promise<T> {
    auth.assertCurrent(); const stored = this.#joined.get(contract.taskShareIdentity(joinId));
    if (!stored || this.#closed) throw unavailable();
    const joined = fromJsonString(contract.JoinedTaskShareSchema, stored.value); this.#validateJoined(joined);
    if (!["active", "disconnected"].includes(joined.status)) throw new ConnectError("The shared task access has ended.", Code.PermissionDenied);
    if (!leaving && [...this.#actions.values()].some(action => action.kind === "task_share_leave"
      && action.joined?.joinId === joinId && ["sent", "unknown"].includes(action.status))) {
      throw new ConnectError("The leave result is unknown. Check its original receipt.", Code.FailedPrecondition);
    }
    const lifetime = this.#lifetimes.get(joinId)!;
    const signal = leaving ? auth.signal : AbortSignal.any([auth.signal, lifetime.signal]);
    const current = () => { auth.assertCurrent(); signal.throwIfAborted(); if (this.#closed || this.#joined.get(joinId) !== stored) throw unavailable(); };
    const remote = this.#remote(joined.share!.hostOrigin, stored.endpointPublicKey); current(); await remote.verify(joined.share!.hostServerId, signal); current();
    const secret = this.options.vault.open(stored.sealed, stored.credentialReference);
    const scope = create(contract.TaskShareScopeSchema, contract.scopeForJoinedTask(joined));
    try {
      const result = await work(remote, scope, { signal, headers: { authorization: `TaskShareGuest ${secret}` } });
      current(); return result;
    } catch (error) {
      let revoked = !leaving && error instanceof ConnectError && error.code === Code.Unauthenticated;
      if (!leaving && error instanceof ConnectError && error.code === Code.PermissionDenied) {
        try {
          const proof = await remote.guest.getSharedTaskSnapshot({ scope }, { signal, headers: { authorization: `TaskShareGuest ${secret}` } });
          current();
          if (!proof.state?.share || !proof.state.member) throw unavailable();
          contract.assertTaskShareScope(scope, proof.state.share, proof.state.member.memberId, proof.state.member.memberGeneration);
        } catch (proofError) {
          revoked = proofError instanceof ConnectError && [Code.Unauthenticated, Code.PermissionDenied].includes(proofError.code);
        }
      }
      if (revoked) {
        const next = create(contract.JoinedTaskShareSchema, { ...joined, status: "revoked", errorCode: "ACCESS_REVOKED" });
        if (this.#joined.get(joinId) === stored) { this.#joined.set(joinId, { ...stored, value: toJsonString(contract.JoinedTaskShareSchema, next) }); lifetime.abort(); await this.#save(); }
      }
      if (error instanceof ConnectError && [Code.InvalidArgument, Code.FailedPrecondition, Code.AlreadyExists, Code.NotFound, Code.OutOfRange, Code.PermissionDenied, Code.Unauthenticated].includes(error.code)) throw new ConnectError("The shared task request could not be completed.", error.code);
      throw unavailable();
    }
  }
  async #recover(intent: StoredIntent, auth: TaskSharingHomeAuthority): Promise<contract.TaskShareJoinIntent> {
    const remote = this.#remote(intent.hostOrigin, intent.endpointPublicKey); auth.assertCurrent();
    await remote.verify(intent.hostServerId, auth.signal); auth.assertCurrent();
    const sealed = JSON.parse(this.options.vault.open(intent.sealed,
      this.#intentReference(intent.operationId, intent.joinId, intent.hostServerId, intent.shareId))) as { secret: string };
    try {
      const result = await remote.guest.getTaskShareJoinReceipt({ intentId: intent.operationId, credentialSha256Hex: intent.credentialSha256Hex },
        { signal: auth.signal, headers: { authorization: `TaskShareGuest ${sealed.secret}` } });
      auth.assertCurrent(); await this.#accept(intent, result.share, result.member, sealed.secret); auth.assertCurrent();
    } catch (error) { intent.status = "unknown"; intent.errorCode = safeCode(error); await this.#save(); auth.assertCurrent(); }
    return this.#intent(intent);
  }
  async #accept(intent: StoredIntent, share: contract.TaskShare | undefined, member: contract.TaskShareMember | undefined, secret: string): Promise<void> {
    const pinnedShare = this.#checkInvitationShare({ hostOrigin: intent.hostOrigin, hostServerId: intent.hostServerId, shareId: intent.shareId,
      endpointPublicKey: intent.endpointPublicKey, shareGeneration: BigInt(intent.shareGeneration), inviteSecret: "" }, share);
    if (!member?.memberId || member.memberGeneration < 1n || member.status !== "active") throw unavailable();
    const joined = create(contract.JoinedTaskShareSchema, { joinId: intent.joinId, share: pinnedShare, member, status: "active", joinedAtMs: BigInt((this.options.now ?? Date.now)()) });
    const reference = this.#joinedReference(joined, intent.endpointPublicKey);
    this.#joined.set(intent.joinId, { value: toJsonString(contract.JoinedTaskShareSchema, joined), endpointPublicKey: intent.endpointPublicKey, credentialReference: reference, sealed: this.options.vault.seal(secret, reference) });
    this.#lifetimes.set(intent.joinId, new AbortController()); intent.status = "joined"; intent.errorCode = "";
    intent.sealed = this.options.vault.seal("{}", this.#intentReference(intent.operationId, intent.joinId, intent.hostServerId, intent.shareId));
    await this.#save();
  }
  #intent(intent: StoredIntent): contract.TaskShareJoinIntent {
    const stored = this.#joined.get(intent.joinId);
    return create(contract.TaskShareJoinIntentSchema, { operationId: intent.operationId, status: intent.status, errorCode: intent.errorCode,
      ...(stored ? { joined: fromJsonString(contract.JoinedTaskShareSchema, stored.value) } : {}) });
  }
  #checkInvitationShare(invitation: contract.TaskShareInvitation, share: contract.TaskShare | undefined): contract.TaskShare {
    if (!share || share.shareId !== invitation.shareId || share.hostServerId !== invitation.hostServerId
      || share.shareGeneration !== invitation.shareGeneration || !share.sessionId || share.status !== "active") throw unavailable();
    contract.taskShareOrigin(share.hostOrigin);
    return create(contract.TaskShareSchema, { ...share, hostOrigin: invitation.hostOrigin });
  }
  #validateJoined(joined: contract.JoinedTaskShare): void {
    contract.taskShareIdentity(joined.joinId);
    if (!joined.share || !joined.member || joined.share.shareGeneration < 1n || joined.member.memberGeneration < 1n) throw unavailable();
    contract.taskShareOrigin(joined.share.hostOrigin); contract.taskShareIdentity(joined.share.hostServerId); contract.taskShareIdentity(joined.share.shareId);
  }
  #remote(origin: string, endpointPublicKey: string): TaskSharingHomeRemote {
    return (this.options.connect ?? createTaskSharingHomeRemote)(contract.taskShareOrigin(origin), contract.taskShareEndpointPublicKey(endpointPublicKey));
  }
  #intentReference(operationId: string, joinId: string, serverId: string, shareId: string, origin?: string, endpointPublicKey?: string): string {
    const intent = this.#intents.get(operationId), pinnedOrigin = contract.taskShareOrigin(origin ?? intent?.hostOrigin ?? ""), pin = contract.taskShareEndpointPublicKey(endpointPublicKey ?? intent?.endpointPublicKey ?? "");
    return `task-sharing-intent:${this.options.serverId}:${operationId}:${joinId}:${serverId}:${shareId}:${pinnedOrigin}:${pin}`;
  }
  #joinedReference(joined: contract.JoinedTaskShare, endpointPublicKey: string): string {
    const share = joined.share!, member = joined.member!;
    return `task-sharing-guest:${this.options.serverId}:${joined.joinId}:${share.hostServerId}:${share.shareId}:${share.shareGeneration}:${share.sessionId}:${member.memberId}:${member.memberGeneration}:${share.hostOrigin}:${contract.taskShareEndpointPublicKey(endpointPublicKey)}`;
  }
  #single<T>(key: string, work: () => Promise<T>): Promise<T> {
    const old = this.#flights.get(key); if (old) return old as Promise<T>;
    const pending = work().finally(() => { if (this.#flights.get(key) === pending) this.#flights.delete(key); }); this.#flights.set(key, pending); return pending;
  }
  #save(): Promise<void> {
    const snapshot: HomeDisk = { format: 1, serverId: this.options.serverId, intents: [...this.#intents.values()].map(value => ({ ...value })),
      joined: [...this.#joined.values()].map(value => ({ ...value })), writes: [...this.#writes.values()].map(value => ({ ...value })),
      actions: [...this.#actions.values()].map(value => toJsonString(contract.TaskSharingActionReceiptSchema, value)) };
    const save = this.#saveFlight.then(async () => {
      const temporary = join(this.options.directory, `.home-${randomUUID()}.tmp`), destination = join(this.options.directory, "home.json");
      try {
        const file = await open(temporary, "wx", 0o600);
        try { await file.writeFile(JSON.stringify(snapshot)); await file.sync(); } finally { await file.close(); }
        await rename(temporary, destination);
      } finally { await unlink(temporary).catch(() => undefined); }
    });
    this.#saveFlight = save.catch(() => undefined); return save;
  }
}
/** Node HTTP transport does not follow redirects; identity is read without auth. */
export function createTaskSharingHomeRemote(origin: string, endpointPublicKey: string): TaskSharingHomeRemote {
  const transport = createConnectTransport({ baseUrl: contract.taskShareOrigin(origin), endpointPublicKey: contract.taskShareEndpointPublicKey(endpointPublicKey), httpVersion: "1.1", useBinaryFormat: true,
    readMaxBytes: 16 * 1024 * 1024, writeMaxBytes: 4 * 1024 * 1024, defaultTimeoutMs: 15_000 });
  const identity = createClient(contract.ConnectionService, transport);
  return { guest: createClient(contract.TaskSharingGuestService, transport), verify: async (serverId, signal) => {
    const response = await identity.getServerInfo({}, { signal });
    if (response.server?.serverId !== serverId) throw new ConnectError("The shared task server identity changed.", Code.PermissionDenied);
  } };
}
function digest(value: string | Uint8Array): string { return createHash("sha256").update(value).digest("hex"); }
function safeCode(error: unknown): string { return error instanceof ConnectError ? Code[error.code].toUpperCase() : "UNAVAILABLE"; }
function unavailable(): ConnectError { return new ConnectError("The shared task is temporarily unavailable. Check the original receipt before retrying.", Code.Unavailable); }
function isMissing(error: unknown): boolean { return error instanceof Error && "code" in error && error.code === "ENOENT"; }
