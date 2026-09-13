import { randomUUID } from "node:crypto";
import type { ClientRequest, IncomingMessage } from "node:http";
import WebSocket, { type RawData } from "ws";
import type {
  AsrErrorCategory,
  AsrEvent,
  AsrProvider,
  AsrStartRequest,
  AudioChunk
} from "@joko/voice-input";

export type RealtimeTranscriptionProtocol = "openaiRealtime" | "qwenRealtime";

export interface RealtimeTranscriptionRoute {
  readonly protocol: RealtimeTranscriptionProtocol;
  readonly endpoint: string;
  readonly model: string;
  readonly apiKey?: string;
  readonly inputPcmSampleRate?: number;
  readonly connectTimeoutMs?: number;
  readonly flushTimeoutMs?: number;
}

export interface RealtimeTranscriptionProviderOptions extends RealtimeTranscriptionRoute {
  readonly locale?: string;
  readonly now?: () => number;
}

export type RealtimeTranscriptionErrorCode =
  | "authentication"
  | "network"
  | "protocol"
  | "quota"
  | "route"
  | "timeout";

export type RealtimeTranscriptionProbeResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: "authenticationFailed" | "network" | "routeUnavailable" | "serviceError" | "timeout";
    };

/** Content-free transport error: upstream response text is never retained. */
export class RealtimeTranscriptionError extends Error {
  readonly code: RealtimeTranscriptionErrorCode;

  constructor(code: RealtimeTranscriptionErrorCode) {
    super(`Realtime transcription failed (${code}).`);
    this.name = "RealtimeTranscriptionError";
    this.code = code;
  }
}

const DEFAULT_INPUT_PCM_SAMPLE_RATE = 16_000;
const OPENAI_PCM_SAMPLE_RATE = 24_000;
const QWEN_PCM_SAMPLE_RATE = 16_000;
const DEFAULT_CONNECT_TIMEOUT_MS = 8_000;
const DEFAULT_FLUSH_TIMEOUT_MS = 4_000;
const MINIMUM_TIMEOUT_MS = 250;
const MAXIMUM_TIMEOUT_MS = 120_000;
const MINIMUM_COMMIT_AUDIO_MS = 100;
const MAXIMUM_MESSAGE_BYTES = 256 * 1024;
const MAXIMUM_TRANSCRIPT_CHARACTERS = 200_000;
const MAXIMUM_REPLAY_AUDIO_MS = 60_000;
const PARTIAL_CONFIRMATION_LATENCY_MS = 1_500;
const KEEPALIVE_INTERVAL_MS = 25_000;
const KEEPALIVE_TIMEOUT_MS = 8_000;
const ALLOWED_QUERY_KEYS = new Set([
  "api-version",
  "api_version",
  "audio_format",
  "commit_strategy",
  "deployment",
  "intent",
  "language",
  "language_code",
  "model",
  "model_id",
  "tenant",
  "vad_silence_threshold_secs"
]);

interface ValidatedRoute {
  readonly protocol: RealtimeTranscriptionProtocol;
  readonly endpoint: string;
  readonly model: string;
  readonly apiKey?: string;
  readonly inputPcmSampleRate: number;
  readonly targetPcmSampleRate: number;
  readonly connectTimeoutMs: number;
  readonly flushTimeoutMs: number;
}

interface ReplayChunk {
  readonly pcm: Buffer;
  readonly durationMs: number;
  readonly addedAt: number;
}

export class RealtimeTranscriptionProvider implements AsrProvider {
  readonly #protocol: RealtimeTranscriptionProtocol;
  readonly #endpoint: string;
  readonly #model: string;
  #apiKey: string | undefined;
  readonly #locale: string | undefined;
  readonly #inputPcmSampleRate: number;
  readonly #targetPcmSampleRate: number;
  readonly #connectTimeoutMs: number;
  readonly #flushTimeoutMs: number;
  readonly #now: () => number;
  readonly #listeners = new Set<(event: AsrEvent) => void>();
  readonly #intentionalSockets = new WeakSet<WebSocket>();
  #socket: WebSocket | undefined;
  #startRequest: AsrStartRequest | undefined;
  #state: "idle" | "starting" | "started" | "stopped" = "idle";
  #itemOrder: string[] = [];
  #partials = new Map<string, string>();
  #finals = new Map<string, string>();
  #replay: ReplayChunk[] = [];
  #replayDurationMs = 0;
  #bufferedDurationMs = 0;
  #pendingCommits = 0;
  #flushWaiters = new Set<() => void>();
  #recovery: Promise<void> | undefined;
  #keepalive: ReturnType<typeof setInterval> | undefined;
  #pongDeadline: ReturnType<typeof setTimeout> | undefined;

