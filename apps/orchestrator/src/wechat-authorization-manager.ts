import { randomUUID } from "node:crypto";

import {
  MessagingTransportError,
  WeChatAuthorization,
  type WeChatAuthorizationEvent
} from "@joko/messaging";
import type { MessagingConnectionRecord } from "@joko/store";

import type { CredentialManager } from "./credential-manager.js";
import { MessagingManagerError, type MessagingManager } from "./messaging-manager.js";

const VERIFICATION_PROMPT_ID = "wechat-verification";
const MAXIMUM_ATTEMPTS = 64;

export interface WeChatAuthorizationPort {
  begin(signal?: AbortSignal): Promise<WeChatAuthorizationEvent>;
  poll(input: {
    readonly attemptId: string;
    readonly verificationCode?: string;
    readonly signal?: AbortSignal;
  }): Promise<WeChatAuthorizationEvent>;
  cancel(attemptId: string): void;
  close(): void;
}

export interface WeChatAuthorizationManagerOptions {
  readonly messaging: MessagingManager;
  readonly credentials: CredentialManager;
  readonly createAuthorization?: () => WeChatAuthorizationPort;
  readonly onClientRevoked?: (connectionId: string, listener: () => void) => () => void;
  readonly now?: () => number;
}

export type WeChatAuthorizationStatus =
  | "waiting" | "scanned" | "verification_required" | "qr_refreshed"
  | "succeeded" | "failed" | "cancelled" | "expired";

/** The only public projection. Provider QR identity, poll token and bot token never enter it. */
export interface WeChatAuthorizationSnapshot {
  readonly attemptId: string;
  readonly connectionId: string;
  readonly generation: number;
  readonly revision: number;
  readonly status: WeChatAuthorizationStatus;
  readonly qrCodeUrl?: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly verificationRetry: boolean;
  readonly errorCode?: string;
  readonly errorSummary?: string;
  readonly connection?: MessagingConnectionRecord;
}

interface Attempt {
  readonly id: string;
  readonly connectionId: string;
  readonly clientConnectionId: string;
  readonly generation: number;
  readonly credentialReferenceId: string | null;
  readonly credentialGeneration: string | null;
  readonly enabled: boolean;
  readonly createdAt: number;
  readonly authorization: WeChatAuthorizationPort;
  readonly abort: AbortController;
  stopRevocation?: () => void;
  protocolAttemptId?: string;
  expiresAt: number;
  revision: number;
  status: WeChatAuthorizationStatus;
  qrCodeUrl?: string;
  verificationRetry: boolean;
  errorCode?: string;
  errorSummary?: string;
  connection?: MessagingConnectionRecord;
  verificationTicket?: {
    readonly credentialUploadTicketId: string;
    readonly expiresAt: number;
    readonly maximumBytes: number;
  };
  operation: Promise<void>;
}

/** Owns only process-local third-party authorization; durable connection/Vault stay in MessagingManager. */
export class WeChatAuthorizationManager {
  readonly #messaging: MessagingManager;
  readonly #credentials: CredentialManager;
  readonly #createAuthorization: () => WeChatAuthorizationPort;
  readonly #onClientRevoked: WeChatAuthorizationManagerOptions["onClientRevoked"];
  readonly #now: () => number;
  readonly #attempts = new Map<string, Attempt>();
  readonly #beginTails = new Map<string, Promise<void>>();
  #closed = false;

  constructor(options: WeChatAuthorizationManagerOptions) {
    this.#messaging = options.messaging;
    this.#credentials = options.credentials;
    this.#createAuthorization = options.createAuthorization ?? (() => new WeChatAuthorization());
    this.#onClientRevoked = options.onClientRevoked;
    this.#now = options.now ?? Date.now;
  }

