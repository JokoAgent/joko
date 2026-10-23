import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { create, fromJsonString, toJsonString } from "@bufbuild/protobuf";
import { Code, ConnectError, createClient, type Client, type Interceptor } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import * as contract from "@joko/contracts";
import { networkHash, networkHumanId, networkIdentity } from "@joko/store";
import type { CredentialVault, EncryptedCredential } from "./credential-vault.js";
import { networkDigest, parsePartnerNetworkInvitation, type PartnerNetworkAuthority } from "./partner-network-host.js";
import { isLoopbackHost, isPrivateLanHttpOrigin } from "./config.js";

export interface PartnerNetworkRemote {
  readonly client: Client<typeof contract.PartnerNetworkGuestService>;
  verify(signal: AbortSignal): Promise<void>;
}
export interface PartnerNetworkRemoteOptions {
  readonly origin: string; readonly serverId: string; readonly authorization?: () => string; readonly assertCurrent: () => void;
  readonly allowInsecureLan?: boolean;
}
interface Joined {
  readonly id: string; readonly operationId: string; readonly fingerprint: string; readonly origin: string; readonly serverId: string;
  readonly roomId: string; readonly memberId: string; readonly deviceId: string; readonly secret: EncryptedCredential;
  readonly displayName: string; status: "prepared" | "unknown" | "joined" | "left"; room: string;
}
interface HomeDisk { readonly format: 1; readonly serverId: string; readonly joined: readonly Joined[]; }

