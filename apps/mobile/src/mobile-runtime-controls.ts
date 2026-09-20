import {
  CapabilitySupport,
  ConnectionState,
  DeviceKind,
  ModelInputModality,
  ModelOutputModality,
  PermissionMode,
  capabilityNames,
  type BackendDescriptor,
  type Capability,
  type ModelDescriptor,
  type ProviderDescriptor,
  type Session,
  type Snapshot
} from "@joko/contracts";

export interface MobileRuntimeOwnerIdentity {
  readonly profileId: string;
  readonly connectionId: string;
  readonly deviceId: string;
  readonly serverId: string;
}

export interface MobileEffortOption {
  readonly id: string;
  readonly label: string;
  readonly order: number;
  readonly default: boolean;
}

export interface MobileModelRoute {
  readonly key: string;
  readonly backendId: string;
  readonly providerId: string;
  readonly providerName: string;
  readonly modelId: string;
  readonly displayName: string;
  readonly family: string;
  readonly contextWindowTokens: bigint;
  readonly maximumOutputTokens: bigint;
  readonly efforts: readonly MobileEffortOption[];
  readonly supportsFastMode: boolean;
}

export interface MobileCurrentModel {
  readonly providerId: string;
  readonly providerName: string;
  readonly modelId: string;
  readonly displayName: string;
  readonly effortId?: string;
  readonly fastMode: boolean;
  readonly route?: MobileModelRoute;
  readonly selectable: boolean;
}

export interface MobileRuntimeControls {
  readonly authorityKey: string;
  readonly surfaceOwnerKey: string;
  readonly session: Session;
  readonly backend: BackendDescriptor;
  readonly models: readonly MobileModelRoute[];
  readonly currentModel?: MobileCurrentModel;
  readonly canListModels: boolean;
  readonly canSwitchModel: boolean;
  readonly canSetEffort: boolean;
  readonly canSetFastMode: boolean;
  readonly permissionModes: readonly PermissionMode[];
  readonly canSetPermission: boolean;
  readonly canSetPlanMode: boolean;
}

export interface MobileModelControlSelection {
  readonly providerId: string;
  readonly modelId: string;
  readonly effortId?: string;
  readonly fastMode: boolean;
}

export interface MobileTrustedModelAuthority {
  readonly selection: MobileModelControlSelection;
  readonly supportsImages: boolean;
  readonly authorityKey: string;
}

export interface MobileNewTaskExecutionAuthority {
  readonly backend: BackendDescriptor;
  readonly models: readonly MobileModelRoute[];
  readonly canSelectModel: boolean;
  readonly canSetEffort: boolean;
  readonly canSetFastMode: boolean;
  readonly permissionModes: readonly PermissionMode[];
  readonly canSetPlanMode: boolean;
  readonly supportsExtraDirectories: boolean;
}

const permissionModeOrder = [
  PermissionMode.ASK,
  PermissionMode.AUTO,
  PermissionMode.BYPASS_PERMISSIONS
] as const;

