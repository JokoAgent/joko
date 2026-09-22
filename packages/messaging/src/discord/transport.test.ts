import { once } from "node:events";

import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket, { WebSocketServer, type RawData } from "ws";

import { DiscordTransport } from "./transport.js";

const TOKEN = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcd";
const BOT_ID = "222222222222222222";
const OWNER_ID = "111111111111111111";
const DM_ID = "444444444444444444";
const MESSAGE_ID = "900000000000000001";
const servers: WebSocketServer[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe("DiscordTransport effects", () => {
  it("uses direct Discord surfaces for replies, files, cards, typing, and reaction replacement", async () => {
    const gateway = await gatewayServer();
    gateway.on("connection", (socket) => {
      socket.on("message", (raw) => {
        const packet = parse(raw);
        if (packet.op === 1) socket.send(JSON.stringify({ op: 11, d: null }));
        if (packet.op === 2) {
          socket.send(JSON.stringify({
            op: 0,
            s: 1,
            t: "READY",
            d: {
              session_id: "transport-effects-session",
              resume_gateway_url: serverUrl(gateway),
              user: bot()
            }
          }));
        }
      });
      socket.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 250 } }));
    });

    const requests: Array<{
      readonly method: string;
      readonly path: string;
      readonly body?: unknown;
    }> = [];
    let nextMessageId = 900000000000000100n;
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bot ${TOKEN}`);
      let body: unknown;
      if (typeof init?.body === "string") body = JSON.parse(init.body) as unknown;
      if (init?.body instanceof FormData) {
        body = {
          payload: JSON.parse(String(init.body.get("payload_json"))) as unknown,
          fileName: (init.body.get("files[0]") as File).name
        };
      }
      requests.push({ method, path: url.pathname, ...(body === undefined ? {} : { body }) });
      if (method === "GET" && url.pathname.endsWith("/users/@me")) return json(bot());
      if (method === "POST" && url.pathname.endsWith("/users/@me/channels")) return json({ id: DM_ID, type: 1 });
      if (method === "GET" && url.pathname.endsWith("/gateway/bot")) return json({ url: serverUrl(gateway) });
      if (method === "POST" && url.pathname.endsWith(`/channels/${DM_ID}/typing`)) return empty();
      if ((method === "PUT" || method === "DELETE") && url.pathname.includes("/reactions/")) return empty();
      const edit = new RegExp(`/channels/${DM_ID}/messages/([1-9][0-9]{16,19})$`, "u").exec(url.pathname);
      if (method === "PATCH" && edit !== null) return json(message(edit[1]!));
      if (method === "POST" && url.pathname.endsWith(`/channels/${DM_ID}/messages`)) {
        nextMessageId += 1n;
        return json(message(String(nextMessageId)));
      }
      return json({ message: "missing fixture route" }, 404);
    }) as unknown as typeof globalThis.fetch;
    const transport = new DiscordTransport({
      token: TOKEN,
      connectionId: "discord-effects",
      generation: 1,
      ownerUserId: OWNER_ID,
      groupActivation: {},
      apiBaseUrl: "http://127.0.0.1:7777/api/v10/",
      fetch,
      gatewayRandom: () => 0
    });

    await transport.probe();
    const address = transport.ownerAddress();
    expect(address).toMatchObject({
      channel: "discord",
      providerConversationId: DM_ID,
      providerThreadId: null,
      conversationKind: "direct"
    });
    await transport.sendTextPart({ address, text: "reply", replyToMessageId: MESSAGE_ID });
    await transport.sendAttachments({
      address,
      attachments: [{
        kind: "file",
        bytes: new TextEncoder().encode("attachment"),
        fileName: "evidence.txt",
        mimeType: "text/plain"
      }]
    });
    const card = await transport.sendInteractionCard({
      address,
      text: "Choose one",
      buttons: Array.from({ length: 6 }, (_, index) => ({ label: `Choice ${index + 1}`, actionValue: `choice_${index + 1}` }))
    });
    await transport.clearInteractionCard({ address, messageId: card.providerMessageId });
    await transport.sendTyping(address);
    await transport.setReaction({ address, messageId: MESSAGE_ID, emoji: "✅" });
    await transport.setReaction({ address, messageId: MESSAGE_ID, emoji: null });
    await transport.close();

    expect(requests).toEqual(expect.arrayContaining([
      expect.objectContaining({
        method: "POST",
        path: `/api/v10/channels/${DM_ID}/messages`,
        body: expect.objectContaining({
          content: "reply",
          message_reference: { message_id: MESSAGE_ID, fail_if_not_exists: false }
        })
      }),
      expect.objectContaining({
        method: "POST",
        path: `/api/v10/channels/${DM_ID}/messages`,
        body: expect.objectContaining({ fileName: "evidence.txt" })
      }),
      expect.objectContaining({
        method: "POST",
        path: `/api/v10/channels/${DM_ID}/messages`,
        body: expect.objectContaining({
          embeds: [{ description: "Choose one" }],
          components: [
            expect.objectContaining({ components: expect.arrayContaining([expect.objectContaining({ custom_id: "choice_1" })]) }),
            expect.objectContaining({ components: [expect.objectContaining({ custom_id: "choice_6" })] })
          ]
        })
      }),
      expect.objectContaining({ method: "PATCH", path: expect.stringContaining(`/channels/${DM_ID}/messages/`) }),
      expect.objectContaining({ method: "POST", path: `/api/v10/channels/${DM_ID}/typing` }),
      expect.objectContaining({ method: "PUT", path: expect.stringContaining(`/channels/${DM_ID}/messages/${MESSAGE_ID}/reactions/`) }),
      expect.objectContaining({ method: "DELETE", path: expect.stringContaining(`/channels/${DM_ID}/messages/${MESSAGE_ID}/reactions/`) })
    ]));
  });
});

async function gatewayServer(): Promise<WebSocketServer> {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  servers.push(server);
  await once(server, "listening");
  return server;
}

function serverUrl(server: WebSocketServer): string {
  const address = server.address();
  if (typeof address === "string" || address === null) throw new Error("Missing server address.");
  return `ws://127.0.0.1:${address.port}`;
}

function parse(raw: RawData): { readonly op?: unknown } {
  return JSON.parse(raw.toString()) as { readonly op?: unknown };
}

function bot(): Readonly<Record<string, unknown>> {
  return { id: BOT_ID, username: "joko", global_name: "Joko", bot: true };
}

function message(id: string): Readonly<Record<string, unknown>> {
  return {
    id,
    channel_id: DM_ID,
    author: bot(),
    content: "",
    timestamp: new Date().toISOString(),
    attachments: [],
    mentions: []
  };
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function empty(): Response {
  return new Response(undefined, { status: 204 });
}
