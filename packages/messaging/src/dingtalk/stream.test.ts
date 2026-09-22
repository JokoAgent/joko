import { once } from "node:events";

import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer, type RawData } from "ws";

import { decodeDingTalkStreamCursor, DingTalkStreamClient } from "./stream.js";

const servers: WebSocketServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe("DingTalkStreamClient", () => {
  it("acknowledges callbacks before yielding them and advances a capability-free cursor", async () => {
    const server = await streamServer();
    const received: unknown[] = [];
    server.on("connection", (socket, request) => {
      expect(new URL(request.url!, serverUrl(server)).searchParams.get("ticket")).toBe("ticket-value");
      socket.on("message", (raw) => received.push(parse(raw)));
      socket.send(JSON.stringify({
        type: "CALLBACK",
        headers: {
          messageId: "callback-1",
          topic: "/v1.0/im/bot/messages/get",
          contentType: "application/json"
        },
        data: JSON.stringify({ msgId: "message-1" })
      }));
    });
    const client = new DingTalkStreamClient({
      api: { openGateway: async () => ({ endpoint: serverUrl(server), ticket: "ticket-value" }) },
      heartbeatIntervalMs: 100
    });

    await client.connect();
    const result = await client.poll({ timeoutSeconds: 1 });
    await vi.waitFor(() => expect(received).toHaveLength(1));

    expect(received[0]).toMatchObject({
      code: 200,
      headers: { messageId: "callback-1", contentType: "application/json" },
      message: "OK"
    });
    expect(result.updates).toEqual([{ callbackMessageId: "callback-1", payload: { msgId: "message-1" } }]);
    expect(decodeDingTalkStreamCursor(result.nextCursor)).toEqual({
      format: 1,
      lastCallbackMessageId: "callback-1"
    });
    expect(result.nextCursor).not.toContain("ticket-value");
    await client.close();
  });

  it("answers provider pings and reports disconnects as retryable", async () => {
    const server = await streamServer();
    const received: unknown[] = [];
    server.on("connection", (socket) => {
      socket.on("message", (raw) => received.push(parse(raw)));
      socket.send(JSON.stringify({
        type: "SYSTEM",
        headers: { messageId: "system-1", topic: "ping" },
        data: "heartbeat"
      }));
      setTimeout(() => socket.close(1012, "restart"), 25).unref?.();
    });
    const client = new DingTalkStreamClient({
      api: { openGateway: async () => ({ endpoint: serverUrl(server), ticket: "ticket-value" }) }
    });

    await client.connect();
    await vi.waitFor(() => expect(received).toEqual([
      expect.objectContaining({ code: 200, headers: expect.objectContaining({ topic: "ping" }), data: "heartbeat" })
    ]));
    await expect(client.poll({ timeoutSeconds: 1 })).rejects.toMatchObject({
      code: "network",
      options: { retryable: true, effect: "none" }
    });
    await client.close();
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

function parse(raw: RawData): unknown {
  return JSON.parse(raw.toString()) as unknown;
}
