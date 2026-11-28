import { describe, expect, it, vi } from "vitest";
import { MULTILINGUAL_FIXTURES } from "./i18n/multilingual-fixtures.js";

import {
  ProviderModelDiscoveryError,
  deriveProviderModelsUrl,
  fetchProviderModelCatalog,
  fetchProviderModels,
  parseProviderModels
} from "./provider-model-discovery.js";

describe("Provider model discovery", () => {
  it("accepts complete OpenRouter text token prices, including explicit zeros, from its official model catalogue", () => {
    const architecture = { input_modalities: ["text"], output_modalities: ["text"] };
    const pricing = { prompt: "0.00001", completion: "2e-5", input_cache_read: "0", input_cache_write: "0" };
    const payload = { data: [
      { id: "priced", architecture, pricing },
      { id: "free", architecture, pricing: { ...pricing, prompt: "0", completion: "0" } },
      { id: "invalid", architecture, pricing: { ...pricing, prompt: "-0.00001" } },
      { id: "unquoted-cache", architecture, pricing: { prompt: "0", completion: "0" } },
      { id: "speech", architecture: { ...architecture, output_modalities: ["speech"] }, pricing }
    ] };
    const rows = parseProviderModels(payload, "https://openrouter.ai/api/v1/models", true);
    expect(rows.map(row => row.cost)).toEqual([
      { input: 10, output: 20, cacheRead: 0, cacheWrite: 0 },
      { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, undefined, undefined, undefined
    ]);
    expect(parseProviderModels(payload, "https://relay.example/api/v1/models", true).every(row => row.cost === undefined)).toBe(true);
  });

  it("retains speech purpose, explicit withdrawals and source-specific modalities without guessing from generic audio or names", () => {
    const rows = parseProviderModels({ data: [
      { id: "manual-kind", mode: "audio_speech", modalities: { input: ["text"], output: [] } },
      { id: "transcription", model_info: { mode: "audio_transcription" } },
      { model_id: "eleven", can_do_text_to_speech: true },
      { model_id: "withdrawn", can_do_text_to_speech: false },
      { id: "tts-sounding-name", architecture: { output_modalities: ["audio"] } }
    ] }, "https://proxy.example/v1/models", true);
    expect(rows.map(row => row.metadata)).toEqual([
      { mode: "audio_speech", inputModalities: ["text"], outputModalities: [], supportsImages: false },
      { mode: "audio_transcription" }, { mode: "audio_speech" }, { mode: "other" }, { outputModalities: ["audio"] }
    ]);
    const speech = { data: [{ id: "opaque", architecture: { input_modalities: ["text"], output_modalities: ["speech"] } }] };
    expect(parseProviderModels(speech, "https://openrouter.ai/api/v1/models?output_modalities=speech", true)[0]?.metadata)
      .toEqual({ mode: "audio_speech", inputModalities: ["text"], outputModalities: ["audio"], supportsImages: false });
    expect(parseProviderModels(speech, "https://proxy.example/api/v1/models", true)[0]?.metadata)
      .toEqual({ inputModalities: ["text"], outputModalities: ["speech"], supportsImages: false });
  });

  it.each(["complete", "unavailable", "malformed", "partial"] as const)("keeps OpenRouter chat results and accounts for its %s speech list", async speech => {
    const request = vi.fn(async (value: string | URL | Request, init?: RequestInit) => {
      expect(init?.headers).toMatchObject({ authorization: "Bearer original-key" });
      expect(init?.redirect).toBe("error");
      const url = new URL(String(value));
      if (url.search === "") return Response.json({ data: [{ id: "chat", name: "Chat" }] });
      if (speech === "unavailable") return new Response("unavailable", { status: 503 });
      if (speech === "malformed") return Response.json({ data: {} });
      return Response.json({ data: [{ id: "speech", architecture: { input_modalities: ["text"], output_modalities: ["speech"] } }],
        ...(speech === "partial" ? { next_cursor: "more" } : {}) });
    });
    const result = await fetchProviderModelCatalog({ baseUrl: "https://openrouter.ai/api/v1", apiKey: "original-key", includeNonChat: true }, request as typeof fetch);
    expect(result.models.map(row => row.id)).toEqual(speech === "complete" || speech === "partial" ? ["chat", "speech"] : ["chat"]);
    expect(result.complete).toBe(speech === "complete");
    expect([...result.listedIds]).toEqual(["chat"]);
    expect(request.mock.calls.map(([url]) => String(url))).toEqual([
      "https://openrouter.ai/api/v1/models", "https://openrouter.ai/api/v1/models?output_modalities=speech"
    ]);
    expect(request.mock.calls[0]?.[1]?.signal).toBe(request.mock.calls[1]?.[1]?.signal);
  });

  it.each(["https://openrouter.ai/api/v1/models?output_modalities=text", "https://relay.example/api/v1/models"])(
    "keeps the explicit scope of %s", async modelsEndpoint => {
      const request = vi.fn(async () => Response.json({ data: [{ id: "chat" }] }));
      const result = await fetchProviderModelCatalog({ baseUrl: new URL("..", modelsEndpoint).toString(), modelsEndpoint,
        apiKey: "scoped-key", includeNonChat: true }, request as typeof fetch);
      expect(result.models.map(model => model.id)).toEqual(["chat"]);
      expect(result.complete).toBe(true);
      expect(request).toHaveBeenCalledExactlyOnceWith(modelsEndpoint,
        expect.objectContaining({ headers: expect.objectContaining({ authorization: "Bearer scoped-key" }) }));
    });

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
    await expect(fetchProviderModelCatalog({ baseUrl: "https://api.example.test/v1", modelsEndpoint,
      api: "anthropic-messages", apiKey: "test-key" }, request as typeof fetch)).resolves.toMatchObject({
      listedIds: new Set(["listed-model"]), complete: false
    });
    expect(request.mock.calls.map(([url]) => url)).toEqual([modelsEndpoint, `${modelsEndpoint}?after_id=${encodeURIComponent(cursor)}`]);
    expect(request.mock.calls[0]?.[1]?.signal).toBe(request.mock.calls[1]?.[1]?.signal);
  });

  it("keeps an Anthropic before_id listing partial and pages backwards with first_id", async () => {
    const baseUrl = "https://api.example.test/v1";
    const modelsEndpoint = `${baseUrl}/models?before_id=anchor&scope=team`;
    const request = vi.fn(async (input: string | URL | Request) => {
      const query = new URL(String(input)).searchParams;
      if (query.has("after_id")) return new Response(null, { status: 400 });
      return query.get("before_id") === "anchor"
        ? Response.json({ data: [{ id: "b" }, { id: "c" }], has_more: true, first_id: "b", last_id: "c" })
        : Response.json({ data: [{ id: "a" }], has_more: false, first_id: "a", last_id: "a" });
    });
    const catalog = await fetchProviderModelCatalog({ api: "anthropic-messages", baseUrl, modelsEndpoint }, request);
    expect(request.mock.calls.map(([url]) => String(url))).toEqual([modelsEndpoint, `${baseUrl}/models?before_id=b&scope=team`]);
    expect(catalog.listedIds).toEqual(new Set(["a", "b", "c"]));
    expect(catalog.complete).toBe(false);
  });

  it.each([
    { fields: { next_cursor: "second" }, query: "cursor" },
    { fields: { nextPageToken: "second" }, query: "pageToken" },
    { fields: { next_page_token: "second" }, query: "page_token" },
    { fields: { next: "?page=second" }, query: "page" }
  ])("collects a second page via $query on the original endpoint", async ({ fields, query }) => {
    const baseUrl = "https://api.example.test/v1";
    const request = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer catalog-key");
      expect(init?.redirect).toBe("error");
      return url === `${baseUrl}/models`
        ? Response.json({ data: [{ id: "a" }, { id: "b" }], ...fields, pagination: { totalPages: 2 } })
        : Response.json({ data: [{ id: "c" }] });
    });
    const catalog = await fetchProviderModelCatalog({ baseUrl, apiKey: "catalog-key" }, request);
    expect(catalog.complete).toBe(true);
    expect(catalog.listedIds).toEqual(new Set(["a", "b", "c"]));
    expect(catalog.models.map(model => model.id)).toEqual(["a", "b", "c"]);
    expect(request.mock.calls.map(([url]) => url)).toEqual([`${baseUrl}/models`, `${baseUrl}/models?${query}=second`]);
  });

  it.each(["https://unrelated.example.test/v1/models", "/v1/account"])("retains a partial catalog for a next link to %s", async next => {
    const request = vi.fn(async () => Response.json({ data: [{ id: "a" }] }, { headers: { link: `<${next}>; rel="next"` } }));
    await expect(fetchProviderModelCatalog({ baseUrl: "https://api.example.test/v1", apiKey: "catalog-key" }, request))
      .resolves.toMatchObject({ listedIds: new Set(["a"]), complete: false });
    expect(request).toHaveBeenCalledOnce();
  });

  it("retains a complete token quote when a duplicate on the next page omits pricing", async () => {
    const baseUrl = "https://openrouter.ai/api/v1";
    const architecture = { output_modalities: ["text"] };
    const pricing = { prompt: "0.00001", completion: "0.00002", input_cache_read: "0.000003", input_cache_write: "0.000004" };
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ data: [{ id: "priced", architecture, pricing }], next_cursor: "second" }))
      .mockResolvedValueOnce(Response.json({ data: [{ id: "priced", name: "Named model", architecture }] }));
    const catalog = await fetchProviderModelCatalog({ baseUrl, apiKey: "catalog-key" }, request);
    expect(catalog.complete).toBe(true);
    expect(catalog.models).toEqual([expect.objectContaining({
      id: "priced", name: "Named model", cost: { input: 10, output: 20, cacheRead: 3, cacheWrite: 4 }
    })]);
  });

  it("follows an HTTP next link without switching the configured catalog filter", async () => {
    const endpoint = "https://api.example.test/v1/models";
    const spec = { baseUrl: "https://api.example.test/v1", modelsEndpoint: `${endpoint}?scope=approved`, apiKey: "catalog-key" };
    const request = vi.fn(async (url: string | URL | Request) => {
      if (url === spec.modelsEndpoint) return Response.json({ data: [{ id: "first" }] }, { headers: { link: '<?page=2>; rel="next"' } });
      expect(url).toBe(`${endpoint}?page=2&scope=approved`);
      return Response.json({ data: [{ id: "second" }] });
    });
    expect(await fetchProviderModelCatalog(spec, request)).toMatchObject({ complete: true, listedIds: new Set(["first", "second"]) });
    const differentScope = vi.fn(async () => Response.json({ data: [{ id: "first" }], next: "?page=2&scope=other" }));
    expect(await fetchProviderModelCatalog(spec, differentScope)).toMatchObject({ complete: false, listedIds: new Set(["first"]) });
    expect(differentScope).toHaveBeenCalledOnce();
    const relative = vi.fn(async (url: string | URL | Request) => {
      expect(url).toBe(`${endpoint}?scope=approved`);
      return Response.json({ data: [{ id: "relative" }] });
    });
    await expect(fetchProviderModels({ ...spec, modelsEndpoint: "/v1/models?scope=approved" }, relative))
      .resolves.toMatchObject([{ id: "relative" }]);
    for (const path of ["//other.example.test/v1/models?scope=approved", `${endpoint}?api_key=unsafe`, `${endpoint}?client_version=wrong`]) {
      await expect(fetchProviderModels({ ...spec, modelsEndpoint: path }, relative)).rejects.toMatchObject({ code: "unavailable" });
    }
    expect(relative).toHaveBeenCalledOnce();
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
