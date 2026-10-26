import { randomUUID } from "node:crypto";
import { realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { inspectKeyDirectoryPermissions } from "@joko/remote-ssh";
import type { OfflineLinkspanContext } from "./linkspan-offline-context.js";
import type { SdkDeployment } from "./linkspan-deployment.js";
import { readIceToken } from "./remote-desktop-ice-configuration.js";
import { operationBodyHash, type OperationalStore } from "@joko/store";
import type { OrchestratorApplication } from "./application.js";

const PREFIX = "runtime.linkspan.iroh-lease.";
interface LeaseRecord { readonly requestId: string; readonly reference: string; readonly state: "issuing" | "active"; readonly expiresAt?: number }
type IrohConfiguration = Extract<SdkDeployment, { provider: "iroh" }>;
interface ActiveIssuer { readonly entryId: string; readonly configuration: IrohConfiguration; readonly endpointId: string; readonly ticket: string }
const issuers = new WeakMap<OperationalStore, Map<string, ActiveIssuer>>();
const issuing = new WeakMap<OperationalStore, Map<string, { readonly bodyHash: string; readonly promise: Promise<PrivateIrohRelayInvitation> }>>();

export interface PrivateIrohRelayInvitation {
  readonly requestId: string; readonly nodeEndpointId: string; readonly recipientEndpointId: string;
  readonly ticket: string; readonly relayUrls: readonly string[]; readonly relayToken: string; readonly expiresAt: number;
  readonly origin: string; readonly serverId: string; readonly endpointPublicKey: string;
}

/** Only a live, explicitly configured publishing instance may grant relay use. */
export function registerIrohRelayIssuer(application: Pick<OrchestratorApplication, "store">, input: ActiveIssuer): () => void {
  if (input.configuration.servicesApiSecretPath === undefined) return () => undefined;
  if (!input.configuration.relayUrls?.length) throw new Error("A managed relay issuer requires its explicitly selected relay URLs.");
  let entries = issuers.get(application.store);
  if (entries === undefined) { entries = new Map(); issuers.set(application.store, entries); }
  if (entries.has(input.endpointId)) throw new Error("The same iroh backend identity is already published by another entrance.");
  entries.set(input.endpointId, input);
  return () => { if (entries!.get(input.endpointId) === input) entries!.delete(input.endpointId); };
}

export async function issueAuthorizedIrohRelayInvitation(application: Pick<OrchestratorApplication, "store" | "config" | "credentials" | "linkspanIdentity" | "serverId">, input: {
  readonly requestId: string; readonly nodeEndpointId: string; readonly recipientEndpointId: string;
  readonly ownerConnectionId: string; readonly signal: AbortSignal; readonly assertCurrent: () => void;
}): Promise<PrivateIrohRelayInvitation> {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(input.requestId)
    || !/^[a-f0-9]{64}$/u.test(input.nodeEndpointId) || !/^[a-f0-9]{64}$/u.test(input.recipientEndpointId)) throw new Error("A stable request UUID and complete node/recipient endpoint public keys are required.");
  input.signal.throwIfAborted(); input.assertCurrent();
  const savedRequestId = `linkspan-iroh-lease:${input.requestId}`, savedReference = `linkspan.iroh-lease:${savedRequestId}`;
  const original = application.store.findOperation(savedRequestId);
  if (original !== undefined) {
    const body = original.body as { entryId?: string; nodeEndpointId?: string; clientEndpointId?: string; ownerConnectionId?: string; serverId?: string; ttlSeconds?: number } | null;
    if (original.kind !== "connection.iroh.relay-lease" || original.connectionId !== undefined || original.completionMode !== "external_effect"
      || original.status === "failed" || original.bodyHash !== operationBodyHash(original.body)
      || body?.nodeEndpointId !== input.nodeEndpointId || body.clientEndpointId !== input.recipientEndpointId
      || body.ownerConnectionId !== input.ownerConnectionId || body.serverId !== application.serverId) throw new Error("The original relay request belongs to different authority or recipient.");
    const running = issuing.get(application.store)?.get(savedRequestId);
    if (running !== undefined) {
      if (running.bodyHash !== original.bodyHash) throw new Error("The original relay request changed while issuing.");
      const result = await running.promise; input.signal.throwIfAborted(); input.assertCurrent(); return result;
    }
    const credentials = application.credentials;
    if (credentials === undefined || application.linkspanIdentity === undefined) throw new Error("The original node's protected credential store is unavailable.");
    credentials.reserveManagedSecret({ credentialReferenceId: savedReference, kind: "header_secret", providerId: "iroh.relay-use" });
    if (credentials.find(savedReference) === undefined) throw new Error("The original relay lease outcome is unconfirmed. Inspect that operation before issuing a replacement.");
    let invitation: PrivateIrohRelayInvitation | undefined;
    try { invitation = (JSON.parse(credentials.resolve(savedReference)) as { invitation?: PrivateIrohRelayInvitation }).invitation; }
    catch { throw new Error("The original protected relay receipt is invalid."); }
    if (!invitation || invitation.requestId !== input.requestId || invitation.nodeEndpointId !== input.nodeEndpointId
      || invitation.recipientEndpointId !== input.recipientEndpointId || invitation.serverId !== application.serverId
      || invitation.endpointPublicKey !== application.linkspanIdentity.publicKey || !Number.isSafeInteger(invitation.expiresAt)) throw new Error("The original private relay invitation is invalid.");
    input.signal.throwIfAborted(); input.assertCurrent();
    // A lost response must remain queryable even after expiry or a later
    // deployment change. Return the exact old receipt; never extend or remint it.
    if (original.status !== "completed") application.store.completeDeferredEffectOperation(savedRequestId, original.bodyHash, current => {
      current.setSetting("service", "orchestrator", PREFIX + savedRequestId, { requestId: savedRequestId, reference: savedReference, state: "active", expiresAt: invitation!.expiresAt });
      return { state: "active", reference: savedReference, expiresAt: invitation!.expiresAt, scope: "relay:use", clientEndpointId: input.recipientEndpointId };
    });
    return invitation;
  }
  const issuer = issuers.get(application.store)?.get(input.nodeEndpointId);
  if (issuer === undefined || !issuer.configuration.servicesApiSecretPath || !issuer.configuration.relayUrls?.length) throw new Error("The selected node entrance has no live managed relay issuer.");
  const activeIssuer: ActiveIssuer = issuer;
  const ttlSeconds = issuer.configuration.relayLeaseTtlSeconds ?? 3600;
  if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 60 || ttlSeconds > 86400) throw new Error("The relay-use lease TTL must be from 60 to 86400 seconds.");
  const requestId = `linkspan-iroh-lease:${input.requestId}`, reference = `linkspan.iroh-lease:${requestId}`;
  const body = { entryId: issuer.entryId, nodeEndpointId: input.nodeEndpointId, clientEndpointId: input.recipientEndpointId,
    ownerConnectionId: input.ownerConnectionId, serverId: application.serverId, ttlSeconds };
  const bodyHash = operationBodyHash(body);
  let pending = issuing.get(application.store);
  if (pending === undefined) { pending = new Map(); issuing.set(application.store, pending); }
  const previous = pending.get(requestId);
  if (previous !== undefined) {
    if (previous.bodyHash !== bodyHash) throw new Error("The relay request identifier belongs to different original authority or recipient.");
    const result = await previous.promise; assertCurrent(); return result;
  }
  const promise = issue(); pending.set(requestId, { bodyHash, promise });
  try { return await promise; }
  finally { if (pending.get(requestId)?.promise === promise) pending.delete(requestId); }

  function assertCurrent(): void {
    input.signal.throwIfAborted(); input.assertCurrent();
    if (issuers.get(application.store)?.get(input.nodeEndpointId) !== activeIssuer) throw new Error("The original publishing entrance was retired.");
  }
  async function issue(): Promise<PrivateIrohRelayInvitation> {
    assertCurrent();
    const credentials = application.credentials;
    if (credentials === undefined || application.linkspanIdentity === undefined) throw new Error("The original node's protected credential store is unavailable.");
    credentials.reserveManagedSecret({ credentialReferenceId: reference, kind: "header_secret", providerId: "iroh.relay-use" });
    let operation = application.store.findOperation(requestId);
    if (operation !== undefined) {
      if (operation.kind !== "connection.iroh.relay-lease" || operation.connectionId !== undefined || operation.completionMode !== "external_effect"
        || operation.bodyHash !== bodyHash || operation.status === "failed") throw new Error("The original relay lease request conflicts with this owner or recipient.");
      if (credentials.find(reference) === undefined) throw new Error("The original relay lease outcome is unconfirmed. Inspect that operation before issuing a replacement.");
      const stored = JSON.parse(credentials.resolve(reference)) as { invitation?: PrivateIrohRelayInvitation };
      const invitation = stored.invitation;
      if (!invitation || invitation.requestId !== input.requestId || invitation.nodeEndpointId !== input.nodeEndpointId
        || invitation.recipientEndpointId !== input.recipientEndpointId || invitation.serverId !== application.serverId
        || invitation.endpointPublicKey !== application.linkspanIdentity.publicKey || !Number.isSafeInteger(invitation.expiresAt)) throw new Error("The original private relay invitation is unavailable.");
      assertCurrent();
      if (operation.status !== "completed") complete(operation.bodyHash, invitation.expiresAt);
      return invitation;
    }
    const record: LeaseRecord = { requestId, reference, state: "issuing" };
    operation = application.store.claimDeferredEffectOperation({ id: requestId, kind: "connection.iroh.relay-lease", body }, current => {
      current.setSetting("service", "orchestrator", PREFIX + requestId, record);
    }).operation;
    const secretPath = activeIssuer.configuration.servicesApiSecretPath!;
    if (!isAbsolute(secretPath)) throw new Error("The issuer secret requires an absolute private file.");
    const [secret, workspace, source] = await Promise.all([realpath(secretPath), realpath(application.config.workspace.root), realpath(fileURLToPath(new URL("../../../", import.meta.url)))]);
    if ([workspace, source].some(root => within(root, secret))) throw new Error("The issuer secret must remain outside source/workspace roots.");
    assertCurrent(); const apiSecret = await readIceToken(secret, input.signal); assertCurrent();
    const { issueIrohRelayLease } = await import("@jokoagent/linkspan-iroh-services");
    const lease = await issueIrohRelayLease({ apiSecret, endpointId: input.recipientEndpointId, ttlSeconds, signal: input.signal });
    assertCurrent();
    if (lease.endpointId !== input.recipientEndpointId || lease.scope !== "relay:use" || lease.expiresAt <= Date.now() || lease.expiresAt > Date.now() + 86400000) throw new Error("The provider returned an invalid recipient-bound relay lease.");
    const invitation: PrivateIrohRelayInvitation = { requestId: input.requestId, nodeEndpointId: input.nodeEndpointId, recipientEndpointId: input.recipientEndpointId,
      ticket: activeIssuer.ticket, relayUrls: activeIssuer.configuration.relayUrls!, relayToken: lease.relayToken, expiresAt: lease.expiresAt,
      origin: application.config.publicOrigin, serverId: application.serverId, endpointPublicKey: application.linkspanIdentity.publicKey };
    if (!await credentials.compareAndSetManagedSecret({ credentialReferenceId: reference, expectedSecret: undefined, secret: JSON.stringify({ invitation }),
      displayName: "Private recipient relay-use invitation", kind: "header_secret", providerId: "iroh.relay-use" })) throw new Error("The original private relay invitation receipt could not be saved.");
    assertCurrent(); complete(operation.bodyHash, lease.expiresAt); return invitation;
  }
  function complete(hash: string, expiresAt: number): void {
    application.store.completeDeferredEffectOperation(requestId, hash, current => {
      current.setSetting("service", "orchestrator", PREFIX + requestId, { requestId, reference, state: "active", expiresAt });
      return { state: "active", reference, expiresAt, scope: "relay:use", clientEndpointId: input.recipientEndpointId };
    });
  }
}

