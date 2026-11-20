import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, type HandlerContext, type ServiceImpl } from "@connectrpc/connect";
import { fastifyConnectPlugin } from "@connectrpc/connect-fastify";
import * as contract from "@joko/contracts";
import { DESKTOP_HOST_AUTHORIZATION_HEADER } from "@joko/contracts/desktop-bootstrap";
import type { ConnectionRecord, OperationalStore } from "@joko/store";
import type { FastifyInstance } from "fastify";
import { isLoopbackHost } from "./config.js";
import type { ConnectionManager } from "./connection-manager.js";
import { createHostedAgentConnectService } from "./hosted-agent-connect-service.js";
import type { HostedAgentPrincipal } from "./hosted-agent-host.js";
import type { HostedAgentRuntime } from "./hosted-agent-runtime.js";
import { decodeHostedAgentCall, decodeHostedAgentOpen, encodeHostedAgentValue, HOSTED_AGENT_WIRE_ENVELOPE_BYTES,
  HOSTED_AGENT_WIRE_FORMAT, HostedAgentWireError } from "./hosted-agent-wire.js";

const scope = "local-agent-applications";
const requestLifetimeMs = 120_000;
const maximumRequests = 8;
const maximumGrants = 32;
const tokenPattern = /^[A-Za-z0-9_-]{43}$/u;

interface ApplicationIdentity { readonly clientId: string; readonly displayName: string }
interface Grant {
  readonly version: 1;
  readonly id: string;
  readonly application: ApplicationIdentity;
  readonly owner: Pick<ConnectionRecord, "id" | "authKeyDigest" | "deviceId">;
  readonly digest: string;
  readonly grantedAt: number;
  readonly retired: boolean;
}
interface AccessRequest {
  readonly id: string;
  readonly application: ApplicationIdentity;
  readonly digest: string;
  readonly expiresAt: number;
  decision?: { readonly kind: "denied" } | { readonly kind: "approved"; readonly grantId: string; readonly token: string };
}
interface Options {
  readonly store: OperationalStore;
  readonly connections: ConnectionManager;
  readonly runtime: Pick<HostedAgentRuntime, "localApplicationOptions" | "retireLocalApplication">;
  readonly now?: () => number;
}

/** Owns one managed node's application requests, grants and native cleanup. */
export class LocalAgentApplications {
  readonly #requests = new Map<string, AccessRequest>();
  readonly #principals = new Map<string, HostedAgentPrincipal>();
  readonly #retirements = new Map<string, Promise<void>>();
  readonly #maintenance: ReturnType<typeof setInterval>;
  #closed = false;

  constructor(private readonly options: Options) {
    this.#maintenance = setInterval(() => { this.#sweep(); }, 5_000);
    this.#maintenance.unref();
  }

