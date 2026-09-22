import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import WebSocket, { WebSocketServer, type RawData } from "ws";

export const SLACK_SYSTEM_APP_TOKEN = "xapp-aaaaaaaaaaaaaaaaaaaa";
export const SLACK_SYSTEM_BOT_TOKEN = "xoxb-bbbbbbbbbbbbbbbbbbbb";
export const SLACK_SYSTEM_TEAM_ID = "T0123456789";
export const SLACK_SYSTEM_OWNER_ID = "U0123456789";
export const SLACK_SYSTEM_STRANGER_ID = "U2123456789";
export const SLACK_SYSTEM_BOT_USER_ID = "U1123456789";
export const SLACK_SYSTEM_BOT_ID = "B0123456789";
export const SLACK_SYSTEM_DM_ID = "D0123456789";
export const SLACK_SYSTEM_CHANNEL_ID = "C0123456789";
export const SLACK_SYSTEM_FILE_ID = "F0123456789";

export interface SlackSystemOutboundMessage {
  readonly channelId: string;
  readonly text: string;
  readonly threadTs: string | null;
}

interface SlackSystemAttachment {
  readonly id: string;
  readonly name: string;
  readonly mimeType: string;
  readonly bytes: Uint8Array;
}

interface PendingEnvelope {
  readonly id: string;
  readonly frame: string;
}

/** Independent loopback Socket Mode and Web API boundary for the real product-chain test. */
export class SlackSystemFixture {
  readonly baseUrl: string;
  readonly apiBaseUrl: string;
  readonly outboundMessages: SlackSystemOutboundMessage[] = [];
  readonly outboundMessageIds: string[] = [];
  readonly updatedMessages: { readonly channelId: string; readonly messageId: string; readonly text: string }[] = [];
  readonly acknowledgements: string[] = [];
  readonly methods: string[] = [];
  readonly reactions: { readonly method: string; readonly channel: string; readonly timestamp: string; readonly name: string }[] = [];
  onAcknowledge?: (envelopeId: string) => void;
  readonly #server: Server;
  readonly #gateway: WebSocketServer;
  readonly #peers = new Set<WebSocket>();
  readonly #pending: PendingEnvelope[] = [];
  readonly #attachments = new Map<string, SlackSystemAttachment>();
  #serial = 0;
  #closed = false;

  private constructor(server: Server, gateway: WebSocketServer, baseUrl: string) {
    this.#server = server;
    this.#gateway = gateway;
    this.baseUrl = baseUrl;
    this.apiBaseUrl = `${baseUrl}/api/`;
  }

