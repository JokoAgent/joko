import { randomUUID } from "node:crypto";
import { WebSocket, type RawData } from "ws";
import { validateAudioChunk, type AsrEvent, type AsrProvider, type AsrStartRequest, type AudioChunk } from "@joko/voice-input";
import { audioFrame, configurationFrame, MAXIMUM_MESSAGE_BYTES, serverMessage, type ServerMessage } from "./protocol.js";

const PCM_BYTES_PER_MS = 32;
const PACKET_MS = 200;
const PACKET_BYTES = PACKET_MS * PCM_BYTES_PER_MS;
const REPLAY_BYTES = 60_000 * PCM_BYTES_PER_MS;
const MAXIMUM_SOCKET_BYTES = 4 * 1024 * 1024;
const RESOURCES = new Set(["volc.bigasr.sauc.duration", "volc.bigasr.sauc.concurrent", "volc.seedasr.sauc.duration", "volc.seedasr.sauc.concurrent"]);

export interface SaucTranscriptionConfiguration {
  readonly endpoint: string;
  readonly resourceId: string;
}
export interface SaucTranscriptionRoute extends SaucTranscriptionConfiguration {
  readonly apiKey: string;
  readonly connectTimeoutMs?: number;
  readonly flushTimeoutMs?: number;
}
type FailureCode = "authentication" | "quota" | "network" | "timeout" | "route" | "protocol" | "stopped";
export class SaucTranscriptionError extends Error {
  constructor(readonly code: FailureCode) {
    super(`Realtime transcription failed (${code}).`);
    this.name = "SaucTranscriptionError";
  }
}
export type SaucTranscriptionProbeResult = { readonly ok: true } | {
  readonly ok: false;
  readonly reason: "authenticationFailed" | "timeout" | "network" | "routeUnavailable" | "serviceError";
};
type PendingAudio = { data: Buffer; offset: number };
type Waiter = { check: () => boolean; finish: (error?: SaucTranscriptionError) => void };

/** Owns one ephemeral capture and the native SAUC v1 binary WebSocket protocol. */
export class SaucTranscriptionProvider implements AsrProvider {
  readonly #route: Omit<ReturnType<typeof validateSaucTranscriptionRoute>, "apiKey">;
  #apiKey: string | undefined;
  readonly #listeners = new Set<(event: AsrEvent) => void>();
  readonly #waiters = new Set<Waiter>();
  readonly #pending: PendingAudio[] = [];
  #pendingBytes = 0;
  #replay: Buffer | undefined = Buffer.alloc(REPLAY_BYTES);
  #replayBytes = 0;
  #totals = { bytes: 0, durationMs: 0 };
  #state: "idle" | "starting" | "ready" | "disconnected" | "finished" | "failed" | "stopped" = "idle";
  #socket: WebSocket | undefined;
  #generation = 0;
  #sequence = 1;
  #sentBytes = 0;
  #recoveryTarget = 0;
  #stable = "";
  #text = "";
  #publishedText = "";
  #recoveryPrefix = "";
  #connectReject: ((error: SaucTranscriptionError) => void) | undefined;
  #pumpTimer: ReturnType<typeof setTimeout> | undefined;
  #heartbeat: ReturnType<typeof setInterval> | undefined;
  #pongTimer: ReturnType<typeof setTimeout> | undefined;
  #flushing = false;
  #lastSent = false;
  #flushTask: Promise<void> | undefined;
  #recoveryTask: Promise<void> | undefined;
  #recoveries = 0;

  constructor(route: SaucTranscriptionRoute) {
    const { apiKey, ...configuration } = validateSaucTranscriptionRoute(route);
    this.#apiKey = apiKey;
    this.#route = configuration;
  }

