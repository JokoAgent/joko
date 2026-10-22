import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { HostedAgentExchange } from "./hosted-agent-exchange.js";

it("retains ordered immutable frames until the original task acknowledges its durable cursor", async () => {
  const exchange = new HostedAgentExchange({ assertCurrent: () => {}, onOverflow: () => {} }), signal = new AbortController().signal;
  try {
    const event = { type: "status" as const, key: "native", text: "first" }; exchange.emit(event); event.text = "changed producer";
    exchange.emit({ type: "status", key: "native", text: "second" });
    const first = await exchange.poll(0, signal, 0);
    expect(first).toEqual({ cursor: 2, finished: false, frames: [
      { sequence: 1, payload: { kind: "event", event: { type: "status", key: "native", text: "first" } } },
      { sequence: 2, payload: { kind: "event", event: { type: "status", key: "native", text: "second" } } }
    ] });
    expect(await exchange.poll(0, signal, 0)).toEqual(first);
    expect(await exchange.poll(1, signal, 0)).toEqual({ cursor: 2, finished: false, frames: [first.frames[1]] });
    await expect(exchange.poll(0, signal, 0)).rejects.toMatchObject({ code: "INVALID_CURSOR" });
    await expect(exchange.poll(3, signal, 0)).rejects.toMatchObject({ code: "INVALID_CURSOR" });
    expect(await exchange.poll(2, signal, 0)).toEqual({ frames: [], cursor: 2, finished: false });
  } finally { exchange.close(); }
});

it("delivers a tool result once, accepts an exact repeated acknowledgement and rejects foreign or conflicting replies", async () => {
  const exchange = new HostedAgentExchange({ assertCurrent: () => {}, onOverflow: () => {} }), signal = new AbortController().signal;
  try {
    const pending = exchange.tool({ operation: "fs.read" }, signal);
    const frame = (await exchange.poll(0, signal, 0)).frames[0]!;
    if (frame.payload.kind !== "request") throw new Error("Missing request.");
    const id = frame.payload.id, reply = { ok: true as const, value: { data: "private-source-bytes" } };
    expect(exchange.reply(id, reply)).toBe("accepted"); expect(await pending).toEqual(reply.value);
    expect(exchange.reply(id, reply)).toBe("accepted");
    expect(() => exchange.reply(id, { ok: true, value: { data: "other" } })).toThrow(expect.objectContaining({ code: "CONFLICTING_REPLY" }));
    expect(() => exchange.reply(randomUUID(), reply)).toThrow(expect.objectContaining({ code: "UNKNOWN_REQUEST" }));
  } finally { exchange.close(); }
});

it("cancels the exact source request when the native operation aborts and does not accept its late result", async () => {
  const exchange = new HostedAgentExchange({ assertCurrent: () => {}, onOverflow: () => {} }), abort = new AbortController();
  try {
    const pending = exchange.tool({ operation: "exec.run" }, abort.signal); void pending.catch(() => {});
    const frame = (await exchange.poll(0, new AbortController().signal, 0)).frames[0]!;
    if (frame.payload.kind !== "request") throw new Error("Missing request.");
    abort.abort(); await expect(pending).rejects.toMatchObject({ code: "CLOSED" });
    expect(exchange.reply(frame.payload.id, { ok: true, value: { exitCode: 0 } })).toBe("cancelled");
    const frames = await exchange.poll(0, new AbortController().signal, 0);
    expect(frames.frames[1]).toEqual({ sequence: 2, payload: { kind: "cancel_request", id: frame.payload.id } });
  } finally { exchange.close(); }
});

it("wakes an outstanding poll on native output and fences all pending requests after authority revocation", async () => {
  let current = true;
  const exchange = new HostedAgentExchange({ assertCurrent: () => { if (!current) throw new Error("private-relation-secret"); }, onOverflow: () => {} });
  const signal = new AbortController().signal;
  try {
    const poll = exchange.poll(0, signal);
    exchange.emit({ type: "status", key: "native", text: "ready" }); expect((await poll).cursor).toBe(1);
    const pending = exchange.tool({ operation: "fs.write" }, signal); void pending.catch(() => {});
    current = false;
    await expect(exchange.poll(1, signal, 0)).rejects.toMatchObject({ code: "STALE_AUTHORITY" });
    await expect(pending).rejects.toMatchObject({ code: "CLOSED" });
    await expect(exchange.poll(1, signal, 0)).rejects.not.toThrow("private-relation-secret");
  } finally { exchange.close(); }
});

it("closes a native run at the bounded unread limit instead of discarding unacknowledged task output", () => {
  const overflow = vi.fn(), exchange = new HostedAgentExchange({ assertCurrent: () => {}, onOverflow: overflow, maximumBytes: 256 });
  expect(() => exchange.emit({ type: "status", key: "native", text: "x".repeat(1024) })).toThrow(expect.objectContaining({ code: "RESOURCE_EXHAUSTED" }));
  expect(overflow).toHaveBeenCalledTimes(1);
  expect(() => exchange.emit({ type: "status", key: "native", text: "later" })).toThrow(expect.objectContaining({ code: "CLOSED" }));
  exchange.close(); expect(overflow).toHaveBeenCalledTimes(1);
});
