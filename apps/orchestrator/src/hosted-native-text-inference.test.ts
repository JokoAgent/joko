import type { BackendAdapter, NativeTextInferenceInput, ProviderModel } from "@joko/core";
import { OperationalStore } from "@joko/store";
import { afterEach, expect, it, vi } from "vitest";
import { createHostedNativeTextInference } from "./hosted-native-text-inference.js";
import type { CredentialModelRoute, ModelRouteCatalog } from "./personalization-inference.js";

const stores: OperationalStore[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });
function fixture(managed: boolean) {
  const store = new OperationalStore(":memory:"); stores.push(store);
  const model: ProviderModel = { providerId: "api", modelId: "model", displayName: "Model", api: "openai-completions",
    contextWindow: 32768, maxOutputTokens: 4096, supportsImages: true, thinkingLevels: [], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  store.upsertBackend({ id: "native", adapterKind: "pi", instanceGeneration: 7, displayName: "Native", version: "1", health: "healthy",
    installationState: "installed", authenticationState: "not_required", capabilities: new Map(), models: [model], tools: [], diagnostics: [] });
  const native = vi.fn(async (input: NativeTextInferenceInput) => { input.assertCurrent(); return "native reply"; });
  let adapter = { inferNativeText: native } as unknown as BackendAdapter;
  let generation = "original";
  const route = (): CredentialModelRoute => ({ backendId: "native", providerId: "api", modelId: "model", generationId: generation,
    api: "openai-completions", baseUrl: "https://model.invalid/v1", authorization: "Bearer private-provider-key", headers: {}, supportsImages: true });
  const routes: ModelRouteCatalog = { list: () => [], resolve: () => managed ? route() : undefined };
  const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify({ choices: [{ message: { content: "managed reply" } }] }),
    { headers: { "content-type": "application/json" } }));
  const infer = createHostedNativeTextInference({ store, registry: { adapter: () => adapter }, routes, fetch });
  const allowed = vi.fn();
  const input: NativeTextInferenceInput = { providerId: "api", modelId: "model", system: "Use the public room only", user: "Read the attached image",
    images: [{ data: Uint8Array.from([1, 2, 3, 4]), mimeType: "image/png" }], maxTokens: 512, timeoutMs: 10_000,
    backendInstanceGeneration: 7, signal: new AbortController().signal, assertCurrent() {}, assertModelAllowed: allowed };
  return { store, infer, input, fetch, native, allowed, replaceCredential: () => { generation = "replacement"; },
    replaceAdapter: () => { adapter = { inferNativeText: native } as unknown as BackendAdapter; } };
}

it("resolves managed Source credentials on the providing node and forwards exact text/image input without native account fallback", async () => {
  const f = fixture(true);
  await expect(f.infer("native", f.input)).resolves.toBe("managed reply");
  expect(f.fetch).toHaveBeenCalledOnce(); expect(f.native).not.toHaveBeenCalled();
  const [url, init] = f.fetch.mock.calls[0]!;
  expect(String(url)).toBe("https://model.invalid/v1/chat/completions");
  expect(new Headers(init?.headers).get("authorization")).toBe("Bearer private-provider-key");
  expect(JSON.parse(init!.body as string)).toMatchObject({ model: "model", max_tokens: 512,
    messages: [{ role: "system", content: f.input.system }, { role: "user", content: [
      { type: "text", text: f.input.user }, { type: "image_url", image_url: { url: "data:image/png;base64,AQIDBA==" } }
    ] }] });
  expect(f.allowed).toHaveBeenCalledWith("api", "model"); expect(f.store.listSessions()).toEqual([]);
  expect(f.store.listSettings("service")).toEqual([]);
});

it("keeps native-account inference on the exact original Backend instance", async () => {
  const f = fixture(false);
  await expect(f.infer("native", f.input)).resolves.toBe("native reply");
  expect(f.native).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ images: f.input.images, providerId: "api", modelId: "model", backendInstanceGeneration: 7 }));
  expect(f.fetch).not.toHaveBeenCalled();
  f.native.mockImplementation(async () => { f.replaceAdapter(); return "stale reply"; });
  await expect(f.infer("native", f.input)).rejects.toThrow(/instance changed/u);
});

it("rejects stale credential replies and stale native generations without a second route or inference", async () => {
  const f = fixture(true);
  await expect(f.infer("native", { ...f.input, backendInstanceGeneration: 6 })).rejects.toThrow(/unavailable/u);
  expect(f.fetch).not.toHaveBeenCalled();
  f.fetch.mockImplementation(async () => { f.replaceCredential(); return new Response(JSON.stringify({ choices: [{ message: { content: "late reply" } }] }),
    { headers: { "content-type": "application/json" } }); });
  await expect(f.infer("native", f.input)).rejects.toThrow(/instance changed/u);
  expect(f.fetch).toHaveBeenCalledOnce(); expect(f.native).not.toHaveBeenCalled();
});
