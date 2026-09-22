import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import WebSocket, { WebSocketServer, type RawData } from "ws";

export const DINGTALK_SYSTEM_APP_KEY = "ding-system-app-key";
export const DINGTALK_SYSTEM_APP_SECRET = "ding-system-app-secret";
export const DINGTALK_SYSTEM_OWNER_ID = "ding-owner-1";
export const DINGTALK_SYSTEM_GROUP_ID = "cid-ding-approved-group";

const MODERN_TOKEN = "ding-system-modern-token";
const LEGACY_TOKEN = "ding-system-legacy-token";
const STREAM_TICKET = "ding-system-stream-ticket";
export const DINGTALK_SYSTEM_SESSION_CAPABILITY = "ding-session-capability-private";

export interface DingTalkSystemOutboundMessage {
  readonly target: string;
  readonly text: string;
  readonly messageId: string;
}

interface DingTalkSystemAttachment {
  readonly downloadCode: string;
  readonly fileName: string;
  readonly mimeType: string;
  readonly bytes: Uint8Array;
}

/**
 * Independent loopback DingTalk API + Stream boundary for the production
 * product-chain tests. It intentionally shares no parsing or transport code
 * with @joko/messaging.
 */
export class DingTalkSystemFixture {
  readonly baseUrl: string;
  readonly outboundMessages: DingTalkSystemOutboundMessage[] = [];
  readonly callbackAcknowledgements: string[] = [];
  readonly methods: string[] = [];
  readonly #server: Server;
  readonly #stream: WebSocketServer;
  readonly #peers = new Set<WebSocket>();
  readonly #attachments = new Map<string, DingTalkSystemAttachment>();
  #nextOutbound = 1;
  #nextSystem = 1;
  #streamConnections = 0;
  #closed = false;

  private constructor(server: Server, stream: WebSocketServer, baseUrl: string) {
    this.#server = server;
    this.#stream = stream;
    this.baseUrl = baseUrl;
  }

  get streamConnections(): number {
    return this.#streamConnections;
  }

  static async start(): Promise<DingTalkSystemFixture> {
    let fixture: DingTalkSystemFixture | undefined;
    const stream = new WebSocketServer({ noServer: true });
    const server = createServer((request, response) => {
      if (fixture !== undefined) void fixture.#handleHttp(request, response);
    });
    server.on("upgrade", (request, socket, head) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== "/stream" || url.searchParams.get("ticket") !== STREAM_TICKET) {
        socket.destroy();
        return;
      }
      stream.handleUpgrade(request, socket, head, (peer) => stream.emit("connection", peer, request));
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    const address = server.address() as AddressInfo;
    fixture = new DingTalkSystemFixture(server, stream, `http://127.0.0.1:${address.port}`);
    stream.on("connection", (peer) => {
      if (fixture !== undefined) fixture.#acceptStream(peer);
    });
    return fixture;
  }

  addAttachment(input: {
    readonly downloadCode: string;
    readonly fileName: string;
    readonly mimeType: string;
    readonly bytes: Uint8Array;
  }): void {
    if (input.downloadCode.trim() === "" || input.fileName.trim() === "" || input.bytes.byteLength === 0) {
      throw new Error("DingTalk fixture attachment is invalid.");
    }
    this.#attachments.set(input.downloadCode, { ...input, bytes: input.bytes.slice() });
  }

