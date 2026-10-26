import { createHash, randomBytes, randomUUID } from "node:crypto";
import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, createClient, type Client } from "@connectrpc/connect";
import { createConnectTransport } from "@joko/connection-transport/node";
import * as contract from "@joko/contracts";
import type { OperationalStore } from "@joko/store";
import type { CredentialVault, EncryptedCredential } from "./credential-vault.js";
import type { TaskSharingHost } from "./task-sharing-host.js";
import type { TaskSharingHome, TaskSharingHomeAuthority } from "./task-sharing-home.js";

export interface PartnerIdentityProfile {
  readonly id: string; readonly name: string; readonly description: string;
  readonly canonicalSessionId: string; readonly revision: bigint;
}
export interface PartnerIdentityRemote {
  readonly client: Client<typeof contract.PartnerIdentityGuestService>;
  verify(serverId: string, signal: AbortSignal): Promise<void>;
}
interface Grant {
  readonly id: string; readonly partnerId: string; readonly name: string; readonly description: string;
  readonly secretHash: string; status: "active" | "revoked";
  scopeEpoch: number; shareId: string; sessionId: string;
}
interface Link {
  readonly id: string; readonly authorityServerId: string; readonly partnerId: string; readonly origin: string;
  readonly endpointPublicKey: string;
  readonly grantId: string; readonly sealed: EncryptedCredential; readonly invitationHash: string;
  name: string; description: string; alias: string; status: "active" | "removed";
  joinId: string; pendingOperation: string; pendingShareId: string;
}
const grantScope = "partner-identity-authority", homeScope = "partner-identity-home";
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const op = (kind: string, value: unknown) => `identity-${kind}:${digest(JSON.stringify(value))}`;
const denied = () => new ConnectError("The partner identity access is unavailable or revoked.", Code.PermissionDenied);

/** Stable public identity, explicit authority grants, and sealed Home aliases.
 * Conversation history remains at the Partner's current canonical Session. */
export class PartnerIdentityDirectory {
  #host: TaskSharingHost | undefined;
  readonly #issueReplies = new Map<string, string>();
  readonly #busy = new Set<string>();
  constructor(readonly options: { readonly store: OperationalStore; readonly serverId: string; readonly origin: string | (() => string); readonly endpointPublicKey: string;
    readonly vault: CredentialVault; readonly home: TaskSharingHome;
    readonly partner: (id: string) => PartnerIdentityProfile;
    readonly connect?: (origin: string, endpointPublicKey: string) => PartnerIdentityRemote }) {}

  #origin(): string { return contract.taskShareOrigin(typeof this.options.origin === "string" ? this.options.origin : this.options.origin()); }

