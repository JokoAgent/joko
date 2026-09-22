import { createCipheriv, createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { WeChatAuthorization, WeChatTransport, type WeChatFetch } from "@joko/messaging";

export const WECHAT_SYSTEM_TOKEN = "wechat-system-private-token";
export const WECHAT_SYSTEM_BOT_ID = "wechat-system-bot";
export const WECHAT_SYSTEM_OWNER_ID = "wechat-system-owner";
export const WECHAT_SYSTEM_PEER_ID = "wechat-system-peer";
export const WECHAT_SYSTEM_CONTEXT = "wechat-system-private-context";

type ProviderMessage = Readonly<Record<string, unknown>>;

/** Independent HTTP iLink fixture; the application still uses production API and transport code. */
export class WeChatSystemFixture {
  readonly baseUrl: string;
  readonly outbound: Array<Readonly<Record<string, unknown>>> = [];
  readonly paths: string[] = [];
  readonly requestedCursors: string[] = [];
  readonly createAuthorization: () => WeChatAuthorization;
  readonly createTransport: (options: ConstructorParameters<typeof WeChatTransport>[0]) => WeChatTransport;
  readonly #server: Server;
  readonly #messages: ProviderMessage[] = [];
  readonly #media = new Map<string, Buffer>();
  #closed = false;

  private constructor(server: Server, baseUrl: string) {
    this.#server = server;
    this.baseUrl = baseUrl;
    const fetch: WeChatFetch = (input, init) => {
      const upstream = new URL(String(input));
      const local = new URL(`${upstream.pathname}${upstream.search}`, this.baseUrl);
      return globalThis.fetch(local, init);
    };
    this.createAuthorization = () => new WeChatAuthorization({ fetch });
    this.createTransport = (options) => new WeChatTransport({ ...options, fetch, mediaFetch: fetch });
  }

  static async start(): Promise<WeChatSystemFixture> {
    let fixture: WeChatSystemFixture | undefined;
    const server = createServer((request, response) => {
      if (fixture !== undefined) void fixture.#handle(request, response);
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    fixture = new WeChatSystemFixture(server, `http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    return fixture;
  }

  enqueueDirectText(messageId: string, text: string, peerId = WECHAT_SYSTEM_PEER_ID): void {
    this.#messages.push({
      message_type: 1,
      client_id: messageId,
      from_user_id: peerId,
      to_user_id: WECHAT_SYSTEM_BOT_ID,
      create_time_ms: Date.now(),
      context_token: WECHAT_SYSTEM_CONTEXT,
      item_list: [{ type: 1, text_item: { text } }]
    });
  }

  enqueueDirectImage(messageId: string, text: string, bytes: Uint8Array): void {
    const key = Buffer.alloc(16, 7);
    const cipher = createCipheriv("aes-128-ecb", key, null);
    const ciphertext = Buffer.concat([cipher.update(bytes), cipher.final()]);
    this.#media.set(messageId, ciphertext);
    this.#messages.push({
      message_type: 1,
      client_id: messageId,
      from_user_id: WECHAT_SYSTEM_PEER_ID,
      to_user_id: WECHAT_SYSTEM_BOT_ID,
      create_time_ms: Date.now(),
      context_token: WECHAT_SYSTEM_CONTEXT,
      item_list: [
        { type: 1, text_item: { text } },
        {
          type: 2,
          image_item: {
            media: {
              full_url: `https://novac2c.cdn.weixin.qq.com/c2c/download?id=${messageId}`,
              aes_key: key.toString("base64"),
              file_size: bytes.byteLength,
              file_md5: createHash("md5").update(bytes).digest("hex")
            },
            mid_size: ciphertext.byteLength
          }
        }
      ]
    });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await new Promise<void>((resolve, reject) => this.#server.close((error) => error ? reject(error) : resolve()));
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const pathname = new URL(request.url ?? "/", this.baseUrl).pathname;
    this.paths.push(pathname);
    try {
      const body = await readJson(request);
      if (pathname === "/c2c/download") {
        const mediaId = new URL(request.url ?? "/", this.baseUrl).searchParams.get("id") ?? "";
        const media = this.#media.get(mediaId);
        if (media === undefined) { response.writeHead(404); response.end(); return; }
        response.writeHead(200, { "content-type": "application/octet-stream" });
        response.end(media);
        return;
      }
      if (pathname.endsWith("/get_bot_qrcode")) {
        respond(response, { ret: 0, qrcode: "wechat-qr-system", qrcode_img_content: "https://weixin.qq.com/x/qr-system" });
        return;
      }
      if (pathname.endsWith("/get_qrcode_status")) {
        respond(response, {
          status: "confirmed", bot_token: WECHAT_SYSTEM_TOKEN,
          ilink_bot_id: WECHAT_SYSTEM_BOT_ID, ilink_user_id: WECHAT_SYSTEM_OWNER_ID,
          baseurl: "https://ilinkai.weixin.qq.com/"
        });
        return;
      }
      if (pathname.endsWith("/getupdates")) {
        const cursor = typeof body["get_updates_buf"] === "string" ? body["get_updates_buf"] : "";
        this.requestedCursors.push(cursor);
        const index = cursor === "" ? 0 : Number(cursor);
        if (!Number.isSafeInteger(index) || index < 0 || index > this.#messages.length) {
          respond(response, { ret: 1, errmsg: "invalid cursor" });
          return;
        }
        if (index === this.#messages.length) await new Promise((resolve) => setTimeout(resolve, 50));
        const messages = this.#messages.slice(index);
        respond(response, { ret: 0, get_updates_buf: String(index + messages.length), msgs: messages });
        return;
      }
      if (pathname.endsWith("/sendmessage")) {
        if (isRecord(body["msg"])) this.outbound.push(body["msg"]);
        respond(response, { ret: 0 });
        return;
      }
      if (pathname.endsWith("/getconfig")) {
        respond(response, { ret: 0, typing_ticket: "wechat-system-typing-ticket" });
        return;
      }
      if (pathname.endsWith("/sendtyping") || pathname.endsWith("/notifystart")
        || pathname.endsWith("/notifystop")) {
        respond(response, { ret: 0 });
        return;
      }
      respond(response, { ret: 1, errmsg: "unknown fixture operation" }, 404);
    } catch {
      respond(response, { ret: 1, errmsg: "malformed fixture request" }, 400);
    }
  }
}

async function readJson(request: IncomingMessage): Promise<Readonly<Record<string, unknown>>> {
  if (request.method === "GET") return {};
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString("utf8");
  if (raw === "") return {};
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed)) throw new Error("Request body is not an object.");
  return parsed;
}

function respond(response: ServerResponse, body: Readonly<Record<string, unknown>>, status = 200): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