export function resolveMobileRuntimeControls(
  identity: MobileRuntimeOwnerIdentity | undefined,
  owner: Snapshot | undefined,
  detail: Snapshot | undefined,
  selectedSessionId: string | undefined
): MobileRuntimeControls | undefined {
  if (!identity || !owner || !detail || !strictText(selectedSessionId)
    || !strictText(identity.profileId) || !strictText(identity.connectionId)
    || !strictText(identity.deviceId) || !strictText(identity.serverId)
    || owner.scope?.kind.case !== "owner"
    || owner.server?.serverId !== identity.serverId
    || detail.server?.serverId !== identity.serverId
    || owner.settings === undefined
    || owner.generation < 1n || detail.generation !== owner.generation
    || detail.scope?.kind.case !== "session"
    || detail.scope.kind.value.sessionId !== selectedSessionId
    || !positiveRevision(owner) || !positiveRevision(detail)) return undefined;

  const connections = owner.connections.filter((candidate) => candidate.connectionId === identity.connectionId);
  const devices = owner.devices.filter((candidate) => candidate.deviceId === identity.deviceId);
  if (connections.length !== 1 || devices.length !== 1) return undefined;
  const connection = connections[0]!;
  const device = devices[0]!;
  if (connection.connectionProfileId !== identity.profileId || connection.deviceId !== identity.deviceId
    || connection.state !== ConnectionState.CONNECTED || device.kind !== DeviceKind.MOBILE
    || device.revoked || !device.connectionIds.includes(identity.connectionId)) return undefined;

  const detailSessions = detail.sessions.filter((candidate) => candidate.sessionId === selectedSessionId);
  const ownerSessions = owner.sessions.filter((candidate) => candidate.sessionId === selectedSessionId);
  if (detailSessions.length !== 1 || ownerSessions.length !== 1) return undefined;
  const session = detailSessions[0]!;
  const ownerSession = ownerSessions[0]!;
  const runtimeGeneration = session.nativeBinding?.runtimeGeneration;
  const sessionRevision = session.version?.revision?.value;
  if (!strictText(session.backendId) || !strictText(session.targetId)
    || ownerSession.backendId !== session.backendId || ownerSession.targetId !== session.targetId
    || ownerSession.nativeBinding?.runtimeGeneration !== runtimeGeneration
    || !runtimeGeneration || runtimeGeneration < 1n
    || !sessionRevision || sessionRevision < 1n
    || session.version?.generation !== runtimeGeneration) return undefined;

  const backends = detail.backends.filter((candidate) => candidate.backendId === session.backendId);
  const ownerBackends = owner.backends.filter((candidate) => candidate.backendId === session.backendId);
  const targets = detail.targets.filter((candidate) => candidate.targetId === session.targetId);
  const ownerTargets = owner.targets.filter((candidate) => candidate.targetId === session.targetId);
  if (backends.length !== 1 || ownerBackends.length !== 1 || targets.length !== 1 || ownerTargets.length !== 1) {
    return undefined;
  }
  const backend = backends[0]!;
  const ownerBackend = ownerBackends[0]!;
  if (targets[0]!.backendId !== session.backendId || ownerTargets[0]!.backendId !== session.backendId
    || !sameBackendAuthority(ownerBackend, backend)) return undefined;
  const backendSettings = owner.settings?.backends.filter((candidate) => candidate.backendId === session.backendId) ?? [];
  if (backendSettings.length > 1) return undefined;

  const modelList = typedModelCapability(backend, capabilityNames.modelList);
  const modelSwitch = typedModelCapability(backend, capabilityNames.modelSwitch);
  const modelEffort = typedModelCapability(backend, capabilityNames.modelEffort);
  const modelFastMode = typedModelCapability(backend, capabilityNames.modelFastMode);
  const canListModels = modelList?.providerAware === true;
  const canSwitchModel = canListModels && modelSwitch?.switchDuringSession === true;
  const canSetEffort = modelEffort?.supportsEffort === true;
  const canSetFastMode = modelFastMode?.supportsFastMode === true;

  const providerGroups = groupBy(owner.providers.filter((provider) => provider.backendId === session.backendId), providerKey);
  const modelGroups = groupBy(owner.models.filter((model) => model.backendId === session.backendId), modelKey);
  const validRoutes: MobileModelRoute[] = [];
  const structuralRoutes = new Map<string, MobileModelRoute>();
  for (const [key, models] of modelGroups) {
    if (models.length !== 1) continue;
    const model = models[0]!;
    const providerId = model.key?.providerId;
    const providers = strictText(providerId) ? providerGroups.get(providerId) ?? [] : [];
    if (providers.length > 1) continue;
    const provider = providers[0];
    const route = mobileModelRoute(model, provider);
    if (!route) continue;
    structuralRoutes.set(key, route);
    if (canListModels && modelRouteEnabled(owner, backendSettings[0], provider, route)) validRoutes.push(route);
  }
  validRoutes.sort(compareModelRoutes);

  const currentKey = session.model?.model === undefined
    ? undefined
    : modelRouteKey(session.model.model.providerId, session.model.model.modelId);
  const currentRoute = currentKey === undefined ? undefined : structuralRoutes.get(currentKey);
  const selectableCurrent = currentKey !== undefined && validRoutes.some((route) => route.key === currentKey);
  const currentProviderId = session.model?.model?.providerId;
  const currentModelId = session.model?.model?.modelId;
  const currentProvider = strictText(currentProviderId)
    ? (providerGroups.get(currentProviderId)?.length === 1 ? providerGroups.get(currentProviderId)![0] : undefined)
    : undefined;
  const currentModel = strictText(currentProviderId) && strictText(currentModelId)
    ? {
        providerId: currentProviderId,
        providerName: currentRoute?.providerName
          ?? (strictText(currentProvider?.displayName) ? currentProvider.displayName : currentProviderId),
        modelId: currentModelId,
        displayName: currentRoute?.displayName ?? currentModelId,
        ...(strictText(session.model?.effortId) ? { effortId: session.model.effortId } : {}),
        fastMode: session.model?.fastMode === true,
        ...(currentRoute === undefined ? {} : { route: currentRoute }),
        selectable: selectableCurrent
      } satisfies MobileCurrentModel
    : undefined;

  const permissionModes = advertisedPermissionModes(backend);
  const permissionChange = typedPermissionCapability(backend, capabilityNames.permissionChange);
  const canSetPermission = permissionModes.length > 0
    && permissionChange?.mutableDuringSession === true
    && validPermissionMode(session.permissionMode);
  const canSetPlanMode = supportedCapability(backend, capabilityNames.planMode) !== undefined;
  const authorityKey = JSON.stringify([
    identity.profileId,
    identity.connectionId,
    identity.deviceId,
    identity.serverId,
    owner.generation.toString(10),
    owner.snapshotId,
    owner.revision?.value.toString(10) ?? "",
    owner.revision?.etag ?? "",
    detail.snapshotId,
    detail.revision?.value.toString(10) ?? "",
    detail.revision?.etag ?? "",
    session.sessionId,
    session.backendId,
    session.targetId,
    runtimeGeneration.toString(10),
    sessionRevision.toString(10),
    session.version?.revision?.etag ?? "",
    backend.entityVersion?.generation.toString(10) ?? "",
    backend.entityVersion?.revision?.value.toString(10) ?? "",
    backend.capabilities?.revision?.value.toString(10) ?? "",
    detail.settings?.revision?.value.toString(10) ?? ""
  ]);
  const surfaceOwnerKey = JSON.stringify([
    identity.profileId,
    identity.connectionId,
    identity.deviceId,
    identity.serverId,
    session.sessionId,
    session.backendId,
    session.targetId,
    runtimeGeneration.toString(10)
  ]);

  return {
    authorityKey,
    surfaceOwnerKey,
    session,
    backend,
    models: validRoutes,
    ...(currentModel === undefined ? {} : { currentModel }),
    canListModels,
    canSwitchModel,
    canSetEffort,
    canSetFastMode,
    permissionModes,
    canSetPermission,
    canSetPlanMode
  };
}

