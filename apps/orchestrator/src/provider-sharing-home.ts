import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { create, fromJsonString, toJsonString } from "@bufbuild/protobuf";
import { Code, ConnectError, createClient, type Client, type Interceptor } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import * as contract from "@joko/contracts";
import type { ProviderModel } from "@joko/core";
import type { CredentialVault, EncryptedCredential } from "./credential-vault.js";
import { HostedAgentConnectClient } from "./hosted-agent-connect-client.js";
import { PROVIDER_SHARING_RECIPIENT_HEADER, PROVIDER_SHARING_SOURCE_DEVICE_HEADER } from "./provider-sharing-host.js";
import { providerSharingBackendId, providerSharingReshareKey, type ProviderSharingDirectoryPort, type ProviderSharingReceivedIdentity,
  type ProviderSharingReceivedEntry, type ProviderSharingRecipient } from "./provider-sharing-ports.js";

export interface ProviderSharingHomeAuthority { readonly deviceId: string; readonly signal: AbortSignal; assertCurrent(): void; }
export interface ProviderSharingRemote {
  readonly guest: Client<typeof contract.ProviderSharingGuestService>; readonly native: Client<typeof contract.HostedAgentService>;
  verify(expected: string | undefined, signal: AbortSignal): Promise<string>;
}
export interface ProviderSharingRemoteOptions {
  readonly origin: string; readonly serverId?: string; readonly authorization?: () => string; readonly sourceDeviceId?: string;
  readonly recipientKey?: string; readonly assertCurrent: () => void;
}
interface StoredIntent {
  readonly id: string; readonly joinId: string; readonly requestId: string; readonly bodyHash: string; readonly deviceId: string;
  readonly preview: string; readonly person: { readonly name: string; readonly avatarUrl?: string };
  readonly requestCredential: EncryptedCredential; memberCredential?: EncryptedCredential;
  request?: string; status: string; errorCode: string;
}
interface StoredJoin { value: string; credential?: EncryptedCredential; }
interface HomeDisk { readonly format: 1; readonly serverId: string; readonly intents: readonly StoredIntent[]; readonly joined: readonly [string, StoredJoin][];
  readonly actions: readonly { readonly id: string; readonly kind: string; readonly bodyHash: string; readonly joinId: string; readonly status: string }[]; }
