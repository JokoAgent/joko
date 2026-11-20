import { createPrivateKey, createSign, type KeyObject } from "node:crypto";
import { connect, type ClientHttp2Session, type ClientHttp2Stream, type IncomingHttpHeaders } from "node:http2";

import {
  mobilePushAttentionTitle,
  type MobilePushDeliveryInput,
  type MobilePushDeliveryResult,
  type MobilePushProviderPort
} from "./mobile-push.js";

const APNS_REQUEST_TIMEOUT_MS = 10_000;
const APNS_RESPONSE_MAXIMUM_BYTES = 4_096;
const APNS_TOKEN_TTL_SECONDS = 50 * 60;

export interface ApnsMobilePushProviderOptions {
  readonly teamId: string;
  readonly keyId: string;
  readonly privateKeyPem: string;
  readonly topic: string;
  readonly now?: () => number;
}

/** Generic Joko-owned APNs transport. It consumes only the bounded delivery
 * envelope; APNs signing material never enters Store, Events, diagnostics, or
 * request-selected state. */
export class ApnsMobilePushProvider implements MobilePushProviderPort {
  readonly #key: KeyObject;
  readonly #keyId: string;
  readonly #now: () => number;
  readonly #teamId: string;
  readonly #topic: string;
  #authorization: { readonly issuedAt: number; readonly value: string } | undefined;

  constructor(options: ApnsMobilePushProviderOptions) {
    this.#teamId = options.teamId;
    this.#keyId = options.keyId;
    this.#topic = options.topic;
    this.#now = options.now ?? Date.now;
    this.#key = createPrivateKey(options.privateKeyPem);
    if (this.#key.asymmetricKeyType !== "ec") throw new Error("The APNs private key must be an EC key.");
  }

  async send(input: MobilePushDeliveryInput, signal: AbortSignal, isCurrent?: () => boolean): Promise<MobilePushDeliveryResult> {
    if (signal.aborted) return { outcome: "unknown", code: "APNS_ABORTED_UNKNOWN" };
    if (input.environment === "fcm" || isCurrent?.() === false) {
      return { outcome: "failed", code: "PUSH_AUTHORITY_CHANGED" };
    }
    if (input.collapseId !== undefined && !/^[0-9a-f]{32}$/u.test(input.collapseId)) {
      return { outcome: "failed", code: "APNS_COLLAPSE_ID_INVALID" };
    }
    const payload = buildApnsMobilePushPayload(input);
    if (payload.byteLength > APNS_RESPONSE_MAXIMUM_BYTES) {
      return { outcome: "failed", code: "APNS_PAYLOAD_LIMIT" };
    }
    const origin = input.environment === "apns_sandbox"
      ? "https://api.sandbox.push.apple.com"
      : "https://api.push.apple.com";
    return await this.request(origin, input.token, input.collapseId, payload, signal);
  }

  private async request(
    origin: string,
    token: string,
    collapseId: string | undefined,
    payload: Buffer,
    signal: AbortSignal
  ): Promise<MobilePushDeliveryResult> {
    return await new Promise((resolve) => {
      let session: ClientHttp2Session | undefined;
      let stream: ClientHttp2Stream | undefined;
      let settled = false;
      let status = 0;
      let responseBytes = 0;
      const response: Buffer[] = [];
      const finish = (result: MobilePushDeliveryResult, destroy = false): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        if (destroy) {
          stream?.destroy();
          session?.destroy();
        } else {
          session?.close();
        }
        resolve(result);
      };
      const onAbort = (): void => finish({ outcome: "unknown", code: "APNS_ABORTED_UNKNOWN" }, true);
      const timer = setTimeout(
        () => finish({ outcome: "unknown", code: "APNS_TIMEOUT_UNKNOWN" }, true),
        APNS_REQUEST_TIMEOUT_MS
      );
      timer.unref?.();
      signal.addEventListener("abort", onAbort, { once: true });
      try {
        session = connect(origin);
        session.once("error", () => finish({ outcome: "unknown", code: "APNS_TRANSPORT_UNKNOWN" }, true));
        stream = session.request({
          ":method": "POST",
          ":path": `/3/device/${encodeURIComponent(token)}`,
          authorization: `bearer ${this.authorizationToken()}`,
          "apns-topic": this.#topic,
          "apns-push-type": "alert",
          "apns-priority": "10",
          ...(collapseId === undefined ? {} : { "apns-collapse-id": collapseId }),
          "content-type": "application/json",
          "content-length": String(payload.byteLength)
        });
        stream.once("response", (headers: IncomingHttpHeaders) => {
          status = Number(headers[":status"] ?? 0);
        });
        stream.on("data", (chunk: Buffer | string) => {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          responseBytes += bytes.byteLength;
          if (responseBytes <= APNS_RESPONSE_MAXIMUM_BYTES) response.push(bytes);
        });
        stream.once("error", () => finish({ outcome: "unknown", code: "APNS_TRANSPORT_UNKNOWN" }, true));
        stream.once("end", () => {
          const reason = responseBytes > APNS_RESPONSE_MAXIMUM_BYTES
            ? undefined
            : apnsReason(Buffer.concat(response).toString("utf8"));
          finish(classifyApnsResponse(status, reason));
        });
        stream.end(payload);
      } catch {
        finish({ outcome: "unknown", code: "APNS_TRANSPORT_UNKNOWN" }, true);
      }
    });
  }

