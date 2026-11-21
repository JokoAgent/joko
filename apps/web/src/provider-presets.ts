import { capabilityNames, preferredPublicProviderInterface, publicProviderCatalogId, publicProviderInterfaces, publicProviderModel, type PublicProviderInterface, type PublicProviderModelDefaults } from "@joko/contracts";
import type { BackendView, ProviderCompatibilityView, ProviderModelConfigurationView, ProviderRuntimeConfigurationView } from "./model.js";
import { emptyProviderModel, emptyProviderRuntime, providerEndpointOrigin, supportsProviderField } from "./provider-runtime-draft.js";
import presets from "./provider-presets.json" with { type: "json" };

type PresetBackend = "claude-code" | "codex" | "pi";

interface PresetModelOptions {
  readonly supportsImageInput?: boolean;
  readonly reasoning?: boolean;
  readonly reasoningEfforts?: readonly string[];
  readonly reasoningDefaultEffort?: string;
  readonly piApi?: string;
  readonly route?: { readonly baseUrl: string; readonly wireProtocol: string };
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

export function providerModelInterfaceOptions(backend: BackendView, endpoint: string, modelId: string, catalogId = publicProviderCatalogId(endpoint)) {
  const origin = providerEndpointOrigin(endpoint);
  if (catalogId === undefined || origin === undefined) return [];
  return publicProviderInterfaces(catalogId, endpoint, modelId).flatMap(profile => {
    const compatibility = compatibilityForWireProtocol(profile.api);
    if (compatibility === undefined || backend.providerRuntimeSupport?.protocols.includes(compatibility) !== true
      || providerEndpointOrigin(profile.baseUrl) !== origin
      || (profile.baseUrl !== endpoint && !supportsProviderField(backend, "modelEndpoint"))) return [];
    return [{ profile, compatibility, endpoint: profile.baseUrl === endpoint ? undefined : profile.baseUrl }];
  });
}

export function modelInterfaceConfiguration(profile: PublicProviderInterface, endpoint: string): Pick<ProviderModelConfigurationView, "compatibility" | "endpoint"> {
  return { compatibility: compatibilityForWireProtocol(profile.api),
    endpoint: profile.baseUrl.replace(/\/+$/u, "") === endpoint.replace(/\/+$/u, "") ? undefined : profile.baseUrl };
}

export function discoveredProviderModelInterface(modelId: string, backend: BackendView, endpoint: string, catalogId?: string): PublicProviderInterface | undefined {
  const candidates = providerModelInterfaceOptions(backend, endpoint, modelId, catalogId);
  return preferredPublicProviderInterface(candidates.map(item => item.profile), endpoint, backend.id, modelId)
    ?? (candidates.length === 1 && candidates[0]!.profile.modelIds?.includes(modelId) ? candidates[0]!.profile : undefined);
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
    models: preset.models.filter(model => (model.engines === undefined || model.engines.includes(backendId))
      && publicProviderModel(preset.id, model.id)?.status !== "retired")
      .map(model => presetModel(model, preset.id, spec.baseUrl, compatibility, backend, backendId))
  };
}

