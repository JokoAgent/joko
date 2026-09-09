import { randomUUID } from "node:crypto";
import { WebSocket, type RawData } from "ws";
import {
  validateAudioChunk,
  type AsrErrorCategory,
  type AsrEvent,
  type AsrProvider,
  type AsrStartRequest,
  type AudioChunk
} from "@joko/voice-input";

const PCM_BYTES_PER_MS = 32;
const REPLAY_BYTES = 60_000 * PCM_BYTES_PER_MS;
const MESSAGE_BYTES = 256 * 1024;
const TRANSCRIPT_CHARACTERS = 200_000;
const SOCKET_BUFFER_BYTES = 4 * 1024 * 1024;
const MINIMUM_SEGMENT_BYTES = 2_100 * PCM_BYTES_PER_MS;
const MAXIMUM_SEGMENT_BYTES = 20_000 * PCM_BYTES_PER_MS;
const SILENCE_BYTES = 1_500 * PCM_BYTES_PER_MS;
const MAXIMUM_PENDING_CHUNKS = 4_096;

export interface ScribeTranscriptionRoute {
  readonly endpoint: string;
  readonly model: string;
  readonly apiKey?: string;
  readonly connectTimeoutMs?: number;
  readonly flushTimeoutMs?: number;
}

type FailureCode = "authentication" | "quota" | "network" | "timeout" | "route" | "protocol" | "stopped";
export class ScribeTranscriptionError extends Error {
  constructor(readonly code: FailureCode) {
    super(`Realtime transcription failed (${code}).`);
    this.name = "ScribeTranscriptionError";
  }
}

export type ScribeTranscriptionProbeResult = { readonly ok: true } | {
  readonly ok: false;
  readonly reason: "authenticationFailed" | "timeout" | "network" | "routeUnavailable" | "serviceError";
};

type Waiter = { check: () => boolean; resolve: () => void; reject: (error: ScribeTranscriptionError) => void };
type PendingAudio = { audio: Buffer; offset: number; voiced: boolean; commitAfter?: boolean; paddingBytes?: number };
type CommitBoundary = { captureEnd: number; voiced: boolean; paddingBytes: number };
type PendingCommit = CommitBoundary & { timer: ReturnType<typeof setTimeout> };

/** Owns the Scribe wire protocol. Audio and credentials live only for this instance. */
export class ScribeTranscriptionProvider implements AsrProvider {
  readonly #route: Omit<ReturnType<typeof validateScribeTranscriptionRoute>, "apiKey">;
  readonly #listeners = new Set<(event: AsrEvent) => void>();
  readonly #waiters = new Set<Waiter>();
  #apiKey: string | undefined;
  #state: "idle" | "starting" | "ready" | "disconnected" | "stopped" = "idle";
  #socket: WebSocket | undefined;
  #generation = 0;
  #connectReject: ((error: ScribeTranscriptionError) => void) | undefined;
  #heartbeat: ReturnType<typeof setInterval> | undefined;
  #pongTimer: ReturnType<typeof setTimeout> | undefined;
  #locale: string | undefined;
  #totals = { bytes: 0, durationMs: 0 };
  #replay: Buffer | undefined = Buffer.alloc(REPLAY_BYTES);
  #replayLength = 0;
  #connectionText = "";
  #stable = "";
  #recoveryPrefix = "";
  readonly #pending: PendingAudio[] = [];
  readonly #boundaries: CommitBoundary[] = [];
  #pendingBytes = 0;
  #sentCaptureBytes = 0;
  #ackedCaptureBytes = 0;
  #segmentBytes = 0;
  #segmentVoiced = false;
  #silenceBytes = 0;
  #commit: PendingCommit | undefined;
  #pumping = false;
  #recoveryTargetBytes = 0;
  #flushing = false;
  #flushTask: Promise<void> | undefined;
  #recoveryTask: Promise<void> | undefined;
  #recoveries = 0;

  constructor(route: ScribeTranscriptionRoute) {
    const { apiKey, ...configuration } = validateScribeTranscriptionRoute(route);
    this.#apiKey = apiKey;
    this.#route = configuration;
  }

