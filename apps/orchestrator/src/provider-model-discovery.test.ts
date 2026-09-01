import { describe, expect, it, vi } from "vitest";

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
      { id: "kept", name: "Kept", contextWindow: 128_000 },
      { id: "new", name: "New", contextWindow: 1_000_000 }
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
      { id: "model-b", name: "Model B" }
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
});
