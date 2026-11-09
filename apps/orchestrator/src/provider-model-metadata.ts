import {
  PI_EDITABLE_MODEL_METADATA_FIELDS, PI_MODEL_METADATA_FIELDS, supportedPiThinkingLevels,
  type PiManagedModel, type PiModelDiscoveryMetadata, type PiModelMetadataField
} from "@joko/adapter-pi";

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
  if (current?.discoveredMetadata === undefined) {
    const { metadataOverrides: _metadataOverrides, discoveredMetadata: _discoveredMetadata, contextWindowMax: _contextWindowMax,
      declaredInputModalities: _declaredInputModalities, ...manual } = input;
    return manual;
  }
  const editable = new Set<PiModelMetadataField>(PI_EDITABLE_MODEL_METADATA_FIELDS);
  const privateOverrides = current.metadataOverrides!.filter(field => !editable.has(field));
  const editableOverrides = (input.metadataOverrides ?? PI_EDITABLE_MODEL_METADATA_FIELDS).filter(field => editable.has(field));
  return materializeDiscoveredModel({ ...current, ...input, discoveredMetadata: current.discoveredMetadata,
    ...(editableOverrides.includes("contextWindow") && input.contextWindow !== undefined ? { contextWindowSource: "declared" as const } : {}),
    ...(editableOverrides.includes("maxTokens") && input.maxTokens !== undefined ? { maxOutputTokensSource: "declared" as const } : {}),
    metadataOverrides: [...privateOverrides, ...editableOverrides] });
}

export function materializeDiscoveredModel(model: PiManagedModel): PiManagedModel {
  const metadata = model.discoveredMetadata!;
  const overrides = new Set(model.metadataOverrides);
  const user = Object.fromEntries(PI_MODEL_METADATA_FIELDS.filter(field => overrides.has(field)).map(field => [field, model[field]]));
  const base = Object.fromEntries(Object.entries(model).filter(([field]) => !PI_MODEL_METADATA_FIELDS.includes(field as PiModelMetadataField)
    && !["contextWindowSource", "maxOutputTokensSource", "declaredInputModalities"].includes(field)));
  const levels = metadata.efforts;
  const thinkingLevelMap = levels === undefined ? undefined : Object.fromEntries(
    ["off", "minimal", "low", "medium", "high", "xhigh", "max"].map(level => [level, levels.includes(level) ? level : null]));
  const reportedInput = metadata.supportsImages === false ? metadata.inputModalities?.filter(value => value !== "image")
    : metadata.supportsImages === true ? [...new Set([...(metadata.inputModalities ?? ["text"]), "image"])] : metadata.inputModalities;
  const input = reportedInput?.filter((value): value is "text" | "image" => value === "text" || value === "image");
  const result: PiManagedModel = {
    ...base, id: model.id, discoveredMetadata: metadata, metadataOverrides: model.metadataOverrides,
    name: metadata.name ?? model.id,
    contextWindow: metadata.contextWindow ?? metadata.contextWindowMax ?? 128_000,
    contextWindowSource: metadata.contextWindow === undefined ? "estimated" : "declared",
    maxTokens: metadata.maxOutputTokens ?? 16_384,
    maxOutputTokensSource: metadata.maxOutputTokens === undefined ? "estimated" : "declared",
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
