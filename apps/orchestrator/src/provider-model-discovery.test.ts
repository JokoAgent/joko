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
    }, vi.fn(async () => new Response(body)) as typeof fetch)).resolves.toEqual([{ id: "model", name: MULTILINGUAL_FIXTURES.modelName }]);
    expect(body.locked).toBe(false);
  });
});
