import { capabilityNames } from "@joko/contracts";
import type { BackendView, ProviderCompatibilityView, ProviderModelConfigurationView, ProviderRuntimeConfigurationView } from "./model.js";
import { emptyProviderModel, emptyProviderRuntime, providerEndpointOrigin, supportsProviderField } from "./provider-runtime-draft.js";
import presets from "./provider-presets.json" with { type: "json" };

type PresetBackend = "claude-code" | "codex" | "pi";

interface PresetModelOptions {
  readonly supportsImageInput?: boolean;
  readonly reasoning?: boolean;
  readonly reasoningEfforts?: readonly string[];
  readonly piApi?: string;
}

interface PresetModel extends PresetModelOptions {
  readonly id: string;
  readonly name: string;
  readonly engines?: readonly string[];
  readonly contextWindow?: number;
  readonly maxOutputTokens?: number;
  readonly maxOutput?: number;
  readonly engineOverrides?: Partial<Record<PresetBackend, PresetModelOptions>>;
}

interface PresetRuntime {
  readonly baseUrl: string;
  readonly wireProtocol?: string;
  readonly modelsUrl?: string;
}

export interface ProviderPreset {
  readonly id: string;
  readonly name: string;
  readonly nameEn?: string;
  readonly docsUrl: string;
  readonly authMethod?: string;
  readonly runtimes: Partial<Record<PresetBackend, PresetRuntime>>;
  readonly models: readonly PresetModel[];
}

export const providerPresets: readonly ProviderPreset[] = presets;

const selfHostedEndpoint = "https://{endpoint}/v1";
const defaultProtocol: Readonly<Record<PresetBackend, string>> = {
  "claude-code": "anthropic-messages",
  codex: "openai-responses",
  pi: "openai-chat"
};

function presetBackend(backendId: string): PresetBackend | undefined {
  return backendId === "claude-code" || backendId === "codex" || backendId === "pi" ? backendId : undefined;
}

function compatibilityForWireProtocol(protocol: string | undefined): ProviderCompatibilityView | undefined {
  switch (protocol) {
    case "anthropic-messages": return "anthropic";
    case "openai-responses": return "openaiResponses";
    case "openai-chat":
    case "openai-completions": return "openaiCompletions";
    case "google-generative-ai": return "google";
    default: return undefined;
  }
}

export function providerPresetName(preset: ProviderPreset, locale: string): string {
  return locale.startsWith("zh") ? preset.name : preset.nameEn ?? preset.name;
}

export function providerPresetMatches(preset: ProviderPreset, query: string): boolean {
  return [preset.id, preset.name, preset.nameEn].some(value => value?.toLocaleLowerCase().includes(query));
}

function supportedPresetRuntime(preset: ProviderPreset, backend: BackendView) {
  const backendId = presetBackend(backend.id);
  if (backendId === undefined || backend.capabilities.get(capabilityNames.providerManagedCatalog)?.supported !== true) return undefined;
  const spec = preset.runtimes[backendId];
  if (spec === undefined) return undefined;
  const compatibility = compatibilityForWireProtocol(spec.wireProtocol ?? defaultProtocol[backendId]);
  if (compatibility === undefined || backend.providerRuntimeSupport?.protocols.includes(compatibility) !== true) return undefined;
  const keyless = preset.authMethod === "none";
  if (keyless && !supportsProviderField(backend, "keyless")) return undefined;
  return { backendId, spec, compatibility, keyless };
}

export function supportsProviderPreset(preset: ProviderPreset, backend: BackendView): boolean {
  return supportedPresetRuntime(preset, backend) !== undefined;
}

export function providerPresetRuntime(preset: ProviderPreset, backend: BackendView): ProviderRuntimeConfigurationView | undefined {
  const runtime = supportedPresetRuntime(preset, backend);
  if (runtime === undefined) return undefined;
  const { backendId, spec, compatibility, keyless } = runtime;
  return {
    ...emptyProviderRuntime(backend),
    compatibility,
    endpoint: spec.baseUrl === selfHostedEndpoint ? "" : spec.baseUrl,
    ...(spec.modelsUrl !== undefined && spec.baseUrl !== selfHostedEndpoint && supportsProviderField(backend, "modelsEndpoint")
      ? { modelsEndpoint: spec.modelsUrl } : {}),
    keyless,
    authHeader: !keyless && supportsProviderField(backend, "authHeader") && compatibility !== "anthropic",
    models: preset.models.filter(model => model.engines === undefined || model.engines.includes(backendId))
      .map(model => presetModel(model, backend, backendId))
  };
}

