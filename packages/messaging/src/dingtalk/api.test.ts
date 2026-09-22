import { describe, expect, it, vi } from "vitest";

import { DingTalkApi } from "./api.js";

const APP_KEY = "ding-app-key";
const APP_SECRET = "ding-app-secret-value";
const BASE = "http://127.0.0.1:7777";

describe("DingTalkApi", () => {
  it("opens the official Stream subscription using direct OAuth credentials", async () => {
    const requests: Array<{ readonly path: string; readonly body: unknown }> = [];
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const body = JSON.parse(String(init?.body)) as unknown;
      requests.push({ path: url.pathname, body });
      if (url.pathname === "/v1.0/oauth2/accessToken") {
        return json({ accessToken: "modern-token", expireIn: 7_200 });
      }
      if (url.pathname === "/v1.0/gateway/connections/open") {
        return json({ endpoint: "ws://127.0.0.1:7788/stream", ticket: "gateway-ticket" });
      }
      return json({ code: "NotFound" }, 404);
    }) as unknown as typeof globalThis.fetch;
    const api = createApi(fetch);

    await api.validateCredentials();
    await expect(api.openGateway()).resolves.toEqual({
      endpoint: "ws://127.0.0.1:7788/stream",
      ticket: "gateway-ticket"
    });
    expect(requests).toEqual([
      { path: "/v1.0/oauth2/accessToken", body: { appKey: APP_KEY, appSecret: APP_SECRET } },
      {
        path: "/v1.0/gateway/connections/open",
        body: {
          clientId: APP_KEY,
          clientSecret: APP_SECRET,
          ua: "Joko",
          subscriptions: [{ type: "CALLBACK", topic: "/v1.0/im/bot/messages/get" }]
        }
      }
    ]);
  });

  it("uses a live session webhook and falls back to proactive delivery only on a known no-effect failure", async () => {
    const requests: Array<{ readonly path: string; readonly body: unknown; readonly authorization: string | null }> = [];
    let webhookAttempts = 0;
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const body = typeof init?.body === "string" ? JSON.parse(init.body) as unknown : null;
      requests.push({
        path: url.pathname,
        body,
        authorization: new Headers(init?.headers).get("x-acs-dingtalk-access-token")
      });
      if (url.pathname === "/session") {
        webhookAttempts += 1;
        return webhookAttempts === 1
          ? json({ processQueryKey: "session-message" })
          : json({ code: "Expired" }, 404);
      }
      if (url.pathname === "/v1.0/oauth2/accessToken") return json({ accessToken: "modern-token", expireIn: 7_200 });
      if (url.pathname === "/v1.0/robot/oToMessages/batchSend") return json({ processQueryKey: "proactive-message" });
      return json({ code: "NotFound" }, 404);
    }) as unknown as typeof globalThis.fetch;
    const api = createApi(fetch);
    const target = {
      kind: "direct" as const,
      id: "owner-1",
      sessionWebhook: `${BASE}/session`,
      sessionWebhookExpiresAt: Date.now() + 60_000
    };

    await expect(api.sendText(target, "first")).resolves.toBe("session-message");
    await expect(api.sendText(target, "second")).resolves.toBe("proactive-message");
    expect(requests).toContainEqual({
      path: "/v1.0/robot/oToMessages/batchSend",
      authorization: "modern-token",
      body: {
        robotCode: APP_KEY,
        userIds: ["owner-1"],
        msgKey: "sampleText",
        msgParam: JSON.stringify({ content: "second" })
      }
    });
  });

  it("uploads image and file effects and keeps media downloads on trusted bounded origins", async () => {
    const sent: unknown[] = [];
    let untrusted = false;
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === "/gettoken") return json({ errcode: 0, access_token: "legacy-token", expires_in: 7_200 });
      if (url.pathname === "/media/upload") {
        expect(url.searchParams.get("access_token")).toBe("legacy-token");
        expect(init?.body).toBeInstanceOf(FormData);
        return json({ errcode: 0, media_id: "@media-1" });
      }
      if (url.pathname === "/v1.0/oauth2/accessToken") return json({ accessToken: "modern-token", expireIn: 7_200 });
      if (url.pathname === "/v1.0/robot/groupMessages/send") {
        sent.push(JSON.parse(String(init?.body)) as unknown);
        return json({ processQueryKey: `sent-${sent.length}` });
      }
      if (url.pathname === "/v1.0/robot/messageFiles/download") {
        return json({ downloadUrl: untrusted ? "https://example.com/private" : `${BASE}/media/content` });
      }
      if (url.pathname === "/media/content") {
        return new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: { "content-type": "image/png", "content-length": "3" }
        });
      }
      return json({ code: "NotFound" }, 404);
    }) as unknown as typeof globalThis.fetch;
    const api = createApi(fetch);
    const target = { kind: "group" as const, id: "group-1", sessionWebhook: null, sessionWebhookExpiresAt: null };

    await expect(api.sendAttachment(target, {
      kind: "image",
      bytes: new Uint8Array([1]),
      fileName: "image.png",
      mimeType: "image/png"
    })).resolves.toBe("sent-1");
    await expect(api.sendAttachment(target, {
      kind: "file",
      bytes: new Uint8Array([2]),
      fileName: "report.pdf",
      mimeType: "application/pdf"
    })).resolves.toBe("sent-2");
    expect(sent).toEqual([
      expect.objectContaining({
        openConversationId: "group-1",
        msgKey: "sampleImageMsg",
        msgParam: JSON.stringify({ photoURL: "@media-1" })
      }),
      expect.objectContaining({
        openConversationId: "group-1",
        msgKey: "sampleFile",
        msgParam: JSON.stringify({ mediaId: "@media-1", fileName: "report.pdf", fileType: "pdf", fileSize: 1 })
      })
    ]);
    await expect(api.downloadAttachment("download-code", 3)).resolves.toEqual({
      bytes: new Uint8Array([1, 2, 3]),
      mimeType: "image/png"
    });
    untrusted = true;
    await expect(api.downloadAttachment("download-code", 3)).rejects.toMatchObject({
      code: "provider_rejected",
      options: { retryable: false, effect: "none" }
    });
  });

  it("does not expose rejected credentials in errors", async () => {
    const api = createApi((async () => json({ message: APP_SECRET }, 401)) as typeof globalThis.fetch);
    const failure = await api.validateCredentials().catch((error: unknown) => error);

    expect(failure).toMatchObject({ code: "invalid_credential", options: { retryable: false, effect: "none" } });
    expect(String(failure)).not.toContain(APP_SECRET);
  });
});

function createApi(fetch: typeof globalThis.fetch): DingTalkApi {
  return new DingTalkApi({
    appKey: APP_KEY,
    appSecret: APP_SECRET,
    apiBaseUrl: BASE,
    oapiBaseUrl: BASE,
    fetch
  });
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" }
  });
}
