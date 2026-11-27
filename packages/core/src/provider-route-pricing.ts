import routes from "./provider-route-prices.json" with { type: "json" };
import { catalogModelReferencePricing } from "./model-pricing.js";
import type { ModelReferenceTariff, ProviderModel } from "./types.js";

interface PriceRoute {
  readonly modelId: string;
  readonly agents: readonly string[];
  readonly baseModel?: string;
  readonly group?: string;
  readonly tariffs?: readonly ModelReferenceTariff[];
}

interface PriceEndpoint {
  readonly baseUrl: string;
  readonly api: string;
  readonly defaultFor: readonly string[];
  readonly selectable?: boolean;
  readonly requiresPreset?: boolean;
  readonly modelIds?: readonly string[];
}

interface PriceSupplier {
  readonly id: string;
  readonly endpoints: readonly PriceEndpoint[];
  readonly models: readonly PriceRoute[];
}

const directApiPresets = new Map([["openai", "openai-api"], ["anthropic", "anthropic-api"], ["xai", "xai-api"]]);
const endpoints = new Map<string, { supplierId: string; endpoint: PriceEndpoint; models: ReadonlyMap<string, PriceRoute> }>();
for (const supplier of routes.suppliers as readonly PriceSupplier[]) {
  const models = new Map(supplier.models.map(model => [model.modelId, model]));
  for (const endpoint of supplier.endpoints) {
    const route = "\0" + endpoint.baseUrl + "\0" + endpoint.api;
    const binding = { supplierId: supplier.id, endpoint, models };
    endpoints.set((directApiPresets.get(supplier.id) ?? supplier.id) + route, binding);
    // Accounts created before preset identity was recorded can use an unambiguous endpoint.
    if (!endpoint.requiresPreset) endpoints.set(route, binding);
  }
}

/** Look up the actual configured upstream route without using an account-local Provider ID. */
export function providerRouteReferencePricing(input: {
  readonly baseUrl: string | undefined;
  readonly api: string;
  readonly requestPath?: string;
  readonly modelId: string;
  readonly backend: "pi" | "codex" | "claude-code";
  readonly catalogPresetId?: string;
  readonly selectedModelRoute?: boolean;
}): ProviderModel["pricing"] {
  const baseUrl = input.baseUrl?.replace(/\/+$/u, "");
  if (!baseUrl) return undefined;
  const catalogUrl = baseUrl === "https://api.deepseek.com/v1" && input.api.startsWith("openai-")
    ? "https://api.deepseek.com" : baseUrl;
  const binding = endpoints.get((input.catalogPresetId ?? "") + "\0" + catalogUrl + "\0" + input.api);
  if (binding === undefined) return undefined;
  const { endpoint, models, supplierId } = binding;
  if (!endpoint.defaultFor.includes(input.backend) && !(input.selectedModelRoute && endpoint.selectable)) return undefined;
  if (input.requestPath !== undefined) {
    const base = new URL(baseUrl + "/");
    const suffix = input.api === "openai-completions" ? "chat/completions" : input.api === "openai-responses" ? "responses"
      : input.api === "anthropic-messages" ? (base.pathname.endsWith("/v1/") ? "messages" : "v1/messages") : undefined;
    if (suffix === undefined || input.requestPath !== new URL(suffix, base).pathname) return undefined;
  }
  let id = input.modelId.replace(/\[1m\]$/u, "");
  if (supplierId === "openai") id = id.replace(/^chatgpt\//u, "");
  if (supplierId === "xai" && !id.startsWith("xai/")) id = "xai/" + id;
  if (supplierId === "anthropic" && !models.has(id)) id = id.replace(/-\d{8}$/u, "");
  if (endpoint.modelIds !== undefined && !endpoint.modelIds.includes(id)) return undefined;
  const route = models.get(id);
  if (route === undefined || input.backend !== "pi" && !route.agents.includes(input.backend)) return undefined;
  if (route.tariffs === undefined) {
    return route.baseModel === undefined || route.group === undefined ? undefined : catalogModelReferencePricing(route.baseModel, route.group);
  }
  const currency = route.tariffs[0]?.currencyCode;
  return currency === undefined || route.tariffs.some(tariff => tariff.currencyCode !== currency) ? undefined
    : { source: "providerReference", currencyCode: currency, updatedAt: Date.parse(routes.updatedAt), tariffs: route.tariffs };
}
