import {
  PI_EDITABLE_MODEL_METADATA_FIELDS, PI_MODEL_METADATA_FIELDS, supportedPiThinkingLevels,
  type PiManagedModel, type PiModelDiscoveryMetadata, type PiModelMetadataField, type PiSupportedApi
} from "@joko/adapter-pi";
import { publicModelNativeApi, publicProviderCatalogId, publicProviderInterfaces, publicProviderModel } from "@joko/contracts";

const thinkingLevels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/** Project defaults for discovered members of the exact public connection. */
export function publicDiscoveryDefaults(model: PiManagedModel, endpoint: string | undefined, backend: string,
  api: PiSupportedApi | undefined): PiManagedModel {
  const live = model.discoveredMetadata;
  if (live === undefined || endpoint === undefined) return model;
  const catalog = publicProviderCatalogId(endpoint);
  if (catalog === undefined) return model;
  const declaration = publicProviderModel(catalog, model.id);
  if (declaration === undefined || declaration.status === "retired") return model;
  const profile = publicProviderInterfaces(catalog, endpoint, model.id).find(item => item.api === api
    && item.baseUrl.replace(/\/+$/u, "") === endpoint.replace(/\/+$/u, ""));
  const defaults = { ...declaration.baseDefaults, ...declaration.defaults, ...declaration.perBackend?.[backend], ...profile?.defaults };
  const nativeApi = publicModelNativeApi(catalog, model.id, live.mode ?? defaults.mode);
  const efforts = live.efforts ?? defaults.efforts;
  const intent = live.defaultEffort === null || defaults.defaultEffort === undefined ? live.defaultEffort : defaults.defaultEffort;
  const offered = efforts === undefined ? undefined : thinkingLevels.filter(value => efforts.includes(value));
  const defaultEffort = !intent || offered === undefined || offered.includes(intent) ? intent
    : offered.filter(value => thinkingLevels.indexOf(value) <= thinkingLevels.indexOf(intent)).at(-1) ?? offered[0];
  const capacity = catalog === "openai" ? declaration.baseDefaults.contextWindow ?? defaults.contextWindow : defaults.contextWindow;
  return materializeDiscoveredModel(model, {
    mode: defaults.mode, name: defaults.name,
    contextWindow: live.contextWindow ?? live.contextWindowMax ?? capacity,
    maxOutputTokens: defaults.maxOutputTokens,
    nativeApi: nativeApi === "anthropic-messages" || nativeApi === "openai-responses" || nativeApi === "openai-completions"
      || nativeApi === "google-generative-ai" ? nativeApi : undefined,
    inputModalities: defaults.modalities?.input,
    outputModalities: defaults.modalities?.output,
    supportsImages: defaults.supportsImageInput,
    supportsTools: defaults.supportsToolCalls,
    supportsFastMode: defaults.supportsFastMode,
    ...live,
    efforts,
    defaultEffort,
    ...(live.inputModalities === undefined || live.supportsImages !== undefined ? {} : { supportsImages: live.inputModalities.includes("image") })
  });
}

/** Keep facts separate from the values explicitly declared by the owner. */
export function refreshDiscoveredModel(model: PiManagedModel, update: PiModelDiscoveryMetadata): PiManagedModel {
  const discoveredMetadata = { ...model.discoveredMetadata, ...update };
  if (update.supportsImages === false && update.inputModalities === undefined && discoveredMetadata.inputModalities !== undefined) {
    discoveredMetadata.inputModalities = discoveredMetadata.inputModalities.filter(value => value !== "image");
  }
  if (discoveredMetadata.contextWindow !== undefined && discoveredMetadata.contextWindowMax !== undefined
    && discoveredMetadata.contextWindowMax < discoveredMetadata.contextWindow) delete discoveredMetadata.contextWindowMax;
  const metadataOverrides = model.discoveredMetadata === undefined
    ? PI_MODEL_METADATA_FIELDS.filter(field => model[field] !== undefined)
    : model.metadataOverrides!;
  return materializeDiscoveredModel({ ...model, discoveredMetadata, metadataOverrides });
}

