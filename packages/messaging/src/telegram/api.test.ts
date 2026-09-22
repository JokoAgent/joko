import { describe, expect, it, vi } from "vitest";

import { MessagingTransportError } from "../types.js";
import { TelegramApi } from "./api.js";

const TOKEN = "123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcd";

describe("TelegramApi", () => {
  it("calls the direct Bot API without exposing the token in results", async () => {
    const requests: Array<{ readonly url: string; readonly init: RequestInit }> = [];
    const api = new TelegramApi({
      token: TOKEN,
      fetch: fakeFetch(async (url, init) => {
        requests.push({ url, init });
        return jsonResponse({ ok: true, result: { id: 77, is_bot: true, first_name: "Joko" } });
      })
    });

    await expect(api.call("getMe")).resolves.toMatchObject({ id: 77 });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe(`https://api.telegram.org/bot${TOKEN}/getMe`);
    expect(requests[0]?.init.method).toBe("POST");
  });

  it("classifies provider failures and redacts a reflected credential", async () => {
    const api = new TelegramApi({
      token: TOKEN,
      fetch: fakeFetch(async () => jsonResponse({
        ok: false,
        error_code: 401,
        description: `bad token ${TOKEN}`
      }, 401))
    });

    const failure = await api.call("getMe").catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(MessagingTransportError);
    expect(failure).toMatchObject({ code: "invalid_credential", options: { effect: "none", retryable: false } });
    expect(String(failure)).not.toContain(TOKEN);
  });

  it("marks an unacknowledged write as an unknown external effect", async () => {
    const api = new TelegramApi({
      token: TOKEN,
      fetch: fakeFetch(async () => {
        throw new TypeError("socket reset");
      })
    });

    await expect(api.call("sendMessage", { chat_id: 42, text: "hello" }, { effect: "unknown" }))
      .rejects.toMatchObject({ code: "network", options: { effect: "unknown", retryable: true } });
    await expect(api.callForm("sendDocument", new FormData(), { effect: "unknown" }))
      .rejects.toMatchObject({ code: "network", options: { effect: "unknown", retryable: true } });
  });

  it("classifies long-poll conflicts and honors provider backoff", async () => {
    const conflict = new TelegramApi({
      token: TOKEN,
      fetch: fakeFetch(async () => jsonResponse({
        ok: false,
        error_code: 409,
        description: "terminated by another getUpdates request"
      }, 409))
    });
    await expect(conflict.call("getUpdates"))
      .rejects.toMatchObject({ code: "conflict", options: { effect: "none", retryable: true } });

    const limited = new TelegramApi({
      token: TOKEN,
      fetch: fakeFetch(async () => jsonResponse({
        ok: false,
        error_code: 429,
        description: "retry later",
        parameters: { retry_after: 3 }
      }, 429))
    });
    await expect(limited.call("getUpdates"))
      .rejects.toMatchObject({
        code: "rate_limited",
        options: { effect: "none", retryable: true, retryAfterMs: 3_000 }
      });
  });

  it("bounds downloads before adopting provider bytes", async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/getFile")) {
        return jsonResponse({ ok: true, result: { file_id: "f1", file_size: 6, file_path: "docs/a.txt" } });
      }
      return new Response("123456", {
        status: 200,
        headers: { "content-type": "text/plain", "content-length": "6" }
      });
    }) as unknown as typeof globalThis.fetch;
    const api = new TelegramApi({ token: TOKEN, fetch });

    await expect(api.downloadFile("f1", 5)).rejects.toMatchObject({ code: "payload_too_large" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("allows only HTTPS or a loopback HTTP provider", () => {
    expect(() => new TelegramApi({ token: TOKEN, apiBaseUrl: "http://example.com" }))
      .toThrowError(expect.objectContaining({ code: "invalid_input" }));
    expect(() => new TelegramApi({ token: TOKEN, apiBaseUrl: "http://127.0.0.1:7777" }))
      .not.toThrow();
  });
});

function fakeFetch(
  handler: (url: string, init: RequestInit) => Promise<Response>
): typeof globalThis.fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => handler(String(input), init ?? {})) as typeof globalThis.fetch;
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" }
  });
}
