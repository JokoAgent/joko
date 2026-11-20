import { createPrivateKey, sign, type KeyObject } from "node:crypto";

import {
  mobilePushAttentionTitle,
  type MobilePushDeliveryInput,
  type MobilePushDeliveryResult,
  type MobilePushProviderPort
} from "./mobile-push.js";

const oauthEndpoint = "https://oauth2.googleapis.com/token";
const messagingScope = "https://www.googleapis.com/auth/firebase.messaging";
const requestTimeoutMs = 10_000;
const maximumResponseBytes = 16_384;

/** Sends one node-authorized delivery to its Android registration. */
export class FcmMobilePushProvider implements MobilePushProviderPort {
  readonly #key: KeyObject;
  readonly #email: string;
  readonly #keyId: string;
  readonly #projectId: string;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  #authorization: { readonly token: string; readonly expiresAt: number } | undefined;

  constructor(serviceAccount: string, options: { readonly fetch?: typeof fetch; readonly now?: () => number } = {}) {
    let account: Record<string, unknown> | undefined;
    try { account = object(JSON.parse(serviceAccount) as unknown); }
    catch { throw new Error("The configured FCM service account must be a JSON object."); }
    const project = account?.["project_id"];
    const email = account?.["client_email"];
    const keyId = account?.["private_key_id"];
    const pem = account?.["private_key"];
    if (account?.["type"] !== "service_account"
      || typeof project !== "string" || !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/u.test(project)
      || typeof email !== "string" || !/^[a-z0-9_.+-]{1,128}@[a-z0-9.-]{1,128}\.gserviceaccount\.com$/iu.test(email)
      || typeof keyId !== "string" || !/^[a-f0-9]{40}$/iu.test(keyId)
      || typeof pem !== "string" || pem.length > 8_192
      || (account["token_uri"] !== undefined && account["token_uri"] !== oauthEndpoint)) {
      throw new Error("The configured FCM service account is invalid.");
    }
    try { this.#key = createPrivateKey(pem); }
    catch { throw new Error("The configured FCM service account has an invalid private key."); }
    if (this.#key.asymmetricKeyType !== "rsa" || (this.#key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) {
      throw new Error("The configured FCM service account must have an RSA key of at least 2048 bits.");
    }
    this.#projectId = project;
    this.#email = email;
    this.#keyId = keyId;
    this.#fetch = options.fetch ?? fetch;
    this.#now = options.now ?? Date.now;
  }

  async send(input: MobilePushDeliveryInput, signal: AbortSignal, isCurrent?: () => boolean): Promise<MobilePushDeliveryResult> {
    const current = () => !signal.aborted && isCurrent?.() !== false;
    if (input.environment !== "fcm" || !current()) return { outcome: "failed", code: "PUSH_AUTHORITY_CHANGED" };
    const status = mobilePushAttentionTitle(input);
    const body = JSON.stringify({
      message: {
        token: input.token,
        notification: { title: input.title ?? status, ...(input.title === undefined ? {} : { body: input.body ?? status }) },
        data: { intent: input.intent },
        android: {
          priority: "high",
          notification: { channel_id: "joko-task-attention", visibility: "PRIVATE",
            ...(input.collapseId === undefined ? {} : { tag: input.collapseId }) }
        }
      }
    });
    if (Buffer.byteLength(body, "utf8") > 4_096) return { outcome: "failed", code: "FCM_PAYLOAD_LIMIT" };
    let token: string;
    try { token = await this.authorization(signal); }
    catch {
      return current() ? { outcome: "retry", code: "FCM_AUTH_UNAVAILABLE", retryAfterMs: 60_000 }
        : { outcome: "failed", code: "PUSH_AUTHORITY_CHANGED" };
    }
    if (!current()) return { outcome: "failed", code: "PUSH_AUTHORITY_CHANGED" };
    try {
      const response = await this.#fetch(`https://fcm.googleapis.com/v1/projects/${this.#projectId}/messages:send`, {
        method: "POST", redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(requestTimeoutMs)]),
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body
      });
      const payload = await responseObject(response);
      const name = payload?.["name"];
      if (response.status === 200 && typeof name === "string"
        && name.startsWith(`projects/${this.#projectId}/messages/`) && name.split("/").length === 4
        && name.length > `projects/${this.#projectId}/messages/`.length) {
        return { outcome: "delivered", code: "FCM_ACCEPTED" };
      }
      const error = object(payload?.["error"]);
      if (error?.["code"] !== response.status) return { outcome: "unknown", code: "FCM_RESPONSE_UNKNOWN" };
      const errorStatus = error["status"];
      const details = error["details"];
      if (response.status === 404 && errorStatus === "NOT_FOUND" && Array.isArray(details)
        && details.some(detail => object(detail)?.["@type"] === "type.googleapis.com/google.firebase.fcm.v1.FcmError"
          && object(detail)?.["errorCode"] === "UNREGISTERED")) {
        return { outcome: "invalid_registration", code: "FCM_UNREGISTERED" };
      }
      if (response.status === 401 && errorStatus === "UNAUTHENTICATED") {
        this.#authorization = undefined;
        return { outcome: "retry", code: "FCM_AUTH_EXPIRED", retryAfterMs: 60_000 };
      }
      if ((response.status === 429 && errorStatus === "RESOURCE_EXHAUSTED")
        || (response.status === 503 && errorStatus === "UNAVAILABLE") || (response.status === 500 && errorStatus === "INTERNAL")) {
        return { outcome: "retry", code: response.status === 429 ? "FCM_QUOTA" : "FCM_UNAVAILABLE",
          retryAfterMs: retryDelay(response.headers.get("retry-after"), this.#now(), response.status === 429 ? 60_000 : 1_000) };
      }
      return response.status >= 400 && response.status < 500 ? { outcome: "failed", code: "FCM_REJECTED" }
        : { outcome: "unknown", code: "FCM_RESPONSE_UNKNOWN" };
    } catch {
      return { outcome: "unknown", code: "FCM_TRANSPORT_UNKNOWN" };
    }
  }

  private async authorization(signal: AbortSignal): Promise<string> {
    const now = this.#now();
    if (this.#authorization !== undefined && this.#authorization.expiresAt > now + 60_000) return this.#authorization.token;
    const issuedAt = Math.floor(now / 1_000);
    const header = base64Json({ alg: "RS256", typ: "JWT", kid: this.#keyId });
    const claims = base64Json({ iss: this.#email, aud: oauthEndpoint, scope: messagingScope, iat: issuedAt, exp: issuedAt + 3_600 });
    const unsigned = `${header}.${claims}`;
    const assertion = `${unsigned}.${sign("RSA-SHA256", Buffer.from(unsigned, "utf8"), this.#key).toString("base64url")}`;
    const response = await this.#fetch(oauthEndpoint, {
      method: "POST", redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(requestTimeoutMs)]),
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion })
    });
    const parsed = await responseObject(response);
    const token = parsed?.["access_token"];
    const expiresIn = parsed?.["expires_in"];
    if (!response.ok || parsed?.["token_type"] !== "Bearer"
      || typeof token !== "string" || !/^[A-Za-z0-9._~+/-]{1,4096}={0,2}$/u.test(token)
      || typeof expiresIn !== "number" || !Number.isSafeInteger(expiresIn) || expiresIn <= 0) {
      throw new Error("FCM authorization is unavailable.");
    }
    this.#authorization = { token, expiresAt: now + Math.min(expiresIn, 3_600) * 1_000 };
    return token;
  }
}

function retryDelay(header: string | null, now: number, minimum: number): number {
  if (header === null) return minimum;
  const delay = /^\d{1,8}$/u.test(header) ? Number(header) * 1_000 : Date.parse(header) - now;
  return Number.isFinite(delay) ? Math.min(3_600_000, Math.max(minimum, delay)) : minimum;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function base64Json(value: Readonly<Record<string, string | number>>): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

async function responseObject(response: Response): Promise<Record<string, unknown> | undefined> {
  const reader = response.body?.getReader();
  if (reader === undefined) return undefined;
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) return object(JSON.parse(Buffer.concat(chunks, length).toString("utf8")) as unknown);
      length += chunk.value.byteLength;
      if (length > maximumResponseBytes) return undefined;
      chunks.push(chunk.value);
    }
  } finally {
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
