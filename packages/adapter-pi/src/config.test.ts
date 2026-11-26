import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { modelTokenPricesAt } from "@joko/core";
import { describe, expect, it } from "vitest";
import {
  piModelOutputTokenLimit,
  provisionManagedCatalog,
  supportedPiThinkingLevels,
  writeMcpDescriptor
} from "./config.js";
import { mkdtemp } from "./test-paths.js";

describe("managed Pi catalog", () => {
  it("keeps configured speech models outside the native chat catalog and strips the declared purpose", async () => {
    const home = await mkdtemp(join(tmpdir(), "joko-pi-model-purpose-"));
    const result = await provisionManagedCatalog(home, [{ id: "mixed", models: [
      { id: "chat", mode: "chat" }, { id: "ordinary" }, { id: "tts-1" },
      { id: "custom-speech", mode: "audio_speech" }, { id: "transcribe", mode: "audio_transcription" }
    ] }, { id: "speech-only", models: [{ id: "custom", mode: "audio_speech" }] }]);
    expect(result.models.map(model => [model.providerId, model.modelId])).toEqual([["mixed", "chat"], ["mixed", "ordinary"]]);
    const native = JSON.parse(await readFile(join(home, "models.json"), "utf8"));
    expect(Object.keys(native.providers)).toEqual(["mixed"]);
    expect(native.providers.mixed.models.map((model: { id: string }) => model.id)).toEqual(["chat", "ordinary"]);
    for (const model of native.providers.mixed.models) expect(model).not.toHaveProperty("mode");
  });

  it("preserves declared advanced metadata while keeping product fields out of native model configuration", async () => {
    const home = await mkdtemp(join(tmpdir(), "joko-pi-advanced-metadata-"));
    const result = await provisionManagedCatalog(home, [{ id: "gateway", api: "openai-completions", models: [{ id: "declared-model", reasoning: true,
      contextWindow: 32_000, maxTokens: 4_000, input: ["text"], description: "Declared description", defaultEffort: "medium", supportsFastMode: false,
      referenceApi: "anthropic-messages", displayThinkingLevels: ["high"], declaredOutputModalities: ["text"] }, { id: "unknown-model" }] }]);
    expect(result.models[0]).toMatchObject({ description: "Declared description", defaultEffort: "medium", displayThinkingLevels: ["high"], declaredInputModalities: ["text"], declaredSupportsImages: false,
      declaredSupportsFastMode: false, protocolMode: "matching", contextWindowSource: "declared", maxOutputTokensSource: "declared" });
    expect(result.models[1]!.defaultEffort).toBeUndefined(); expect(result.models[1]!.declaredInputModalities).toBeUndefined();
    const native = JSON.parse(await readFile(join(home, "models.json"), "utf8")).providers.gateway.models[0];
    for (const key of ["description", "defaultEffort", "displayThinkingLevels", "referenceApi", "declaredOutputModalities", "supportsFastMode"]) expect(native[key]).toBeUndefined();
  });
  it("keeps estimated limits labeled in the public catalog while passing only numeric limits to Pi", async () => {
    const home = await mkdtemp(join(tmpdir(), "joko-pi-estimated-limits-"));
    const result = await provisionManagedCatalog(home, [{ id: "local", models: [{ id: "capacity-only", contextWindow: 64_000,
      contextWindowMax: 64_000, discoveredMetadata: { contextWindowMax: 64_000 }, metadataOverrides: [],
      maxTokens: 16_384, contextWindowSource: "estimated", maxOutputTokensSource: "estimated" }] }]);
    expect(result.models[0]).toMatchObject({ contextWindow: 64_000, maxOutputTokens: 16_384, contextWindowSource: "estimated", maxOutputTokensSource: "estimated" });
    expect(result.models[0]).toMatchObject({ contextWindow: 64_000, contextWindowMax: 64_000 });
    const model = JSON.parse(await readFile(join(home, "models.json"), "utf8")).providers.local.models[0];
    for (const key of ["contextWindowMax", "discoveredMetadata", "metadataOverrides"]) expect(model).not.toHaveProperty(key);
    expect(model).toMatchObject({ contextWindow: 64_000, maxTokens: 16_384 });
    expect(model).not.toHaveProperty("contextWindowSource"); expect(model).not.toHaveProperty("maxOutputTokensSource");
  });

  it("writes a current object output schema and rejects non-object roots", async () => {
    const home = await mkdtemp(join(tmpdir(), "joko-pi-mcp-schema-"));
    const path = join(home, "mcp.json");
    const descriptor = {
      endpoint: "http://127.0.0.1:4318/internal/mcp",
      generation: 7,
      sessionId: "session-7",
      targetId: "target-7",
      tools: [{
        serverId: "fixture",
        name: "structured",
        description: "Structured output",
        inputSchema: { type: "object" },
        outputSchema: { type: "object", properties: { value: { type: "string" } } },
        requiresPermission: false
      }]
    } as const;
    await writeMcpDescriptor(path, descriptor);
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
      tools: [{ outputSchema: { type: "object", properties: { value: { type: "string" } } } }]
    });
    await expect(writeMcpDescriptor(path, {
      ...descriptor,
      tools: [{ ...descriptor.tools[0], outputSchema: { type: "array" } }]
    })).rejects.toMatchObject({ publicError: { code: "PI_MCP_INVALID_SCHEMA" } });
  });

  it("writes environment references and fail-closed project trust without secret values", async () => {
    const home = await mkdtemp(join(tmpdir(), "joko-pi-catalog-"));
    const result = await provisionManagedCatalog(
      home,
      [
        {
          id: "gateway",
          baseUrl: "https://gateway.example/v1",
          api: "openai-responses",
          apiKeyEnv: "JOKO_GATEWAY_KEY",
          models: [{ id: "model-a", name: "Model A", reasoning: true, input: ["text", "image"] }]
        }
      ],
      { retry: { enabled: true, maxRetries: 2 } }
    );
    const models = await readFile(join(home, "models.json"), "utf8");
    const settings = await readFile(join(home, "settings.json"), "utf8");
    expect(models).toContain('"apiKey": "$JOKO_GATEWAY_KEY"');
    expect(JSON.parse(models).providers.gateway.models[0]).toMatchObject({
      contextWindow: 128_000,
      maxTokens: 65_536
    });
    expect(models).not.toContain("actual-secret");
    expect(settings).toContain('"defaultProjectTrust": "never"');
    expect(JSON.parse(settings)).toMatchObject({ compaction: { reserveTokens: 0 } });
    expect(settings).not.toContain("thresholdPercent");
    expect(result.models[0]).toMatchObject({ providerId: "gateway", modelId: "model-a", supportsImages: true });
    expect(result.secretEnvironmentNames).toContain("JOKO_GATEWAY_KEY");
  });

  it("keeps authoritative model limits and bounds unknown limits by context", () => {
    expect(piModelOutputTokenLimit(8_192, 128_000)).toBe(8_192);
    expect(piModelOutputTokenLimit(undefined, 32_000)).toBe(32_000);
    expect(piModelOutputTokenLimit(undefined, 128_000)).toBe(65_536);
    expect(piModelOutputTokenLimit(undefined, undefined)).toBe(65_536);
  });

  it("distinguishes an explicit zero price from a missing upstream quote", async () => {
    const home = await mkdtemp(join(tmpdir(), "joko-pi-catalog-pricing-"));
    const result = await provisionManagedCatalog(home, [{
      id: "gateway",
      keyless: true,
      models: [
        { id: "free", cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
        { id: "unknown" }
      ]
    }]);
    expect(result.models.find((model) => model.modelId === "free")?.pricing).toMatchObject({
      source: "upstream",
      currencyCode: "USD"
    });
    expect(result.models.find((model) => model.modelId === "unknown")?.pricing).toBeUndefined();
  });

  it("projects the mainland Token Plan reference price on an independent managed Pi account", async () => {
    const home = await mkdtemp(join(tmpdir(), "joko-pi-regional-price-"));
    const model = { id: "mimo-v2.6-pro" };
    const endpoint = "https://token-plan-cn.xiaomimimo.com/v1";
    const common = { baseUrl: endpoint, api: "openai-completions" as const, models: [model] };
    const projected = await provisionManagedCatalog(home, [
      { ...common, id: "independent-cn", apiKeyEnv: "INDEPENDENT_CN_KEY" },
      { ...common, id: "alternate-path", baseUrl: `${endpoint}/alternate`, apiKeyEnv: "ALTERNATE_PATH_KEY" },
      { ...common, id: "different-protocol", api: "openai-responses", apiKeyEnv: "DIFFERENT_PROTOCOL_KEY" },
      { ...common, id: "owner-price", apiKeyEnv: "OWNER_PRICE_KEY", models: [{ ...model, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] }
    ]);
    const find = (providerId: string) => projected.models.find(item => item.providerId === providerId)!;
    const priced = find("independent-cn");
    expect(priced).toMatchObject({ providerId: "independent-cn", modelId: model.id, pricing: { source: "providerReference", currencyCode: "CNY" } });
    const prices = modelTokenPricesAt(priced, { at: Date.UTC(2026, 10, 19), inputTokens: 1000, fastMode: false });
    expect(prices).toMatchObject({ currencyCode: "CNY", cost: { input: 3, output: 6 } });
    expect(((prices?.cost.input ?? 0) * 1000 + (prices?.cost.output ?? 0) * 1000) / 1_000_000).toBe(0.009);
    expect(find("alternate-path").pricing).toBeUndefined();
    expect(find("different-protocol").pricing).toBeUndefined();
    expect(find("owner-price")).toMatchObject({ cost: { input: 0, output: 0 }, pricing: { source: "upstream", currencyCode: "USD" } });

    const native = JSON.parse(await readFile(join(home, "models.json"), "utf8"));
    expect(native.providers["independent-cn"]).toMatchObject({ baseUrl: endpoint, apiKey: "$INDEPENDENT_CN_KEY", models: [{ id: model.id }] });
    expect(native.providers["independent-cn"].models[0]).not.toHaveProperty("cost");
  });

  it("uses Pi's null thinking-map sentinel and environment-only override headers", async () => {
    const home = await mkdtemp(join(tmpdir(), "joko-pi-catalog-overrides-"));
    const result = await provisionManagedCatalog(home, [
      {
        id: "gateway",
        baseUrl: "https://gateway.example/v1",
        api: "openai-completions",
        apiKeyEnv: "JOKO_GATEWAY_KEY",
        models: [{ id: "model-a", reasoning: true, thinkingLevelMap: { off: "off", low: "low", high: null } }],
        modelOverrides: {
          "built-in": { headers: { "x-tenant-key": { env: "JOKO_TENANT_KEY" } } }
        }
      }
    ]);
    const models = await readFile(join(home, "models.json"), "utf8");
    expect(models).toContain('"high": null');
    expect(models).toContain('"x-tenant-key": "$JOKO_TENANT_KEY"');
    expect(result.models[0]?.thinkingLevels).toEqual(["off", "minimal", "low", "medium"]);
    expect(result.secretEnvironmentNames).toContain("JOKO_TENANT_KEY");
  });

  it("matches Pi's canonical thinking-level defaults and extended-level opt in", () => {
    expect(supportedPiThinkingLevels(true)).toEqual(["off", "minimal", "low", "medium", "high"]);
    expect(supportedPiThinkingLevels(true, {
      off: null,
      minimal: "minimal",
      low: null,
      medium: null,
      high: "high",
      xhigh: "xhigh",
      max: null,
      future: "future"
    })).toEqual(["minimal", "high", "xhigh"]);
    expect(supportedPiThinkingLevels(false, { xhigh: "xhigh", max: "max" })).toEqual([]);
  });

  it("rejects relative compaction thresholds outside the public 50 through 95 range", async () => {
    const home = await mkdtemp(join(tmpdir(), "joko-pi-catalog-threshold-"));
    await expect(provisionManagedCatalog(home, [], {
      compaction: { thresholdPercent: 49 }
    })).rejects.toMatchObject({ publicError: { code: "PI_SETTINGS_INVALID_NUMBER" } });
    await expect(provisionManagedCatalog(home, [], {
      compaction: { thresholdPercent: 96 }
    })).rejects.toMatchObject({ publicError: { code: "PI_SETTINGS_INVALID_NUMBER" } });
  });

  it("projects host-owned model metadata without leaking it into models.json", async () => {
    const home = await mkdtemp(join(tmpdir(), "joko-pi-catalog-fast-"));
    const result = await provisionManagedCatalog(home, [{
      id: "gateway",
      baseUrl: "https://gateway.example/v1",
      api: "openai-responses",
      keyless: true,
      models: [
        { id: "bridge/priority", logicalId: "priority", supportsFastMode: true, supportsTools: false, defaultVisible: false },
        { id: "standard" }
      ]
    }]);
    expect(result.models).toEqual(expect.arrayContaining([
      expect.objectContaining({ modelId: "bridge/priority", logicalId: "priority", supportsFastMode: true, supportsTools: false, defaultVisible: false }),
      expect.objectContaining({ modelId: "standard", supportsFastMode: false, defaultVisible: true })
    ]));
    const serialized = await readFile(join(home, "models.json"), "utf8");
    expect(serialized).not.toContain("supportsFastMode");
    expect(serialized).not.toContain("supportsTools");
    expect(serialized).not.toContain("defaultVisible");
    expect(serialized).not.toContain("logicalId");
  });

  it("rejects duplicate providers and literal override credentials", async () => {
    const duplicateHome = await mkdtemp(join(tmpdir(), "joko-pi-catalog-duplicate-"));
    const provider = {
      id: "local",
      baseUrl: "http://127.0.0.1:11434/v1",
      api: "openai-completions" as const,
      keyless: true,
      models: [{ id: "model-a" }]
    };
    await expect(provisionManagedCatalog(duplicateHome, [provider, provider])).rejects.toMatchObject({
      publicError: { code: "PI_MODEL_DUPLICATE_PROVIDER" }
    });
    await expect(provisionManagedCatalog(
      await mkdtemp(join(tmpdir(), "joko-pi-catalog-credential-owner-collision-")),
      [{
        ...provider,
        id: "provider-a",
        keyless: undefined,
        apiKeyEnv: "SHARED_PROVIDER_SECRET"
      }, {
        ...provider,
        id: "provider-b",
        keyless: undefined,
        apiKeyEnv: "SHARED_PROVIDER_SECRET"
      }]
    )).rejects.toMatchObject({ publicError: { code: "PI_MODEL_AUTH_ENV_COLLISION" } });

    const secretHome = await mkdtemp(join(tmpdir(), "joko-pi-catalog-inline-secret-"));
    await expect(
      provisionManagedCatalog(secretHome, [
        {
          ...provider,
          modelOverrides: { "built-in": { headers: { authorization: "literal-bearer-value" } } }
        }
      ])
    ).rejects.toMatchObject({ publicError: { code: "PI_MODEL_INLINE_SECRET_DENIED" } });
  });

  it("requires encrypted transport for credentials outside loopback", async () => {
    const credentialed = {
      id: "remote",
      baseUrl: "http://models.example.test/v1",
      api: "openai-completions" as const,
      apiKeyEnv: "REMOTE_API_KEY",
      models: [{ id: "model-a" }]
    };
    await expect(provisionManagedCatalog(
      await mkdtemp(join(tmpdir(), "joko-pi-remote-http-secret-")),
      [credentialed]
    )).rejects.toMatchObject({ publicError: { code: "PI_MODEL_INSECURE_CREDENTIAL_TRANSPORT" } });

    await expect(provisionManagedCatalog(
      await mkdtemp(join(tmpdir(), "joko-pi-remote-http-keyless-")),
      [{ ...credentialed, apiKeyEnv: undefined, keyless: true }]
    )).resolves.toMatchObject({ models: [expect.objectContaining({ providerId: "remote" })] });

    await expect(provisionManagedCatalog(
      await mkdtemp(join(tmpdir(), "joko-pi-loopback-http-secret-")),
      [{ ...credentialed, baseUrl: "http://127.0.0.1:11434/v1" }]
    )).resolves.toMatchObject({ secretEnvironmentNames: ["REMOTE_API_KEY"] });

    await expect(provisionManagedCatalog(
      await mkdtemp(join(tmpdir(), "joko-pi-remote-https-secret-")),
      [{ ...credentialed, baseUrl: "https://models.example.test/v1" }]
    )).resolves.toMatchObject({ secretEnvironmentNames: ["REMOTE_API_KEY"] });
  });
});