  applicationService(): ServiceImpl<typeof contract.LocalAgentService> {
    const native = createHostedAgentConnectService(this.options.runtime.localApplicationOptions(context => this.#authenticate(context)));
    return {
      requestLocalAgentAccess: (request, context) => {
        this.#assertOpen(context);
        this.#pruneRequests();
        const application = applicationIdentity(request.application);
        if (this.#requests.size >= maximumRequests) throw new ConnectError("Too many local application requests.", Code.ResourceExhausted);
        const id = secret(), claim = secret(), expiresAt = this.#now() + requestLifetimeMs;
        this.#requests.set(id, { id, application, digest: hash(claim), expiresAt });
        return create(contract.RequestLocalAgentAccessResponseSchema, { requestId: id, claim, expiresAtUnixMs: BigInt(expiresAt) });
      },
      readLocalAgentAccess: (request, context) => {
        const pending = this.#claim(request.requestId, request.claim, context);
        if (pending.decision?.kind === "approved") {
          this.#assertGrant(pending.decision.grantId);
          return create(contract.ReadLocalAgentAccessResponseSchema, { state: contract.LocalAgentAccessState.APPROVED,
            grantId: pending.decision.grantId, token: pending.decision.token });
        }
        return create(contract.ReadLocalAgentAccessResponseSchema, { state: pending.decision?.kind === "denied"
          ? contract.LocalAgentAccessState.DENIED : contract.LocalAgentAccessState.PENDING });
      },
      cancelLocalAgentAccess: async (request, context) => {
        const pending = this.#claim(request.requestId, request.claim, context);
        this.#requests.delete(pending.id);
        if (pending.decision?.kind === "approved") {
          const grant = this.#getGrant(pending.decision.grantId);
          if (grant) await this.#revoke(grant);
        }
        return create(contract.CancelLocalAgentAccessResponseSchema);
      },
      listLocalAgentModels: async (_request, context) => {
        const catalog = await native.getHostedAgentCatalog(create(contract.GetHostedAgentCatalogRequestSchema, { format: HOSTED_AGENT_WIRE_FORMAT }), context);
        return create(contract.ListLocalAgentModelsResponseSchema, { backends: catalog.backends });
      },
      openLocalAgent: async (request, context) => {
        this.#authenticate(context);
        if (request.open === undefined) throw invalid();
        const input = decodeLocalOpen(request.open.openJson);
        const result = await native.openHostedAgent(create(contract.OpenHostedAgentRequestSchema, { ...request.open, openJson: input }), context);
        return create(contract.OpenLocalAgentResponseSchema, { result });
      },
      callLocalAgent: async (request, context) => {
        this.#authenticate(context);
        if (request.call === undefined) throw invalid();
        const command = decodeLocalCall(request.call.commandJson);
        const result = await native.callHostedAgent(create(contract.CallHostedAgentRequestSchema, { ...request.call, commandJson: command }), context);
        return create(contract.CallLocalAgentResponseSchema, { result });
      },
      pollLocalAgents: async (request, context) => {
        if (request.poll === undefined) throw invalid();
        const result = await native.pollHostedAgents(request.poll, context);
        return create(contract.PollLocalAgentsResponseSchema, { result });
      },
      replyLocalAgent: async (request, context) => {
        if (request.reply === undefined) throw invalid();
        const result = await native.replyHostedAgent(request.reply, context);
        return create(contract.ReplyLocalAgentResponseSchema, { result });
      },
      readLocalAgentArtifact: async (request, context) => {
        if (request.read === undefined) throw invalid();
        const result = await native.readHostedAgentArtifact(request.read, context);
        return create(contract.ReadLocalAgentArtifactResponseSchema, { result });
      },
      closeLocalAgent: async (request, context) => {
        if (request.close === undefined) throw invalid();
        const result = await native.closeHostedAgent(request.close, context);
        return create(contract.CloseLocalAgentResponseSchema, { result });
      }
    };
  }

  desktopService(): ServiceImpl<typeof contract.DesktopLocalAgentService> {
    return {
      listDesktopLocalAgents: (_request, context) => {
        const owner = this.#desktop(context);
        this.#pruneRequests();
        const requests = [...this.#requests.values()].filter(request => request.decision === undefined);
        const grants = this.#grants().filter(grant => sameOwner(grant, owner));
        return create(contract.ListDesktopLocalAgentsResponseSchema, {
          requests: requests.map(request => ({ requestId: request.id, application: request.application, expiresAtUnixMs: BigInt(request.expiresAt) })),
          grants: grants.map(grant => ({ grantId: grant.id, application: grant.application, grantedAtUnixMs: BigInt(grant.grantedAt), retired: grant.retired }))
        });
      },
      decideDesktopLocalAgentAccess: (request, context) => {
        const owner = this.#desktop(context);
        this.#pruneRequests();
        const pending = this.#requests.get(request.requestId);
        if (pending === undefined || pending.decision !== undefined) throw new ConnectError("The local application request has ended.", Code.NotFound);
        if (request.allow) {
          if (this.#grants().length >= maximumGrants) throw new ConnectError("Too many local application grants.", Code.ResourceExhausted);
          const id = secret(), token = secret();
          const grant: Grant = { version: 1, id, application: pending.application, owner: {
            id: owner.id, deviceId: owner.deviceId, authKeyDigest: owner.authKeyDigest
          }, digest: hash(token), grantedAt: this.#now(), retired: false };
          this.options.store.setSetting("service", scope, id, grant);
          pending.decision = { kind: "approved", grantId: id, token };
        } else pending.decision = { kind: "denied" };
        return create(contract.DecideDesktopLocalAgentAccessResponseSchema);
      },
      revokeDesktopLocalAgentAccess: async (request, context) => {
        const owner = this.#desktop(context);
        const grant = this.#getGrant(request.grantId);
        if (grant !== undefined && !sameOwner(grant, owner)) throw new ConnectError("The local application grant is unavailable.", Code.NotFound);
        if (grant) await this.#revoke(grant);
        this.#desktop(context);
        return create(contract.RevokeDesktopLocalAgentAccessResponseSchema);
      }
    };
  }

  async close(): Promise<void> {
    this.#closed = true;
    clearInterval(this.#maintenance);
    this.#requests.clear();
    await Promise.allSettled(this.#retirements.values());
  }

  #getGrant(id: string): Grant | undefined {
    if (!tokenPattern.test(id)) return undefined;
    return readGrant(id, this.options.store.findSetting<unknown>("service", scope, id)?.value);
  }

  #grants(): Grant[] {
    return this.options.store.listSettings("service", scope).flatMap(item => {
      const grant = readGrant(item.key, item.value);
      return grant === undefined ? [] : [grant];
    });
  }

  #assertGrant(id: string): Grant {
    const grant = this.#getGrant(id);
    if (this.#closed || grant === undefined || grant.retired || !this.options.connections.isLocalDesktopHostConnection(grant.owner)) {
      throw new ConnectError("The local application grant is unavailable.", Code.Unauthenticated);
    }
    return grant;
  }

  #principal(id: string): HostedAgentPrincipal {
    const existing = this.#principals.get(id);
    if (existing !== undefined) return existing;
    const identity = `local-application:${id}`;
    const principal: HostedAgentPrincipal = {
      id: identity, deviceId: identity, trust: "guest", localApplication: true,
      assertCurrent: () => { this.#assertGrant(id); }
    };
    this.#principals.set(id, principal);
    return principal;
  }

  #authenticate(context: HandlerContext): HostedAgentPrincipal {
    this.#assertOpen(context);
    const credential = /^LocalAgent ([A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{43})$/u.exec(context.requestHeader.get("authorization") ?? "");
    if (credential === null) throw new ConnectError("Local application authorization is required.", Code.Unauthenticated);
    const grant = this.#assertGrant(credential[1]!);
    if (!equalDigest(grant.digest, credential[2]!)) throw new ConnectError("Local application authorization is required.", Code.Unauthenticated);
    return this.#principal(grant.id);
  }

  #desktop(context: HandlerContext): ConnectionRecord {
    this.#assertOpen(context);
    try {
      const connection = this.options.connections.authenticate(context.requestHeader.get("authorization") ?? undefined);
      return this.options.connections.authenticateDesktopHost(connection, context.requestHeader.get(DESKTOP_HOST_AUTHORIZATION_HEADER) ?? undefined);
    } catch {
      throw new ConnectError("Managed Desktop approval is required.", Code.Unauthenticated);
    }
  }

  #claim(id: string, claim: string, context: HandlerContext): AccessRequest {
    this.#assertOpen(context);
    this.#pruneRequests();
    const pending = this.#requests.get(id);
    if (!pending || !tokenPattern.test(claim) || !equalDigest(pending.digest, claim)) {
      throw new ConnectError("The local application request is unavailable.", Code.NotFound);
    }
    return pending;
  }

  #pruneRequests(): void {
    const now = this.#now();
    for (const [id, request] of this.#requests) if (request.expiresAt <= now) this.#requests.delete(id);
  }

  #revoke(grant: Grant): Promise<void> {
    const running = this.#retirements.get(grant.id);
    if (running !== undefined) return running;
    // Fence the token durably before waiting for its exact native cleanup.
    if (!grant.retired) this.options.store.setSetting("service", scope, grant.id, { ...grant, retired: true });
    for (const [id, request] of this.#requests) if (request.decision?.kind === "approved" && request.decision.grantId === grant.id) this.#requests.delete(id);
    const retirement = this.options.runtime.retireLocalApplication(this.#principal(grant.id)).then(() => {
      this.options.store.deleteSetting("service", scope, grant.id);
      this.#principals.delete(grant.id);
    }).catch(() => {
      throw new ConnectError("The local application has retired. Native cleanup is still pending.", Code.Unavailable);
    }).finally(() => { this.#retirements.delete(grant.id); });
    this.#retirements.set(grant.id, retirement);
    return retirement;
  }

  #sweep(): void {
    if (this.#closed) return;
    this.#pruneRequests();
    for (const grant of this.#grants()) {
      if (grant.retired || !this.options.connections.isLocalDesktopHostConnection(grant.owner)) void this.#revoke(grant).catch(() => {});
    }
  }

  #assertOpen(context: HandlerContext): void {
    if (this.#closed) throw new ConnectError("Local application access is unavailable.", Code.Unavailable);
    context.signal.throwIfAborted();
  }
  #now(): number { return this.options.now?.() ?? Date.now(); }
}

export async function registerLocalAgentServices(server: FastifyInstance, applications: LocalAgentApplications, managementOnly: boolean): Promise<void> {
  if (!managementOnly) server.addHook("preClose", () => applications.close());
  await server.register(async scope => {
    scope.addHook("onRequest", async (request, reply) => {
      const peer = request.raw.socket.remoteAddress, local = request.raw.socket.localAddress;
      if (!isLoopbackHost(socketHost(peer)) || !isLoopbackHost(socketHost(local)) || !isLoopbackHost(request.hostname)
        || request.headers.origin !== undefined || request.headers["sec-fetch-site"] !== undefined
        || request.headers.forwarded !== undefined || request.headers["x-forwarded-for"] !== undefined) {
        return reply.code(404).send({ error: "Local application access is unavailable." });
      }
    });
    await scope.register(fastifyConnectPlugin, {
      routes: router => {
        if (!managementOnly) router.service(contract.LocalAgentService, applications.applicationService());
        router.service(contract.DesktopLocalAgentService, applications.desktopService());
      },
      grpc: false, grpcWeb: false, connect: true,
      readMaxBytes: HOSTED_AGENT_WIRE_ENVELOPE_BYTES, writeMaxBytes: HOSTED_AGENT_WIRE_ENVELOPE_BYTES
    });
  });
}

function socketHost(address: string | undefined): string { return address?.replace(/^::ffff:/iu, "") ?? ""; }

function decodeLocalOpen(bytes: Uint8Array): Uint8Array {
  try {
    const input = decodeHostedAgentOpen(bytes);
    if (input.groupSwitch !== undefined || input.groupMember !== undefined) throw new HostedAgentWireError();
    const platform = process.platform === "win32" ? "win32" : process.platform === "darwin" ? "darwin" : "linux";
    const { personalInstructions, memoryInstructions, mcpEnabled } = input.workspace;
    return encodeHostedAgentValue({ ...input, permissionMode: "ask", workspace: {
      platform, shell: platform === "win32" ? "PowerShell" : "sh", isGitRepository: false,
      personalInstructions, memoryInstructions, mcpEnabled
    } });
  } catch { throw invalid(); }
}

function decodeLocalCall(bytes: Uint8Array): Uint8Array {
  try {
    const command = decodeHostedAgentCall(bytes);
    if (command.kind === "send" && command.newGroupRound !== true) {
      const { automaticContinuation: _recovery, objectiveContinuation: _objective, ...input } = command.input;
      // The native run owns the durable call receipt. There is no upstream Joko
      // task whose separate dispatch receipt would need to be committed.
      return encodeHostedAgentValue({ kind: "send", input, durableFence: false });
    }
    if (command.kind === "abort" || command.kind === "state" || command.kind === "history") return bytes;
  } catch { throw invalid(); }
  throw new ConnectError("This method is unavailable to local applications.", Code.PermissionDenied);
}

function applicationIdentity(value: Pick<contract.LocalAgentApplication, "clientId" | "displayName"> | undefined): ApplicationIdentity {
  const clientId = value?.clientId;
  const displayName = value?.displayName.trim();
  if (!clientId || !/^[a-zA-Z0-9._-]{3,128}$/u.test(clientId) || !displayName || displayName.length > 96
    || /[\p{Cc}\u202a-\u202e\u2066-\u2069]/u.test(displayName)) throw invalid();
  return { clientId, displayName };
}

function readGrant(id: string, value: unknown): Grant | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const grant = value as Grant;
  if (grant.version !== 1 || !tokenPattern.test(id) || grant.id !== id || !/^[a-f0-9]{64}$/u.test(grant.digest)
    || typeof grant.retired !== "boolean" || !Number.isSafeInteger(grant.grantedAt)
    || typeof grant.owner?.id !== "string" || typeof grant.owner.deviceId !== "string" || typeof grant.owner.authKeyDigest !== "string") return undefined;
  try { applicationIdentity(grant.application); } catch { return undefined; }
  return grant;
}

function sameOwner(grant: Grant, owner: ConnectionRecord): boolean {
  return grant.owner.id === owner.id && grant.owner.deviceId === owner.deviceId && grant.owner.authKeyDigest === owner.authKeyDigest;
}

function secret(): string { return randomBytes(32).toString("base64url"); }
function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function equalDigest(digest: string, value: string): boolean { return timingSafeEqual(Buffer.from(digest, "hex"), Buffer.from(hash(value), "hex")); }
function invalid(): ConnectError { return new ConnectError("The local application request is invalid.", Code.InvalidArgument); }
