import { createHash, randomUUID } from "node:crypto";
import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, type HandlerContext, type ServiceImpl } from "@connectrpc/connect";
import { fastifyConnectPlugin } from "@connectrpc/connect-fastify";
import type { FastifyInstance } from "fastify";
import * as contract from "@joko/contracts";
import { DESKTOP_HOST_AUTHORIZATION_HEADER } from "@joko/contracts/desktop-bootstrap";
import type { ConnectionRecord } from "@joko/store";
import type { ConnectionManager } from "../connection-manager.js";
import type { InputHandoffNativePort } from "./coordinator.js";
import type { LiveHandoffWindow } from "./session.js";
import { NativeHandoffInputOwnership, nativeHandoffWindowIdentity } from "./native-input-ownership.js";

export interface NativeInputHandoffLivePort {
  liveWindow(requestId: string, controllerDeviceId: string): Promise<LiveHandoffWindow | null>;
  isLiveViewCurrent(requestId: string, controllerDeviceId: string, windowId: number, processId: number): boolean;
  liveViewEnded(requestId: string, controllerDeviceId: string): void;
}

const Method = contract.NativeInputHandoffMethod;
const MAX_REQUEST = 65_536, MAX_RESPONSE = 8_000_000;
interface Authority { readonly connection: ConnectionRecord; readonly proof: string }
interface Command {
  readonly id: string; readonly method: contract.NativeInputHandoffMethod; readonly payload: Uint8Array; readonly assertCurrent: () => void;
  readonly resolve: (value: unknown) => void; readonly reject: (error: Error) => void; readonly timeout: ReturnType<typeof setTimeout>; dispatched: boolean;
}
interface Host {
  readonly id: string; readonly generation: bigint; readonly pid: number; readonly authority: Authority; readonly pending: Map<string, Command>;
  readonly unlisten: () => void; readonly receipts: Map<string, { digest: string; expires: number }>;
  poll?: () => void; seenAt: number;
}

/** Exact committed Main mailbox. A dispatched effect is never re-enqueued
 * after an uncertain poll/completion; old host cleanup cannot name a new one. */
