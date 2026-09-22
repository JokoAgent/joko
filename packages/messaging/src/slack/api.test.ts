import { describe, expect, it, vi } from "vitest";

import { MessagingTransportError } from "../types.js";
import { SlackApi } from "./api.js";

const APP_TOKEN = "xapp-1234567890-abcdefghi";
const BOT_TOKEN = "xoxb-1234567890-abcdefghi";
const API_BASE = "http://127.0.0.1:7777/api/";
const CHANNEL = "C12345678";
const ROOT = "1770000000.000001";

function json(value: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json", ...headers } });
}

describe("Slack Web API", () => {
  it("binds bot and app token to separate methods and rejects a Socket URL outside the provider", async () => {
    const seen: Array<{ path: string; authorization: string | null }> = [];
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      seen.push({ path: url.pathname, authorization: new Headers(init?.headers).get("authorization") });
      if (url.pathname.endsWith("auth.test")) return json({ ok: true, team_id: "T12345678", user_id: "U22222222", bot_id: "B22222222", team: "Test Team" });
      if (url.pathname.endsWith("apps.connections.open")) return json({ ok: true, url: "ws://127.0.0.1:7777/link/?ticket=one" });
      return json({ ok: false, error: "unknown_method" });
    }) as typeof globalThis.fetch;
    const api = new SlackApi({ appToken: APP_TOKEN, botToken: BOT_TOKEN, apiBaseUrl: API_BASE, fetch });
    expect(await api.authTest()).toEqual({ teamId: "T12345678", botUserId: "U22222222", botId: "B22222222", teamName: "Test Team" });
    expect(await api.openSocketUrl()).toBe("ws://127.0.0.1:7777/link/?ticket=one");
    expect(seen).toEqual([
      { path: "/api/auth.test", authorization: `Bearer ${BOT_TOKEN}` },
      { path: "/api/apps.connections.open", authorization: `Bearer ${APP_TOKEN}` }
    ]);
    const bad = new SlackApi({
      appToken: APP_TOKEN, botToken: BOT_TOKEN, apiBaseUrl: API_BASE,
      fetch: vi.fn(async () => json({ ok: true, url: "ws://127.0.0.1:9876/link/?ticket=one" })) as typeof globalThis.fetch
    });
    await expect(bad.openSocketUrl()).rejects.toMatchObject({ code: "malformed_response" });
  });

  it("posts a safe threaded message, uploads one file through the v2 sequence, and downloads only a bounded authorized private file", async () => {
    const calls: Array<{ path: string; authorization: string | null; body: unknown }> = [];
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const body = typeof init?.body === "string" ? JSON.parse(init.body) as unknown : init?.body;
      calls.push({ path: url.pathname, authorization: new Headers(init?.headers).get("authorization"), body });
      if (url.pathname.endsWith("chat.postMessage")) return json({ ok: true, channel: CHANNEL, ts: "1770000001.000001" });
      if (url.pathname.endsWith("files.getUploadURLExternal")) return json({ ok: true, upload_url: "http://127.0.0.1:7777/upload/one", file_id: "F12345678" });
      if (url.pathname === "/upload/one") return new Response("OK", { status: 200 });
      if (url.pathname.endsWith("files.completeUploadExternal")) return json({ ok: true, files: [{ id: "F12345678", title: "a.txt" }] });
      if (url.pathname.endsWith("files.info")) return json({ ok: true, file: { id: "F12345678", name: "a.txt", mimetype: "text/plain", size: 5, url_private: "http://127.0.0.1:7777/files/a.txt" } });
      if (url.pathname === "/files/a.txt") return new Response("hello", { status: 200, headers: { "content-type": "text/plain", "content-length": "5" } });
      return json({ ok: false, error: "unknown_method" });
    }) as typeof globalThis.fetch;
    const api = new SlackApi({ appToken: APP_TOKEN, botToken: BOT_TOKEN, apiBaseUrl: API_BASE, fetch });
    expect(await api.postMessage({ channelId: CHANNEL, text: "safe", threadTs: ROOT })).toBe("1770000001.000001");
    expect(await api.uploadFile({ bytes: new TextEncoder().encode("hello"), fileName: "a.txt", channelId: CHANNEL, threadTs: ROOT })).toBe("F12345678");
    const info = await api.fileInfo("F12345678");
    expect(new TextDecoder().decode((await api.downloadFile(info, 5)).bytes)).toBe("hello");
    expect(calls.find((call) => call.path.endsWith("chat.postMessage"))?.body).toMatchObject({
      channel: CHANNEL, thread_ts: ROOT, mrkdwn: false, parse: "none", unfurl_links: false
    });
    expect(calls.find((call) => call.path.endsWith("files.completeUploadExternal"))?.body).toMatchObject({
      files: [{ id: "F12345678", title: "a.txt" }], channel_id: CHANNEL, thread_ts: ROOT
    });
    expect(calls.find((call) => call.path === "/upload/one")?.authorization).toBeNull();
    expect(calls.find((call) => call.path === "/files/a.txt")?.authorization).toBe(`Bearer ${BOT_TOKEN}`);
  });

  it("classifies 429, explicit credential failure, and ambiguous post failure without leaking tokens", async () => {
    const api = (response: Response) => new SlackApi({
      appToken: APP_TOKEN, botToken: BOT_TOKEN, apiBaseUrl: API_BASE,
      fetch: vi.fn(async () => response) as typeof globalThis.fetch
    });
    await expect(api(new Response("", { status: 429, headers: { "retry-after": "7" } })).postMessage({ channelId: CHANNEL, text: "x", threadTs: null }))
      .rejects.toMatchObject({ code: "rate_limited", options: { effect: "none", retryAfterMs: 7_000 } });
    await expect(api(json({ ok: false, error: "invalid_auth" })).postMessage({ channelId: CHANNEL, text: "x", threadTs: null }))
      .rejects.toMatchObject({ code: "invalid_credential", options: { effect: "none" } });
    await expect(api(json({ ok: false, error: "internal_error" })).postMessage({ channelId: CHANNEL, text: "x", threadTs: null }))
      .rejects.toMatchObject({ code: "provider_unavailable", options: { effect: "unknown" } });
    const failing = new SlackApi({
      appToken: APP_TOKEN, botToken: BOT_TOKEN, apiBaseUrl: API_BASE,
      fetch: vi.fn(async () => { throw new Error(`no route for ${BOT_TOKEN}`); }) as typeof globalThis.fetch
    });
    let failure: unknown;
    try { await failing.postMessage({ channelId: CHANNEL, text: "x", threadTs: null }); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(MessagingTransportError);
    expect(failure).toMatchObject({ code: "network", options: { effect: "unknown" } });
    expect(String(failure)).not.toContain(BOT_TOKEN);
  });

  it("treats duplicate reactions and absent acknowledgement reaction as already settled", async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL) => json({ ok: false, error: String(input).endsWith("reactions.add") ? "already_reacted" : "no_reaction" })) as typeof globalThis.fetch;
    const api = new SlackApi({ appToken: APP_TOKEN, botToken: BOT_TOKEN, apiBaseUrl: API_BASE, fetch });
    await expect(api.addReaction(CHANNEL, ROOT, "👀")).resolves.toBeUndefined();
    await expect(api.removeReaction(CHANNEL, ROOT, "👀")).resolves.toBeUndefined();
  });

  it("rejects private-file redirects outside Slack before forwarding its bearer credential", async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("files.info")) return json({ ok: true, file: { id: "F12345678", name: "a.txt", size: 5, url_private: "http://127.0.0.1:7777/files/a.txt" } });
      return new Response("", { status: 302, headers: { location: "http://127.0.0.1:7778/secret" } });
    }) as typeof globalThis.fetch;
    const api = new SlackApi({ appToken: APP_TOKEN, botToken: BOT_TOKEN, apiBaseUrl: API_BASE, fetch });
    const info = await api.fileInfo("F12345678");
    await expect(api.downloadFile(info, 5)).rejects.toMatchObject({ code: "invalid_input" });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
