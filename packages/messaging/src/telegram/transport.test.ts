import { describe, expect, it, vi } from "vitest";

import type { MessagingAddress } from "../types.js";
import { splitTelegramText } from "./text.js";
import { TelegramTransport } from "./transport.js";

const TOKEN = "123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcd";

describe("TelegramTransport", () => {
  it("renders a Markdown reply and uses one plain replacement only after a structured 400", async () => {
    const bodies: Record<string, unknown>[] = [], current = vi.fn();
    const transport = createTransport(fakeFetch(async (_url, init) => {
      bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return bodies.length === 1 ? jsonResponse({ ok: false, error_code: 400, description: "Can't parse entities" }, 400)
        : jsonResponse({ ok: true, result: { message_id: 88 } });
    }));
    const address: MessagingAddress = { channel: "telegram", connectionId: "connection-1", providerConversationId: "-100", providerThreadId: "55", conversationKind: "group" };
    await expect(transport.sendTextPart({ address, text: "**Answer** <literal>", format: "markdown", replyToMessageId: "77", assertCurrent: current }))
      .resolves.toEqual({ providerMessageId: "88", address });
    expect(bodies).toEqual([
      { chat_id: -100, message_thread_id: 55, reply_parameters: { message_id: 77, allow_sending_without_reply: true }, text: "<b>Answer</b> &lt;literal&gt;", parse_mode: "HTML" },
      { chat_id: -100, message_thread_id: 55, reply_parameters: { message_id: 77, allow_sending_without_reply: true }, text: "**Answer** <literal>" }
    ]);
    expect(current).toHaveBeenCalledTimes(2);
  });

  it.each(["network", "malformed-400", "server", "rate-limit"])("does not replace a %s outcome with another send", async kind => {
    const fetch = vi.fn(async () => {
      if (kind === "network") throw new TypeError("Response lost");
      if (kind === "malformed-400") return new Response("truncated", { status: 400 });
      return kind === "server" ? jsonResponse({ ok: false, error_code: 500 }, 500) : jsonResponse({ ok: false, error_code: 429, parameters: { retry_after: 120 } }, 429);
    }) as unknown as typeof globalThis.fetch;
    const address: MessagingAddress = { channel: "telegram", connectionId: "connection-1", providerConversationId: "42", providerThreadId: null, conversationKind: "direct" };
    await expect(createTransport(fetch).sendTextPart({ address, text: "**Answer**", format: "markdown" })).rejects.toThrow();
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("rechecks original authority before the known-rejection replacement and accepts expanded HTML within the visible limit", async () => {
    let allowed = true;
    const request = vi.fn(async () => { allowed = false; return jsonResponse({ ok: false, error_code: 400 }, 400); }) as unknown as typeof globalThis.fetch;
    const address: MessagingAddress = { channel: "telegram", connectionId: "connection-1", providerConversationId: "42", providerThreadId: null, conversationKind: "direct" };
    await expect(createTransport(request).sendTextPart({ address, text: "**Answer**", format: "markdown",
      assertCurrent: () => { if (!allowed) throw new Error("Recipient revoked"); } })).rejects.toThrow("Recipient revoked");
    expect(request).toHaveBeenCalledOnce();
    const rendered = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toMatchObject({ text: "&lt;".repeat(3_000), parse_mode: "HTML" });
      return jsonResponse({ ok: true, result: { message_id: 90 } });
    }) as unknown as typeof globalThis.fetch;
    await expect(createTransport(rendered).sendTextPart({ address, text: "<".repeat(3_000), format: "markdown" })).resolves.toMatchObject({ providerMessageId: "90" });
  });
  it("probes identity and advances a raw-update cursor without normalizing first", async () => {
    const bodies: unknown[] = [];
    const fetch = fakeFetch(async (_url, init) => {
      const body = JSON.parse(String(init.body)) as unknown;
      bodies.push(body);
      if (bodies.length === 1) {
        return jsonResponse({ ok: true, result: { id: 700, is_bot: true, first_name: "Joko", username: "jokobot" } });
      }
      return jsonResponse({ ok: true, result: [{ update_id: 17 }, { update_id: 19 }] });
    });
    const transport = createTransport(fetch);

    await expect(transport.probe()).resolves.toMatchObject({
      providerAccountId: "700",
      username: "jokobot",
      generation: 3
    });
    await expect(transport.poll({ cursor: "17", timeoutSeconds: 12 })).resolves.toMatchObject({
      nextCursor: "20",
      updates: [{ update_id: 17 }, { update_id: 19 }]
    });
    expect(bodies[1]).toMatchObject({ offset: 17, timeout: 12, limit: 100 });
  });

  it("keeps each outbound call to one externally uncertain effect", async () => {
    const calls: Array<{ readonly method: string; readonly body: Record<string, unknown> }> = [];
    const fetch = fakeFetch(async (url, init) => {
      const method = /\/([^/]+)$/u.exec(url)?.[1] ?? "";
      calls.push({ method, body: JSON.parse(String(init.body)) as Record<string, unknown> });
      if (method === "getMe") {
        return jsonResponse({ ok: true, result: { id: 700, is_bot: true, first_name: "Joko", username: "jokobot" } });
      }
      return jsonResponse({
        ok: true,
        result: { message_id: 88, chat: { id: -100, type: "supergroup" }, date: 1 }
      });
    });
    const transport = createTransport(fetch);
    await transport.probe();
    const address: MessagingAddress = {
      channel: "telegram",
      connectionId: "connection-1",
      providerConversationId: "-100",
      providerThreadId: "55",
      conversationKind: "group"
    };

    await expect(transport.sendTextPart({
      address,
      text: "hello",
      replyToMessageId: "77"
    })).resolves.toEqual({ providerMessageId: "88", address });
    expect(calls.at(-1)).toEqual({
      method: "sendMessage",
      body: {
        chat_id: -100,
        text: "hello",
        message_thread_id: 55,
        reply_parameters: { message_id: 77, allow_sending_without_reply: true }
      }
    });
    await expect(transport.sendInteractionCard({
      address,
      text: "Allow this tool?",
      buttons: [
        { label: "Allow", actionValue: "allow-token" },
        { label: "Deny", actionValue: "deny-token" }
      ]
    })).resolves.toEqual({ providerMessageId: "88", address });
    expect(calls.at(-1)).toEqual({
      method: "sendMessage",
      body: {
        chat_id: -100,
        text: "Allow this tool?",
        message_thread_id: 55,
        reply_markup: { inline_keyboard: [[
          { text: "Allow", callback_data: "allow-token" },
          { text: "Deny", callback_data: "deny-token" }
        ]] }
      }
    });
    await expect(transport.sendInteractionCard({
      address,
      text: "Reply to this question.",
      buttons: []
    })).resolves.toEqual({ providerMessageId: "88", address });
    expect(calls.at(-1)).toEqual({
      method: "sendMessage",
      body: {
        chat_id: -100,
        text: "Reply to this question.",
        message_thread_id: 55
      }
    });
    await expect(transport.clearInteractionCard({ address, messageId: "88" }))
      .resolves.toEqual({ providerMessageId: "88", address });
    expect(calls.at(-1)).toEqual({
      method: "editMessageReplyMarkup",
      body: {
        chat_id: -100,
        message_id: 88,
        reply_markup: { inline_keyboard: [] }
      }
    });
  });

  it("uploads one document or one native image album per externally uncertain effect", async () => {
    const forms: Array<{ readonly method: string; readonly form: FormData }> = [];
    const fetch = fakeFetch(async (url, init) => {
      const method = /\/([^/]+)$/u.exec(url)?.[1] ?? "";
      if (method === "getMe") {
        return jsonResponse({ ok: true, result: { id: 700, is_bot: true, first_name: "Joko", username: "jokobot" } });
      }
      const form = init.body;
      if (!(form instanceof FormData)) throw new Error("Expected multipart form data.");
      forms.push({ method, form });
      const message = (id: number) => ({ message_id: id, chat: { id: -100, type: "supergroup" }, date: 1 });
      return jsonResponse({ ok: true, result: method === "sendMediaGroup" ? [message(91), message(92)] : message(90) });
    });
    const transport = createTransport(fetch);
    await transport.probe();
    const address: MessagingAddress = {
      channel: "telegram",
      connectionId: "connection-1",
      providerConversationId: "-100",
      providerThreadId: "55",
      conversationKind: "group"
    };

    await expect(transport.sendAttachments({
      address,
      attachments: [{
        kind: "file",
        bytes: new TextEncoder().encode("document"),
        fileName: "report.txt",
        mimeType: "text/plain"
      }],
      replyToMessageId: "77"
    })).resolves.toMatchObject({ providerMessageId: "90" });
    await expect(transport.sendAttachments({
      address,
      attachments: [{
        kind: "image",
        bytes: new Uint8Array([1, 2, 3]),
        fileName: "one.png",
        mimeType: "image/png"
      }, {
        kind: "image",
        bytes: new Uint8Array([4, 5, 6]),
        fileName: "two.png",
        mimeType: "image/png"
      }]
    })).resolves.toMatchObject({ providerMessageId: "91" });

    expect(forms.map((entry) => entry.method)).toEqual(["sendDocument", "sendMediaGroup"]);
    expect(forms[0]!.form.get("chat_id")).toBe("-100");
    expect(forms[0]!.form.get("message_thread_id")).toBe("55");
    expect(forms[0]!.form.get("reply_parameters")).toBe(JSON.stringify({
      message_id: 77,
      allow_sending_without_reply: true
    }));
    expect(forms[0]!.form.get("document")).toBeInstanceOf(Blob);
    expect(JSON.parse(String(forms[1]!.form.get("media")))).toEqual([
      { type: "photo", media: "attach://photo0" },
      { type: "photo", media: "attach://photo1" }
    ]);
    expect(forms[1]!.form.get("photo0")).toBeInstanceOf(Blob);
    expect(forms[1]!.form.get("photo1")).toBeInstanceOf(Blob);
  });

  it("rejects cross-connection addresses before any external write", async () => {
    const fetch = vi.fn(async () => jsonResponse({ ok: true, result: {} })) as unknown as typeof globalThis.fetch;
    const transport = createTransport(fetch);

    await expect(transport.sendTextPart({
      address: {
        channel: "telegram",
        connectionId: "other",
        providerConversationId: "42",
        providerThreadId: null,
        conversationKind: "direct"
      },
      text: "must not send"
    })).rejects.toMatchObject({ code: "invalid_input", options: { effect: "none" } });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("splitTelegramText", () => {
  it("preserves code indentation and all whitespace across split boundaries", () => {
    const source = ('line  \n    indented 😀 line\n\n' + 'x'.repeat(40) + '   ').repeat(4);
    expect(splitTelegramText(source, 32).join('')).toBe(source);
    expect(() => splitTelegramText('😀😀', 1)).toThrow(/code point/u);
  });
  it("prefers readable boundaries and never bisects surrogate pairs", () => {
    const chunks = splitTelegramText(`alpha beta gamma 😀 delta`, 12);
    expect(chunks.join(" ").replace(/\s+/gu, " ")).toBe("alpha beta gamma 😀 delta");
    expect(chunks.every((chunk) => chunk.length <= 12)).toBe(true);
    expect(chunks.some((chunk) => /[\uD800-\uDBFF]$/u.test(chunk))).toBe(false);
    expect(chunks.some((chunk) => /^[\uDC00-\uDFFF]/u.test(chunk))).toBe(false);
  });
});

function createTransport(fetch: typeof globalThis.fetch): TelegramTransport {
  return new TelegramTransport({
    token: TOKEN,
    fetch,
    connectionId: "connection-1",
    generation: 3,
    ownerUserId: "42",
    now: () => Date.UTC(2026, 8, 22, 12, 0, 0)
  });
}

function fakeFetch(
  handler: (url: string, init: RequestInit) => Promise<Response>
): typeof globalThis.fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => handler(String(input), init ?? {})) as typeof globalThis.fetch;
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" }
  });
}