export function reserveIrohRelayLeaseCredentials(context: Pick<OfflineLinkspanContext, "store" | "credentials">): void {
  for (const { key, value } of context.store.listSettingsByKeyPrefix("service", "orchestrator", PREFIX)) {
    const record = value as LeaseRecord;
    if (!record || !/^linkspan-iroh-lease:[a-f0-9-]{36}$/u.test(record.requestId) || key !== PREFIX + record.requestId
      || record.reference !== `linkspan.iroh-lease:${record.requestId}`
      || context.store.findOperation(record.requestId)?.kind !== "connection.iroh.relay-lease") throw new Error("The original relay lease journal is invalid.");
    context.credentials?.reserveManagedSecret({ credentialReferenceId: record.reference, kind: "header_secret", providerId: "iroh.relay-use" });
  }
}

/** Only a short relay-use capability for B's public key leaves this local
 * administrator command. Neither B's private key nor the issuer secret does. */
export async function issuePrivateIrohRelayInvitation(context: OfflineLinkspanContext, input: {
  readonly entryId: string;
  readonly configuration: Extract<SdkDeployment, { provider: "iroh" }>;
  readonly clientEndpointId: string;
  readonly signal?: AbortSignal;
}) {
  const config = input.configuration, signal = input.signal ?? AbortSignal.timeout(30000);
  if (!/^[a-z][a-z0-9-]{0,63}$/u.test(input.entryId) || !/^[a-f0-9]{64}$/u.test(input.clientEndpointId)
    || !/^[a-f0-9]{64}$/u.test(config.secretKeyHex) || !config.servicesApiSecretPath
    || !isAbsolute(config.servicesApiSecretPath) || !isAbsolute(config.invitationDirectory)
    || !Array.isArray(config.relayUrls) || config.relayUrls.length < 1 || config.relayUrls.length > 8) throw new Error("A relay invitation requires the selected server identity, explicit relay URLs, a private issuer-secret file and B's trusted public key.");
  const ttlSeconds = config.relayLeaseTtlSeconds ?? 3600;
  if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 60 || ttlSeconds > 86400) throw new Error("The relay-use lease TTL must be from 60 to 86400 seconds.");
  const excluded = await Promise.all([context.config.workspace.root, fileURLToPath(new URL("../../../", import.meta.url))].map(root => realpath(root)));
  const [secretPath, directory] = await Promise.all([realpath(config.servicesApiSecretPath), realpath(config.invitationDirectory)]);
  if (excluded.some(root => within(root, secretPath) || within(root, directory))) throw new Error("The issuer secret and private invitation directory must remain outside source/workspace roots.");
  await inspectKeyDirectoryPermissions(directory, signal);
  if (!context.credentials || !context.linkspanIdentity) throw new Error("The original node's protected identity and credential store are required.");
  const credentials = context.credentials;
  const { issueIrohRelayLease, irohPublicKeyFromPrivateKey, createIrohTicket } = await import("@jokoagent/linkspan-iroh-services");
  const endpointId = await irohPublicKeyFromPrivateKey(Buffer.from(config.secretKeyHex, "hex"));
  const ticket = await createIrohTicket({ endpointId, relayUrls: config.relayUrls });
  signal.throwIfAborted();
  const requestId = `linkspan-iroh-lease:${randomUUID()}`, reference = `linkspan.iroh-lease:${requestId}`;
  const record: LeaseRecord = { requestId, reference, state: "issuing" };
  const claim = context.store.claimDeferredEffectOperation({ id: requestId, kind: "connection.iroh.relay-lease", body: {
    entryId: input.entryId, clientEndpointId: input.clientEndpointId, nodeEndpointId: endpointId, ttlSeconds, serverId: context.serverId
  } }, current => { current.setSetting("service", "orchestrator", PREFIX + requestId, record); });
  credentials.reserveManagedSecret({ credentialReferenceId: reference, kind: "header_secret", providerId: "iroh.relay-use" });
  const apiSecret = await readIceToken(secretPath, signal);
  const lease = await issueIrohRelayLease({ apiSecret, endpointId: input.clientEndpointId, ttlSeconds, signal });
  signal.throwIfAborted();
  const invitation = { version: 1, origin: context.config.publicOrigin, serverId: context.serverId, endpointPublicKey: context.linkspanIdentity.publicKey,
    endpointTransport: { kind: "iroh", endpointId, ticket, clientEndpointId: input.clientEndpointId,
      relayUrls: config.relayUrls, relayToken: lease.relayToken, relayTokenExpiresAt: lease.expiresAt } };
  const invitationPath = join(directory, `${input.entryId}-relay-${requestId.split(":").at(-1)}.json`);
  if (!await credentials.compareAndSetManagedSecret({ credentialReferenceId: reference, expectedSecret: undefined,
    secret: JSON.stringify({ lease, invitationPath }), displayName: "Private relay-use lease", kind: "header_secret", providerId: "iroh.relay-use" })) throw new Error("The original relay lease receipt could not be saved. Reconcile its operation before issuing a replacement.");
  signal.throwIfAborted();
  await writeFile(invitationPath, JSON.stringify(invitation) + "\n", { flag: "wx", mode: 0o600 });
  context.store.completeDeferredEffectOperation(requestId, claim.operation.bodyHash, current => {
    current.setSetting("service", "orchestrator", PREFIX + requestId, { ...record, state: "active", expiresAt: lease.expiresAt });
    return { state: "active", reference, expiresAt: lease.expiresAt, scope: lease.scope, clientEndpointId: input.clientEndpointId };
  });
  return { requestId, invitationPath, expiresAt: lease.expiresAt, scope: lease.scope, individualRevocation: false };
}
function within(root: string, candidate: string): boolean {
  const suffix = relative(resolve(root), resolve(candidate)); return !suffix || suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix);
}