  start(request: AsrStartRequest): Promise<void> {
    if (this.#state !== "idle" || request.mimeType !== "audio/pcm") return Promise.reject(new SaucTranscriptionError("protocol"));
    // The async two-pass API auto-detects language; it has no supported locale override.
    return this.#connect();
  }

  appendAudio(chunk: AudioChunk): void {
    if (this.#flushing || !["starting", "ready", "disconnected"].includes(this.#state)) return;
    try {
      this.#totals = validateAudioChunk(chunk, this.#totals);
      if (chunk.data.byteLength % 2 !== 0 || Math.abs(chunk.data.byteLength / PCM_BYTES_PER_MS - chunk.durationMs) > 1) {
        throw new SaucTranscriptionError("protocol");
      }
      const data = Buffer.from(new Uint8Array(chunk.data));
      if (this.#replay !== undefined) {
        if (this.#replayBytes + data.length <= REPLAY_BYTES) {
          data.copy(this.#replay, this.#replayBytes);
          this.#replayBytes += data.length;
        } else {
          this.#replay.fill(0);
          this.#replay = undefined;
          this.#replayBytes = 0;
        }
      }
      if (this.#pendingBytes + data.length > REPLAY_BYTES || this.#pending.length >= 4_096) {
        data.fill(0);
        this.#fail("protocol");
        return;
      }
      this.#pending.push({ data, offset: 0 });
      this.#pendingBytes += data.length;
      this.#pump();
    } catch { this.#fail("protocol"); }
  }

  flushAudio(): Promise<void> {
    if (this.#flushTask !== undefined) return this.#flushTask;
    this.#flushing = true;
    this.#flushTask = this.#flush();
    return this.#flushTask;
  }

  async #flush(): Promise<void> {
    await this.#recoveryTask;
    if (this.#state !== "ready") throw new SaucTranscriptionError("network");
    // No audio was captured, so there is no remote recognition to finalize.
    if (this.#totals.bytes === 0) return;
    const completion = this.#wait(() => this.#state === "finished", this.#pendingBytes / PCM_BYTES_PER_MS + this.#route.flushTimeoutMs);
    this.#pump();
    await completion;
  }

  recover(): Promise<void> {
    if (this.#recoveryTask !== undefined) return this.#recoveryTask;
    if (this.#state !== "disconnected" || this.#replay === undefined || this.#recoveries >= 3 || this.#flushing) {
      return Promise.reject(new SaucTranscriptionError("network"));
    }
    this.#recoveries += 1;
    const task = this.#recover();
    this.#recoveryTask = task;
    const clear = (): void => { if (this.#recoveryTask === task) this.#recoveryTask = undefined; };
    void task.then(clear, clear);
    return task;
  }

  async #recover(): Promise<void> {
    this.#recoveryPrefix = this.#stable;
    this.#text = "";
    this.#sentBytes = 0;
    this.#recoveryTarget = this.#replayBytes;
    this.#clearPending();
    if (this.#replayBytes > 0) {
      this.#pending.push({ data: Buffer.from(this.#replay!.subarray(0, this.#replayBytes)), offset: 0 });
      this.#pendingBytes = this.#replayBytes;
    }
    await this.#connect();
    await this.#wait(() => this.#sentBytes >= this.#recoveryTarget && this.#recoveryPrefix === "",
      this.#recoveryTarget / PCM_BYTES_PER_MS + this.#route.connectTimeoutMs);
  }

  async stop(): Promise<void> {
    if (this.#state === "stopped") return;
    this.#state = "stopped";
    this.#retire(new SaucTranscriptionError("stopped"));
    this.#apiKey = undefined;
    this.#replay?.fill(0);
    this.#replay = undefined;
    this.#replayBytes = 0;
    this.#stable = "";
    this.#text = "";
    this.#recoveryPrefix = "";
    this.#publishedText = "";
    this.#listeners.clear();
  }

  onEvent(listener: (event: AsrEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #connect(): Promise<void> {
    this.#state = "starting";
    this.#sequence = 1;
    this.#lastSent = false;
    const generation = ++this.#generation;
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: SaucTranscriptionError): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.#connectReject = undefined;
        if (error === undefined) resolve(); else reject(error);
      };
      const timer = setTimeout(() => this.#fail("timeout"), this.#route.connectTimeoutMs);
      this.#connectReject = (error) => finish(error);
      let socket: WebSocket;
      try {
        socket = new WebSocket(this.#route.endpoint, {
          headers: { "X-Api-Key": this.#apiKey!, "X-Api-Resource-Id": this.#route.resourceId,
            "X-Api-Request-Id": randomUUID(), "X-Api-Connect-Id": randomUUID(), "X-Api-Sequence": "-1" },
          followRedirects: false, maxPayload: MAXIMUM_MESSAGE_BYTES, perMessageDeflate: false,
          handshakeTimeout: this.#route.connectTimeoutMs
        });
      } catch { this.#fail("protocol"); return; }
      this.#socket = socket;
      const current = (): boolean => this.#generation === generation && this.#socket === socket;
      socket.on("error", (error) => {
        if (!current()) return;
        const code = "code" in error ? error.code : undefined;
        this.#fail(typeof code === "string" && code.startsWith("WS_ERR_") ? "protocol" : "network");
      });
      socket.on("unexpected-response", (_request, response) => {
        response.destroy();
        if (current()) this.#fail(httpFailure(response.statusCode ?? 500));
      });
      socket.on("close", () => { if (current()) this.#fail("network", true); });
      socket.on("open", () => { if (current()) this.#send(configurationFrame()); });
      socket.on("pong", () => {
        if (!current()) return;
        clearTimeout(this.#pongTimer);
        this.#pongTimer = undefined;
      });
      socket.on("message", (raw, binary) => {
        if (!current()) return;
        try {
          if (!binary) throw new SaucTranscriptionError("protocol");
          const message = serverMessage(bytes(raw));
          if (message.type === "error") { this.#fail(serviceFailure(message.code)); return; }
          if (this.#state === "starting") {
            if (message.last || (message.sequence !== undefined && message.sequence !== 1)
              || (message.text !== undefined && message.text !== "")) throw new SaucTranscriptionError("protocol");
            this.#state = "ready";
            this.#heartbeat = setInterval(() => {
              if (!current() || this.#pongTimer !== undefined) return;
              this.#pongTimer = setTimeout(() => { if (current()) this.#fail("network"); }, 8_000);
              socket.ping(undefined, undefined, (error) => { if (error && current()) this.#fail("network"); });
            }, 25_000);
            finish();
            this.#emit({ type: "connected" });
            this.#pump();
          } else this.#result(message);
        } catch { if (current()) this.#fail("protocol"); }
      });
    });
  }

  #result(message: Extract<ServerMessage, { type: "result" }>): void {
    if (this.#state !== "ready" || (message.last && !this.#lastSent)) { this.#fail("protocol"); return; }
    if (message.text === undefined) {
      if (message.last && this.#text !== "") { this.#fail("protocol"); return; }
    } else {
      const text = message.text;
      const stable = message.stable!;
      const previousText = this.#publishedText;
      if (this.#recoveryPrefix !== "") {
        if (stable.startsWith(this.#recoveryPrefix)) this.#recoveryPrefix = "";
        else if (!this.#recoveryPrefix.startsWith(stable) || message.last) { this.#fail("protocol"); return; }
      }
      this.#text = text;
      if (this.#recoveryPrefix === "") {
        if (!stable.startsWith(this.#stable) || !text.startsWith(this.#stable)) { this.#fail("protocol"); return; }
        if (stable !== this.#stable || (text === stable && text !== previousText)) {
          this.#stable = stable;
          this.#publishedText = stable;
          this.#emit({ type: "stable", text: stable });
        }
        if (text !== stable) {
          this.#publishedText = text;
          this.#emit({ type: "partial", text });
        }
      }
    }
    if (message.last) {
      if (this.#recoveryPrefix !== "") { this.#fail("protocol"); return; }
      this.#state = "finished";
      this.#settleWaiters();
      this.#retire(new SaucTranscriptionError("stopped"));
    } else this.#settleWaiters();
  }

  #pump(): void {
    if (this.#state !== "ready" || this.#pumpTimer !== undefined || this.#lastSent) return;
    // Normal capture packets are 200 ms. Flush and recovery also send their short tail.
    const drainTail = this.#flushing || this.#sentBytes < this.#recoveryTarget;
    if (this.#pendingBytes < PACKET_BYTES && !drainTail) return;
    if (this.#pendingBytes === 0 && (!this.#flushing || this.#recoveryTask !== undefined)) { this.#settleWaiters(); return; }
    const size = Math.min(PACKET_BYTES, this.#pendingBytes);
    const data = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      const next = this.#pending[0]!;
      const length = Math.min(size - offset, next.data.length - next.offset);
      next.data.copy(data, offset, next.offset, next.offset + length);
      next.offset += length;
      offset += length;
      this.#pendingBytes -= length;
      if (next.offset === next.data.length) { this.#pending.shift(); next.data.fill(0); }
    }
    this.#sentBytes += size;
    const last = this.#flushing && this.#pendingBytes === 0 && this.#recoveryTask === undefined;
    this.#sequence += 1;
    this.#lastSent = last;
    const sent = this.#send(audioFrame(data, last ? -this.#sequence : this.#sequence));
    data.fill(0);
    if (!sent) return;
    this.#settleWaiters();
    if (!last) this.#pumpTimer = setTimeout(() => {
      this.#pumpTimer = undefined;
      this.#pump();
    }, PACKET_MS);
  }

  #send(data: Buffer): boolean {
    const socket = this.#socket;
    const generation = this.#generation;
    if (socket?.readyState !== WebSocket.OPEN || socket.bufferedAmount + data.length > MAXIMUM_SOCKET_BYTES) {
      this.#fail("network"); return false;
    }
    try {
      socket.send(data, (error) => { if (error && this.#generation === generation && this.#socket === socket) this.#fail("network"); });
      return true;
    } catch { this.#fail("network"); return false; }
  }

  #wait(check: () => boolean, timeoutMs: number): Promise<void> {
    if (check()) return Promise.resolve();
    if (this.#state !== "ready") return Promise.reject(new SaucTranscriptionError(this.#state === "stopped" ? "stopped" : "network"));
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = { check, finish: (error) => {
        clearTimeout(timer);
        this.#waiters.delete(waiter);
        if (error === undefined) resolve(); else reject(error);
      } };
      const timer = setTimeout(() => {
        waiter.finish(new SaucTranscriptionError("timeout"));
        this.#fail("timeout");
      }, timeoutMs);
      this.#waiters.add(waiter);
    });
  }
  #settleWaiters(): void {
    for (const waiter of [...this.#waiters]) if (waiter.check()) waiter.finish();
  }
  #fail(code: FailureCode, disconnected = false): void {
    if (["failed", "finished", "stopped"].includes(this.#state)) return;
    const wasReady = this.#state === "ready";
    const recoverable = wasReady && !this.#flushing && this.#replay !== undefined && this.#recoveries < 3
      && (code === "network" || code === "timeout" || code === "route");
    this.#state = recoverable ? "disconnected" : "failed";
    this.#retire(new SaucTranscriptionError(code));
    this.#emit(disconnected && wasReady ? { type: "disconnected", recoverable }
      : { type: "error", category: code === "authentication" ? "authentication" : code === "quota" ? "quota"
        : code === "protocol" ? "protocol" : "transport", recoverable });
  }
  #retire(error: SaucTranscriptionError): void {
    this.#generation += 1;
    this.#connectReject?.(error);
    for (const waiter of [...this.#waiters]) waiter.finish(error);
    clearTimeout(this.#pumpTimer);
    this.#pumpTimer = undefined;
    clearInterval(this.#heartbeat);
    this.#heartbeat = undefined;
    clearTimeout(this.#pongTimer);
    this.#pongTimer = undefined;
    this.#clearPending();
    const socket = this.#socket;
    this.#socket = undefined;
    // The fenced error listener remains while ws retires asynchronously.
    socket?.terminate();
  }
  #clearPending(): void {
    for (const item of this.#pending) item.data.fill(0);
    this.#pending.length = 0;
    this.#pendingBytes = 0;
  }
  #emit(event: AsrEvent): void {
    if (this.#state !== "stopped") for (const listener of [...this.#listeners]) listener(event);
  }
}

export function validateSaucTranscriptionRoute(input: SaucTranscriptionRoute): {
  endpoint: string; resourceId: string; apiKey: string; connectTimeoutMs: number; flushTimeoutMs: number;
} {
  const configuration = validateSaucTranscriptionConfiguration(input);
  if (typeof input.apiKey !== "string" || input.apiKey.length === 0 || input.apiKey.length > 8_192 || /[^\x21-\x7e]/u.test(input.apiKey)) {
    throw new SaucTranscriptionError("protocol");
  }
  return { ...configuration, apiKey: input.apiKey,
    connectTimeoutMs: timeout(input.connectTimeoutMs ?? 8_000), flushTimeoutMs: timeout(input.flushTimeoutMs ?? 4_000) };
}

export function validateSaucTranscriptionConfiguration(input: SaucTranscriptionConfiguration): SaucTranscriptionConfiguration {
  let endpoint: URL;
  try { endpoint = new URL(input.endpoint); } catch { throw new SaucTranscriptionError("protocol"); }
  const loopback = endpoint.hostname === "localhost" || endpoint.hostname === "[::1]" || /^127(?:\.\d{1,3}){3}$/u.test(endpoint.hostname);
  if (endpoint.href.length > 2_048 || (endpoint.protocol !== "wss:" && !(endpoint.protocol === "ws:" && loopback))
    || endpoint.username !== "" || endpoint.password !== "" || endpoint.search !== "" || endpoint.hash !== ""
    || endpoint.pathname !== "/api/v3/sauc/bigmodel_async" || !RESOURCES.has(input.resourceId)) {
    throw new SaucTranscriptionError("protocol");
  }
  return { endpoint: endpoint.href, resourceId: input.resourceId };
}

export async function probeSaucTranscriptionRoute(route: SaucTranscriptionRoute): Promise<SaucTranscriptionProbeResult> {
  let provider: SaucTranscriptionProvider | undefined;
  try {
    provider = new SaucTranscriptionProvider(route);
    await provider.start({ runId: `probe-${randomUUID()}`, mimeType: "audio/pcm" });
    return { ok: true };
  } catch (error) {
    const code = error instanceof SaucTranscriptionError ? error.code : "protocol";
    return { ok: false, reason: code === "authentication" ? "authenticationFailed" : code === "timeout" ? "timeout"
      : code === "network" ? "network" : code === "route" ? "routeUnavailable" : "serviceError" };
  } finally { await provider?.stop(); }
}
function timeout(value: number): number {
  if (!Number.isSafeInteger(value) || value < 250 || value > 120_000) throw new SaucTranscriptionError("protocol");
  return value;
}
function httpFailure(status: number): FailureCode {
  return status === 401 || status === 403 ? "authentication" : status === 429 ? "quota"
    : status === 408 || status === 504 ? "timeout" : status === 404 || status >= 500 ? "route" : "protocol";
}
function serviceFailure(code: number): FailureCode {
  return code === 45000081 ? "timeout" : code >= 55000000 && code <= 55099999 ? "route" : "protocol";
}
function bytes(value: RawData): Buffer {
  return Array.isArray(value) ? Buffer.concat(value) : value instanceof ArrayBuffer ? Buffer.from(value)
    : Buffer.from(value.buffer, value.byteOffset, value.byteLength);
}
