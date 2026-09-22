import { once } from "node:events";

import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";

import { DingTalkTransport } from "./transport.js";

const NOW = Date.UTC(2026, 8, 22, 12, 0, 0);
const APP_KEY = "ding-app-key";
const BASE = "http://127.0.0.1:7777";
const servers: WebSocketServer[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe("DingTalkTransport", () => {
  it("claims an owner and uses transient callback capabilities for direct text, files, and downloads", async () => {
    const stream = await streamServer();
    stream.on("connection", (socket) => {
      socket.send(JSON.stringify({
        type: "CALLBACK",
        headers: { messageId: "callback-1", topic: "/v1.0/im/bot/messages/get" },
        data: JSON.stringify({
          conversationId: "direct-owner-1",
          conversationType: "1",
          msgId: "message-1",
          msgtype: "file",
          robotCode: APP_KEY,
          senderStaffId: "owner-1",
          senderNick: "Owner",
          createAt: NOW,
          sessionWebhook: `${BASE}/session`,
          sessionWebhookExpiredTime: NOW + 60_000,
          content: {
            downloadCode: "download-code",
            fileName: "evidence.txt",
            fileType: "text/plain",
            fileSize: 3
          }
        })
      }));
    });
    const requests: Array<{ readonly path: string; readonly body: unknown }> = [];
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const body = typeof init?.body === "string" ? JSON.parse(init.body) as unknown : init?.body;
      requests.push({ path: url.pathname, body });
      if (url.pathname === "/v1.0/oauth2/accessToken") return json({ accessToken: "modern-token", expireIn: 7_200 });
      if (url.pathname === "/v1.0/gateway/connections/open") {
        return json({ endpoint: serverUrl(stream), ticket: "stream-ticket" });
      }
      if (url.pathname === "/session") return json({ processQueryKey: "session-reply" });
      if (url.pathname === "/v1.0/robot/messageFiles/download") return json({ downloadUrl: `${BASE}/download` });
      if (url.pathname === "/download") {
        return new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: { "content-type": "text/plain", "content-length": "3" }
        });
      }
      if (url.pathname === "/gettoken") return json({ errcode: 0, access_token: "legacy-token", expires_in: 7_200 });
      if (url.pathname === "/media/upload") return json({ errcode: 0, media_id: "@media-1" });
      if (url.pathname === "/v1.0/robot/oToMessages/batchSend") return json({ processQueryKey: "file-reply" });
      return json({ code: "NotFound" }, 404);
    }) as unknown as typeof globalThis.fetch;
    const transport = new DingTalkTransport({
      appKey: APP_KEY,
      appSecret: "ding-app-secret",
      connectionId: "ding-connection",
      generation: 1,
      ownerUserId: null,
      groupActivation: {},
      initialCursor: null,
      now: () => NOW,
      apiBaseUrl: BASE,
      oapiBaseUrl: BASE,
      fetch
    });

    await transport.probe();
    const polled = await transport.poll({ cursor: null, timeoutSeconds: 1 });
    const normalized = transport.normalize(polled.updates);
    expect(normalized.ownerClaimProviderUserId).toBe("owner-1");
    const event = normalized.events[0];
    expect(event).toMatchObject({
      kind: "message",
      attachments: [expect.objectContaining({ kind: "file", fileName: "evidence.txt" })]
    });
    if (event?.kind !== "message") throw new Error("Expected a message event.");
    const address = transport.ownerAddress();
    expect(address.providerConversationId).toBe("owner-1");
    await expect(transport.downloadAttachment(event.attachments[0]!)).resolves.toEqual({
      bytes: new Uint8Array([1, 2, 3]),
      fileName: "evidence.txt",
      mimeType: "text/plain"
    });
    await expect(transport.sendTextPart({ address, text: "reply" })).resolves.toMatchObject({
      providerMessageId: "session-reply"
    });
    await expect(transport.sendInteractionCard({
      address,
      text: "Allow this operation?",
      buttons: [{ label: "Allow", actionValue: "claim:allow" }, { label: "Deny", actionValue: "claim:deny" }]
    })).resolves.toMatchObject({ providerMessageId: "session-reply" });
    await expect(transport.sendAttachments({
      address,
      attachments: [{
        kind: "file",
        bytes: new Uint8Array([4, 5]),
        fileName: "result.txt",
        mimeType: "text/plain"
      }]
    })).resolves.toMatchObject({ providerMessageId: "file-reply" });
    expect(requests).toContainEqual(expect.objectContaining({
      path: "/session",
      body: { msgtype: "text", text: { content: "reply" } }
    }));
    expect(requests).toContainEqual(expect.objectContaining({
      path: "/session",
      body: {
        msgtype: "text",
        text: { content: "Allow this operation?\n\nReply with a number or label:\n1. Allow\n2. Deny" }
      }
    }));
    expect(JSON.stringify(normalized)).not.toContain("download-code");
    expect(JSON.stringify(normalized)).not.toContain("/session");
    await transport.close();
  });
});

async function streamServer(): Promise<WebSocketServer> {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  servers.push(server);
  await once(server, "listening");
  return server;
}

function serverUrl(server: WebSocketServer): string {
  const address = server.address();
  if (typeof address === "string" || address === null) throw new Error("Missing server address.");
  return `ws://127.0.0.1:${address.port}/stream`;
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" }
  });
}