/** Home retains private membership credentials and a directory, never a second room authority. */
export class PartnerNetworkHome {
  readonly #joined = new Map<string, Joined>();
  readonly #flights = new Map<string, Promise<unknown>>();
  readonly #lifetime = new AbortController();
  #saveFlight = Promise.resolve();
  constructor(readonly options: { readonly directory: string; readonly serverId: string; readonly vault: CredentialVault;
    readonly partner: (id: string) => { id: string; name: string; description: string };
    readonly connect?: (options: PartnerNetworkRemoteOptions) => PartnerNetworkRemote; readonly allowInsecureLan?: boolean }) {}
  async initialize(): Promise<void> {
    await mkdir(this.options.directory, { recursive: true, mode: 0o700 }); let text: string;
    try { text = await readFile(join(this.options.directory, "memberships.json"), "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    if (Buffer.byteLength(text) > 8 * 1024 * 1024) throw invalid(); const disk = JSON.parse(text) as HomeDisk;
    if (disk.format !== 1 || disk.serverId !== this.options.serverId || !Array.isArray(disk.joined)) throw invalid();
    for (const row of disk.joined) {
      [row.id, row.operationId, row.serverId, row.roomId, row.memberId, row.deviceId].forEach(networkIdentity); partnerNetworkOrigin(row.origin, this.options.allowInsecureLan);
      if (this.#joined.has(row.id) || !/^[a-f0-9]{64}$/u.test(row.fingerprint) || !["prepared", "unknown", "joined", "left"].includes(row.status)) throw invalid();
      this.#validateRoom(fromJsonString(contract.PartnerNetworkRoomSchema, row.room), row);
      this.#joined.set(row.id, { ...row, status: row.status === "prepared" ? "unknown" : row.status });
    }
  }
  get signal(): AbortSignal { return this.#lifetime.signal; }
  #check(auth?: Pick<PartnerNetworkAuthority, "signal" | "assertCurrent">): void { this.#lifetime.signal.throwIfAborted(); auth?.signal.throwIfAborted(); auth?.assertCurrent(); }
  #reference(row: Pick<Joined, "id" | "serverId" | "roomId" | "memberId">): string { return `conversation:${this.options.serverId}:${row.id}:${row.serverId}:${row.roomId}:${row.memberId}`; }
  #get(joinId: string): Joined { const row = this.#joined.get(networkIdentity(joinId)); if (!row || row.status === "prepared" || row.status === "unknown") throw new ConnectError("Read the original join result before continuing.", Code.FailedPrecondition); return row; }
  #client(row: Joined, auth?: Pick<PartnerNetworkAuthority, "signal" | "assertCurrent">, terminal = false): PartnerNetworkRemote {
    const check = () => { this.#check(auth); if (this.#joined.get(row.id) !== row || row.status !== "joined" && !(terminal && row.status === "left")) throw denied(); };
    partnerNetworkOrigin(row.origin, this.options.allowInsecureLan);
    return (this.options.connect ?? createPartnerNetworkRemote)({ origin: row.origin, serverId: row.serverId, allowInsecureLan: this.options.allowInsecureLan === true,
      assertCurrent: check, authorization: () => { check(); const secret = JSON.parse(this.options.vault.open(row.secret, this.#reference(row))) as { credential: string };
        if (!/^[A-Za-z0-9_-]{43}$/u.test(secret.credential)) throw denied(); return `Bearer joko-conversation-${secret.credential}`; } });
  }
  async preview(invitation: string, auth: PartnerNetworkAuthority): Promise<contract.PreviewPartnerNetworkResponse> {
    this.#check(auth); const parsed = parsePartnerNetworkInvitation(invitation);
    partnerNetworkOrigin(parsed.origin, this.options.allowInsecureLan);
    if (parsed.serverId === this.options.serverId) throw new ConnectError("Open this node's group directly.", Code.FailedPrecondition);
    const remote = (this.options.connect ?? createPartnerNetworkRemote)({ origin: parsed.origin, serverId: parsed.serverId, allowInsecureLan: this.options.allowInsecureLan === true, assertCurrent: () => this.#check(auth) });
    await remote.verify(auth.signal); this.#check(auth);
    const result = await remote.client.inspectPartnerNetwork({ invitation }, { signal: auth.signal }); this.#check(auth);
    if (!result.room || result.room.hostServerId !== parsed.serverId || result.room.hostOrigin !== parsed.origin || !result.link || result.link.roomId !== result.room.id) throw invalid();
    return create(contract.PreviewPartnerNetworkResponseSchema, { ...result, $typeName: undefined });
  }
  join(request: contract.JoinPartnerNetworkRequest, auth: PartnerNetworkAuthority): Promise<contract.PartnerNetworkRoom> {
    const fingerprint = networkHash([request.invitation, request.displayName, auth.deviceId]), key = networkIdentity(request.operationId);
    return this.#single(key, async () => {
      this.#check(auth); let row = [...this.#joined.values()].find(item => item.operationId === key);
      if (row && row.fingerprint !== fingerprint) throw new ConnectError("This join operation has different input.", Code.AlreadyExists);
      if (row?.status === "joined" || row?.status === "left") return this.#public(row);
      if (!row) {
        const preview = await this.preview(request.invitation, auth); this.#check(auth); const room = preview.room!;
        const id = randomUUID(), memberId = networkHumanId(this.options.serverId), credential = randomBytes(32).toString("base64url");
        const identity = { id, serverId: room.hostServerId, roomId: room.id, memberId };
        row = { ...identity, operationId: key, fingerprint, deviceId: auth.deviceId, origin: room.hostOrigin, displayName: request.displayName,
          secret: this.options.vault.seal(JSON.stringify({ credential, invitation: request.invitation }), this.#reference(identity)), status: "prepared", room: toJsonString(contract.PartnerNetworkRoomSchema, room) };
        this.#joined.set(id, row); await this.#save(); this.#check(auth);
      }
      row.status = "unknown"; await this.#save(); this.#check(auth);
      const selected = row;
      const remote = (this.options.connect ?? createPartnerNetworkRemote)({ origin: row.origin, serverId: row.serverId, allowInsecureLan: this.options.allowInsecureLan === true, assertCurrent: () => this.#check(auth) });
      await remote.verify(auth.signal); this.#check(auth);
      const secret = JSON.parse(this.options.vault.open(row.secret, this.#reference(row))) as { credential: string; invitation: string };
      const result = await remote.client.acceptPartnerNetwork({ operationId: row.operationId, invitation: secret.invitation, homeServerId: this.options.serverId,
        displayName: row.displayName, credentialSha256: networkDigest(secret.credential) }, { signal: auth.signal }); this.#check(auth);
      if (!result.room || result.memberId !== row.memberId) throw invalid(); this.#validateRoom(result.room, row);
      selected.room = toJsonString(contract.PartnerNetworkRoomSchema, result.room); selected.status = "joined"; await this.#save(); this.#check(auth); return this.#public(selected);
    });
  }
  #public(row: Joined): contract.PartnerNetworkRoom {
    const room = fromJsonString(contract.PartnerNetworkRoomSchema, row.room); return create(contract.PartnerNetworkRoomSchema, { ...room, selfId: row.memberId, joinId: row.id,
      availability: row.status === "joined" ? room.availability : row.status === "left" ? "denied" : "joining" });
  }
  directory(): contract.PartnerNetworkRoom[] { return [...this.#joined.values()].map(row => this.#public(row)); }
  async refresh(auth?: Pick<PartnerNetworkAuthority, "signal" | "assertCurrent">): Promise<contract.PartnerNetworkRoom[]> {
    this.#check(auth);
    const rows = [...this.#joined.values()].filter(row => row.status === "joined"); let next = 0;
    await Promise.all(Array.from({ length: Math.min(4, rows.length) }, async () => {
      for (;;) { const row = rows[next++]; if (!row) break;
        try { await this.snapshot(create(contract.GetPartnerNetworkRequestSchema, { roomId: row.roomId, joinId: row.id }), auth); }
        catch (error) { this.#check(auth); const room = fromJsonString(contract.PartnerNetworkRoomSchema, row.room);
          row.room = toJsonString(contract.PartnerNetworkRoomSchema, { ...room, availability: error instanceof ConnectError && [Code.PermissionDenied, Code.Unauthenticated].includes(error.code) ? "denied" : "unavailable" }); }
      }
    }));
    await this.#save(); this.#check(auth); return this.directory();
  }
  async snapshot(request: contract.GetPartnerNetworkRequest, auth?: Pick<PartnerNetworkAuthority, "signal" | "assertCurrent">): Promise<contract.PartnerNetworkSnapshot> {
    const row = this.#room(request.joinId, request.roomId), result = await this.#client(row, auth).client.getPartnerNetwork({ ...request, $typeName: undefined }, { signal: auth?.signal ?? this.signal }); this.#check(auth);
    if (!result.snapshot?.room) throw invalid(); this.#validateRoom(result.snapshot.room, row);
    row.room = toJsonString(contract.PartnerNetworkRoomSchema, result.snapshot.room); await this.#save(); this.#check(auth);
    return create(contract.PartnerNetworkSnapshotSchema, { ...result.snapshot, room: this.#public(row) });
  }
  async failures(request: contract.ReadPartnerNetworkFailuresRequest, auth: PartnerNetworkAuthority): Promise<contract.ReadPartnerNetworkFailuresResponse> {
    if (request.sourceMessageIds.length > 100) throw invalid();
    const row = this.#room(request.joinId, request.roomId), response = await this.#client(row, auth).client.readPartnerNetworkFailures({ ...request, $typeName: undefined }, { signal: auth.signal }); this.#check(auth);
    const selected = new Set(request.sourceMessageIds);
    if (response.executions.some(job => job.roomId !== row.roomId || !selected.has(job.sourceMessageId) || !["failed", "unknown"].includes(job.status)
      || !contract.isPartnerNetworkFailureCode(job.failureCode) && job.failureCode !== "input-unavailable")) throw invalid();
    return create(contract.ReadPartnerNetworkFailuresResponseSchema, { ...response, $typeName: undefined });
  }
  async send(request: contract.SendPartnerNetworkRequest, auth: PartnerNetworkAuthority): Promise<contract.PartnerNetworkMessage> {
    const row = this.#room(request.joinId, request.roomId), response = await this.#client(row, auth).client.sendPartnerNetwork({ ...request, $typeName: undefined }, { signal: auth.signal }); this.#check(auth);
    if (!response.message) throw invalid(); return response.message;
  }
  async plan(request: contract.PlanPartnerNetworkRequest, auth: PartnerNetworkAuthority): Promise<contract.PlanPartnerNetworkResponse> {
    const row = this.#room(request.joinId, request.roomId), result = await this.#client(row, auth).client.planPartnerNetwork({ ...request, $typeName: undefined }, { signal: auth.signal }); this.#check(auth);
    if (!result.snapshot?.room) throw invalid(); this.#validateRoom(result.snapshot.room, row);
    if (result.plan && result.plan.roomId !== row.roomId) throw invalid();
    row.room = toJsonString(contract.PartnerNetworkRoomSchema, result.snapshot.room); await this.#save(); this.#check(auth);
    return create(contract.PlanPartnerNetworkResponseSchema, { ...result, $typeName: undefined, snapshot: { ...result.snapshot, room: this.#public(row) } });
  }
  async invite(request: contract.InvitePartnerNetworkRequest, auth: PartnerNetworkAuthority): Promise<contract.InvitePartnerNetworkResponse> {
    const row = this.#room(request.joinId, request.roomId), result = await this.#client(row, auth).client.invitePartnerNetwork({ ...request, $typeName: undefined }, { signal: auth.signal }); this.#check(auth);
    return create(contract.InvitePartnerNetworkResponseSchema, { ...result, $typeName: undefined });
  }
  async manage(request: contract.ManagePartnerNetworkRequest, auth: PartnerNetworkAuthority): Promise<contract.PartnerNetworkRoom> {
    const row = this.#room(request.joinId, request.roomId);
    let partner: contract.PartnerNetworkActor | undefined;
    if (request.action === "add-partner") { const local = this.options.partner(request.actorId); partner = create(contract.PartnerNetworkActorSchema,
      { partnerId: local.id, name: local.name, description: local.description }); }
    const result = await this.#client(row, auth, ["remove-list", "restore-list"].includes(request.action)).client.managePartnerNetwork({ ...request, $typeName: undefined, ...(partner ? { partner } : {}) }, { signal: auth.signal }); this.#check(auth);
    if (!result.room) throw invalid(); this.#validateRoom(result.room, row);
    row.room = toJsonString(contract.PartnerNetworkRoomSchema, result.room); if (request.action === "leave") row.status = "left";
    await this.#save(); this.#check(auth); return this.#public(row);
  }
  async react(request: contract.ReactPartnerNetworkRequest, auth: PartnerNetworkAuthority): Promise<contract.PartnerNetworkMessage> {
    const row = this.#room(request.joinId, request.roomId), response = await this.#client(row, auth).client.reactPartnerNetwork({ ...request, $typeName: undefined }, { signal: auth.signal }); this.#check(auth);
    if (!response.message) throw invalid(); return response.message;
  }
  async media(request: contract.MediaPartnerNetworkRequest, auth: PartnerNetworkAuthority): Promise<contract.MediaPartnerNetworkResponse> {
    const row = this.#room(request.joinId, request.roomId), response = await this.#client(row, auth).client.mediaPartnerNetwork({ ...request, $typeName: undefined }, { signal: auth.signal }); this.#check(auth);
    return create(contract.MediaPartnerNetworkResponseSchema, { ...response, $typeName: undefined });
  }
  async claim(joinId: string, actorId: string): Promise<contract.ClaimPartnerNetworkResponse> {
    const row = this.#get(joinId), result = await this.#client(row).client.claimPartnerNetwork({ roomId: row.roomId, actorId }, { signal: this.signal }); this.#check();
    if (result.execution && (result.execution.roomId !== row.roomId || result.execution.actorId !== actorId || !result.snapshot?.room)) throw invalid();
    if (result.snapshot?.room) this.#validateRoom(result.snapshot.room, row); return result;
  }
  async settle(joinId: string, request: contract.SettlePartnerNetworkRequest): Promise<contract.PartnerNetworkExecution> {
    const row = this.#room(joinId, request.roomId), result = await this.#client(row).client.settlePartnerNetwork(request, { signal: this.signal }); this.#check();
    if (!result.execution || result.execution.id !== request.executionId || result.execution.lease !== request.lease) throw invalid(); return result.execution;
  }
  async readExecution(joinId: string, request: contract.GetPartnerNetworkExecutionRequest): Promise<contract.GetPartnerNetworkExecutionResponse> {
    const row = this.#room(joinId, request.roomId), result = await this.#client(row).client.getPartnerNetworkExecution(request, { signal: this.signal }); this.#check();
    if (!result.execution || result.execution.id !== request.executionId || result.execution.lease !== request.lease || !result.snapshot?.room) throw invalid();
    this.#validateRoom(result.snapshot.room, row); return result;
  }
  async publish(joinId: string, request: contract.PublishPartnerNetworkActorRequest): Promise<contract.PartnerNetworkMessage> {
    const row = this.#room(joinId, request.roomId), result = await this.#client(row).client.publishPartnerNetworkActor(request, { signal: this.signal }); this.#check();
    if (!result.message || result.message.authorId !== request.actorId) throw invalid(); return result.message;
  }
  #room(joinId: string, roomId: string): Joined { const row = this.#get(joinId); if (row.roomId !== roomId) throw denied(); return row; }
  #validateRoom(room: contract.PartnerNetworkRoom, row: Pick<Joined, "roomId" | "serverId" | "origin" | "memberId">): void {
    if (room.id !== row.roomId || room.hostServerId !== row.serverId || room.hostOrigin !== row.origin || room.revision < 1n
      || room.selfId && room.selfId !== row.memberId || !["active", "archived", "dissolved"].includes(room.state)) throw invalid();
  }
  #single<T>(key: string, task: () => Promise<T>): Promise<T> { const old = this.#flights.get(key); if (old) return old as Promise<T>;
    const pending = task().finally(() => this.#flights.delete(key)); this.#flights.set(key, pending); return pending; }
  #save(): Promise<void> {
    const value: HomeDisk = { format: 1, serverId: this.options.serverId, joined: [...this.#joined.values()].map(row => ({ ...row })) }, bytes = JSON.stringify(value);
    if (Buffer.byteLength(bytes) > 8 * 1024 * 1024) throw invalid();
    const promise = this.#saveFlight.then(async () => { const temporary = join(this.options.directory, `.memberships-${randomUUID()}.tmp`);
      try { const file = await open(temporary, "wx", 0o600); try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
        await rename(temporary, join(this.options.directory, "memberships.json")); } finally { await unlink(temporary).catch(() => {}); } });
    this.#saveFlight = promise.catch(() => {}); return promise;
  }
  async close(): Promise<void> { this.#lifetime.abort(); await this.#saveFlight; }
}
export function createPartnerNetworkRemote(options: PartnerNetworkRemoteOptions): PartnerNetworkRemote {
  const baseUrl = partnerNetworkOrigin(options.origin, options.allowInsecureLan), identity = createClient(contract.ConnectionService, createConnectTransport({ baseUrl, httpVersion: "1.1", defaultTimeoutMs: 10_000 }));
  const verify = async (signal: AbortSignal) => { options.assertCurrent(); signal.throwIfAborted(); const result = await identity.getServerInfo({}, { signal });
    options.assertCurrent(); signal.throwIfAborted(); if (result.server?.serverId !== options.serverId) throw denied(); };
  const authorization: Interceptor = next => async request => { await verify(request.signal); options.assertCurrent(); const secret = options.authorization?.();
    if (secret) request.header.set("authorization", secret); const result = await next(request); options.assertCurrent(); return result; };
  return { verify, client: createClient(contract.PartnerNetworkGuestService, createConnectTransport({ baseUrl, httpVersion: "1.1", useBinaryFormat: true,
    readMaxBytes: 1024 * 1024, writeMaxBytes: 1024 * 1024, defaultTimeoutMs: 15_000, interceptors: [authorization] })) };
}
export function partnerNetworkOrigin(value: string, allowInsecureLan = false): string {
  const origin = contract.taskShareOrigin(value), parsed = new URL(origin);
  if (parsed.protocol !== "https:" && !isLoopbackHost(parsed.hostname) && !(allowInsecureLan && isPrivateLanHttpOrigin(origin))) throw new ConnectError("Use HTTPS, loopback, or the node's explicitly enabled private LAN transport.", Code.InvalidArgument);
  return origin;
}
function denied(): ConnectError { return new ConnectError("This conversation membership is unavailable or changed.", Code.PermissionDenied); }
function invalid(): ConnectError { return new ConnectError("The conversation response is invalid.", Code.InvalidArgument); }
