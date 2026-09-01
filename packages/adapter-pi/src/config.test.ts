import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { piModelOutputTokenLimit, provisionManagedCatalog, supportedPiThinkingLevels } from "./config.js";
import { mkdtemp } from "./test-paths.js";

describe("managed Pi catalog", () => {
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
        { id: "bridge/priority", logicalId: "priority", supportsFastMode: true, defaultVisible: false },
        { id: "standard" }
      ]
    }]);
    expect(result.models).toEqual(expect.arrayContaining([
      expect.objectContaining({ modelId: "bridge/priority", logicalId: "priority", supportsFastMode: true, defaultVisible: false }),
      expect.objectContaining({ modelId: "standard", supportsFastMode: false, defaultVisible: true })
    ]));
    const serialized = await readFile(join(home, "models.json"), "utf8");
    expect(serialized).not.toContain("supportsFastMode");
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
