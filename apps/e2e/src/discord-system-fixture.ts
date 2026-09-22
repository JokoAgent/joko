import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import WebSocket, { WebSocketServer, type RawData } from "ws";

export const DISCORD_SYSTEM_TOKEN = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcd";
export const DISCORD_SYSTEM_OWNER_ID = "111111111111111111";
export const DISCORD_SYSTEM_BOT_ID = "222222222222222222";
export const DISCORD_SYSTEM_DM_ID = "444444444444444444";
export const DISCORD_SYSTEM_GUILD_ID = "555555555555555555";
export const DISCORD_SYSTEM_ROOT_CHANNEL_ID = "666666666666666666";
export const DISCORD_SYSTEM_THREAD_ID = "777777777777777777";

export interface DiscordSystemOutboundMessage {
  readonly channelId: string;
  readonly text: string;
  readonly replyToMessageId?: string;
}

interface DiscordSystemAttachment {
  readonly id: string;
  readonly fileName: string;
  readonly bytes: Uint8Array;
  readonly mimeType: string;
}

interface DiscordSystemMessage {
  readonly id: string;
  readonly channel_id: string;
  readonly guild_id?: string;
  readonly author: Readonly<Record<string, unknown>>;
  readonly content: string;
  readonly timestamp: string;
  readonly attachments: readonly Readonly<Record<string, unknown>>[];
  readonly mentions: readonly Readonly<Record<string, unknown>>[];
}

/**
 * Independent loopback Discord REST + Gateway boundary used by the production
 * product-chain test. It intentionally shares no transport implementation with
 * @joko/messaging.
 */
export class DiscordSystemFixture {
  readonly baseUrl: string;
  readonly apiBaseUrl: string;
  readonly gatewayUrl: string;
  readonly outboundMessages: DiscordSystemOutboundMessage[] = [];
  readonly methods: string[] = [];
  readonly resumeSequences: number[] = [];
  readonly #server: Server;
  readonly #gateway: WebSocketServer;
  readonly #peers = new Set<WebSocket>();
  readonly #readyPeers = new Set<WebSocket>();
  readonly #attachments = new Map<string, DiscordSystemAttachment>();
  readonly #messages = new Map<string, DiscordSystemMessage>();
  #sequence = 0;
  #nextOutboundMessageId = 900000000000000100n;
  #closed = false;

  private constructor(server: Server, gateway: WebSocketServer, baseUrl: string) {
    this.#server = server;
    this.#gateway = gateway;
    this.baseUrl = baseUrl;
    this.apiBaseUrl = `${baseUrl}/api/v10/`;
    this.gatewayUrl = `${baseUrl.replace(/^http/u, "ws")}/gateway`;
  }

  static async start(): Promise<DiscordSystemFixture> {
    let fixture: DiscordSystemFixture | undefined;
    const gateway = new WebSocketServer({ noServer: true });
    const server = createServer((request, response) => {
      if (fixture !== undefined) void fixture.#handleHttp(request, response);
    });
    server.on("upgrade", (request, socket, head) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== "/gateway") {
        socket.destroy();
        return;
      }
      gateway.handleUpgrade(request, socket, head, (peer) => gateway.emit("connection", peer, request));
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    const address = server.address() as AddressInfo;
    fixture = new DiscordSystemFixture(server, gateway, `http://127.0.0.1:${address.port}`);
    gateway.on("connection", (peer) => {
      if (fixture !== undefined) fixture.#acceptGateway(peer);
    });
    return fixture;
  }

  addAttachment(input: {
    readonly id: string;
    readonly fileName: string;
    readonly bytes: Uint8Array;
    readonly mimeType: string;
  }): void {
    if (!/^[1-9][0-9]{16,19}$/u.test(input.id) || input.fileName.trim() === "") {
      throw new Error("Discord fixture attachment is invalid.");
    }
    this.#attachments.set(input.id, { ...input, bytes: input.bytes.slice() });
  }

  enqueueThreadMessage(input: {
    readonly messageId: string;
    readonly text: string;
    readonly attachmentId?: string;
  }): void {
    if (!/^[1-9][0-9]{16,19}$/u.test(input.messageId)) throw new Error("Discord fixture message ID is invalid.");
    const attachment = input.attachmentId === undefined ? undefined : this.#attachments.get(input.attachmentId);
    if (input.attachmentId !== undefined && attachment === undefined) {
      throw new Error("Discord fixture attachment is not registered.");
    }
    const message: DiscordSystemMessage = {
      id: input.messageId,
      channel_id: DISCORD_SYSTEM_THREAD_ID,
      guild_id: DISCORD_SYSTEM_GUILD_ID,
      author: owner(),
      content: input.text,
      timestamp: new Date().toISOString(),
      attachments: attachment === undefined ? [] : [{
        id: attachment.id,
        filename: attachment.fileName,
        content_type: attachment.mimeType,
        size: attachment.bytes.byteLength,
        url: `${this.baseUrl}/cdn/${attachment.id}`
      }],
      mentions: []
    };
    this.#messages.set(message.id, message);
    this.#dispatch("MESSAGE_CREATE", message);
  }

