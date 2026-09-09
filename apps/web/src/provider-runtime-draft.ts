import type { BackendView, ProviderCompatibilityView, ProviderConfigurationFieldView, ProviderModelConfigurationView, ProviderRuntimeConfigurationView } from "./model.js";

export type ProviderTransferField = "endpoint" | "models" | "authentication" | "headers" | "modelsEndpoint";
export interface ProviderTransferDifference {
  readonly field: ProviderTransferField;
  readonly state: "empty" | "same" | "conflict" | "incompatible";
}

export function supportsProviderField(backend: BackendView, field: ProviderConfigurationFieldView): boolean {
  return backend.providerRuntimeSupport?.fields.includes(field) === true;
}

export function providerEndpointOrigin(endpoint: string): string | undefined {
  try {
    const url = new URL(endpoint);
    if (url.username || url.password || url.search || url.hash) return undefined;
    if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) return undefined;
    return url.origin;
  } catch { return undefined; }
}

export function providerRequestPathValid(path: string | undefined): boolean {
  if (!path) return true;
  if (!path.startsWith("/") || path.startsWith("//")) return false;
  try { const url = new URL(path, "https://route.invalid"); return url.origin === "https://route.invalid" && !url.search && !url.hash; }
  catch { return false; }
}

export function providerCredentialBindingsValid(runtime: ProviderRuntimeConfigurationView, hasNewSecret = false): boolean {
  if (runtime.keyless && (runtime.credentialId !== "" || runtime.headers.length > 0 || hasNewSecret)) return false;
  const bindings = new Map<string, string>();
  const spellings = new Map<string, string>();
  const apiEnvironment = runtime.environmentName.trim().toUpperCase();
  if (runtime.credentialId || hasNewSecret) spellings.set(apiEnvironment, runtime.environmentName.trim());
  if (runtime.credentialId) bindings.set(apiEnvironment, runtime.credentialId);
  for (const header of runtime.headers) {
    const name = header.environmentName.trim().toUpperCase();
    const spelling = spellings.get(name);
    if (spelling !== undefined && spelling !== header.environmentName.trim()) return false;
    spellings.set(name, header.environmentName.trim());
    if (hasNewSecret && name === apiEnvironment) return false;
    const existing = bindings.get(name);
    if (existing !== undefined && existing !== header.credentialId) return false;
    bindings.set(name, header.credentialId);
  }
  return true;
}

export function emptyProviderRuntime(backend: BackendView): ProviderRuntimeConfigurationView {
  const compatibility = backend.providerRuntimeSupport?.protocols[0];
  if (compatibility === undefined) throw new Error("The runtime has no custom Provider protocol.");
  return { backendId: backend.id, compatibility, endpoint: "", credentialId: "", environmentName: "", credentialOrigin: "",
    keyless: false, authHeader: supportsProviderField(backend, "authHeader") && compatibility !== "anthropic", headers: [], models: [emptyProviderModel(backend)] };
}

export function emptyProviderModel(backend: BackendView): ProviderModelConfigurationView {
  return { modelId: "", name: "", reasoning: false, inputModalities: ["text"], contextWindowTokens: supportsProviderField(backend, "modelLimits") ? 128_000 : 0, maximumOutputTokens: supportsProviderField(backend, "modelLimits") ? 8_192 : 0,
    inputCostMicrosPerMillion: 0, outputCostMicrosPerMillion: 0, cacheReadCostMicrosPerMillion: 0, cacheWriteCostMicrosPerMillion: 0,
    thinkingLevels: [], supportsFastMode: false };
}

export function providerCompatibilityLabel(compatibility: ProviderCompatibilityView): string {
  switch (compatibility) {
    case "openaiResponses": return "OpenAI Responses";
    case "openaiChat": return "OpenAI Chat Completions";
    case "anthropic": return "Anthropic Messages";
    case "google": return "Google Generative AI";
    case "openaiCompletions": return "OpenAI Completions";
    case "native": return "Native";
  }
}

