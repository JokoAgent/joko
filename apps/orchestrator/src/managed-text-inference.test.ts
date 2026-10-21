import { describe, expect, it, vi } from "vitest";
import type { ProviderInferenceRoute } from "./credential-manager.js";
import { requestManagedTextInference } from "./personalization-inference.js";

const route: ProviderInferenceRoute = {
  backendId: "backend", providerId: "provider", modelId: "model", generationId: "generation",
  api: "openai-completions", baseUrl: "https://provider.example/v1", headers: {}, supportsImages: false
};
const response = (value: unknown) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
const request = { route, system: "Give a short label.", user: "Label this task.", maxTokens: 160, timeoutMs: 1_000 };

describe("bounded auxiliary output-budget recovery", () => {
  it.each([
    ["openai-completions", { choices: [{ finish_reason: "length", message: { content: "", reasoning_content: "private reasoning" } }] }, { choices: [{ message: { content: "Label" } }] }, "max_tokens"],
    ["anthropic-messages", { stop_reason: "max_tokens", content: [{ type: "thinking", thinking: "private reasoning" }] }, { content: [{ type: "text", text: "Label" }] }, "max_tokens"],
    ["openai-responses", { status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [] }, { output_text: "Label" }, "max_output_tokens"]
  ] as const)("retries an empty %s length stop once on the same route", async (api, empty, complete, field) => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(response(empty)).mockResolvedValueOnce(response(complete));
    await expect(requestManagedTextInference({ ...request, route: { ...route, api }, fetch })).resolves.toBe("Label");
    expect(fetch).toHaveBeenCalledTimes(2);
    const bodies = fetch.mock.calls.map(call => JSON.parse(call[1]!.body as string) as Record<string, unknown>);
    expect(bodies[0]![field]).toBe(160);
    expect(bodies[1]![field]).toBe(4_096);
    expect(bodies.map(body => body["model"])).toEqual(["model", "model"]);
  });

  it("uses observed usage with a hard ceiling and never retries a second empty result", async () => {
    const exhausted = { choices: [{ finish_reason: "length", message: { content: "" } }], usage: { completion_tokens: 99_999 } };
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => response(exhausted));
    await expect(requestManagedTextInference({ ...request, fetch })).rejects.toMatchObject({ message: "EMPTY_RESPONSE" });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetch.mock.calls[1]![1]!.body as string).max_tokens).toBe(16_384);
  });

  it("does not retry a completed empty response, visible partial output or failed HTTP request", async () => {
    for (const value of [
      { choices: [{ finish_reason: "stop", message: { content: "" } }] },
      { choices: [{ finish_reason: "length", message: { content: "Visible partial answer" } }] }
    ]) {
      const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => response(value));
      const pending = requestManagedTextInference({ ...request, fetch });
      if (value.choices[0]!.message.content) await expect(pending).resolves.toBe("Visible partial answer");
      else await expect(pending).rejects.toMatchObject({ message: "EMPTY_RESPONSE" });
      expect(fetch).toHaveBeenCalledTimes(1);
    }
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response("", { status: 503 }));
    await expect(requestManagedTextInference({ ...request, fetch })).rejects.toMatchObject({ message: "HTTP_503" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("revalidates the owner before budget recovery and retains the original cancellation", async () => {
    const owner = new AbortController();
    let current = true;
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => {
      current = false;
      return response({ choices: [{ finish_reason: "length", message: { content: "" } }] });
    });
    await expect(requestManagedTextInference({ ...request, fetch, signal: owner.signal, assertCurrent: () => {
      if (!current) throw new Error("Owner changed");
    } })).rejects.toThrow("Owner changed");
    expect(fetch).toHaveBeenCalledTimes(1);
    fetch.mockClear().mockImplementation(async () => {
      owner.abort();
      return response({ choices: [{ finish_reason: "length", message: { content: "" } }] });
    });
    await expect(requestManagedTextInference({ ...request, fetch, signal: owner.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
