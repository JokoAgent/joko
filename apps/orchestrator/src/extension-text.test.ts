import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { OperationalStore } from "@joko/store";
import { ExtensionText } from "./extension-text.js";
import { requestPluginTextInference } from "./personalization-inference.js";
import type { ExtensionTaskPreferences, ExtensionTasks } from "./extension-tasks.js";
import type { ExtensionCatalogDescriptor } from "./extension-catalog.js";
import type { BackendAdapter } from "@joko/core";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function fixture(selected?: ExtensionTaskPreferences["model"]) {
  const root = await mkdtemp(join(tmpdir(), "joko-plugin-text-")), store = new OperationalStore(join(root, "store.db"));
  const model = { providerId: "primary", modelId: "answer", displayName: "Answer", api: "openai-completions", contextWindow: 100_000, maxOutputTokens: 16_384, supportsImages: false, thinkingLevels: [], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  store.upsertBackend({ id: "runtime", displayName: "Runtime", version: "test", adapterKind: "fixture", instanceGeneration: 1, installationState: "installed", authenticationState: "authenticated", health: "healthy", capabilities: new Map(), models: [model, { ...model, providerId: "fallback" }], tools: [], diagnostics: [] });
  let current = true, revision = 1n;
  const route = { backendId: "runtime", providerId: "primary", modelId: "answer" }, fallback = { ...route, providerId: "fallback" };
  const credential = (reference: typeof route) => ({ ...reference, generationId: "credentials-one", api: "openai-completions" as const, baseUrl: "https://inference.example.test/v1", headers: {}, supportsImages: false });
  const infer = vi.fn<typeof requestPluginTextInference>(async () => "```json\n{\"answer\":42}\n```");
  const service = new ExtensionText({ store, catalog: { get: () => ({ installed: true, enabled: true, owner: { kind: "resource", resourceId: "resource" }, permissions: [], runtime: { text: { oneshot: true } } } as unknown as ExtensionCatalogDescriptor) },
    tasks: { preferences: () => ({ revision, config: { permissionMode: "ask", ...(selected ? { model: selected } : {}) } }) } as unknown as Pick<ExtensionTasks, "preferences">,
    routes: { list: () => [route, fallback].map(value => ({ ...value, credentialRoute: true, supportsImages: false })), resolve: credential },
    auxiliary: { snapshot: () => ({ models: [route, fallback], automaticModels: [], available: true, options: [], unavailableReason: "", revision: 1n, runtimeRevision: "one" }) }, infer });
  const owner = { extensionId: "plugin", resourceId: "resource", installation: "one", signal: new AbortController().signal, assertCurrent: () => { if (!current) throw new Error("Revoked"); } };
  cleanups.push(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  return { service, infer, owner, route, revoke: () => { current = false; }, changePreferences: () => { revision++; } };
}
it("pins the user's plugin route and never falls back after its failure", async () => {
  const f = await fixture({ backendId: "runtime", providerId: "primary", modelId: "answer", fastMode: false });
  f.infer.mockRejectedValue(new Error("Provider unavailable"));
  expect(await f.service.oneshot(f.owner, { type: "text-oneshot", prompt: "Evaluate this input" })).toEqual({ ok: false, errorCode: "INFERENCE_FAILED" });
  expect(f.infer).toHaveBeenCalledTimes(1); expect(f.infer.mock.calls[0]![0].route.providerId).toBe("primary");
});
it("follows the auxiliary chain only for an unselected plugin, validates JSON and rejects stale results", async () => {
  const f = await fixture();
  f.infer.mockRejectedValueOnce(new Error("Unavailable"));
  expect(await f.service.oneshot(f.owner, { type: "text-oneshot", prompt: "Give an answer", expectJson: true })).toEqual({ ok: true, text: '{"answer":42}' });
  expect(f.infer.mock.calls.map(([value]) => value.route.providerId)).toEqual(["primary", "fallback"]);
  f.infer.mockImplementation(async () => { f.changePreferences(); return "late"; });
  expect((await f.service.oneshot(f.owner, { type: "text-oneshot", prompt: "Another answer" })).ok).toBe(false);
});
it("rejects invalid request limits and keeps an omitted OpenAI output limit omitted", async () => {
  const f = await fixture();
  for (const value of [{ prompt: "x", maxTokens: 0 }, { prompt: "x", maxTokens: 1.5 }, { prompt: "x", expectJson: "yes" }, { prompt: "x".repeat(32_769) }]) {
    expect(await f.service.oneshot(f.owner, value)).toEqual({ ok: false, errorCode: "INVALID_REQUEST" });
  }
  const bodies: Record<string, unknown>[] = [];
  const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response(JSON.stringify({ choices: [{ message: { content: "Answer" } }] }));
  });
  const route = { backendId: "runtime", providerId: "provider", generationId: "one", modelId: "model", api: "openai-completions" as const, baseUrl: "https://provider.example.test/v1", headers: {}, supportsImages: false };
  const input = { route, system: "Answer", user: "Question", modelOutputLimit: 16_384, timeoutMs: 60_000, fetch };
  await expect(requestPluginTextInference(input)).resolves.toBe("Answer");
  await expect(requestPluginTextInference({ ...input, maxTokens: 100_000 })).resolves.toBe("Answer");
  expect(bodies[0]).not.toHaveProperty("max_tokens"); expect(bodies[1]?.max_tokens).toBe(100_000);
});
it("uses the selected native one-shot surface with its exact model and limit without billing fallback", async () => {
  const f = await fixture({ backendId: "runtime", providerId: "primary", modelId: "answer", fastMode: false });
  const native = vi.fn<NonNullable<BackendAdapter["inferNativeText"]>>(async input => { input.assertCurrent(); input.assertModelAllowed("primary", "answer"); return '{"answer":42}'; });
  const adapter = { id: "runtime", nativeTextInferenceCapabilities: { pluginOneshot: true, maxTokens: true }, inferNativeText: native } as unknown as BackendAdapter;
  const service = new ExtensionText({ ...f.service.options, routes: { list: () => [], resolve: () => undefined }, adapters: () => [adapter] });
  await expect(service.oneshot(f.owner, { prompt: "Answer", maxTokens: 1500, expectJson: true })).resolves.toEqual({ ok: true, text: '{"answer":42}' });
  expect(native).toHaveBeenCalledWith(expect.objectContaining({ providerId: "primary", modelId: "answer", maxTokens: 1500, backendInstanceGeneration: 1 })); expect(f.infer).not.toHaveBeenCalled();
  native.mockImplementation(async input => { input.assertModelAllowed("fallback", "answer"); return "wrong"; });
  await expect(service.oneshot(f.owner, { prompt: "Answer again" })).resolves.toEqual({ ok: false, errorCode: "INFERENCE_FAILED" });
  expect(native).toHaveBeenCalledTimes(2); expect(f.infer).not.toHaveBeenCalled();
});
it("aborts selected native inference with the original owner and never uses a review-only native channel", async () => {
  const f = await fixture({ backendId: "runtime", providerId: "primary", modelId: "answer", fastMode: false }), ownerAbort = new AbortController();
  const native = vi.fn<NonNullable<BackendAdapter["inferNativeText"]>>(async input => new Promise((_resolve, reject) => input.signal.addEventListener("abort", () => reject(input.signal.reason), { once: true })));
  const adapter = { id: "runtime", nativeTextInferenceCapabilities: { pluginOneshot: true, maxTokens: false }, inferNativeText: native } as unknown as BackendAdapter;
  const service = new ExtensionText({ ...f.service.options, routes: { list: () => [], resolve: () => undefined }, adapters: () => [adapter] });
  const result = service.oneshot({ ...f.owner, signal: ownerAbort.signal }, { prompt: "Answer" }); await vi.waitFor(() => expect(native).toHaveBeenCalledOnce());
  ownerAbort.abort(); await expect(result).resolves.toEqual({ ok: false, errorCode: "CANCELLED" }); expect(f.infer).not.toHaveBeenCalled();
  const reviewOnly = new ExtensionText({ ...service.options, adapters: () => [{ id: "runtime", inferNativeText: native } as unknown as BackendAdapter] });
  await expect(reviewOnly.oneshot(f.owner, { prompt: "Answer" })).resolves.toEqual({ ok: false, errorCode: "ROUTE_UNAVAILABLE" }); expect(native).toHaveBeenCalledOnce();
});