/** Transfer model declarations only where both runtime descriptors support them. */
function transferModels(source: ProviderRuntimeConfigurationView, target: ProviderRuntimeConfigurationView,
  sourceBackend: BackendView, targetBackend: BackendView): readonly ProviderModelConfigurationView[] {
  const allowed = (field: ProviderConfigurationFieldView): boolean => supportsProviderField(sourceBackend, field) && supportsProviderField(targetBackend, field);
  return source.models.filter((model) => model.modelId.trim() && model.name.trim()).map((model) => {
    const retained = target.models.find((candidate) => candidate.modelId === model.modelId) ?? emptyProviderModel(targetBackend);
    return {
      ...retained, modelId: model.modelId, name: model.name,
      ...(allowed("modelLimits") ? { contextWindowTokens: model.contextWindowTokens, maximumOutputTokens: model.maximumOutputTokens } : {}),
      ...(allowed("modelCosts") ? { inputCostMicrosPerMillion: model.inputCostMicrosPerMillion, outputCostMicrosPerMillion: model.outputCostMicrosPerMillion,
        cacheReadCostMicrosPerMillion: model.cacheReadCostMicrosPerMillion, cacheWriteCostMicrosPerMillion: model.cacheWriteCostMicrosPerMillion } : {}),
      ...(allowed("modelInputModalities") ? { inputModalities: model.inputModalities } : {}),
      ...(allowed("modelThinkingLevels") ? { reasoning: model.reasoning, thinkingLevels: model.thinkingLevels } : {}),
      ...(allowed("modelFastMode") ? { supportsFastMode: model.supportsFastMode } : {}),
      ...(allowed("modelSampling") ? { sampling: model.sampling } : {}),
      ...(allowed("modelCompatibility") ? { compatibility: model.compatibility, compatibilityOptions: model.compatibilityOptions } : {})
    };
  });
}

export function providerTransferDifferences(source: ProviderRuntimeConfigurationView, target: ProviderRuntimeConfigurationView,
  sourceBackend: BackendView, targetBackend: BackendView, hasSourceSecret = false, hasTargetSecret = false): readonly ProviderTransferDifference[] {
  const endpointCompatible = providerEndpointOrigin(source.endpoint) !== undefined
    && targetBackend.providerRuntimeSupport?.protocols.includes(source.compatibility) === true
    && providerRequestPathValid(source.requestPath)
    && (!source.requestPath || supportsProviderField(targetBackend, "requestPath"));
  const rows: ProviderTransferDifference[] = [];
  const sourceOrigin = providerEndpointOrigin(source.endpoint);
  const destinationOriginCompatible = endpointCompatible || sourceOrigin !== undefined && providerEndpointOrigin(target.endpoint) === sourceOrigin;
  const add = (field: ProviderTransferField, sourceValue: unknown, targetValue: unknown, targetHasValue: boolean, compatible: boolean): void => {
    rows.push({ field, state: !compatible ? "incompatible" : JSON.stringify(sourceValue) === JSON.stringify(targetValue) ? "same" : targetHasValue ? "conflict" : "empty" });
  };
  if (source.endpoint.trim()) add("endpoint", [source.endpoint.trim(), source.compatibility, source.requestPath ?? ""],
    [target.endpoint.trim(), target.compatibility, target.requestPath ?? ""], target.endpoint.trim() !== "", endpointCompatible);
  if (source.models.some((model) => model.modelId.trim() && model.name.trim())) {
    add("models", transferModels(source, target, sourceBackend, targetBackend), target.models,
      target.models.some((model) => model.modelId.trim() !== ""), !supportsProviderField(sourceBackend, "modelCompatibility") || !supportsProviderField(targetBackend, "modelCompatibility")
        || source.models.every((model) => model.compatibility === undefined || targetBackend.providerRuntimeSupport?.protocols.includes(model.compatibility)));
  }
  if (hasSourceSecret || source.credentialId || source.keyless) {
    const authHeader = source.keyless || !supportsProviderField(targetBackend, "authHeader") ? false
      : supportsProviderField(sourceBackend, "authHeader") ? source.authHeader : target.authHeader;
    add("authentication", [source.keyless, authHeader, source.credentialId, source.environmentName, hasSourceSecret, 0],
      [target.keyless, target.authHeader, target.credentialId, target.environmentName, hasTargetSecret ? "destination-secret" : false, source.keyless ? target.headers.length : 0],
      !!target.credentialId || target.keyless || hasTargetSecret || source.keyless && target.headers.length > 0,
      destinationOriginCompatible && (!source.keyless || supportsProviderField(targetBackend, "keyless") && source.headers.length === 0 && !source.credentialId));
  }
  if (source.headers.length) add("headers", source.headers, target.headers, target.headers.length > 0,
    destinationOriginCompatible && supportsProviderField(sourceBackend, "headers") && supportsProviderField(targetBackend, "headers"));
  if (source.modelsEndpoint) add("modelsEndpoint", source.modelsEndpoint, target.modelsEndpoint ?? "", !!target.modelsEndpoint,
    destinationOriginCompatible && supportsProviderField(targetBackend, "modelsEndpoint") && providerEndpointOrigin(source.modelsEndpoint) === sourceOrigin);
  return rows;
}