  constructor(options: RealtimeTranscriptionProviderOptions) {
    const route = validateRealtimeTranscriptionRoute(options);
    this.#protocol = route.protocol;
    this.#endpoint = route.endpoint;
    this.#model = route.model;
    this.#apiKey = route.apiKey;
    this.#locale = normalizeLanguage(options.locale);
    this.#inputPcmSampleRate = route.inputPcmSampleRate;
    this.#targetPcmSampleRate = route.targetPcmSampleRate;
    this.#connectTimeoutMs = route.connectTimeoutMs;
    this.#flushTimeoutMs = route.flushTimeoutMs;
    this.#now = options.now ?? Date.now;
  }

  async start(request: AsrStartRequest): Promise<void> {
    if (
      this.#state !== "idle"
      || request.mimeType !== "audio/pcm"
      || normalizeLanguage(request.locale) !== this.#locale
    ) throw new RealtimeTranscriptionError("protocol");
    this.#state = "starting";
    this.#startRequest = request;
    this.#resetTranscript();
    await this.#connect();
    if ((this.#state as string) === "stopped") throw new RealtimeTranscriptionError("network");
    this.#state = "started";
    this.#emit({ type: "connected" });
  }

  appendAudio(chunk: AudioChunk): void {
    if (this.#state !== "started") return;
    if (chunk.data.byteLength === 0 || chunk.data.byteLength % 2 !== 0) {
      throw new RealtimeTranscriptionError("protocol");
    }
    const pcm = resamplePcm16(
      Buffer.from(chunk.data),
      this.#inputPcmSampleRate,
      this.#targetPcmSampleRate
    );
    if (pcm.byteLength === 0) return;
    this.#bufferReplay({ pcm, durationMs: chunk.durationMs, addedAt: this.#now() });
    const socket = this.#socket as WebSocket | undefined;
    if (socket === undefined || socket.readyState !== WebSocket.OPEN) return;
    this.#send(socket, buildAppendAudioMessage(pcm.toString("base64"), this.#protocol));
    this.#bufferedDurationMs += chunk.durationMs;
  }

  async flushAudio(): Promise<void> {
    if (this.#state !== "started") return;
    await this.#recovery;
    const socket = this.#socket;
    if (socket === undefined || socket.readyState !== WebSocket.OPEN) {
      throw new RealtimeTranscriptionError("network");
    }
    if (this.#protocol === "qwenRealtime") {
      if (this.#bufferedDurationMs <= 0) return;
      this.#send(socket, buildFinishSessionMessage(this.#protocol));
      this.#bufferedDurationMs = 0;
    } else {
      if (this.#bufferedDurationMs < MINIMUM_COMMIT_AUDIO_MS) {
        this.#bufferedDurationMs = 0;
        return;
      }
      this.#send(socket, { type: "input_audio_buffer.commit" });
      this.#bufferedDurationMs = 0;
      this.#pendingCommits += 1;
    }
    await this.#waitForFlush();
  }

  async stop(): Promise<void> {
    if (this.#state === "stopped") return;
    this.#state = "stopped";
    this.#stopKeepalive();
    this.#resolveFlushWaiters();
    const socket = this.#socket;
    this.#socket = undefined;
    if (socket !== undefined) {
      this.#intentionalSockets.add(socket);
      if (socket.readyState === WebSocket.CONNECTING) socket.terminate();
      else if (socket.readyState === WebSocket.OPEN) socket.close();
    }
    this.#replay = [];
    this.#replayDurationMs = 0;
    this.#partials.clear();
    this.#finals.clear();
    this.#itemOrder = [];
    this.#apiKey = undefined;
    this.#listeners.clear();
  }

  onEvent(listener: (event: AsrEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  recover(): Promise<void> {
    if (this.#state !== "started") return Promise.reject(new RealtimeTranscriptionError("network"));
    if (this.#recovery !== undefined) return this.#recovery;
    const recovery = this.#performRecovery().finally(() => {
      if (this.#recovery === recovery) this.#recovery = undefined;
    });
    this.#recovery = recovery;
    return recovery;
  }

  async #performRecovery(): Promise<void> {
    for (const [itemId, value] of this.#partials) {
      if (value !== "" && !this.#finals.has(itemId)) this.#finals.set(itemId, value);
    }
    this.#partials.clear();
    const oldSocket = this.#socket;
    this.#socket = undefined;
    if (oldSocket !== undefined) {
      this.#intentionalSockets.add(oldSocket);
      if (oldSocket.readyState === WebSocket.CONNECTING) oldSocket.terminate();
      else if (oldSocket.readyState === WebSocket.OPEN) oldSocket.close();
    }
    this.#stopKeepalive();
    await this.#connect();
    if (this.#state !== "started") throw new RealtimeTranscriptionError("network");
    const socket = this.#socket as WebSocket | undefined;
    if (socket === undefined || socket.readyState !== WebSocket.OPEN) {
      throw new RealtimeTranscriptionError("network");
    }
    this.#bufferedDurationMs = 0;
    for (const chunk of this.#replay) {
      this.#send(socket, buildAppendAudioMessage(chunk.pcm.toString("base64"), this.#protocol));
      this.#bufferedDurationMs += chunk.durationMs;
    }
  }

  async #connect(): Promise<void> {
    const socket = new WebSocket(resolveRealtimeTranscriptionEndpoint({
      protocol: this.#protocol,
      endpoint: this.#endpoint,
      model: this.#model
    }), {
      headers: this.#apiKey === undefined ? {} : { authorization: `Bearer ${this.#apiKey}` }
    });
    this.#socket = socket;
    this.#attachSocket(socket);
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (failure?: RealtimeTranscriptionError): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.off("unexpected-response", onUnexpectedResponse);
        socket.off("error", onEarlyError);
        socket.off("close", onEarlyClose);
        if (failure === undefined) resolve();
        else {
          if (this.#socket === socket) this.#socket = undefined;
          this.#intentionalSockets.add(socket);
          if (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN) socket.terminate();
          reject(failure);
        }
      };
      const timer = setTimeout(() => finish(new RealtimeTranscriptionError("timeout")), this.#connectTimeoutMs);
      timer.unref?.();
      const onUnexpectedResponse = (_request: ClientRequest, response: IncomingMessage): void => {
        response.resume();
        finish(new RealtimeTranscriptionError(categoryForStatus(response.statusCode ?? 0)));
      };
      const onEarlyError = (): void => finish(new RealtimeTranscriptionError("network"));
      const onEarlyClose = (): void => finish(new RealtimeTranscriptionError("network"));
      socket.once("unexpected-response", onUnexpectedResponse);
      socket.once("error", onEarlyError);
      socket.once("close", onEarlyClose);
      socket.once("open", () => {
        if (settled || this.#state === "stopped") return;
        this.#send(socket, buildSessionUpdateMessage(
          this.#model,
          this.#locale,
          this.#targetPcmSampleRate,
          this.#protocol
        ));
      });
      const unsubscribe = this.onEvent((event) => {
        if (event.type !== "connected" || this.#socket !== socket) return;
        unsubscribe();
        finish();
      });
      // Connected is emitted by #handleMessage during this private handshake;
      // start() emits the public event after the barrier. Fence that private
      // signal from external listeners by resolving through a dedicated hook.
      this.#handshakeReady.set(socket, () => {
        unsubscribe();
        finish();
      });
    });
    this.#startKeepalive(socket);
  }

  readonly #handshakeReady = new WeakMap<WebSocket, () => void>();

  #attachSocket(socket: WebSocket): void {
    socket.on("message", (data) => {
      if (this.#socket !== socket) return;
      this.#handleMessage(socket, data);
    });
    socket.on("pong", () => {
      if (this.#socket !== socket) return;
      if (this.#pongDeadline !== undefined) clearTimeout(this.#pongDeadline);
      this.#pongDeadline = undefined;
    });
    socket.on("error", () => {
      if (this.#socket !== socket || this.#state !== "started") return;
      this.#emit({ type: "error", category: "transport", recoverable: true });
      socket.terminate();
    });
    socket.on("close", () => {
      if (this.#socket !== socket) return;
      this.#socket = undefined;
      this.#stopKeepalive();
      this.#resolveFlushWaiters();
      if (this.#state === "started" && !this.#intentionalSockets.has(socket)) {
        this.#emit({ type: "disconnected", recoverable: true });
      }
    });
  }

  #handleMessage(socket: WebSocket, raw: RawData): void {
    const bytes = rawDataBytes(raw);
    if (bytes.byteLength > MAXIMUM_MESSAGE_BYTES) {
      this.#emit({ type: "error", category: "protocol", recoverable: false });
      this.#intentionalSockets.add(socket);
      socket.terminate();
      return;
    }
    let event: unknown;
    try { event = JSON.parse(bytes.toString("utf8")); }
    catch { return; }
    if (!isRecord(event) || typeof event["type"] !== "string") return;
    switch (event["type"]) {
      case "session.updated":
        this.#handshakeReady.get(socket)?.();
        this.#handshakeReady.delete(socket);
        return;
      case "input_audio_buffer.committed":
        if (typeof event["item_id"] === "string") this.#registerItem(event["item_id"]);
        if (this.#protocol === "qwenRealtime") this.#bufferedDurationMs = 0;
        return;
      case "conversation.item.input_audio_transcription.delta":
        this.#acceptDelta(event);
        return;
      case "conversation.item.input_audio_transcription.text":
        this.#acceptText(event);
        return;
      case "conversation.item.input_audio_transcription.completed":
        this.#acceptCompleted(event);
        return;
      case "conversation.item.input_audio_transcription.failed":
        this.#emit({ type: "error", category: categoryForEvent(event), recoverable: false });
        this.#resolveFlushWaiters();
        return;
      case "session.finished":
        this.#resolveFlushWaiters();
        return;
      case "error": {
        const category = categoryForEvent(event);
        const ready = this.#handshakeReady.get(socket);
        if (ready !== undefined) {
          this.#handshakeReady.delete(socket);
          this.#intentionalSockets.add(socket);
          socket.terminate();
        } else {
          this.#emit({ type: "error", category, recoverable: category === "transport" });
        }
        this.#resolveFlushWaiters();
      }
    }
  }

  #acceptDelta(event: Readonly<Record<string, unknown>>): void {
    const itemId = event["item_id"];
    const delta = event["delta"];
    if (typeof itemId !== "string" || typeof delta !== "string") return;
    const next = `${this.#partials.get(itemId) ?? ""}${delta}`;
    if (!this.#acceptTranscriptSize(next)) return;
    this.#registerItem(itemId);
    this.#partials.set(itemId, next);
    this.#confirmOldAudio();
    this.#publishPartial();
  }

  #acceptText(event: Readonly<Record<string, unknown>>): void {
    const itemId = event["item_id"];
    const text = event["text"];
    if (typeof itemId !== "string" || typeof text !== "string") return;
    const preview = `${text}${typeof event["stash"] === "string" ? event["stash"] : ""}`;
    if (!this.#acceptTranscriptSize(preview)) return;
    this.#registerItem(itemId);
    this.#partials.set(itemId, preview);
    this.#confirmOldAudio();
    this.#publishPartial();
  }

  #acceptCompleted(event: Readonly<Record<string, unknown>>): void {
    const itemId = event["item_id"];
    const text = typeof event["transcript"] === "string" ? event["transcript"] : event["text"];
    if (typeof itemId !== "string" || typeof text !== "string" || !this.#acceptTranscriptSize(text)) return;
    this.#registerItem(itemId);
    this.#finals.set(itemId, text);
    this.#partials.delete(itemId);
    if (this.#pendingCommits > 0) this.#pendingCommits -= 1;
    this.#confirmOldAudio();
    const aggregate = this.#aggregateTranscript();
    if (aggregate !== "") this.#emit({ type: "stable", text: aggregate });
    if (this.#pendingCommits === 0) this.#resolveFlushWaiters();
  }

  #publishPartial(): void {
    const aggregate = this.#aggregateTranscript();
    if (aggregate !== "") this.#emit({ type: "partial", text: aggregate });
  }

  #aggregateTranscript(): string {
    return this.#itemOrder
      .map((itemId) => this.#finals.get(itemId) ?? this.#partials.get(itemId) ?? "")
      .join("")
      .replace(/\s+/gu, " ")
      .trim()
      .slice(0, MAXIMUM_TRANSCRIPT_CHARACTERS);
  }

  #registerItem(itemId: string): void {
    if (itemId.length === 0 || itemId.length > 512 || this.#itemOrder.includes(itemId)) return;
    this.#itemOrder.push(itemId);
  }

  #acceptTranscriptSize(value: string): boolean {
    if (value.length <= MAXIMUM_TRANSCRIPT_CHARACTERS) return true;
    this.#emit({ type: "error", category: "protocol", recoverable: false });
    return false;
  }

  #bufferReplay(chunk: ReplayChunk): void {
    this.#replay.push(chunk);
    this.#replayDurationMs += chunk.durationMs;
    while (this.#replayDurationMs > MAXIMUM_REPLAY_AUDIO_MS && this.#replay.length > 1) {
      const removed = this.#replay.shift();
      if (removed !== undefined) this.#replayDurationMs -= removed.durationMs;
    }
  }

  #confirmOldAudio(): void {
    const cutoff = this.#now() - PARTIAL_CONFIRMATION_LATENCY_MS;
    while (this.#replay.length > 0 && this.#replay[0]!.addedAt < cutoff) {
      const removed = this.#replay.shift()!;
      this.#replayDurationMs -= removed.durationMs;
    }
  }

  #waitForFlush(): Promise<void> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.#flushWaiters.delete(finish);
        resolve();
      };
      const timer = setTimeout(finish, this.#flushTimeoutMs);
      timer.unref?.();
      this.#flushWaiters.add(finish);
    });
  }

  #resolveFlushWaiters(): void {
    for (const resolve of [...this.#flushWaiters]) resolve();
  }

  #startKeepalive(socket: WebSocket): void {
    this.#stopKeepalive();
    this.#keepalive = setInterval(() => {
      if (this.#socket !== socket || socket.readyState !== WebSocket.OPEN) return;
      if (this.#pongDeadline !== undefined) {
        this.#emit({ type: "error", category: "transport", recoverable: true });
        socket.terminate();
        return;
      }
      socket.ping();
      this.#pongDeadline = setTimeout(() => {
        if (this.#socket !== socket) return;
        this.#emit({ type: "error", category: "transport", recoverable: true });
        socket.terminate();
      }, KEEPALIVE_TIMEOUT_MS);
      this.#pongDeadline.unref?.();
    }, KEEPALIVE_INTERVAL_MS);
    this.#keepalive.unref?.();
  }

  #stopKeepalive(): void {
    if (this.#keepalive !== undefined) clearInterval(this.#keepalive);
    if (this.#pongDeadline !== undefined) clearTimeout(this.#pongDeadline);
    this.#keepalive = undefined;
    this.#pongDeadline = undefined;
  }

  #send(socket: WebSocket, value: Readonly<Record<string, unknown>>): void {
    if (socket.readyState !== WebSocket.OPEN) throw new RealtimeTranscriptionError("network");
    socket.send(JSON.stringify(value));
  }

  #resetTranscript(): void {
    this.#itemOrder = [];
    this.#partials.clear();
    this.#finals.clear();
    this.#replay = [];
    this.#replayDurationMs = 0;
    this.#bufferedDurationMs = 0;
    this.#pendingCommits = 0;
  }

  #emit(event: AsrEvent): void {
    for (const listener of [...this.#listeners]) listener(event);
  }
}

export function validateRealtimeTranscriptionRoute(input: RealtimeTranscriptionRoute): ValidatedRoute {
  if (input.protocol !== "openaiRealtime" && input.protocol !== "qwenRealtime") {
    throw new TypeError("Realtime transcription protocol is invalid.");
  }
  let endpoint: URL;
  try { endpoint = new URL(input.endpoint); }
  catch { throw new TypeError("Realtime transcription endpoint is invalid."); }
  const loopback = endpoint.hostname === "localhost" || endpoint.hostname === "::1"
    || endpoint.hostname === "[::1]" || isLoopbackIpv4(endpoint.hostname);
  if (
    endpoint.toString().length > 2_048
    || (endpoint.protocol !== "wss:" && !(endpoint.protocol === "ws:" && loopback))
    || endpoint.username !== ""
    || endpoint.password !== ""
    || endpoint.hash !== ""
    || [...endpoint.searchParams.keys()].some((key) => !ALLOWED_QUERY_KEYS.has(key.toLocaleLowerCase("en-US")))
  ) throw new TypeError("Realtime transcription endpoint is unsafe.");
  const model = input.model.trim();
  if (model === "" || model.length > 200 || /[\u0000-\u001f\u007f]/u.test(model)) {
    throw new TypeError("Realtime transcription model is invalid.");
  }
  if (
    input.apiKey !== undefined
    && (input.apiKey.length === 0 || input.apiKey.length > 8_192 || /[\u0000\r\n]/u.test(input.apiKey))
  ) throw new TypeError("Realtime transcription credential is invalid.");
  const inputPcmSampleRate = input.inputPcmSampleRate ?? DEFAULT_INPUT_PCM_SAMPLE_RATE;
  if (!Number.isSafeInteger(inputPcmSampleRate) || inputPcmSampleRate < 8_000 || inputPcmSampleRate > 96_000) {
    throw new TypeError("Realtime transcription sample rate is invalid.");
  }
  const connectTimeoutMs = validateTimeout(input.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS);
  const flushTimeoutMs = validateTimeout(input.flushTimeoutMs ?? DEFAULT_FLUSH_TIMEOUT_MS);
  return {
    protocol: input.protocol,
    endpoint: endpoint.toString(),
    model,
    inputPcmSampleRate,
    targetPcmSampleRate: input.protocol === "qwenRealtime" ? QWEN_PCM_SAMPLE_RATE : OPENAI_PCM_SAMPLE_RATE,
    connectTimeoutMs,
    flushTimeoutMs,
    ...(input.apiKey === undefined ? {} : { apiKey: input.apiKey })
  };
}

export function resolveRealtimeTranscriptionEndpoint(input: Pick<RealtimeTranscriptionRoute, "protocol" | "endpoint" | "model">): string {
  const endpoint = new URL(input.endpoint);
  if (input.protocol === "qwenRealtime") endpoint.searchParams.set("model", input.model);
  return endpoint.toString();
}

export function buildSessionUpdateMessage(
  model: string,
  locale: string | undefined,
  sampleRate: number,
  protocol: RealtimeTranscriptionProtocol
): Readonly<Record<string, unknown>> {
  const language = normalizeLanguage(locale);
  if (protocol === "qwenRealtime") {
    return {
      event_id: realtimeEventId("session_update"),
      type: "session.update",
      session: {
        modalities: ["text"],
        input_audio_format: "pcm",
        sample_rate: sampleRate,
        input_audio_transcription: { ...(language === undefined ? {} : { language }) },
        turn_detection: { type: "server_vad", threshold: 0, silence_duration_ms: 400 }
      }
    };
  }
  return {
    type: "session.update",
    session: {
      type: "transcription",
      audio: {
        input: {
          format: { type: "audio/pcm", rate: sampleRate },
          transcription: { model, ...(language === undefined ? {} : { language }) },
          turn_detection: null
        }
      }
    }
  };
}

export function resamplePcm16(input: Buffer, fromRate: number, toRate: number): Buffer {
  if (input.byteLength === 0 || input.byteLength % 2 !== 0) return Buffer.alloc(0);
  if (fromRate === toRate) return Buffer.from(input);
  const samples = new Int16Array(input.buffer, input.byteOffset, input.byteLength / 2);
  const outputLength = Math.max(1, Math.round(samples.length * toRate / fromRate));
  const output = Buffer.allocUnsafe(outputLength * 2);
  const ratio = fromRate / toRate;
  for (let index = 0; index < outputLength; index += 1) {
    const source = index * ratio;
    const left = Math.min(samples.length - 1, Math.floor(source));
    const right = Math.min(samples.length - 1, left + 1);
    const fraction = source - left;
    const value = Math.round(samples[left]! * (1 - fraction) + samples[right]! * fraction);
    output.writeInt16LE(Math.max(-32_768, Math.min(32_767, value)), index * 2);
  }
  return output;
}

export async function probeRealtimeTranscriptionRoute(
  input: RealtimeTranscriptionRoute
): Promise<RealtimeTranscriptionProbeResult> {
  let provider: RealtimeTranscriptionProvider | undefined;
  try {
    provider = new RealtimeTranscriptionProvider(input);
    await provider.start({ runId: `probe-${randomUUID()}`, mimeType: "audio/pcm" });
    return { ok: true };
  } catch (error) {
    const code = error instanceof RealtimeTranscriptionError ? error.code : "protocol";
    return {
      ok: false,
      reason: code === "authentication" ? "authenticationFailed"
        : code === "timeout" ? "timeout"
          : code === "network" ? "network"
            : code === "route" ? "routeUnavailable"
              : "serviceError"
    };
  } finally {
    await provider?.stop().catch(() => undefined);
  }
}

function buildAppendAudioMessage(audio: string, protocol: RealtimeTranscriptionProtocol): Readonly<Record<string, unknown>> {
  return {
    ...(protocol === "qwenRealtime" ? { event_id: realtimeEventId("append") } : {}),
    type: "input_audio_buffer.append",
    audio
  };
}

function buildFinishSessionMessage(protocol: RealtimeTranscriptionProtocol): Readonly<Record<string, unknown>> {
  return {
    ...(protocol === "qwenRealtime" ? { event_id: realtimeEventId("finish") } : {}),
    type: "session.finish"
  };
}

function realtimeEventId(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}

function normalizeLanguage(locale: string | undefined): string | undefined {
  if (locale === undefined) return undefined;
  const normalized = locale.trim().toLocaleLowerCase("en-US");
  if (normalized === "" || normalized === "auto") return undefined;
  const primary = normalized.split(/[-_]/u, 1)[0];
  return primary !== undefined && /^[a-z]{2,3}$/u.test(primary) ? primary : undefined;
}

function validateTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value < MINIMUM_TIMEOUT_MS || value > MAXIMUM_TIMEOUT_MS) {
    throw new TypeError("Realtime transcription timeout is invalid.");
  }
  return value;
}

function categoryForStatus(status: number): RealtimeTranscriptionErrorCode {
  if (status === 401 || status === 403) return "authentication";
  if (status === 408 || status === 504) return "timeout";
  if (status === 429) return "quota";
  if (status === 404 || status >= 500) return "route";
  return status >= 400 ? "protocol" : "network";
}

function categoryForEvent(event: Readonly<Record<string, unknown>>): AsrErrorCategory {
  const error = isRecord(event["error"]) ? event["error"] : event;
  const code = `${typeof error["code"] === "string" ? error["code"] : ""} ${typeof error["type"] === "string" ? error["type"] : ""}`.toLocaleLowerCase("en-US");
  if (/auth|credential|permission|token|unauthor/u.test(code)) return "authentication";
  if (/quota|rate_limit|billing/u.test(code)) return "quota";
  if (/timeout|connect|network|unavailable/u.test(code)) return "transport";
  return "protocol";
}

function rawDataBytes(value: RawData): Buffer {
  if (Array.isArray(value)) return Buffer.concat(value);
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
}

function isLoopbackIpv4(hostname: string): boolean {
  const octets = hostname.split(".");
  return octets.length === 4 && octets[0] === "127"
    && octets.every((octet) => /^\d{1,3}$/u.test(octet) && Number(octet) <= 255);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
