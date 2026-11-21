import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

export const IMESSAGE_SYSTEM_OWNER = "+12025550101";
export const IMESSAGE_SYSTEM_GUEST = "+12025550102";
export const IMESSAGE_SYSTEM_DIRECT = `iMessage;-;${IMESSAGE_SYSTEM_OWNER}`;
export const IMESSAGE_SYSTEM_GROUP = "any;+;chat-e2e-imessage";
export const IMESSAGE_SYSTEM_PASSWORD = "bluebubbles-product-fixture-password";
export const IMESSAGE_SYSTEM_FILE = { guid: "at_0_imessage-e2e", transferName: "imessage-evidence.txt",
  mimeType: "text/plain", totalBytes: 22 } as const;
const FILE_BYTES = Buffer.from("iMessage product chain");

interface HistoryRow {
  readonly guid: string;
  readonly text: string;
  readonly dateCreated: number;
  readonly isFromMe: boolean;
  readonly service: "iMessage";
  readonly chats: readonly { readonly guid: string }[];
  readonly handle?: { readonly address: string; readonly service: "iMessage" };
  readonly attachments?: readonly typeof IMESSAGE_SYSTEM_FILE[];
  readonly tempGuid?: string;
}

export async function startIMessageSystemFixture() {
  const rows: HistoryRow[] = [];
  const queries: string[] = [];
  const downloads: string[] = [];
  const sent: { readonly chatGuid: string; readonly message: string; readonly method: string; readonly tempGuid: string }[] = [];
  const errors: unknown[] = [];
  const chatParticipants = new Map([
    [IMESSAGE_SYSTEM_DIRECT, [IMESSAGE_SYSTEM_OWNER]], [IMESSAGE_SYSTEM_GROUP, [IMESSAGE_SYSTEM_OWNER, IMESSAGE_SYSTEM_GUEST]]
  ]);
  let loseNextReceipt = false;
  const respond = (reply: ServerResponse, data: unknown) =>
    reply.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ status: 200, data }));
  const body = async (request: IncomingMessage): Promise<unknown> => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  };
  const handle = async (request: IncomingMessage, reply: ServerResponse): Promise<void> => {
    const url = new URL(request.url!, "http://127.0.0.1");
    if (url.searchParams.get("password") !== IMESSAGE_SYSTEM_PASSWORD) {
      reply.writeHead(401).end();
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/v1/server/info") {
      respond(reply, { private_api: true, helper_connected: true });
      return;
    }
    if (request.method === "GET" && url.pathname.startsWith("/api/v1/chat/")) {
      const guid = decodeURIComponent(url.pathname.slice("/api/v1/chat/".length));
      const participants = chatParticipants.get(guid);
      if (!participants || url.searchParams.get("with") !== "participants") throw new Error("Unexpected BlueBubbles chat probe");
      respond(reply, { guid, participants: participants.map(address => ({ address, service: "iMessage" })) });
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/v1/message/query") {
      const query = await body(request) as { chatGuid: string; after: number; before: number; offset: number; limit: number; sort: string; with: string[] };
      if (!chatParticipants.has(query.chatGuid) || query.sort !== "ASC" || !query.with.includes("chats") || !query.with.includes("attachments")) {
        throw new Error("BlueBubbles queried a chat outside its fixture authority");
      }
      queries.push(query.chatGuid);
      respond(reply, rows.filter(row => row.chats.some(chat => chat.guid === query.chatGuid)
        && row.dateCreated > query.after && row.dateCreated < query.before).sort((a, b) => a.dateCreated - b.dateCreated)
        .slice(query.offset, query.offset + query.limit));
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/v1/message/text") {
      const item = await body(request) as typeof sent[number];
      if (!chatParticipants.has(item.chatGuid) || !item.message || !/^[a-f0-9-]{36}$/u.test(item.tempGuid)) {
        throw new Error("Invalid provider send or delivery identity");
      }
      sent.push(item);
      const guid = `native-out-${sent.length}`;
      rows.push({ guid, text: item.message, service: "iMessage", isFromMe: true, tempGuid: item.tempGuid,
        dateCreated: Date.now(), chats: [{ guid: item.chatGuid }] });
      if (loseNextReceipt) { loseNextReceipt = false; reply.destroy(); }
      else respond(reply, { guid });
      return;
    }
    if (request.method === "GET" && url.pathname === `/api/v1/attachment/${IMESSAGE_SYSTEM_FILE.guid}/download`
      && url.searchParams.get("original") === "true") {
      downloads.push(IMESSAGE_SYSTEM_FILE.guid);
      reply.writeHead(200, { "Content-Type": "text/plain", "Content-Length": FILE_BYTES.length }).end(FILE_BYTES);
      return;
    }
    throw new Error(`Unexpected BlueBubbles route ${request.method} ${url.pathname}`);
  };
  const server = createServer((request, reply) => {
    void handle(request, reply).catch(error => {
      errors.push(error);
      reply.writeHead(500).end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("BlueBubbles did not bind loopback");
  return {
    origin: `http://127.0.0.1:${address.port}`, queries, downloads, sent, errors,
    receive(input: { readonly guid: string; readonly chatGuid: string; readonly sender: string; readonly text: string;
      readonly at?: number; readonly attachment?: typeof IMESSAGE_SYSTEM_FILE }): void {
      rows.push({ guid: input.guid, text: input.text, dateCreated: input.at ?? Date.now(), service: "iMessage",
        isFromMe: false, handle: { address: input.sender, service: "iMessage" }, chats: [{ guid: input.chatGuid }],
        ...(input.attachment ? { attachments: [input.attachment] } : {}) });
    },
    loseNextReceipt(): void { loseNextReceipt = true; },
    async close(): Promise<void> {
      const stopped = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      server.closeAllConnections();
      await stopped;
    }
  };
}