/** Endpoint and credentials have separate selections. A changed origin retires
 * old authority; only an explicitly selected key/header is bound to the result. */
export function transferProviderRuntime(source: ProviderRuntimeConfigurationView, target: ProviderRuntimeConfigurationView,
  sourceBackend: BackendView, targetBackend: BackendView, selected: readonly ProviderTransferField[], hasSourceSecret = false): ProviderRuntimeConfigurationView {
  const differences = providerTransferDifferences(source, target, sourceBackend, targetBackend, hasSourceSecret);
  if (selected.some((field) => !differences.some((diff) => diff.field === field && diff.state !== "incompatible"))) {
    throw new Error("A selected Provider field is unavailable on this runtime.");
  }
  let next = { ...target };
  if (selected.includes("endpoint")) {
    next = { ...next, endpoint: source.endpoint.trim(), compatibility: source.compatibility, requestPath: source.requestPath };
    if (source.compatibility !== target.compatibility) next.authHeader = supportsProviderField(targetBackend, "authHeader") && source.compatibility !== "anthropic";
    if (providerEndpointOrigin(next.endpoint) !== providerEndpointOrigin(target.endpoint)) {
      next = { ...next, credentialId: "", environmentName: "", credentialOrigin: "", headers: [], modelsEndpoint: undefined };
    }
  }
  const origin = providerEndpointOrigin(next.endpoint);
  const sourceOrigin = providerEndpointOrigin(source.endpoint);
  if ((selected.includes("authentication") || selected.includes("headers") || selected.includes("modelsEndpoint"))
    && (origin === undefined || origin !== sourceOrigin)) throw new Error("Select the source endpoint before transferring its credential or catalog authority.");
  if (next.credentialOrigin !== origin && (selected.includes("authentication") && !source.keyless && next.headers.length > 0 && !selected.includes("headers")
    || selected.includes("headers") && next.credentialId !== "" && !selected.includes("authentication"))) {
    throw new Error("Transferring one credential cannot authorize unrelated destination credentials.");
  }
  if (selected.includes("authentication")) {
    if (source.credentialId && source.credentialOrigin !== sourceOrigin && !hasSourceSecret) throw new Error("The source credential requires explicit origin authorization.");
    next = { ...next, keyless: source.keyless,
      authHeader: source.keyless || !supportsProviderField(targetBackend, "authHeader") ? false
        : supportsProviderField(sourceBackend, "authHeader") ? source.authHeader : next.authHeader,
      credentialId: source.credentialId, environmentName: source.environmentName,
      ...(source.keyless ? { headers: [] } : {}), credentialOrigin: source.keyless ? "" : origin! };
  }
  if (selected.includes("headers")) {
    if (source.credentialOrigin !== sourceOrigin) throw new Error("The source header credentials require explicit origin authorization.");
    next = { ...next, headers: source.headers, credentialOrigin: origin! };
  }
  if (selected.includes("modelsEndpoint")) next = { ...next, modelsEndpoint: source.modelsEndpoint };
  if (selected.includes("models")) next = { ...next, models: transferModels(source, target, sourceBackend, targetBackend) };
  return next;
}
