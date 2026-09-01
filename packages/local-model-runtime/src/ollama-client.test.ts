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