export class NativeInputHandoffHost implements InputHandoffNativePort {
  #host: Host | undefined; #generation = 0n; #closed = false;
  #live: NativeInputHandoffLivePort | undefined;
  readonly #input = new NativeHandoffInputOwnership();
  readonly #sweep: ReturnType<typeof setInterval>;
  constructor(readonly connections: ConnectionManager) {
    this.#sweep = setInterval(() => { const host = this.#host; if (!host) return; try { this.#current(host); } catch { this.#retire(host); } }, 5_000); this.#sweep.unref();
  }
  setLiveHandoffPort(port: NativeInputHandoffLivePort): void { this.#live = port; }
  currentDeviceId(): string | null { const host = this.#host; if (!host) return null; try { this.#current(host); return host.authority.connection.deviceId; } catch { return null; } }
  createDriver(assertCurrent: () => void): { readonly driver: contract.HandoffDriver; readonly hostPid: number } | null {
    const host = this.#host; if (!host) return null;
    try { this.#current(host); assertCurrent(); } catch { return null; }
    const call = <T>(method: contract.NativeInputHandoffMethod, body: unknown = {}): Promise<T> => this.#call(host, method, body, assertCurrent) as Promise<T>;
    const target = (pid: number, window?: contract.NativeWindowRef) => ({ pid, ...(window ? { window } : {}) });
    return { hostPid: host.pid, driver: {
      permission: () => call(Method.PERMISSION), requestPermission: () => call(Method.REQUEST_PERMISSION), windows: () => call(Method.WINDOWS),
      snapshot: (pid, window) => call(Method.SNAPSHOT, target(pid, window)), act: request => call(Method.ACT, request),
      commandLine: pid => call(Method.COMMAND_LINE, { pid }), capture: value => call(Method.CAPTURE, value),
      focusedField: pid => call(Method.FOCUSED_FIELD, { pid }), pointer: request => call(Method.POINTER, request),
      qr: (value, frame) => call(Method.QR, { ...value, frame }), raise: value => call(Method.RAISE, value)
    } };
  }
  service(): ServiceImpl<typeof contract.DesktopInputHandoffHostService> {
    const auth = (context: HandlerContext): Authority => {
      context.signal.throwIfAborted();
      try { const connection = this.connections.authenticate(context.requestHeader.get("authorization") ?? undefined), proof = context.requestHeader.get(DESKTOP_HOST_AUTHORIZATION_HEADER) ?? "";
        this.connections.authenticateDesktopHost(connection, proof); return { connection, proof };
      } catch { throw new ConnectError("Committed Desktop host authentication is required.", Code.Unauthenticated); }
    };
    return {
      registerNativeInputHandoffHost: (request, context) => {
        const authority = auth(context);
        if (this.#closed || request.platform !== "darwin" || !/^[a-f0-9-]{36}$/u.test(request.hostInstanceId) || !Number.isSafeInteger(request.processId) || request.processId <= 0) throw unavailable();
        let host = this.#host;
        if (host && (host.id !== request.hostInstanceId || host.pid !== request.processId || host.authority.connection.id !== authority.connection.id || host.authority.proof !== authority.proof)) this.#retire(host);
        host = this.#host;
        if (!host) {
          let captured!: Host;
          const unlisten = this.connections.onRevoked(authority.connection.id, () => this.#retire(captured));
          host = captured = { id: request.hostInstanceId, generation: ++this.#generation, pid: request.processId, authority, pending: new Map(), receipts: new Map(), unlisten, seenAt: Date.now() }; this.#host = host;
        }
        this.#current(host); host.seenAt = Date.now();
        return create(contract.RegisterNativeInputHandoffHostResponseSchema, { hostGeneration: host.generation });
      },
      pollNativeInputHandoffCommand: async (request, context) => {
        const host = this.#entry(auth(context), request.hostInstanceId, request.hostGeneration);
        host.seenAt = Date.now();
        let command = this.#next(host);
        if (!command) {
          if (host.poll) throw unavailable();
          await new Promise<void>(resolve => {
            const finish = () => { clearTimeout(timer); context.signal.removeEventListener("abort", finish); if (host.poll === finish) host.poll = undefined; resolve(); };
            const timer = setTimeout(finish, 20_000); timer.unref(); host.poll = finish; context.signal.addEventListener("abort", finish, { once: true });
          });
          this.#current(host); context.signal.throwIfAborted(); command = this.#next(host);
        }
        return create(contract.PollNativeInputHandoffCommandResponseSchema, command ? { command: { commandId: command.id, method: command.method, payload: command.payload } } : {});
      },
      admitNativeInputHandoffCommand: (request, context) => {
        const host = this.#entry(auth(context), request.hostInstanceId, request.hostGeneration), command = host.pending.get(request.commandId);
        host.seenAt = Date.now();
        let current = !!command?.dispatched; try { command?.assertCurrent(); } catch { current = false; if (command) this.#fail(host, command); }
        return create(contract.AdmitNativeInputHandoffCommandResponseSchema, { current });
      },
      resolveNativeInputHandoffWindow: async (request, context) => {
        const host = this.#entry(auth(context), request.hostInstanceId, request.hostGeneration); host.seenAt = Date.now();
        assertWindowRequest(request); const window = await this.#live?.liveWindow(request.requestId, request.controllerDeviceId);
        this.#current(host); context.signal.throwIfAborted();
        return create(contract.ResolveNativeInputHandoffWindowResponseSchema, window ? { window: {
          requestId: request.requestId, windowId: window.windowId, processId: window.pid, app: window.app, title: window.title, frame: window.frame
        } } : {});
      },
      checkNativeInputHandoffWindow: (request, context) => {
        const host = this.#entry(auth(context), request.hostInstanceId, request.hostGeneration); host.seenAt = Date.now(); assertWindowRequest(request);
        return create(contract.CheckNativeInputHandoffWindowResponseSchema, { current: this.#live?.isLiveViewCurrent(request.requestId, request.controllerDeviceId, request.windowId, request.processId) === true });
      },
      endNativeInputHandoffWindow: (request, context) => {
        const host = this.#entry(auth(context), request.hostInstanceId, request.hostGeneration); host.seenAt = Date.now(); assertWindowRequest(request);
        if (this.#live?.isLiveViewCurrent(request.requestId, request.controllerDeviceId, request.windowId, request.processId)) this.#live.liveViewEnded(request.requestId, request.controllerDeviceId);
        return create(contract.EndNativeInputHandoffWindowResponseSchema);
      },
      beginNativeInputHandoffInput: async (request, context) => {
        const window = request.window; if (!window) throw unavailable();
        const host = this.#entry(auth(context), window.hostInstanceId, window.hostGeneration); host.seenAt = Date.now(); assertWindowRequest(window);
        const assertCurrent = () => { this.#current(host); if (!this.#live?.isLiveViewCurrent(window.requestId, window.controllerDeviceId, window.windowId, window.processId)) throw unavailable(); };
        const batch = await this.#input.begin({ instanceId: host.id, deviceId: host.authority.connection.deviceId, token: host }, request.inputOwnerId,
          nativeHandoffWindowIdentity(window), request.gestureState, assertCurrent, context.signal);
        return create(contract.BeginNativeInputHandoffInputResponseSchema, { inputBatchId: batch });
      },
      finishNativeInputHandoffInput: (request, context) => {
        const window = request.window; if (!window) throw unavailable();
        const host = this.#entry(auth(context), window.hostInstanceId, window.hostGeneration); host.seenAt = Date.now(); assertWindowRequest(window);
        this.#input.finish({ instanceId: host.id, deviceId: host.authority.connection.deviceId }, request.inputOwnerId,
          nativeHandoffWindowIdentity(window), request.inputBatchId, request.closed);
        return create(contract.FinishNativeInputHandoffInputResponseSchema);
      },
      completeNativeInputHandoffCommand: (request, context) => {
        const host = this.#entry(auth(context), request.hostInstanceId, request.hostGeneration); host.seenAt = Date.now();
        if (request.payload.byteLength > MAX_RESPONSE) throw unavailable();
        const digest = createHash("sha256").update(request.success ? "1" : "0").update(request.payload).digest("hex"), receipt = host.receipts.get(request.commandId);
        if (receipt) return create(contract.CompleteNativeInputHandoffCommandResponseSchema, { accepted: receipt.digest === digest });
        const command = host.pending.get(request.commandId); if (!command?.dispatched) return create(contract.CompleteNativeInputHandoffCommandResponseSchema, { accepted: false });
        try {
          command.assertCurrent();
          if (!request.success) throw new Error("Native input handoff failed.");
          const value: unknown = JSON.parse(Buffer.from(request.payload).toString("utf8"), (key, value: unknown) => key === "jpeg" && typeof value === "string" ? decodeJpeg(value) : value);
          this.#finish(host, command); command.resolve(value); host.receipts.set(command.id, { digest, expires: Date.now() + 60_000 });
          for (const [id, item] of host.receipts) if (item.expires <= Date.now()) host.receipts.delete(id);
          return create(contract.CompleteNativeInputHandoffCommandResponseSchema, { accepted: true });
        } catch { this.#fail(host, command); return create(contract.CompleteNativeInputHandoffCommandResponseSchema, { accepted: false }); }
      }
    };
  }
  close(): void { this.#closed = true; clearInterval(this.#sweep); if (this.#host) this.#retire(this.#host); this.#input.close(); }
  #call(host: Host, method: contract.NativeInputHandoffMethod, value: unknown, assertCurrent: () => void): Promise<unknown> {
    this.#current(host); assertCurrent();
    const payload = Buffer.from(JSON.stringify(value)); if (payload.length > MAX_REQUEST || host.pending.size >= 32) throw unavailable();
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const timeout = setTimeout(() => { const entry = host.pending.get(id); if (entry) this.#fail(host, entry); }, 30_000); timeout.unref();
      const command: Command = { id, method, payload, assertCurrent: () => { this.#current(host); assertCurrent(); }, resolve, reject, timeout, dispatched: false };
      host.pending.set(id, command); host.poll?.();
    });
  }
  #next(host: Host): Command | undefined {
    for (const command of host.pending.values()) if (!command.dispatched) { try { command.assertCurrent(); } catch { this.#fail(host, command); continue; } command.dispatched = true; return command; } return undefined;
  }
  #entry(authority: Authority, id: string, generation: bigint): Host {
    const host = this.#host;
    if (!host || host.id !== id || host.generation !== generation || host.authority.connection.id !== authority.connection.id || host.authority.proof !== authority.proof) throw unavailable();
    this.#current(host); return host;
  }
  #current(host: Host): void {
    if (this.#closed || this.#host !== host || Date.now() - host.seenAt > 45_000) throw unavailable();
    this.connections.authenticateDesktopHost(host.authority.connection, host.authority.proof);
  }
  #finish(host: Host, command: Command): void { clearTimeout(command.timeout); host.pending.delete(command.id); command.payload.fill(0); }
  #fail(host: Host, command: Command): void { this.#finish(host, command); command.reject(new Error("Native input handoff is unavailable.")); }
  #retire(host: Host): void {
    this.#input.retireHost(host);
    if (this.#host === host) this.#host = undefined; host.unlisten(); host.poll?.();
    for (const command of host.pending.values()) this.#fail(host, command); host.receipts.clear();
  }
}
export async function registerInputHandoffNativeHost(server: FastifyInstance, host: NativeInputHandoffHost): Promise<void> {
  server.addHook("onClose", () => host.close());
  await server.register(async scope => {
    scope.addHook("onRequest", async (request, reply) => {
      if (!loopback(request.ip) || !loopback(request.raw.socket.localAddress ?? "")) return reply.code(403).send({ error: "Native input handoff is only available locally." });
    });
    await scope.register(fastifyConnectPlugin, { routes: router => router.service(contract.DesktopInputHandoffHostService, host.service()), readMaxBytes: MAX_RESPONSE + 4096, writeMaxBytes: MAX_RESPONSE + 4096 });
  });
}
function unavailable(): ConnectError { return new ConnectError("Native input handoff is unavailable.", Code.FailedPrecondition); }
function loopback(value: string): boolean { return value === "127.0.0.1" || value === "::1" || value.startsWith("::ffff:127."); }
function decodeJpeg(value: string): Uint8Array { if (!value || value.length > 440_004 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(value)) throw unavailable(); const bytes = Buffer.from(value, "base64"); if (bytes.length > 330_000) throw unavailable(); return bytes; }
function assertWindowRequest(request: Omit<contract.NativeInputHandoffWindowScope, "$typeName">): void {
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(request.requestId) || !request.controllerDeviceId || request.controllerDeviceId.length > 256 || /[\u0000-\u001f\u007f]/u.test(request.controllerDeviceId)) throw unavailable();
}
