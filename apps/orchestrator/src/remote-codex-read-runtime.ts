import { createHash, randomBytes } from "node:crypto";
import { posix as remotePath } from "node:path";
import { TextDecoder } from "node:util";
import {
  AppServerHost,
  StdioJsonRpcTransport,
  TransportFault,
  type CodexRemoteMcpOpenInput,
  type CodexRemoteRuntime,
  type CodexRemoteRuntimePort,
  type JsonRpcRecordChannel,
  type JsonRpcRecordChannelHandlers
} from "@joko/adapter-codex";
import type { TargetDescriptor } from "@joko/core";
import type {
  RemoteProcessHandle,
  RemoteProcessTransportPort,
  RemoteSshTransportLease
} from "@joko/remote-ssh";
import type { OperationalStore, RemoteHostRecord, StoredTarget } from "@joko/store";
import { probeRemoteCodexInstallation } from "./remote-codex-installation.js";
import type { RemoteHostRegistry } from "./remote-host-registry.js";
import type { RemoteCodexMcpBridgeManager } from "./remote-codex-mcp-bridge.js";

const PROBE_TIMEOUT_MS = 10_000;
const DAEMON_BOOTSTRAP_TIMEOUT_MS = 30_000;
const HANDSHAKE_TIMEOUT_MS = 15_000;
const SHUTDOWN_TIMEOUT_MS = 2_000;
const MAXIMUM_COMMAND_OUTPUT_BYTES = 64 * 1_024;
const MAXIMUM_HANDSHAKE_BYTES = 64 * 1_024;
const MAXIMUM_MESSAGE_BYTES = 16 * 1_024 * 1_024;
const MAXIMUM_FRAME_BUFFER_BYTES = 20 * 1_024 * 1_024;
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

type ProcessAuthority = Awaited<ReturnType<RemoteHostRegistry["captureProcessAuthority"]>>;

interface ResolverEntry {
  readonly targetId: string;
  readonly targetRevision: bigint;
  readonly targetSignature: string;
  readonly authority: ProcessAuthority;
  readonly runtime: CodexRemoteRuntime;
}

export interface RemoteCodexRuntimeResolverOptions {
  readonly store: Pick<OperationalStore, "getTarget">;
  readonly registry: Pick<RemoteHostRegistry, "captureProcessAuthority">;
  readonly mcpBridge?: Pick<RemoteCodexMcpBridgeManager, "open" | "shutdown">;
}

/** Target- and SSH-generation-bound owner for a remote Codex runtime. */
export class RemoteCodexRuntimeResolver implements CodexRemoteRuntimePort {
  readonly #store: Pick<OperationalStore, "getTarget">;
  readonly #registry: Pick<RemoteHostRegistry, "captureProcessAuthority">;
  readonly #mcpBridge: RemoteCodexRuntimeResolverOptions["mcpBridge"];
  readonly #entries = new Map<string, ResolverEntry>();
  readonly #flights = new Map<string, Promise<CodexRemoteRuntime>>();
  #closed = false;

  constructor(options: RemoteCodexRuntimeResolverOptions) {
    this.#store = options.store;
    this.#registry = options.registry;
    this.#mcpBridge = options.mcpBridge;
  }