export function resolveMobileSessionModelAuthority(
  owner: Snapshot | undefined,
  session: Session | undefined
): MobileTrustedModelAuthority | undefined {
  const model = session?.model?.model;
  if (!owner || !session || !model) return undefined;
  return resolveTrustedMobileModel(owner, session.backendId, {
    providerId: model.providerId,
    modelId: model.modelId,
    ...(strictText(session.model?.effortId) ? { effortId: session.model.effortId } : {}),
    fastMode: session.model?.fastMode === true
  }, false);
}

export function resolveMobileNewTaskDefaultModelAuthority(
  owner: Snapshot | undefined,
  backendId: string | undefined
): MobileTrustedModelAuthority | undefined {
  if (!owner?.settings || !strictText(backendId)) return undefined;
  const settings = owner.settings.backends.filter((candidate) => candidate.backendId === backendId);
  if (settings.length !== 1) return undefined;
  const selection = settings[0]!.defaultModel;
  const model = selection?.model;
  if (!selection || !model) return undefined;
  return resolveTrustedMobileModel(owner, backendId, {
    providerId: model.providerId,
    modelId: model.modelId,
    ...(strictText(selection.effortId) ? { effortId: selection.effortId } : {}),
    fastMode: selection.fastMode
  }, true);
}

export function resolveMobileExplicitNewTaskModelAuthority(
  owner: Snapshot | undefined,
  backendId: string | undefined,
  selection: MobileModelControlSelection | undefined
): MobileTrustedModelAuthority | undefined {
  if (!owner || !strictText(backendId) || !selection) return undefined;
  return resolveTrustedMobileModel(owner, backendId, selection, true);
}

