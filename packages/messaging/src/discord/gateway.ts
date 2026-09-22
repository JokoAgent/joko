import WebSocket, { type RawData } from "ws";

import { MessagingTransportError } from "../types.js";
import type { DiscordApi } from "./api.js";
import type {
  DiscordGatewayPacket,
  DiscordInteraction,
  DiscordMessage,
  DiscordReadyEvent
} from "./model.js";

const GATEWAY_VERSION = 10;
const MAXIMUM_GATEWAY_MESSAGE_BYTES = 1024 * 1024;
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 15_000;
const DEFAULT_INVALID_SESSION_DELAY_MS = 1_000;
const DISCORD_GATEWAY_INTENTS = (1 << 0) | (1 << 9) | (1 << 12) | (1 << 15);

export interface DiscordGatewayCursor {
  readonly format: 1;
  readonly sequence: number;
  readonly sessionId: string;
  readonly resumeGatewayUrl: string;
}

export interface DiscordGatewayDispatch {
  readonly sequence: number;
  readonly eventType: "MESSAGE_CREATE" | "INTERACTION_CREATE";
  readonly message?: DiscordMessage;
  readonly interaction?: Omit<DiscordInteraction, "token">;
}

export interface DiscordGatewayPollResult {
  readonly dispatches: readonly DiscordGatewayDispatch[];
  readonly nextCursor: string;
}

export interface DiscordGatewayClientOptions {
  readonly api: Pick<DiscordApi, "acknowledgeInteraction">;
  readonly gatewayUrl: string;
  readonly token: string;
  readonly botUserId: string;
  readonly initialCursor?: string | null;
  readonly allowLoopback?: boolean;
  readonly random?: () => number;
  readonly handshakeTimeoutMs?: number;
  readonly invalidSessionDelayMs?: number;
  readonly createSocket?: (url: string) => WebSocket;
}

export class DiscordGatewayClient {
  readonly #api: DiscordGatewayClientOptions["api"];
  readonly #gatewayUrl: string;
  readonly #token: string;
  readonly #botUserId: string;
  readonly #allowLoopback: boolean;
  readonly #random: () => number;
  readonly #handshakeTimeoutMs: number;
  readonly #invalidSessionDelayMs: number;
  readonly #createSocket: (url: string) => WebSocket;
  readonly #dispatches: DiscordGatewayDispatch[] = [];
  readonly #interactionAcks = new Map<string, Promise<void>>();
  readonly #interactionAckFailures = new Map<string, MessagingTransportError>();
  readonly #waiters = new Set<() => void>();
  #cursor: DiscordGatewayCursor | null;
  #socket: WebSocket | null = null;
  #connectPromise: Promise<void> | null = null;
  #heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  #awaitingHeartbeatAck = false;
  #ready = false;
  #stopped = false;
  #terminalError: MessagingTransportError | null = null;

