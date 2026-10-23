import { randomBytes } from "node:crypto";
import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, type HandlerContext, type ServiceImpl } from "@connectrpc/connect";
import { fastifyConnectPlugin } from "@connectrpc/connect-fastify";
import type { FastifyInstance } from "fastify";
import * as contract from "@joko/contracts";
import { DESKTOP_HOST_AUTHORIZATION_HEADER } from "@joko/contracts/desktop-bootstrap";
import { DEVICE_PEER_NATIVE_AGENT_MAXIMUM_BYTES, devicePeerNativeAgentMethodEffect, type DevicePeerNativeAgentPort } from "@joko/device-peer";
import type { ConnectionRecord } from "@joko/store";
import type { ConnectionManager } from "./connection-manager.js";
import { createHostedAgentPeerPort } from "./hosted-agent-peer-port.js";
import type { HostedAgentRuntime } from "./hosted-agent-runtime.js";
import { withProviderGroupPeerPort } from "./provider-group-peer.js";
import type { ProviderGroupConnectOptions } from "./provider-group-connect-service.js";

const FORMAT = 1;
interface DesktopAuthority {
  readonly connection: ConnectionRecord;
  readonly proof: string;
}
interface Delegate {
  readonly id: string;
  readonly instanceKey: string;
  readonly authority: DesktopAuthority;
  readonly port: DevicePeerNativeAgentPort;
  readonly unsubscribe: () => void;
  retiring: boolean;
  closedAt?: number;
  closing?: Promise<void>;
}
export interface HostedAgentDesktopServiceOptions {
  readonly runtime: HostedAgentRuntime;
  readonly connections: ConnectionManager;
  /** The managed service's own identity, never accepted from an RPC message. */
  readonly serverId: string;
  readonly groupOptions?: Omit<ProviderGroupConnectOptions, "authenticate">;
}

/** Each committed Main-process route owns a distinct native authority. The
 * original task Device is preserved within the service-owned Hub scope. */