  private authorizationToken(): string {
    const issuedAt = Math.floor(this.#now() / 1_000);
    if (this.#authorization !== undefined && issuedAt - this.#authorization.issuedAt < APNS_TOKEN_TTL_SECONDS) {
      return this.#authorization.value;
    }
    const header = base64UrlJson({ alg: "ES256", kid: this.#keyId });
    const claims = base64UrlJson({ iss: this.#teamId, iat: issuedAt });
    const content = `${header}.${claims}`;
    const signer = createSign("SHA256");
    signer.update(content);
    signer.end();
    const signature = signer.sign({ key: this.#key, dsaEncoding: "ieee-p1363" }).toString("base64url");
    const value = `${content}.${signature}`;
    this.#authorization = { issuedAt, value };
    return value;
  }
}

export function buildApnsMobilePushPayload(input: MobilePushDeliveryInput): Buffer {
  const status = mobilePushAttentionTitle(input);
  return Buffer.from(JSON.stringify({
    aps: {
      alert: { title: input.title ?? status, ...(input.title === undefined ? {} : { body: input.body ?? status }) },
      ...(input.collapseId === undefined ? {} : { "thread-id": input.collapseId })
    },
    intent: input.intent
  }), "utf8");
}

export function classifyApnsResponse(status: number, reason: string | undefined): MobilePushDeliveryResult {
  if (status === 200) return { outcome: "delivered", code: "APNS_200" };
  if (reason === "BadDeviceToken" || reason === "DeviceTokenNotForTopic" || reason === "Unregistered") {
    return { outcome: "invalid_registration", code: reason === "Unregistered"
      ? "APNS_UNREGISTERED"
      : reason === "DeviceTokenNotForTopic" ? "APNS_TOKEN_TOPIC" : "APNS_BAD_TOKEN" };
  }
  if (status === 429 || status === 500 || status === 503) {
    return { outcome: "retry", code: status === 429 ? "APNS_429" : "APNS_5XX" };
  }
  if (status >= 400 && status < 500) return { outcome: "failed", code: "APNS_REJECTED" };
  if (status >= 500) return { outcome: "retry", code: "APNS_5XX" };
  return { outcome: "unknown", code: "APNS_RESPONSE_UNKNOWN" };
}

function apnsReason(value: string): string | undefined {
  try {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === "object" && parsed !== null && "reason" in parsed &&
      typeof parsed.reason === "string" ? parsed.reason : undefined;
  } catch {
    return undefined;
  }
}

function base64UrlJson(value: Readonly<Record<string, string | number>>): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}
