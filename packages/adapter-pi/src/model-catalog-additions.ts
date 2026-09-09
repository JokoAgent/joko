import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { clampThinkingLevel } from "@earendil-works/pi-ai";
import { buildBaseOptions } from "@earendil-works/pi-ai/api/simple-options";
import type { ProviderModel } from "@joko/core";

type NativeProvider = ReturnType<ModelRuntime["getProviders"]>[number];
type NativeModel = ReturnType<NativeProvider["getModels"]>[number];

/**
 * Published-runtime catalog additions. The shared factory below is also loaded
 * by the managed extension, so discovery and native dispatch share one model.
 * Existing native rows, authentication, filtering and refresh remain authoritative.
 */
export function createPiModelCatalogAdditions() {
  return createPiModelCatalogAdditionsFactory({ buildBaseOptions, clampThinkingLevel });
}

/** Explicit helpers keep the provisioned factory independent of module closures. */
export function createPiModelCatalogAdditionsFactory(nativeOptions: {
  readonly buildBaseOptions: typeof buildBaseOptions;
  readonly clampThinkingLevel: typeof clampThinkingLevel;
}) {
  // Verified 2026-09-08: https://developers.openai.com/api/docs/models/gpt-6-astra
  // Codex's installed native catalog reports a 272k default, independent of the
  // public API's 1.05m window. An existing runtime row always wins below.
  const routes = {
    openai: { api: "openai-responses", baseUrl: "https://api.openai.com/v1", contextWindow: 1_050_000 },
    "openai-codex": { api: "openai-codex-responses", baseUrl: "https://chatgpt.com/backend-api", contextWindow: 272_000 }
  } as const;

  function isAstra(model: { readonly id: string; readonly api?: string }): boolean {
    return (model.api === "openai-responses" || model.api === "openai-codex-responses")
      && /(^|\/)gpt-6-astra(?:\[1m\])?$/i.test(model.id);
  }

  function withServiceTier<T>(options: T, priority: boolean): T & { readonly serviceTier: "priority" | "default" } {
    return { ...options, serviceTier: priority ? "priority" : "default" };
  }

  function extendProvider(provider: NativeProvider, fastMode?: () => boolean): NativeProvider {
    const route = routes[provider.id as keyof typeof routes];
    if (!route || provider.baseUrl?.replace(/\/+$/, "") !== route.baseUrl) return provider;
    const addition: NativeModel = {
      id: "gpt-6-astra",
      name: "GPT-6 Astra",
      provider: provider.id,
      api: route.api,
      baseUrl: route.baseUrl,
      contextWindow: route.contextWindow,
      maxTokens: 128_000,
      reasoning: true,
      input: ["text", "image"],
      thinkingLevelMap: { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" },
      cost: {
        input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5,
        tiers: [{ inputTokensAbove: 272_000, input: 20, output: 75, cacheRead: 2, cacheWrite: 25 }]
      }
    };
    return {
      ...provider,
      getModels() {
        const native = provider.getModels();
        return native.some((model) => model.id === addition.id) ? native : [...native, addition];
      },
      // Pass the service tier into the native stream options as well as the
      // wire payload. Pi computes each response's cost from these options and
      // its actual usage before adding it to the cumulative session statistics.
      stream(model, context, options) {
        return provider.stream(model, context, isAstra(model) && fastMode
          ? withServiceTier(options, fastMode())
          : options);
      },
      streamSimple(model, context, options) {
        if (!isAstra(model) || fastMode === undefined) return provider.streamSimple(model, context, options);
        // Native simple options deliberately contain no service tier. Reuse
        // the published simple-option conversion, then enter the full native
        // stream with the tier so request construction and usage pricing agree.
        const reasoning = options?.reasoning ? nativeOptions.clampThinkingLevel(model, options.reasoning) : undefined;
        return provider.stream(model, context, withServiceTier({
          ...nativeOptions.buildBaseOptions(model, context, options, options?.apiKey),
          toolChoice: options?.toolChoice,
          reasoningEffort: reasoning === "off" ? undefined : reasoning
        }, fastMode()));
      }
    };
  }

  function referencePricing(model: {
    readonly id: string;
    readonly api?: string;
    readonly provider?: string;
    readonly baseUrl?: string;
  }): ProviderModel["pricing"] | undefined {
    const route = routes[model.provider as keyof typeof routes];
    if (!route || model.id !== "gpt-6-astra" || model.api !== route.api
      || model.baseUrl?.replace(/\/+$/, "") !== route.baseUrl) return undefined;
    return {
      source: "providerReference",
      currencyCode: "USD",
      updatedAt: Date.UTC(2026, 8, 8),
      cacheReadAvailable: true,
      cacheWriteAvailable: true,
      fastModeMultiplier: 2,
      longContext: {
        inputTokenThreshold: 272_000,
        inputMultiplier: 2,
        outputMultiplier: 1.5,
        cacheReadMultiplier: 2,
        cacheWriteMultiplier: 2
      }
    };
  }

  function normalizeResponsesPayload(model: { readonly id: string; readonly api?: string } | undefined, value: unknown): unknown {
    if (!model || model.api !== "openai-responses" || !isAstra(model)
      || value === null || typeof value !== "object" || Array.isArray(value)) return value;
    const payload = { ...value } as Record<string, unknown>;
    // https://developers.openai.com/api/docs/guides/latest-model
    for (const key of ["temperature", "top_p", "top_logprobs", "prompt_cache_retention"]) delete payload[key];
    if (Array.isArray(payload.include)) {
      payload.include = payload.include.filter((item) => item !== "message.output_text.logprobs");
    }
    const cacheOptions = payload.prompt_cache_options;
    payload.prompt_cache_options = {
      ttl: "30m",
      ...(cacheOptions && typeof cacheOptions === "object" && !Array.isArray(cacheOptions) ? cacheOptions : {})
    };
    const reasoning = payload.reasoning;
    if (reasoning && typeof reasoning === "object" && !Array.isArray(reasoning)) {
      const record = reasoning as Record<string, unknown>;
      if (record.effort === "none" || record.effort === "minimal") payload.reasoning = { ...record, effort: "low" };
    }
    return payload;
  }

  return { extendProvider, referencePricing, normalizeResponsesPayload };
}