export function saveDiscoveredModelConfiguration(current: PiManagedModel | undefined, input: PiManagedModel): PiManagedModel {
  const preservedEndpoint = !Object.hasOwn(input, "baseUrl") && current?.baseUrl !== undefined ? { baseUrl: current.baseUrl } : {};
  if (current?.discoveredMetadata === undefined) {
    const { metadataOverrides: _metadataOverrides, discoveredMetadata: _discoveredMetadata, contextWindowMax: _contextWindowMax,
      declaredInputModalities: _declaredInputModalities, ...manual } = input;
    return { ...preservedEndpoint, ...manual };
  }
  const editable = new Set<PiModelMetadataField>(PI_EDITABLE_MODEL_METADATA_FIELDS);
  const privateOverrides = current.metadataOverrides!.filter(field => !editable.has(field));
  if (input.defaultEffort !== undefined && !privateOverrides.includes("defaultEffort")) privateOverrides.push("defaultEffort");
  const editableOverrides = (input.metadataOverrides ?? PI_EDITABLE_MODEL_METADATA_FIELDS).filter(field => editable.has(field));
  return materializeDiscoveredModel({ ...current, ...preservedEndpoint, ...input, api: input.api, discoveredMetadata: current.discoveredMetadata,
    ...(editableOverrides.includes("contextWindow") && input.contextWindow !== undefined ? { contextWindowSource: "declared" as const } : {}),
    ...(editableOverrides.includes("maxTokens") && input.maxTokens !== undefined ? { maxOutputTokensSource: "declared" as const } : {}),
    metadataOverrides: [...privateOverrides, ...editableOverrides] });
}

export function materializeDiscoveredModel(model: PiManagedModel, metadata = model.discoveredMetadata!): PiManagedModel {
  const live = model.discoveredMetadata!;
  const overrides = new Set(model.metadataOverrides);
  const user = Object.fromEntries(PI_MODEL_METADATA_FIELDS.filter(field => overrides.has(field)).map(field => [field, model[field]]));
  const base = Object.fromEntries(Object.entries(model).filter(([field]) => !PI_MODEL_METADATA_FIELDS.includes(field as PiModelMetadataField)
    && !["contextWindowSource", "maxOutputTokensSource", "declaredInputModalities"].includes(field)));
  const levels = metadata.efforts;
  const thinkingLevelMap = levels === undefined ? undefined : Object.fromEntries(
    thinkingLevels.map(level => [level, levels.includes(level) ? level : null]));
  const reportedInput = metadata.supportsImages === false ? metadata.inputModalities?.filter(value => value !== "image")
    : metadata.supportsImages === true ? [...new Set([...(metadata.inputModalities ?? ["text"]), "image"])] : metadata.inputModalities;
  const input = reportedInput?.filter((value): value is "text" | "image" => value === "text" || value === "image");
  const result: PiManagedModel = {
    ...base, id: model.id, discoveredMetadata: live, metadataOverrides: model.metadataOverrides,
    name: metadata.name ?? model.id,
    contextWindow: metadata.contextWindow ?? metadata.contextWindowMax ?? 128_000,
    contextWindowSource: live.contextWindow === undefined ? "estimated" : "declared",
    maxTokens: metadata.maxOutputTokens ?? 16_384,
    maxOutputTokensSource: live.maxOutputTokens === undefined ? "estimated" : "declared",
    ...(metadata.mode === undefined ? {} : { mode: metadata.mode }),
    ...(metadata.contextWindowMax === undefined ? {} : { contextWindowMax: metadata.contextWindowMax }),
    ...(metadata.description === undefined ? {} : { description: metadata.description }),
    ...(metadata.nativeApi === undefined ? {} : { referenceApi: metadata.nativeApi }),
    ...(reportedInput === undefined && metadata.supportsImages === undefined ? {} : { input: input?.length ? input : ["text" as const],
      declaredInputModalities: reportedInput ?? ["text"] }),
    ...(metadata.outputModalities === undefined ? {} : { declaredOutputModalities: metadata.outputModalities }),
    ...(metadata.supportsTools === undefined ? {} : { supportsTools: metadata.supportsTools }),
    ...(metadata.supportsFastMode === undefined ? {} : { supportsFastMode: metadata.supportsFastMode }),
    ...(thinkingLevelMap === undefined ? {} : { reasoning: levels!.some(level => level !== "ultra"), thinkingLevelMap }),
    ...(metadata.defaultEffort == null ? {} : { defaultEffort: metadata.defaultEffort }),
    ...user,
    ...(overrides.has("contextWindow") ? { contextWindowSource: model.contextWindowSource ?? "declared" } : {}),
    ...(overrides.has("maxTokens") ? { maxOutputTokensSource: model.maxOutputTokensSource ?? "declared" } : {}),
    ...(overrides.has("input") ? { declaredInputModalities: model.input } : {})
  };
  const { defaultEffort, contextWindowMax, ...effective } = result;
  return { ...effective,
    ...(contextWindowMax === undefined || contextWindowMax < result.contextWindow! ? {} : { contextWindowMax }),
    ...(defaultEffort === undefined || !supportedPiThinkingLevels(result.reasoning, result.thinkingLevelMap).includes(defaultEffort) ? {} : { defaultEffort }) };
}
