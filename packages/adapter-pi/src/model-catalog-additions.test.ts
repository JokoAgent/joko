import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { zstdDecompressSync } from "node:zlib";
import { clampThinkingLevel, type SimpleStreamOptions } from "@earendil-works/pi-ai";
import { buildBaseOptions } from "@earendil-works/pi-ai/api/simple-options";
import { describe, expect, it, vi } from "vitest";
import { createPiModelCatalogAdditions, type createPiModelCatalogAdditionsFactory } from "./model-catalog-additions.js";
import { MANAGED_MODEL_CATALOG_RUNTIME_SOURCE } from "./model-catalog-runtime.js";

async function nativeRuntime() {
  return await ModelRuntime.create({
    modelsPath: null, allowModelNetwork: false, refreshOnCreate: false,
    credentials: { read: async () => undefined, list: async () => [], modify: async () => undefined, delete: async () => {} }
  });
}

describe("Pi model catalog additions", () => {
  it("preserves both native Astra routes and their fixed installed-runtime metadata", async () => {
    const runtime = await nativeRuntime();
    const additions = createPiModelCatalogAdditions();
    for (const [providerId, api, minimal] of [
      ["openai", "openai-responses", null],
      ["openai-codex", "openai-codex-responses", "low"]
    ] as const) {
      const provider = runtime.getProvider(providerId)!;
      const extended = additions.extendProvider(provider);
      expect(extended.auth).toBe(provider.auth);
      expect(extended.filterModels).toBe(provider.filterModels);
      expect(extended.refreshModels).toBe(provider.refreshModels);
      expect(extended.getModels()).toEqual(expect.arrayContaining([...provider.getModels()]));
      runtime.registerNativeProvider(extended);
      const astra = runtime.getModel(providerId, "gpt-6-astra")!;
      expect(astra).toMatchObject({ api, contextWindow: 272_000, maxTokens: 128_000, input: ["text", "image"],
        thinkingLevelMap: { off: null, minimal, xhigh: "xhigh", max: "max" },
        cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5,
          tiers: [{ inputTokensAbove: 272_000, input: 20, output: 75, cacheRead: 2, cacheWrite: 25 }] } });
      const future = { ...astra, contextWindow: 872_000, maxTokens: 160_000 };
      const refreshed = additions.extendProvider({ ...provider, getModels: () => [future] });
      expect(refreshed.getModels()).toEqual([future]);
      expect(refreshed.getModels()[0]).toBe(future);
      const custom = { ...provider, baseUrl: "https://gateway.example.test/v1" };
      expect(additions.extendProvider(custom)).toBe(custom);
    }
  });

  it("projects only the admitted exact provider routes and keeps unknown subscription pricing unknown", async () => {
    const runtime = await nativeRuntime();
    const additions = createPiModelCatalogAdditions();
    const models = (providerId: string) => additions.extendProvider(runtime.getProvider(providerId)!).getModels();

    expect(models("kimi-coding").find((model) => model.id === "kimi-for-coding")).toMatchObject({
      name: "Kimi K2.8 Preview",
      contextWindow: 1_048_576,
      maxTokens: 32_768,
      input: ["text", "image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      thinkingLevelMap: { low: "low", high: "high", max: "max" }
    });
    expect(additions.referenceCatalogMetadata(models("kimi-coding").find((model) => model.id === "kimi-for-coding")!))
      .toEqual({ cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });

    const deepSeek = models("deepseek");
    expect(deepSeek.some((model) => model.id === "deepseek-v4-flash")).toBe(false);
    expect(deepSeek.find((model) => model.id === "deepseek-flash")).toMatchObject({
      contextWindow: 1_048_576,
      maxTokens: 384_000,
      input: ["text", "image"],
      cost: { input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0 }
    });
    expect(deepSeek.find((model) => model.id === "deepseek-v4-pro")?.cost)
      .toEqual({ input: 1.32, output: 3.96, cacheRead: 0.044, cacheWrite: 0 });

    const xiaomi = models("xiaomi");
    expect(xiaomi.filter((model) => model.id.startsWith("mimo-v2.6")).map((model) => model.id)).toEqual([
      "mimo-v2.6-pro", "mimo-v2.6-flash", "mimo-v2.6-pro-ultraspeed"
    ]);
    expect(xiaomi.find((model) => model.id === "mimo-v2.6-pro")).toMatchObject({
      contextWindow: 1_048_576,
      maxTokens: 131_072,
      reasoning: true,
      input: ["text", "image"],
      thinkingLevelMap: { off: null, minimal: null, low: null, medium: null, high: null, xhigh: null, max: null }
    });
    expect(xiaomi.find((model) => model.id === "mimo-v2.6-pro-ultraspeed")?.input).toEqual(["text"]);
    expect(additions.referenceCatalogMetadata(xiaomi.find((model) => model.id === "mimo-v2.6-flash")!))
      .toMatchObject({
        cost: { input: 1, output: 2, cacheRead: 0.02, cacheWrite: 0 },
        pricing: { currencyCode: "CNY" }
      });
    expect(additions.referenceCatalogMetadata(xiaomi.find((model) => model.id === "mimo-v2.5")!))
      .toEqual({ defaultVisible: false });

    const xiaomiTokenPlan = models("xiaomi-token-plan-cn");
    expect(xiaomiTokenPlan.filter((model) => model.id.startsWith("mimo-v2.6")).map((model) => model.id)).toEqual([
      "mimo-v2.6-pro", "mimo-v2.6-flash"
    ]);
    expect(xiaomiTokenPlan.find((model) => model.id === "mimo-v2.6-pro")).toMatchObject({
      provider: "xiaomi-token-plan-cn",
      baseUrl: "https://token-plan-cn.xiaomimimo.com/v1",
      input: ["text", "image"]
    });
    expect(additions.referenceCatalogMetadata(
      xiaomiTokenPlan.find((model) => model.id === "mimo-v2.6-pro")!
    )).toMatchObject({ pricing: { currencyCode: "CNY" } });

    const globalK3 = models("moonshotai").find((model) => model.id === "kimi-k3")!;
    const chinaK3 = models("moonshotai-cn").find((model) => model.id === "kimi-k3")!;
    expect(globalK3.cost).toEqual({ input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3 });
    expect(additions.referenceCatalogMetadata(chinaK3)).toMatchObject({
      cost: { input: 20, output: 100, cacheRead: 2, cacheWrite: 20 },
      pricing: { currencyCode: "CNY" }
    });

    const custom = { ...runtime.getProvider("xiaomi")!, baseUrl: "https://gateway.example.test/v1" };
    expect(additions.extendProvider(custom)).toBe(custom);
  });

  it("exposes the fixed xAI Fast target and rewrites that exact route without a service tier", async () => {
    const runtime = await nativeRuntime();
    const additions = createPiModelCatalogAdditions();
    const native = runtime.getProvider("xai")!;
    const projected = additions.extendProvider(native).getModels();
    const parent = projected.find((model) => model.id === "grok-4.7")!;
    expect(parent).toMatchObject({ contextWindow: 500_000, maxTokens: 500_000, input: ["text", "image"] });
    expect(projected.some((model) => model.id === "grok-4.7-build-fast")).toBe(false);
    expect(additions.referenceCatalogMetadata(parent)).toMatchObject({
      supportsFastMode: true,
      pricing: {
        fastModeMultiplier: 2,
        longContext: { inputTokenThreshold: 199_999, fastInputTokenThreshold: 200_000, fastModeMultiplier: 1.5 }
      }
    });
    expect(additions.prepareProviderPayload(parent, {
      model: "grok-4.7", service_tier: "priority", input: "hello"
    }, true)).toEqual({ model: "grok-4.7-build-fast", input: "hello" });
    expect(additions.prepareProviderPayload({ ...parent, baseUrl: "https://gateway.example.test/v1" }, {
      model: "grok-4.7", input: "hello"
    }, true)).toEqual({ model: "grok-4.7", input: "hello", service_tier: "priority" });
  });

  it("loads the provisioned module and normalizes only Astra Responses requests without mutating caller options", async () => {
    const { createPiModelCatalogAdditions: provisioned } = await import(
      `data:text/javascript;base64,${Buffer.from(MANAGED_MODEL_CATALOG_RUNTIME_SOURCE).toString("base64")}`
    ) as { createPiModelCatalogAdditions: typeof createPiModelCatalogAdditionsFactory };
    const normalize = provisioned({ buildBaseOptions, clampThinkingLevel }).normalizeResponsesPayload;
    const input = {
      temperature: 0.2, top_p: 0.8, top_logprobs: 2, prompt_cache_retention: "24h",
      prompt_cache_options: { mode: "explicit", ttl: "5m" },
      include: ["message.output_text.logprobs", "reasoning.encrypted_content"],
      reasoning: { effort: "minimal", summary: "auto" }, service_tier: "priority"
    };
    expect(normalize({ id: "openai/gpt-6-astra[1m]", api: "openai-responses" }, input)).toEqual({
      prompt_cache_options: { mode: "explicit", ttl: "5m" }, include: ["reasoning.encrypted_content"],
      reasoning: { effort: "low", summary: "auto" }, service_tier: "priority"
    });
    expect(input.reasoning.effort).toBe("minimal");
    expect(input.temperature).toBe(0.2);
    expect(normalize({ id: "gpt-6-astra", api: "openai-responses" }, {})).toEqual({ prompt_cache_options: { ttl: "30m" } });
    for (const model of [{ id: "gpt-5.5", api: "openai-responses" }, { id: "gpt-6-astra", api: "openai-codex-responses" }]) {
      expect(normalize(model, input)).toBe(input);
    }
  });

  it.each([
    ["openai", true], ["openai", false], ["openai-codex", true], ["openai-codex", false]
  ] as const)("uses the provisioned native %s stream to price actual long-context usage with Fast=%s", async (providerId, fast) => {
    const runtime = await nativeRuntime();
    const { createPiModelCatalogAdditions: provisioned } = await import(
      `data:text/javascript;base64,${Buffer.from(MANAGED_MODEL_CATALOG_RUNTIME_SOURCE).toString("base64")}`
    ) as { createPiModelCatalogAdditions: typeof createPiModelCatalogAdditionsFactory };
    const additions = provisioned({ buildBaseOptions, clampThinkingLevel });
    const provider = additions.extendProvider(runtime.getProvider(providerId)!, () => fast);
    const model = provider.getModels().find((candidate) => candidate.id === "gpt-6-astra")!;
    let request: Record<string, unknown> | undefined;
    const stream = provider.streamSimple(model, { messages: [] }, {
      apiKey: providerId === "openai-codex" ? testSubscriptionToken() : "test-placeholder",
      reasoning: "low",
      transport: "sse",
      fetch: async (_url, init) => {
        request = await requestPayload(init);
        return new Response('event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed","output":[],"usage":{"input_tokens":300000,"output_tokens":1000,"input_tokens_details":{"cached_tokens":100000}}}}\n\n', {
          status: 200, headers: { "content-type": "text/event-stream" }
        });
      },
      onPayload: (payload) => additions.normalizeResponsesPayload(model, payload)
    });
    const message = await stream.result();
    expect(message.stopReason, message.errorMessage).not.toBe("error");
    expect(request).toMatchObject({ model: "gpt-6-astra", service_tier: fast ? "priority" : "default" });
    if (providerId === "openai") expect(request).toMatchObject({ prompt_cache_options: { ttl: "30m" } });
    expect(request).not.toHaveProperty("prompt_cache_retention");
    expect(message.usage).toMatchObject({ input: 200_000, cacheRead: 100_000, output: 1_000 });
    expect(message.usage.cost.input).toBeCloseTo(fast ? 8 : 4);
    expect(message.usage.cost.cacheRead).toBeCloseTo(fast ? 0.4 : 0.2);
    expect(message.usage.cost.output).toBeCloseTo(fast ? 0.15 : 0.075);
    expect(message.usage.cost.total).toBeCloseTo(fast ? 8.55 : 4.275);
  });

  it.each(["openai", "openai-codex"] as const)("preserves native %s simple-option, auth and callback semantics", async (providerId) => {
    const runtime = await nativeRuntime();
    const native = runtime.getProvider(providerId)!;
    const extended = createPiModelCatalogAdditions().extendProvider(native, () => true);
    const astra = extended.getModels().find((model) => model.id === "gpt-6-astra")!;
    const model = { ...astra, contextWindow: 8_192, maxTokens: 32_768,
      thinkingLevelMap: { off: null, minimal: null, low: null, medium: null, high: "high", xhigh: null, max: null },
      samplingParams: { top_p: 0.4, temperature: 0.5 } };
    const requests: Record<string, unknown>[] = [];
    const headers: Headers[] = [];
    const onPayload = vi.fn((payload: unknown) => payload);
    const onResponse = vi.fn();
    const options: SimpleStreamOptions = {
      ...(providerId === "openai-codex" ? { apiKey: testSubscriptionToken() } : {}),
      headers: { Authorization: "Bearer header-placeholder", "X-Request-Context": "test" },
      reasoning: "max", maxTokens: 32_768, temperature: 0.2, samplingParams: { top_p: 0.7 },
      transport: "sse", toolChoice: "none", cacheRetention: "long", sessionId: "catalog-session",
      signal: new AbortController().signal, timeoutMs: 5_000, maxRetries: 0, maxRetryDelayMs: 0,
      onPayload, onResponse,
      fetch: async (_url, init) => {
        requests.push(await requestPayload(init));
        headers.push(new Headers(init?.headers));
        return new Response('event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed","output":[],"usage":{"input_tokens":10,"output_tokens":1}}}\n\n', {
          status: 200, headers: { "content-type": "text/event-stream" }
        });
      }
    };
    const context = { messages: [{ role: "user" as const, content: "Check options.", timestamp: 0 }] };
    for (const provider of [native, extended]) {
      const message = await provider.streamSimple(model, context, options).result();
      expect(message.stopReason, message.errorMessage).not.toBe("error");
    }
    expect(requests).toHaveLength(2);
    const { service_tier: serviceTier, ...request } = requests[1]!;
    expect(serviceTier).toBe("priority");
    expect(request).toEqual(requests[0]);
    expect(request.reasoning).toMatchObject({ effort: "high" });
    expect(request.tool_choice).toBe("none");
    if (providerId === "openai") {
      expect(request.max_output_tokens).toBeLessThan(8_192);
      expect(request).toMatchObject({ top_p: 0.7, temperature: 0.5 });
      expect(headers.map((value) => value.get("authorization"))).toEqual(["Bearer header-placeholder", "Bearer header-placeholder"]);
    }
    expect(headers.map((value) => value.get("x-request-context"))).toEqual(["test", "test"]);
    expect(onPayload).toHaveBeenCalledTimes(2);
    expect(onResponse).toHaveBeenCalledTimes(2);
    const invalidOptions = { ...options, apiKey: undefined, headers: {} };
    const errors = await Promise.all([native, extended].map(async (provider) =>
      (await provider.streamSimple(model, context, invalidOptions).result()).errorMessage));
    expect(errors[0]).toContain("No API key");
    expect(errors[1]).toBe(errors[0]);
    expect(requests).toHaveLength(2);
  });
});

function testSubscriptionToken(): string {
  return `test.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test-account" } })).toString("base64url")}.signature`;
}

async function requestPayload(init?: RequestInit): Promise<Record<string, unknown>> {
  const bytes = Buffer.from(await new Response(init?.body).arrayBuffer());
  const body = new Headers(init?.headers).get("content-encoding") === "zstd" ? zstdDecompressSync(bytes) : bytes;
  return JSON.parse(body.toString("utf8")) as Record<string, unknown>;
}