  attachHost(host: TaskSharingHost): void { this.#host = host; }
  #sharing(): TaskSharingHost { if (!this.#host) throw new ConnectError("Task sharing is unavailable.", Code.Unavailable); return this.#host; }
  #grant(id: string): Grant {
    const row = this.options.store.findSetting<Grant>("service", grantScope, `grant:${contract.taskShareIdentity(id)}`)?.value;
    if (!row) throw denied(); return row;
  }
  #saveGrant(row: Grant): void { this.options.store.setSetting("service", grantScope, `grant:${row.id}`, row); }
  #link(id: string): Link {
    const row = this.options.store.findSetting<Link>("service", homeScope, contract.taskShareIdentity(id))?.value;
    if (!row || row.status !== "active") throw new ConnectError("This partner alias is unavailable.", Code.NotFound);
    contract.taskShareEndpointPublicKey(row.endpointPublicKey); return row;
  }
  #saveLink(row: Link): void { this.options.store.setSetting("service", homeScope, row.id, row); }
  #reference(row: Pick<Link, "id" | "authorityServerId" | "partnerId" | "grantId" | "origin" | "endpointPublicKey">): string {
    return `partner-identity:${this.options.serverId}:${row.id}:${row.authorityServerId}:${row.partnerId}:${row.grantId}:${row.origin}:${contract.taskShareEndpointPublicKey(row.endpointPublicKey)}`;
  }
  #identity(partnerId: string, name: string, description: string, authorityServerId = this.options.serverId): contract.PartnerIdentity {
    return create(contract.PartnerIdentitySchema, { authorityServerId, partnerId, displayName: name, description });
  }
  #publicGrant(row: Grant): contract.PartnerIdentityGrant {
    let profile: PartnerIdentityProfile | undefined; try { profile = this.options.partner(row.partnerId); } catch { /* Keep revoked identities recognizable. */ }
    return create(contract.PartnerIdentityGrantSchema, { grantId: row.id, status: row.status,
      identity: this.#identity(row.partnerId, profile?.name ?? row.name, profile?.description ?? row.description) });
  }
  #publicLink(row: Link): contract.PartnerIdentityLink {
    return create(contract.PartnerIdentityLinkSchema, { linkId: row.id, alias: row.alias, status: row.status, joinId: row.joinId,
      identity: this.#identity(row.partnerId, row.name, row.description, row.authorityServerId) });
  }
  list(): contract.ListPartnerIdentitiesResponse {
    return create(contract.ListPartnerIdentitiesResponseSchema, {
      grants: this.options.store.listSettings("service", grantScope).filter(row => row.key.startsWith("grant:")).map(row => this.#publicGrant(row.value as Grant)),
      links: this.options.store.listSettings("service", homeScope).map(row => row.value as Link).filter(row => row.status === "active").map(row => this.#publicLink(row)) });
  }
  issue(request: contract.IssuePartnerIdentityRequest): contract.IssuePartnerIdentityResponse {
    contract.taskShareIdentity(request.operationId); contract.taskShareIdentity(request.partnerId);
    const profile = this.options.partner(request.partnerId);
    if (profile.revision !== request.expectedRevision) throw new ConnectError("The partner changed. Refresh before granting access.", Code.FailedPrecondition);
    const prior = this.options.store.findOperation(request.operationId);
    if (prior && !this.#issueReplies.has(request.operationId)) throw new ConnectError("The private invitation response expired. Issue a new invitation explicitly.", Code.FailedPrecondition);
    let invitation = this.#issueReplies.get(request.operationId);
    const result = this.options.store.runOperation({ id: request.operationId, kind: "partner_identity_issue",
      body: { partnerId: request.partnerId, expectedRevision: String(request.expectedRevision) } }, () => {
      const secret = randomBytes(32).toString("base64url"), id = `identity-${randomUUID()}`;
      this.#saveGrant({ id, partnerId: profile.id, name: profile.name, description: profile.description, secretHash: digest(secret),
        status: "active", scopeEpoch: 0, shareId: "", sessionId: "" });
      invitation = contract.buildPartnerIdentityInvitation({ authorityServerId: this.options.serverId, partnerId: profile.id,
        origin: this.#origin(), endpointPublicKey: this.options.endpointPublicKey, grantId: id, secret });
      return id;
    });
    if (!invitation) throw denied(); this.#issueReplies.set(request.operationId, invitation);
    setTimeout(() => this.#issueReplies.delete(request.operationId), 60_000).unref();
    return create(contract.IssuePartnerIdentityResponseSchema, { grant: this.#publicGrant(this.#grant(result.value)), invitation });
  }
  revoke(request: contract.RevokePartnerIdentityRequest): contract.RevokePartnerIdentityResponse {
    contract.taskShareIdentity(request.operationId); contract.taskShareIdentity(request.grantId);
    const result = this.options.store.runOperation({ id: request.operationId, kind: "partner_identity_revoke", body: { grantId: request.grantId } }, () => {
      const row = this.#grant(request.grantId); row.status = "revoked"; this.#saveGrant(row);
      if (row.shareId && this.#sharing().get(row.shareId).status === "active") this.#sharing().end({ operationId: op("revoke", [request.operationId, row.shareId]), shareId: row.shareId });
      return row.id;
    });
    return create(contract.RevokePartnerIdentityResponseSchema, { grant: this.#publicGrant(this.#grant(result.value)) });
  }
  #authorized(grantId: string, partnerId: string, authorization: string | undefined): { grant: Grant; profile: PartnerIdentityProfile } {
    const secret = /^PartnerIdentity ([A-Za-z0-9_-]{43})$/u.exec(authorization ?? "")?.[1];
    if (!secret) throw new ConnectError("Partner identity authentication is required.", Code.Unauthenticated);
    const grant = this.#grant(grantId);
    if (grant.status !== "active" || grant.partnerId !== partnerId || grant.secretHash !== digest(secret)) throw denied();
    let profile: PartnerIdentityProfile; try { profile = this.options.partner(partnerId); } catch { throw denied(); }
    return { grant, profile };
  }
  inspect(request: contract.InspectPartnerIdentityRequest, authorization: string | undefined): contract.InspectPartnerIdentityResponse {
    const { profile } = this.#authorized(request.grantId, request.partnerId, authorization);
    return create(contract.InspectPartnerIdentityResponseSchema, { identity: this.#identity(profile.id, profile.name, profile.description) });
  }
  /** Called at every TaskShare lease use, including reads and queued effects.
   * A moved/paused/revoked Partner cannot keep an old canonical scope alive. */
  authorizeScope(shareId: string, sessionId: string): void {
    const binding = this.options.store.findSetting<{ grantId: string }>("service", grantScope, `scope:${shareId}`)?.value;
    if (!binding) return;
    const grant = this.#grant(binding.grantId);
    let profile: PartnerIdentityProfile; try { profile = this.options.partner(grant.partnerId); } catch { throw denied(); }
    if (grant.status !== "active" || grant.shareId !== shareId || grant.sessionId !== sessionId || profile.canonicalSessionId !== sessionId) throw denied();
  }
  resolve(request: contract.ResolvePartnerIdentityRequest, authorization: string | undefined): contract.ResolvePartnerIdentityResponse {
    contract.taskShareIdentity(request.operationId);
    const { grant, profile } = this.#authorized(request.grantId, request.partnerId, authorization), host = this.#sharing();
    const shareActive = grant.shareId ? host.get(grant.shareId).status === "active" : false;
    if (grant.sessionId !== profile.canonicalSessionId || !shareActive) {
      this.options.store.transaction(() => {
        if (grant.shareId && shareActive) host.end({ operationId: op("move", [grant.id, grant.scopeEpoch]), shareId: grant.shareId });
        grant.scopeEpoch += 1;
        const share = host.create({ operationId: op("scope", [grant.id, grant.scopeEpoch]), sessionId: profile.canonicalSessionId });
        grant.shareId = share.shareId; grant.sessionId = profile.canonicalSessionId;
        this.#saveGrant(grant);
        this.options.store.setSetting("service", grantScope, `scope:${share.shareId}`, { grantId: grant.id });
      });
    }
    this.authorizeScope(grant.shareId, grant.sessionId);
    const invited = host.invite({ operationId: op("invite", [grant.id, request.operationId, grant.scopeEpoch]), shareId: grant.shareId });
    return create(contract.ResolvePartnerIdentityResponseSchema, { identity: this.#identity(profile.id, profile.name, profile.description), ...invited });
  }
  #remote(origin: string, endpointPublicKey: string): PartnerIdentityRemote { return (this.options.connect ?? createPartnerIdentityRemote)(contract.taskShareOrigin(origin), contract.taskShareEndpointPublicKey(endpointPublicKey)); }
  #checkIdentity(value: contract.PartnerIdentity | undefined, row: Pick<Link, "authorityServerId" | "partnerId">): contract.PartnerIdentity {
    if (!value || value.authorityServerId !== row.authorityServerId || value.partnerId !== row.partnerId || !value.displayName.trim()) throw denied(); return value;
  }
  async #lock<T>(id: string, work: () => Promise<T>): Promise<T> {
    if (this.#busy.has(id)) throw new ConnectError("The original partner access request is still being checked.", Code.FailedPrecondition);
    this.#busy.add(id); try { return await work(); } finally { this.#busy.delete(id); }
  }
  async import(invitation: string, alias: string, auth: TaskSharingHomeAuthority): Promise<contract.PartnerIdentityLink> {
    const parsed = contract.parsePartnerIdentityInvitation(invitation);
    if (parsed.authorityServerId === this.options.serverId) throw new ConnectError("Open your own Partner from its directory.", Code.FailedPrecondition);
    const id = `partner-${digest(JSON.stringify([parsed.authorityServerId, parsed.partnerId]))}`;
    return this.#lock(id, async () => {
      const remote = this.#remote(parsed.origin, parsed.endpointPublicKey); auth.assertCurrent(); await remote.verify(parsed.authorityServerId, auth.signal); auth.assertCurrent();
      const response = await remote.client.inspectPartnerIdentity({ grantId: parsed.grantId, partnerId: parsed.partnerId },
        { signal: auth.signal, headers: { authorization: `PartnerIdentity ${parsed.secret}` } }); auth.assertCurrent();
      const identity = this.#checkIdentity(response.identity, parsed);
      const previous = this.options.store.findSetting<Link>("service", homeScope, id)?.value;
      if (previous?.pendingOperation) throw new ConnectError("Confirm the previous partner join before replacing access.", Code.FailedPrecondition);
      if (previous?.status === "active" && previous.grantId !== parsed.grantId && previous.joinId
        && this.options.home.list().joined.some(joined => joined.joinId === previous.joinId && joined.status === "active")) {
        await this.options.home.leave(op("replace", [id, parsed.grantId, previous.joinId]), previous.joinId, auth); auth.assertCurrent();
      }
      const row: Link = { id, authorityServerId: parsed.authorityServerId, partnerId: parsed.partnerId, grantId: parsed.grantId,
        origin: parsed.origin, endpointPublicKey: parsed.endpointPublicKey, invitationHash: digest(invitation), name: identity.displayName, description: identity.description,
        alias: validAlias(alias || previous?.alias || identity.displayName), status: "active", joinId: previous?.grantId === parsed.grantId ? previous.joinId : "", pendingOperation: "", pendingShareId: "",
        sealed: this.options.vault.seal(parsed.secret, this.#reference({ id, ...parsed })) };
      this.#saveLink(row); auth.assertCurrent(); return this.#publicLink(row);
    });
  }
  rename(linkId: string, alias: string): contract.PartnerIdentityLink {
    const row = this.#link(linkId); row.alias = validAlias(alias); this.#saveLink(row); return this.#publicLink(row);
  }
  async forget(operationId: string, linkId: string, auth: TaskSharingHomeAuthority): Promise<void> {
    contract.taskShareIdentity(operationId);
    await this.#lock(linkId, async () => {
      const row = this.#link(linkId);
      if (row.pendingOperation) throw new ConnectError("Confirm the previous partner join before removing access.", Code.FailedPrecondition);
      if (row.joinId) {
        const joined = this.options.home.list().joined.find(item => item.joinId === row.joinId);
        if (joined?.status === "active") await this.options.home.leave(op("forget", [operationId, row.joinId]), row.joinId, auth);
      }
      auth.assertCurrent(); row.status = "removed";
      this.#saveLink({ ...row, sealed: this.options.vault.seal("", this.#reference(row)) });
    });
  }
  async open(request: contract.OpenPartnerIdentityRequest, auth: TaskSharingHomeAuthority): Promise<contract.OpenPartnerIdentityResponse> {
    contract.taskShareIdentity(request.operationId);
    return this.#lock(request.linkId, async () => {
      let row = this.#link(request.linkId); auth.assertCurrent();
      let uncertain: contract.TaskShareJoinIntent | undefined;
      if (row.pendingOperation) {
        let intent: contract.TaskShareJoinIntent | undefined;
        try { intent = await this.options.home.lookup(row.pendingOperation, auth); }
        catch (error) { if (!(error instanceof ConnectError) || error.code !== Code.NotFound) throw error; }
        auth.assertCurrent();
        if (intent && intent.status !== "joined" && intent.status !== "failed") uncertain = intent;
        else {
          row.pendingOperation = ""; row.pendingShareId = "";
          if (intent?.status === "joined" && intent.joined) row.joinId = intent.joined.joinId;
          this.#saveLink(row);
        }
      }
      const remote = this.#remote(row.origin, row.endpointPublicKey);
      await remote.verify(row.authorityServerId, auth.signal); auth.assertCurrent();
      const secret = this.options.vault.open(row.sealed, this.#reference(row));
      const response = await remote.client.resolvePartnerIdentity({ operationId: request.operationId, grantId: row.grantId, partnerId: row.partnerId },
        { signal: auth.signal, headers: { authorization: `PartnerIdentity ${secret}` } }); auth.assertCurrent();
      const identity = this.#checkIdentity(response.identity, row), invitation = contract.parseTaskShareInvitation(response.invitation), share = response.share;
      if (!share || share.status !== "active" || share.hostServerId !== row.authorityServerId || share.hostOrigin !== invitation.hostOrigin
        || invitation.hostServerId !== row.authorityServerId || invitation.shareId !== share.shareId
        || invitation.endpointPublicKey !== row.endpointPublicKey
        || invitation.shareGeneration !== share.shareGeneration || !share.sessionId) throw denied();
      row = this.#link(row.id);
      if (uncertain) {
        if (row.pendingShareId === share.shareId) return create(contract.OpenPartnerIdentityResponseSchema, { link: this.#publicLink(row), intent: uncertain });
        // The same authority has replaced and revoked the old scope. A new
        // canonical join does not resend the uncertain join or any task input.
        row.pendingOperation = ""; row.pendingShareId = ""; this.#saveLink(row);
      }
      const existing = this.options.home.list().joined.find(item => item.joinId === row.joinId && item.status === "active"
        && item.share?.shareId === share.shareId && item.share.shareGeneration === share.shareGeneration && item.share.sessionId === share.sessionId);
      row.name = identity.displayName; row.description = identity.description;
      if (existing) {
        await this.options.home.snapshot(existing.joinId, auth); auth.assertCurrent();
        this.#saveLink(row); return create(contract.OpenPartnerIdentityResponseSchema, { link: this.#publicLink(row), joined: existing });
      }
      row.pendingOperation = op("join", [row.id, request.operationId, share.shareId]); row.pendingShareId = share.shareId; this.#saveLink(row); auth.assertCurrent();
      // A verified authority may publish a new entrance. This alias keeps the
      // locator and pin captured at import until the user explicitly replaces it.
      const pinnedInvitation = contract.buildTaskShareInvitation({ ...invitation, hostOrigin: row.origin });
      const intent = await this.options.home.join(row.pendingOperation, pinnedInvitation, request.displayName, auth); auth.assertCurrent();
      if (intent.status === "joined" && intent.joined) { row.joinId = intent.joined.joinId; row.pendingOperation = ""; row.pendingShareId = ""; }
      else if (intent.status === "failed") { row.pendingOperation = ""; row.pendingShareId = ""; }
      this.#saveLink(row);
      return create(contract.OpenPartnerIdentityResponseSchema, { link: this.#publicLink(row), intent, ...(intent.status === "joined" && intent.joined ? { joined: intent.joined } : {}) });
    });
  }
}
function validAlias(value: string): string {
  const alias = value.trim(); if (!alias || alias.length > 128) throw new ConnectError("A partner alias is required.", Code.InvalidArgument); return alias;
}
/** Local recovery revokes every inbound proof; linked foreign identities and history remain. */
export function revokeAllPartnerIdentityGrants(store: OperationalStore): number {
  let revoked = 0;
  for (const row of store.listSettingsByKeyPrefix("service", grantScope, "grant:")) {
    const grant = row.value as Grant;
    contract.taskShareIdentity(grant.id);
    if (!["active", "revoked"].includes(grant.status)) throw denied();
    if (grant.status === "active") {
      store.setSetting("service", grantScope, row.key, { ...grant, status: "revoked" }); revoked++;
    }
  }
  return revoked;
}
/** Verify the stable node without a credential, then use only the identity scheme. */
export function createPartnerIdentityRemote(origin: string, endpointPublicKey: string): PartnerIdentityRemote {
  const transport = createConnectTransport({ baseUrl: contract.taskShareOrigin(origin), endpointPublicKey: contract.taskShareEndpointPublicKey(endpointPublicKey), httpVersion: "1.1", useBinaryFormat: true,
    defaultTimeoutMs: 15_000, readMaxBytes: 4 * 1024 * 1024, writeMaxBytes: 64 * 1024 });
  const identity = createClient(contract.ConnectionService, transport);
  return { client: createClient(contract.PartnerIdentityGuestService, transport), verify: async (serverId, signal) => {
    const response = await identity.getServerInfo({}, { signal });
    if (response.server?.serverId !== serverId) throw denied();
  } };
}
