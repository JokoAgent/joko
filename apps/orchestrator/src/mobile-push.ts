import { createHash } from "node:crypto";

import { redactSecrets } from "@joko/core";
import { TaskShareStore } from "@joko/store";
import type {
  ClaimedMobilePushDelivery,
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
  readonly title?: string;
  readonly body?: string;
  readonly collapseId?: string;
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
  readonly redactText?: (value: string) => string;
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
  readonly previewEnabled?: boolean;
}

export interface RegisteredMobilePush {
  readonly registration: MobilePushRegistrationRecord;
  readonly revocationSecret: string;
  readonly previewEnabled: boolean;
}

export class MobilePushCoordinator {
  readonly #now: () => number;
  readonly #provider: MobilePushProviderPort | undefined;
  readonly #redactText: (value: string) => string;
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
    this.#redactText = value => redactSecrets(options.redactText?.(value) ?? value);
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
      previewEnabled: input.previewEnabled === true,
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
    return { registration, revocationSecret, previewEnabled: this.#store.mobilePushPreviewEnabled(registration) };
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
      if ((event.payload.type === "session_attention" && event.payload.unread)
        || (event.payload.type === "run_state" && event.payload.state === "completed" && event.runId !== undefined
          && this.#store.findRun(event.runId)?.descriptor.source === "schedule")) this.wake();
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

  notifyGroupStep(input: Parameters<OperationalStore["enqueuePartnerGroupStepPush"]>[0]): void {
    this.#store.enqueuePartnerGroupStepPush(input); this.wake();
  }
  notifyInputHandoff(input: Parameters<OperationalStore["enqueueInputHandoffPush"]>[0]): void {
    this.#store.enqueueInputHandoffPush(input); this.wake();
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
        const collapseId = claimed.delivery.kind === "done" && claimed.delivery.groupId === undefined
          ? createHash("sha256").update(JSON.stringify([this.#serverId, claimed.delivery.sessionId]), "utf8").digest("hex").slice(0, 32) : undefined;
        const preview = this.completionPreview(claimed);
        result = await this.#provider!.send({
          environment: claimed.registration.environment,
          token,
          locale: claimed.registration.locale,
          kind: claimed.delivery.kind,
          ...(collapseId === undefined ? {} : { collapseId }),
          ...(claimed.delivery.groupTitle === undefined ? {} : { title: claimed.delivery.groupTitle }),
          ...preview,
          intent: claimed.delivery.groupId === undefined ? mobilePushIntent(
            this.#serverId,
            claimed.delivery.sessionId,
            claimed.delivery.messageId,
            claimed.delivery.messageEventId
          ) : `joko://partner-group/${encodeURIComponent(boundedIdentity(claimed.delivery.groupId, "Push group ID"))}`
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

  private completionPreview({ delivery, registration }: ClaimedMobilePushDelivery): { title: string; body: string } | undefined {
    if (delivery.kind !== "done" || delivery.groupId !== undefined || delivery.messageEventId === undefined) return undefined;
    try {
      if (!this.#store.mobilePushPreviewEnabled(registration)) return undefined;
      const session = this.#store.findSession(delivery.sessionId)?.descriptor;
      const attention = this.#store.findSessionAttention(delivery.sessionId);
      if (!session || session.hidden || session.archived || session.deletedAt !== undefined || session.automationOrigin
        || session.binding.generation !== delivery.subjectGeneration || attention?.kind !== "done" || !attention.unread
        || attention.subjectCursor !== delivery.subjectCursor || attention.subjectGeneration !== delivery.subjectGeneration
        || this.#store.listRuns({ sessionId: session.id, states: ["running", "waiting", "retrying", "dispatch_unknown"], limit: 1 }).length > 0
        || new TaskShareStore(this.#store).list().some(share => share.sessionId === session.id && share.status === "active")) return undefined;
      const event = this.#store.findEvent(delivery.messageEventId);
      if (!event || event.sessionId !== session.id || event.generation !== delivery.subjectGeneration
        || event.globalCursor > delivery.subjectCursor || event.runId === undefined || event.attemptId === undefined) return undefined;
      const run = this.#store.findRun(event.runId)?.descriptor;
      const payload = event.payload;
      if (run?.sessionId !== session.id || run.source !== "user" || run.parentRunId !== undefined
        || run.state !== "completed" || run.activeAttemptId !== event.attemptId
        || payload.type !== "message_complete" || payload.role !== "assistant" || payload.automationOrigin
        || payload.partnerPrivateOrigin || payload.collaborationReportOrigin || payload.taskMessageOrigin
        || payload.automaticContinuation || payload.objectiveContinuation || payload.inputHandoffContinuation) return undefined;
      const title = compactPreviewText(this.#redactText(session.title), 72);
      const body = compactPreviewText(this.#redactText(payload.blocks.flatMap(block => block.kind === "text" ? [block.text] : []).join(" ")), 160);
      return title && body ? { title, body } : undefined;
    } catch {
      // A notification with an unavailable or unverified preview can still deliver its status.
      return undefined;
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

function compactPreviewText(value: string, maximum: number): string {
  const plain = value.replace(/[\s\p{Cc}]+/gu, " ").trim();
  if (plain.length <= maximum) return plain;
  let preview = "";
  for (const character of plain) {
    if (preview.length + character.length >= maximum) return preview.trimEnd() + "…";
    preview += character;
  }
  return preview;
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

function mobilePushIntent(serverId: string, sessionId: string, messageId?: string, messageEventId?: string): string {
  const task = boundedIdentity(sessionId, "Mobile push task ID");
  const message = messageId === undefined ? undefined : boundedIdentity(messageId, "Mobile push message ID");
  const event = messageEventId === undefined
    ? undefined
    : boundedIdentity(messageEventId, "Mobile push message Event ID");
  if (event !== undefined && message === undefined) throw new Error("Mobile push message identity is incomplete.");
  const source = `server=${encodeURIComponent(serverId)}`;
  const query = message === undefined ? source :
    `message=${encodeURIComponent(message)}${event === undefined ? "" : `&event=${encodeURIComponent(event)}`}&${source}`;
  return `joko://task/${encodeURIComponent(task)}?${query}`;
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