  async resolve(target: TargetDescriptor, signal?: AbortSignal): Promise<CodexRemoteRuntime> {
    this.#assertOpen();
    if (signal?.aborted) throw remoteRuntimeFault("The remote Codex runtime lookup was cancelled.");
    const stored = this.#storedTarget(target);
    const signature = targetSignature(target);
    const existing = this.#entries.get(target.id);
    if (existing !== undefined
      && existing.targetRevision === stored.revision
      && existing.targetSignature === signature) {
      try {
        existing.runtime.assertCurrent();
        return existing.runtime;
      } catch {
        await this.#retire(existing, true);
      }
    } else if (existing !== undefined) {
      await this.#retire(existing, true);
    }
    const activeFlight = this.#flights.get(target.id);
    if (activeFlight !== undefined) return activeFlight;
    const flight = this.#resolveFresh(target, stored, signature, signal);
    this.#flights.set(target.id, flight);
    try {
      return await flight;
    } finally {
      if (this.#flights.get(target.id) === flight) this.#flights.delete(target.id);
    }
  }

  async shutdown(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await Promise.allSettled([...this.#flights.values()]);
    const entries = [...this.#entries.values()];
    this.#entries.clear();
    await this.#mcpBridge?.shutdown();
    await Promise.allSettled(entries.map((entry) => entry.runtime.host.shutdown()));
  }

  async forceShutdown(): Promise<void> {
    this.#closed = true;
    const entries = [...this.#entries.values()];
    this.#entries.clear();
    await this.#mcpBridge?.shutdown();
    await Promise.allSettled(entries.map((entry) => entry.runtime.host.forceShutdown()));
  }

  async #resolveFresh(
    target: TargetDescriptor,
    stored: StoredTarget,
    signature: string,
    signal?: AbortSignal
  ): Promise<CodexRemoteRuntime> {
    const binding = requireRemoteBinding(target);
    const authority = await this.#registry.captureProcessAuthority(target.id, binding.hostId, signal);
    const processes = requireProcesses(authority.lease);
    authority.assertCurrent();
    const installation = await probeRemoteCodexInstallation(processes, binding.workspaceRoot, authority.assertCurrent, signal);
    authority.assertCurrent();
    if (installation.state !== "ready") throw remoteRuntimeFault("The fixed remote Codex runtime is unavailable.");
    if (signal?.aborted) throw remoteRuntimeFault("The remote Codex runtime lookup was cancelled.");
    const executionDomain = executionDomainFor(authority.host, installation.profileRoot);
    const profileKey = createHash("sha256").update(executionDomain, "utf8").digest("hex");
    let entry: ResolverEntry;
    const assertCurrent = (): void => {
      this.#assertOpen();
      const current = this.#store.getTarget(target.id);
      if (current.revision !== stored.revision
        || targetSignature(current.descriptor) !== signature
        || this.#entries.get(target.id) !== entry) {
        throw remoteRuntimeFault("The remote Codex Target authority changed.");
      }
      authority.assertCurrent();
    };
    const host = new AppServerHost({
      transportFactory: () => new StdioJsonRpcTransport({
        channelFactory: () => new RemoteCodexWebSocketChannel({
          processes,
          executable: installation.executable,
          profileRoot: installation.profileRoot,
          workspaceRoot: installation.workspaceRoot,
          assertCurrent
        })
      })
    });
    const runtime: CodexRemoteRuntime = Object.freeze({
      host,
      workspaceRoot: installation.workspaceRoot,
      profileKey,
      executionDomain,
      assertCurrent,
      ...(this.#mcpBridge === undefined ? {} : {
        openMcpBridge: async (input: CodexRemoteMcpOpenInput) => {
          assertCurrent();
          const bridge = await this.#mcpBridge!.open({
            forwarding: authority.lease.forwarding,
            assertCurrent: authority.assertCurrent,
            assertForwardingCurrent: authority.assertForwardingCurrent
          }, input);
          try {
            assertCurrent();
            bridge.assertCurrent();
            return bridge;
          } catch (error) {
            await bridge.release();
            throw error;
          }
        }
      })
    });
    entry = Object.freeze({
      targetId: target.id,
      targetRevision: stored.revision,
      targetSignature: signature,
      authority,
      runtime
    });
    this.#assertOpen();
    authority.assertCurrent();
    this.#entries.set(target.id, entry);
    try {
      runtime.assertCurrent();
      return runtime;
    } catch (error) {
      await this.#retire(entry, true);
      throw error;
    }
  }

  async #retire(entry: ResolverEntry, force: boolean): Promise<void> {
    if (this.#entries.get(entry.targetId) === entry) this.#entries.delete(entry.targetId);
    if (force) await entry.runtime.host.forceShutdown().catch(() => undefined);
    else await entry.runtime.host.shutdown().catch(() => undefined);
  }

  #storedTarget(target: TargetDescriptor): StoredTarget {
    const stored = this.#store.getTarget(target.id);
    if (targetSignature(stored.descriptor) !== targetSignature(target)) {
      throw remoteRuntimeFault("The remote Codex Target binding is stale.");
    }
    requireRemoteBinding(stored.descriptor);
    return stored;
  }