  constructor(options: DiscordGatewayClientOptions) {
    this.#api = options.api;
    this.#allowLoopback = options.allowLoopback === true;
    this.#gatewayUrl = normalizeGatewayUrl(options.gatewayUrl, this.#allowLoopback);
    this.#token = requiredToken(options.token);
    this.#botUserId = requiredSnowflake(options.botUserId, "bot user");
    this.#cursor = decodeDiscordGatewayCursor(options.initialCursor ?? null, this.#allowLoopback);
    this.#random = options.random ?? Math.random;
    this.#handshakeTimeoutMs = boundedInteger(
      options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS,
      100,
      60_000,
      "Gateway handshake timeout"
    );
    this.#invalidSessionDelayMs = boundedInteger(
      options.invalidSessionDelayMs ?? DEFAULT_INVALID_SESSION_DELAY_MS,
      0,
      5_000,
      "Gateway invalid-session delay"
    );
    this.#createSocket = options.createSocket ?? ((url) => new WebSocket(url));
  }

  async connect(signal?: AbortSignal): Promise<void> {
    if (this.#stopped) throw cancelled();
    if (this.#terminalError !== null) throw this.#terminalError;
    if (this.#ready && this.#socket?.readyState === WebSocket.OPEN) return;
    if (this.#connectPromise === null) {
      const promise = this.#openSocket();
      this.#connectPromise = promise;
      void promise.finally(() => {
        if (this.#connectPromise === promise) this.#connectPromise = null;
      }).catch(() => undefined);
    }
    await withAbort(this.#connectPromise, signal);
  }

  async poll(input: {
    readonly timeoutSeconds?: number;
    readonly signal?: AbortSignal;
  }): Promise<DiscordGatewayPollResult> {
    const timeoutSeconds = input.timeoutSeconds ?? 50;
    if (!Number.isSafeInteger(timeoutSeconds) || timeoutSeconds < 0 || timeoutSeconds > 50) {
      throw invalidInput("Discord poll timeout must be between 0 and 50 seconds.");
    }
    await this.connect(input.signal);
    const deadline = Date.now() + timeoutSeconds * 1_000;
    while (this.#dispatches.length === 0 && timeoutSeconds > 0) {
      if (this.#terminalError !== null) throw this.#terminalError;
      if (!this.#ready || this.#socket?.readyState !== WebSocket.OPEN) await this.connect(input.signal);
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await this.#waitForChange(remaining, input.signal);
    }
    if (this.#terminalError !== null) throw this.#terminalError;
    const cursor = this.#cursor;
    if (cursor === null) throw malformed("Discord Gateway did not establish a resumable session.");
    const sequence = cursor.sequence;
    const dispatches = this.#dispatches.filter((entry) => entry.sequence <= sequence);
    this.#dispatches.splice(0, dispatches.length);
    await Promise.all(dispatches.flatMap((dispatch) => {
      const interactionId = dispatch.interaction?.id;
      if (interactionId === undefined) return [];
      const ack = this.#interactionAcks.get(interactionId);
      return ack === undefined ? [] : [ack.catch(() => undefined)];
    }));
    return {
      dispatches,
      nextCursor: encodeDiscordGatewayCursor(cursor, this.#allowLoopback)
    };
  }

  interactionAckFailure(interactionId: string): MessagingTransportError | undefined {
    const failure = this.#interactionAckFailures.get(interactionId);
    this.#interactionAckFailures.delete(interactionId);
    this.#interactionAcks.delete(interactionId);
    return failure;
  }

  consumeInteractionAck(interactionId: string): void {
    this.#interactionAckFailures.delete(interactionId);
    this.#interactionAcks.delete(interactionId);
  }

  async close(): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#ready = false;
    this.#clearHeartbeat();
    const socket = this.#socket;
    this.#socket = null;
    if (socket !== null && socket.readyState !== WebSocket.CLOSED) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 250);
        timer.unref?.();
        socket.once("close", () => {
          clearTimeout(timer);
          resolve();
        });
        socket.close(1000, "Joko transport closed");
      });
      if (Number(socket.readyState) !== WebSocket.CLOSED) socket.terminate();
    }
    this.#notify();
  }

  async #openSocket(): Promise<void> {
    if (this.#stopped) throw cancelled();
    const resumeUrl = this.#cursor?.resumeGatewayUrl ?? this.#gatewayUrl;
    const socketUrl = withGatewayQuery(normalizeGatewayUrl(resumeUrl, this.#allowLoopback));
    const socket = this.#createSocket(socketUrl);
    this.#socket = socket;
    this.#ready = false;
    this.#terminalError = null;

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        socket.terminate();
        reject(network("Discord Gateway handshake timed out."));
      }, this.#handshakeTimeoutMs);
      timer.unref?.();
      const finish = (error?: MessagingTransportError) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error === undefined) resolve();
        else reject(error);
      };

      socket.on("message", (data) => {
        try {
          const packet = decodeGatewayPacket(data);
          this.#handlePacket(socket, packet, () => finish());
        } catch (error) {
          const failure = error instanceof MessagingTransportError ? error : malformed("Discord Gateway packet was invalid.");
          this.#terminalError = failure;
          socket.close(1002, "Invalid Gateway packet");
          finish(failure);
        }
      });
      socket.once("error", () => {
        if (this.#socket === socket) {
          this.#ready = false;
          this.#notify();
        }
        finish(network("Discord Gateway connection failed."));
      });
      socket.once("close", (code) => {
        if (this.#socket === socket) {
          this.#socket = null;
          this.#ready = false;
          this.#clearHeartbeat();
          const failure = gatewayCloseFailure(code);
          if (!failure.options.retryable) this.#terminalError = failure;
          if (code === 4007 || code === 4009) this.#cursor = null;
          this.#notify();
          finish(failure);
        }
      });
    });
  }

  #handlePacket(socket: WebSocket, packet: DiscordGatewayPacket, ready: () => void): void {
    if (this.#socket !== socket || this.#stopped) return;
    if (packet.op === 10) {
      const interval = heartbeatInterval(packet.d);
      this.#startHeartbeat(socket, interval);
      if (this.#cursor === null) {
        this.#send(socket, {
          op: 2,
          d: {
            token: this.#token,
            intents: DISCORD_GATEWAY_INTENTS,
            properties: { os: process.platform, browser: "joko", device: "joko" }
          }
        });
      } else {
        this.#sendResume(socket);
      }
      return;
    }
    if (packet.op === 11) {
      this.#awaitingHeartbeatAck = false;
      return;
    }
    if (packet.op === 1) {
      this.#sendHeartbeat(socket);
      return;
    }
    if (packet.op === 7) {
      socket.close(4000, "Gateway requested reconnect");
      return;
    }
    if (packet.op === 9) {
      const resumable = packet.d === true && this.#cursor !== null;
      if (!resumable) this.#cursor = null;
      const timer = setTimeout(() => {
        if (this.#socket !== socket || socket.readyState !== WebSocket.OPEN) return;
        if (this.#cursor === null) {
          this.#send(socket, {
            op: 2,
            d: {
              token: this.#token,
              intents: DISCORD_GATEWAY_INTENTS,
              properties: { os: process.platform, browser: "joko", device: "joko" }
            }
          });
        } else this.#sendResume(socket);
      }, this.#invalidSessionDelayMs);
      timer.unref?.();
      return;
    }
    if (packet.op !== 0) return;
    const sequence = packet.s;
    if (!Number.isSafeInteger(sequence) || Number(sequence) < 0 || typeof packet.t !== "string") {
      throw malformed("Discord Gateway dispatch sequence was invalid.");
    }
    const numericSequence = Number(sequence);
    if (packet.t === "READY") {
      const event = readyEvent(packet.d);
      if (event.user.id !== this.#botUserId || event.user.bot !== true) {
        throw malformed("Discord Gateway identity did not match the probed bot.");
      }
      this.#cursor = {
        format: 1,
        sequence: numericSequence,
        sessionId: requiredSessionId(event.session_id),
        resumeGatewayUrl: normalizeGatewayUrl(event.resume_gateway_url, this.#allowLoopback)
      };
      this.#ready = true;
      this.#notify();
      ready();
      return;
    }
    if (this.#cursor === null) throw malformed("Discord Gateway dispatched before READY.");
    this.#cursor = { ...this.#cursor, sequence: numericSequence };
    if (packet.t === "RESUMED") {
      this.#ready = true;
      this.#notify();
      ready();
      return;
    }
    if (packet.t === "MESSAGE_CREATE") {
      const message = discordMessage(packet.d);
      this.#dispatches.push({ sequence: numericSequence, eventType: "MESSAGE_CREATE", message });
      this.#notify();
      return;
    }
    if (packet.t === "INTERACTION_CREATE") {
      const interaction = discordInteraction(packet.d);
      const { token: _token, ...durableInteraction } = interaction;
      this.#dispatches.push({
        sequence: numericSequence,
        eventType: "INTERACTION_CREATE",
        interaction: durableInteraction
      });
      const ack = this.#api.acknowledgeInteraction(interaction).catch((error: unknown) => {
        const failure = error instanceof MessagingTransportError
          ? error
          : network("Discord interaction acknowledgement failed.", "unknown");
        this.#interactionAckFailures.set(interaction.id, failure);
        throw failure;
      });
      this.#interactionAcks.set(interaction.id, ack);
      this.#notify();
    }
  }

  #startHeartbeat(socket: WebSocket, interval: number): void {
    this.#clearHeartbeat();
    const random = this.#random();
    const fraction = Number.isFinite(random) ? Math.max(0, Math.min(random, 0.999_999)) : 0.5;
    const initialDelay = Math.floor(interval * fraction);
    this.#heartbeatTimer = setTimeout(() => this.#heartbeatTick(socket, interval), initialDelay);
    this.#heartbeatTimer.unref?.();
  }

  #heartbeatTick(socket: WebSocket, interval: number): void {
    if (this.#socket !== socket || socket.readyState !== WebSocket.OPEN || this.#stopped) return;
    if (this.#awaitingHeartbeatAck) {
      socket.terminate();
      return;
    }
    this.#sendHeartbeat(socket);
    this.#heartbeatTimer = setTimeout(() => this.#heartbeatTick(socket, interval), interval);
    this.#heartbeatTimer.unref?.();
  }

  #sendHeartbeat(socket: WebSocket): void {
    this.#send(socket, { op: 1, d: this.#cursor?.sequence ?? null });
    this.#awaitingHeartbeatAck = true;
  }

  #sendResume(socket: WebSocket): void {
    const cursor = this.#cursor;
    if (cursor === null) throw invalidInput("Discord resume cursor is unavailable.");
    this.#send(socket, {
      op: 6,
      d: { token: this.#token, session_id: cursor.sessionId, seq: cursor.sequence }
    });
  }

  #send(socket: WebSocket, value: unknown): void {
    if (socket.readyState !== WebSocket.OPEN) throw network("Discord Gateway socket is not open.");
    socket.send(JSON.stringify(value));
  }

  #clearHeartbeat(): void {
    if (this.#heartbeatTimer !== null) clearTimeout(this.#heartbeatTimer);
    this.#heartbeatTimer = null;
    this.#awaitingHeartbeatAck = false;
  }

  #notify(): void {
    for (const waiter of [...this.#waiters]) waiter();
  }

  #waitForChange(timeoutMs: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error?: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.#waiters.delete(onChange);
        signal?.removeEventListener("abort", onAbort);
        if (error === undefined) resolve();
        else reject(error);
      };
      const onChange = () => finish();
      const onAbort = () => finish(cancelled());
      const timer = setTimeout(() => finish(), timeoutMs);
      timer.unref?.();
      this.#waiters.add(onChange);
      if (signal?.aborted) finish(cancelled());
      else signal?.addEventListener("abort", onAbort, { once: true });
    });
  }
}

