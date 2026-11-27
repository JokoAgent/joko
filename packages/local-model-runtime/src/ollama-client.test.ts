import { createServer } from "node:http";
import { setImmediate } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";

import { LocalRuntimeError } from "./errors.js";
import { OllamaLoopbackClient, parsePullLine, type RuntimeFetch } from "./ollama-client.js";
import { OLLAMA_LOOPBACK_ORIGIN } from "./types.js";

describe("OllamaLoopbackClient", () => {
  it("uses only the fixed loopback origin for probe, tags, show and delete", async () => {
    const requested: string[] = [];
    const fetchImpl: RuntimeFetch = vi.fn(async (url) => {
      requested.push(url);
      if (url.endsWith("/api/version")) return Response.json({ version: "0.14.2" });
      if (url.endsWith("/api/tags")) return Response.json({ models: [{ name: "model-a:latest", size: 42, digest: `sha256:${"ab".repeat(32)}` }] });
      if (url.endsWith("/api/show")) return Response.json({ model_info: { "family.context_length": 32768 }, capabilities: ["tools"] });
      return new Response(null, { status: 200 });
    });
    const client = new OllamaLoopbackClient(fetchImpl);

    await expect(client.version()).resolves.toBe("0.14.2");
    await expect(client.tags()).resolves.toEqual([{ name: "model-a:latest", sizeBytes: 42, digest: `sha256:${"ab".repeat(32)}` }]);
    await expect(client.show("model-a:latest")).resolves.toEqual({ contextLength: 32768, capabilities: ["tools"] });
    await expect(client.delete("model-a:latest")).resolves.toBeUndefined();
    expect(requested).toEqual([
      `${OLLAMA_LOOPBACK_ORIGIN}/api/version`,
      `${OLLAMA_LOOPBACK_ORIGIN}/api/tags`,
      `${OLLAMA_LOOPBACK_ORIGIN}/api/show`,
      `${OLLAMA_LOOPBACK_ORIGIN}/api/delete`
    ]);
  });

  it("rejects redirects and non-runtime version payloads as a port conflict", async () => {
    const redirected = new OllamaLoopbackClient(async () => new Response(null, { status: 302, headers: { location: "https://example.invalid" } }));
    await expect(redirected.version()).rejects.toMatchObject({ code: "PORT_CONFLICT" });
    const foreign = new OllamaLoopbackClient(async () => Response.json({ service: "other" }));
    await expect(foreign.version()).rejects.toMatchObject({ code: "PORT_CONFLICT" });
  });

  it("bounds JSON responses and filters malformed tag entries", async () => {
    const client = new OllamaLoopbackClient(async () => Response.json({
      models: [
        { name: "valid:latest", size: 1 },
        { name: "../../escape", size: 2 },
        { name: "valid:latest", size: -1 }
      ]
    }));
    await expect(client.tags()).resolves.toEqual([
      { name: "valid:latest", sizeBytes: 1 },
      { name: "valid:latest" }
    ]);
    const oversized = new OllamaLoopbackClient(async () => new Response("{}", { headers: { "content-length": String(9 * 1024 * 1024) } }));
    await expect(oversized.tags()).rejects.toBeInstanceOf(LocalRuntimeError);
  });

  it.each(["deadline", "cancel"] as const)("releases a partially read HTTP response on %s", async (cause) => {
    let receivedHeaders!: () => void;
    const headers = new Promise<void>(resolve => { receivedHeaders = resolve; });
    let recordDisconnect!: (interrupted: boolean) => void;
    const disconnected = new Promise<boolean>(resolve => { recordDisconnect = resolve; });
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.write('{"version":');
      const timer = setTimeout(() => response.end('"0.14.2"}'), 2_500);
      response.on("close", () => {
        clearTimeout(timer);
        recordDisconnect(!response.writableEnded);
      });
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("The test runtime did not bind a TCP port.");
      const client = new OllamaLoopbackClient(async (url, init) => {
        const response = await fetch(`http://127.0.0.1:${address.port}${new URL(url).pathname}`, init);
        receivedHeaders();
        return response;
      });
      const controller = new AbortController();
      const version = client.version(controller.signal);
      const rejected = expect(version).rejects.toMatchObject({ code: cause === "deadline" ? "RUNTIME_UNREACHABLE" : "OPERATION_CANCELLED" });
      await headers;
      await setImmediate();
      if (cause === "cancel") controller.abort();
      await rejected;
      expect(await disconnected).toBe(true);
    } finally {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it("skips a short runtime request already cancelled by its caller", async () => {
    const fetchImpl = vi.fn<RuntimeFetch>(async () => new Response(null, { status: 200 }));
    const client = new OllamaLoopbackClient(fetchImpl);
    await expect(client.delete("model-a", AbortSignal.abort())).rejects.toMatchObject({ code: "OPERATION_CANCELLED" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("parses bounded NDJSON and delegates one validated pull", async () => {
    const pull = vi.fn(async (_name: string, emit: (event: { status: string }) => void) => emit({ status: "success" }));
    const client = new OllamaLoopbackClient(async () => Response.json({}), pull);
    const events: unknown[] = [];
    await client.pull("model-a", (event) => events.push(event));
    expect(pull).toHaveBeenCalledOnce();
    expect(events).toEqual([{ status: "success" }]);
    expect(parsePullLine('{"status":"downloading","completed":1}')).toEqual({ status: "downloading", completed: 1 });
    expect(parsePullLine("not-json")).toBeUndefined();
    expect(() => parsePullLine("x".repeat(65 * 1024))).toThrow(LocalRuntimeError);
    await expect(client.pull("../bad", () => undefined)).rejects.toMatchObject({ code: "MODEL_INVALID" });
  });
});
