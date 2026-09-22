import { randomUUID } from "node:crypto";

import { WeChatApiClient, type WeChatFetch, validateWeChatHttpsUrl, validateWeChatOrigin } from "./api.js";
import { weChatCancelled, weChatConflict, weChatInvalid, weChatMalformed } from "./errors.js";
import type { WeChatAuthorizationEvent, WeChatCredentials } from "./model.js";

const AUTHORIZATION_TTL_MS = 5 * 60_000;
const MAXIMUM_QR_REFRESHES = 3;
const DEFAULT_AUTHORIZATION_ORIGIN = "https://ilinkai.weixin.qq.com/";

export interface WeChatAuthorizationOptions {
  readonly fetch?: WeChatFetch;
  readonly now?: () => number;
  readonly localTokens?: () => readonly string[] | Promise<readonly string[]>;
  readonly apiTimeoutMs?: number;
  readonly longPollTimeoutMs?: number;
}

interface ActiveAttempt {
  readonly id: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly localTokens: readonly string[];
  qrCode: string;
  qrCodeUrl: string;
  pollBaseUrl: string;
  status: "waiting" | "scanned" | "verification_required";
  refreshes: number;
  verificationAttempted: boolean;
}

/** Short-lived, in-memory QR authorization state machine. */
export class WeChatAuthorization {
  readonly #api: WeChatApiClient;
  readonly #now: () => number;
  readonly #localTokens: () => readonly string[] | Promise<readonly string[]>;
  #active: ActiveAttempt | null = null;
  #beginPromise: Promise<WeChatAuthorizationEvent> | null = null;
  #closed = false;

