import { once } from "node:events";

import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket, { WebSocketServer, type RawData } from "ws";

import { DiscordGatewayClient, decodeDiscordGatewayCursor } from "./gateway.js";
import type { DiscordInteraction } from "./model.js";

const TOKEN = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcd";
const BOT_ID = "222222222222222222";
const OWNER_ID = "111111111111111111";
const CHANNEL_ID = "444444444444444444";
const NOW = Date.UTC(2026, 8, 22, 12, 0, 0);
const servers: WebSocketServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe("DiscordGatewayClient", () => {
  it("identifies, heartbeats, defers interactions, and emits a resumable cursor without the token", async () => {
    const server = await gatewayServer();
    const messages: unknown[] = [];
    let peer: WebSocket | undefined;
    server.on("connection", (socket) => {
      peer = socket;
      socket.on("message", (raw) => {
        const value = parse(raw);
        messages.push(value);
        if (isPacket(value, 1)) socket.send(JSON.stringify({ op: 11, d: null }));
        if (isPacket(value, 2)) {
          socket.send(JSON.stringify({
            op: 0,
            s: 1,
            t: "READY",
            d: {
              session_id: "session-one",
              resume_gateway_url: serverUrl(server),
              user: { id: BOT_ID, username: "joko", bot: true }
            }
          }));
        }
      });
      socket.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 30 } }));
    });
    const acknowledgeInteraction = vi.fn(async (_interaction: DiscordInteraction) => undefined);
    const client = new DiscordGatewayClient({
      api: { acknowledgeInteraction },
      gatewayUrl: serverUrl(server),
      token: TOKEN,
      botUserId: BOT_ID,
      allowLoopback: true,
      random: () => 0
    });

    await client.connect();
    peer!.send(JSON.stringify({
      op: 0,
      s: 2,
      t: "INTERACTION_CREATE",
      d: {
        id: snowflake(NOW, 2),
        application_id: BOT_ID,
        type: 3,
        token: "interaction_token_abcdefghijklmnopqrstuvwxyz",
        data: { component_type: 2, custom_id: "act_allow" },
        channel_id: CHANNEL_ID,
        user: { id: OWNER_ID, username: "owner" },
        message: {
          id: snowflake(NOW - 1, 1),
          channel_id: CHANNEL_ID,
          author: { id: BOT_ID, username: "joko", bot: true },
          content: "Choose",
          timestamp: new Date(NOW).toISOString()
        }
      }
    }));
    const polled = await client.poll({ timeoutSeconds: 1 });

    expect(acknowledgeInteraction).toHaveBeenCalledTimes(1);
    expect(polled.dispatches).toHaveLength(1);
    expect(polled.dispatches[0]?.interaction).not.toHaveProperty("token");
    expect(decodeDiscordGatewayCursor(polled.nextCursor, true)).toMatchObject({
      sequence: 2,
      sessionId: "session-one"
    });
    await vi.waitFor(() => expect(messages.some((value) => isPacket(value, 1))).toBe(true));
    expect(messages.some((value) => isPacket(value, 2))).toBe(true);
    await client.close();
  });

  it("resumes from a durable cursor and maps authentication close codes", async () => {
    const server = await gatewayServer();
    const cursor = JSON.stringify({
      format: 1,
      sequence: 41,
      sessionId: "session-existing",
      resumeGatewayUrl: serverUrl(server)
    });
    let resume: unknown;
    server.on("connection", (socket) => {
      socket.on("message", (raw) => {
        const value = parse(raw);
        if (isPacket(value, 1)) socket.send(JSON.stringify({ op: 11, d: null }));
        if (isPacket(value, 6)) {
          resume = value;
          socket.send(JSON.stringify({ op: 0, s: 42, t: "RESUMED", d: {} }));
        }
      });
      socket.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 30 } }));
    });
    const client = new DiscordGatewayClient({
      api: { acknowledgeInteraction: async () => undefined },
      gatewayUrl: serverUrl(server),
      token: TOKEN,
      botUserId: BOT_ID,
      initialCursor: cursor,
      allowLoopback: true,
      random: () => 0
    });
    await client.connect();
    expect(resume).toMatchObject({ op: 6, d: { session_id: "session-existing", seq: 41, token: TOKEN } });
    expect(decodeDiscordGatewayCursor((await client.poll({ timeoutSeconds: 0 })).nextCursor, true)?.sequence).toBe(42);
    await client.close();

    const rejectedServer = await gatewayServer();
    rejectedServer.on("connection", (socket) => {
      socket.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 30 } }));
      socket.once("message", () => socket.close(4004, "bad token"));
    });
    const rejected = new DiscordGatewayClient({
      api: { acknowledgeInteraction: async () => undefined },
      gatewayUrl: serverUrl(rejectedServer),
      token: TOKEN,
      botUserId: BOT_ID,
      allowLoopback: true,
      random: () => 0
    });
    await expect(rejected.connect()).rejects.toMatchObject({
      code: "invalid_credential",
      options: { retryable: false }
    });
    await rejected.close();
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

function parse(raw: RawData): unknown {
  return JSON.parse(raw.toString()) as unknown;
}

function isPacket(value: unknown, op: number): value is { readonly op: number; readonly d?: unknown } {
  return typeof value === "object" && value !== null && "op" in value && (value as { readonly op?: unknown }).op === op;
}

function snowflake(timestamp: number, increment: number): string {
  return (((BigInt(timestamp) - 1_420_070_400_000n) << 22n) + BigInt(increment)).toString();
}