export class ProviderSharingHome implements ProviderSharingDirectoryPort {
  readonly localSourceDeviceId: string;
  readonly #intents = new Map<string, StoredIntent>(); readonly #joins = new Map<string, StoredJoin>();
  readonly #actions = new Map<string, HomeDisk["actions"][number]>(); readonly #listeners = new Set<() => void>();
  readonly #flights = new Map<string, Promise<unknown>>(); readonly #reshareStates = new Map<string, ReadonlyMap<string, string>>();
  #saveFlight = Promise.resolve(); #closed = false;
  constructor(readonly options: { readonly directory: string; readonly serverId: string; readonly vault: CredentialVault;
    readonly connect?: (options: ProviderSharingRemoteOptions) => ProviderSharingRemote }) { this.localSourceDeviceId = options.serverId; }
  async initialize(): Promise<void> {
    await mkdir(this.options.directory, { recursive: true, mode: 0o700 }); let text: string;
    try { text = await readFile(join(this.options.directory, "home.json"), "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    if (Buffer.byteLength(text) > 16 * 1024 * 1024) throw invalid(); const value = JSON.parse(text) as HomeDisk;
    if (!value || value.format !== 1 || value.serverId !== this.options.serverId || !Array.isArray(value.intents) || !Array.isArray(value.joined) || !Array.isArray(value.actions)) throw invalid();
    for (const intent of value.intents) { id(intent.id); id(intent.joinId); id(intent.requestId); if (!/^[a-f0-9]{64}$/u.test(intent.bodyHash) || this.#intents.has(intent.id)) throw invalid();
      this.checkPreview(fromJsonString(contract.ProviderSharingPreviewSchema, intent.preview));
      this.#intents.set(intent.id, { ...intent, status: ["prepared", "sent"].includes(intent.status) ? "unknown" : intent.status }); }
    for (const [joinId, stored] of value.joined) { const received = this.parseReceived(stored.value); if (received.joinId !== joinId || this.#joins.has(joinId)) throw invalid();
      if (received.state === "active") stored.value = toJsonString(contract.ProviderSharingReceivedSchema, { ...received, state: "unavailable" });
      this.#joins.set(joinId, stored); }
    for (const action of value.actions) { id(action.id); id(action.joinId); if (!["leave", "withdraw"].includes(action.kind) || !["prepared", "unknown", "complete"].includes(action.status)
      || !/^[a-f0-9]{64}$/u.test(action.bodyHash) || this.#actions.has(action.id)) throw invalid(); this.#actions.set(action.id, { ...action, status: action.status === "prepared" ? "unknown" : action.status }); }
  }
  subscribe(listener: () => void): () => void { this.#listeners.add(listener); return () => this.#listeners.delete(listener); }
  received(): readonly contract.ProviderSharingReceived[] { return [...this.#joins.values()].map(row => this.parseReceived(row.value)); }
  intents(): readonly contract.ProviderSharingIntent[] { return [...this.#intents.values()].map(row => this.publicIntent(row)); }
  listReceived(): readonly ProviderSharingReceivedEntry[] {
    return this.received().map(row => ({ joinId: row.joinId, shareId: row.shareId, memberId: row.memberId, generation: integer(row.generation),
      hostServerId: row.hostServerId, nativeBackendId: row.nativeBackendId, backendId: row.backendId, providerId: row.providerId,
      displayName: row.providerName, ownerName: row.owner?.name ?? "", models: row.models.map(fromModel), sourceNodeId: row.hostServerId,
      state: row.state as ProviderSharingReceivedEntry["state"] }));
  }
  async preview(link: string, auth: ProviderSharingHomeAuthority): Promise<contract.ProviderSharingPreview> {
    this.check(auth); const parsed = contract.parseProviderSharingLink(link), remote = this.remote({ origin: parsed.origin, assertCurrent: () => this.check(auth) });
    const serverId = await remote.verify(undefined, auth.signal); this.check(auth);
    const result = await remote.guest.inspectProviderShare({ invitation: parsed.secret }, { signal: auth.signal }); this.check(auth);
    const preview = this.checkPreview(result.preview); if (preview.hostOrigin !== parsed.origin || preview.hostServerId !== serverId) throw denied();
    if (serverId === this.options.serverId) throw new ConnectError("This Provider already belongs to your Home.", Code.FailedPrecondition); return preview;
  }
  apply(input: contract.ApplyProviderShareRequest, auth: ProviderSharingHomeAuthority): Promise<contract.ProviderSharingIntent> {
    return this.single(`apply:${id(input.operationId)}`, async () => {
      this.check(auth); const parsed = contract.parseProviderSharingLink(input.link), person = safePerson(input.person);
      const bodyHash = hash(JSON.stringify([parsed.origin, hash(parsed.secret), person])); let intent = this.#intents.get(input.operationId);
      if (intent) { if (intent.bodyHash !== bodyHash) throw denied(); return this.recover(intent, auth); }
      const preview = await this.preview(input.link, auth); this.check(auth);
      if (preview.state !== "unused" || Number(preview.expiresAtMs) <= Date.now()) throw new ConnectError("This invitation is used or expired.", Code.FailedPrecondition);
      const joinId = `received-${randomUUID()}`, requestId = `request-${randomUUID()}`, requestSecret = randomBytes(32).toString("base64url"), memberSecret = randomBytes(32).toString("base64url");
      const reference = this.reference(joinId, preview);
      intent = { id: input.operationId, joinId, requestId, bodyHash, deviceId: auth.deviceId, preview: toJsonString(contract.ProviderSharingPreviewSchema, preview), person,
        requestCredential: this.options.vault.seal(requestSecret, reference + ":request"), memberCredential: this.options.vault.seal(memberSecret, reference + ":member"), status: "prepared", errorCode: "" };
      this.#intents.set(input.operationId, intent); await this.save(); this.check(auth);
      try {
        intent.status = "sent"; await this.save(); this.check(auth);
        const remote = this.remote({ origin: parsed.origin, serverId: preview.hostServerId, assertCurrent: () => this.check(auth) });
        const response = await remote.guest.submitProviderShareRequest({ requestId, invitation: parsed.secret, homeServerId: this.options.serverId, deviceId: auth.deviceId,
          person, requestSha256Hex: hash(requestSecret), credentialSha256Hex: hash(memberSecret) }, { signal: auth.signal });
        this.check(auth); await this.accept(intent, response); this.check(auth);
      } catch (error) { intent.status = "unknown"; intent.errorCode = safeCode(error); await this.save(); this.check(auth); }
      this.changed(); return this.publicIntent(intent);
    });
  }
  async refresh(auth: ProviderSharingHomeAuthority): Promise<void> {
    this.check(auth);
    await Promise.all([...this.#intents.values()].filter(row => ["pending", "prepared", "sent", "unknown"].includes(row.status)).map(row => this.single(`recover:${row.id}`, () => this.recover(row, auth))));
    await Promise.all([...this.#joins.keys()].map(joinId => this.single(`refresh:${joinId}`, () => this.refreshJoin(joinId, auth))));
    for (const action of this.#actions.values()) if (action.status === "unknown" && action.kind === "leave") await this.leave(action.id, action.joinId, auth);
    this.check(auth);
  }
  withdraw(operationId: string, applicationId: string, auth: ProviderSharingHomeAuthority): Promise<contract.ProviderSharingIntent> {
    return this.single(`withdraw:${id(operationId)}`, async () => {
      this.check(auth); const intent = this.#intents.get(id(applicationId)); if (!intent) throw invalid(); const preview = this.intentPreview(intent);
      const secret = this.options.vault.open(intent.requestCredential, this.reference(intent.joinId, preview) + ":request");
      const bodyHash = hash(JSON.stringify([applicationId])); this.action(operationId, "withdraw", bodyHash, intent.joinId); await this.save(); this.check(auth);
      try { const remote = this.remote({ origin: preview.hostOrigin, serverId: preview.hostServerId, authorization: () => `ProviderShareRequest ${secret}`, assertCurrent: () => this.check(auth) });
        const response = await remote.guest.withdrawProviderShareRequest({ operationId, requestId: intent.requestId }, { signal: auth.signal }); this.check(auth); await this.accept(intent, response);
        this.#actions.set(operationId, { ...this.#actions.get(operationId)!, status: "complete" });
      } catch (error) { intent.errorCode = safeCode(error); this.#actions.set(operationId, { ...this.#actions.get(operationId)!, status: "unknown" }); }
      await this.save(); this.check(auth); this.changed(); return this.publicIntent(intent);
    });
  }
  leave(operationId: string, joinId: string, auth: ProviderSharingHomeAuthority): Promise<contract.ProviderSharingReceived> {
    return this.single(`leave:${id(operationId)}`, () => this.leaveOnce(operationId, joinId, auth));
  }
  private async leaveOnce(operationId: string, joinId: string, auth: ProviderSharingHomeAuthority): Promise<contract.ProviderSharingReceived> {
    this.check(auth); const stored = this.#joins.get(id(joinId)); if (!stored) throw invalid(); const original = this.parseReceived(stored.value);
    const bodyHash = hash(JSON.stringify([joinId])); const previous = this.#actions.get(id(operationId)); this.action(operationId, "leave", bodyHash, joinId);
    if (original.state === "removed") { this.#actions.set(operationId, { ...this.#actions.get(operationId)!, status: "complete" }); await this.save(); return original; }
    if (!stored.credential) throw denied(); const secret = this.options.vault.open(stored.credential, this.reference(joinId, original));
    await this.save(); this.check(auth);
    const remote = this.remote({ origin: original.hostOrigin, serverId: original.hostServerId, authorization: () => `ProviderShareGuest ${secret}`, assertCurrent: () => this.check(auth) });
    try {
      if (previous?.status === "unknown") {
        try { const receipt = await remote.guest.getProviderShareLeaveReceipt({ operationId, shareId: original.shareId }, { signal: auth.signal }); this.check(auth); if (receipt.member?.status !== "left") throw denied(); }
        catch (error) { if (!(error instanceof ConnectError && error.code === Code.NotFound)) throw error;
          const receipt = await remote.guest.leaveProviderShare({ operationId, shareId: original.shareId }, { signal: auth.signal }); this.check(auth); if (receipt.member?.status !== "left") throw denied(); }
      } else { const receipt = await remote.guest.leaveProviderShare({ operationId, shareId: original.shareId }, { signal: auth.signal }); this.check(auth); if (receipt.member?.status !== "left") throw denied(); }
      stored.value = toJsonString(contract.ProviderSharingReceivedSchema, { ...original, state: "removed", models: [] }); this.eraseMemberCredential(joinId);
      this.#actions.set(operationId, { ...this.#actions.get(operationId)!, status: "complete" }); this.#reshareStates.delete(joinId);
    } catch { this.#actions.set(operationId, { ...this.#actions.get(operationId)!, status: "unknown" }); throw unavailable(); }
    finally { await this.save(); this.changed(); }
    return this.parseReceived(stored.value);
  }
  assertReceived(identity: ProviderSharingReceivedIdentity): void {
    if (this.#closed) throw unavailable(); const row = this.get(identity.joinId);
    if (row.state !== "active" || row.shareId !== identity.shareId || row.memberId !== identity.memberId || Number(row.generation) !== identity.generation
      || row.hostServerId !== identity.hostServerId || row.nativeBackendId !== identity.nativeBackendId || row.providerId !== identity.providerId) throw denied();
  }
  canRelayToRecipient(identity: ProviderSharingReceivedIdentity, recipient: ProviderSharingRecipient) {
    const opaqueReshareKey = providerSharingReshareKey(recipient), approved = this.#reshareStates.get(identity.joinId)?.get(opaqueReshareKey) === "approved";
    return { approved, opaqueReshareKey, assertCurrent: () => {
      this.assertReceived(identity); if (!approved || this.#reshareStates.get(identity.joinId)?.get(opaqueReshareKey) !== "approved") throw denied();
    } };
  }
  async syncReshares(identity: ProviderSharingReceivedIdentity, recipients: readonly ProviderSharingRecipient[], signal: AbortSignal): Promise<void> {
    signal.throwIfAborted(); this.assertReceived(identity); const row = this.get(identity.joinId), stored = this.#joins.get(identity.joinId)!;
    if (!stored.credential) throw denied(); const secret = this.options.vault.open(stored.credential, this.reference(row.joinId, row));
    const assertCurrent = () => { signal.throwIfAborted(); this.assertReceived(identity); };
    const remote = this.remote({ origin: row.hostOrigin, serverId: row.hostServerId, authorization: () => `ProviderShareGuest ${secret}`, sourceDeviceId: this.localSourceDeviceId, assertCurrent });
    const entries = recipients.map(recipient => ({ key: providerSharingReshareKey(recipient), person: { name: recipient.name, ...(recipient.avatarUrl ? { avatarUrl: recipient.avatarUrl } : {}) } }));
    const states = new Map<string, string>(), count = Math.max(1, Math.ceil(entries.length / 256)), batchId = randomBytes(16).toString("base64url");
    for (let index = 0; index < count; index++) {
      assertCurrent(); const chunk = entries.slice(index * 256, (index + 1) * 256), result = await remote.guest.syncProviderReshares({ entries: chunk,
        ...(count > 1 ? { batch: { id: batchId, index, count } } : {}) }, { signal }); assertCurrent();
      if (result.entries.length !== chunk.length || new Set(result.entries.map(entry => entry.key)).size !== chunk.length
        || result.entries.some(entry => !chunk.some(input => input.key === entry.key) || !["pending", "approved", "rejected"].includes(entry.state))
        || result.complete !== (index === count - 1)) throw invalid();
      for (const entry of result.entries) states.set(entry.key, entry.state);
    }
    assertCurrent(); this.#reshareStates.set(identity.joinId, states); this.changed();
  }
  captureNative(identity: ProviderSharingReceivedIdentity, sourceDeviceId: string, recipient?: ProviderSharingRecipient) {
    this.assertReceived(identity); const row = this.get(identity.joinId), stored = this.#joins.get(identity.joinId)!; if (!stored.credential) throw denied();
    const secret = this.options.vault.open(stored.credential, this.reference(row.joinId, row));
    const consent = recipient ? this.canRelayToRecipient(identity, recipient) : undefined;
    const assertCurrent = () => { this.assertReceived(identity); consent?.assertCurrent(); };
    assertCurrent();
    const remote = this.remote({ origin: row.hostOrigin, serverId: row.hostServerId, authorization: () => `ProviderShareGuest ${secret}`,
      sourceDeviceId: id(sourceDeviceId), ...(consent ? { recipientKey: consent.opaqueReshareKey } : {}), assertCurrent });
    const terminal = this.remote({ origin: row.hostOrigin, serverId: row.hostServerId, authorization: () => `ProviderShareGuest ${secret}`, assertCurrent: () => { if (this.#closed) throw unavailable(); } });
    return { client: new HostedAgentConnectClient(remote.native, assertCurrent), assertCurrent,
      close: async (runId: string, signal: AbortSignal) => { await terminal.guest.closeProviderShareRun({ runId }, { signal }); } };
  }
  close(): Promise<void> { this.#closed = true; this.#listeners.clear(); this.#reshareStates.clear(); return this.#saveFlight; }
  private async recover(intent: StoredIntent, auth: ProviderSharingHomeAuthority): Promise<contract.ProviderSharingIntent> {
    this.check(auth); if (!["pending", "unknown", "prepared", "sent"].includes(intent.status)) return this.publicIntent(intent);
    const preview = this.intentPreview(intent), secret = this.options.vault.open(intent.requestCredential, this.reference(intent.joinId, preview) + ":request");
    try { const remote = this.remote({ origin: preview.hostOrigin, serverId: preview.hostServerId, authorization: () => `ProviderShareRequest ${secret}`, assertCurrent: () => this.check(auth) });
      const response = await remote.guest.getProviderShareRequest({ requestId: intent.requestId }, { signal: auth.signal }); this.check(auth); await this.accept(intent, response); this.check(auth);
    } catch (error) { intent.errorCode = safeCode(error); intent.status = "unknown"; await this.save(); this.check(auth); }
    this.changed(); return this.publicIntent(intent);
  }
  private async accept(intent: StoredIntent, result: Pick<contract.SubmitProviderShareRequestResponse, "request" | "member" | "preview">): Promise<void> {
    const preview = this.intentPreview(intent), request = result.request;
    if (!request || request.requestId !== intent.requestId || request.shareId !== preview.shareId || !/^\d{4}$/u.test(request.pairingCode)
      || !["pending", "approved", "rejected", "withdrawn", "expired"].includes(request.status)) throw invalid();
    intent.request = toJsonString(contract.ProviderSharingRequestSchema, request); intent.status = request.status; intent.errorCode = "";
    if (request.status === "approved") {
      const member = result.member; if (!member || !["active", "paused"].includes(member.status) || member.homeServerId !== this.options.serverId || !intent.memberCredential) throw denied();
      const secret = this.options.vault.open(intent.memberCredential, this.reference(intent.joinId, preview) + ":member");
      const received = create(contract.ProviderSharingReceivedSchema, { joinId: intent.joinId, hostOrigin: preview.hostOrigin, hostServerId: preview.hostServerId, shareId: preview.shareId,
        memberId: member.memberId, generation: member.generation, nativeBackendId: preview.backendId, backendId: providerSharingBackendId(intent.joinId, preview.backendId),
        providerId: preview.providerId, providerName: preview.providerName, owner: preview.owner, state: "unavailable", models: [] });
      this.#joins.set(intent.joinId, { value: toJsonString(contract.ProviderSharingReceivedSchema, received), credential: this.options.vault.seal(secret, this.reference(intent.joinId, received)) });
    } else if (["rejected", "withdrawn", "expired"].includes(request.status)) delete intent.memberCredential;
    await this.save();
  }
  private async refreshJoin(joinId: string, auth: ProviderSharingHomeAuthority): Promise<void> {
    this.check(auth); const stored = this.#joins.get(joinId)!; const before = this.parseReceived(stored.value); if (before.state === "removed" || !stored.credential) return;
    const secret = this.options.vault.open(stored.credential, this.reference(joinId, before));
    try {
      const remote = this.remote({ origin: before.hostOrigin, serverId: before.hostServerId, authorization: () => `ProviderShareGuest ${secret}`, assertCurrent: () => this.check(auth) });
      const result = await remote.guest.readProviderShare({ shareId: before.shareId }, { signal: auth.signal }); this.check(auth);
      const share = this.checkPreview(result.share), member = result.member;
      if (share.shareId !== before.shareId || share.hostServerId !== before.hostServerId || share.backendId !== before.nativeBackendId || share.providerId !== before.providerId
        || !member || member.memberId !== before.memberId || member.homeServerId !== this.options.serverId || !["active", "paused"].includes(member.status)) throw invalid();
      const catalog = result.catalog, provider = catalog?.backends.find(backend => backend.backendId === before.nativeBackendId)?.providers.find(provider => provider.providerId === before.providerId);
      if (catalog?.backends.some(backend => backend.backendId !== before.nativeBackendId || backend.providers.some(provider => provider.providerId !== before.providerId))) throw invalid();
      const state = member.status === "paused" ? "paused" : provider?.connected && provider.remoteInvocationEnabled && provider.models.length ? "active" : "unavailable";
      const value = create(contract.ProviderSharingReceivedSchema, { ...before, generation: member.generation, providerName: share.providerName, owner: share.owner,
        state, models: provider?.models ?? before.models });
      stored.value = toJsonString(contract.ProviderSharingReceivedSchema, value);
      if (value.generation !== before.generation || state !== "active") this.#reshareStates.delete(joinId);
    } catch (error) {
      this.check(auth);
      if (error instanceof ConnectError && [Code.PermissionDenied, Code.Unauthenticated].includes(error.code)) {
        stored.value = toJsonString(contract.ProviderSharingReceivedSchema, { ...before, state: "removed", models: [] }); this.eraseMemberCredential(joinId); this.#reshareStates.delete(joinId);
      } else stored.value = toJsonString(contract.ProviderSharingReceivedSchema, { ...before, state: "unavailable" });
    }
    await this.save(); this.changed();
  }
  private get(joinId: string): contract.ProviderSharingReceived { const row = this.#joins.get(id(joinId)); if (!row) throw denied(); return this.parseReceived(row.value); }
  private eraseMemberCredential(joinId: string): void {
    const join = this.#joins.get(joinId); if (join) delete join.credential;
    for (const intent of this.#intents.values()) if (intent.joinId === joinId) delete intent.memberCredential;
  }
  private parseReceived(text: string): contract.ProviderSharingReceived {
    const row = fromJsonString(contract.ProviderSharingReceivedSchema, text); id(row.joinId); id(row.shareId); id(row.memberId); id(row.hostServerId); id(row.nativeBackendId); id(row.providerId);
    contract.taskShareOrigin(row.hostOrigin); integer(row.generation);
    if (row.backendId !== providerSharingBackendId(row.joinId, row.nativeBackendId) || !["active", "paused", "removed", "unavailable"].includes(row.state)) throw invalid(); return row;
  }
  private intentPreview(intent: StoredIntent): contract.ProviderSharingPreview { return this.checkPreview(fromJsonString(contract.ProviderSharingPreviewSchema, intent.preview)); }
  private checkPreview(row: contract.ProviderSharingPreview | undefined): contract.ProviderSharingPreview {
    if (!row) throw invalid(); id(row.hostServerId); id(row.shareId); id(row.backendId); id(row.providerId); contract.taskShareOrigin(row.hostOrigin); safePerson(row.owner); return row;
  }
  private publicIntent(intent: StoredIntent): contract.ProviderSharingIntent { return create(contract.ProviderSharingIntentSchema, { operationId: intent.id, joinId: intent.joinId,
    status: intent.status, errorCode: intent.errorCode, preview: this.intentPreview(intent), ...(intent.request ? { request: fromJsonString(contract.ProviderSharingRequestSchema, intent.request) } : {}) }); }
  private reference(joinId: string, row: Pick<contract.ProviderSharingPreview, "hostServerId" | "shareId">): string { return `provider-sharing:${this.options.serverId}:${joinId}:${row.hostServerId}:${row.shareId}`; }
  private action(id: string, kind: string, bodyHash: string, joinId: string): void { const previous = this.#actions.get(id);
    if (previous && (previous.kind !== kind || previous.bodyHash !== bodyHash || previous.joinId !== joinId)) throw denied();
    if (!previous) this.#actions.set(id, { id, kind, bodyHash, joinId, status: "prepared" }); }
  private remote(options: ProviderSharingRemoteOptions): ProviderSharingRemote { return (this.options.connect ?? createProviderSharingRemote)(options); }
  private check(auth: ProviderSharingHomeAuthority): void { if (this.#closed) throw unavailable(); auth.signal.throwIfAborted(); auth.assertCurrent(); }
  private single<T>(key: string, task: () => Promise<T>): Promise<T> { const old = this.#flights.get(key); if (old) return old as Promise<T>;
    const promise = task().finally(() => { if (this.#flights.get(key) === promise) this.#flights.delete(key); }); this.#flights.set(key, promise); return promise; }
  private save(): Promise<void> {
    const value: HomeDisk = { format: 1, serverId: this.options.serverId, intents: [...this.#intents.values()].map(row => ({ ...row })), joined: [...this.#joins].map(([id, row]) => [id, { ...row }]), actions: [...this.#actions.values()].map(row => ({ ...row })) };
    const text = JSON.stringify(value); if (Buffer.byteLength(text) > 16 * 1024 * 1024) throw invalid();
    const promise = this.#saveFlight.then(async () => { const temporary = join(this.options.directory, `.home-${randomUUID()}.tmp`);
      try { const file = await open(temporary, "wx", 0o600); try { await file.writeFile(text); await file.sync(); } finally { await file.close(); }
        await rename(temporary, join(this.options.directory, "home.json")); } finally { await unlink(temporary).catch(() => {}); } });
    this.#saveFlight = promise.catch(() => {}); return promise;
  }
  private changed(): void { for (const listener of this.#listeners) listener(); }
}
/** No redirect following and no credentials in server-identity discovery. */
export function createProviderSharingRemote(options: ProviderSharingRemoteOptions): ProviderSharingRemote {
  const baseUrl = contract.taskShareOrigin(options.origin), plain = createConnectTransport({ baseUrl, httpVersion: "1.1", useBinaryFormat: true, defaultTimeoutMs: 15_000 });
  const identity = createClient(contract.ConnectionService, plain);
  const verify = async (expected: string | undefined, signal: AbortSignal) => { options.assertCurrent(); signal.throwIfAborted();
    const result = await identity.getServerInfo({}, { signal }); options.assertCurrent(); signal.throwIfAborted(); const actual = id(result.server?.serverId ?? "");
    if (expected !== undefined && actual !== expected) throw denied(); return actual; };
  const authorization: Interceptor = next => async request => {
    options.assertCurrent(); if (options.serverId) await verify(options.serverId, request.signal);
    options.assertCurrent(); const secret = options.authorization?.(); if (secret) request.header.set("authorization", secret);
    if (options.sourceDeviceId) request.header.set(PROVIDER_SHARING_SOURCE_DEVICE_HEADER, options.sourceDeviceId);
    if (options.recipientKey) request.header.set(PROVIDER_SHARING_RECIPIENT_HEADER, options.recipientKey);
    const result = await next(request); options.assertCurrent(); return result;
  };
  const transport = createConnectTransport({ baseUrl, httpVersion: "1.1", useBinaryFormat: true, readMaxBytes: 16 * 1024 * 1024, writeMaxBytes: 8 * 1024 * 1024,
    defaultTimeoutMs: 35_000, interceptors: [authorization] });
  return { verify, guest: createClient(contract.ProviderSharingGuestService, transport), native: createClient(contract.HostedAgentService, transport) };
}
function fromModel(row: contract.ModelDescriptor): ProviderModel {
  const number = (value: bigint) => { const result = Number(value); if (!Number.isSafeInteger(result) || result < 0) throw invalid(); return result; };
  if (!row.key?.providerId || !row.key.modelId || !row.displayName || !row.api) throw invalid();
  return { providerId: row.key.providerId, modelId: row.key.modelId, displayName: row.displayName, logicalId: row.logicalId || row.key.modelId,
    api: row.api, contextWindow: number(row.contextWindowTokens), maxOutputTokens: number(row.maximumOutputTokens), supportsImages: row.inputModalities.includes(contract.ModelInputModality.IMAGE),
    thinkingLevels: row.effortLevels.map(level => level.effortId), ...(row.defaultEffort === undefined ? {} : { defaultEffort: row.defaultEffort }), supportsFastMode: row.supportsFastMode,
    ...(row.description === undefined ? {} : { description: row.description }),
    ...(row.defaultVisible === undefined ? {} : { defaultVisible: row.defaultVisible }),
    ...(row.displayThinkingLevels.length ? { displayThinkingLevels: [...row.displayThinkingLevels] } : {}),
    ...(row.declaredModalities?.input === undefined ? {} : { declaredInputModalities: [...row.declaredModalities.input.values] }),
    ...(row.declaredModalities?.output === undefined ? {} : { declaredOutputModalities: [...row.declaredModalities.output.values] }),
    ...(row.declaredSupportsImages === undefined ? {} : { declaredSupportsImages: row.declaredSupportsImages }),
    ...(row.declaredSupportsFastMode === undefined ? {} : { declaredSupportsFastMode: row.declaredSupportsFastMode }),
    ...(row.referenceApi === undefined ? {} : { referenceApi: row.referenceApi }),
    ...(["matching", "compatibility", "unknown"].includes(row.protocolMode ?? "") ? { protocolMode: row.protocolMode as ProviderModel["protocolMode"] } : {}),
    ...(["declared", "estimated"].includes(row.contextWindowSource ?? "") ? { contextWindowSource: row.contextWindowSource as "declared" | "estimated" } : {}),
    ...(["declared", "estimated"].includes(row.maxOutputTokensSource ?? "") ? { maxOutputTokensSource: row.maxOutputTokensSource as "declared" | "estimated" } : {}),
    ...(row.priceSource === contract.ModelPriceSource.UNSPECIFIED ? {} : { pricing: { source: row.priceSource === contract.ModelPriceSource.PROVIDER_REFERENCE ? "providerReference" as const : "upstream" as const,
      currencyCode: row.currencyCode, ...(row.priceUpdatedAt === undefined ? {} : { updatedAt: Number(row.priceUpdatedAt.seconds) * 1000 + row.priceUpdatedAt.nanos / 1_000_000 }) } }),
    cost: { input: number(row.inputCostMicrosPerMillion) / 1_000_000,
      output: number(row.outputCostMicrosPerMillion) / 1_000_000, cacheRead: number(row.cacheReadCostMicrosPerMillion) / 1_000_000, cacheWrite: number(row.cacheWriteCostMicrosPerMillion) / 1_000_000 } };
}
function safePerson(row: contract.ProviderSharingPerson | undefined): { name: string; avatarUrl?: string } {
  if (!row || !row.name || row.name !== row.name.trim() || row.name.length > 200 || /[\0-\x1f\x7f]/u.test(row.name)) throw invalid();
  if (row.avatarUrl) { const url = new URL(row.avatarUrl); if (url.protocol !== "https:" || url.username || url.password || url.href.length > 2048) throw invalid(); }
  return { name: row.name, ...(row.avatarUrl ? { avatarUrl: row.avatarUrl } : {}) };
}
function integer(value: bigint): number { const result = Number(value); if (!Number.isSafeInteger(result) || result < 1) throw invalid(); return result; }
function id(value: string): string { if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/u.test(value)) throw invalid(); return value; }
function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function safeCode(error: unknown): string { return error instanceof ConnectError ? Code[error.code].toUpperCase() : "UNAVAILABLE"; }
function denied(): ConnectError { return new ConnectError("The Provider grant is unavailable or changed.", Code.PermissionDenied); }
function unavailable(): ConnectError { return new ConnectError("The Provider is temporarily unavailable. Check the original request before retrying.", Code.Unavailable); }
function invalid(): ConnectError { return new ConnectError("The Provider sharing record is invalid.", Code.InvalidArgument); }
