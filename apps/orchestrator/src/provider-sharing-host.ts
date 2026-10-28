import { createHash, randomBytes, randomInt, randomUUID } from "node:crypto";
import { create, toBinary } from "@bufbuild/protobuf";
import { Code, ConnectError, type HandlerContext } from "@connectrpc/connect";
import * as contract from "@joko/contracts";
import { ProviderSharingStore, ProviderSharingStoreError, type OperationalStore, type ProviderSharingProof, type ProviderSharingPerson,
  type ProviderSharingShareRecord, type ProviderSharingMemberRecord, type ProviderSharingRequestRecord, type ProviderSharingReshareRecord } from "@joko/store";
import type { HostedAgentPrincipal } from "./hosted-agent-host.js";
import type { HostedAgentRuntime } from "./hosted-agent-runtime.js";
import type { ProviderSharingRecipient } from "./provider-sharing-ports.js";

export const PROVIDER_SHARING_SOURCE_DEVICE_HEADER = "x-joko-provider-source-device";
export const PROVIDER_SHARING_RECIPIENT_HEADER = "x-joko-provider-reshare-key";
interface Batch { readonly id: string; readonly count: number; readonly chunks: Map<number, readonly { key: string; person: ProviderSharingPerson }[]>; touchedAt: number; bytes: number; }
export class ProviderSharingHost {
  readonly records: ProviderSharingStore;
  readonly #issued = new Map<string, { link: string; linkId: string; expiresAt: number; shareId: string }>();
  readonly #batches = new Map<string, Batch>();
  readonly #completed = new Map<string, { id: string; count: number; digests: readonly string[]; touchedAt: number }>();
  readonly #listeners = new Set<() => void>();
  #closed = false;
  constructor(readonly options: { readonly store: OperationalStore; readonly serverId: string; readonly origin: string | (() => string); readonly endpointPublicKey: string;
    readonly native: HostedAgentRuntime; readonly now?: () => number; readonly closeNative?: (credentialDigest: string, runId: string) => Promise<void>;
    readonly readQuota?: (backendId: string, providerId: string, signal: AbortSignal) => Promise<readonly contract.ProviderSharingQuotaAccount[]>;
    readonly readGroupUsage?: (backendId: string, providerId: string, memberId: string, fromDay: string) => readonly import("@joko/store").ProviderGroupUsageRow[] }) {
    this.records = new ProviderSharingStore(options.store, options.now);
  }
  subscribe(listener: () => void): () => void { this.#listeners.add(listener); return () => this.#listeners.delete(listener); }
  list(): readonly contract.ProviderSharingOwned[] { this.#assertOpen(); this.records.expire(); return this.records.list().map(row => this.owned(row)); }
  issue(input: contract.CreateProviderShareLinkRequest): contract.CreateProviderShareLinkResponse {
    this.#assertOpen(); this.options.native.shareableProvider(input.backendId, input.providerId).assertCurrent();
    for (const [key, value] of this.#issued) if (value.expiresAt <= this.now()) this.#issued.delete(key);
    const person = fromPerson(input.owner), body = { backendId: input.backendId, providerId: input.providerId, providerName: label(input.providerName), owner: person };
    const previous = this.options.store.findOperation(input.operationId);
    if (previous && !this.#issued.has(input.operationId)) throw new ConnectError("The private link reply expired. Generate a new link explicitly.", Code.FailedPrecondition);
    const result = this.options.store.runOperation({ id: id(input.operationId), kind: "provider_share_link", body }, () => {
      const secret = randomBytes(32).toString("base64url"), digest = hash(secret);
      const { share, link } = this.records.issue({ shareId: `provider-share-${randomUUID()}`, ...body, linkDigest: digest });
      this.#issued.set(input.operationId, { link: contract.buildProviderSharingLink(this.origin(), secret, this.options.endpointPublicKey), linkId: digest, expiresAt: link.expiresAt, shareId: share.id }); return share.id;
    });
    const issued = this.#issued.get(input.operationId);
    if (!issued || issued.expiresAt <= this.now()) { this.#issued.delete(input.operationId); throw new ConnectError("The private link reply expired. Generate a new link explicitly.", Code.FailedPrecondition); }
    this.#changed(); return create(contract.CreateProviderShareLinkResponseSchema, { link: issued.link, linkId: issued.linkId, expiresAtMs: BigInt(issued.expiresAt), share: this.owned(this.records.get(result.value)) });
  }
  inspect(secret: string): contract.ProviderSharingPreview {
    this.#assertOpen(); invitation(secret); this.records.expire(); const link = this.records.link(hash(secret)), share = this.records.get(link.shareId);
    return this.preview(share, link.state === "unused" ? "unused" : link.state === "expired" ? "expired" : "used", link.expiresAt);
  }
  submit(input: contract.SubmitProviderShareRequestRequest): Pick<contract.SubmitProviderShareRequestResponse, "request" | "member" | "preview"> {
    this.#assertOpen(); invitation(input.invitation);
    const result = this.records.apply({ id: id(input.requestId), linkDigest: hash(input.invitation), homeServerId: id(input.homeServerId), deviceId: id(input.deviceId),
      person: fromPerson(input.person), requestDigest: digest(input.requestSha256Hex), credentialDigest: digest(input.credentialSha256Hex),
      pairingCode: String(randomInt(0, 10_000)).padStart(4, "0") }, this.options.serverId);
    this.#changed(); return this.requestResponse(result);
  }
  request(requestId: string, authorization: string | undefined): Pick<contract.GetProviderShareRequestResponse, "request" | "member" | "preview"> {
    this.#assertOpen(); this.records.expire(); const request = this.records.request(id(requestId));
    if (request.requestDigest !== requestCredential(authorization)) throw denied(); return this.requestResponse(request);
  }
  withdraw(operationId: string, requestId: string, authorization: string | undefined): Pick<contract.WithdrawProviderShareRequestResponse, "request" | "member" | "preview"> {
    this.#assertOpen();
    const credentialDigest = requestCredential(authorization);
    this.options.store.runOperation({ id: id(operationId), kind: "provider_share_withdraw", body: { requestId: id(requestId), credentialDigest } }, () => {
      this.records.withdraw(requestId, credentialDigest); return requestId;
    });
    this.#changed(); return this.request(requestId, authorization);
  }
  decide(input: contract.DecideProviderShareRequestRequest): contract.ProviderSharingOwned {
    this.#assertOpen(); const result = this.options.store.runOperation({ id: id(input.operationId), kind: "provider_share_decide", body: { requestId: id(input.requestId), approve: input.approve } }, () =>
      this.records.decide(input.requestId, input.approve ? "approve" : "reject", `member-${randomUUID()}`).shareId);
    this.#changed(); return this.owned(this.records.get(result.value));
  }
  member(input: contract.SetProviderShareMemberRequest): contract.ProviderSharingOwned {
    this.#assertOpen(); const generation = integer(input.generation);
    if (!["pause", "resume", "remove"].includes(input.action)) throw invalid();
    const result = this.options.store.runOperation({ id: id(input.operationId), kind: "provider_share_member", body: { shareId: id(input.shareId), memberId: id(input.memberId), generation, action: input.action } }, () =>
      this.records.setMember(input.shareId, input.memberId, generation, input.action === "pause" ? "paused" : input.action === "resume" ? "active" : "removed").id);
    this.#changed(); return this.owned(this.records.get(result.value));
  }
  setModelAccess(input: contract.SetProviderShareModelAccessRequest): contract.ProviderSharingOwned {
    this.#assertOpen(); if (!input.access) throw invalid();
    const modelIds = contract.readRemoteModelAccess(input.access);
    const body = { shareId: id(input.shareId), memberId: id(input.memberId), revision: integer(input.expectedRevision),
      generation: integer(input.memberGeneration), modelIds: modelIds ?? null };
    const result = this.options.store.runOperation({ id: id(input.operationId), kind: "provider_share_model_access", body }, () =>
      this.records.setModelAccess(body.shareId, body.memberId, body.revision, body.generation, modelIds).id);
    this.#changed(); return this.owned(this.records.get(result.value));
  }
  setVisibility(input: contract.SetProviderShareVisibilityRequest): contract.ProviderSharingOwned {
    this.#assertOpen(); if (!input.visibility) throw invalid();
    const body = { shareId: id(input.shareId), revision: integer(input.expectedRevision), quota: input.visibility.quota, usage: input.visibility.usage };
    const result = this.options.store.runOperation({ id: id(input.operationId), kind: "provider_share_visibility", body }, () =>
      this.records.setVisibility(body.shareId, body.revision, body).id);
    this.#changed(); return this.owned(this.records.get(result.value));
  }
  decideReshare(input: contract.DecideProviderReshareRequest): contract.ProviderSharingOwned {
    this.#assertOpen();
    const result = this.options.store.runOperation({ id: id(input.operationId), kind: "provider_reshare_decide", body: { id: id(input.id), approve: input.approve } }, () =>
      this.records.decideReshare(input.id, input.approve ? "approved" : "rejected").shareId);
    this.#changed(); return this.owned(this.records.get(result.value));
  }
  read(shareId: string, authorization: string | undefined): Pick<contract.ReadProviderShareResponse, "share" | "member" | "catalog"> {
    this.#assertOpen(); const { share, member } = this.records.lookupCredential(guestCredential(authorization), true);
    if (share.id !== shareId) throw denied();
    let catalog: contract.GetHostedAgentCatalogResponse | undefined;
    if (member.status === "active") { try { const provider = this.options.native.shareableProvider(share.backendId, share.providerId);
      catalog = create(contract.GetHostedAgentCatalogResponseSchema, { format: 1, remoteControlEnabled: true,
        backends: [{ ...provider.catalog, providers: provider.catalog.providers.map(item => ({ ...item,
          manageableModels: [], models: item.models.filter(model => member.modelIds === undefined || member.modelIds.includes(model.key?.modelId ?? "")) })) }] });
    } catch {} }
    return { share: this.preview(share, member.status === "paused" ? "paused" : catalog ? "active" : "unavailable"), member: publicMember(member), catalog };
  }
  async readInsights(input: contract.ReadProviderShareInsightsRequest, authorization: string | undefined, signal: AbortSignal): Promise<contract.ProviderSharingInsights> {
    this.#assertOpen(); signal.throwIfAborted();
    const credentialDigest = guestCredential(authorization), { share, member } = this.records.lookupCredential(credentialDigest);
    if (share.id !== input.shareId) throw denied();
    const proof = { shareId: share.id, memberId: member.id, generation: member.generation, credentialDigest };
    const assertProvider = this.options.native.settings.captureProvider(share.backendId, share.providerId), assertComputer = this.options.native.settings.captureComputer();
    const assertCurrent = () => { this.#assertOpen(); signal.throwIfAborted(); assertComputer(); assertProvider(); this.records.authorize(proof);
      if (this.records.get(share.id).revision !== share.revision) throw denied(); };
    assertCurrent(); const visibility = share.visibility ?? { quota: false, usage: false };
    const value = create(contract.ProviderSharingInsightsSchema, { visibility,
      quotaStatus: visibility.quota ? "unavailable" : "disabled", usageStatus: visibility.usage ? input.includeUsage ? "unavailable" : "not_requested" : "disabled" });
    if (visibility.quota && this.options.readQuota) {
      try { value.accounts = [...await this.options.readQuota(share.backendId, share.providerId, signal)];
        value.quotaStatus = value.accounts.length ? "ready" : "unavailable"; value.quotaPartial = value.accounts.some(account => !["ready", "unlimited"].includes(account.state));
      } catch { value.quotaStatus = "unavailable"; }
    }
    assertCurrent();
    if (visibility.usage && input.includeUsage) {
      const fromDay = new Date(this.now() - 30 * 24 * 60 * 60_000).toISOString().slice(0, 10);
      const rows = [...this.options.native.sharingUsage(share.backendId, share.providerId, member.id, fromDay),
        ...(this.options.readGroupUsage?.(share.backendId, share.providerId, member.id, fromDay) ?? [])];
      const merged = new Map<string, contract.ProviderSharingUsageDay>();
      for (const row of rows) {
        const key = JSON.stringify([row.day, row.modelId, row.currencyCode]);
        const day = merged.get(key) ?? create(contract.ProviderSharingUsageDaySchema, { day: row.day, modelId: row.modelId, currencyCode: row.currencyCode, tokensComplete: true, costComplete: true });
        for (const key of ["turns", "inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "costMicros"] as const) day[key] += BigInt(row[key]);
        day.estimated ||= row.estimated; day.tokensComplete &&= row.tokensComplete; day.costComplete &&= row.costComplete; merged.set(key, day);
      }
      const days = [...merged.values()].sort((a, b) => b.day.localeCompare(a.day));
      value.days = days.slice(0, 5000); value.usagePartial = days.length > value.days.length;
      value.coverageStart = value.usagePartial ? value.days.at(-1)?.day ?? "" : fromDay; value.usageStatus = "ready";
    }
    if (toBinary(contract.ProviderSharingInsightsSchema, { ...value, days: [] }).byteLength > contract.PROVIDER_SHARING_INSIGHTS_MAX_BYTES) { value.accounts = []; value.quotaStatus = "unavailable"; value.quotaPartial = true; }
    while (value.days.length && toBinary(contract.ProviderSharingInsightsSchema, value).byteLength > contract.PROVIDER_SHARING_INSIGHTS_MAX_BYTES) {
      value.days.pop(); value.usagePartial = true; value.coverageStart = value.days.at(-1)?.day ?? "";
    }
    assertCurrent(); return contract.projectProviderSharingInsights(value);
  }
  leave(operationId: string, shareId: string, authorization: string | undefined): Pick<contract.LeaveProviderShareResponse, "share" | "member" | "catalog"> {
    this.#assertOpen();
    const credentialDigest = guestCredential(authorization), previous = this.options.store.findOperation(operationId);
    if (previous) return this.leaveReceipt(operationId, shareId, authorization);
    const { share, member } = this.records.lookupCredential(credentialDigest, true); if (share.id !== shareId) throw denied();
    const result = this.options.store.runOperation({ id: id(operationId), kind: "provider_share_leave", body: { shareId, credentialDigest } }, () => {
      const next = this.records.setMember(share.id, member.id, member.generation, "left");
      return { shareId: next.id, memberId: member.id };
    });
    const next = this.records.get(result.value.shareId), gone = next.members.find(row => row.id === result.value.memberId)!;
    this.#changed(); return { share: this.preview(next, "left"), member: publicMember(gone), catalog: undefined };
  }
  leaveReceipt(operationId: string, shareId: string, authorization: string | undefined): Pick<contract.GetProviderShareLeaveReceiptResponse, "share" | "member" | "catalog"> {
    const credentialDigest = guestCredential(authorization), operation = this.options.store.findOperation(id(operationId));
    if (!operation || operation.kind !== "provider_share_leave") throw new ConnectError("The original leave has no receipt.", Code.NotFound);
    // runOperation performs exact body-hash comparison before adopting its reply.
    const result = this.options.store.runOperation<{ shareId: string; memberId: string }>({ id: operationId, kind: "provider_share_leave", body: { shareId, credentialDigest } }, () => { throw denied(); });
    const share = this.records.get(result.value.shareId), member = share.members.find(row => row.id === result.value.memberId);
    if (!member || member.credentialDigest !== credentialDigest || member.status !== "left") throw denied();
    return { share: this.preview(share, "left"), member: publicMember(member), catalog: undefined };
  }
  authenticateNative(context: HandlerContext): HostedAgentPrincipal {
    try { return this.#authenticateNative(context); } catch (error) { return providerSharingPublicError(error); }
  }
  #authenticateNative(context: HandlerContext): HostedAgentPrincipal {
    this.#assertOpen(); const credentialDigest = guestCredential(context.requestHeader.get("authorization") ?? undefined), current = this.records.lookupCredential(credentialDigest);
    const deviceId = id(context.requestHeader.get(PROVIDER_SHARING_SOURCE_DEVICE_HEADER) ?? ""), proof: ProviderSharingProof = {
      shareId: current.share.id, memberId: current.member.id, generation: current.member.generation, credentialDigest };
    this.records.registerDevice(proof, deviceId);
    const key = context.requestHeader.get(PROVIDER_SHARING_RECIPIENT_HEADER), provider = this.options.native.shareableProvider(current.share.backendId, current.share.providerId);
    const assertCurrent = () => { this.#assertOpen(); const { member } = this.records.authorize(proof); if (!member.devices.includes(deviceId)) throw denied();
      provider.assertCurrent(); if (key !== null) this.records.assertReshare(proof, deviceId, opaque(key)); };
    assertCurrent();
    return { id: `provider-guest-${hash(JSON.stringify([this.options.serverId, proof.shareId, proof.memberId, deviceId, key])).slice(0, 48)}`,
      deviceId: `source-${hash(JSON.stringify([current.member.homeServerId, deviceId])).slice(0, 40)}`, trust: "guest", assertCurrent,
      providerGrant: { backendId: current.share.backendId, providerId: current.share.providerId,
        modelIds: provider.models.filter(model => current.member.modelIds === undefined || current.member.modelIds.includes(model.modelId)).map(model => model.modelId), cleanupKey: credentialDigest, assertCurrent,
        ...(key === null ? {} : { groupMember: true as const }),
        cleanupOwner: { shareId: current.share.id, memberId: current.member.id, incarnation: current.member.incarnation, cleanupKey: credentialDigest },
        purgeRequested: () => this.isRemoved({ shareId: current.share.id, memberId: current.member.id, incarnation: current.member.incarnation, cleanupKey: credentialDigest }),
        recipient: { shareId: current.share.id, memberId: current.member.id, generation: current.member.generation,
          name: current.member.person.name, avatarUrl: current.member.person.avatarUrl } } };
  }
  sync(input: contract.SyncProviderResharesRequest, context: HandlerContext): contract.SyncProviderResharesResponse {
    this.#assertOpen(); const credentialDigest = guestCredential(context.requestHeader.get("authorization") ?? undefined), { share, member } = this.records.lookupCredential(credentialDigest);
    const deviceId = id(context.requestHeader.get(PROVIDER_SHARING_SOURCE_DEVICE_HEADER) ?? ""), proof = { shareId: share.id, memberId: member.id, generation: member.generation, credentialDigest };
    this.records.registerDevice(proof, deviceId);
    if (input.entries.length > 256) throw invalid(); const entries = input.entries.map(entry => ({ key: opaque(entry.key), person: fromPerson(entry.person) }));
    if (new Set(entries.map(entry => entry.key)).size !== entries.length) throw invalid();
    const scope = JSON.stringify([share.id, member.id, member.incarnation, deviceId]); const batch = input.batch; let complete = true;
    let all = entries; let completed: { id: string; count: number; digests: readonly string[]; touchedAt: number } | undefined;
    if (batch) {
      opaque(batch.id); if (!Number.isSafeInteger(batch.count) || batch.count < 1 || !Number.isSafeInteger(batch.index) || batch.index < 0 || batch.index >= batch.count) throw invalid();
      this.#pruneBatches(); const done = this.#completed.get(scope);
      if (done?.id === batch.id) {
        if (done.count !== batch.count || done.digests[batch.index] !== hash(JSON.stringify(entries))) throw invalid();
        return this.reshareResponse(proof, deviceId, entries, batch, true);
      }
      let pending = this.#batches.get(scope);
      if (!pending || pending.id !== batch.id) { pending = { id: batch.id, count: batch.count, chunks: new Map(), touchedAt: this.now(), bytes: 512 }; this.#batches.set(scope, pending); }
      if (pending.count !== batch.count) throw invalid(); const previous = pending.chunks.get(batch.index);
      if (previous && JSON.stringify(previous) !== JSON.stringify(entries)) throw invalid();
      if (!previous) { pending.chunks.set(batch.index, entries); pending.bytes += Buffer.byteLength(JSON.stringify(entries)) + 128; }
      pending.touchedAt = this.now();
      if ([...this.#batches.values()].reduce((sum, row) => sum + row.bytes, 0) > 16 * 1024 * 1024) { this.#batches.delete(scope); throw new ConnectError("The reshare batch is too large.", Code.ResourceExhausted); }
      complete = pending.chunks.size === pending.count;
      if (complete) { all = Array.from({ length: pending.count }, (_, index) => pending!.chunks.get(index)!).flat();
        if (new Set(all.map(entry => entry.key)).size !== all.length) { this.#batches.delete(scope); throw invalid(); }
        completed = { id: pending.id, count: pending.count, touchedAt: this.now(), digests: Array.from({ length: pending.count }, (_, index) => hash(JSON.stringify(pending!.chunks.get(index)))) }; }
    }
    if (complete) { this.records.syncReshares(proof, deviceId, all); if (completed) { this.#completed.set(scope, completed); this.#batches.delete(scope); } this.#changed(); }
    return this.reshareResponse(proof, deviceId, entries, batch, complete);
  }
  ownedRecipients(backendId: string, providerId: string): readonly ProviderSharingRecipient[] {
    return this.records.list().filter(row => row.backendId === backendId && row.providerId === providerId).flatMap(share => share.members.filter(member => ["active", "paused"].includes(member.status))
      .map(member => ({ shareId: share.id, memberId: member.id, generation: member.generation, name: member.person.name, avatarUrl: member.person.avatarUrl })));
  }
  closeRun(runId: string, authorization: string | undefined): Promise<void> {
    const credentialDigest = guestCredential(authorization); id(runId);
    return (this.options.closeNative ?? ((digest, run) => this.options.native.endpoint.closeProviderGrant(digest, run)))(credentialDigest, runId);
  }
  async reconcile(): Promise<void> {
    this.#assertOpen(); this.records.expire(); this.#pruneBatches();
    await this.options.native.endpoint.sweep();
    await this.options.native.purgeClosedProviderSessions(owner => this.isRemoved(owner));
  }
  private isRemoved(owner: { readonly shareId: string; readonly memberId: string; readonly incarnation: number; readonly cleanupKey: string }): boolean {
    const share = this.records.list().find(row => row.id === owner.shareId), member = share?.members.find(row => row.id === owner.memberId);
    return !member || member.incarnation !== owner.incarnation || member.credentialDigest !== owner.cleanupKey || ["removed", "left"].includes(member.status);
  }
  close(): void { this.#closed = true; this.#listeners.clear(); this.#batches.clear(); this.#completed.clear(); this.#issued.clear(); }
  owned(share: ProviderSharingShareRecord): contract.ProviderSharingOwned {
    return create(contract.ProviderSharingOwnedSchema, { shareId: share.id, generation: BigInt(share.generation), backendId: share.backendId, providerId: share.providerId,
      providerName: share.providerName, owner: toPerson(share.owner), revision: BigInt(share.revision), members: share.members.filter(member => ["active", "paused"].includes(member.status)).map(publicMember),
      requests: this.records.requests(share.id).filter(row => row.status === "pending").map(publicRequest),
      reshares: this.records.reshares().filter(row => row.shareId === share.id).map(publicReshare),
      providerModelAccess: contract.toRemoteModelAccess(this.options.native.settings.modelIds(share.backendId, share.providerId)),
      availableModels: [...this.options.native.availableRemoteModels(share.backendId, share.providerId)],
      visibility: share.visibility ?? { quota: false, usage: false } });
  }
  preview(share: ProviderSharingShareRecord, state: string, expiresAt = 0): contract.ProviderSharingPreview {
    return create(contract.ProviderSharingPreviewSchema, { hostOrigin: this.origin(), hostServerId: this.options.serverId, shareId: share.id,
      backendId: share.backendId, providerId: share.providerId, providerName: share.providerName, owner: toPerson(share.owner), state, expiresAtMs: BigInt(expiresAt),
      visibility: share.visibility ?? { quota: false, usage: false }, accessRevision: BigInt(share.revision) });
  }
  private requestResponse(request: ProviderSharingRequestRecord): Pick<contract.SubmitProviderShareRequestResponse, "request" | "member" | "preview"> {
    const share = this.records.get(request.shareId), member = request.memberId ? share.members.find(row => row.id === request.memberId) : undefined;
    return { request: publicRequest(request), preview: this.preview(share, request.status, request.expiresAt), member: member ? publicMember(member) : undefined };
  }
  private reshareResponse(proof: ProviderSharingProof, deviceId: string, entries: readonly { key: string }[], batch: contract.ProviderSharingReshareBatch | undefined, complete: boolean) {
    const { member } = this.records.authorize(proof), records = this.records.reshares().filter(row => row.shareId === proof.shareId && row.memberId === proof.memberId && row.incarnation === member.incarnation && row.deviceId === deviceId);
    return create(contract.SyncProviderResharesResponseSchema, { entries: entries.map(entry => ({ key: entry.key, state: records.find(row => row.key === entry.key)?.state ?? "pending" })), ...(batch ? { batch } : {}), complete });
  }
  #pruneBatches(): void {
    for (const map of [this.#batches, this.#completed]) for (const [key, value] of map) if (value.touchedAt < this.now() - 10 * 60_000) map.delete(key);
    for (const [key, value] of this.#issued) if (value.expiresAt <= this.now()) this.#issued.delete(key);
  }
  #assertOpen(): void { if (this.#closed) throw new ConnectError("Provider sharing is closed.", Code.Unavailable); }
  #changed(): void { for (const listener of this.#listeners) listener(); void this.reconcile().catch(() => {}); }
  private now(): number { return (this.options.now ?? Date.now)(); }
  private origin(): string { return contract.taskShareOrigin(typeof this.options.origin === "string" ? this.options.origin : this.options.origin()); }
}
export function providerSharingPublicError(error: unknown): never {
  if (error instanceof ProviderSharingStoreError) throw new ConnectError(`Provider sharing: ${error.code}.`, error.code === "EXPIRED" ? Code.DeadlineExceeded
    : ["LINK_USED", "ALREADY_MEMBER", "SELF", "STALE"].includes(error.code) ? Code.FailedPrecondition : error.code === "NOT_FOUND" ? Code.NotFound : error.code === "INVALID" ? Code.InvalidArgument : Code.PermissionDenied);
  if (error instanceof ConnectError) throw new ConnectError("Provider sharing could not complete the request.", error.code);
  throw new ConnectError("Provider sharing could not complete the request.", Code.Unavailable);
}
export function fromPerson(value: contract.ProviderSharingPerson | undefined): ProviderSharingPerson { if (!value) throw invalid(); return { name: label(value.name), avatarUrl: value.avatarUrl ?? null }; }
function toPerson(value: ProviderSharingPerson) { return create(contract.ProviderSharingPersonSchema, { name: value.name, ...(value.avatarUrl ? { avatarUrl: value.avatarUrl } : {}) }); }
function publicMember(row: ProviderSharingMemberRecord) { return create(contract.ProviderSharingMemberSchema, { memberId: row.id, generation: BigInt(row.generation), person: toPerson(row.person), status: row.status, joinedAtMs: BigInt(row.joinedAt), homeServerId: row.homeServerId,
  modelAccess: contract.toRemoteModelAccess(row.modelIds) }); }
function publicRequest(row: ProviderSharingRequestRecord) { return create(contract.ProviderSharingRequestSchema, { requestId: row.id, shareId: row.shareId, linkId: row.linkDigest,
  person: toPerson(row.person), pairingCode: row.pairingCode, status: row.status, createdAtMs: BigInt(row.createdAt), expiresAtMs: BigInt(row.expiresAt), ...(row.memberId ? { memberId: row.memberId } : {}) }); }
function publicReshare(row: ProviderSharingReshareRecord) { return create(contract.ProviderSharingReshareSchema, { id: row.id, shareId: row.shareId, memberId: row.memberId, deviceId: row.deviceId,
  key: row.key, person: toPerson(row.person), state: row.state, requestedAtMs: BigInt(row.requestedAt), ...(row.decidedAt === undefined ? {} : { decidedAtMs: BigInt(row.decidedAt) }) }); }
function invitation(value: string): void { if (!/^[A-Za-z0-9_-]{43}$/u.test(value)) throw invalid(); }
function requestCredential(value: string | undefined): string { const secret = /^ProviderShareRequest ([A-Za-z0-9_-]{43})$/u.exec(value ?? "")?.[1]; if (!secret) throw denied(); return hash(secret); }
function guestCredential(value: string | undefined): string { const secret = /^ProviderShareGuest ([A-Za-z0-9_-]{43})$/u.exec(value ?? "")?.[1]; if (!secret) throw denied(); return hash(secret); }
function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function digest(value: string): string { if (!/^[a-f0-9]{64}$/u.test(value)) throw invalid(); return value; }
function id(value: string): string { if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/u.test(value)) throw invalid(); return value; }
function opaque(value: string): string { if (!/^[A-Za-z0-9_-]{16,64}$/u.test(value)) throw invalid(); return value; }
function integer(value: bigint): number { const number = Number(value); if (!Number.isSafeInteger(number) || number < 1) throw invalid(); return number; }
function label(value: string): string { if (!value || value !== value.trim() || value.length > 200 || /[\0-\x1f\x7f]/u.test(value)) throw invalid(); return value; }
function denied(): ConnectError { return new ConnectError("The Provider grant is unavailable or changed.", Code.PermissionDenied); }
function invalid(): ConnectError { return new ConnectError("The Provider sharing request is invalid.", Code.InvalidArgument); }