function presetModel(model: PresetModel, catalogId: string, endpoint: string, compatibility: ProviderCompatibilityView, backend: BackendView, kind: PresetBackend): ProviderModelConfigurationView {
  const defaults = emptyProviderModel(backend);
  const options = { ...model, ...model.engineOverrides?.[kind] };
  const declaration = publicProviderModel(catalogId, model.id);
  const interfaces = providerModelInterfaceOptions(backend, endpoint, model.id, catalogId);
  const api = compatibilityForWireProtocol(options.piApi);
  const preferred = kind === "pi" && declaration?.interfaces === undefined && api !== undefined
    ? interfaces.find(item => item.compatibility === api && (options.route === undefined || item.profile.baseUrl === options.route.baseUrl))?.profile
    : preferredPublicProviderInterface(interfaces.map(item => item.profile), endpoint, kind, model.id);
  const maximumOutput = model.maxOutputTokens ?? model.maxOutput;
  const declared: PublicProviderModelDefaults = { ...declaration?.baseDefaults,
    ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
    ...(maximumOutput === undefined ? {} : { maxOutputTokens: maximumOutput }),
    ...(options.supportsImageInput === undefined ? {} : { supportsImageInput: options.supportsImageInput }),
    ...(options.reasoningEfforts === undefined ? {} : { efforts: options.reasoningEfforts }),
    ...declaration?.defaults, ...declaration?.perBackend?.[kind], ...preferred?.defaults };
  const thinking = supportsProviderField(backend, "modelThinkingLevels");
  const efforts = declared.efforts ?? options.reasoningEfforts ?? [];
  const supportedEfforts = efforts.filter(effort => ["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(effort));
  const reasoning = thinking && (options.reasoning ?? supportedEfforts.some(effort => effort !== "off" && effort !== "minimal"));
  const defaultEffort = options.reasoningDefaultEffort ?? declared.defaultEffort ?? undefined;
  const imageInput = preferred?.defaults?.modalities?.input?.includes("image") ?? preferred?.defaults?.supportsImageInput
    ?? options.supportsImageInput ?? declared.modalities?.input?.includes("image") ?? declared.supportsImageInput;
  const limits = supportsProviderField(backend, "modelLimits");
  const fallbackRoute: Pick<ProviderModelConfigurationView, "compatibility" | "endpoint"> =
    kind === "pi" && api !== undefined && backend.providerRuntimeSupport?.protocols.includes(api) && supportsProviderField(backend, "modelCompatibility")
    ? { compatibility: api, ...(options.route !== undefined && supportsProviderField(backend, "modelEndpoint")
      && providerEndpointOrigin(options.route.baseUrl) === providerEndpointOrigin(endpoint) ? { endpoint: options.route.baseUrl } : {}) }
    : {};
  const selected = preferred === undefined ? fallbackRoute : modelInterfaceConfiguration(preferred, endpoint);
  return {
    ...defaults,
    modelId: model.id,
    name: declaration?.defaults.name ?? model.name,
    mode: declared.mode ?? "chat",
    inputModalities: imageInput && supportsProviderField(backend, "modelInputModalities") ? ["text", "image"] : ["text"],
    contextWindowTokens: limits ? declared.contextWindow ?? model.contextWindow ?? defaults.contextWindowTokens : 0,
    maximumOutputTokens: limits ? declared.maxOutputTokens ?? model.maxOutputTokens ?? model.maxOutput ?? defaults.maximumOutputTokens : 0,
    reasoning,
    thinkingLevels: thinking ? supportedEfforts.map(effortId => ({ effortId,
      ...(kind === "pi" || (effortId !== "off" && effortId !== "minimal") ? { nativeLevel: effortId } : {}) })) : [],
    defaultEffort: reasoning && defaultEffort !== undefined && supportedEfforts.includes(defaultEffort)
      && (kind !== "claude-code" || (defaultEffort !== "off" && defaultEffort !== "minimal")) ? defaultEffort : undefined,
    supportsFastMode: supportsProviderField(backend, "modelFastMode") && declared.supportsFastMode === true,
    supportsTools: declared.supportsToolCalls,
    defaultVisible: declared.defaultEnabled,
    compatibility: selected.compatibility === compatibility ? undefined : selected.compatibility,
    endpoint: selected.endpoint
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
  if (candidate === undefined) return { ...runtime, endpoint };
  const supportsCatalog = supportsProviderField(backend, "modelsEndpoint");
  if (candidate.baseUrl !== selfHostedEndpoint) {
    const oldDefault = candidate.modelsUrl;
    const modelsEndpoint = supportsCatalog && (runtime.modelsEndpoint === undefined || runtime.modelsEndpoint === oldDefault)
      ? endpoint.replace(/\/+$/u, "") === candidate.baseUrl.replace(/\/+$/u, "") ? oldDefault : undefined
      : runtime.modelsEndpoint;
    if (providerEndpointOrigin(runtime.endpoint) !== providerEndpointOrigin(endpoint)) {
      const initialModels = providerPresetRuntime(preset, backend)?.models ?? [];
      return { ...runtime, endpoint, modelsEndpoint, models: runtime.models.map(model => {
        const initial = initialModels.find(item => item.modelId === model.modelId);
        return initial !== undefined && model.endpoint === initial.endpoint && model.compatibility === initial.compatibility
          ? { ...model, endpoint: undefined, compatibility: undefined } : model;
      }) };
    }
    return { ...runtime, endpoint, modelsEndpoint };
  }
  if (!supportsCatalog) return { ...runtime, endpoint };
  const previous = selfHostedRoute(runtime.endpoint, candidate.modelsUrl);
  if (runtime.modelsEndpoint !== previous.modelsEndpoint) return { ...runtime, endpoint };
  return { ...runtime, endpoint, modelsEndpoint: selfHostedRoute(endpoint, candidate.modelsUrl).modelsEndpoint };
}

export function finalizeProviderPresetEndpoint(preset: ProviderPreset, runtime: ProviderRuntimeConfigurationView): ProviderRuntimeConfigurationView {
  const backend = presetBackend(runtime.backendId);
  const candidate = backend === undefined ? undefined : preset.runtimes[backend];
  if (candidate?.baseUrl !== selfHostedEndpoint) return runtime;
  const route = selfHostedRoute(runtime.endpoint, candidate.modelsUrl);
  return { ...runtime, endpoint: route.endpoint };
}

function selfHostedRoute(endpoint: string, modelsUrl: string | undefined): { endpoint: string; modelsEndpoint?: string } {
  if (providerEndpointOrigin(endpoint) === undefined) return { endpoint };
  const url = new URL(endpoint);
  const path = url.pathname.replace(/\/+$/u, "");
  url.pathname = /(?:\/v\d+|\/backend-api\/codex)$/iu.test(path) ? path : path + "/v1";
  const base = url.toString();
  return { endpoint: base, ...(modelsUrl === undefined ? {} : { modelsEndpoint: base + modelsUrl.slice(selfHostedEndpoint.length) }) };
}
