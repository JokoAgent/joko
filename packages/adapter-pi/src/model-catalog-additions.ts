import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { clampThinkingLevel } from "@earendil-works/pi-ai";
import { buildBaseOptions } from "@earendil-works/pi-ai/api/simple-options";
import type { ProviderModel } from "@joko/core";

type NativeProvider = ReturnType<ModelRuntime["getProviders"]>[number];
type NativeModel = ReturnType<NativeProvider["getModels"]>[number];
type CatalogMetadata = Readonly<{
  cost?: ProviderModel["cost"];
  pricing?: ProviderModel["pricing"];
  defaultVisible?: boolean;
  supportsFastMode?: boolean;
}>;

/**
 * Fixed-runtime catalog additions. The shared factory below is also loaded by
 * the managed extension, so discovery, selection and native dispatch use the
 * same exact Provider routes. Unlisted Providers and models remain native.
 */
export function createPiModelCatalogAdditions() {
  return createPiModelCatalogAdditionsFactory({ buildBaseOptions, clampThinkingLevel });
}

/** Explicit helpers keep the provisioned factory independent of module closures. */
export function createPiModelCatalogAdditionsFactory(nativeOptions: {
  readonly buildBaseOptions: typeof buildBaseOptions;
  readonly clampThinkingLevel: typeof clampThinkingLevel;
}) {
  const routes = {
    openai: { baseUrl: "https://api.openai.com/v1" },
    "openai-codex": { baseUrl: "https://chatgpt.com/backend-api" },
    xai: { baseUrl: "https://api.x.ai/v1" },
    deepseek: { baseUrl: "https://api.deepseek.com" },
    "kimi-coding": { baseUrl: "https://api.kimi.com/coding" },
    moonshotai: { baseUrl: "https://api.moonshot.ai/v1" },
    "moonshotai-cn": { baseUrl: "https://api.moonshot.cn/v1" },
    xiaomi: { baseUrl: "https://api.xiaomimimo.com/v1" },
    "xiaomi-token-plan-cn": { baseUrl: "https://token-plan-cn.xiaomimimo.com/v1" }
  } as const;
  const zeroCost = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  const exactBaseUrl = (value: string | undefined) => value?.replace(/\/+$/, "");
  const routeFor = (provider: { readonly id: string; readonly baseUrl?: string }) => {
    const route = routes[provider.id as keyof typeof routes];
    return route !== undefined && exactBaseUrl(provider.baseUrl) === route.baseUrl ? route : undefined;
  };

  function isAstra(model: { readonly id: string; readonly api?: string }): boolean {
    return (model.api === "openai-responses" || model.api === "openai-codex-responses")
      && /(^|\/)gpt-6-astra(?:\[1m\])?$/i.test(model.id);
  }

  function withServiceTier<T>(options: T, priority: boolean): T & { readonly serviceTier: "priority" | "default" } {
    return { ...options, serviceTier: priority ? "priority" : "default" };
  }

  function exactModel(model: NativeModel, values: Partial<NativeModel>): NativeModel {
    return { ...model, ...values } as NativeModel;
  }

  function grokModel(seed?: NativeModel): NativeModel {
    return exactModel(seed ?? ({ id: "grok-4.7" } as NativeModel), {
      id: "grok-4.7",
      name: "Grok 4.7",
      provider: "xai",
      api: "openai-responses",
      baseUrl: routes.xai.baseUrl,
      contextWindow: 500_000,
      maxTokens: 500_000,
      reasoning: true,
      input: ["text", "image"],
      cost: zeroCost(),
      thinkingLevelMap: {
        off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: null
      }
    });
  }

  function deepSeekFlashModel(seed?: NativeModel): NativeModel {
    return exactModel(seed ?? ({ id: "deepseek-flash" } as NativeModel), {
      id: "deepseek-flash",
      name: "DeepSeek-Flash",
      provider: "deepseek",
      api: "openai-completions",
      baseUrl: routes.deepseek.baseUrl,
      contextWindow: 1_048_576,
      maxTokens: 384_000,
      reasoning: true,
      input: ["text", "image"],
      cost: { input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0 },
      thinkingLevelMap: {
        off: null, minimal: null, low: "low", medium: null, high: "high", xhigh: null, max: "max"
      }
    });
  }

  function xiaomiModel(
    providerId: "xiaomi" | "xiaomi-token-plan-cn",
    id: string,
    name: string,
    images: boolean,
    seed?: NativeModel
  ): NativeModel {
    return exactModel(seed ?? ({ id } as NativeModel), {
      id,
      name,
      provider: providerId,
      api: "openai-completions",
      baseUrl: routes[providerId].baseUrl,
      contextWindow: 1_048_576,
      maxTokens: 131_072,
      reasoning: true,
      input: images ? ["text", "image"] : ["text"],
      cost: zeroCost(),
      // The Provider accepts only an on/off thinking switch. Null every
      // product effort so no reasoning_effort value can reach the wire.
      thinkingLevelMap: {
        off: null, minimal: null, low: null, medium: null, high: null, xhigh: null, max: null
      }
    });
  }

  function projectModels(provider: NativeProvider): readonly NativeModel[] {
    if (routeFor(provider) === undefined) return provider.getModels();
    const native = provider.getModels();
    if (provider.id === "xai") {
      const projected = native.map((model) => model.id === "grok-4.7" ? grokModel(model) : model);
      return projected.some((model) => model.id === "grok-4.7") ? projected : [...projected, grokModel()];
    }
    if (provider.id === "deepseek") {
      const current = native.find((model) => model.id === "deepseek-flash")
        ?? native.find((model) => model.id === "deepseek-v4-flash");
      const projected = native
        .filter((model) => model.id !== "deepseek-flash" && model.id !== "deepseek-v4-flash")
        .map((model) => model.id === "deepseek-v4-pro" ? exactModel(model, {
          contextWindow: 1_048_576,
          maxTokens: 384_000,
          cost: { input: 1.32, output: 3.96, cacheRead: 0.044, cacheWrite: 0 }
        }) : model);
      return [...projected, deepSeekFlashModel(current)];
    }
    if (provider.id === "kimi-coding") {
      return native.map((model) => model.id === "kimi-for-coding" ? exactModel(model, {
        name: "Kimi K2.8 Preview",
        contextWindow: 1_048_576,
        reasoning: true,
        input: ["text", "image"],
        cost: zeroCost(),
        thinkingLevelMap: {
          off: null, minimal: null, low: "low", medium: null, high: "high", xhigh: null, max: "max"
        }
      }) : model);
    }
    if (provider.id === "moonshotai" || provider.id === "moonshotai-cn") {
      return native.map((model) => model.id === "kimi-k3" ? exactModel(model, {
        cost: provider.id === "moonshotai"
          ? { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3 }
          : zeroCost()
      }) : model);
    }
    if (provider.id === "xiaomi" || provider.id === "xiaomi-token-plan-cn") {
      const ids = new Set(["mimo-v2.6-pro", "mimo-v2.6-flash", "mimo-v2.6-pro-ultraspeed"]);
      const projected = [
        ...native.filter((model) => !ids.has(model.id)),
        xiaomiModel(provider.id, "mimo-v2.6-pro", "MiMo-V2.6-Pro", true,
          native.find((model) => model.id === "mimo-v2.5-pro")),
        xiaomiModel(provider.id, "mimo-v2.6-flash", "MiMo-V2.6-Flash", true,
          native.find((model) => model.id === "mimo-v2.5"))
      ];
      return provider.id === "xiaomi"
        ? [...projected, xiaomiModel(provider.id, "mimo-v2.6-pro-ultraspeed", "MiMo-V2.6-Pro-UltraSpeed", false,
          native.find((model) => model.id === "mimo-v2.5-pro-ultraspeed"))]
        : projected;
    }
    return native;
  }

  function extendProvider(provider: NativeProvider, fastMode?: () => boolean): NativeProvider {
    if (routeFor(provider) === undefined) return provider;
    const extended = {
      ...provider,
      getModels() {
        return projectModels(provider);
      }
    } as NativeProvider;
    if (provider.id !== "openai" && provider.id !== "openai-codex") return extended;
    return {
      ...extended,
      // Pass the tier into native stream options as well as the wire payload.
      // The native runtime then prices Astra from actual response usage.
      stream(model, context, options) {
        return provider.stream(model, context, isAstra(model) && fastMode
          ? withServiceTier(options, fastMode())
          : options);
      },
      streamSimple(model, context, options) {
        if (!isAstra(model) || fastMode === undefined) return provider.streamSimple(model, context, options);
        const reasoning = options?.reasoning ? nativeOptions.clampThinkingLevel(model, options.reasoning) : undefined;
        return provider.stream(model, context, withServiceTier({
          ...nativeOptions.buildBaseOptions(model, context, options, options?.apiKey),
          toolChoice: options?.toolChoice,
          reasoningEffort: reasoning === "off" ? undefined : reasoning
        }, fastMode()));
      }
    };
  }

  function priced(
    cost: ProviderModel["cost"],
    updatedAt: number,
    values: Omit<NonNullable<ProviderModel["pricing"]>, "source" | "currencyCode" | "updatedAt"> = {},
    currencyCode = "USD"
  ): CatalogMetadata {
    return {
      cost,
      pricing: { source: "providerReference", currencyCode, updatedAt, ...values }
    };
  }

  function referenceCatalogMetadata(
    model: { readonly id: string; readonly api?: string; readonly provider?: string; readonly baseUrl?: string }
  ): CatalogMetadata | undefined {
    const provider = model.provider ?? "";
    const route = routes[provider as keyof typeof routes];
    if (route === undefined || exactBaseUrl(model.baseUrl) !== route.baseUrl) return undefined;
    if (model.id === "gpt-6-astra" && (provider === "openai" || provider === "openai-codex")) {
      return {
        ...priced(
          { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
          Date.UTC(2026, 8, 8),
          {
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
          }
        ),
        supportsFastMode: true
      };
    }
    if (provider === "xai" && model.id === "grok-4.7") {
      return {
        ...priced({ input: 2, output: 6, cacheRead: 0.5, cacheWrite: 0 }, Date.UTC(2026, 8, 24), {
          cacheReadAvailable: true,
          cacheWriteAvailable: false,
          fastModeMultiplier: 2,
          longContext: {
            inputTokenThreshold: 199_999,
            fastInputTokenThreshold: 200_000,
            fastModeMultiplier: 1.5,
            inputMultiplier: 2,
            outputMultiplier: 2,
            cacheReadMultiplier: 2,
            cacheWriteMultiplier: 1
          }
        }),
        supportsFastMode: true
      };
    }
    if (provider === "deepseek" && model.id === "deepseek-v4-pro") {
      return priced(
        { input: 1.32, output: 3.96, cacheRead: 0.044, cacheWrite: 0 },
        Date.UTC(2026, 7, 16),
        { cacheReadAvailable: true, cacheWriteAvailable: false }
      );
    }
    if (provider === "deepseek" && model.id === "deepseek-flash") {
      return priced(
        { input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0 },
        Date.UTC(2026, 8, 11),
        { cacheReadAvailable: true, cacheWriteAvailable: false }
      );
    }
    if (provider === "kimi-coding" && model.id === "kimi-for-coding") return { cost: zeroCost() };
    if (provider === "moonshotai" && model.id === "kimi-k3") {
      return priced(
        { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3 },
        Date.UTC(2026, 8, 23),
        { cacheReadAvailable: true, cacheWriteAvailable: true }
      );
    }
    if (provider === "moonshotai-cn" && model.id === "kimi-k3") {
      return priced(
        { input: 20, output: 100, cacheRead: 2, cacheWrite: 20 },
        Date.UTC(2026, 8, 23),
        { cacheReadAvailable: true, cacheWriteAvailable: true },
        "CNY"
      );
    }
    if (provider === "xiaomi" || provider === "xiaomi-token-plan-cn") {
      if (model.id === "mimo-v2.5" || model.id === "mimo-v2.5-pro"
        || (provider === "xiaomi" && model.id === "mimo-v2.5-pro-ultraspeed")) {
        return { defaultVisible: false };
      }
      const cost = model.id === "mimo-v2.6-pro"
        ? { input: 3, output: 6, cacheRead: 0.025, cacheWrite: 0 }
        : model.id === "mimo-v2.6-flash"
          ? { input: 1, output: 2, cacheRead: 0.02, cacheWrite: 0 }
          : provider === "xiaomi" && model.id === "mimo-v2.6-pro-ultraspeed"
            ? { input: 30, output: 60, cacheRead: 0.25, cacheWrite: 0 }
            : undefined;
      if (cost !== undefined) {
        return priced(cost, Date.UTC(2026, 8, 22), {
          cacheReadAvailable: true,
          cacheWriteAvailable: false
        }, "CNY");
      }
    }
    return undefined;
  }

  function normalizeResponsesPayload(model: { readonly id: string; readonly api?: string } | undefined, value: unknown): unknown {
    if (!model || model.api !== "openai-responses" || !isAstra(model)
      || value === null || typeof value !== "object" || Array.isArray(value)) return value;
    const payload = { ...value } as Record<string, unknown>;
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

  function prepareProviderPayload(
    model: { readonly id: string; readonly api?: string; readonly provider?: string; readonly baseUrl?: string } | undefined,
    value: unknown,
    fastMode: boolean
  ): unknown {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
    const payload = { ...value } as Record<string, unknown>;
    if (model?.provider === "xai" && exactBaseUrl(model.baseUrl) === routes.xai.baseUrl) {
      if (fastMode && model.id === "grok-4.7") payload.model = "grok-4.7-build-fast";
      delete payload.service_tier;
    } else if (fastMode) {
      payload.service_tier = "priority";
    } else {
      delete payload.service_tier;
    }
    return normalizeResponsesPayload(model, payload);
  }

  return {
    extendProvider,
    referenceCatalogMetadata,
    normalizeResponsesPayload,
    prepareProviderPayload
  };
}