export class HostedAgentDesktopDelegates {
  readonly #routes = new Map<string, Delegate>();
  readonly #instances = new Map<string, Delegate>();
  readonly #timer: ReturnType<typeof setInterval>;
  #closed = false;
  constructor(readonly options: HostedAgentDesktopServiceOptions) {
    identity(options.serverId);
    this.#timer = setInterval(() => { void this.#sweep(); }, 5_000);
    this.#timer.unref();
  }
  service(): ServiceImpl<typeof contract.DesktopHostedAgentService> {
    const invoke = async <T>(format: number, context: HandlerContext, action: (authority: DesktopAuthority) => T | Promise<T>): Promise<T> => {
      try {
        if (format !== FORMAT || this.#closed) throw new ConnectError("Native Desktop delegation is unavailable.", Code.FailedPrecondition);
        context.signal.throwIfAborted();
        const authority = this.#authenticate(context);
        const result = await action(authority);
        this.#assertAuthority(authority); context.signal.throwIfAborted();
        return result;
      } catch (error) {
        if (error instanceof ConnectError) throw error;
        if (context.signal.aborted) throw new ConnectError("Native Desktop delegation was cancelled.", Code.Canceled);
        throw new ConnectError("Native Desktop delegation is unavailable.", Code.PermissionDenied);
      }
    };
    return {
      openDesktopHostedAgentDelegate: (request, context) => invoke(request.format, context, authority => {
        if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(request.routeInstanceId)) {
          throw new ConnectError("The native route identity is invalid.", Code.InvalidArgument);
        }
        const instanceKey = JSON.stringify([authority.connection.id, request.routeInstanceId]);
        let entry = this.#instances.get(instanceKey);
        if (entry?.retiring) throw new ConnectError("The native route has retired.", Code.FailedPrecondition);
        if (!entry) {
          if (this.#routes.size >= 4_096) throw new ConnectError("Native Desktop route capacity has been reached.", Code.ResourceExhausted);
          const id = randomBytes(32).toString("base64url");
          const native = createHostedAgentPeerPort(this.options.runtime, this.options.serverId, () => this.#assertAuthority(authority));
          const port = this.options.groupOptions
            ? withProviderGroupPeerPort(native, this.options.groupOptions, () => this.#assertAuthority(authority)) : native;
          let captured!: Delegate;
          const unsubscribe = this.options.connections.onRevoked(authority.connection.id, () => {
            void this.#retire(captured).catch(() => {});
          });
          entry = captured = { id, instanceKey, authority, port, unsubscribe, retiring: false };
          this.#routes.set(id, entry); this.#instances.set(instanceKey, entry);
        }
        return create(contract.OpenDesktopHostedAgentDelegateResponseSchema, { format: FORMAT, delegateId: entry.id, serverId: this.options.serverId });
      }),
      invokeDesktopHostedAgentDelegate: (request, context) => invoke(request.format, context, async authority => {
        const entry = this.#entry(authority, request.delegateId);
        if (entry.retiring) throw new ConnectError("The native route has retired.", Code.FailedPrecondition);
        identity(request.controllerDeviceId);
        if (devicePeerNativeAgentMethodEffect(request.method) === undefined || request.requestBytes.byteLength > DEVICE_PEER_NATIVE_AGENT_MAXIMUM_BYTES) {
          throw new ConnectError("The native request is invalid.", Code.InvalidArgument);
        }
        const bytes = await entry.port.invoke(request.method, request.requestBytes, context.signal, { controllerDeviceId: request.controllerDeviceId });
        this.#assertAuthority(entry.authority);
        if (bytes.byteLength > DEVICE_PEER_NATIVE_AGENT_MAXIMUM_BYTES) throw new ConnectError("The native response is too large.", Code.ResourceExhausted);
        return create(contract.InvokeDesktopHostedAgentDelegateResponseSchema, { format: FORMAT, responseBytes: bytes });
      }),
      closeDesktopHostedAgentDelegate: (request, context) => invoke(request.format, context, async authority => {
        const entry = this.#entry(authority, request.delegateId);
        await this.#retire(entry);
        return create(contract.CloseDesktopHostedAgentDelegateResponseSchema, { format: FORMAT });
      })
    };
  }
  async close(): Promise<void> {
    this.#closed = true; clearInterval(this.#timer);
    const outcomes = await Promise.allSettled([...this.#routes.values()].map(entry => this.#retire(entry)));
    if (outcomes.some(outcome => outcome.status === "rejected")) throw new Error("Native Desktop routes could not finish cleanup.");
    this.#routes.clear(); this.#instances.clear();
  }
  #authenticate(context: HandlerContext): DesktopAuthority {
    try {
      const connection = this.options.connections.authenticate(context.requestHeader.get("authorization") ?? undefined);
      const proof = context.requestHeader.get(DESKTOP_HOST_AUTHORIZATION_HEADER) ?? "";
      this.options.connections.authenticateDesktopHost(connection, proof);
      return { connection, proof };
    } catch {
      throw new ConnectError("Committed Desktop host authentication is required.", Code.Unauthenticated);
    }
  }
  #assertAuthority(authority: DesktopAuthority): void {
    if (this.#closed) throw new Error("The native Desktop service has closed.");
    this.options.connections.authenticateDesktopHost(authority.connection, authority.proof);
  }
  #entry(authority: DesktopAuthority, id: string): Delegate {
    if (!/^[A-Za-z0-9_-]{43}$/u.test(id)) throw new ConnectError("The native delegate identity is invalid.", Code.InvalidArgument);
    const entry = this.#routes.get(id);
    if (!entry || entry.authority.connection.id !== authority.connection.id || entry.authority.connection.authKeyDigest !== authority.connection.authKeyDigest) {
      throw new ConnectError("The native delegate is unavailable.", Code.PermissionDenied);
    }
    this.#assertAuthority(entry.authority);
    return entry;
  }
  #retire(entry: Delegate): Promise<void> {
    entry.retiring = true;
    return entry.closing ??= entry.port.retire().then(() => {
      entry.closedAt ??= Date.now(); entry.unsubscribe();
    }).catch(error => { entry.closing = undefined; throw error; });
  }
  async #sweep(): Promise<void> {
    await Promise.allSettled([...this.#routes.values()].map(async entry => {
      try { this.#assertAuthority(entry.authority); } catch { entry.retiring = true; }
      if (entry.retiring) await this.#retire(entry);
      if (entry.closedAt !== undefined && Date.now() - entry.closedAt >= 60_000) {
        if (this.#routes.get(entry.id) === entry) this.#routes.delete(entry.id);
        if (this.#instances.get(entry.instanceKey) === entry) this.#instances.delete(entry.instanceKey);
      }
    }));
  }
}

/** The private proof is never accepted from a network peer or renderer. The
 * normal public listener may also serve LAN clients, so fence this service to
 * an actual loopback socket independently of that listener's configuration. */
export async function registerHostedAgentDesktopService(server: FastifyInstance, options: HostedAgentDesktopServiceOptions): Promise<void> {
  const delegates = new HostedAgentDesktopDelegates(options);
  server.addHook("onClose", () => delegates.close());
  await server.register(async scope => {
    scope.addHook("onRequest", async (request, reply) => {
      if (!loopback(request.ip) || !loopback(request.raw.socket.localAddress ?? request.ip)) {
        return reply.code(403).send({ error: "Native Desktop delegation is only available locally." });
      }
    });
    await scope.register(fastifyConnectPlugin, { routes: router => router.service(contract.DesktopHostedAgentService, delegates.service()),
      readMaxBytes: DEVICE_PEER_NATIVE_AGENT_MAXIMUM_BYTES + 4_096, writeMaxBytes: DEVICE_PEER_NATIVE_AGENT_MAXIMUM_BYTES + 4_096 });
  });
}
function identity(value: string): void {
  if (!value || value.length > 256 || /[\0\r\n]/u.test(value)) throw new ConnectError("The native controller identity is invalid.", Code.InvalidArgument);
}
function loopback(value: string): boolean { return value === "127.0.0.1" || value === "::1" || value.startsWith("::ffff:127."); }
