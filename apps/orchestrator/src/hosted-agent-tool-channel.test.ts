import { afterEach, expect, it, vi } from "vitest";
import { createHostedAgentToolChannel, type HostedAgentToolChannel } from "./hosted-agent-tool-channel.js";

const channels: HostedAgentToolChannel[] = [];
afterEach(async () => { for (const channel of channels.splice(0)) await channel.close(); });
const post = (channel: HostedAgentToolChannel, value: unknown, options?: RequestInit) => fetch(channel.endpoint + "/execute", {
  method: "POST", headers: { authorization: "Bearer " + channel.bearer, "content-type": "application/json" }, body: JSON.stringify(value), ...options
});

it("accepts only the private loopback bearer and exact native operation route", async () => {
  const execute = vi.fn(async (request: unknown) => ({ request }));
  const channel = await createHostedAgentToolChannel({ execute, assertCurrent: () => {} }); channels.push(channel);
  expect(new URL(channel.endpoint).hostname).toBe("127.0.0.1"); expect(channel.bearer).toHaveLength(43);
  const value = { operation: "source-only" };
  const wrong = await post(channel, value, { headers: { authorization: "Bearer incorrect", "content-type": "application/json" } });
  expect(wrong.status).toBe(403); expect(execute).not.toHaveBeenCalled();
  const query = await fetch(channel.endpoint + "/execute?other=1", { method: "POST", headers: { authorization: "Bearer " + channel.bearer, "content-type": "application/json" }, body: "{}" });
  expect(query.status).toBe(400);
  expect((await post(channel, value, { headers: { authorization: "Bearer " + channel.bearer, "content-type": "text/plain" } })).status).toBe(400);
  expect(await (await post(channel, value)).json()).toEqual({ format: 1, ok: true, value: { request: value } });
  expect(execute).toHaveBeenCalledTimes(1);
});

it("keeps failures generic and fences a response if the original authority changes during execution", async () => {
  let current = true;
  const channel = await createHostedAgentToolChannel({ execute: async () => { current = false; return { taskFile: "must not escape after revocation" }; },
    assertCurrent: () => { if (!current) throw new Error("private-source-route-secret"); } }); channels.push(channel);
  const response = await post(channel, {});
  expect(response.status).toBe(409); expect(await response.json()).toEqual({ format: 1, ok: false, error: { code: "STALE_AUTHORITY" } });
  const failure = await createHostedAgentToolChannel({ execute: async () => { throw new Error("private-native-bearer-value"); }, assertCurrent: () => {} }); channels.push(failure);
  expect(await (await post(failure, {})).text()).not.toContain("private-native-bearer-value");
  expect((await post(failure, {}, { body: "{" })).status).toBe(400);
});

it("aborts the exact source operation when its native caller disconnects and closes idempotently", async () => {
  let started!: () => void, stopped!: () => void;
  const start = new Promise<void>(resolve => { started = resolve; }), stop = new Promise<void>(resolve => { stopped = resolve; });
  const channel = await createHostedAgentToolChannel({ execute: async (_request, signal) => {
    started(); await new Promise<void>((_, reject) => { signal.addEventListener("abort", () => { stopped(); reject(new Error("Disconnected")); }, { once: true }); }); return {};
  }, assertCurrent: () => {} }); channels.push(channel);
  const abort = new AbortController(), pending = post(channel, {}, { signal: abort.signal });
  void pending.catch(() => {}); await start; abort.abort(); await expect(pending).rejects.toThrow();
  await Promise.race([stop, new Promise<never>((_, reject) => { const timer = setTimeout(() => reject(new Error("Source operation remained active")), 3000); timer.unref(); })]);
  await channel.close(); await channel.close();
  await expect(post(channel, {})).rejects.toThrow();
});
