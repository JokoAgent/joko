import { createHash } from "node:crypto";

import type {
  MobilePushEnvironment,
  MobilePushLocale,
  MobilePushRegistrationRecord,
  OperationalStore
} from "@joko/store";

import type { CredentialVault } from "./credential-vault.js";

const MOBILE_PUSH_REGISTRATION_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const MOBILE_PUSH_RETRY_LIMIT = 5;
const MOBILE_PUSH_RETRY_BASE_MS = 1_000;
const MOBILE_PUSH_TIMER_MAXIMUM_MS = 2_147_483_647;
const MOBILE_PUSH_TOKEN_MAXIMUM_CHARACTERS = 512;

export interface MobilePushDeliveryInput {
  readonly environment: MobilePushEnvironment;
  readonly token: string;
  readonly locale: MobilePushLocale;
  readonly kind: "done" | "awaiting" | "error";
  readonly intent: string;
}

export type MobilePushDeliveryResult =
  | { readonly outcome: "delivered"; readonly code: string }
  | { readonly outcome: "retry"; readonly code: string; readonly retryAfterMs?: number }
  | { readonly outcome: "failed" | "unknown" | "invalid_registration"; readonly code: string };

/** Provider credentials stay inside this node-owned port. Neither callers nor
 * durable product data can inspect or select them. */
export interface MobilePushProviderPort {
  send(input: MobilePushDeliveryInput, signal: AbortSignal): Promise<MobilePushDeliveryResult>;
}

export interface MobilePushCoordinatorOptions {
  readonly store: OperationalStore;
  readonly vault: CredentialVault;
  readonly serverId: string;
  readonly provider?: MobilePushProviderPort;
  readonly now?: () => number;
}

export interface RegisterMobilePushInput {
  readonly connectionId: string;
  readonly deviceId: string;
  readonly expectedDeviceRevision: bigint;
  readonly environment: MobilePushEnvironment;
  readonly locale: MobilePushLocale;
  readonly deviceToken: string;
  readonly registrationId: string;
  readonly revocationSecret: string;
}

export interface RegisteredMobilePush {
  readonly registration: MobilePushRegistrationRecord;
  readonly revocationSecret: string;
}

export class MobilePushCoordinator {
  readonly #now: () => number;
  readonly #provider: MobilePushProviderPort | undefined;
  readonly #serverId: string;
  readonly #store: OperationalStore;
  readonly #vault: CredentialVault;
  #abort: AbortController | undefined;
  #closed = false;
  #drain: Promise<void> | undefined;
  #running = false;
  #started = false;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #unsubscribe: (() => void) | undefined;

  constructor(options: MobilePushCoordinatorOptions) {
    this.#store = options.store;
    this.#vault = options.vault;
    this.#serverId = boundedIdentity(options.serverId, "Mobile push Server ID");
    this.#provider = options.provider;
    this.#now = options.now ?? Date.now;
  }

  get serverId(): string { return this.#serverId; }

  capability(): { readonly supported: boolean; readonly unavailableReasonCode?: string } {
    return this.#provider === undefined
      ? { supported: false, unavailableReasonCode: "APNS_NOT_CONFIGURED" }
      : { supported: true };
  }

  register(input: RegisterMobilePushInput): RegisteredMobilePush {
    if (this.#provider === undefined) throw new MobilePushUnavailableError("APNS_NOT_CONFIGURED");
    const token = normalizedDeviceToken(input.deviceToken);
    const existing = this.#store.findMobilePushRegistrationForConnection(input.connectionId);
    const registrationId = boundedIdentity(input.registrationId, "Mobile push registration ID");
    const revocationSecret = normalizedRevocationSecret(input.revocationSecret);
    if (existing !== undefined && existing.id !== registrationId) {
      throw new MobilePushInputError();
    }
    const now = this.#now();
    const registration = this.#store.putMobilePushRegistration({
      id: registrationId,
      connectionId: input.connectionId,
      deviceId: input.deviceId,
      expectedDeviceRevision: input.expectedDeviceRevision,
      environment: input.environment,
      locale: input.locale,
      tokenDigest: privateDigest(token),
      sealedToken: this.#vault.seal(
        token,
        mobilePushCredentialReference(this.#serverId, registrationId, "token")
      ),
      revocationSecretDigest: privateDigest(revocationSecret),
      sealedRevocationSecret: this.#vault.seal(
        revocationSecret,
        mobilePushCredentialReference(this.#serverId, registrationId, "revocation")
      ),
      expiresAt: now + MOBILE_PUSH_REGISTRATION_TTL_MS,
      now
    });
    this.wake();
    return { registration, revocationSecret };
  }

