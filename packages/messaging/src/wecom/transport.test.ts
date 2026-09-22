import { Buffer } from "node:buffer";
import type { BaseMessage, WSClientOptions, WsFrame } from "@wecom/aibot-node-sdk";
import { describe, expect, it, vi } from "vitest";

import { MessagingTransportError, type MessagingAddress } from "../types.js";
import type { WeComSdkClient } from "./stream.js";
import { WeComTransport } from "./transport.js";

type Listener = (...args: never[]) => void;

class FakeClient {
  readonly listeners = new Map<string, Listener[]>();
  isConnected = true;
  connectAction: (() => void) | undefined;
  readonly replyStream = vi.fn(async (_frame: WsFrame<BaseMessage>, _streamId: string, _content: string, _finish?: boolean) => ({}));
  readonly sendMessage = vi.fn(async (_chatId: string, _body: unknown) => ({}));
  readonly uploadMedia = vi.fn(async (_buffer: Buffer, _options: unknown) => ({ media_id: "media-1" }));
  readonly replyMedia = vi.fn(async (_frame: WsFrame<BaseMessage>, _type: string, _mediaId: string) => ({}));
  readonly sendMediaMessage = vi.fn(async (_chatId: string, _type: string, _mediaId: string) => ({}));
  readonly downloadFile = vi.fn(async (_url: string, _aesKey?: string) => ({ buffer: Buffer.from("file"), filename: "file.txt" }));

  on(event: string, listener: Listener): this {
    const listeners = this.listeners.get(event) ?? [];
    listeners.push(listener);
    this.listeners.set(event, listeners);
    return this;
  }
  connect(): this { this.connectAction?.(); return this; }
  disconnect(): void { this.isConnected = false; }
  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args as never[]);
  }
}

function frame(id: string, requestId: string, text = id): WsFrame<BaseMessage> {
  return {
    headers: { req_id: requestId },
    body: {
      msgid: id,
      aibotid: "bot-1",
      chattype: "single",
      from: { userid: "owner" },
      msgtype: "text",
      text: { content: text }
    }
  } as WsFrame<BaseMessage>;
}

const address: MessagingAddress = {
  channel: "wecom",
  connectionId: "connection-1",
  providerConversationId: "owner",
  providerThreadId: null,
  conversationKind: "direct"
};

async function setup(input: { now?: () => number; client?: FakeClient } = {}) {
  const client = input.client ?? new FakeClient();
  client.connectAction = () => client.emit("authenticated");
  const transport = new WeComTransport({
    connectionId: "connection-1",
    generation: 1,
    botId: "bot-1",
    botSecret: "secret-1",
    ownerUserId: "owner",
    now: input.now,
    createClient: (_options: WSClientOptions) => client as unknown as WeComSdkClient
  });
  await transport.probe();
  return { client, transport };
}

async function admit(transport: WeComTransport, client: FakeClient, frames: readonly WsFrame<BaseMessage>[]): Promise<string> {
  for (const item of frames) client.emit("message", item);
  const result = await transport.poll({ cursor: null, timeoutSeconds: 0 });
  transport.normalize(result.updates);
  return result.nextCursor;
}