  enqueueDirectRichText(input: {
    readonly callbackMessageId: string;
    readonly messageId: string;
    readonly text: string;
    readonly downloadCode: string;
  }): void {
    const attachment = this.#attachments.get(input.downloadCode);
    if (attachment === undefined) throw new Error("DingTalk fixture attachment is not registered.");
    this.#dispatch(input.callbackMessageId, {
      ...this.#messageBase(input.messageId, DINGTALK_SYSTEM_OWNER_ID, `direct-${DINGTALK_SYSTEM_OWNER_ID}`, "1"),
      msgtype: "richText",
      content: {
        richText: [
          { text: input.text },
          {
            type: "file",
            downloadCode: attachment.downloadCode,
            fileName: attachment.fileName,
            fileType: attachment.mimeType,
            fileSize: attachment.bytes.byteLength
          }
        ]
      }
    });
  }

  enqueueGroupText(input: {
    readonly callbackMessageId: string;
    readonly messageId: string;
    readonly text: string;
  }): void {
    this.#dispatch(input.callbackMessageId, {
      ...this.#messageBase(input.messageId, DINGTALK_SYSTEM_OWNER_ID, DINGTALK_SYSTEM_GROUP_ID, "2"),
      msgtype: "text",
      text: { content: input.text }
    });
  }

  enqueueDirectText(input: {
    readonly callbackMessageId: string;
    readonly messageId: string;
    readonly text: string;
  }): void {
    this.#dispatch(input.callbackMessageId, {
      ...this.#messageBase(input.messageId, DINGTALK_SYSTEM_OWNER_ID, `direct-${DINGTALK_SYSTEM_OWNER_ID}`, "1"),
      msgtype: "text",
      text: { content: input.text }
    });
  }

  forceStreamReconnect(): void {
    if (this.#peers.size === 0) throw new Error("DingTalk fixture has no Stream peer.");
    const messageId = `system-disconnect-${this.#nextSystem++}`;
    for (const peer of this.#peers) {
      if (peer.readyState !== WebSocket.OPEN) continue;
      peer.send(JSON.stringify({
        type: "SYSTEM",
        headers: { messageId, topic: "disconnect" },
        data: "reconnect"
      }));
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    for (const peer of this.#peers) peer.terminate();
    this.#peers.clear();
    await new Promise<void>((resolve) => this.#stream.close(() => resolve()));
    this.#server.closeIdleConnections();
    await new Promise<void>((resolve, reject) => {
      this.#server.close((error) => error === undefined ? resolve() : reject(error));
    });
    this.#server.closeAllConnections();
  }

  #acceptStream(peer: WebSocket): void {
    this.#streamConnections += 1;
    this.#peers.add(peer);
    peer.on("message", (raw) => this.#handleStreamMessage(raw));
    peer.once("close", () => this.#peers.delete(peer));
  }

  #handleStreamMessage(raw: RawData): void {
    let value: unknown;
    try {
      value = JSON.parse(raw.toString()) as unknown;
    } catch {
      return;
    }
    if (!isRecord(value) || value["code"] !== 200 || !isRecord(value["headers"])) return;
    const messageId = value["headers"]["messageId"];
    if (typeof messageId === "string") this.callbackAcknowledgements.push(messageId);
  }

  #dispatch(callbackMessageId: string, payload: Readonly<Record<string, unknown>>): void {
    const open = [...this.#peers].filter((peer) => peer.readyState === WebSocket.OPEN);
    if (open.length === 0) throw new Error("DingTalk fixture has no open Stream peer.");
    const envelope = JSON.stringify({
      type: "CALLBACK",
      headers: {
        messageId: callbackMessageId,
        topic: "/v1.0/im/bot/messages/get",
        contentType: "application/json"
      },
      data: JSON.stringify(payload)
    });
    for (const peer of open) peer.send(envelope);
  }

  #messageBase(
    messageId: string,
    senderId: string,
    conversationId: string,
    conversationType: "1" | "2"
  ): Readonly<Record<string, unknown>> {
    const target = conversationType === "1" ? senderId : conversationId;
    return {
      conversationId,
      conversationType,
      msgId: messageId,
      robotCode: DINGTALK_SYSTEM_APP_KEY,
      senderStaffId: senderId,
      senderNick: "DingTalk E2 owner",
      createAt: Date.now(),
      sessionWebhook: `${this.baseUrl}/session/${encodeURIComponent(target)}?cap=${DINGTALK_SYSTEM_SESSION_CAPABILITY}`,
      sessionWebhookExpiredTime: Date.now() + 60 * 60_000
    };
  }

  async #handleHttp(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const url = new URL(request.url ?? "/", this.baseUrl);
      this.methods.push(`${request.method ?? "GET"} ${url.pathname}`);

      const mediaMatch = /^\/media\/([^/]+)$/u.exec(url.pathname);
      if (request.method === "GET" && mediaMatch !== null) {
        const attachment = this.#attachments.get(decodeURIComponent(mediaMatch[1]!));
        if (attachment === undefined) return json(response, 404, { code: "NotFound" });
        response.writeHead(200, {
          "content-type": attachment.mimeType,
          "content-length": String(attachment.bytes.byteLength),
          "cache-control": "no-store"
        });
        response.end(attachment.bytes);
        return;
      }

      if (request.method === "POST" && url.pathname === "/v1.0/oauth2/accessToken") {
        const body = await readJson(request);
        if (body["appKey"] !== DINGTALK_SYSTEM_APP_KEY || body["appSecret"] !== DINGTALK_SYSTEM_APP_SECRET) {
          return json(response, 401, { code: "InvalidCredential" });
        }
        return json(response, 200, { accessToken: MODERN_TOKEN, expireIn: 7_200 });
      }

      if (request.method === "POST" && url.pathname === "/v1.0/gateway/connections/open") {
        const body = await readJson(request);
        if (body["clientId"] !== DINGTALK_SYSTEM_APP_KEY || body["clientSecret"] !== DINGTALK_SYSTEM_APP_SECRET) {
          return json(response, 401, { code: "InvalidCredential" });
        }
        return json(response, 200, {
          endpoint: `${this.baseUrl.replace(/^http/u, "ws")}/stream`,
          ticket: STREAM_TICKET
        });
      }

      if (request.method === "POST" && url.pathname === "/v1.0/robot/messageFiles/download") {
        if (request.headers["x-acs-dingtalk-access-token"] !== MODERN_TOKEN) {
          return json(response, 401, { code: "InvalidToken" });
        }
        const body = await readJson(request);
        const downloadCode = typeof body["downloadCode"] === "string" ? body["downloadCode"] : "";
        if (body["robotCode"] !== DINGTALK_SYSTEM_APP_KEY || !this.#attachments.has(downloadCode)) {
          return json(response, 404, { code: "NotFound" });
        }
        return json(response, 200, {
          downloadUrl: `${this.baseUrl}/media/${encodeURIComponent(downloadCode)}`
        });
      }

      const session = /^\/session\/([^/]+)$/u.exec(url.pathname);
      if (request.method === "POST" && session !== null) {
        if (url.searchParams.get("cap") !== DINGTALK_SYSTEM_SESSION_CAPABILITY) {
          return json(response, 403, { code: "InvalidSession" });
        }
        const body = await readJson(request);
        const text = nestedText(body);
        const messageId = `ding-outbound-${this.#nextOutbound++}`;
        this.outboundMessages.push({ target: decodeURIComponent(session[1]!), text, messageId });
        return json(response, 200, { processQueryKey: messageId });
      }

      if (request.method === "POST" && (
        url.pathname === "/v1.0/robot/oToMessages/batchSend"
        || url.pathname === "/v1.0/robot/groupMessages/send"
      )) {
        if (request.headers["x-acs-dingtalk-access-token"] !== MODERN_TOKEN) {
          return json(response, 401, { code: "InvalidToken" });
        }
        const body = await readJson(request);
        const parameter = typeof body["msgParam"] === "string"
          ? record(JSON.parse(body["msgParam"] as string) as unknown)
          : {};
        const target = url.pathname.includes("groupMessages")
          ? stringValue(body["openConversationId"])
          : stringValue(Array.isArray(body["userIds"]) ? body["userIds"][0] : undefined);
        const messageId = `ding-outbound-${this.#nextOutbound++}`;
        this.outboundMessages.push({ target, text: stringValue(parameter["content"]), messageId });
        return json(response, 200, { processQueryKey: messageId });
      }

      if (request.method === "GET" && url.pathname === "/gettoken") {
        if (url.searchParams.get("appkey") !== DINGTALK_SYSTEM_APP_KEY
          || url.searchParams.get("appsecret") !== DINGTALK_SYSTEM_APP_SECRET) {
          return json(response, 401, { errcode: 40014 });
        }
        return json(response, 200, { errcode: 0, access_token: LEGACY_TOKEN, expires_in: 7_200 });
      }

      return json(response, 404, { code: "NotFound" });
    } catch {
      if (!response.headersSent) json(response, 500, { code: "FixtureFailure" });
      else response.destroy();
    }
  }
}

function nestedText(body: Readonly<Record<string, unknown>>): string {
  const text = body["text"];
  return isRecord(text) ? stringValue(text["content"]) : "";
}

async function readJson(request: IncomingMessage): Promise<Readonly<Record<string, unknown>>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    size += bytes.byteLength;
    if (size > 2 * 1024 * 1024) throw new Error("DingTalk fixture request is too large.");
    chunks.push(bytes);
  }
  return chunks.length === 0 ? {} : record(JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown);
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

function record(value: unknown): Readonly<Record<string, unknown>> {
  if (!isRecord(value)) throw new Error("DingTalk fixture record is invalid.");
  return value;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}