function presetModel(model: PresetModel, backend: BackendView, kind: PresetBackend): ProviderModelConfigurationView {
  const defaults = emptyProviderModel(backend);
  const options = { ...model, ...model.engineOverrides?.[kind] };
  const api = compatibilityForWireProtocol(options.piApi);
  const thinking = supportsProviderField(backend, "modelThinkingLevels");
  return {
    ...defaults,
    modelId: model.id,
    name: model.name,
    mode: "chat",
    inputModalities: options.supportsImageInput && supportsProviderField(backend, "modelInputModalities") ? ["text", "image"] : ["text"],
    contextWindowTokens: supportsProviderField(backend, "modelLimits") ? model.contextWindow ?? defaults.contextWindowTokens : 0,
    maximumOutputTokens: supportsProviderField(backend, "modelLimits") ? model.maxOutputTokens ?? model.maxOutput ?? defaults.maximumOutputTokens : 0,
    reasoning: thinking && options.reasoning === true,
    thinkingLevels: thinking ? (options.reasoningEfforts ?? []).map(effortId => ({ effortId, nativeLevel: effortId })) : [],
    ...(api !== undefined && supportsProviderField(backend, "modelCompatibility")
      && backend.providerRuntimeSupport?.protocols.includes(api) ? { compatibility: api } : {})
  };
}

/** Changes only defaults derived from the current draft's endpoint. A manually entered catalog stays explicit. */
export function updateProviderPresetEndpoint(
  preset: ProviderPreset,
  runtime: ProviderRuntimeConfigurationView,
  backend: BackendView,
  endpoint: string
): ProviderRuntimeConfigurationView {
  const backendId = presetBackend(backend.id);
  const candidate = backendId === undefined ? undefined : preset.runtimes[backendId];
  if (candidate === undefined || !supportsProviderField(backend, "modelsEndpoint")) return { ...runtime, endpoint };
  if (candidate.baseUrl !== selfHostedEndpoint) {
    const oldDefault = candidate.modelsUrl;
    const modelsEndpoint = runtime.modelsEndpoint === undefined || runtime.modelsEndpoint === oldDefault
      ? endpoint.replace(/\/+$/u, "") === candidate.baseUrl.replace(/\/+$/u, "") ? oldDefault : undefined
      : runtime.modelsEndpoint;
    return { ...runtime, endpoint, modelsEndpoint };
  }
  const previous = selfHostedRoute(runtime.endpoint, candidate.modelsUrl);
  if (runtime.modelsEndpoint !== previous.modelsEndpoint) return { ...runtime, endpoint };
  return { ...runtime, endpoint, modelsEndpoint: selfHostedRoute(endpoint, candidate.modelsUrl).modelsEndpoint };
}

export function finalizeProviderPresetEndpoint(preset: ProviderPreset, runtime: ProviderRuntimeConfigurationView): ProviderRuntimeConfigurationView {
  const backend = presetBackend(runtime.backendId);
  const candidate = backend === undefined ? undefined : preset.runtimes[backend];
  if (candidate?.baseUrl !== selfHostedEndpoint) return runtime;
  const route = selfHostedRoute(runtime.endpoint, candidate.modelsUrl);
  return { ...runtime, endpoint: route.endpoint, modelsEndpoint: runtime.modelsEndpoint ?? route.modelsEndpoint };
}

function selfHostedRoute(endpoint: string, modelsUrl: string | undefined): { endpoint: string; modelsEndpoint?: string } {
  if (providerEndpointOrigin(endpoint) === undefined) return { endpoint };
  const url = new URL(endpoint);
  const path = url.pathname.replace(/\/+$/u, "");
  url.pathname = /(?:\/v\d+|\/backend-api\/codex)$/iu.test(path) ? path : path + "/v1";
  const base = url.toString();
  return { endpoint: base, ...(modelsUrl === undefined ? {} : { modelsEndpoint: base + modelsUrl.slice(selfHostedEndpoint.length) }) };
}