  async begin(input: {
    readonly clientConnectionId: string;
    readonly connectionId: string;
    readonly expectedRevision: bigint;
    readonly expectedGeneration: number;
  }): Promise<WeChatAuthorizationSnapshot> {
    const previousBegin = this.#beginTails.get(input.connectionId) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const tail = new Promise<void>((resolve) => { release = resolve; });
    this.#beginTails.set(input.connectionId, tail);
    await previousBegin;
    try {
      return await this.#begin(input);
    } finally {
      release();
      if (this.#beginTails.get(input.connectionId) === tail) this.#beginTails.delete(input.connectionId);
    }
  }

  async #begin(input: {
    readonly clientConnectionId: string;
    readonly connectionId: string;
    readonly expectedRevision: bigint;
    readonly expectedGeneration: number;
  }): Promise<WeChatAuthorizationSnapshot> {
    this.#assertOpen();
    const connection = this.#requireConnection(input.connectionId);
    if (connection.revision !== input.expectedRevision || connection.generation !== input.expectedGeneration) {
      throw conflict("WeChat connection changed before authorization began.");
    }
    const previous = this.#attempts.get(connection.id);
    if (previous !== undefined) {
      this.#retire(previous);
      await previous.operation;
    }
    // A previous confirmed attempt may have committed while its replacement was being prepared.
    const latest = this.#requireConnection(connection.id);
    if (latest.revision !== input.expectedRevision || latest.generation !== input.expectedGeneration) {
      throw conflict("WeChat connection changed before authorization began.");
    }
    if (this.#attempts.size >= MAXIMUM_ATTEMPTS) this.#evictTerminal();
    if (this.#attempts.size >= MAXIMUM_ATTEMPTS) {
      throw new MessagingManagerError("conflict", "Too many WeChat authorizations are active.");
    }
    const now = this.#now();
    const attempt: Attempt = {
      id: randomUUID(),
      connectionId: latest.id,
      clientConnectionId: requiredClient(input.clientConnectionId),
      generation: latest.generation,
      credentialReferenceId: latest.credentialReferenceId ?? null,
      credentialGeneration: latest.credentialGeneration ?? null,
      enabled: latest.enabled,
      createdAt: now,
      authorization: this.#createAuthorization(),
      abort: new AbortController(),
      expiresAt: now + 5 * 60_000,
      revision: 1,
      status: "waiting",
      verificationRetry: false,
      operation: Promise.resolve()
    };
    this.#attempts.set(latest.id, attempt);
    attempt.stopRevocation = this.#onClientRevoked?.(attempt.clientConnectionId, () => {
      if (this.#attempts.get(attempt.connectionId) === attempt) this.#attempts.delete(attempt.connectionId);
      this.#retire(attempt);
    });
    try {
      const event = await attempt.authorization.begin(attempt.abort.signal);
      this.#assertCurrent(attempt);
      this.#applyEvent(attempt, event);
    } catch (error) {
      if (this.#attempts.get(attempt.connectionId) !== attempt || attempt.abort.signal.aborted) {
        throw conflict("WeChat authorization was replaced or cancelled.");
      }
      this.#applyFailure(attempt, error);
    }
    return this.#snapshot(attempt);
  }

  async get(input: {
    readonly clientConnectionId: string;
    readonly connectionId: string;
    readonly attemptId: string;
    readonly expectedGeneration: number;
  }): Promise<WeChatAuthorizationSnapshot> {
    const attempt = this.#requireAttempt(input);
    if (this.#expire(attempt) || terminal(attempt.status)) return this.#snapshot(attempt);
    return this.#run(attempt, () => this.#poll(attempt));
  }

  beginVerificationInput(input: {
    readonly clientConnectionId: string;
    readonly connectionId: string;
    readonly attemptId: string;
    readonly expectedGeneration: number;
  }): { readonly credentialUploadTicketId: string; readonly expiresAt: number; readonly maximumBytes: number } {
    const attempt = this.#requireAttempt(input);
    if (this.#expire(attempt) || attempt.status !== "verification_required") {
      throw new MessagingManagerError("invalid", "WeChat verification is not requested by the current authorization.");
    }
    if (attempt.verificationTicket !== undefined && attempt.verificationTicket.expiresAt > this.#now()) {
      return attempt.verificationTicket;
    }
    const ticket = this.#credentials.createProviderLoginInputTicket({
      flowId: attempt.id,
      promptId: VERIFICATION_PROMPT_ID,
      connectionId: attempt.clientConnectionId,
      maximumBytes: 64
    });
    attempt.verificationTicket = ticket;
    return ticket;
  }

  async submitVerificationCode(input: {
    readonly clientConnectionId: string;
    readonly connectionId: string;
    readonly attemptId: string;
    readonly expectedGeneration: number;
    readonly credentialInputTicketId: string;
  }): Promise<WeChatAuthorizationSnapshot> {
    const attempt = this.#requireAttempt(input);
    if (this.#expire(attempt) || attempt.status !== "verification_required") {
      throw new MessagingManagerError("invalid", "WeChat verification is not requested by the current authorization.");
    }
    if (input.credentialInputTicketId !== attempt.verificationTicket?.credentialUploadTicketId) {
      throw new MessagingManagerError("invalid", "WeChat verification input is not current.");
    }
    // The one-shot upload is sealed and bound to this exact client/attempt/prompt.
    let code: string;
    try {
      code = this.#credentials.consumeProviderLoginInput({
        credentialUploadTicketId: input.credentialInputTicketId,
        flowId: attempt.id,
        promptId: VERIFICATION_PROMPT_ID,
        connectionId: attempt.clientConnectionId
      });
      attempt.verificationTicket = undefined;
    } catch {
      throw new MessagingManagerError("invalid", "WeChat verification input is missing or no longer valid.");
    }
    if (!/^\d{1,12}$/u.test(code)) {
      throw new MessagingManagerError("invalid", "WeChat verification code is invalid.");
    }
    return this.#run(attempt, () => this.#poll(attempt, code));
  }

  async cancel(input: {
    readonly clientConnectionId: string;
    readonly connectionId: string;
    readonly attemptId: string;
    readonly expectedGeneration: number;
  }): Promise<WeChatAuthorizationSnapshot> {
    const attempt = this.#requireAttempt(input);
    if (terminal(attempt.status)) return this.#snapshot(attempt);
    attempt.abort.abort();
    await attempt.operation;
    if (terminal(attempt.status)) return this.#snapshot(attempt);
    attempt.status = "cancelled";
    attempt.revision += 1;
    this.#stopProtocol(attempt);
    return this.#snapshot(attempt);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const attempt of this.#attempts.values()) this.#retire(attempt);
    this.#attempts.clear();
  }

  #requireConnection(connectionId: string): MessagingConnectionRecord {
    const connection = this.#messaging.getConnection(connectionId);
    if (connection.channel !== "wechat") throw new MessagingManagerError("invalid", "This is not a WeChat connection.");
    return connection;
  }

  #requireAttempt(input: {
    readonly clientConnectionId: string;
    readonly connectionId: string;
    readonly attemptId: string;
    readonly expectedGeneration: number;
  }): Attempt {
    this.#assertOpen();
    const attempt = this.#attempts.get(input.connectionId);
    if (attempt === undefined || attempt.id !== input.attemptId
      || attempt.clientConnectionId !== requiredClient(input.clientConnectionId)) {
      throw conflict("WeChat authorization attempt is not current for this client.");
    }
    if (attempt.generation !== input.expectedGeneration) {
      throw conflict("WeChat authorization generation changed.");
    }
    if (attempt.status !== "succeeded") this.#assertMaterial(attempt);
    return attempt;
  }

  #assertMaterial(attempt: Attempt): MessagingConnectionRecord {
    const connection = this.#requireConnection(attempt.connectionId);
    if (connection.generation !== attempt.generation
      || (connection.credentialReferenceId ?? null) !== attempt.credentialReferenceId
      || (connection.credentialGeneration ?? null) !== attempt.credentialGeneration
      || connection.enabled !== attempt.enabled) {
      this.#retire(attempt);
      throw conflict("WeChat connection material changed during authorization.");
    }
    return connection;
  }

  #assertCurrent(attempt: Attempt): void {
    this.#assertOpen();
    if (this.#attempts.get(attempt.connectionId) !== attempt || attempt.abort.signal.aborted) {
      throw conflict("WeChat authorization was replaced or cancelled.");
    }
    this.#assertMaterial(attempt);
  }

  #expire(attempt: Attempt): boolean {
    if (this.#now() < attempt.expiresAt) return false;
    if (!terminal(attempt.status)) {
      attempt.status = "expired";
      attempt.revision += 1;
      this.#stopProtocol(attempt);
    }
    return true;
  }

  async #run(attempt: Attempt, action: () => Promise<WeChatAuthorizationSnapshot>): Promise<WeChatAuthorizationSnapshot> {
    const previous = attempt.operation;
    let release: () => void = () => undefined;
    attempt.operation = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      if (this.#attempts.get(attempt.connectionId) !== attempt) {
        throw conflict("WeChat authorization was replaced or cancelled.");
      }
      if (terminal(attempt.status)) return this.#snapshot(attempt);
      this.#assertCurrent(attempt);
      if (this.#expire(attempt)) return this.#snapshot(attempt);
      return await action();
    } finally {
      release();
    }
  }

  async #poll(attempt: Attempt, verificationCode?: string): Promise<WeChatAuthorizationSnapshot> {
    if (attempt.protocolAttemptId === undefined) throw conflict("WeChat authorization has not started.");
    try {
      const event = await attempt.authorization.poll({
        attemptId: attempt.protocolAttemptId,
        ...(verificationCode === undefined ? {} : { verificationCode }),
        signal: attempt.abort.signal
      });
      this.#assertCurrent(attempt);
      if (event.status === "confirmed") {
        const current = this.#assertMaterial(attempt);
        const connection = await this.#messaging.commitWeChatAuthorization({
          clientConnectionId: attempt.clientConnectionId,
          connectionId: attempt.connectionId,
          expectedRevision: current.revision,
          expectedGeneration: attempt.generation,
          expectedCredentialReferenceId: attempt.credentialReferenceId,
          expectedCredentialGeneration: attempt.credentialGeneration,
          expectedEnabled: attempt.enabled,
          credentials: event.credentials,
          enable: true
        });
        // Cancellation/replacement can race only with the awaited commit. A completed
        // CAS is authoritative, so do not project a false cancelled outcome.
        attempt.connection = connection;
        attempt.status = "succeeded";
        attempt.revision += 1;
        this.#stopProtocol(attempt);
      } else {
        this.#applyEvent(attempt, event);
      }
    } catch (error) {
      if (attempt.status === "succeeded") return this.#snapshot(attempt);
      if (this.#attempts.get(attempt.connectionId) !== attempt || attempt.abort.signal.aborted) {
        throw conflict("WeChat authorization was replaced or cancelled.");
      }
      if (error instanceof MessagingManagerError) throw error;
      this.#applyFailure(attempt, error);
    }
    return this.#snapshot(attempt);
  }

  #applyEvent(attempt: Attempt, event: WeChatAuthorizationEvent): void {
    if (event.status === "confirmed") throw new Error("Confirmed WeChat credentials require a commit.");
    attempt.protocolAttemptId = event.attemptId;
    attempt.errorCode = undefined;
    attempt.errorSummary = undefined;
    attempt.verificationRetry = event.status === "verification_required" ? event.retry : false;
    if (event.status === "waiting" || event.status === "scanned" || event.status === "qr_refreshed") {
      attempt.qrCodeUrl = event.qrCodeUrl;
      attempt.expiresAt = Math.min(event.expiresAt, attempt.createdAt + 5 * 60_000);
    }
    attempt.status = event.status;
    attempt.revision += 1;
    if (event.status === "expired" || event.status === "cancelled") this.#stopProtocol(attempt);
  }

  #applyFailure(attempt: Attempt, error: unknown): void {
    const code = error instanceof MessagingTransportError ? error.code : "connection_failed";
    attempt.errorCode = code;
    attempt.errorSummary = summaryFor(code);
    attempt.revision += 1;
    if (error instanceof MessagingTransportError && error.options.retryable && attempt.protocolAttemptId !== undefined) {
      // Network/5xx during a QR poll does not discard an otherwise valid attempt.
      return;
    }
    attempt.status = "failed";
    this.#stopProtocol(attempt);
  }

  #snapshot(attempt: Attempt): WeChatAuthorizationSnapshot {
    return {
      attemptId: attempt.id,
      connectionId: attempt.connectionId,
      generation: attempt.generation,
      revision: attempt.revision,
      status: attempt.status,
      createdAt: attempt.createdAt,
      expiresAt: attempt.expiresAt,
      verificationRetry: attempt.verificationRetry,
      ...(terminal(attempt.status) ? {} : attempt.qrCodeUrl === undefined ? {} : { qrCodeUrl: attempt.qrCodeUrl }),
      ...(attempt.errorCode === undefined ? {} : { errorCode: attempt.errorCode }),
      ...(attempt.errorSummary === undefined ? {} : { errorSummary: attempt.errorSummary }),
      ...(attempt.connection === undefined ? {} : { connection: attempt.connection })
    };
  }

  #stopProtocol(attempt: Attempt): void {
    attempt.abort.abort();
    attempt.authorization.close();
    attempt.verificationTicket = undefined;
    attempt.stopRevocation?.();
    attempt.stopRevocation = undefined;
  }

  #retire(attempt: Attempt): void {
    this.#stopProtocol(attempt);
    if (!terminal(attempt.status)) {
      attempt.status = "cancelled";
      attempt.revision += 1;
    }
  }

  #evictTerminal(): void {
    for (const [key, attempt] of this.#attempts) {
      if (terminal(attempt.status) || this.#now() >= attempt.expiresAt) {
        this.#retire(attempt);
        this.#attempts.delete(key);
        return;
      }
    }
  }

  #assertOpen(): void {
    if (this.#closed) throw new MessagingManagerError("channel_unavailable", "WeChat authorization is closed.");
  }
}

function terminal(status: WeChatAuthorizationStatus): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled" || status === "expired";
}

function requiredClient(value: string): string {
  if (!value || value.length > 512) throw new MessagingManagerError("invalid", "Authenticated client is required.");
  return value;
}

function conflict(message: string): MessagingManagerError {
  return new MessagingManagerError("conflict", message);
}

function summaryFor(code: string): string {
  if (code === "network" || code === "provider_unavailable" || code === "rate_limited") {
    return "WeChat authorization is temporarily unavailable. Try again.";
  }
  if (code === "conflict") return "This WeChat account or authorization is already bound.";
  if (code === "invalid_credential") return "WeChat authorization was rejected. Start a new authorization.";
  return "WeChat authorization could not continue. Start a new authorization.";
}
