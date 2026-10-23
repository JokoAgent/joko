import { nativeTextInferenceImages, type NativeTextInferenceInput } from "@joko/core";
import type { OperationalStore } from "@joko/store";
import type { BackendInstanceRegistry } from "./backend-instance-registry.js";
import { requestConversationInference, type ModelRouteCatalog } from "./personalization-inference.js";

/** The providing node alone resolves credentials; no task context or tool runtime is opened. */
export function createHostedNativeTextInference(options: { readonly store: OperationalStore;
  readonly registry: Pick<BackendInstanceRegistry, "adapter">; readonly routes: ModelRouteCatalog; readonly fetch?: typeof globalThis.fetch }) {
  return async (backendId: string, input: NativeTextInferenceInput): Promise<string> => {
    const adapter = options.registry.adapter(backendId), generation = options.store.getBackend(backendId).descriptor.instanceGeneration;
    const providerId = input.providerId, modelId = input.modelId;
    if (!providerId || !modelId || generation !== input.backendInstanceGeneration) throw new Error("The native inference Backend is unavailable.");
    const images = nativeTextInferenceImages(input), reference = { backendId, providerId, modelId };
    const route = options.routes.resolve(reference, { requireImages: images.length > 0 });
    const model = options.store.getBackend(backendId).descriptor.models.find(model => model.providerId === providerId && model.modelId === modelId);
    if (!model || images.length && !model.supportsImages) throw new Error("The selected inference model cannot accept this input.");
    const assertCurrent = () => {
      input.assertCurrent(); input.signal.throwIfAborted(); input.assertModelAllowed(providerId, modelId);
      if (options.registry.adapter(backendId) !== adapter || options.store.getBackend(backendId).descriptor.instanceGeneration !== generation
        || route && options.routes.resolve(reference, { requireImages: images.length > 0 })?.generationId !== route.generationId) {
        throw new Error("The native inference Backend or credential instance changed.");
      }
    };
    assertCurrent();
    if (route) {
      const result = await requestConversationInference({ route, system: input.system, user: input.user, images,
        maxTokens: Math.min(input.maxTokens ?? 4096, model.maxOutputTokens), modelOutputLimit: model.maxOutputTokens,
        timeoutMs: input.timeoutMs, signal: input.signal, assertCurrent, ...(options.fetch ? { fetch: options.fetch } : {}) });
      assertCurrent(); return result;
    }
    if (!adapter?.inferNativeText) throw new Error("The native inference Backend is unavailable.");
    const result = await adapter.inferNativeText({ ...input, assertCurrent }); assertCurrent(); return result;
  };
}