  constructor(options: WeChatAuthorizationOptions = {}) {
    this.#api = new WeChatApiClient({
      fetch: options.fetch,
      apiTimeoutMs: options.apiTimeoutMs,
      longPollTimeoutMs: options.longPollTimeoutMs
    });
    this.#now = options.now ?? Date.now;
    this.#localTokens = options.localTokens ?? (() => []);
  }

  async begin(signal?: AbortSignal): Promise<WeChatAuthorizationEvent> {
    this.#assertOpen();
    const operationSignal = signal ?? new AbortController().signal;
    operationSignal.throwIfAborted();
    if (this.#active !== null && this.#now() < this.#active.expiresAt) return publicState(this.#active);
    if (this.#beginPromise !== null) return this.#beginPromise;
    this.#active = null;
    const begun = (async (): Promise<WeChatAuthorizationEvent> => {
      const localTokens = [...await this.#localTokens()].filter(validLocalToken).slice(-10);
      operationSignal.throwIfAborted();
      this.#assertOpen();
      const response = await this.#api.beginQr(localTokens, operationSignal);
      operationSignal.throwIfAborted();
      this.#assertOpen();
      const now = this.#now();
      const attempt: ActiveAttempt = {
        id: randomUUID(),
        createdAt: now,
        expiresAt: now + AUTHORIZATION_TTL_MS,
        localTokens,
        qrCode: requiredSecret(response["qrcode"], "QR identity"),
        qrCodeUrl: requiredQrUrl(response["qrcode_img_content"]),
        pollBaseUrl: DEFAULT_AUTHORIZATION_ORIGIN,
        status: "waiting",
        refreshes: 0,
        verificationAttempted: false
      };
      this.#active = attempt;
      return publicState(attempt);
    })();
    this.#beginPromise = begun;
    try { return await begun; }
    finally { if (this.#beginPromise === begun) this.#beginPromise = null; }
  }

  async poll(input: {
    readonly attemptId: string;
    readonly verificationCode?: string;
    readonly signal?: AbortSignal;
  }): Promise<WeChatAuthorizationEvent> {
    this.#assertOpen();
    const attempt = this.#requireAttempt(input.attemptId);
    const signal = input.signal ?? new AbortController().signal;
    signal.throwIfAborted();
    if (this.#now() >= attempt.expiresAt) {
      this.#active = null;
      return { status: "expired", attemptId: attempt.id };
    }
    if (input.verificationCode !== undefined && !/^\d{1,12}$/u.test(input.verificationCode)) {
      throw weChatInvalid("WeChat verification code is invalid.");
    }
    if (input.verificationCode !== undefined && attempt.status !== "verification_required") {
      throw weChatInvalid("WeChat verification is not requested for this attempt.");
    }
    const verificationCode = input.verificationCode;
    const status = await this.#api.pollQr({
      qrCode: attempt.qrCode,
      ...(verificationCode === undefined ? {} : { verificationCode }),
      baseUrl: attempt.pollBaseUrl,
      signal
    });
    signal.throwIfAborted();
    this.#assertOpen();
    if (this.#active !== attempt) throw weChatCancelled("WeChat authorization attempt is no longer active.");
    if (this.#now() >= attempt.expiresAt) {
      this.#active = null;
      return { status: "expired", attemptId: attempt.id };
    }
    switch (status.status) {
      case "wait":
        attempt.status = "waiting";
        return publicState(attempt);
      case "scaned":
        attempt.status = "scanned";
        return publicState(attempt);
      case "need_verifycode": {
        const retry = attempt.verificationAttempted || verificationCode !== undefined;
        attempt.verificationAttempted = retry;
        attempt.status = "verification_required";
        return { status: "verification_required", attemptId: attempt.id, retry };
      }
      case "verify_code_blocked":
        this.#active = null;
        throw weChatConflict("WeChat verification attempts were blocked.");
      case "binded_redirect":
        this.#active = null;
        throw weChatConflict("This WeChat account is already bound.");
      case "scaned_but_redirect": {
        const host = requiredRedirectHost(status.redirect_host);
        attempt.pollBaseUrl = validateWeChatOrigin(`https://${host}/`).toString();
        attempt.status = "scanned";
        return publicState(attempt);
      }
      case "expired": {
        attempt.refreshes += 1;
        if (attempt.refreshes > MAXIMUM_QR_REFRESHES) {
          this.#active = null;
          return { status: "expired", attemptId: attempt.id };
        }
        const refreshed = await this.#api.beginQr(attempt.localTokens, signal);
        signal.throwIfAborted();
        this.#assertOpen();
        if (this.#active !== attempt) throw weChatCancelled("WeChat authorization attempt is no longer active.");
        if (this.#now() >= attempt.expiresAt) {
          this.#active = null;
          return { status: "expired", attemptId: attempt.id };
        }
        attempt.qrCode = requiredSecret(refreshed["qrcode"], "QR identity");
        attempt.qrCodeUrl = requiredQrUrl(refreshed["qrcode_img_content"]);
        attempt.pollBaseUrl = DEFAULT_AUTHORIZATION_ORIGIN;
        attempt.status = "waiting";
        attempt.verificationAttempted = false;
        return { status: "qr_refreshed", attemptId: attempt.id, qrCodeUrl: attempt.qrCodeUrl, expiresAt: attempt.expiresAt };
      }
      case "confirmed": {
        const credentials: WeChatCredentials = {
          token: requiredSecret(status.bot_token, "credential"),
          botId: requiredProviderId(status.ilink_bot_id, "bot"),
          userId: requiredProviderId(status.ilink_user_id, "account"),
          baseUrl: validateWeChatOrigin(requiredString(status.baseurl, "service origin")).toString()
        };
        this.#active = null;
        return { status: "confirmed", attemptId: attempt.id, credentials };
      }
      default:
        throw weChatMalformed("WeChat returned an unknown authorization status.");
    }
  }

  cancel(attemptId: string): void {
    this.#assertOpen();
    const normalized = requiredProviderId(attemptId, "authorization attempt");
    if (this.#active?.id === normalized) this.#active = null;
  }

  close(): void {
    this.#closed = true;
    this.#active = null;
  }

  #requireAttempt(attemptId: string): ActiveAttempt {
    const normalized = requiredProviderId(attemptId, "authorization attempt");
    if (this.#active?.id !== normalized) throw weChatCancelled("WeChat authorization attempt is no longer active.");
    return this.#active;
  }

  #assertOpen(): void {
    if (this.#closed) throw weChatCancelled("WeChat authorization is closed.");
  }
}

function publicState(attempt: ActiveAttempt): WeChatAuthorizationEvent {
  if (attempt.status === "verification_required") {
    return { status: "verification_required", attemptId: attempt.id, retry: attempt.verificationAttempted };
  }
  return { status: attempt.status, attemptId: attempt.id, qrCodeUrl: attempt.qrCodeUrl, expiresAt: attempt.expiresAt };
}

function requiredQrUrl(value: unknown): string {
  const raw = requiredString(value, "QR URL");
  return validateWeChatHttpsUrl(raw, "WeChat QR URL").toString();
}

function requiredRedirectHost(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9.-]{1,253}$/u.test(value)) throw weChatMalformed("WeChat returned an invalid authorization redirect.");
  return value;
}

function requiredProviderId(value: unknown, label: string): string {
  const normalized = requiredString(value, label).trim();
  if (normalized.length > 512 || /[\u0000-\u001f\u007f]/u.test(normalized)) throw weChatMalformed(`WeChat omitted a valid ${label}.`, false);
  return normalized;
}

function requiredSecret(value: unknown, label: string): string {
  const normalized = requiredString(value, label).trim();
  if (normalized.length > 8_192 || /[\u0000-\u001f\u007f]/u.test(normalized)) throw weChatMalformed(`WeChat omitted a valid ${label}.`, false);
  return normalized;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") throw weChatMalformed(`WeChat omitted ${label}.`, false);
  return value.trim();
}

function validLocalToken(value: string): boolean {
  const normalized = value.trim();
  return normalized.length >= 1 && normalized.length <= 8_192 && !/[\u0000-\u001f\u007f]/u.test(normalized);
}