  forceGatewayReconnect(): void {
    for (const peer of [...this.#readyPeers]) peer.close(4000, "fixture reconnect");
  }

  methodCount(method: string): number {
    return this.methods.filter((candidate) => candidate === method).length;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    for (const peer of this.#peers) peer.terminate();
    this.#peers.clear();
    this.#readyPeers.clear();
    await new Promise<void>((resolve) => this.#gateway.close(() => resolve()));
    this.#server.closeIdleConnections();
    await new Promise<void>((resolve, reject) => {
      this.#server.close((error) => error === undefined ? resolve() : reject(error));
    });
    this.#server.closeAllConnections();
  }

  #acceptGateway(peer: WebSocket): void {
    this.#peers.add(peer);
    peer.on("message", (raw) => this.#handleGatewayPacket(peer, raw));
    peer.once("close", () => {
      this.#peers.delete(peer);
      this.#readyPeers.delete(peer);
    });
    peer.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 250 } }));
  }

  #handleGatewayPacket(peer: WebSocket, raw: RawData): void {
    const packet = JSON.parse(raw.toString()) as { readonly op?: unknown; readonly d?: unknown };
    if (packet.op === 1) {
      peer.send(JSON.stringify({ op: 11, d: null }));
      return;
    }
    if (packet.op === 2) {
      const identify = record(packet.d);
      if (identify["token"] !== DISCORD_SYSTEM_TOKEN) {
        peer.close(4004, "invalid token");
        return;
      }
      this.#readyPeers.add(peer);
      peer.send(JSON.stringify({
        op: 0,
        s: this.#nextSequence(),
        t: "READY",
        d: {
          session_id: "joko-discord-system-session",
          resume_gateway_url: this.gatewayUrl,
          user: bot()
        }
      }));
      return;
    }
    if (packet.op === 6) {
      const resume = record(packet.d);
      if (resume["token"] !== DISCORD_SYSTEM_TOKEN
        || resume["session_id"] !== "joko-discord-system-session"
        || typeof resume["seq"] !== "number") {
        peer.close(4007, "invalid sequence");
        return;
      }
      this.resumeSequences.push(resume["seq"]);
      this.#readyPeers.add(peer);
      peer.send(JSON.stringify({ op: 0, s: this.#nextSequence(), t: "RESUMED", d: {} }));
    }
  }

  #dispatch(eventType: string, data: unknown): void {
    if (this.#readyPeers.size === 0) throw new Error("Discord fixture has no ready Gateway peer.");
    const packet = JSON.stringify({ op: 0, s: this.#nextSequence(), t: eventType, d: data });
    for (const peer of this.#readyPeers) {
      if (peer.readyState === WebSocket.OPEN) peer.send(packet);
    }
  }

  #nextSequence(): number {
    this.#sequence += 1;
    return this.#sequence;
  }

  async #handleHttp(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const url = new URL(request.url ?? "/", this.baseUrl);
      const cdn = /^\/cdn\/([1-9][0-9]{16,19})$/u.exec(url.pathname);
      if (request.method === "GET" && cdn !== null) {
        const attachment = this.#attachments.get(cdn[1]!);
        if (attachment === undefined) return json(response, 404, { message: "missing attachment" });
        response.writeHead(200, {
          "content-type": attachment.mimeType,
          "content-length": String(attachment.bytes.byteLength),
          "cache-control": "no-store"
        });
        response.end(attachment.bytes);
        return;
      }

      if (!url.pathname.startsWith("/api/v10/")) return json(response, 404, { message: "unknown route" });
      if (request.headers.authorization !== `Bot ${DISCORD_SYSTEM_TOKEN}`) {
        return json(response, 401, { message: "invalid token" });
      }
      const path = url.pathname.slice("/api/v10/".length);
      this.methods.push(`${request.method ?? "GET"} ${path}`);

      if (request.method === "GET" && path === "users/@me") return json(response, 200, bot());
      if (request.method === "POST" && path === "users/@me/channels") {
        const body = await readJson(request);
        if (body["recipient_id"] !== DISCORD_SYSTEM_OWNER_ID) return json(response, 400, { message: "invalid owner" });
        return json(response, 200, { id: DISCORD_SYSTEM_DM_ID, type: 1 });
      }
      if (request.method === "GET" && path === "gateway/bot") {
        return json(response, 200, {
          url: this.gatewayUrl,
          shards: 1,
          session_start_limit: { total: 1_000, remaining: 999, reset_after: 1_000, max_concurrency: 1 }
        });
      }

      const channel = /^channels\/([1-9][0-9]{16,19})$/u.exec(path);
      if (request.method === "GET" && channel !== null) {
        if (channel[1] === DISCORD_SYSTEM_DM_ID) return json(response, 200, { id: DISCORD_SYSTEM_DM_ID, type: 1 });
        if (channel[1] === DISCORD_SYSTEM_ROOT_CHANNEL_ID) {
          return json(response, 200, { id: DISCORD_SYSTEM_ROOT_CHANNEL_ID, type: 0, guild_id: DISCORD_SYSTEM_GUILD_ID, name: "product-chain" });
        }
        if (channel[1] === DISCORD_SYSTEM_THREAD_ID) {
          return json(response, 200, {
            id: DISCORD_SYSTEM_THREAD_ID,
            type: 11,
            guild_id: DISCORD_SYSTEM_GUILD_ID,
            parent_id: DISCORD_SYSTEM_ROOT_CHANNEL_ID,
            name: "product-chain-thread"
          });
        }
        return json(response, 404, { message: "unknown channel" });
      }

      const getMessage = /^channels\/([1-9][0-9]{16,19})\/messages\/([1-9][0-9]{16,19})$/u.exec(path);
      if (request.method === "GET" && getMessage !== null) {
        const message = this.#messages.get(getMessage[2]!);
        return message === undefined ? json(response, 404, { message: "unknown message" }) : json(response, 200, message);
      }
      if (request.method === "PATCH" && getMessage !== null) {
        const existing = this.#messages.get(getMessage[2]!);
        return json(response, 200, existing ?? outboundMessage(getMessage[2]!, getMessage[1]!, ""));
      }

      const send = /^channels\/([1-9][0-9]{16,19})\/messages$/u.exec(path);
      if (request.method === "POST" && send !== null) {
        const body = await readJson(request);
        const content = typeof body["content"] === "string"
          ? body["content"]
          : recordArray(body["embeds"])[0]?.["description"] as string | undefined;
        if (typeof content !== "string") return json(response, 400, { message: "missing content" });
        const reference = optionalRecord(body["message_reference"]);
        const replyToMessageId = reference === undefined || typeof reference["message_id"] !== "string"
          ? undefined
          : reference["message_id"];
        this.outboundMessages.push({
          channelId: send[1]!,
          text: content,
          ...(replyToMessageId === undefined ? {} : { replyToMessageId })
        });
        this.#nextOutboundMessageId += 1n;
        return json(response, 200, outboundMessage(String(this.#nextOutboundMessageId), send[1]!, content));
      }

      if (request.method === "POST" && /^channels\/[1-9][0-9]{16,19}\/typing$/u.test(path)) {
        return empty(response);
      }
      if ((request.method === "PUT" || request.method === "DELETE")
        && /^channels\/[1-9][0-9]{16,19}\/messages\/[1-9][0-9]{16,19}\/reactions\/[^/]+\/@me$/u.test(path)) {
        return empty(response);
      }
      if (request.method === "POST"
        && /^interactions\/[1-9][0-9]{16,19}\/[A-Za-z0-9._-]{16,512}\/callback$/u.test(path)) {
        await readJson(request);
        return empty(response);
      }
      return json(response, 404, { message: "fixture route unavailable" });
    } catch {
      if (!response.headersSent) json(response, 500, { message: "fixture failure" });
      else response.destroy();
    }
  }
}

function bot(): Readonly<Record<string, unknown>> {
  return {
    id: DISCORD_SYSTEM_BOT_ID,
    username: "joko-system-bot",
    global_name: "Joko System Bot",
    discriminator: "0",
    bot: true
  };
}

function owner(): Readonly<Record<string, unknown>> {
  return {
    id: DISCORD_SYSTEM_OWNER_ID,
    username: "owner",
    global_name: "Owner",
    discriminator: "0",
    bot: false
  };
}

function outboundMessage(id: string, channelId: string, content: string): Readonly<Record<string, unknown>> {
  return {
    id,
    channel_id: channelId,
    author: bot(),
    content,
    timestamp: new Date().toISOString(),
    attachments: [],
    mentions: []
  };
}

async function readJson(request: IncomingMessage): Promise<Readonly<Record<string, unknown>>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    size += bytes.byteLength;
    if (size > 2 * 1024 * 1024) throw new Error("Discord fixture request is too large.");
    chunks.push(bytes);
  }
  if (chunks.length === 0) return {};
  return record(JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown);
}

function json(response: ServerResponse, status: number, body: unknown): void {
  const bytes = Buffer.from(JSON.stringify(body));
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(bytes.byteLength),
    "cache-control": "no-store"
  });
  response.end(bytes);
}

function empty(response: ServerResponse): void {
  response.writeHead(204, { "cache-control": "no-store" });
  response.end();
}

function record(value: unknown): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Discord fixture record is invalid.");
  return value as Readonly<Record<string, unknown>>;
}

function optionalRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value === undefined ? undefined : record(value);
}

function recordArray(value: unknown): readonly Readonly<Record<string, unknown>>[] {
  if (!Array.isArray(value)) return [];
  return value.map(record);
}