  unregisterAuthenticated(registrationId: string, connectionId: string): void {
    this.#store.removeMobilePushRegistrationAuthorized({
      registrationId: boundedIdentity(registrationId, "Mobile push registration ID"),
      connectionId: boundedIdentity(connectionId, "Mobile push Connection ID")
    });
  }

  unregisterWithTicket(serverId: string, registrationId: string, secret: string): void {
    if (serverId !== this.#serverId) throw new MobilePushTicketError();
    const removed = this.#store.removeMobilePushRegistrationWithSecret({
      registrationId: boundedIdentity(registrationId, "Mobile push registration ID"),
      revocationSecretDigest: privateDigest(normalizedRevocationSecret(secret))
    });
    if (!removed && this.#store.findMobilePushRegistration(registrationId) !== undefined) {
      throw new MobilePushTicketError();
    }
  }

  start(): void {
    if (this.#started || this.#closed) return;
    this.#started = true;
    if (this.#provider === undefined) return;
    this.#store.recoverInterruptedMobilePushDeliveries(this.#now());
    this.#unsubscribe = this.#store.subscribe((event) => {
      if (event.payload.type === "session_attention" && event.payload.unread) this.wake();
    });
    this.wake();
  }

  wake(): void {
    if (!this.#started || this.#closed || this.#provider === undefined || this.#running) return;
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    this.#running = true;
    this.#abort = new AbortController();
    this.#drain = Promise.resolve().then(() => this.drain(this.#abort!.signal)).finally(() => {
      this.#running = false;
      this.#abort = undefined;
      this.#drain = undefined;
      this.armNext();
    });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#abort?.abort();
    await this.#drain?.catch(() => undefined);
  }

  private async drain(signal: AbortSignal): Promise<void> {
    for (;;) {
      const claimed = this.#store.claimNextMobilePushDelivery(this.#now());
      if (claimed === undefined) return;
      let result: MobilePushDeliveryResult;
      try {
        const token = this.#vault.open(
          claimed.registration.sealedToken,
          mobilePushCredentialReference(this.#serverId, claimed.registration.id, "token")
        );
        result = await this.#provider!.send({
          environment: claimed.registration.environment,
          token,
          locale: claimed.registration.locale,
          kind: claimed.delivery.kind,
          intent: mobilePushIntent(
            claimed.delivery.sessionId,
            claimed.delivery.messageId,
            claimed.delivery.messageEventId
          )
        }, signal);
      } catch (error) {
        result = signal.aborted || abortError(error)
          ? { outcome: "unknown", code: "DISPATCH_ABORTED_UNKNOWN" }
          : { outcome: "invalid_registration", code: "CREDENTIAL_UNAVAILABLE" };
      }
      if (result.outcome === "retry") {
        if (claimed.delivery.attempts >= MOBILE_PUSH_RETRY_LIMIT) {
          this.#store.finishMobilePushDelivery({
            deliveryId: claimed.delivery.id,
            claimToken: claimed.delivery.claimToken!,
            outcome: "failed",
            outcomeCode: "RETRY_LIMIT",
            now: this.#now()
          });
          continue;
        }
        const retryAfterMs = boundedRetryDelay(
          result.retryAfterMs,
          MOBILE_PUSH_RETRY_BASE_MS * (2 ** Math.max(0, claimed.delivery.attempts - 1))
        );
        const completedAt = this.#now();
        this.#store.finishMobilePushDelivery({
          deliveryId: claimed.delivery.id,
          claimToken: claimed.delivery.claimToken!,
          outcome: "retry",
          outcomeCode: result.code,
          retryAt: completedAt + retryAfterMs,
          now: completedAt
        });
        continue;
      }
      this.#store.finishMobilePushDelivery({
        deliveryId: claimed.delivery.id,
        claimToken: claimed.delivery.claimToken!,
        outcome: result.outcome,
        outcomeCode: result.code,
        now: this.#now()
      });
    }
  }

  private armNext(): void {
    if (this.#closed || this.#provider === undefined || this.#running) return;
    const next = this.#store.nextMobilePushDeliveryAt();
    if (next === undefined) return;
    const delay = Math.min(Math.max(0, next - this.#now()), MOBILE_PUSH_TIMER_MAXIMUM_MS);
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.wake();
    }, delay);
    this.#timer.unref?.();
  }
}

export class MobilePushUnavailableError extends Error {
  constructor(readonly reasonCode: string) {
    super("Mobile push is unavailable on this node.");
    this.name = "MobilePushUnavailableError";
  }
}

export class MobilePushTicketError extends Error {
  constructor() {
    super("The mobile push revocation ticket is invalid.");
    this.name = "MobilePushTicketError";
  }
}

export class MobilePushInputError extends Error {
  constructor() {
    super("The mobile push registration input is invalid.");
    this.name = "MobilePushInputError";
  }
}

function normalizedDeviceToken(value: string): string {
  const normalized = value.trim();
  if (
    normalized.length === 0 ||
    normalized.length > MOBILE_PUSH_TOKEN_MAXIMUM_CHARACTERS ||
    /[\p{Cc}\u2028\u2029]/u.test(normalized)
  ) {
    throw new MobilePushInputError();
  }
  return normalized;
}

function normalizedRevocationSecret(value: string): string {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9_-]{43}$/u.test(normalized)) throw new MobilePushTicketError();
  return normalized;
}

function privateDigest(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function mobilePushCredentialReference(
  serverId: string,
  registrationId: string,
  field: "token" | "revocation"
): string {
  return `mobile-push:${serverId}:${registrationId}:${field}`;
}

function boundedIdentity(value: string, label: string): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > 256 || /[\p{Cc}\u2028\u2029]/u.test(normalized)) {
    throw new Error(`${label} is invalid.`);
  }
  return normalized;
}

function mobilePushIntent(sessionId: string, messageId?: string, messageEventId?: string): string {
  const task = boundedIdentity(sessionId, "Mobile push task ID");
  const message = messageId === undefined ? undefined : boundedIdentity(messageId, "Mobile push message ID");
  const event = messageEventId === undefined
    ? undefined
    : boundedIdentity(messageEventId, "Mobile push message Event ID");
  if (event !== undefined && message === undefined) throw new Error("Mobile push message identity is incomplete.");
  return `joko://task/${encodeURIComponent(task)}${message === undefined ? "" :
    `?message=${encodeURIComponent(message)}${event === undefined ? "" : `&event=${encodeURIComponent(event)}`}`}`;
}

function boundedRetryDelay(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isSafeInteger(value) || value < 1_000 || value > 60 * 60 * 1_000) {
    return Math.min(Math.max(fallback, 1_000), 60 * 60 * 1_000);
  }
  return value;
}

function abortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
