import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export const TELEGRAM_SYSTEM_TOKEN = "123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcd";
export const TELEGRAM_SYSTEM_OWNER_ID = 42;

export interface TelegramSystemOutboundMessage {
  readonly chatId: number;
  readonly text: string;
  readonly replyToMessageId?: number;
}

interface TelegramSystemFile {
  readonly fileId: string;
  readonly path: string;
  readonly bytes: Uint8Array;
  readonly mimeType: string;
}

interface TelegramSystemUpdate {
  readonly update_id: number;
  readonly message: Readonly<Record<string, unknown>>;
}

/**
 * A real loopback HTTP boundary implementing only the Bot API surface owned by
 * the Messaging product-chain tests. It deliberately does not share transport
 * implementation code with @joko/messaging.
 */
export class TelegramSystemFixture {
  readonly baseUrl: string;
  readonly outboundMessages: TelegramSystemOutboundMessage[] = [];
  readonly methods: string[] = [];
  readonly #server: Server;
  readonly #updates: TelegramSystemUpdate[] = [];
  readonly #files = new Map<string, TelegramSystemFile>();
  readonly #pollFailures: Array<{ readonly status: number; readonly body: Readonly<Record<string, unknown>> }> = [];
  #nextMessageId = 900;
  #closed = false;

  private constructor(server: Server, baseUrl: string) {
    this.#server = server;
    this.baseUrl = baseUrl;
  }

  static async start(): Promise<TelegramSystemFixture> {
    let fixture: TelegramSystemFixture | undefined;
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
    const address = server.address() as AddressInfo;
    fixture = new TelegramSystemFixture(server, `http://127.0.0.1:${address.port}`);
    return fixture;
  }

  addFile(input: {
    readonly fileId: string;
    readonly path: string;
    readonly bytes: Uint8Array;
    readonly mimeType: string;
  }): void {
    if (!/^[A-Za-z0-9._/-]+$/u.test(input.path) || input.path.startsWith("/")) {
      throw new Error("Telegram fixture file path is invalid.");
    }
    this.#files.set(input.fileId, { ...input, bytes: input.bytes.slice() });
  }