export function resolveMobileNewTaskExecutionAuthority(
  owner: Snapshot | undefined,
  backendId: string | undefined
): MobileNewTaskExecutionAuthority | undefined {
  if (!owner || owner.scope?.kind.case !== "owner" || !strictText(backendId) || owner.settings === undefined) {
    return undefined;
  }
  const backends = owner.backends.filter((candidate) => candidate.backendId === backendId);
  const settings = owner.settings.backends.filter((candidate) => candidate.backendId === backendId);
  if (backends.length !== 1 || settings.length > 1 || settings[0]?.enabled === false) return undefined;
  const backend = backends[0]!;
  if (supportedCapability(backend, capabilityNames.inputText) === undefined) return undefined;
  const canListModels = typedModelCapability(backend, capabilityNames.modelList)?.providerAware === true;
  const canSelectModel = canListModels
    && typedModelCapability(backend, capabilityNames.modelSwitch)?.switchDuringSession === true;
  const canSetEffort = typedModelCapability(backend, capabilityNames.modelEffort)?.supportsEffort === true;
  const canSetFastMode = typedModelCapability(backend, capabilityNames.modelFastMode)?.supportsFastMode === true;
  const providers = groupBy(owner.providers.filter((provider) => provider.backendId === backendId), providerKey);
  const models: MobileModelRoute[] = [];
  if (canListModels) {
    for (const [key, matches] of groupBy(owner.models.filter((model) => model.backendId === backendId), modelKey)) {
      if (matches.length !== 1) continue;
      const model = matches[0]!;
      const providerId = model.key?.providerId;
      const providerMatches = strictText(providerId) ? providers.get(providerId) ?? [] : [];
      if (providerMatches.length > 1) continue;
      const route = mobileModelRoute(model, providerMatches[0]);
      if (route !== undefined && key === route.key
        && modelRouteEnabled(owner, settings[0], providerMatches[0], route)) models.push(route);
    }
  }
  models.sort(compareModelRoutes);
  const permissionModes = advertisedPermissionModes(backend);
  return {
    backend,
    models,
    canSelectModel,
    canSetEffort,
    canSetFastMode,
    permissionModes: permissionModes.length === 0 ? [PermissionMode.ASK] : permissionModes,
    canSetPlanMode: supportedCapability(backend, capabilityNames.planMode) !== undefined,
    supportsExtraDirectories: supportedCapability(backend, capabilityNames.workspaceExtraDirs) !== undefined
  };
}

export function filterMobileModelRoutes(
  routes: readonly MobileModelRoute[],
  query: string
): readonly MobileModelRoute[] {
  const needle = query.trim().toLocaleLowerCase("en-US");
  if (!needle) return routes;
  return routes.filter((route) => [
    route.displayName,
    route.modelId,
    route.providerName,
    route.providerId,
    route.family
  ].some((value) => value.toLocaleLowerCase("en-US").includes(needle)));
}

export function defaultMobileModelSelection(
  controls: MobileRuntimeControls,
  route: MobileModelRoute
): MobileModelControlSelection {
  const current = controls.currentModel;
  const sameRoute = current?.providerId === route.providerId && current.modelId === route.modelId;
  const currentEffort = sameRoute && current?.effortId !== undefined
    && route.efforts.some((effort) => effort.id === current.effortId)
    ? current.effortId
    : undefined;
  const defaultEffort = route.efforts.find((effort) => effort.default)?.id ?? route.efforts[0]?.id;
  return {
    providerId: route.providerId,
    modelId: route.modelId,
    ...(controls.canSetEffort && (currentEffort ?? defaultEffort) !== undefined
      ? { effortId: currentEffort ?? defaultEffort }
      : {}),
    fastMode: controls.canSetFastMode && route.supportsFastMode && sameRoute && current?.fastMode === true
  };
}