export function encodeDiscordGatewayCursor(cursor: DiscordGatewayCursor, allowLoopback = false): string {
  const normalized: DiscordGatewayCursor = {
    format: 1,
    sequence: requiredSequence(cursor.sequence),
    sessionId: requiredSessionId(cursor.sessionId),
    resumeGatewayUrl: normalizeGatewayUrl(cursor.resumeGatewayUrl, allowLoopback)
  };
  return JSON.stringify(normalized);
}

export function decodeDiscordGatewayCursor(value: string | null, allowLoopback = false): DiscordGatewayCursor | null {
  if (value === null) return null;
  if (value.length < 2 || value.length > 2_048) throw invalidInput("Invalid Discord Gateway cursor.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw invalidInput("Invalid Discord Gateway cursor.");
  }
  if (!isRecord(parsed) || Object.keys(parsed).sort().join(",") !== "format,resumeGatewayUrl,sequence,sessionId"
    || parsed["format"] !== 1 || typeof parsed["sequence"] !== "number"
    || typeof parsed["sessionId"] !== "string" || typeof parsed["resumeGatewayUrl"] !== "string") {
    throw invalidInput("Invalid Discord Gateway cursor.");
  }
  return {
    format: 1,
    sequence: requiredSequence(parsed["sequence"]),
    sessionId: requiredSessionId(parsed["sessionId"]),
    resumeGatewayUrl: normalizeGatewayUrl(parsed["resumeGatewayUrl"], allowLoopback)
  };
}

