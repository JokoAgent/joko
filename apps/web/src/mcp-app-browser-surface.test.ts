// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { mountBrowserMcpSurface } from "./mcp-app-browser-surface.js";
import type { McpAppBrowserSurface } from "./model.js";

afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); });
const settle = async () => { for (let count = 0; count < 8; count++) await Promise.resolve(); };

it("keeps bridge capabilities in the trusted client and fences App messages and late polls", async () => {
  const frame = document.body.appendChild(document.createElement("iframe")), abort = new AbortController();
  const polls: Array<(value: unknown) => void> = [];
  const invoke = vi.fn((request: Parameters<McpAppBrowserSurface["invoke"]>[0]): Promise<unknown> => request.op === "poll"
    ? new Promise(resolve => { polls.push(resolve); }) : Promise.resolve({}));
  const present = vi.fn(), openLink = vi.fn(async () => {}), failed = vi.fn();
  const dispose = mountBrowserMcpSurface(frame, Promise.resolve({ html: "<p>private App</p>", policy: "default-src 'none'", invoke }),
    { signal: abort.signal, present, openLink, failed });
  const post = vi.spyOn(frame.contentWindow!, "postMessage").mockImplementation(() => {});
  await settle();
  const send = (data: unknown, source: MessageEventSource = frame.contentWindow!, origin = "null") =>
    window.dispatchEvent(new MessageEvent("message", { data, source, origin }));
  send({ jsonrpc: "2.0", id: 1, method: "ping" }, window);
  send({ jsonrpc: "2.0", id: 2, method: "ping" }, frame.contentWindow!, "https://other.example");
  send({ jsonrpc: "2.0", method: "ui/notifications/sandbox-failed" });
  send({ type: "joko:mcp-app-link", id: "forged", url: "https://unapproved.example" });
  send({ jsonrpc: "2.0", id: 3, method: "ping" });
  await settle();
  expect(invoke.mock.calls.filter(([request]) => request.op === "message")).toEqual([[{ op: "message", message: { jsonrpc: "2.0", id: 3, method: "ping" } }]]);
  expect(openLink).not.toHaveBeenCalled(); expect(failed).not.toHaveBeenCalled();
  const context = { jsonrpc: "2.0", method: "ui/notifications/host-context-changed", params: { displayMode: "fullscreen" } };
  polls.shift()!([{ seq: 1, message: context }]); await settle();
  expect(present).toHaveBeenCalledExactlyOnceWith(context); expect(post).toHaveBeenCalledWith(context, "*");
  abort.abort(); dispose();
  const before = post.mock.calls.length;
  polls.shift()!([{ seq: 2, message: { jsonrpc: "2.0", method: "late" } }]); await settle();
  send({ jsonrpc: "2.0", id: 4, method: "ping" });
  expect(post.mock.calls.length).toBe(before);
  expect(invoke.mock.calls.filter(([request]) => request.op === "message")).toHaveLength(1);
});
