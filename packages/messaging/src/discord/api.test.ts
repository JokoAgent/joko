import { describe, expect, it, vi } from "vitest";

import { DiscordApi } from "./api.js";

const TOKEN = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcd";

describe("DiscordApi", () => {
  it("uses direct Bot authorization and never reflects the credential in failures", async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bot ${TOKEN}`);
      return jsonResponse({ message: `invalid ${TOKEN}` }, 401);
    }) as unknown as typeof globalThis.fetch;
    const api = new DiscordApi({ token: TOKEN, fetch });

    const failure = await api.currentUser().catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: "invalid_credential", options: { effect: "none", retryable: false } });
    expect(String(failure)).not.toContain(TOKEN);
  });

  it("marks an unacknowledged message write as an unknown effect and honors rate limits", async () => {
    const network = new DiscordApi({
      token: TOKEN,
      fetch: (async () => { throw new TypeError("reset"); }) as typeof globalThis.fetch
    });
    await expect(network.sendMessage("123456789012345678", { content: "hello" }))
      .rejects.toMatchObject({ code: "network", options: { effect: "unknown", retryable: true } });

    const limited = new DiscordApi({
      token: TOKEN,
      fetch: (async () => jsonResponse({ message: "slow down", retry_after: 2.5 }, 429)) as typeof globalThis.fetch
    });
    await expect(limited.currentUser()).rejects.toMatchObject({
      code: "rate_limited",
      options: { retryAfterMs: 2_500, effect: "none", retryable: true }
    });
  });

  it("bounds attachment bytes and rejects non-CDN origins", async () => {
    const fetch = vi.fn(async () => new Response("123456", {
      status: 200,
      headers: { "content-type": "text/plain", "content-length": "6" }
    })) as unknown as typeof globalThis.fetch;
    const api = new DiscordApi({ token: TOKEN, fetch });

    await expect(api.download("https://cdn.discordapp.com/attachments/1/2/file.txt", 5))
      .rejects.toMatchObject({ code: "payload_too_large" });
    await expect(api.download("https://example.com/file.txt", 10))
      .rejects.toMatchObject({ code: "invalid_input" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("allows HTTP only for an explicit loopback provider", () => {
    expect(() => new DiscordApi({ token: TOKEN, apiBaseUrl: "http://example.com/api/v10/" }))
      .toThrowError(expect.objectContaining({ code: "invalid_input" }));
    expect(() => new DiscordApi({ token: TOKEN, apiBaseUrl: "http://127.0.0.1:7777/api/v10/" }))
      .not.toThrow();
  });
});

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" }
  });
}