function withGatewayQuery(source: string): string {
  const url = new URL(source);
  url.searchParams.set("v", String(GATEWAY_VERSION));
  url.searchParams.set("encoding", "json");
  return url.toString();
}

function normalizeGatewayUrl(source: string, allowLoopback: boolean): string {
  let url: URL;
  try {
    url = new URL(source);
  } catch {
    throw invalidInput("Invalid Discord Gateway URL.");
  }
  const official = url.protocol === "wss:" && url.hostname === "gateway.discord.gg";
  const loopback = allowLoopback && url.protocol === "ws:" && isLoopback(url);
  if (!official && !loopback) throw invalidInput("Discord Gateway URL is not an approved origin.");
  if (url.username !== "" || url.password !== "" || url.hash !== "") {
    throw invalidInput("Invalid Discord Gateway URL.");
  }
  url.search = "";
  return url.toString();
}

function decodeGatewayPacket(data: RawData): DiscordGatewayPacket {
  const bytes = rawBytes(data);
  if (bytes.byteLength > MAXIMUM_GATEWAY_MESSAGE_BYTES) throw malformed("Discord Gateway packet was too large.");
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw malformed("Discord Gateway packet was malformed JSON.");
  }
  if (!isRecord(value) || !Number.isSafeInteger(value["op"])) {
    throw malformed("Discord Gateway packet was invalid.");
  }
  return {
    op: Number(value["op"]),
    ...(value["d"] === undefined ? {} : { d: value["d"] }),
    ...(value["s"] === undefined ? {} : { s: value["s"] as number | null }),
    ...(value["t"] === undefined ? {} : { t: value["t"] as string | null })
  };
}

