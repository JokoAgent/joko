import { describe, expect, it, vi } from "vitest";
import { MULTILINGUAL_FIXTURES } from "./i18n/multilingual-fixtures.js";

import {
  ProviderModelDiscoveryError,
  deriveProviderModelsUrl,
  fetchProviderModels,
  parseProviderModels
} from "./provider-model-discovery.js";

describe("Provider model discovery", () => {
  it("derives versioned endpoints and parses supported response shapes", () => {
    expect(deriveProviderModelsUrl("https://api.example.test/v1")).toBe("https://api.example.test/v1/models");
    expect(deriveProviderModelsUrl("https://api.example.test/root/")).toBe("https://api.example.test/root/v1/models");
    expect(deriveProviderModelsUrl("https://api.example.test/root?region=west"))
      .toBe("https://api.example.test/root/v1/models?region=west");
    expect(parseProviderModels({
      data: [
        { id: "kept", display_name: "Kept", context_length: 128_000 },
        { id: "kept", name: "Duplicate" },
        { slug: "new", name: "New", max_input_tokens: 1_000_000 },
        { id: "bad id" }
      ]
    })).toEqual([
      { id: "kept", name: "Kept", contextWindow: 128_000, metadata: { name: "Kept" } },
      { id: "new", name: "New", contextWindow: 1_000_000, metadata: { name: "New" } }
    ]);
  });

  it("uses bounded authenticated discovery without exposing upstream bodies", async () => {
    const request = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => new Response(JSON.stringify({
      models: ["model-a", { id: "model-b", name: "Model B" }]
    }), { status: 200, headers: { "content-type": "application/json" } }));
    await expect(fetchProviderModels({
      baseUrl: "https://api.example.test/v1",
      api: "anthropic-messages",
      apiKey: "test-secret-value",
      headers: { "X-Tenant": "tenant-secret", Authorization: "stale" }
    }, request as typeof fetch)).resolves.toEqual([
      { id: "model-a", name: "model-a" },
      { id: "model-b", name: "Model B", metadata: { name: "Model B" } }
    ]);
    expect(request).toHaveBeenCalledWith("https://api.example.test/v1/models", expect.objectContaining({
      headers: expect.objectContaining({
        authorization: "Bearer test-secret-value",
        "x-api-key": "test-secret-value",
        "anthropic-version": "2023-06-01",
        "x-tenant": "tenant-secret"
      })
    }));
  });

  it("accepts native catalog identities and explicit capability denials without inventing a wire protocol", () => {
    expect(parseProviderModels(["plain", { key: "local", model_info: { max_input_tokens: 48_000, max_output_tokens: 8_000, supports_vision: false, supports_function_calling: false } }, {
      name: "models/gemini-test", displayName: "Gemini Test", supportedGenerationMethods: ["generateContent"], inputTokenLimit: 256_000, outputTokenLimit: 32_000
    }])).toEqual([
      { id: "plain", name: "plain" },
      { id: "local", name: "local", contextWindow: 48_000, metadata: { maxOutputTokens: 8_000, supportsImages: false, supportsTools: false } },
      { id: "gemini-test", name: "Gemini Test", contextWindow: 256_000, metadata: { maxOutputTokens: 32_000, name: "Gemini Test" } }
    ]);
    expect(parseProviderModels({ data: [{ id: "explicit", reasoning: { supportedEfforts: [], defaultEffort: null },
      supports_fast_mode: false, native_api: "openai-responses", context_window: 64_000, max_context_window: 32_000 }] })[0])
      .toEqual({ id: "explicit", name: "explicit", contextWindow: 64_000,
        metadata: { efforts: [], defaultEffort: null, supportsFastMode: false, nativeApi: "openai-responses" } });
    expect(parseProviderModels({ data: [{ id: "bad", max_output_tokens: 1e30, max_context_window: 0.5, reasoning: { supportedEfforts: ["unknown"] }, capabilities: { vision: "true" } }] }))
      .toEqual([{ id: "bad", name: "bad" }]);
  });

  it("keeps exact source-specific chat discovery separate from media and declared non-chat models", () => {
    const data = [{ id: "speech", architecture: { input_modalities: ["text"], output_modalities: ["speech"] } },
      { id: "language", type: "language", max_tokens: 8_192, supported_parameters: ["tools", "reasoning"], reasoning_options: [{ type: "effort", values: ["low", "high"] }] },
      { id: "picture", type: "image" }, { model_id: "tts", can_do_text_to_speech: true }, { id: "embedding", mode: "embedding" }];
    expect(parseProviderModels({ data }, "https://openrouter.ai/api/v1/models").map(model => model.id)).not.toContain("speech");
    const vercel = parseProviderModels({ data }, "https://ai-gateway.vercel.sh/v1/models");
    expect(vercel.map(model => model.id)).not.toContain("picture");
    expect(vercel.find(model => model.id === "language")).toMatchObject({ metadata: { maxOutputTokens: 8_192, supportsTools: true, efforts: ["low", "high"] } });
    const custom = parseProviderModels({ data }, "https://relay.example/v1/models");
    expect(custom.find(model => model.id === "language")?.metadata).not.toHaveProperty("maxOutputTokens");
    expect(custom.map(model => model.id)).toContain("speech");
    expect(custom.map(model => model.id)).not.toContain("tts");
    expect(custom.map(model => model.id)).not.toContain("embedding");
  });

  it("fails closed for unauthenticated remote endpoints and invalid payloads", async () => {
    await expect(fetchProviderModels({ baseUrl: "https://api.example.test/v1" }, vi.fn() as typeof fetch))
      .rejects.toMatchObject({ code: "unsafe_endpoint" });
    await expect(fetchProviderModels({
      baseUrl: "http://127.0.0.1:11434/v1"
    }, vi.fn(async () => new Response("upstream secret detail", { status: 500 })) as typeof fetch))
      .rejects.toEqual(new ProviderModelDiscoveryError("unavailable"));
  });

  it("retains a stored custom authorization header when no primary API key replaces it", async () => {
    const request = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.headers).toMatchObject({ authorization: "Custom safe-vault-value" });
      return new Response(JSON.stringify({ data: [{ id: "custom-model" }] }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    });
    await expect(fetchProviderModels({
      baseUrl: "https://api.example.test/v1",
      headers: { Authorization: "Custom safe-vault-value" }
    }, request as typeof fetch)).resolves.toEqual([{ id: "custom-model", name: "custom-model" }]);
  });

  it("honors an explicit same-origin Google catalog and an owner-configured Google key header", async () => {
    const baseUrl = "https://google-proxy.example.test/service/v1beta/";
    const modelsEndpoint = "https://google-proxy.example.test/catalog";
    const request = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("x-goog-api-key")).toBe("configured-key");
      expect(new Headers(init?.headers).has("authorization")).toBe(false);
      return Response.json({ models: [{ name: "models/new-model", supportedGenerationMethods: ["generateContent"] }] });
    });
    const spec = { api: "google-generative-ai", baseUrl, headers: { "X-Goog-API-Key": "configured-key" } };
    await expect(fetchProviderModels({ ...spec, modelsEndpoint }, request as typeof fetch))
      .resolves.toEqual([{ id: "new-model", name: "new-model" }]);
    expect(request).toHaveBeenCalledExactlyOnceWith(modelsEndpoint, expect.objectContaining({ method: "GET", redirect: "error" }));
    await expect(fetchProviderModels({ ...spec, modelsEndpoint: "https://different.example.test/catalog" }, request as typeof fetch))
      .rejects.toMatchObject({ code: "unavailable" });
    expect(request).toHaveBeenCalledOnce();
  });

  it("bounds Anthropic pagination to the original catalog, deadline and unique cursors", async () => {
    const modelsEndpoint = "https://api.example.test/model-catalog";
    const cursor = "https://unrelated.example.test/v1/models";
    const request = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      Response.json({ data: [{ id: "listed-model" }], has_more: true, last_id: cursor }));
    await expect(fetchProviderModels({ baseUrl: "https://api.example.test/v1", modelsEndpoint,
      api: "anthropic-messages", apiKey: "test-key" }, request as typeof fetch)).rejects.toMatchObject({ code: "invalid_response" });
    expect(request.mock.calls.map(([url]) => url)).toEqual([modelsEndpoint, `${modelsEndpoint}?after_id=${encodeURIComponent(cursor)}`]);
    expect(request.mock.calls[0]?.[1]?.signal).toBe(request.mock.calls[1]?.[1]?.signal);
  });

  it("cancels an oversized streaming response without buffering the remaining upstream body", async () => {
    const cancel = vi.fn();
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new Uint8Array(256 * 1024));
      },
      cancel
    }, { highWaterMark: 0 });
    await expect(fetchProviderModels({
      baseUrl: "http://127.0.0.1:11434/v1"
    }, vi.fn(async () => new Response(body)) as typeof fetch))
      .rejects.toEqual(new ProviderModelDiscoveryError("invalid_response"));
    expect(pulls).toBe(5);
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
  });

  it("parses UTF-8 model names split across bounded response chunks", async () => {
    const bytes = new TextEncoder().encode(JSON.stringify({ data: [{ id: "model", name: MULTILINGUAL_FIXTURES.modelName }] }));
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
        controller.close();
      }
    });
    await expect(fetchProviderModels({
      baseUrl: "http://127.0.0.1:11434/v1"
    }, vi.fn(async () => new Response(body)) as typeof fetch)).resolves.toEqual([{ id: "model", name: MULTILINGUAL_FIXTURES.modelName, metadata: { name: MULTILINGUAL_FIXTURES.modelName } }]);
    expect(body.locked).toBe(false);
  });
});