export function assertMobileModelSelection(
  controls: MobileRuntimeControls,
  selection: MobileModelControlSelection
): MobileModelControlSelection {
  if (!strictText(selection.providerId) || !strictText(selection.modelId)
    || (selection.effortId !== undefined && !strictText(selection.effortId))) {
    throw new Error("Choose a current advertised model route and effort.");
  }
  const route = controls.models.find((candidate) => candidate.providerId === selection.providerId
    && candidate.modelId === selection.modelId);
  if (!route) throw new Error("This model route is no longer available to the current task.");
  const current = controls.currentModel;
  const routeChanged = current?.providerId !== route.providerId || current.modelId !== route.modelId;
  if (routeChanged && !controls.canSwitchModel) {
    throw new Error("This Backend does not currently allow task model switching.");
  }
  const effortId = selection.effortId ?? "";
  if (effortId && !route.efforts.some((effort) => effort.id === effortId)) {
    throw new Error("This effort is not advertised by the selected model.");
  }
  const currentEffort = current?.effortId ?? "";
  const effortChanged = !routeChanged && effortId !== currentEffort;
  if (effortChanged && !controls.canSetEffort) {
    throw new Error("This Backend does not currently allow effort changes.");
  }
  if (routeChanged && effortId && !controls.canSetEffort) {
    throw new Error("This Backend does not currently allow choosing an effort for the new model.");
  }
  if (selection.fastMode && (!route.supportsFastMode || !controls.canSetFastMode)) {
    throw new Error("Fast Mode is not available for the selected model.");
  }
  const fastChanged = !routeChanged && selection.fastMode !== (current?.fastMode ?? false);
  if (fastChanged && !controls.canSetFastMode) {
    throw new Error("This Backend does not currently allow Fast Mode changes.");
  }
  if (!routeChanged && !effortChanged && !fastChanged) {
    throw new Error("Choose a different model setting before applying.");
  }
  return {
    providerId: route.providerId,
    modelId: route.modelId,
    ...(effortId ? { effortId } : {}),
    fastMode: selection.fastMode
  };
}

export function assertMobilePermissionMode(
  controls: MobileRuntimeControls,
  mode: PermissionMode
): PermissionMode {
  if (!controls.canSetPermission || !validPermissionMode(controls.session.permissionMode)) {
    throw new Error("Permission changes are unavailable for the current task.");
  }
  if (!controls.permissionModes.includes(mode)) {
    throw new Error("This permission mode is not advertised by the current Backend.");
  }
  if (mode === controls.session.permissionMode) throw new Error("Choose a different permission mode.");
  return mode;
}

export function assertMobilePlanMode(controls: MobileRuntimeControls, enabled: boolean): boolean {
  if (!controls.canSetPlanMode) throw new Error("Plan Mode is unavailable for the current task.");
  if (enabled === controls.session.planMode) throw new Error("Choose a different Plan Mode setting.");
  return enabled;
}

export function mobilePermissionModeLabel(mode: PermissionMode): string {
  switch (mode) {
    case PermissionMode.ASK: return "Ask before actions";
    case PermissionMode.AUTO: return "Allow safe actions";
    case PermissionMode.BYPASS_PERMISSIONS: return "Full access";
    default: return "Unavailable";
  }
}

export function mobilePermissionModeDescription(mode: PermissionMode): string {
  switch (mode) {
    case PermissionMode.ASK: return "Joko asks before actions that need approval.";
    case PermissionMode.AUTO: return "The Backend may continue with its advertised safe automatic policy.";
    case PermissionMode.BYPASS_PERMISSIONS: return "The Backend may act without asking. Use only in a workspace you trust.";
    default: return "This mode is not part of the current public contract.";
  }
}

export function formatMobileTokenLimit(value: bigint): string {
  if (value < 1n) return "Context limit unavailable";
  if (value >= 1_000_000n && value % 1_000_000n === 0n) return `${value / 1_000_000n}M context`;
  if (value >= 1_000n && value % 1_000n === 0n) return `${value / 1_000n}K context`;
  return `${value.toString(10)} token context`;
}