  #assertOpen(): void {
    if (this.#closed) throw remoteRuntimeFault("The remote Codex runtime resolver is closed.");
  }
}

interface RemoteCommandInput {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}

async function runRemoteCommand(
  processes: RemoteProcessTransportPort,
  input: RemoteCommandInput
): Promise<{ readonly stdout: Buffer; readonly exitCode: number | null }> {
  if (input.signal?.aborted) throw remoteRuntimeFault("The remote Codex command was cancelled.");
  const lifetime = new AbortController();
  const onAbort = (): void => lifetime.abort();
  input.signal?.addEventListener("abort", onAbort, { once: true });
  let handle: RemoteProcessHandle;
  try {
    handle = await processes.open({
      executable: input.executable,
      args: input.args,
      cwd: input.cwd,
      ...(input.env === undefined ? {} : { env: input.env }),
      signal: lifetime.signal
    });
  } catch {
    input.signal?.removeEventListener("abort", onAbort);
    throw remoteRuntimeFault("The remote Codex command could not be started.");
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    const timer = setTimeout(() => fail("The remote Codex command timed out."), input.timeoutMs);
    timer.unref?.();
    const cleanup = (): void => {
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", abort);
      input.signal?.removeEventListener("abort", onAbort);
      handle.stdout.removeListener("data", onData);
      handle.stdout.removeListener("error", onStreamError);
      handle.stderr.removeListener("error", onStreamError);
      handle.stdin.removeListener("error", onStreamError);
    };
    const fail = (message: string): void => {
      if (settled) return;
      settled = true;
      cleanup();
      lifetime.abort();
      try { handle.kill("SIGKILL"); } catch { /* The channel may already be closed. */ }
      reject(remoteRuntimeFault(message));
    };
    const abort = (): void => fail("The remote Codex command was cancelled.");
    const onStreamError = (): void => fail("The remote Codex command stream failed.");
    const onData = (chunk: Buffer | string): void => {
      const value = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
      bytes += value.byteLength;
      if (bytes > MAXIMUM_COMMAND_OUTPUT_BYTES) {
        fail("The remote Codex command exceeded its output limit.");
        return;
      }
      chunks.push(Buffer.from(value));
    };
    input.signal?.addEventListener("abort", abort, { once: true });
    handle.stdout.on("data", onData);
    handle.stdout.once("error", onStreamError);
    handle.stderr.once("error", onStreamError);
    handle.stdin.once("error", onStreamError);
    handle.stderr.resume();
    handle.once("error", onStreamError);
    handle.once("exit", (exitCode) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(Object.freeze({ stdout: Buffer.concat(chunks, bytes), exitCode }));
    });
    try {
      handle.stdin.end();
    } catch {
      fail("The remote Codex command stream failed.");
    }
    if (input.signal?.aborted) abort();
    else if (handle.exitCode !== null) {
      settled = true;
      cleanup();
      resolve(Object.freeze({ stdout: Buffer.concat(chunks, bytes), exitCode: handle.exitCode }));
    }
  });
}

interface RemoteCodexWebSocketChannelOptions {
  readonly processes: RemoteProcessTransportPort;
  readonly executable: string;
  readonly profileRoot: string;
  readonly workspaceRoot: string;
  readonly assertCurrent: () => void;
}

class RemoteCodexWebSocketChannel implements JsonRpcRecordChannel {
  readonly #options: RemoteCodexWebSocketChannelOptions;
  #handlers: JsonRpcRecordChannelHandlers | undefined;
  #process: RemoteProcessHandle | undefined;
  #state: "idle" | "starting" | "running" | "closing" | "closed" = "idle";
  #handshakeBuffer = Buffer.alloc(0);
  #frameBuffer = Buffer.alloc(0);
  #expectedAccept = "";
  #handshakeResolve: (() => void) | undefined;
  #handshakeReject: ((error: unknown) => void) | undefined;
  #handshakeTimer: NodeJS.Timeout | undefined;
  #fragmentChunks: Buffer[] = [];
  #fragmentBytes = 0;
  #fragmentedText = false;
  #exitDelivered = false;
  #writeTail: Promise<void> = Promise.resolve();

  constructor(options: RemoteCodexWebSocketChannelOptions) {
    this.#options = options;
  }

  get running(): boolean {
    return this.#state === "running";
  }

