import { once } from "node:events";

import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket, { WebSocketServer, type RawData } from "ws";

import { SlackTransport } from "./transport.js";

const APP_TOKEN = "xapp-1234567890-abcdefghi";
const BOT_TOKEN = "xoxb-1234567890-abcdefghi";
const TEAM = "T12345678";
const BOT = "U22222222";
const OWNER = "U12345678";
const DM = "D12345678";
const CHANNEL = "C12345678";
const servers: WebSocketServer[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(servers.splice(0).map(async (server) => {
    for (const client of server.clients) client.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }));
});

describe("SlackTransport direct Socket Mode", () => {
  it("probes both credentials, holds one envelope until durable ACK, and posts bounded thread/card/reactions", async () => {
    const server = await socketServer();
    const sockets: WebSocket[] = [];
    const acknowledgements: unknown[] = [];
    server.on("connection", (socket) => {
      sockets.push(socket);
      socket.on("message", (raw) => acknowledgements.push(JSON.parse(raw.toString()) as unknown));
      socket.send(JSON.stringify({ type: "hello", connection_info: { app_id: "A12345678" } }));
    });
    const posted: Array<{ method: string; body: Record<string, unknown> }> = [];
    let nextTs = 1770000000;
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const method = new URL(String(input)).pathname.split("/").at(-1)!;
      const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : {};
      posted.push({ method, body });
      if (method === "auth.test") return json({ ok: true, team_id: TEAM, user_id: BOT, bot_id: "B22222222", team: "Workspace" });
      if (method === "conversations.open") return json({ ok: true, channel: { id: DM } });
      if (method === "apps.connections.open") return json({ ok: true, url: `ws://127.0.0.1:${port(server)}/link?ticket=test` });
      if (method === "chat.postMessage") {
        nextTs += 1;
        return json({ ok: true, channel: body.channel, ts: `${nextTs}.000001` });
      }
      if (method === "chat.update") return json({ ok: true, channel: body.channel, ts: body.ts });
      if (method === "reactions.add" || method === "reactions.remove") return json({ ok: true });
      return json({ ok: false, error: "unknown_method" });
    }) as typeof globalThis.fetch;
    const transport = new SlackTransport({
      appToken: APP_TOKEN, botToken: BOT_TOKEN,
      connectionId: "slack-direct", generation: 1, ownerUserId: OWNER,
      groupActivation: { [CHANNEL]: "mention" },
      apiBaseUrl: `http://127.0.0.1:${port(server)}/api/`, fetch
    });
    try {
      expect(await transport.probe()).toMatchObject({ channel: "slack", providerAccountId: TEAM, ownerConversationId: DM });
      expect(transport.ownerAddress()).toMatchObject({ providerConversationId: `${TEAM}/${DM}`, conversationKind: "direct" });
      const ts = `${Math.floor(Date.now() / 1_000)}.000100`;
      sockets[0]!.send(JSON.stringify({
        type: "events_api", envelope_id: "envelope-1", accepts_response_payload: false,
        payload: { type: "event_callback", team_id: TEAM, event_id: "Ev12345678", event: { type: "message", channel: DM, user: OWNER, text: "do it", ts, channel_type: "im" } }
      }));
      const result = await transport.poll({ cursor: null, timeoutSeconds: 2 });
      expect(result).toMatchObject({ envelopeId: "envelope-1", nextCursor: "slack:envelope-1" });
      expect(transport.normalize(result.updates).events).toMatchObject([{ kind: "message", text: "do it" }]);
      expect(acknowledgements).toHaveLength(0);
      expect((await transport.poll({ cursor: null, timeoutSeconds: 0 })).envelopeId).toBe("envelope-1");
      const receivedAck = once(sockets[0]!, "message");
      await transport.acknowledge("envelope-1");
      await receivedAck;
      await transport.acknowledge("envelope-1");
      expect(acknowledgements).toEqual([{ envelope_id: "envelope-1" }]);
      const address = {
        channel: "slack" as const, connectionId: "slack-direct", providerConversationId: `${TEAM}/${CHANNEL}`,
        providerThreadId: ts, conversationKind: "channel" as const
      };
      await transport.sendTextPart({ address, text: "look <@U99999999> & act", replyToMessageId: "1770000000.000777" });
      const ownerAddress = transport.ownerAddress();
      await transport.sendTextPart({ address: ownerAddress, text: "direct reply", replyToMessageId: ts });
      await transport.sendTextPart({ address: ownerAddress, text: "command result", replyToMessageId: "slack:command:envelope-2" });
      await transport.editTextPart({ address, messageId: ts, text: "progress <safe>" });
      const card = await transport.sendInteractionCard({ address, text: "Choose", buttons: [{ label: "Allow", actionValue: "allow_nonce" }] });
      await transport.clearInteractionCard({ address, messageId: card.providerMessageId });
      await transport.setReaction({ address, messageId: ts, emoji: "👀" });
      await transport.setReaction({ address, messageId: ts, emoji: null });
      await transport.setReaction({ address, messageId: ts, emoji: "👎" });
      await transport.sendTyping(address);
      expect(posted.find((call) => call.method === "chat.postMessage")?.body).toMatchObject({
        channel: CHANNEL, thread_ts: ts, text: "look &lt;@U99999999&gt; &amp; act"
      });
      expect(posted.filter((call) => call.method === "chat.postMessage")[1]?.body).toMatchObject({
        channel: DM, thread_ts: ts, text: "direct reply"
      });
      expect(posted.filter((call) => call.method === "chat.postMessage")[2]?.body).not.toHaveProperty("thread_ts");
      expect(posted.filter((call) => call.method === "chat.postMessage")[3]?.body).toMatchObject({
        blocks: [expect.anything(), { type: "actions", elements: [{ action_id: "allow_nonce", value: "allow_nonce" }] }]
      });
      expect(posted.find((call) => call.method === "reactions.add")?.body).toMatchObject({ name: "eyes", channel: CHANNEL, timestamp: ts });
      expect(posted.find((call) => call.method === "reactions.remove")?.body).toMatchObject({ name: "eyes", channel: CHANNEL, timestamp: ts });
      expect(posted.filter((call) => call.method === "reactions.add")[1]?.body).toMatchObject({ name: "-1", channel: CHANNEL, timestamp: ts });
      expect(posted.find((call) => call.method === "chat.update")?.body).toMatchObject({ channel: CHANNEL, ts, text: "progress &lt;safe&gt;" });
    } finally { await transport.close(); }
  });

  it("reopens a new Socket URL after refresh and retires disabled connections", async () => {
    const server = await socketServer();
    const sockets: WebSocket[] = [];
    server.on("connection", (socket) => { sockets.push(socket); socket.send(JSON.stringify({ type: "hello" })); });
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const method = new URL(String(input)).pathname.split("/").at(-1)!;
      if (method === "auth.test") return json({ ok: true, team_id: TEAM, user_id: BOT, bot_id: "B22222222", team: "Workspace" });
      if (method === "conversations.open") return json({ ok: true, channel: { id: DM } });
      if (method === "apps.connections.open") return json({ ok: true, url: `ws://127.0.0.1:${port(server)}/link?ticket=test` });
      return json({ ok: false, error: "unknown_method" });
    }) as typeof globalThis.fetch;
    const transport = new SlackTransport({
      appToken: APP_TOKEN, botToken: BOT_TOKEN,
      connectionId: "slack-reconnect", generation: 1, ownerUserId: OWNER, groupActivation: {},
      apiBaseUrl: `http://127.0.0.1:${port(server)}/api/`, fetch
    });
    try {
      await transport.probe();
      sockets[0]!.send(JSON.stringify({
        type: "events_api", envelope_id: "lost-before-ack", payload: { type: "event_callback", team_id: TEAM }
      }));
      expect((await transport.poll({ cursor: null, timeoutSeconds: 2 })).envelopeId).toBe("lost-before-ack");
      const closed = once(sockets[0]!, "close");
      sockets[0]!.send(JSON.stringify({ type: "disconnect", reason: "refresh_requested" }));
      await closed;
      expect((await transport.poll({ cursor: null, timeoutSeconds: 0 })).envelopeId).toBeNull();
      expect(sockets).toHaveLength(2);
      sockets[1]!.send(JSON.stringify({ type: "disconnect", reason: "link_disabled" }));
      await once(sockets[1]!, "close");
      await expect(transport.poll({ cursor: null, timeoutSeconds: 0 })).rejects.toMatchObject({ code: "invalid_credential" });
    } finally { await transport.close(); }
  });
});

function json(value: unknown): Response { return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } }); }
async function socketServer(): Promise<WebSocketServer> {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  servers.push(server);
  await once(server, "listening");
  return server;
}
function port(server: WebSocketServer): number {
  const address = server.address();
  if (typeof address === "string" || address === null) throw new Error("Socket fixture has no TCP address.");
  return address.port;
}