function positiveRevision(snapshot: Snapshot): boolean {
  return (snapshot.revision?.value ?? 0n) > 0n;
}

function sameBackendAuthority(left: BackendDescriptor, right: BackendDescriptor): boolean {
  return left.entityVersion?.generation === right.entityVersion?.generation
    && left.entityVersion?.revision?.value === right.entityVersion?.revision?.value
    && left.entityVersion?.revision?.etag === right.entityVersion?.revision?.etag
    && left.capabilities?.schemaVersion === right.capabilities?.schemaVersion
    && left.capabilities?.revision?.value === right.capabilities?.revision?.value
    && left.capabilities?.revision?.etag === right.capabilities?.revision?.etag;
}

function strictText(value: string | undefined): value is string {
  return value !== undefined && value.length > 0 && value.trim() === value;
}

function supportedCapability(backend: BackendDescriptor, name: string): Capability | undefined {
  const matches = backend.capabilities?.capabilities.filter((candidate) => candidate.name === name) ?? [];
  return matches.length === 1 && matches[0]!.support === CapabilitySupport.SUPPORTED ? matches[0] : undefined;
}

function typedModelCapability(backend: BackendDescriptor, name: string) {
  const capability = supportedCapability(backend, name);
  return capability?.options?.kind.case === "model" ? capability.options.kind.value : undefined;
}

function typedPermissionCapability(backend: BackendDescriptor, name: string) {
  const capability = supportedCapability(backend, name);
  return capability?.options?.kind.case === "permission" ? capability.options.kind.value : undefined;
}

function advertisedPermissionModes(backend: BackendDescriptor): readonly PermissionMode[] {
  const options = typedPermissionCapability(backend, capabilityNames.permissionModes);
  if (!options || options.mutableDuringSession !== true || options.modes.length === 0) return [];
  const seen = new Set<PermissionMode>();
  for (const mode of options.modes) {
    if (!validPermissionMode(mode) || seen.has(mode)) return [];
    seen.add(mode);
  }
  return permissionModeOrder.filter((mode) => seen.has(mode));
}

function validPermissionMode(mode: PermissionMode): boolean {
  return permissionModeOrder.includes(mode as typeof permissionModeOrder[number]);
}

function mobileModelRoute(
  model: ModelDescriptor,
  provider: ProviderDescriptor | undefined
): MobileModelRoute | undefined {
  const providerId = model.key?.providerId;
  const modelId = model.key?.modelId;
  if (!strictText(providerId) || !strictText(modelId) || !strictText(model.backendId)
    || !strictText(model.displayName) || !model.available
    || !model.outputModalities.includes(ModelOutputModality.TEXT)) return undefined;
  const effortIds = new Set<string>();
  const efforts: MobileEffortOption[] = [];
  let defaults = 0;
  for (const effort of model.effortLevels) {
    if (!strictText(effort.effortId) || effortIds.has(effort.effortId)
      || !Number.isSafeInteger(effort.order) || effort.order < 0) return undefined;
    effortIds.add(effort.effortId);
    if (effort.defaultLevel) defaults += 1;
    efforts.push({
      id: effort.effortId,
      label: strictText(effort.displayName) ? effort.displayName : effort.effortId,
      order: effort.order,
      default: effort.defaultLevel
    });
  }
  if (defaults > 1) return undefined;
  efforts.sort((left, right) => left.order - right.order || compareText(left.label, right.label) || compareText(left.id, right.id));
  return {
    key: modelRouteKey(providerId, modelId),
    backendId: model.backendId,
    providerId,
    providerName: strictText(provider?.displayName) ? provider.displayName : providerId,
    modelId,
    displayName: model.displayName,
    family: strictText(model.family) ? model.family : modelId,
    contextWindowTokens: model.contextWindowTokens,
    maximumOutputTokens: model.maximumOutputTokens,
    efforts,
    supportsFastMode: model.supportsFastMode
  };
}