  static async start(): Promise<SlackSystemFixture> {
    let fixture: SlackSystemFixture | undefined;
    const gateway = new WebSocketServer({ noServer: true });
    const server = createServer((request, response) => {
      if (fixture !== undefined) void fixture.#handleHttp(request, response);
    });
    server.on("upgrade", (request, socket, head) => {
      if (new URL(request.url ?? "/", "http://127.0.0.1").pathname !== "/socket") {
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
    fixture = new SlackSystemFixture(server, gateway, `http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    gateway.on("connection", (peer) => {
      if (fixture !== undefined) fixture.#accept(peer);
    });
    return fixture;
  }

  addAttachment(input: SlackSystemAttachment): void {
    this.#attachments.set(input.id, input);
  }

  enqueueMessage(input: {
    readonly channelId: string;
    readonly text: string;
    readonly threadTs?: string;
    readonly fileId?: string;
    readonly userId?: string;
  }): { readonly envelopeId: string; readonly ts: string } {
    const ts = this.timestamp();
    const envelopeId = `joko-slack-envelope-${this.#serial}`;
    const attachment = input.fileId === undefined ? undefined : this.#attachments.get(input.fileId);
    if (input.fileId !== undefined && attachment === undefined) throw new Error("Missing Slack fixture attachment.");
    const event = {
      type: "message",
      channel: input.channelId,
      user: input.userId ?? SLACK_SYSTEM_OWNER_ID,
      text: input.text,
      ts,
      ...(input.channelId === SLACK_SYSTEM_DM_ID ? { channel_type: "im" } : {}),
      ...(input.threadTs === undefined ? {} : { thread_ts: input.threadTs }),
      ...(attachment === undefined ? {} : {
        subtype: "file_share",
        files: [{ id: attachment.id, name: attachment.name, mimetype: attachment.mimeType, size: attachment.bytes.byteLength }]
      })
    };
    const frame = JSON.stringify({
      envelope_id: envelopeId,
      type: "events_api",
      accepts_response_payload: false,
      payload: {
        type: "event_callback",
        team_id: SLACK_SYSTEM_TEAM_ID,
        event_id: `Ev${this.#serial}`,
        event
      }
    });
    this.#pending.push({ id: envelopeId, frame });
    for (const peer of this.#peers) if (peer.readyState === WebSocket.OPEN) peer.send(frame);
    return { envelopeId, ts };
  }

  enqueueSlashCommand(command: string): string {
    this.#serial += 1;
    const envelopeId = `joko-slack-command-${this.#serial}`;
    const frame = JSON.stringify({
      envelope_id: envelopeId,
      type: "slash_commands",
      accepts_response_payload: false,
      payload: {
        command: "/joko",
        team_id: SLACK_SYSTEM_TEAM_ID,
        channel_id: SLACK_SYSTEM_DM_ID,
        user_id: SLACK_SYSTEM_OWNER_ID,
        text: command
      }
    });
    this.#pending.push({ id: envelopeId, frame });
    for (const peer of this.#peers) if (peer.readyState === WebSocket.OPEN) peer.send(frame);
    return envelopeId;
  }

  timestamp(): string {
    this.#serial += 1;
    return `${Math.floor(Date.now() / 1000)}.${String(this.#serial).padStart(6, "0")}`;
  }

  forceSocketReconnect(): void {
    for (const peer of this.#peers) peer.close(1000, "fixture reconnect");
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    for (const peer of this.#peers) peer.terminate();
    await new Promise<void>((resolve) => this.#gateway.close(() => resolve()));
    await new Promise<void>((resolve) => this.#server.close(() => resolve()));
  }

  #accept(peer: WebSocket): void {
    this.#peers.add(peer);
    peer.send(JSON.stringify({ type: "hello" }));
    for (const envelope of this.#pending) peer.send(envelope.frame);
    peer.on("message", (raw: RawData) => {
      let parsed: unknown;
      try { parsed = JSON.parse(raw.toString()); } catch { return; }
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return;
      const id = (parsed as Record<string, unknown>)["envelope_id"];
      if (typeof id !== "string") return;
      const index = this.#pending.findIndex((envelope) => envelope.id === id);
      if (index < 0) return;
      this.onAcknowledge?.(id);
      this.#pending.splice(index, 1);
      this.acknowledgements.push(id);
    });
    peer.on("close", () => this.#peers.delete(peer));
  }

  async #handleHttp(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const path = new URL(request.url ?? "/", this.baseUrl).pathname;
      const fileId = /^\/files\/([A-Z][A-Z0-9]{8,63})$/u.exec(path)?.[1];
      if (request.method === "GET" && fileId !== undefined) {
        const file = this.#attachments.get(fileId);
        if (file === undefined || request.headers.authorization !== `Bearer ${SLACK_SYSTEM_BOT_TOKEN}`) {
          return json(response, 404, { error: "file_not_found" });
        }
        response.writeHead(200, { "content-type": file.mimeType, "content-length": String(file.bytes.byteLength) });
        response.end(file.bytes);
        return;
      }
      if (request.method !== "POST" || !path.startsWith("/api/")) return json(response, 404, { ok: false, error: "unknown_method" });
      const method = path.slice("/api/".length);
      this.methods.push(method);
      const token = method === "apps.connections.open" ? SLACK_SYSTEM_APP_TOKEN : SLACK_SYSTEM_BOT_TOKEN;
      if (request.headers.authorization !== `Bearer ${token}`) return json(response, 401, { ok: false, error: "invalid_auth" });
      const body = await readJson(request);
      if (method === "auth.test") return json(response, 200, {
        ok: true, team_id: SLACK_SYSTEM_TEAM_ID, user_id: SLACK_SYSTEM_BOT_USER_ID,
        bot_id: SLACK_SYSTEM_BOT_ID, team: "Joko Slack fixture"
      });
      if (method === "conversations.open") {
        if (body["users"] !== SLACK_SYSTEM_OWNER_ID) return json(response, 200, { ok: false, error: "user_not_found" });
        return json(response, 200, { ok: true, channel: { id: SLACK_SYSTEM_DM_ID } });
      }
      if (method === "apps.connections.open") {
        return json(response, 200, { ok: true, url: `${this.baseUrl.replace(/^http/u, "ws")}/socket` });
      }
      if (method === "chat.postMessage") {
        const channel = body["channel"];
        if (typeof channel !== "string" || typeof body["text"] !== "string") return json(response, 200, { ok: false, error: "invalid_arguments" });
        this.outboundMessages.push({
          channelId: channel,
          text: body["text"],
          threadTs: typeof body["thread_ts"] === "string" ? body["thread_ts"] : null
        });
        const ts = this.timestamp();
        this.outboundMessageIds.push(ts);
        return json(response, 200, { ok: true, channel, ts });
      }
      if (method === "files.info") {
        const file = this.#attachments.get(String(body["file"]));
        return file === undefined
          ? json(response, 200, { ok: false, error: "file_not_found" })
          : json(response, 200, { ok: true, file: {
            id: file.id, name: file.name, mimetype: file.mimeType, size: file.bytes.byteLength,
            url_private_download: `${this.baseUrl}/files/${file.id}`
          } });
      }
      if (method === "reactions.add" || method === "reactions.remove") {
        this.reactions.push({ method, channel: String(body["channel"]), timestamp: String(body["timestamp"]), name: String(body["name"]) });
        return json(response, 200, { ok: true });
      }
      if (method === "chat.update") {
        this.updatedMessages.push({ channelId: String(body["channel"]), messageId: String(body["ts"]), text: String(body["text"]) });
        return json(response, 200, { ok: true, channel: body["channel"], ts: body["ts"] });
      }
      return json(response, 200, { ok: false, error: "unknown_method" });
    } catch {
      if (!response.headersSent) json(response, 500, { ok: false, error: "fixture_failure" });
      else response.destroy();
    }
  }
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
}

function json(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.writeHead(status, { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) });
  response.end(body);
}