  async start(handlers: JsonRpcRecordChannelHandlers): Promise<void> {
    if (this.#state !== "idle") throw new TransportFault("closed", "The remote Codex channel cannot be started twice.");
    this.#state = "starting";
    this.#handlers = handlers;
    try {
      this.#options.assertCurrent();
      const socketPath = await ensureDaemon(this.#options);
      this.#options.assertCurrent();
      const processHandle = await this.#options.processes.open({
        executable: this.#options.executable,
        args: ["app-server", "proxy", "--sock", socketPath],
        cwd: this.#options.workspaceRoot,
        env: { CODEX_HOME: this.#options.profileRoot }
      });
      this.#options.assertCurrent();
      if (this.#state !== "starting") {
        try { processHandle.kill("SIGKILL"); } catch { /* A concurrent failure already won. */ }
        throw new TransportFault("closed", "The remote Codex channel closed during startup.");
      }
      this.#process = processHandle;
      processHandle.stderr.resume();
      processHandle.stderr.once("error", () => this.#fail(new TransportFault("process_exited", "The remote Codex proxy error stream failed.", { stateMayHaveChanged: true })));
      processHandle.stdout.on("data", (chunk: Buffer | string) => this.#acceptBytes(chunk));
      processHandle.stdout.once("error", () => this.#fail(new TransportFault("process_exited", "The remote Codex proxy stream failed.", { stateMayHaveChanged: true })));
      processHandle.stdin.once("error", () => this.#fail(new TransportFault("write_failed", "The remote Codex proxy write stream failed.", { stateMayHaveChanged: true })));
      processHandle.once("error", () => this.#fail(new TransportFault("process_exited", "The remote Codex proxy process failed.", { stateMayHaveChanged: true })));
      processHandle.once("exit", () => this.#fail(new TransportFault("process_exited", "The remote Codex proxy process exited.", { stateMayHaveChanged: true })));
      const key = randomBytes(16).toString("base64");
      this.#expectedAccept = createHash("sha1").update(key + WS_GUID, "ascii").digest("base64");
      const ready = new Promise<void>((resolve, reject) => {
        this.#handshakeResolve = resolve;
        this.#handshakeReject = reject;
      });
      this.#handshakeTimer = setTimeout(() => {
        this.#fail(new TransportFault("request_timeout", "The remote Codex WebSocket handshake timed out."));
      }, HANDSHAKE_TIMEOUT_MS);
      this.#handshakeTimer.unref?.();
      await writeProcessBytes(processHandle, Buffer.from([
        "GET / HTTP/1.1",
        "Host: localhost",
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Key: ${key}`,
        "Sec-WebSocket-Version: 13",
        "",
        ""
      ].join("\r\n"), "ascii"));
      await ready;
    } catch (error) {
      const fault = error instanceof TransportFault
        ? error
        : new TransportFault("spawn_failed", "The remote Codex channel could not be started.");
      this.#fail(fault);
      throw fault;
    }
  }

  write(record: Buffer): Promise<void> {
    if (!this.running || record.byteLength < 2 || record.at(-1) !== 0x0a
      || record.subarray(0, record.byteLength - 1).includes(0x0a)) {
      return Promise.reject(new TransportFault("protocol_violation", "The remote Codex channel received an invalid JSONL record."));
    }
    return this.#enqueueFrame(0x1, record.subarray(0, record.byteLength - 1));
  }

  async close(): Promise<void> {
    if (this.#state === "closed") return;
    const processHandle = this.#process;
    const wasRunning = this.#state === "running";
    this.#state = "closing";
    this.#clearHandshake();
    if (processHandle === undefined) {
      this.#state = "closed";
      return;
    }
    if (wasRunning) await this.#writeCloseFrame(processHandle).catch(() => undefined);
    try { processHandle.stdin.end(); } catch { /* The proxy may already be gone. */ }
    let exited = await processExitBefore(processHandle, SHUTDOWN_TIMEOUT_MS);
    if (!exited) {
      try { processHandle.kill("SIGTERM"); } catch { /* Fall through to hard close. */ }
      exited = await processExitBefore(processHandle, SHUTDOWN_TIMEOUT_MS);
    }
    if (!exited) {
      try { processHandle.kill("SIGKILL"); } catch { /* Exit confirmation below is authoritative. */ }
      exited = await processExitBefore(processHandle, SHUTDOWN_TIMEOUT_MS);
      if (!exited) {
        throw new TransportFault("shutdown_unconfirmed", "The remote Codex proxy did not confirm shutdown.", { stateMayHaveChanged: true });
      }
    }
    this.#process = undefined;
    this.#state = "closed";
  }

  async forceClose(): Promise<void> {
    if (this.#state === "closed") return;
    this.#state = "closing";
    this.#clearHandshake();
    const processHandle = this.#process;
    if (processHandle !== undefined && processHandle.exitCode === null && processHandle.signalCode === null) {
      try { processHandle.kill("SIGKILL"); } catch { /* Exit confirmation below is authoritative. */ }
      if (!(await processExitBefore(processHandle, SHUTDOWN_TIMEOUT_MS))) {
        throw new TransportFault("shutdown_unconfirmed", "The remote Codex proxy did not confirm hard shutdown.", { stateMayHaveChanged: true });
      }
    }
    this.#process = undefined;
    this.#state = "closed";
  }

  #acceptBytes(chunk: Buffer | string): void {
    if (this.#state !== "starting" && this.#state !== "running") return;
    const value = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
    try {
      if (this.#state === "starting") this.#acceptHandshakeBytes(value);
      else this.#acceptFrameBytes(value);
    } catch (error) {
      this.#fail(error instanceof TransportFault
        ? error
        : new TransportFault("protocol_violation", "The remote Codex WebSocket stream was invalid."));
    }
  }

  #acceptHandshakeBytes(chunk: Buffer): void {
    if (this.#handshakeBuffer.byteLength + chunk.byteLength > MAXIMUM_HANDSHAKE_BYTES) {
      throw new TransportFault("buffer_overflow", "The remote Codex WebSocket handshake exceeded its byte limit.");
    }
    this.#handshakeBuffer = Buffer.concat([this.#handshakeBuffer, chunk]);
    const end = this.#handshakeBuffer.indexOf("\r\n\r\n", 0, "ascii");
    if (end < 0) return;
    const header = this.#handshakeBuffer.subarray(0, end).toString("ascii");
    const remainder = this.#handshakeBuffer.subarray(end + 4);
    this.#handshakeBuffer = Buffer.alloc(0);
    const lines = header.split("\r\n");
    if (!/^HTTP\/1\.1 101(?:\s|$)/u.test(lines[0] ?? "")) {
      throw new TransportFault("protocol_violation", "The remote Codex WebSocket upgrade was rejected.");
    }
    const headers = new Map<string, string>();
    for (const line of lines.slice(1)) {
      const colon = line.indexOf(":");
      if (colon <= 0) throw new TransportFault("protocol_violation", "The remote Codex WebSocket upgrade headers were invalid.");
      const name = line.slice(0, colon).trim().toLowerCase();
      const value = line.slice(colon + 1).trim();
      if (headers.has(name)) throw new TransportFault("protocol_violation", "The remote Codex WebSocket upgrade headers were ambiguous.");
      headers.set(name, value);
    }
    if (headers.get("upgrade")?.toLowerCase() !== "websocket"
      || !headers.get("connection")?.toLowerCase().split(",").map((value) => value.trim()).includes("upgrade")
      || headers.get("sec-websocket-accept") !== this.#expectedAccept
      || headers.has("sec-websocket-extensions")) {
      throw new TransportFault("protocol_violation", "The remote Codex WebSocket upgrade proof was invalid.");
    }
    this.#options.assertCurrent();
    this.#state = "running";
    this.#clearHandshake(true);
    if (remainder.byteLength > 0) this.#acceptFrameBytes(remainder);
  }

  #acceptFrameBytes(chunk: Buffer): void {
    if (this.#frameBuffer.byteLength + chunk.byteLength > MAXIMUM_FRAME_BUFFER_BYTES) {
      throw new TransportFault("buffer_overflow", "The remote Codex WebSocket input exceeded its byte limit.");
    }
    this.#frameBuffer = Buffer.concat([this.#frameBuffer, chunk]);
    while (this.#frameBuffer.byteLength >= 2) {
      const first = this.#frameBuffer[0]!;
      const second = this.#frameBuffer[1]!;
      const fin = (first & 0x80) !== 0;
      const opcode = first & 0x0f;
      if ((first & 0x70) !== 0 || (second & 0x80) !== 0) throw frameProtocolFault();
      let headerBytes = 2;
      let payloadBytes = second & 0x7f;
      if (payloadBytes === 126) {
        if (this.#frameBuffer.byteLength < 4) return;
        payloadBytes = this.#frameBuffer.readUInt16BE(2);
        headerBytes = 4;
        if (payloadBytes < 126) throw frameProtocolFault();
      } else if (payloadBytes === 127) {
        if (this.#frameBuffer.byteLength < 10) return;
        const length = this.#frameBuffer.readBigUInt64BE(2);
        if (length < 65_536n || length > BigInt(MAXIMUM_MESSAGE_BYTES)) throw frameProtocolFault();
        payloadBytes = Number(length);
        headerBytes = 10;
      }
      if (payloadBytes > MAXIMUM_MESSAGE_BYTES) throw new TransportFault("buffer_overflow", "A remote Codex WebSocket message exceeded its byte limit.");
      if (this.#frameBuffer.byteLength < headerBytes + payloadBytes) return;
      const payload = Buffer.from(this.#frameBuffer.subarray(headerBytes, headerBytes + payloadBytes));
      this.#frameBuffer = this.#frameBuffer.subarray(headerBytes + payloadBytes);
      this.#acceptFrame(opcode, fin, payload);
      if (this.#state !== "running") return;
    }
  }

  #acceptFrame(opcode: number, fin: boolean, payload: Buffer): void {
    if (opcode >= 0x8) {
      if (!fin || payload.byteLength > 125) throw frameProtocolFault();
      if (opcode === 0x8) {
        if (payload.byteLength === 1) throw frameProtocolFault();
        if (payload.byteLength > 2) decodeUtf8(payload.subarray(2));
        const processHandle = this.#process;
        if (processHandle !== undefined) void this.#enqueueFrame(0x8, payload).catch(() => undefined);
        this.#fail(new TransportFault("process_exited", "The remote Codex WebSocket peer closed the channel.", { stateMayHaveChanged: true }));
        return;
      }
      if (opcode === 0x9) {
        void this.#enqueueFrame(0x0a, payload).catch(() => undefined);
        return;
      }
      if (opcode === 0x0a) return;
      throw frameProtocolFault();
    }
    if (opcode === 0x2) throw frameProtocolFault();
    if (opcode === 0x1) {
      if (this.#fragmentedText) throw frameProtocolFault();
      if (fin) {
        this.#deliverText(payload);
        return;
      }
      this.#fragmentedText = true;
      this.#fragmentChunks = [payload];
      this.#fragmentBytes = payload.byteLength;
      return;
    }
    if (opcode !== 0x0 || !this.#fragmentedText) throw frameProtocolFault();
    this.#fragmentBytes += payload.byteLength;
    if (this.#fragmentBytes > MAXIMUM_MESSAGE_BYTES) {
      throw new TransportFault("buffer_overflow", "A fragmented remote Codex WebSocket message exceeded its byte limit.");
    }
    this.#fragmentChunks.push(payload);
    if (!fin) return;
    const message = Buffer.concat(this.#fragmentChunks, this.#fragmentBytes);
    this.#fragmentChunks = [];
    this.#fragmentBytes = 0;
    this.#fragmentedText = false;
    this.#deliverText(message);
  }

  #deliverText(payload: Buffer): void {
    const text = decodeUtf8(payload);
    if (text.length === 0 || text.includes("\n") || text.includes("\r")) throw frameProtocolFault();
    this.#handlers?.onData(Buffer.from(`${text}\n`, "utf8"));
  }

  #enqueueFrame(opcode: number, payload: Buffer): Promise<void> {
    const operation = this.#writeTail.then(async () => {
      if (!this.running) throw new TransportFault("closed", "The remote Codex channel closed before write.");
      this.#options.assertCurrent();
      const processHandle = this.#process;
      if (processHandle === undefined) throw new TransportFault("closed", "The remote Codex proxy is unavailable.");
      await writeProcessBytes(processHandle, clientFrame(opcode, payload));
    });
    this.#writeTail = operation.catch(() => undefined);
    return operation;
  }

  async #writeCloseFrame(processHandle: RemoteProcessHandle): Promise<void> {
    await writeProcessBytes(processHandle, clientFrame(0x8, Buffer.alloc(0)));
  }

  #clearHandshake(success = false): void {
    if (this.#handshakeTimer !== undefined) clearTimeout(this.#handshakeTimer);
    this.#handshakeTimer = undefined;
    const resolve = this.#handshakeResolve;
    const reject = this.#handshakeReject;
    this.#handshakeResolve = undefined;
    this.#handshakeReject = undefined;
    if (success) resolve?.();
    else reject?.(new TransportFault("closed", "The remote Codex WebSocket handshake was closed."));
  }

  #fail(fault: TransportFault): void {
    if (this.#state === "closed" || this.#state === "closing") return;
    const starting = this.#state === "starting";
    this.#state = "closed";
    if (this.#handshakeTimer !== undefined) clearTimeout(this.#handshakeTimer);
    this.#handshakeTimer = undefined;
    const reject = this.#handshakeReject;
    this.#handshakeResolve = undefined;
    this.#handshakeReject = undefined;
    this.#handshakeBuffer = Buffer.alloc(0);
    this.#frameBuffer = Buffer.alloc(0);
    const processHandle = this.#process;
    this.#process = undefined;
    if (processHandle !== undefined && processHandle.exitCode === null && processHandle.signalCode === null) {
      try { processHandle.kill("SIGKILL"); } catch { /* The proxy may already be gone. */ }
    }
    if (starting) {
      reject?.(fault);
      return;
    }
    if (this.#exitDelivered) return;
    this.#exitDelivered = true;
    void Promise.resolve(this.#handlers?.onExit(fault)).catch(() => undefined);
  }
}

async function ensureDaemon(options: RemoteCodexWebSocketChannelOptions): Promise<string> {
  const version = async () => {
    options.assertCurrent();
    const result = await runRemoteCommand(options.processes, {
      executable: options.executable,
      args: ["app-server", "daemon", "version"],
      cwd: options.workspaceRoot,
      env: { CODEX_HOME: options.profileRoot },
      timeoutMs: PROBE_TIMEOUT_MS
    });
    options.assertCurrent();
    return result;
  };
  let available = await version();
  if (available.exitCode !== 0) {
    options.assertCurrent();
    const bootstrap = await runRemoteCommand(options.processes, {
      executable: options.executable,
      args: ["app-server", "daemon", "bootstrap", "--remote-control"],
      cwd: options.workspaceRoot,
      env: { CODEX_HOME: options.profileRoot },
      timeoutMs: DAEMON_BOOTSTRAP_TIMEOUT_MS
    });
    options.assertCurrent();
    if (bootstrap.exitCode !== 0) throw remoteRuntimeFault("The remote Codex daemon could not be bootstrapped.");
    available = await version();
  }
  if (available.exitCode !== 0) throw remoteRuntimeFault("The remote Codex daemon is unavailable.");
  return daemonSocketPath(available.stdout, options.profileRoot);
}

function daemonSocketPath(stdout: Buffer, profileRoot: string): string {
  let value: unknown;
  try {
    value = JSON.parse(stdout.toString("utf8"));
  } catch {
    throw remoteRuntimeFault("The remote Codex daemon returned invalid availability metadata.");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw remoteRuntimeFault("The remote Codex daemon returned invalid availability metadata.");
  }
  const record = value as Readonly<Record<string, unknown>>;
  const socketPath = typeof record["socketPath"] === "string"
    ? record["socketPath"]
    : typeof record["socket_path"] === "string"
      ? record["socket_path"]
      : undefined;
  if (socketPath === undefined || !normalizedAbsoluteRemotePath(socketPath)
    || socketPath === profileRoot || !socketPath.startsWith(`${profileRoot}/`)) {
    throw remoteRuntimeFault("The remote Codex daemon socket is outside its isolated profile.");
  }
  return socketPath;
}

function clientFrame(opcode: number, payload: Buffer): Buffer {
  if (payload.byteLength > MAXIMUM_MESSAGE_BYTES) throw new TransportFault("buffer_overflow", "The remote Codex WebSocket output exceeded its byte limit.");
  const extended = payload.byteLength < 126 ? 0 : payload.byteLength <= 0xffff ? 2 : 8;
  const frame = Buffer.allocUnsafe(2 + extended + 4 + payload.byteLength);
  frame[0] = 0x80 | opcode;
  if (extended === 0) frame[1] = 0x80 | payload.byteLength;
  else if (extended === 2) {
    frame[1] = 0x80 | 126;
    frame.writeUInt16BE(payload.byteLength, 2);
  } else {
    frame[1] = 0x80 | 127;
    frame.writeBigUInt64BE(BigInt(payload.byteLength), 2);
  }
  const maskOffset = 2 + extended;
  randomBytes(4).copy(frame, maskOffset);
  for (let index = 0; index < payload.byteLength; index += 1) {
    frame[maskOffset + 4 + index] = payload[index]! ^ frame[maskOffset + (index % 4)]!;
  }
  return frame;
}

function decodeUtf8(value: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(value);
  } catch {
    throw frameProtocolFault();
  }
}

function frameProtocolFault(): TransportFault {
  return new TransportFault("protocol_violation", "The remote Codex WebSocket peer emitted an invalid frame.");
}

async function writeProcessBytes(processHandle: RemoteProcessHandle, bytes: Buffer): Promise<void> {
  if (processHandle.exitCode !== null || processHandle.signalCode !== null) {
    throw new TransportFault("write_failed", "The remote Codex proxy closed before write.", { stateMayHaveChanged: true });
  }
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error | null): void => {
      if (settled) return;
      settled = true;
      if (error === undefined || error === null) resolve();
      else reject(new TransportFault("write_failed", "The remote Codex proxy write failed.", { stateMayHaveChanged: true }));
    };
    try {
      processHandle.stdin.write(bytes, finish);
    } catch {
      finish(new Error("write failed"));
    }
  });
}

async function processExitBefore(processHandle: RemoteProcessHandle, timeoutMs: number): Promise<boolean> {
  if (processHandle.exitCode !== null || processHandle.signalCode !== null) return true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([
      new Promise<true>((resolve) => processHandle.once("exit", () => resolve(true))),
      timeout
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function requireProcesses(lease: RemoteSshTransportLease): RemoteProcessTransportPort {
  if (lease.capabilities.processStreaming !== true || lease.processes === undefined) {
    throw remoteRuntimeFault("The SSH process-stream capability is unavailable.");
  }
  return lease.processes;
}

function requireRemoteBinding(target: TargetDescriptor): NonNullable<TargetDescriptor["remoteWorkspace"]> {
  const binding = target.remoteWorkspace;
  if (binding === undefined || binding.hostId.length === 0 || binding.hostId.length > 256
    || !normalizedAbsoluteRemotePath(binding.workspaceRoot)) {
    throw remoteRuntimeFault("The remote Codex Target binding is invalid.");
  }
  return binding;
}

function normalizedAbsoluteRemotePath(value: string): boolean {
  return value.length > 0
    && value.length <= 16_384
    && !/[\u0000-\u001f\u007f\\]/u.test(value)
    && remotePath.isAbsolute(value)
    && remotePath.normalize(value) === value;
}

function executionDomainFor(host: RemoteHostRecord, profileRoot: string): string {
  if (host.trust === undefined
    || host.trust.algorithm.length === 0
    || host.trust.fingerprint.length === 0
    || host.user.length === 0) {
    throw remoteRuntimeFault("The remote Codex host identity is not pinned.");
  }
  return JSON.stringify({
    kind: "ssh-codex-profile-v1",
    algorithm: host.trust.algorithm,
    fingerprint: host.trust.fingerprint,
    user: host.user,
    profileRoot
  });
}

function targetSignature(target: TargetDescriptor): string {
  return JSON.stringify({
    id: target.id,
    backendId: target.backendId,
    displayName: target.displayName,
    workspaceRoot: target.workspaceRoot,
    managed: target.managed,
    trusted: target.trusted,
    remoteWorkspace: target.remoteWorkspace ?? null
  });
}

function remoteRuntimeFault(message: string): Error {
  return new Error(message);
}