function rawBytes(data: RawData): Uint8Array {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (Array.isArray(data)) {
    const size = data.reduce((total, entry) => total + entry.byteLength, 0);
    const output = new Uint8Array(size);
    let offset = 0;
    for (const entry of data) {
      output.set(entry, offset);
      offset += entry.byteLength;
    }
    return output;
  }
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

function heartbeatInterval(value: unknown): number {
  if (!isRecord(value) || !Number.isSafeInteger(value["heartbeat_interval"])) {
    throw malformed("Discord Gateway heartbeat interval was invalid.");
  }
  return boundedInteger(Number(value["heartbeat_interval"]), 10, 5 * 60_000, "Gateway heartbeat interval");
}

function readyEvent(value: unknown): DiscordReadyEvent {
  if (!isRecord(value) || typeof value["session_id"] !== "string"
    || typeof value["resume_gateway_url"] !== "string" || !isRecord(value["user"])) {
    throw malformed("Discord READY payload was invalid.");
  }
  const user = value["user"];
  if (typeof user["id"] !== "string" || typeof user["username"] !== "string") {
    throw malformed("Discord READY identity was invalid.");
  }
  return {
    session_id: value["session_id"],
    resume_gateway_url: value["resume_gateway_url"],
    user: {
      id: user["id"],
      username: user["username"],
      ...(typeof user["discriminator"] === "string" ? { discriminator: user["discriminator"] } : {}),
      ...(typeof user["global_name"] === "string" || user["global_name"] === null
        ? { global_name: user["global_name"] }
        : {}),
      ...(typeof user["bot"] === "boolean" ? { bot: user["bot"] } : {})
    }
  };
}

function discordMessage(value: unknown): DiscordMessage {
  if (!isRecord(value) || typeof value["id"] !== "string" || typeof value["channel_id"] !== "string"
    || typeof value["content"] !== "string" || typeof value["timestamp"] !== "string" || !isRecord(value["author"])) {
    throw malformed("Discord MESSAGE_CREATE payload was invalid.");
  }
  return value as unknown as DiscordMessage;
}

function discordInteraction(value: unknown): DiscordInteraction {
  if (!isRecord(value) || typeof value["id"] !== "string" || typeof value["application_id"] !== "string"
    || typeof value["type"] !== "number" || typeof value["token"] !== "string") {
    throw malformed("Discord INTERACTION_CREATE payload was invalid.");
  }
  return value as unknown as DiscordInteraction;
}

function gatewayCloseFailure(code: number): MessagingTransportError {
  if (code === 4004) {
    return new MessagingTransportError("invalid_credential", "Discord Gateway rejected the bot credential.", {
      retryable: false,
      effect: "none",
      providerStatus: code
    });
  }
  if (code === 4013 || code === 4014) {
    return new MessagingTransportError("provider_rejected", "Discord Gateway rejected the configured intents.", {
      retryable: false,
      effect: "none",
      providerStatus: code
    });
  }
  return network("Discord Gateway disconnected.");
}

function requiredToken(value: string): string {
  const token = value.trim();
  if (!/^[A-Za-z0-9._-]{24,256}$/u.test(token)) throw invalidInput("Invalid Discord bot token shape.");
  return token;
}

function requiredSnowflake(value: string, label: string): string {
  if (!/^[1-9][0-9]{16,19}$/u.test(value)) throw invalidInput(`Invalid Discord ${label} identifier.`);
  return value;
}

function requiredSessionId(value: string): string {
  if (!/^[A-Za-z0-9._-]{1,256}$/u.test(value)) throw invalidInput("Invalid Discord Gateway session identifier.");
  return value;
}

function requiredSequence(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw invalidInput("Invalid Discord Gateway sequence.");
  return value;
}

function boundedInteger(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw invalidInput(`${label} is invalid.`);
  return value;
}

function isLoopback(url: URL): boolean {
  return url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]" || url.hostname === "::1";
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidInput(message: string): MessagingTransportError {
  return new MessagingTransportError("invalid_input", message, { retryable: false, effect: "none" });
}

function malformed(message: string): MessagingTransportError {
  return new MessagingTransportError("malformed_response", message, { retryable: false, effect: "none" });
}

function network(message: string, effect: "none" | "unknown" = "none"): MessagingTransportError {
  return new MessagingTransportError("network", message, { retryable: true, effect });
}

function cancelled(): MessagingTransportError {
  return new MessagingTransportError("cancelled", "Discord Gateway operation was cancelled.", {
    retryable: false,
    effect: "none"
  });
}

async function withAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) return promise;
  if (signal.aborted) throw cancelled();
  return await new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(cancelled());
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}