  enqueueDirectMessage(input: {
    readonly updateId: number;
    readonly messageId: number;
    readonly text: string;
    readonly fileId?: string;
    readonly fileName?: string;
    readonly mimeType?: string;
  }): void {
    const file = input.fileId === undefined ? undefined : this.#files.get(input.fileId);
    if (input.fileId !== undefined && file === undefined) throw new Error("Telegram fixture file is not registered.");
    this.#updates.push({
      update_id: input.updateId,
      message: {
        message_id: input.messageId,
        from: {
          id: TELEGRAM_SYSTEM_OWNER_ID,
          is_bot: false,
          first_name: "Owner",
          username: "owner"
        },
        chat: { id: TELEGRAM_SYSTEM_OWNER_ID, type: "private", first_name: "Owner" },
        date: Math.floor(Date.now() / 1_000),
        text: input.text,
        ...(file === undefined ? {} : {
          document: {
            file_id: file.fileId,
            file_unique_id: `${file.fileId}-unique`,
            file_name: input.fileName ?? file.path.split("/").at(-1) ?? "attachment.bin",
            mime_type: input.mimeType ?? file.mimeType,
            file_size: file.bytes.byteLength
          }
        })
      }
    });
    this.#updates.sort((left, right) => left.update_id - right.update_id);
  }

  failNextPollWithConflict(): void {
    this.#pollFailures.push({
      status: 409,
      body: {
        ok: false,
        error_code: 409,
        description: "Conflict: terminated by another getUpdates request"
      }
    });
  }

  methodCount(method: string): number {
    return this.methods.filter((candidate) => candidate === method).length;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#server.closeIdleConnections();
    await new Promise<void>((resolve, reject) => {
      this.#server.close((error) => error === undefined ? resolve() : reject(error));
    });
    this.#server.closeAllConnections();
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const url = new URL(request.url ?? "/", this.baseUrl);
      const filePrefix = `/file/bot${TELEGRAM_SYSTEM_TOKEN}/`;
      if (request.method === "GET" && url.pathname.startsWith(filePrefix)) {
        const path = decodeURIComponent(url.pathname.slice(filePrefix.length));
        const file = [...this.#files.values()].find((candidate) => candidate.path === path);
        if (file === undefined) return json(response, 404, { ok: false, error_code: 404 });
        response.writeHead(200, {
          "content-type": file.mimeType,
          "content-length": String(file.bytes.byteLength),
          "cache-control": "no-store"
        });
        response.end(file.bytes);
        return;
      }

      const methodPrefix = `/bot${TELEGRAM_SYSTEM_TOKEN}/`;
      if (request.method !== "POST" || !url.pathname.startsWith(methodPrefix)) {
        return json(response, 404, { ok: false, error_code: 404 });
      }
      const method = url.pathname.slice(methodPrefix.length);
      this.methods.push(method);
      const body = await readJson(request);
      if (method === "getMe") {
        return json(response, 200, {
          ok: true,
          result: { id: 700, is_bot: true, first_name: "Joko", username: "joko_system_bot" }
        });
      }
      if (method === "getUpdates") {
        const failure = this.#pollFailures.shift();
        if (failure !== undefined) return json(response, failure.status, failure.body);
        const offset = typeof body["offset"] === "number" ? body["offset"] : 0;
        const updates = this.#updates.filter((update) => update.update_id >= offset);
        if (updates.length === 0) await delay(25);
        return json(response, 200, { ok: true, result: updates });
      }
      if (method === "getFile") {
        const fileId = typeof body["file_id"] === "string" ? body["file_id"] : "";
        const file = this.#files.get(fileId);
        if (file === undefined) return json(response, 400, { ok: false, error_code: 400 });
        return json(response, 200, {
          ok: true,
          result: { file_id: file.fileId, file_size: file.bytes.byteLength, file_path: file.path }
        });
      }
      if (method === "sendMessage") {
        const chatId = numberField(body, "chat_id");
        const text = stringField(body, "text");
        const reply = recordField(body, "reply_parameters");
        const replyToMessageId = reply === undefined ? undefined : numberField(reply, "message_id");
        this.outboundMessages.push({
          chatId,
          text,
          ...(replyToMessageId === undefined ? {} : { replyToMessageId })
        });
        this.#nextMessageId += 1;
        return json(response, 200, {
          ok: true,
          result: {
            message_id: this.#nextMessageId,
            from: { id: 700, is_bot: true, first_name: "Joko", username: "joko_system_bot" },
            chat: { id: chatId, type: "private" },
            date: Math.floor(Date.now() / 1_000),
            text
          }
        });
      }
      if (method === "sendChatAction" || method === "setMessageReaction" || method === "answerCallbackQuery") {
        return json(response, 200, { ok: true, result: true });
      }
      if (method === "editMessageReplyMarkup") {
        this.#nextMessageId += 1;
        return json(response, 200, {
          ok: true,
          result: {
            message_id: numberField(body, "message_id"),
            chat: { id: numberField(body, "chat_id"), type: "private" },
            date: Math.floor(Date.now() / 1_000)
          }
        });
      }
      return json(response, 404, { ok: false, error_code: 404, description: "fixture method unavailable" });
    } catch {
      if (!response.headersSent) json(response, 500, { ok: false, error_code: 500 });
      else response.destroy();
    }
  }
}

async function readJson(request: IncomingMessage): Promise<Readonly<Record<string, unknown>>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    size += bytes.byteLength;
    if (size > 2 * 1024 * 1024) throw new Error("Telegram fixture request is too large.");
    chunks.push(bytes);
  }
  if (chunks.length === 0) return {};
  const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Telegram fixture request body is invalid.");
  }
  return parsed as Readonly<Record<string, unknown>>;
}

function json(response: ServerResponse, status: number, body: Readonly<Record<string, unknown>>): void {
  const bytes = Buffer.from(JSON.stringify(body));
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(bytes.byteLength),
    "cache-control": "no-store"
  });
  response.end(bytes);
}

function stringField(value: Readonly<Record<string, unknown>>, key: string): string {
  const field = value[key];
  if (typeof field !== "string") throw new Error(`Telegram fixture ${key} is invalid.`);
  return field;
}

function numberField(value: Readonly<Record<string, unknown>>, key: string): number;
function numberField(value: Readonly<Record<string, unknown>>, key: string): number | undefined {
  const field = value[key];
  if (field === undefined) return undefined;
  if (typeof field !== "number" || !Number.isSafeInteger(field)) {
    throw new Error(`Telegram fixture ${key} is invalid.`);
  }
  return field;
}

function recordField(
  value: Readonly<Record<string, unknown>>,
  key: string
): Readonly<Record<string, unknown>> | undefined {
  const field = value[key];
  if (field === undefined) return undefined;
  if (field === null || typeof field !== "object" || Array.isArray(field)) {
    throw new Error(`Telegram fixture ${key} is invalid.`);
  }
  return field as Readonly<Record<string, unknown>>;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