  start(request: AsrStartRequest): Promise<void> {
    if (this.#state !== "idle" || request.mimeType !== "audio/pcm") {
      return Promise.reject(new ScribeTranscriptionError("protocol"));
    }
    if (request.locale !== undefined) {
      const language = request.locale.toLowerCase().split(/[-_]/u)[0];
      if (language === undefined || !/^[a-z]{2,3}$/u.test(language)) {
        return Promise.reject(new ScribeTranscriptionError("protocol"));
      }
      this.#locale = language;
    }
    return this.#connect(false);
  }

  appendAudio(chunk: AudioChunk): void {
    if (this.#flushing || this.#state === "idle" || this.#state === "stopped") return;
    try {
      this.#totals = validateAudioChunk(chunk, this.#totals);
      // Duration is not trusted as a substitute for the PCM byte count.
      if (chunk.data.byteLength % 2 !== 0 || Math.abs(chunk.data.byteLength / PCM_BYTES_PER_MS - chunk.durationMs) > 1) {
        throw new ScribeTranscriptionError("protocol");
      }
      const audio = Buffer.from(new Uint8Array(chunk.data));
      this.#remember(audio);
      this.#enqueue({ audio, offset: 0, voiced: chunk.voiced });
      this.#pump();
    } catch {
      this.#fail("protocol");
    }
  }

  flushAudio(): Promise<void> {
    if (this.#flushTask !== undefined) return this.#flushTask;
    this.#flushing = true;
    this.#flushTask = this.#flush();
    return this.#flushTask;
  }

  async #flush(): Promise<void> {
    await this.#recoveryTask;
    if (this.#state !== "ready") throw new ScribeTranscriptionError("network");
    if (this.#totals.bytes === 0) return;
    const completion = this.#wait(() => this.#pending.length === 0 && this.#commit === undefined
      && this.#segmentBytes === 0 && this.#recoveryPrefix === "", this.#route.flushTimeoutMs);
    this.#pump();
    try { await completion; }
    catch (error) {
      if (this.#state === "ready") this.#fail(error instanceof ScribeTranscriptionError ? error.code : "protocol");
      throw error;
    }
  }

  recover(): Promise<void> {
    if (this.#recoveryTask !== undefined) return this.#recoveryTask;
    if (this.#state === "stopped" || this.#state === "idle" || this.#replay === undefined || this.#recoveries >= 3) {
      return Promise.reject(new ScribeTranscriptionError("network"));
    }
    this.#recoveries += 1;
    const task = this.#recover();
    this.#recoveryTask = task;
    const clear = (): void => { if (this.#recoveryTask === task) this.#recoveryTask = undefined; };
    void task.then(clear, clear);
    return task;
  }

  async #recover(): Promise<void> {
    this.#retire(new ScribeTranscriptionError("network"));
    this.#recoveryPrefix = this.#stable;
    this.#connectionText = "";
    this.#sentCaptureBytes = 0;
    this.#ackedCaptureBytes = 0;
    try {
      await this.#connect(true);
      await this.#wait(() => this.#ackedCaptureBytes >= this.#recoveryTargetBytes && this.#recoveryPrefix === "", this.#route.connectTimeoutMs);
    } catch (error) {
      if (this.#state === "ready") this.#fail(error instanceof ScribeTranscriptionError ? error.code : "protocol");
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (this.#state === "stopped") return;
    this.#state = "stopped";
    this.#retire(new ScribeTranscriptionError("stopped"));
    this.#apiKey = undefined;
    this.#replay?.fill(0);
    this.#replay = undefined;
    this.#replayLength = 0;
    this.#stable = "";
    this.#connectionText = "";
    this.#recoveryPrefix = "";
    this.#boundaries.length = 0;
    this.#listeners.clear();
  }

  onEvent(listener: (event: AsrEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #connect(replay: boolean): Promise<void> {
    this.#state = "starting";
    const generation = ++this.#generation;
    const url = new URL(this.#route.endpoint);
    url.searchParams.set("model_id", this.#route.model);
    url.searchParams.set("audio_format", "pcm_16000");
    url.searchParams.set("commit_strategy", "manual");
    url.searchParams.set("include_timestamps", "false");
    url.searchParams.set("include_language_detection", "false");
    if (this.#locale !== undefined) url.searchParams.set("language_code", this.#locale);
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: ScribeTranscriptionError): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.#connectReject = undefined;
        if (error === undefined) resolve();
        else reject(error);
      };
      const timer = setTimeout(() => this.#fail("timeout"), this.#route.connectTimeoutMs);
      this.#connectReject = (error) => finish(error);
      let socket: WebSocket;
      try {
        socket = new WebSocket(url, {
          headers: this.#apiKey === undefined ? {} : { "xi-api-key": this.#apiKey },
          followRedirects: false,
          maxPayload: MESSAGE_BYTES,
          perMessageDeflate: false,
          handshakeTimeout: this.#route.connectTimeoutMs
        });
      } catch { this.#fail("protocol"); return; }
      this.#socket = socket;
      const current = (): boolean => this.#generation === generation && this.#socket === socket && this.#state !== "stopped";
      socket.on("error", () => { if (current()) this.#fail("network"); });
      socket.on("unexpected-response", (_request, response) => {
        response.destroy();
        if (current()) this.#fail(statusCode(response.statusCode ?? 500));
      });
      socket.on("close", () => {
        if (!current()) return;
        const wasReady = this.#state === "ready";
        this.#state = "disconnected";
        this.#retire(new ScribeTranscriptionError("network"));
        if (wasReady) this.#emit({ type: "disconnected", recoverable: this.#replay !== undefined });
      });
      socket.on("pong", () => {
        if (!current()) return;
        clearTimeout(this.#pongTimer);
        this.#pongTimer = undefined;
      });
      socket.on("message", (raw, binary) => {
        if (!current()) return;
        try {
          if (binary) throw new ScribeTranscriptionError("protocol");
          const event: unknown = JSON.parse(bytes(raw).toString("utf8"));
          if (!isRecord(event) || typeof event["message_type"] !== "string") throw new ScribeTranscriptionError("protocol");
          if (event["message_type"] === "session_started") {
            if (this.#state !== "starting") throw new ScribeTranscriptionError("protocol");
            const config = event["config"];
            if (!isRecord(config) || config["model_id"] !== this.#route.model
              || config["audio_format"] !== "pcm_16000" || config["sample_rate"] !== 16_000) {
              throw new ScribeTranscriptionError("protocol");
            }
            this.#state = "ready";
            if (replay) {
              if (this.#replay === undefined) throw new ScribeTranscriptionError("protocol");
              this.#queueReplay();
            }
            this.#pump();
            if (!current()) return;
            this.#heartbeat = setInterval(() => {
              if (!current() || this.#pongTimer !== undefined) return;
              this.#pongTimer = setTimeout(() => { if (current()) this.#fail("network"); }, 8_000);
              socket.ping(undefined, undefined, (error) => { if (error && current()) this.#fail("network"); });
            }, 25_000);
            finish();
            this.#emit({ type: "connected" });
          } else this.#message(event);
        } catch { if (current()) this.#fail("protocol"); }
      });
    });
  }

  #message(event: Readonly<Record<string, unknown>>): void {
    const type = event["message_type"];
    if (type === "warning" || type === "committed_transcript_with_timestamps" || type === "committed_transcript_entities") return;
    if (type !== "partial_transcript" && type !== "committed_transcript") {
      this.#fail(eventCode(type));
      return;
    }
    if (this.#state !== "ready" || typeof event["text"] !== "string" || event["text"].length > TRANSCRIPT_CHARACTERS) {
      this.#fail("protocol"); return;
    }
    const segment = event["text"].trim();
    const text = [this.#connectionText, segment].filter(Boolean).join(" ");
    if (text.length > TRANSCRIPT_CHARACTERS) { this.#fail("protocol"); return; }
    const committed = type === "committed_transcript";
    const commit = this.#commit;
    if (committed && commit === undefined) { this.#fail("protocol"); return; }
    let publish = this.#recoveryPrefix === "";
    if (!publish) {
      if (text.startsWith(this.#recoveryPrefix)) {
        if (committed) { this.#recoveryPrefix = ""; publish = true; }
      } else if (committed && !this.#recoveryPrefix.startsWith(text)) {
        this.#fail("protocol"); return;
      }
    }
    if (committed) {
      this.#connectionText = text;
      clearTimeout(commit!.timer);
      this.#ackedCaptureBytes = commit!.captureEnd;
      this.#commit = undefined;
      this.#segmentBytes = 0;
      this.#segmentVoiced = false;
      this.#silenceBytes = 0;
      if (publish) this.#stable = text;
    }
    if (publish) this.#emit({ type: committed ? "stable" : "partial", text });
    this.#pump();
    this.#settleWaiters();
  }

  #enqueue(chunk: PendingAudio): boolean {
    if (this.#pendingBytes + chunk.audio.byteLength > REPLAY_BYTES || this.#pending.length >= MAXIMUM_PENDING_CHUNKS) {
      chunk.audio.fill(0);
      this.#fail("network");
      return false;
    }
    this.#pending.push(chunk);
    this.#pendingBytes += chunk.audio.byteLength;
    return true;
  }

  #queueReplay(): void {
    const replay = this.#replay!;
    this.#clearPending();
    this.#recoveryTargetBytes = this.#replayLength;
    let offset = 0;
    // Retain explicit boundaries, including a commit whose receipt was lost.
    // No later segment was sent before that receipt, so replay is serial too.
    for (const boundary of [...this.#boundaries]) {
      if (boundary.captureEnd <= offset || boundary.captureEnd > this.#recoveryTargetBytes) continue;
      if (!this.#enqueue({ audio: Buffer.from(replay.subarray(offset, boundary.captureEnd)), offset: 0,
        voiced: boundary.voiced, commitAfter: true, paddingBytes: boundary.paddingBytes })) return;
      offset = boundary.captureEnd;
    }
    if (offset < this.#recoveryTargetBytes) {
      this.#enqueue({ audio: Buffer.from(replay.subarray(offset, this.#recoveryTargetBytes)), offset: 0, voiced: true, commitAfter: true });
    }
  }

  #pump(): void {
    if (this.#pumping || this.#state !== "ready" || this.#commit !== undefined) return;
    this.#pumping = true;
    try {
      while (this.#state === "ready" && this.#commit === undefined) {
        if (this.#segmentBytes >= MAXIMUM_SEGMENT_BYTES
          || (this.#segmentVoiced && this.#segmentBytes >= MINIMUM_SEGMENT_BYTES && this.#silenceBytes >= SILENCE_BYTES)) {
          this.#commitSegment(); break;
        }
        const next = this.#pending[0];
        if (next === undefined) {
          if (this.#flushing && this.#segmentBytes > 0) this.#commitSegment();
          break;
        }
        let length = Math.min(next.audio.byteLength - next.offset, MAXIMUM_SEGMENT_BYTES - this.#segmentBytes);
        if (!next.voiced && this.#segmentVoiced && next.commitAfter !== true) {
          length = Math.min(length, Math.max(SILENCE_BYTES - this.#silenceBytes, MINIMUM_SEGMENT_BYTES - this.#segmentBytes));
        }
        if (length <= 0) { this.#fail("protocol"); break; }
        if (!this.#sendAudio(next.audio.subarray(next.offset, next.offset + length), false)) break;
        next.offset += length;
        this.#pendingBytes -= length;
        this.#sentCaptureBytes += length;
        this.#segmentBytes += length;
        this.#segmentVoiced ||= next.voiced;
        this.#silenceBytes = next.voiced ? 0 : this.#silenceBytes + length;
        if (next.offset === next.audio.byteLength) {
          this.#pending.shift();
          next.audio.fill(0);
          if (next.commitAfter) { this.#commitSegment(next.paddingBytes); break; }
        }
      }
    } finally { this.#pumping = false; }
  }

  #commitSegment(replayPaddingBytes?: number): void {
    if (this.#commit !== undefined || this.#segmentBytes === 0 || this.#state !== "ready") return;
    const paddingBytes = replayPaddingBytes ?? Math.max(0, MINIMUM_SEGMENT_BYTES - this.#segmentBytes);
    if (this.#segmentBytes + paddingBytes > MAXIMUM_SEGMENT_BYTES) { this.#fail("protocol"); return; }
    const boundary: CommitBoundary = { captureEnd: this.#sentCaptureBytes, voiced: this.#segmentVoiced, paddingBytes };
    if (this.#replay !== undefined && !this.#boundaries.some((item) => item.captureEnd === boundary.captureEnd)) this.#boundaries.push(boundary);
    const generation = this.#generation;
    const commit: PendingCommit = { ...boundary, timer: setTimeout(() => {
      if (this.#generation === generation && this.#commit === commit) this.#fail("timeout");
    }, this.#route.flushTimeoutMs) };
    this.#commit = commit;
    // Public manual commit accepts an empty audio chunk. Padding is only for
    // sub-two-second tails; each segment stays below the server auto-commit window.
    const padding = Buffer.alloc(paddingBytes);
    this.#sendAudio(padding, true);
    padding.fill(0);
  }

  #remember(audio: Buffer): void {
    if (this.#replay === undefined) return;
    if (this.#replayLength + audio.byteLength > REPLAY_BYTES) {
      this.#replay.fill(0);
      this.#replay = undefined;
      this.#replayLength = 0;
      this.#boundaries.length = 0;
      return;
    }
    audio.copy(this.#replay, this.#replayLength);
    this.#replayLength += audio.byteLength;
  }

  #sendAudio(audio: Buffer, commit: boolean): boolean {
    const socket = this.#socket;
    const generation = this.#generation;
    if (socket?.readyState !== WebSocket.OPEN || this.#state !== "ready") {
      this.#fail("network"); return false;
    }
    for (let offset = 0; offset < Math.max(1, audio.byteLength); offset += 32_000) {
      if (socket.bufferedAmount > SOCKET_BUFFER_BYTES) { this.#fail("network"); return false; }
      const chunk = audio.subarray(offset, offset + 32_000);
      try {
        socket.send(JSON.stringify({
          message_type: "input_audio_chunk", audio_base_64: chunk.toString("base64"), sample_rate: 16_000,
          commit: commit && offset + chunk.byteLength === audio.byteLength
        }), (error) => {
          if (error && this.#socket === socket && this.#generation === generation) this.#fail("network");
        });
      } catch { this.#fail("network"); return false; }
    }
    return this.#state === "ready" && this.#socket === socket && this.#generation === generation;
  }

  #wait(check: () => boolean, timeoutMs: number): Promise<void> {
    if (this.#state !== "ready") return Promise.reject(new ScribeTranscriptionError("network"));
    if (check()) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        check,
        resolve: () => { clearTimeout(timer); this.#waiters.delete(waiter); resolve(); },
        reject: (error) => { clearTimeout(timer); this.#waiters.delete(waiter); reject(error); }
      };
      const timer = setTimeout(() => waiter.reject(new ScribeTranscriptionError("timeout")), timeoutMs);
      this.#waiters.add(waiter);
    });
  }

  #settleWaiters(): void {
    for (const waiter of [...this.#waiters]) if (waiter.check()) waiter.resolve();
  }

  #fail(code: FailureCode): void {
    if (this.#state === "stopped") return;
    const active = this.#state === "ready";
    this.#state = "disconnected";
    this.#retire(new ScribeTranscriptionError(code));
    if (active) {
      const category: AsrErrorCategory = code === "authentication" ? "authentication" : code === "quota" ? "quota"
        : code === "network" || code === "timeout" || code === "route" ? "transport" : "protocol";
      this.#emit({ type: "error", category, recoverable: category === "transport" && this.#replay !== undefined });
    }
  }

  #retire(error: ScribeTranscriptionError): void {
    this.#generation += 1;
    this.#connectReject?.(error);
    for (const waiter of [...this.#waiters]) waiter.reject(error);
    clearInterval(this.#heartbeat);
    clearTimeout(this.#pongTimer);
    this.#heartbeat = undefined;
    this.#pongTimer = undefined;
    if (this.#commit !== undefined) clearTimeout(this.#commit.timer);
    this.#commit = undefined;
    this.#segmentBytes = 0;
    this.#segmentVoiced = false;
    this.#silenceBytes = 0;
    this.#clearPending();
    const socket = this.#socket;
    this.#socket = undefined;
    // Leave a non-reporting error listener during asynchronous ws retirement.
    socket?.terminate();
  }

  #clearPending(): void {
    for (const item of this.#pending) item.audio.fill(0);
    this.#pending.length = 0;
    this.#pendingBytes = 0;
  }

  #emit(event: AsrEvent): void {
    if (this.#state === "stopped") return;
    for (const listener of [...this.#listeners]) listener(event);
  }
}

export function validateScribeTranscriptionRoute(input: ScribeTranscriptionRoute): {
  endpoint: string; model: string; apiKey?: string; connectTimeoutMs: number; flushTimeoutMs: number;
} {
  let endpoint: URL;
  try { endpoint = new URL(input.endpoint); }
  catch { throw new ScribeTranscriptionError("protocol"); }
  const loopback = endpoint.hostname === "localhost" || endpoint.hostname === "[::1]"
    || /^127(?:\.\d{1,3}){3}$/u.test(endpoint.hostname);
  if (endpoint.href.length > 2_048 || (endpoint.protocol !== "wss:" && !(endpoint.protocol === "ws:" && loopback))
    || endpoint.username !== "" || endpoint.password !== "" || endpoint.hash !== "" || endpoint.search !== "") {
    throw new ScribeTranscriptionError("protocol");
  }
  const model = input.model.trim();
  if (model === "" || model.length > 200 || /[\u0000-\u001f\u007f]/u.test(model)
    || (input.apiKey !== undefined && (input.apiKey.length === 0 || input.apiKey.length > 8_192 || /[\u0000\r\n]/u.test(input.apiKey)))) {
    throw new ScribeTranscriptionError("protocol");
  }
  return {
    endpoint: endpoint.href, model,
    ...(input.apiKey === undefined ? {} : { apiKey: input.apiKey }),
    connectTimeoutMs: timeout(input.connectTimeoutMs ?? 8_000), flushTimeoutMs: timeout(input.flushTimeoutMs ?? 4_000)
  };
}

export async function probeScribeTranscriptionRoute(route: ScribeTranscriptionRoute): Promise<ScribeTranscriptionProbeResult> {
  let provider: ScribeTranscriptionProvider | undefined;
  try {
    provider = new ScribeTranscriptionProvider(route);
    await provider.start({ runId: `probe-${randomUUID()}`, mimeType: "audio/pcm" });
    return { ok: true };
  } catch (error) {
    const code = error instanceof ScribeTranscriptionError ? error.code : "protocol";
    return { ok: false, reason: code === "authentication" ? "authenticationFailed" : code === "timeout" ? "timeout"
      : code === "network" ? "network" : code === "route" ? "routeUnavailable" : "serviceError" };
  } finally { await provider?.stop(); }
}

function timeout(value: number): number {
  if (!Number.isSafeInteger(value) || value < 250 || value > 120_000) throw new ScribeTranscriptionError("protocol");
  return value;
}
function statusCode(status: number): FailureCode {
  return status === 401 || status === 403 ? "authentication" : status === 429 ? "quota"
    : status === 408 || status === 504 ? "timeout" : status === 404 || status >= 500 ? "route" : "protocol";
}
function eventCode(type: unknown): FailureCode {
  switch (type) {
    case "auth_error": case "unaccepted_terms": return "authentication";
    case "quota_exceeded": case "rate_limited": return "quota";
    case "transcriber_error": case "resource_exhausted": case "session_time_limit_exceeded": return "network";
    default: return "protocol";
  }
}
function bytes(value: RawData): Buffer {
  return Array.isArray(value) ? Buffer.concat(value) : value instanceof ArrayBuffer ? Buffer.from(value)
    : Buffer.from(value.buffer, value.byteOffset, value.byteLength);
}
function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