function resolveTrustedMobileModel(
  owner: Snapshot,
  backendId: string,
  selection: MobileModelControlSelection,
  requireRoutingEnabled: boolean
): MobileTrustedModelAuthority | undefined {
  if (!strictText(backendId) || !strictText(selection.providerId) || !strictText(selection.modelId)
    || (selection.effortId !== undefined && !strictText(selection.effortId))) return undefined;
  const models = owner.models.filter((candidate) => candidate.backendId === backendId
    && candidate.key?.providerId === selection.providerId
    && candidate.key.modelId === selection.modelId);
  if (models.length !== 1) return undefined;
  const providers = owner.providers.filter((candidate) => candidate.backendId === backendId
    && candidate.providerId === selection.providerId);
  if (providers.length > 1) return undefined;
  const model = models[0]!;
  const route = mobileModelRoute(model, providers[0]);
  if (!route) return undefined;
  const settings = owner.settings?.backends.filter((candidate) => candidate.backendId === backendId) ?? [];
  if (settings.length > 1 || requireRoutingEnabled && !modelRouteEnabled(owner, settings[0], providers[0], route)) {
    return undefined;
  }
  if (selection.effortId !== undefined
    && !route.efforts.some((candidate) => candidate.id === selection.effortId)) return undefined;
  if (selection.fastMode && !route.supportsFastMode) return undefined;
  const exactSelection: MobileModelControlSelection = {
    providerId: selection.providerId,
    modelId: selection.modelId,
    ...(selection.effortId === undefined ? {} : { effortId: selection.effortId }),
    fastMode: selection.fastMode
  };
  return {
    selection: exactSelection,
    supportsImages: model.inputModalities.includes(ModelInputModality.IMAGE),
    authorityKey: JSON.stringify([
      backendId,
      exactSelection.providerId,
      exactSelection.modelId,
      exactSelection.effortId ?? "",
      exactSelection.fastMode,
      model.available,
      [...model.inputModalities],
      [...model.outputModalities]
    ])
  };
}

function modelRouteEnabled(
  detail: Snapshot,
  settings: NonNullable<Snapshot["settings"]>["backends"][number] | undefined,
  provider: ProviderDescriptor | undefined,
  route: MobileModelRoute
): boolean {
  if (settings?.modelAccess?.disabledProviderIds.includes(route.providerId) === true) return false;
  if (settings?.modelAccess?.disabledModels.some((model) => model.providerId === route.providerId
    && model.modelId === route.modelId) === true) return false;
  if (provider?.ownerManaged !== true) return true;
  const configurations = detail.settings?.providers.filter((candidate) => candidate.providerId === route.providerId) ?? [];
  return configurations.length <= 1 && configurations[0]?.enabled !== false;
}

function groupBy<T>(values: readonly T[], key: (value: T) => string | undefined): Map<string, T[]> {
  const result = new Map<string, T[]>();
  for (const value of values) {
    const currentKey = key(value);
    if (!strictText(currentKey)) continue;
    const bucket = result.get(currentKey) ?? [];
    bucket.push(value);
    result.set(currentKey, bucket);
  }
  return result;
}

function providerKey(provider: ProviderDescriptor): string | undefined {
  return strictText(provider.providerId) ? provider.providerId : undefined;
}

function modelKey(model: ModelDescriptor): string | undefined {
  return strictText(model.key?.providerId) && strictText(model.key.modelId)
    ? modelRouteKey(model.key.providerId, model.key.modelId)
    : undefined;
}

function modelRouteKey(providerId: string, modelId: string): string {
  return JSON.stringify([providerId, modelId]);
}

function compareModelRoutes(left: MobileModelRoute, right: MobileModelRoute): number {
  return compareText(left.providerName, right.providerName)
    || compareText(left.providerId, right.providerId)
    || compareText(left.displayName, right.displayName)
    || compareText(left.modelId, right.modelId);
}

function compareText(left: string, right: string): number {
  const a = left.toLocaleLowerCase("en-US");
  const b = right.toLocaleLowerCase("en-US");
  return a < b ? -1 : a > b ? 1 : left < right ? -1 : left > right ? 1 : 0;
}
