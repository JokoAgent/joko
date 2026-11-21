import { MessagingTransportError } from "../types.js";
import { parseIMessageOrigin } from "./configuration.js";

export const MAXIMUM_IMESSAGE_ATTACHMENT_BYTES = 64 * 1024 * 1024;
const MESSAGE_FIELDS = ["chats", "chats.participants", "attachments", "attributed-body"];
const JSON_BYTES = 4 * 1024 * 1024;

export class BlueBubblesApi {
  readonly #origin: string;

  constructor(origin: string, private readonly password: string, private readonly fetcher: typeof fetch = fetch) {
    this.#origin = parseIMessageOrigin(origin);
    if (!password || password.length > 4_096 || /[\u0000-\u001f\u007f]/u.test(password)) {
      throw blueBubblesFailure("invalid_credential", "The BlueBubbles password is invalid.");
    }
  }

  info(signal?: AbortSignal): Promise<unknown> {
    return this.#request("GET", "/api/v1/server/info", { signal });
  }

  chat(guid: string, signal?: AbortSignal): Promise<unknown> {
    return this.#request("GET", `/api/v1/chat/${encodeURIComponent(guid)}?with=participants`, { signal });
  }

  message(guid: string, signal?: AbortSignal): Promise<unknown> {
    return this.#request("GET", `/api/v1/message/${encodeURIComponent(guid)}?with=${MESSAGE_FIELDS.join(",")}`, { signal });
  }

  history(chatGuid: string, after: number, before: number, offset: number, signal?: AbortSignal): Promise<unknown> {
    return this.#request("POST", "/api/v1/message/query", { body: { chatGuid, after, before, offset,
      limit: 100, sort: "ASC", with: MESSAGE_FIELDS }, signal });
  }

  async download(guid: string, signal?: AbortSignal): Promise<Uint8Array> {
    return await this.#request("GET", `/api/v1/attachment/${encodeURIComponent(guid)}/download?original=true`,
      { binary: true, signal }) as Uint8Array;
  }

  sendText(chatGuid: string, message: string, tempGuid: string, method: "apple-script" | "private-api", signal?: AbortSignal): Promise<unknown> {
    return this.#request("POST", "/api/v1/message/text", { body: { chatGuid, message, tempGuid, method }, effect: true, signal });
  }

  sendFile(chatGuid: string, bytes: Uint8Array, name: string, tempGuid: string, method: "apple-script" | "private-api", signal?: AbortSignal): Promise<unknown> {
    const body = new FormData();
    body.set("chatGuid", chatGuid);
    body.set("tempGuid", tempGuid);
    body.set("method", method);
    body.set("name", name);
    body.set("attachment", new Blob([new Uint8Array(bytes)]), name);
    return this.#request("POST", "/api/v1/message/attachment", { body, effect: true, signal });
  }

  async #request(method: string, route: string, input: {
    readonly body?: unknown;
    readonly effect?: boolean;
    readonly binary?: boolean;
    readonly signal?: AbortSignal;
  }): Promise<unknown> {
    if (input.signal?.aborted) throw blueBubblesFailure("cancelled", "The BlueBubbles request was cancelled.");
    const url = new URL(route, this.#origin);
    url.searchParams.set("password", this.password);
    const timeout = AbortSignal.timeout(15_000);
    const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout;
    try {
      const response = await this.fetcher(url, { method, signal, redirect: "error",
        ...(input.body instanceof FormData ? { body: input.body } : input.body === undefined ? {}
          : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(input.body) }) });
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        if ([401, 403].includes(response.status)) throw blueBubblesFailure("invalid_credential", "BlueBubbles rejected the password.");
        if (response.status === 429) throw blueBubblesFailure("rate_limited", "BlueBubbles is rate limiting this connection.", false, true);
        throw blueBubblesFailure(response.status < 500 ? "provider_rejected" : "provider_unavailable",
          "BlueBubbles could not confirm the request.", input.effect === true, response.status >= 500);
      }
      const maximum = input.binary ? MAXIMUM_IMESSAGE_ATTACHMENT_BYTES : JSON_BYTES;
      const declared = Number(response.headers.get("content-length"));
      if (declared > maximum) {
        await response.body?.cancel().catch(() => undefined);
        throw blueBubblesFailure("payload_too_large", "The BlueBubbles response exceeds its size limit.", input.effect === true);
      }
      const reader = response.body?.getReader();
      if (!reader) throw blueBubblesFailure("malformed_response", "BlueBubbles returned no response.", input.effect === true);
      const chunks: Uint8Array[] = [];
      let length = 0;
      try {
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          length += part.value.byteLength;
          if (length > maximum) throw blueBubblesFailure("payload_too_large", "The BlueBubbles response exceeds its size limit.", input.effect === true);
          chunks.push(part.value);
        }
      } finally {
        await reader.cancel().catch(() => undefined);
        reader.releaseLock();
      }
      const bytes = Buffer.concat(chunks, length);
      if (input.binary) return bytes;
      const envelope = JSON.parse(bytes.toString("utf8")) as Record<string, unknown> | null;
      if (!envelope || typeof envelope !== "object" || !Object.hasOwn(envelope, "data")
        || typeof envelope["status"] !== "number" || envelope["status"] < 200 || envelope["status"] >= 300) {
        throw blueBubblesFailure("malformed_response", "BlueBubbles returned an unconfirmed response.", input.effect === true);
      }
      return envelope["data"];
    } catch (error) {
      if (error instanceof MessagingTransportError) throw error;
      // Fetch diagnostics can contain the URL and its query password.
      throw blueBubblesFailure(signal.aborted && input.signal?.aborted ? "cancelled" : "network",
        "BlueBubbles did not complete the network request.", input.effect === true, !input.effect);
    }
  }
}

export function blueBubblesFailure(code: MessagingTransportError["code"], message: string, unknown = false, retryable = false): MessagingTransportError {
  return new MessagingTransportError(code, message, { effect: unknown ? "unknown" : "none", retryable: retryable && !unknown });
}