describe("WeCom transport", () => {
  it("binds passive streams to exact callback message IDs and sends later chunks actively", async () => {
    const { client, transport } = await setup();
    await admit(transport, client, [frame("m1", "r1"), frame("m2", "r2")]);

    await transport.beginReply({ address, messageId: "m2" });
    await transport.beginReply({ address, messageId: "m2" });
    await transport.beginReply({ address, messageId: "m1" });
    await transport.sendTextPart({ address, text: "first final", callbackMessageId: "m1" });
    await transport.sendTextPart({ address, text: "second final", callbackMessageId: "m2" });
    await transport.sendTextPart({ address, text: "second chunk" });

    expect(client.replyStream.mock.calls.map((call) => [(call[0] as WsFrame<BaseMessage>).headers.req_id, call[2], call[3]])).toEqual([
      ["r2", " ", false],
      ["r1", " ", false],
      ["r1", "first final", true],
      ["r2", "second final", true]
    ]);
    expect(client.sendMessage).toHaveBeenCalledWith("owner", { msgtype: "markdown", markdown: { content: "second chunk" } });
    await expect(transport.sendTextPart({ address, text: "duplicate final", callbackMessageId: "m2" }))
      .rejects.toMatchObject({ code: "provider_rejected", options: { effect: "none" } });
    expect(client.sendMessage).toHaveBeenCalledTimes(1);
    await expect(transport.beginReply({ address, messageId: "m1" }))
      .rejects.toMatchObject({ code: "provider_rejected" });
  });

  it("falls back actively only after the passive safe deadline", async () => {
    let now = 10_000;
    const { client, transport } = await setup({ now: () => now });
    await admit(transport, client, [frame("m1", "r1")]);
    await transport.beginReply({ address, messageId: "m1" });
    now += 165_001;
    await transport.sendTextPart({ address, text: "late", callbackMessageId: "m1" });
    expect(client.replyStream).toHaveBeenCalledTimes(1);
    expect(client.sendMessage).toHaveBeenCalledOnce();
  });

  it("rejects an expired callback frame instead of fabricating an active reply reservation", async () => {
    let now = 10_000;
    const { client, transport } = await setup({ now: () => now });
    await admit(transport, client, [frame("m1", "r1")]);
    now += 4 * 60_000 + 1;
    await expect(transport.beginReply({ address, messageId: "m1" }))
      .rejects.toMatchObject({ code: "provider_rejected" });
    expect(client.replyStream).not.toHaveBeenCalled();
  });

  it("actively sends when no passive response was ever reserved", async () => {
    const { client, transport } = await setup();
    await transport.sendTextPart({ address, text: "active", callbackMessageId: "missing-callback" });
    expect(client.replyStream).not.toHaveBeenCalled();
    expect(client.sendMessage).toHaveBeenCalledOnce();
    await expect(transport.sendTextPart({ address, text: "active retry", callbackMessageId: "missing-callback" }))
      .rejects.toMatchObject({ code: "provider_rejected" });
    expect(client.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("does not actively retry a passive final with an unknown outcome", async () => {
    const { client, transport } = await setup();
    await admit(transport, client, [frame("m1", "r1")]);
    await transport.beginReply({ address, messageId: "m1" });
    client.replyStream.mockRejectedValueOnce(new Error("ack timeout"));
    await expect(transport.sendTextPart({ address, text: "final", callbackMessageId: "m1" }))
      .rejects.toMatchObject({ code: "provider_unavailable", options: { effect: "unknown" } });
    expect(client.sendMessage).not.toHaveBeenCalled();
  });

  it("maps authentication, ordinary disconnect and conflict without overwriting conflict", async () => {
    const authClient = new FakeClient();
    authClient.connectAction = () => authClient.emit("error", Object.assign(new Error("Authentication failed"), { code: "WS_AUTH_FAILURE_EXHAUSTED" }));
    const authTransport = new WeComTransport({ connectionId: "auth", generation: 1, botId: "bot-1", botSecret: "bad", ownerUserId: null, createClient: () => authClient as unknown as WeComSdkClient });
    await expect(authTransport.probe()).rejects.toMatchObject({ code: "invalid_credential" });

    const { client, transport } = await setup();
    client.emit("message", frame("before-disconnect", "before-request"));
    client.emit("disconnected", "network");
    const buffered = await transport.poll({ cursor: null, timeoutSeconds: 0 });
    expect(buffered.updates).toHaveLength(1);
    await expect(transport.poll({ cursor: buffered.nextCursor, timeoutSeconds: 0 }))
      .rejects.toMatchObject({ code: "network", options: { retryable: true, effect: "none" } });

    const conflict = await setup();
    conflict.client.emit("event.disconnected_event", {});
    conflict.client.emit("disconnected", "taken over");
    await expect(conflict.transport.poll({ cursor: null, timeoutSeconds: 0 }))
      .rejects.toMatchObject({ code: "conflict" });

    const recovered = await setup();
    recovered.client.emit("message", frame("after-reconnect", "request"));
    await expect(recovered.transport.poll({ cursor: null, timeoutSeconds: 0 })).resolves.toMatchObject({
      updates: [expect.objectContaining({ callbackId: expect.stringContaining("after-reconnect") })]
    });

    const networkError = await setup();
    networkError.client.emit("error", new Error("socket failed"));
    await expect(networkError.transport.poll({ cursor: null, timeoutSeconds: 0 }))
      .rejects.toMatchObject({ code: "network", options: { retryable: true, effect: "none" } });
  });

  it("fences an in-flight media download when closed", async () => {
    const client = new FakeClient();
    let finish!: () => void;
    client.downloadFile.mockImplementationOnce(() => new Promise((resolve) => {
      finish = () => resolve({ buffer: Buffer.from("file"), filename: "file.txt" });
    }));
    const { transport } = await setup({ client });
    await admit(transport, client, [{
      headers: { req_id: "r-file" },
      body: { msgid: "file", aibotid: "bot-1", chattype: "single", from: { userid: "owner" }, msgtype: "file", file: { url: "https://provider.invalid/file", aeskey: "a" } }
    } as WsFrame<BaseMessage>]);
    const normalized = transport.normalize([]);
    void normalized;
    const attachment = {
      providerFileId: "wecom-attachment:ZmlsZQ:0",
      providerUniqueFileId: null,
      kind: "file" as const,
      fileName: "wecom-file",
      mimeType: null,
      byteLength: null
    };
    const download = transport.downloadAttachment(attachment);
    await vi.waitFor(() => expect(client.downloadFile).toHaveBeenCalledOnce());
    await transport.close();
    finish();
    await expect(download).rejects.toMatchObject({ code: "cancelled" });
    await expect(transport.beginReply({ address, messageId: "file" }))
      .rejects.toMatchObject({ code: "cancelled" });
  });

  it("truncates interaction prompts only at Unicode code-point boundaries", async () => {
    const { client, transport } = await setup();
    await transport.sendInteractionCard({
      address,
      text: "😀".repeat(10_000),
      buttons: [{ label: "Continue", actionValue: "continue" }]
    });
    const content = (client.sendMessage.mock.calls[0]?.[1] as { markdown: { content: string } }).markdown.content;
    expect(content).not.toContain("�");
    expect(Buffer.byteLength(content, "utf8")).toBeLessThanOrEqual(18 * 1_024);
    expect(Array.from(content.match(/^😀*/u)?.[0] ?? "").every((point) => point === "😀")).toBe(true);
  });
});
